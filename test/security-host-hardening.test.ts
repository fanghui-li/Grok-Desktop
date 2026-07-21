import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readFileDataUrl, resolveUnderRoots } from "../src/host/files.js";
import { isIntervalSchedule, AutomationStore } from "../src/host/automations.js";
import { WorktreeService } from "../src/host/worktrees.js";
import { DesktopHost } from "../src/host/host.js";
import { HostError } from "../src/shared/errors.js";
import { desktopDir } from "../src/host/paths.js";
import type { Thread } from "../src/shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(here, "fake-acp-agent.mjs");
const nodeBin = process.execPath;
const hosts: DesktopHost[] = [];

afterEach(async () => {
  while (hosts.length) await hosts.pop()!.dispose();
});

function makeHost(): DesktopHost {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sec-home-"));
  const host = new DesktopHost({
    home,
    grokPath: nodeBin,
    agentArgs: [fakeAgent],
    env: { ...process.env },
  });
  hosts.push(host);
  return host;
}

/** Live thread object (roster projection may omit accessMode). */
function liveThread(host: DesktopHost, threadId: string): Thread {
  const map = (host as unknown as {
    threads: Map<string, { thread: Thread }>;
  }).threads;
  const live = map.get(threadId);
  if (!live) throw new Error(`live thread missing: ${threadId}`);
  return live.thread;
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sec-repo-"));
  spawnSync("git", ["init"], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  fs.writeFileSync(
    path.join(dir, "pic.png"),
    Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
  );
  spawnSync("git", ["add", "."], { cwd: dir, windowsHide: true });
  spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
    { cwd: dir, windowsHide: true },
  );
  return dir;
}

describe("security: files.readDataUrl path sandbox", () => {
  it("denies absolute paths outside roots", () => {
    const repo = tempRepo();
    const secret = path.join(os.tmpdir(), `grok-secret-${Date.now()}.png`);
    fs.writeFileSync(secret, Buffer.from([1, 2, 3, 4]));
    expect(() => readFileDataUrl({ path: secret, roots: [repo] })).toThrowError(
      /Path outside project roots/,
    );
  });

  it("allows files under project roots", () => {
    const repo = tempRepo();
    const r = readFileDataUrl({
      path: path.join(repo, "pic.png"),
      roots: [repo],
    });
    expect(r.mime).toBe("image/png");
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("allows paste-images under desktop home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sec-paste-"));
    const pasteDir = path.join(desktopDir(home), "paste-images");
    fs.mkdirSync(pasteDir, { recursive: true });
    const img = path.join(pasteDir, "x.png");
    fs.writeFileSync(img, Buffer.from([9, 8, 7]));
    const r = readFileDataUrl({ path: img, home, roots: [] });
    expect(r.bytes).toBe(3);
  });

  it("resolveUnderRoots denies empty roots", () => {
    expect(() =>
      resolveUnderRoots(path.join(os.tmpdir(), "x"), null, []),
    ).toThrow(HostError);
  });

  it("Host.filesReadDataUrl uses project roots", () => {
    const host = makeHost();
    const repo = tempRepo();
    host.projectsAdd({ path: repo, trust: true });
    const ok = host.filesReadDataUrl({ path: path.join(repo, "pic.png") });
    expect(ok.bytes).toBeGreaterThan(0);

    const secret = path.join(os.tmpdir(), `grok-secret2-${Date.now()}.png`);
    fs.writeFileSync(secret, Buffer.from([1, 2, 3]));
    expect(() => host.filesReadDataUrl({ path: secret })).toThrowError(
      /Path outside project roots/,
    );
  });
});

describe("security: session alwaysApprove priority", () => {
  it("explicit alwaysApprove false wins over desktop default YOLO", async () => {
    const host = makeHost();
    host.configPatch({ alwaysApproveDefault: true });
    const repo = tempRepo();
    host.projectsAdd({ path: repo, trust: true });
    const created = await host.threadsCreate({
      cwd: repo,
      prompt: "hi",
      alwaysApprove: false,
    });
    expect(liveThread(host, created.threadId).accessMode).toBe("normal");
  });

  it("mode=normal is not forced to YOLO by alwaysApproveDefault", async () => {
    const host = makeHost();
    host.configPatch({
      alwaysApproveDefault: true,
      defaultPermMode: "always_approve",
    });
    const repo = tempRepo();
    host.projectsAdd({ path: repo, trust: true });
    const created = await host.threadsCreate({
      cwd: repo,
      prompt: "hi",
      mode: "normal",
    });
    expect(liveThread(host, created.threadId).accessMode).toBe("normal");
  });

  it("default YOLO still applies when session does not override", async () => {
    const host = makeHost();
    host.configPatch({ alwaysApproveDefault: true });
    const repo = tempRepo();
    host.projectsAdd({ path: repo, trust: true });
    const created = await host.threadsCreate({
      cwd: repo,
      prompt: "hi",
    });
    expect(liveThread(host, created.threadId).accessMode).toBe("always_approve");
  });
});

