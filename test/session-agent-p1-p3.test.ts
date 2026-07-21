/**
 * P1–P3 session/agent improve: pure modules + Host APIs (Mode B).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_IDENTIFIER, readAppVersion } from "../src/host/app-version.js";
import {
  DEFAULT_IDLE_DETACH,
  pickLruDetachTargets,
  shouldIdleDetach,
  type LiveAttachSnapshot,
} from "../src/host/attach-policy.js";
import {
  applyRuntimeCapabilitySignal,
  BASELINE_CAPABILITIES,
  parseInitializeCapabilities,
} from "../src/host/capabilities.js";
import {
  copySessionHistoryForFork,
  countHistoryLines,
  writeForkSummary,
} from "../src/host/fork-session.js";
import { DesktopHost } from "../src/host/host.js";
import {
  listDesktopHooks,
  loadHooksTrustMap,
  setHookTrusted,
} from "../src/host/hooks-trust.js";
import {
  normalizeSessionNotification,
  normalizeSessionUpdate,
} from "../src/host/normalize.js";
import {
  clearQueue,
  enqueueItem,
  loadQueue,
  reorderItems,
  saveQueue,
  setQueueFlags,
} from "../src/host/prompt-queue.js";
import { findSessionDir } from "../src/host/paths.js";
import { aggregateTasksLoose } from "../src/host/tasks-aggregate.js";
import { spawnSync } from "node:child_process";

const fakeAgent = path.join(__dirname, "fake-acp-agent.mjs");
const homes: string[] = [];
const openHosts: DesktopHost[] = [];

function tempHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "grok-p1p3-"));
  homes.push(h);
  return h;
}

function trackHost(host: DesktopHost): DesktopHost {
  openHosts.push(host);
  return host;
}

function plantSession(home: string, sessionId: string, cwd: string): string {
  const enc = encodeURIComponent(path.resolve(cwd));
  const dir = path.join(home, ".grok-desktop", "sessions", enc, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      title: "src",
      updated_at: new Date().toISOString(),
      info: { cwd: path.resolve(cwd), id: sessionId },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "chat_history.jsonl"),
    JSON.stringify({ role: "user", content: "hello" }) + "\n",
    "utf8",
  );
  return dir;
}

function spawnSyncSafeGit(cwd: string): void {
  spawnSync("git", ["init"], { cwd, windowsHide: true });
}

function findSessionDirFallback(
  home: string,
  sessionId: string,
  cwd: string,
): string | null {
  const via = findSessionDir(sessionId, home);
  if (via) return via;
  const enc = encodeURIComponent(path.resolve(cwd));
  const p = path.join(home, ".grok-desktop", "sessions", enc, sessionId);
  return fs.existsSync(p) ? p : null;
}

afterEach(async () => {
  while (openHosts.length) {
    const h = openHosts.pop()!;
    try {
      await h.dispose();
    } catch {
      /* ignore */
    }
  }
  // let log streams flush before rm
  await new Promise((r) => setTimeout(r, 20));
  while (homes.length) {
    const h = homes.pop()!;
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("P1-A clientIdentifier + version", () => {
  it("CLIENT_IDENTIFIER is grok-desktop", () => {
    expect(CLIENT_IDENTIFIER).toBe("grok-desktop");
  });

  it("readAppVersion matches package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"),
    ) as { version: string };
    expect(readAppVersion()).toBe(pkg.version);
    expect(readAppVersion()).not.toBe("0.1.0");
  });

  it("fake agent wire receives clientIdentifier + package version", async () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    homes.push(cwd);
    const initLog = path.join(home, "init-params.json");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"),
    ) as { version: string };
    const host = trackHost(
      new DesktopHost({
        home,
        grokPath: process.execPath,
        agentArgs: [fakeAgent],
        env: { ...process.env, FAKE_ACP_INIT_LOG: initLog },
      }),
    );
    await host.threadsCreate({ cwd, title: "init-wire" });
    expect(fs.existsSync(initLog)).toBe(true);
    const init = JSON.parse(fs.readFileSync(initLog, "utf8")) as {
      clientInfo?: { name?: string; version?: string };
      _meta?: { clientIdentifier?: string; clientVersion?: string };
    };
    expect(init.clientInfo?.name).toBe("grok-desktop");
    expect(init.clientInfo?.version).toBe(pkg.version);
    expect(init.clientInfo?.version).not.toBe("0.1.0");
    expect(init._meta?.clientIdentifier).toBe("grok-desktop");
    expect(init._meta?.clientVersion).toBe(pkg.version);
  });

  it("threadsCreate live + ping with fake agent", async () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    homes.push(cwd);
    const host = trackHost(
      new DesktopHost({
        home,
        grokPath: process.execPath,
        agentArgs: [fakeAgent],
      }),
    );
    const created = await host.threadsCreate({ cwd, title: "init-id" });
    const st = host.threadsAttachState({ threadId: created.threadId });
    expect(st.state).toBe("live");
    const ping = host.threadsPing(created.threadId);
    expect(ping.ok).toBe(true);
    expect(ping.alive).toBe(true);
    const info = host.grokInfo();
    expect(info.capabilities.worktreeApi).toBe(true);
    expect(info.capabilities.hunkTimeline).toBe(true);
  });
});

