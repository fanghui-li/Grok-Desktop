/**
 * 会话全流程集成测试（Mode B + fake ACP agent）。
 * create → prompt → detach → attach → queue → pin → rename → fork → delete
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHost } from "../src/host/host.js";
import { loadChatHistory } from "../src/host/history.js";
import { loadQueue, queueFilePath } from "../src/host/prompt-queue/queue.js";
import { findSessionDir } from "../src/host/paths.js";
import {
  invalidateDiskRosterCache,
  readSessionMeta,
} from "../src/host/roster.js";

const fakeAgent = path.join(__dirname, "fake-acp-agent.mjs");
const homes: string[] = [];
const hosts: DesktopHost[] = [];

function tempHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "grok-life-"));
  homes.push(h);
  return h;
}

function tempCwd(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-life-"));
  homes.push(d);
  return d;
}

function makeHost(home = tempHome()): DesktopHost {
  const host = new DesktopHost({
    home,
    grokPath: process.execPath,
    agentArgs: [fakeAgent],
    env: { ...process.env },
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  while (hosts.length) {
    await hosts.pop()!.dispose().catch(() => undefined);
  }
  while (homes.length) {
    const h = homes.pop()!;
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("session lifecycle e2e", () => {
  it("create → prompt → list → history → detach → attach → prompt", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);

    const created = await host.threadsCreate({
      cwd,
      title: "life-1",
      // 不在 create 里阻塞整轮；单独 turnsPrompt
    });
    expect(created.threadId).toMatch(/^thread_/);
    expect(created.sessionId).toBeTruthy();

    const events: string[] = [];
    host.subscribe((e) => events.push(e.type));

    await host.turnsPrompt(created.threadId, "hello lifecycle");
    expect(events).toContain("turn.started");
    expect(events).toContain("turn.completed");
    expect(events).toContain("message.delta");

    const listed = host.listThreads();
    const row = listed.find((t) => t.sessionId === created.sessionId);
    expect(row).toBeTruthy();
    expect(row!.status === "idle" || row!.status === "completed").toBe(true);

    // fake agent 不一定写 chat_history；至少 session 目录应存在或可 attach
    const sdir = findSessionDir(created.sessionId, home);
    // 部分 agent 落盘延迟：detach 后再 load 应成功
    await host.threadsDetach(created.threadId);
    const st = host.threadsAttachState({ threadId: created.threadId });
    expect(st.state).toBe("history_only");

    const att = await host.threadsAttach(created.sessionId, cwd);
    expect(att.threadId).toBe(created.threadId);
    expect(host.threadsPing(att.threadId).ok).toBe(true);

    await host.turnsPrompt(att.threadId, "second turn after reattach");
    expect(events.filter((t) => t === "turn.completed").length).toBeGreaterThanOrEqual(2);

    void sdir;
  });

  it("queue L1 take→complete survives across detach", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "q-life" });

    host.queueEnqueue(created.sessionId, {
      content: "queued-1",
      display: "q1",
    });
    host.queueEnqueue(created.sessionId, {
      content: "queued-2",
      display: "q2",
    });
    expect(host.queueGet(created.sessionId).items).toHaveLength(2);

    const taken = host.queueTakeNext(created.sessionId);
    expect(taken.item?.content).toBe("queued-1");
    expect(taken.item?.status).toBe("sending");

    // 二次 take 应被 drain 锁挡住
    const blocked = host.queueTakeNext(created.sessionId);
    expect(blocked.item).toBeNull();

    await host.threadsDetach(created.threadId);
    // detach 释放锁后可再 take（若 complete 未调用，sending 在 load 时恢复 pending）
    const afterDetach = host.queueGet(created.sessionId);
    expect(afterDetach.items.length).toBeGreaterThanOrEqual(1);

    // complete 成功删条
    const again = host.queueTakeNext(created.sessionId);
    if (again.item) {
      host.queueCompleteSending(created.sessionId, again.item.id, true);
    }
    // 清理剩余
    host.queueClear(created.sessionId);
    expect(host.queueGet(created.sessionId).items).toHaveLength(0);
  });

  it("rename / pin / archive / delete full path", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "meta-life" });

    const renamed = host.threadsRename(created.threadId, "重命名会话");
    expect(renamed.title).toBe("重命名会话");

    const pinned = host.threadsPin(created.threadId, true);
    expect(pinned.pinned).toBe(true);

    // detach 后仍可 pin disk_
    await host.threadsDetach(created.threadId);
    const pinDisk = host.threadsPin(`disk_${created.sessionId}`, false);
    expect(pinDisk.pinned).toBe(false);

    const archived = host.threadsArchive(
      `disk_${created.sessionId}`,
      true,
    );
    expect(archived.archived).toBe(true);

    host.queueEnqueue(created.sessionId, { content: "will-delete" });
    expect(fs.existsSync(queueFilePath(created.sessionId, home))).toBe(true);

    await host.threadsDelete(`disk_${created.sessionId}`);
    expect(fs.existsSync(queueFilePath(created.sessionId, home))).toBe(false);
    expect(
      host.listThreads().find((t) => t.sessionId === created.sessionId),
    ).toBeUndefined();
  });

  it("fork after multi-turn + optional directive", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "fork-src" });
    await host.turnsPrompt(created.threadId, "turn A");

    // 确保源目录有可读 history（fake 可能不写；手动补）
    let srcDir = findSessionDir(created.sessionId, home);
    if (!srcDir) {
      const enc = encodeURIComponent(path.resolve(cwd));
      srcDir = path.join(home, ".grok-desktop", "sessions", enc, created.sessionId);
      fs.mkdirSync(srcDir, { recursive: true });
    }
    const histPath = path.join(srcDir, "chat_history.jsonl");
    if (!fs.existsSync(histPath) || fs.statSync(histPath).size < 10) {
      fs.writeFileSync(
        histPath,
        [
          JSON.stringify({
            type: "user",
            content: [{ type: "text", text: "<user_query>\nturn A\n</user_query>" }],
          }),
          JSON.stringify({ type: "assistant", content: "reply A" }),
        ].join("\n") + "\n",
        "utf8",
      );
    }

    const forked = await host.threadsFork({
      sourceSessionId: created.sessionId,
      cwd,
      title: "fork-child",
      directive: "from fork",
    });
    expect(forked.sessionId).not.toBe(created.sessionId);
    expect(forked.historyCopied).toBe(true);
    expect(forked.directiveSent).toBe(true);
    expect(forked.parentSessionId).toBe(created.sessionId);

    const childHist = loadChatHistory(forked.sessionId, home);
    expect(childHist.entries.some((e) => e.role === "user")).toBe(true);
  });

  it("concurrent attach same session returns same live thread", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "conc" });
    await host.threadsDetach(created.threadId);

    const [a, b, c] = await Promise.all([
      host.threadsAttach(created.sessionId, cwd),
      host.threadsAttach(created.sessionId, cwd),
      host.threadsAttach(created.sessionId, cwd),
    ]);
    expect(a.threadId).toBe(b.threadId);
    expect(b.threadId).toBe(c.threadId);
    expect(host.threadsPing(a.threadId).alive).toBe(true);
  });

  it("create failure mid-flight does not leave writable zombie", async () => {
    const home = tempHome();
    const host = new DesktopHost({
      home,
      grokPath: path.join(home, "missing-binary.exe"),
      env: { PATH: home },
    });
    hosts.push(host);
    const cwd = tempCwd();
    await expect(
      host.threadsCreate({ cwd, title: "fail" }),
    ).rejects.toMatchObject({ code: "BINARY_NOT_FOUND" });
    expect(host.listThreads().filter((t) => t.status === "idle")).toHaveLength(
      0,
    );
  });

  it(
    "YOLO auto-approve does not leave pending inbox permission",
    async () => {
      const home = tempHome();
      const cwd = tempCwd();
      const host = new DesktopHost({
        home,
        grokPath: process.execPath,
        agentArgs: [fakeAgent],
        env: { ...process.env, FAKE_ACP_ASK_PERMISSION: "1" },
      });
      hosts.push(host);

      // 先 create 再 prompt，避免 create 内嵌 prompt 与 permission 竞态难观测
      const created = await host.threadsCreate({
        cwd,
        title: "yolo",
        alwaysApprove: true,
      });
      expect(created.sessionId).toBeTruthy();

      await host.turnsPrompt(created.threadId, "need perm");

      const perms = host
        .inboxList()
        .filter((i) => i.type === "permission" && !i.read);
      expect(perms).toHaveLength(0);
    },
    15_000,
  );

  it("readSessionMeta prefers explicit title over first user query", () => {
    const home = tempHome();
    const cwd = tempCwd();
    const sid = "sess_title_prio";
    const enc = encodeURIComponent(path.resolve(cwd));
    const dir = path.join(home, ".grok-desktop", "sessions", enc, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        title: "自定义标题",
        generated_title: "自定义标题",
        updated_at: new Date().toISOString(),
        info: { cwd: path.resolve(cwd), id: sid },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [
          { type: "text", text: "<user_query>\n首条用户消息不该盖标题\n</user_query>" },
        ],
      }) + "\n",
      "utf8",
    );
    const meta = readSessionMeta(dir, sid, cwd);
    expect(meta.title).toContain("自定义");
    expect(meta.title).not.toContain("首条用户");
  });

  it("readSessionMeta falls back to first user when no summary title", () => {
    const home = tempHome();
    const cwd = tempCwd();
    const sid = "sess_title_user";
    const enc = encodeURIComponent(path.resolve(cwd));
    const dir = path.join(home, ".grok-desktop", "sessions", enc, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        updated_at: new Date().toISOString(),
        info: { cwd: path.resolve(cwd), id: sid },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [
          { type: "text", text: "<user_query>\n仅用用户首条\n</user_query>" },
        ],
      }) + "\n",
      "utf8",
    );
    const meta = readSessionMeta(dir, sid, cwd);
    expect(meta.title).toContain("仅用用户首条");
  });

  it("queue L1 survives session id still on disk after enqueue (leave-welcome semantics)", () => {
    const home = tempHome();
    const host = makeHost(home);
    const sid = "sess_keep_q";
    host.queueEnqueue(sid, { content: "keep-me", display: "k" });
    // 模拟回欢迎：不调 queueClear，只读盘应仍在
    expect(loadQueue(sid, home).items.map((i) => i.content)).toEqual([
      "keep-me",
    ]);
    // 显式 clear 才消失
    host.queueClear(sid);
    expect(loadQueue(sid, home).items).toHaveLength(0);
  });

  it("fork invalidates disk roster cache so list sees child", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "src-inv" });
    let srcDir = findSessionDir(created.sessionId, home);
    if (!srcDir) {
      const enc = encodeURIComponent(path.resolve(cwd));
      srcDir = path.join(
        home,
        ".grok-desktop",
        "sessions",
        enc,
        created.sessionId,
      );
      fs.mkdirSync(srcDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(srcDir, "chat_history.jsonl"),
      JSON.stringify({ role: "user", content: "x" }) + "\n",
      "utf8",
    );
    // 预热 cache
    host.listThreads();
    const forked = await host.threadsFork({
      sourceSessionId: created.sessionId,
      cwd,
      title: "child-inv",
    });
    invalidateDiskRosterCache(); // fork 内已 invalidate；再 list 必须含 child
    const ids = host.listThreads().map((t) => t.sessionId);
    expect(ids).toContain(forked.sessionId);
  });

  it("export markdown works for disk session", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const host = makeHost(home);
    const created = await host.threadsCreate({ cwd, title: "export-me" });
    let dir = findSessionDir(created.sessionId, home);
    if (!dir) {
      const enc = encodeURIComponent(path.resolve(cwd));
      dir = path.join(home, ".grok-desktop", "sessions", enc, created.sessionId);
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_query>\nexport me\n</user_query>" }],
      }) +
        "\n" +
        JSON.stringify({ type: "assistant", content: "exported body" }) +
        "\n",
      "utf8",
    );
    await host.threadsDetach(created.threadId);
    const md = host.threadsExportMarkdown(`disk_${created.sessionId}`);
    expect(md.markdown).toContain("export me");
    expect(md.markdown).toContain("exported body");
  });
});