describe("security: automations interval cannot YOLO", () => {
  it("isIntervalSchedule detects every_N_minutes", () => {
    expect(isIntervalSchedule("every_15_minutes")).toBe(true);
    expect(isIntervalSchedule("every_1_minute")).toBe(true);
    expect(isIntervalSchedule("0 9 * * *")).toBe(false);
  });

  it("create/update force alwaysApprove false for interval", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auto-"));
    const store = new AutomationStore(home);
    const a = store.create({
      name: "tick",
      projectId: "p1",
      schedule: "every_5_minutes",
      prompt: "run",
      worktreeMode: "project_root",
      alwaysApprove: true,
    });
    expect(a.alwaysApprove).toBe(false);

    const b = store.create({
      name: "manual",
      projectId: "p1",
      schedule: "manual",
      prompt: "run",
      worktreeMode: "project_root",
      alwaysApprove: true,
    });
    expect(b.alwaysApprove).toBe(true);

    const updated = store.update(b.id, {
      schedule: "every_10_minutes",
      alwaysApprove: true,
    });
    expect(updated.alwaysApprove).toBe(false);
  });

  it("migrateSafeDefaults scrubs legacy interval YOLO", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-auto-mig-"));
    const store = new AutomationStore(home);
    store.create({
      name: "legacy2",
      projectId: "p1",
      schedule: "every_3_minutes",
      prompt: "x",
      worktreeMode: "project_root",
      alwaysApprove: false,
    });
    const f = path.join(desktopDir(home), "automations", "automations.json");
    expect(fs.existsSync(f)).toBe(true);
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const item of data.automations) {
      if (String(item.schedule).includes("every_")) item.alwaysApprove = true;
    }
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    const n = store.migrateSafeDefaults();
    expect(n).toBeGreaterThan(0);
    expect(
      store.list().filter((x) => String(x.schedule).includes("every_"))[0]
        .alwaysApprove,
    ).toBe(false);
  });

  it("Host.automationsCreate strips YOLO on interval", () => {
    const host = makeHost();
    const repo = tempRepo();
    const p = host.projectsAdd({ path: repo, trust: true });
    const a = host.automationsCreate({
      name: "n",
      projectId: p.id,
      schedule: "every_2_minutes",
      prompt: "p",
      worktreeMode: "project_root",
      alwaysApprove: true,
    });
    expect(a.alwaysApprove).toBe(false);
  });
});

describe("security: worktree cleanup path guard", () => {
  it("creates under .grok-worktrees", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wt-"));
    const svc = new WorktreeService(home);
    const repo = tempRepo();
    const wt = svc.create({ projectId: "p", projectPath: repo, name: "feat-x" });
    expect(wt.path.replace(/\\/g, "/")).toMatch(/\.grok-worktrees\//);
    // Soft cleanup may fail on Windows file locks; force best-effort.
    const r = svc.cleanup(wt.id, { force: true });
    expect(r.removed).toBe(true);
    expect(r.forced).toBe(true);
  });

  it("refuses paths outside .grok-worktrees", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wt2-"));
    const svc = new WorktreeService(home);
    const repo = tempRepo();
    const wt = svc.create({ projectId: "p", projectPath: repo, name: "feat-y" });
    const f = path.join(desktopDir(home), "worktrees.json");
    expect(fs.existsSync(f)).toBe(true);
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    data.worktrees[0].path = repo; // outside .grok-worktrees
    fs.writeFileSync(f, JSON.stringify(data, null, 2));
    expect(() => svc.cleanup(wt.id, { force: true })).toThrowError(
      /outside \.grok-worktrees/,
    );
  });
});