describe("P1-C durable prompt queue", () => {
  it("enqueue persists across load and isolates sessions", () => {
    const home = tempHome();
    const a = enqueueItem(
      "sess-a",
      { display: "one", content: "one", attachments: [] },
      home,
    );
    expect(a.items).toHaveLength(1);
    enqueueItem(
      "sess-a",
      { display: "two", content: "two", attachments: [] },
      home,
    );
    enqueueItem(
      "sess-b",
      { display: "b1", content: "b1", attachments: [] },
      home,
    );
    const la = loadQueue("sess-a", home);
    const lb = loadQueue("sess-b", home);
    expect(la.items.map((i) => i.content)).toEqual(["one", "two"]);
    expect(lb.items).toHaveLength(1);
    const reordered = reorderItems(
      "sess-a",
      [la.items[1]!.id, la.items[0]!.id],
      home,
    );
    expect(reordered.items.map((i) => i.content)).toEqual(["two", "one"]);
    setQueueFlags("sess-a", { pausedByInterrupt: true }, home);
    expect(loadQueue("sess-a", home).pausedByInterrupt).toBe(true);
    clearQueue("sess-a", home);
    expect(loadQueue("sess-a", home).items).toHaveLength(0);
  });

  it("Host queueGet/enqueue emit durable file", () => {
    const home = tempHome();
    const host = trackHost(new DesktopHost({ home }));
    const q = host.queueEnqueue("sid-host", {
      content: "hello queue",
      display: "hello",
    });
    expect(q.items).toHaveLength(1);
    expect(host.queueGet("sid-host").items[0]?.content).toBe("hello queue");
    host.queueSetFlags("sid-host", { queueingEnabled: false });
    expect(host.queueGet("sid-host").queueingEnabled).toBe(false);
  });
});

