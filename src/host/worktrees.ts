import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorktreeInfo } from "../shared/types.js";
import { HostError } from "../shared/errors.js";
import { desktopDir, ensureDesktopDirs } from "./paths.js";

interface WorktreeFile {
  version: number;
  worktrees: WorktreeInfo[];
}

export class WorktreeService {
  constructor(private readonly home?: string) {
    ensureDesktopDirs(home);
  }

  private file(): string {
    return path.join(desktopDir(this.home), "worktrees.json");
  }

  private read(): WorktreeFile {
    const f = this.file();
    if (!fs.existsSync(f)) return { version: 1, worktrees: [] };
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as WorktreeFile;
    } catch {
      return { version: 1, worktrees: [] };
    }
  }

  private write(data: WorktreeFile): void {
    const tmp = this.file() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file());
  }

  list(projectId?: string): WorktreeInfo[] {
    const all = this.read().worktrees;
    return projectId ? all.filter((w) => w.projectId === projectId) : all;
  }

  create(opts: {
    projectId: string;
    projectPath: string;
    name?: string;
  }): WorktreeInfo {
    const repo = path.resolve(opts.projectPath);
    if (!fs.existsSync(path.join(repo, ".git")) && !isGitRepo(repo)) {
      throw new HostError(
        "IO_ERROR",
        `Not a git repository: ${repo} (worktree requires git)`,
      );
    }
    const name =
      opts.name ??
      `wt-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    const wtPath = path.join(repo, ".grok-worktrees", name);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    const r = spawnSync(
      "git",
      ["worktree", "add", "-b", `grok/${name}`, wtPath],
      { cwd: repo, encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0) {
      // retry without new branch
      const r2 = spawnSync("git", ["worktree", "add", "--detach", wtPath], {
        cwd: repo,
        encoding: "utf8",
        windowsHide: true,
      });
      if (r2.status !== 0) {
        throw new HostError(
          "IO_ERROR",
          `git worktree add failed: ${r2.stderr || r.stderr || r.stdout}`,
        );
      }
    }

    const info: WorktreeInfo = {
      id: `wt_${randomUUID()}`,
      projectId: opts.projectId,
      path: wtPath,
      name,
      branch: `grok/${name}`,
      createdAt: new Date().toISOString(),
      boundSessionIds: [],
    };
    const data = this.read();
    data.worktrees.push(info);
    this.write(data);
    return info;
  }

  bindSession(worktreeId: string, sessionId: string): void {
    const data = this.read();
    const w = data.worktrees.find((x) => x.id === worktreeId);
    if (!w) return;
    if (!w.boundSessionIds.includes(sessionId)) {
      w.boundSessionIds.push(sessionId);
    }
    this.write(data);
  }

  cleanup(
    worktreeId: string,
    opts?: { force?: boolean; activeSessionIds?: string[] },
  ): {
    removed: boolean;
    path: string;
    forced: boolean;
    busy: boolean;
    missingOnDisk?: boolean;
    diskDeleteFailed?: boolean;
    error?: string;
  } {
    const data = this.read();
    const w = data.worktrees.find((x) => x.id === worktreeId);
    if (!w) throw new HostError("INVALID_ARGUMENT", `Unknown worktree: ${worktreeId}`);
    const abs = path.resolve(w.path);
    // Only remove Desktop-managed worktrees under .grok-worktrees (defense in depth).
    const norm = abs.replace(/\\/g, "/").toLowerCase();
    if (!norm.includes("/.grok-worktrees/")) {
      throw new HostError(
        "PERMISSION_DENIED",
        `Refusing to remove path outside .grok-worktrees: ${abs}`,
      );
    }
    const active = opts?.activeSessionIds ?? [];
    const busy = w.boundSessionIds.some((s) => active.includes(s));
    if (busy && !opts?.force) {
      throw new HostError(
        "PERMISSION_DENIED",
        "Worktree has active Threads; stop them or pass force",
      );
    }
    const repo = findGitRoot(abs) ?? path.dirname(path.dirname(abs));
    const force = Boolean(opts?.force);
    // Prefer soft remove; --force only when caller explicitly requests.
    const args = force
      ? ["worktree", "remove", "--force", abs]
      : ["worktree", "remove", abs];
    const r = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) {
      if (!fs.existsSync(abs)) {
        data.worktrees = data.worktrees.filter((x) => x.id !== worktreeId);
        this.write(data);
        return { removed: true, missingOnDisk: true, path: abs, forced: force, busy };
      }
      const detail = (r.stderr || r.stdout || "").toString().trim().slice(0, 400);
      // force=true: drop registry even if Windows file locks block disk delete
      // (soft remove still surfaces the git error).
      if (force) {
        data.worktrees = data.worktrees.filter((x) => x.id !== worktreeId);
        this.write(data);
        return {
          removed: true,
          path: abs,
          forced: true,
          busy,
          diskDeleteFailed: true,
          error: detail || `exit ${r.status}`,
        };
      }
      throw new HostError(
        "IO_ERROR",
        `git worktree remove failed: ${detail || `exit ${r.status}`}`,
      );
    }
    data.worktrees = data.worktrees.filter((x) => x.id !== worktreeId);
    this.write(data);
    return { removed: true, path: abs, forced: force, busy };
  }

  get(id: string): WorktreeInfo | undefined {
    return this.read().worktrees.find((w) => w.id === id);
  }
}

function isGitRepo(dir: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 && (r.stdout ?? "").trim() === "true";
}

function findGitRoot(dir: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}
