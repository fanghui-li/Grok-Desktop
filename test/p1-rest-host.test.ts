import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHost } from "../src/host/host.js";
import { searchProjectFiles } from "../src/host/files.js";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(here, "fake-acp-agent.mjs");
const nodeBin = process.execPath;

const hosts: DesktopHost[] = [];

afterEach(async () => {
  while (hosts.length) await hosts.pop()!.dispose();
});

function makeHost(): DesktopHost {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-p1-home-"));
  const host = new DesktopHost({
    home,
    grokPath: nodeBin,
    agentArgs: [fakeAgent],
    env: { ...process.env },
  });
  hosts.push(host);
  return host;
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-p1-repo-"));
  spawnSync("git", ["init"], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
  fs.mkdirSync(path.join(dir, ".hidden-dir"));
  fs.writeFileSync(path.join(dir, ".hidden-dir", "secret.txt"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir, windowsHide: true });
  spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: dir, windowsHide: true },
  );
  return dir;
}

describe("P1 rest: @! hidden / threads.fork", () => {
  it("searchProjectFiles skips dotfiles by default; includeHidden and !query show them", () => {
    const repo = tempRepo();
    const normal = searchProjectFiles({ cwd: repo, query: "env", limit: 50 });
    expect(normal.hits.some((h) => h.name.includes(".env"))).toBe(false);

    const hidden = searchProjectFiles({
      cwd: repo,
      query: "env",
      includeHidden: true,
      limit: 50,
    });
    expect(hidden.hits.some((h) => h.name.includes(".env"))).toBe(true);

    const bang = searchProjectFiles({ cwd: repo, query: "!env", limit: 50 });
    expect(bang.hits.some((h) => h.name.includes(".env"))).toBe(true);
  });

  it("threadsFork copies chat_history and marks parent", async () => {
    const host = makeHost();
    const repo = tempRepo();
    const p = host.projectsAdd({ path: repo, trust: true });
    const created = await host.threadsCreate({
      cwd: repo,
      projectId: p.id,
      title: "src-session",
    });
    // fake agent 不落盘：按 Desktop 布局 seed 源会话目录
    const home = (host as unknown as { home: string }).home;
    const srcDir = path.join(
      home,
      ".grok-desktop",
      "sessions",
      encodeURIComponent(path.resolve(repo)),
      created.sessionId,
    );
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "chat_history.jsonl"),
      JSON.stringify({ role: "user", content: "hello fork" }) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(srcDir, "goal.json"),
      JSON.stringify({ title: "g" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(srcDir, "summary.json"),
      JSON.stringify({
        title: "src-session",
        info: { id: created.sessionId, cwd: path.resolve(repo) },
      }),
      "utf8",
    );

    const forked = await host.threadsFork({
      sourceSessionId: created.sessionId,
      cwd: repo,
      projectId: p.id,
      title: "branch-title",
    });
    expect(forked.sessionId).not.toBe(created.sessionId);
    expect(forked.parentSessionId).toBe(created.sessionId);
    expect(forked.historyCopied).toBe(true);

    const destDir = host.findSessionDir(forked.sessionId);
    expect(destDir).toBeTruthy();
    expect(fs.existsSync(path.join(destDir, "chat_history.jsonl"))).toBe(true);
    const hist = fs.readFileSync(
      path.join(destDir, "chat_history.jsonl"),
      "utf8",
    );
    expect(hist).toContain("hello fork");
    expect(fs.existsSync(path.join(destDir, "goal.json"))).toBe(true);
    const sum = JSON.parse(
      fs.readFileSync(path.join(destDir, "summary.json"), "utf8"),
    ) as {
      session_kind?: string;
      parent_session_id?: string;
      title?: string;
    };
    expect(sum.session_kind).toBe("fork");
    expect(sum.parent_session_id).toBe(created.sessionId);
    expect(sum.title).toBe("branch-title");

    // listThreads 应透出 fork 元数据，供侧栏「派生」标记与「来自」
    const listed = host.listThreads().find((t) => t.sessionId === forked.sessionId);
    expect(listed?.sessionKind).toBe("fork");
    expect(listed?.parentSessionId).toBe(created.sessionId);
  });
});
