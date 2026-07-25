import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  ChangeFileSummary,
  ChangeSummary,
  DiffResult,
  HunkTimelineEntry,
} from "../shared/types.js";
import { HostError } from "../shared/errors.js";

export function changesSummary(cwd: string): ChangeSummary {
  const stat = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (stat.status !== 0) {
    return { scope: "thread", cwd, files: [], rawStat: stat.stderr };
  }
  const files: ChangeFileSummary[] = [];
  for (const line of (stat.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const p = line.slice(3).trim();
    let status: ChangeFileSummary["status"] = "M";
    if (code.includes("A") || code === "??") status = code === "??" ? "?" : "A";
    else if (code.includes("D")) status = "D";
    else if (code.includes("R")) status = "R";
    files.push({ path: p, status });
  }
  return { scope: "thread", cwd, files, rawStat: stat.stdout ?? undefined };
}

export function changesDiff(cwd: string, filePath: string): DiffResult {
  const r = spawnSync("git", ["diff", "--", filePath], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  // also try untracked / staged
  let patch = r.stdout ?? "";
  if (!patch.trim()) {
    const r2 = spawnSync("git", ["diff", "--cached", "--", filePath], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    patch = r2.stdout ?? "";
  }
  if (!patch.trim()) {
    const r3 = spawnSync("git", ["diff", "HEAD", "--", filePath], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    patch = r3.stdout ?? "";
  }
  return { path: filePath, patch };
}

export function changesTimeline(cwd: string): HunkTimelineEntry[] {
  // Git-degraded timeline: last commits touching dirty files
  const summary = changesSummary(cwd);
  return summary.files.slice(0, 50).map((f) => ({
    path: f.path,
    summary: `status ${f.status}`,
    turnHint: "git-status",
  }));
}

export function openInEditor(
  filePath: string,
  line?: number,
  editor?: string,
): void {
  const resolved = path.resolve(filePath);
  const cmd =
    editor?.trim() ||
    process.env.GROK_DESKTOP_EDITOR?.trim() ||
    "code";
  // 带路径的 .cmd/.exe 用 shell；PATH 短名用 -g 跳行（VS Code 系）
  const base = path.basename(cmd).toLowerCase().replace(/\.cmd$/i, "").replace(/\.exe$/i, "");
  const isVscodeFamily = ["code", "cursor", "codium", "windsurf", "code-insiders"].includes(
    base,
  );
  try {
    if (isVscodeFamily) {
      spawn(cmd, line != null ? ["-g", `${resolved}:${line}`] : [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: process.platform === "win32",
      }).unref();
    } else {
      spawn(cmd, [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: true,
      }).unref();
    }
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open editor: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 在资源管理器 / Finder 中打开路径（目录或文件所在位置） */
export async function openPath(
  targetPath: string,
  opts?: { /** 不存在时先 mkdir（仅目录入口，如 Skills/Plugins） */ createDir?: boolean },
): Promise<void> {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    if (opts?.createDir) {
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch (e) {
        throw new HostError(
          "IO_ERROR",
          `Failed to create directory: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      throw new HostError("IO_ERROR", `Path not found: ${resolved}`);
    }
  }
  // Electron 主进程：优先 shell.openPath（Windows 比 spawn explorer 更稳）
  try {
    const { shell } = await import("electron");
    const err = await shell.openPath(resolved);
    if (err) {
      throw new HostError("IO_ERROR", err || `Failed to open path: ${resolved}`);
    }
    return;
  } catch (e) {
    if (e instanceof HostError) throw e;
    // 非 Electron / shell 不可用时回退 spawn
  }
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("explorer.exe", [resolved], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (platform === "darwin") {
      spawn("open", [resolved], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [resolved], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open path: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 用系统默认浏览器 / 协议处理器打开 URL（http(s)/mailto 等） */
export async function openExternalUrl(url: string): Promise<void> {
  const u = url.trim();
  if (!u) {
    throw new HostError("INVALID_ARGUMENT", "Empty URL");
  }
  // 仅允许常见安全协议，避免 openExternal 打开任意 scheme
  if (!/^(https?:|mailto:|vscode:|cursor:)/i.test(u)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      `Blocked external URL scheme: ${u.slice(0, 32)}`,
    );
  }
  try {
    // Host 运行在 Electron 主进程
    const { shell } = await import("electron");
    await shell.openExternal(u);
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Failed to open external URL: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