describe("P1-D fork copy", () => {
  it("copySessionHistoryForFork copies history files", () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    homes.push(cwd);
    const src = plantSession(home, "parent-sess", cwd);
    const dest = path.join(path.dirname(src), "child-sess");
    const r = copySessionHistoryForFork(src, dest);
    expect(r.historyCopied).toBe(true);
    expect(countHistoryLines(dest)).toBe(1);
    writeForkSummary({
      destDir: dest,
      sessionId: "child-sess",
      parentSessionId: "parent-sess",
      cwd,
      title: "分支",
      sourceSummaryPath: path.join(src, "summary.json"),
    });
    const sum = JSON.parse(
      fs.readFileSync(path.join(dest, "summary.json"), "utf8"),
    ) as { session_kind: string; parent_session_id: string };
    expect(sum.session_kind).toBe("fork");
    expect(sum.parent_session_id).toBe("parent-sess");
  });

  it("Host threadsFork F2: history on child + directiveSent", async () => {
    const home = tempHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-fork-"));
    homes.push(cwd);
    spawnSyncSafeGit(cwd);
    const host = trackHost(
      new DesktopHost({
        home,
        grokPath: process.execPath,
        agentArgs: [fakeAgent],
      }),
    );
    const created = await host.threadsCreate({
      cwd,
      title: "fork-src",
    });
    // Seed the real session dir Host uses (fake agent does not write chat_history)
    let srcDir = host.findSessionDir(created.sessionId);
    if (!srcDir) {
      srcDir = plantSession(home, created.sessionId, cwd);
    }
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "chat_history.jsonl"),
      JSON.stringify({ role: "user", content: "line-a" }) +
        "\n" +
        JSON.stringify({ role: "assistant", content: "line-b" }) +
        "\n",
      "utf8",
    );
    const forked = await host.threadsFork({
      sourceSessionId: created.sessionId,
      cwd,
      title: "fork-child",
      directive: "follow up from fork",
    });
    expect(forked.parentSessionId).toBe(created.sessionId);
    expect(forked.historyCopied).toBe(true);
    expect(forked.directiveSent).toBe(true);
    expect(forked.sessionId).not.toBe(created.sessionId);
    const childDir =
      host.findSessionDir(forked.sessionId) ??
      findSessionDirFallback(home, forked.sessionId, cwd);
    expect(childDir).toBeTruthy();
    expect(countHistoryLines(childDir!)).toBeGreaterThanOrEqual(2);
    const sum = JSON.parse(
      fs.readFileSync(path.join(childDir!, "summary.json"), "utf8"),
    ) as { session_kind?: string; parent_session_id?: string };
    expect(sum.session_kind).toBe("fork");
    expect(sum.parent_session_id).toBe(created.sessionId);
  });
});

describe("P1-B / P3-C attach policy", () => {
  it("shouldIdleDetach respects working and TTL", () => {
    const now = 1_000_000;
    const snap: LiveAttachSnapshot = {
      threadId: "t1",
      sessionId: "s1",
      state: "live",
      lastActiveAt: now - 30 * 60 * 1000,
      working: false,
      hasPendingPermission: false,
      hasRunningTask: false,
      hasSendingQueueItem: false,
    };
    expect(shouldIdleDetach(snap, now, { ...DEFAULT_IDLE_DETACH })).toBe(
      true,
    );
    expect(
      shouldIdleDetach({ ...snap, working: true }, now, {
        ...DEFAULT_IDLE_DETACH,
      }),
    ).toBe(false);
  });

  it("pickLruDetachTargets picks excess idle", () => {
    const now = Date.now();
    const live: LiveAttachSnapshot[] = [1, 2, 3, 4, 5].map((i) => ({
      threadId: `t${i}`,
      sessionId: `s${i}`,
      state: "live" as const,
      lastActiveAt: now - i * 60_000,
      working: false,
      hasPendingPermission: false,
      hasRunningTask: false,
      hasSendingQueueItem: false,
    }));
    const pick = pickLruDetachTargets(
      live,
      { idleDetachMs: 0, maxLiveAttaches: 2 },
      now,
    );
    // idleDetachMs 0 disables idle; still LRU by max
    expect(pick.length).toBe(3);
  });
});

describe("P2-A QueueChanged normalize", () => {
  it("queue_changed from session update", () => {
    const evs = normalizeSessionUpdate("t1", "sess-1", {
      sessionUpdate: "queue_changed",
      itemCount: 2,
      pausedByInterrupt: true,
    });
    expect(evs[0]).toMatchObject({
      type: "queue.changed",
      source: "agent",
      itemCount: 2,
      pausedByInterrupt: true,
    });
  });

  it("queue_changed from session notification PascalCase", () => {
    const evs = normalizeSessionNotification("t1", "sess-1", {
      sessionUpdate: "QueueChanged",
      item_count: 1,
    });
    expect(evs[0]).toMatchObject({
      type: "queue.changed",
      itemCount: 1,
    });
  });
});

