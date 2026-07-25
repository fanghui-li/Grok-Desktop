/**
 * folder-trust 桥 + hooks 磁盘发现（L0–L2）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  folderTrustStorePath,
  grantFolderTrust,
  isFolderTrusted,
  loadFolderTrustMap,
  parseTrustedFoldersToml,
  revokeFolderTrust,
  serializeTrustedFoldersToml,
  workspaceKeyForCwd,
} from "../src/host/folder-trust.js";
import { listDesktopHooks } from "../src/host/hooks-discover.js";
import { DesktopHost } from "../src/host/host.js";
import { ensureDesktopDirs, hooksDir } from "../src/host/paths.js";

const temps: string[] = [];

function tempHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gd-hooks-"));
  temps.push(d);
  return d;
}

afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("folder-trust toml", () => {
  it("roundtrips serialize/parse", () => {
    const map = new Map([
      ["D:\\repo\\a", { trusted: true, decidedAt: 100 }],
      ["D:\\repo\\b", { trusted: false, decidedAt: 200 }],
    ]);
    const text = serializeTrustedFoldersToml(map);
    const back = parseTrustedFoldersToml(text);
    expect(back.get("D:\\repo\\a")?.trusted).toBe(true);
    expect(back.get("D:\\repo\\b")?.trusted).toBe(false);
  });

  it("grant and isFolderTrusted on temp repo", () => {
    const home = tempHome();
    const repo = path.join(home, "proj");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    ensureDesktopDirs(home);

    expect(isFolderTrusted(repo, home)).toBe(false);
    const g = grantFolderTrust(repo, home);
    expect(g.ok).toBe(true);
    expect(isFolderTrusted(repo, home)).toBe(true);
    expect(fs.existsSync(folderTrustStorePath(home))).toBe(true);

    const rev = revokeFolderTrust(repo, home);
    expect(rev.wasTrusted).toBe(true);
    expect(isFolderTrusted(repo, home)).toBe(false);
  });

  it("workspaceKey prefers git root", () => {
    const home = tempHome();
    const repo = path.join(home, "gitproj");
    const sub = path.join(repo, "src", "pkg");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    expect(workspaceKeyForCwd(sub).toLowerCase()).toBe(
      path.resolve(repo).toLowerCase(),
    );
  });
});

describe("hooks discover", () => {
  it("lists user hooks json and marks project by folder-trust", () => {
    const home = tempHome();
    ensureDesktopDirs(home);
    const ud = hooksDir(home);
    fs.writeFileSync(
      path.join(ud, "session-log.json"),
      JSON.stringify({ hooks: { SessionStart: [] } }),
      "utf8",
    );

    const repo = path.join(home, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".grok", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".grok", "hooks", "guard.json"),
      "{}",
      "utf8",
    );

    const listed0 = listDesktopHooks(home, { projectPath: repo });
    expect(listed0.hooks.some((h) => h.name === "session-log")).toBe(true);
    const proj0 = listed0.hooks.find((h) => h.name === "guard");
    expect(proj0?.scope).toBe("project");
    expect(proj0?.trusted).toBe(false);

    grantFolderTrust(repo, home);
    const listed1 = listDesktopHooks(home, { projectPath: repo });
    expect(listed1.hooks.find((h) => h.name === "guard")?.trusted).toBe(true);
  });
});

describe("Host projects trust bridge", () => {
  it("projectsAdd/update sync trusted_folders.toml", () => {
    const home = tempHome();
    const repo = path.join(home, "work");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const host = new DesktopHost({ home });

    const p = host.projectsAdd({ path: repo, trust: true });
    expect(p.trust).toBe("trusted");
    expect(isFolderTrusted(repo, home)).toBe(true);
    expect(loadFolderTrustMap(home).size).toBeGreaterThan(0);

    host.projectsUpdate(p.id, { trust: "untrusted" });
    expect(isFolderTrusted(repo, home)).toBe(false);

    const list = host.hooksList({ projectPath: repo });
    expect(list.hooksDir).toContain("hooks");
  });
});