describe("P2-B tasks aggregate", () => {
  it("merges process monitor subagent scheduled", () => {
    const items = aggregateTasksLoose({
      sessionId: "s1",
      processSnaps: [
        {
          taskId: "p1",
          phase: "backgrounded",
          command: "npm t",
          sessionId: "s1",
        },
        {
          taskId: "m1",
          phase: "monitor",
          isMonitor: true,
          description: "watch",
          sessionId: "s1",
        },
      ],
      subagents: [
        {
          id: "sa1",
          type: "explore",
          status: "running",
          childSessionId: "child-1",
          summary: "explore",
        } as never,
      ],
      automationsForSession: [
        {
          id: "auto1",
          name: "nightly",
          status: "active",
          projectId: "p",
          schedule: "0 0 * * *",
          prompt: "x",
          worktreeMode: "project_root",
          alwaysApprove: false,
          createdAt: "",
          updatedAt: "",
        } as never,
      ],
    });
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["monitor", "process", "scheduled", "subagent"]);
  });
});

describe("P2-C dynamic capabilities", () => {
  it("parseInitializeCapabilities merges agent fields", () => {
    const caps = parseInitializeCapabilities({
      agentCapabilities: { loadSession: true },
      _meta: {
        agentVersion: "1.2.3",
        "x.ai/hooks": true,
        "x.ai/queue": true,
      },
    });
    expect(caps.loadSession).toBe(true);
    expect(caps.agentVersion).toBe("1.2.3");
    expect(caps.hooks).toBe(true);
    expect(caps.queueWire).toBe(true);
    expect(caps.worktreeApi).toBe(true);
    expect(caps.hunkTimeline).toBe(true);
  });

  it("runtime signals update caps", () => {
    let c = { ...BASELINE_CAPABILITIES, queueWire: false };
    c = applyRuntimeCapabilitySignal(c, "queue_changed");
    expect(c.queueWire).toBe(true);
  });
});

describe("P3 skills resolve + hooks", () => {
  it("skillsResolve finds SKILL.md", () => {
    const home = tempHome();
    const skillDir = path.join(
      home,
      ".grok-desktop",
      "skills",
      "demo-skill",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "# Demo\n\nDo the thing.\n",
      "utf8",
    );
    const host = trackHost(new DesktopHost({ home }));
    const r = host.skillsResolve("demo-skill");
    expect(r.mode).toBe("resolved");
    expect(r.prompt).toContain("Do the thing");
    const fb = host.skillsResolve("missing-skill-xyz");
    expect(fb.mode).toBe("prompt_fallback");
  });

  it("hooksList reads hooks-trust.json (default untrusted until trust)", () => {
    const home = tempHome();
    const cfgDir = path.join(home, ".grok-desktop");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, "config.toml"),
      "# hooks\n# PreToolUse\n# PostToolUse\n",
      "utf8",
    );
    // Pure module: default not trusted
    const listed0 = listDesktopHooks(home);
    const pre = listed0.hooks.find((h) => h.event === "PreToolUse");
    expect(pre).toBeTruthy();
    expect(pre!.trusted).toBe(false);

    setHookTrusted("config:PreToolUse", true, home);
    expect(loadHooksTrustMap(home)["config:PreToolUse"]).toBe(true);
    const listed1 = listDesktopHooks(home);
    expect(
      listed1.hooks.find((h) => h.id === "config:PreToolUse")?.trusted,
    ).toBe(true);

    setHookTrusted("config:PreToolUse", false, home);
    expect(
      listDesktopHooks(home).hooks.find((h) => h.id === "config:PreToolUse")
        ?.trusted,
    ).toBe(false);

    // Host facade uses same path
    const host = trackHost(new DesktopHost({ home }));
    host.hooksTrust("config:PostToolUse");
    expect(
      host.hooksList().hooks.find((h) => h.id === "config:PostToolUse")
        ?.trusted,
    ).toBe(true);
    host.hooksUntrust("config:PostToolUse");
    expect(
      host.hooksList().hooks.find((h) => h.id === "config:PostToolUse")
        ?.trusted,
    ).toBe(false);
  });
});

describe("saveQueue roundtrip", () => {
  it("writes version 1 file", () => {
    const home = tempHome();
    const q = saveQueue(
      {
        version: 1,
        sessionId: "round",
        updatedAt: new Date().toISOString(),
        queueingEnabled: true,
        pausedByInterrupt: false,
        items: [
          {
            id: "q1",
            display: "d",
            content: "c",
            attachments: [],
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        ],
      },
      home,
    );
    expect(q.version).toBe(1);
    expect(loadQueue("round", home).items[0]?.id).toBe("q1");
  });
});
