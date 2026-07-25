/**
 * Desktop 侧 folder-trust 持久化，对齐 CLI
 * `~/.grok/trusted_folders.toml`（Desktop 下为 GROK_HOME=～/.grok-desktop）。
 *
 * 项目 hooks / 项目 MCP 等 agent 闸门读同一文件；Host 在「信任项目」时写入。
 * 不实现 agent 进程内 DECISIONS 缓存（那是 shell 职责）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokHomeDir } from "./paths.js";

export const TRUST_FILE_NAME = "trusted_folders.toml";

export type FolderTrustRecord = {
  trusted: boolean;
  decidedAt?: number;
};

function normalizeKey(p: string): string {
  try {
    return path.resolve(fs.realpathSync.native?.(p) ?? fs.realpathSync(p));
  } catch {
    return path.resolve(p);
  }
}

/** 拒绝 $HOME / 盘符根等过宽 key（对齐 CLI is_unsafe_trust_root 精神） */
export function isUnsafeTrustRoot(key: string): boolean {
  const n = normalizeKey(key);
  const home = normalizeKey(os.homedir());
  if (!path.isAbsolute(n)) return true;
  if (n.toLowerCase() === home.toLowerCase()) return true;
  // Windows 盘符根 C:\ ；POSIX /
  const parsed = path.parse(n);
  if (parsed.root && normalizeKey(parsed.root).toLowerCase() === n.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * 工作区 key：优先 git 根（向上找 .git），否则 cwd。
 * 不接入 worktrees.db（CLI 进阶）；与 CLI 在普通仓库上一致。
 */
export function workspaceKeyForCwd(cwd: string): string {
  let cur = normalizeKey(cwd);
  if (!fs.existsSync(cur)) return cur;
  // 若 cwd 是文件则用目录
  try {
    if (fs.statSync(cur).isFile()) cur = path.dirname(cur);
  } catch {
    /* keep */
  }
  let dir = cur;
  for (;;) {
    const git = path.join(dir, ".git");
    try {
      if (fs.existsSync(git)) {
        const key = normalizeKey(dir);
        if (isUnsafeTrustRoot(key)) return normalizeKey(cwd);
        return key;
      }
    } catch {
      /* continue */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const key = normalizeKey(cwd);
  if (isUnsafeTrustRoot(key)) return key;
  return key;
}

export function folderTrustStorePath(home?: string): string {
  return path.join(grokHomeDir(home), TRUST_FILE_NAME);
}

/** 解析 CLI 形状的 trusted_folders.toml（仅 folders 表） */
export function parseTrustedFoldersToml(text: string): Map<string, FolderTrustRecord> {
  const out = new Map<string, FolderTrustRecord>();
  let currentKey: string | null = null;
  let trusted: boolean | undefined;
  let decidedAt: number | undefined;

  const flush = () => {
    if (currentKey != null && typeof trusted === "boolean") {
      out.set(currentKey, {
        trusted,
        decidedAt: decidedAt,
      });
    }
    currentKey = null;
    trusted = undefined;
    decidedAt = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // [folders."/abs/path"] 或 [folders.'...']；basic string 反斜杠转义
    const sec = line.match(/^\[folders\.(?:"((?:\\.|[^"\\])*)"|'([^']*)')\]$/);
    if (sec) {
      flush();
      const raw = sec[1] != null ? sec[1] : sec[2];
      currentKey =
        raw != null
          ? raw.replace(/\\([\\"])/g, "$1").replace(/\\n/g, "\n")
          : null;
      continue;
    }
    if (currentKey == null) continue;
    const mTrusted = line.match(/^trusted\s*=\s*(true|false)\s*$/i);
    if (mTrusted) {
      trusted = mTrusted[1].toLowerCase() === "true";
      continue;
    }
    const mAt = line.match(/^decided_at\s*=\s*(-?\d+)\s*$/);
    if (mAt) {
      decidedAt = Number(mAt[1]);
    }
  }
  flush();
  return out;
}

export function serializeTrustedFoldersToml(
  map: Map<string, FolderTrustRecord>,
): string {
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b));
  const parts: string[] = [
    "# Grok Desktop folder-trust (aligned with CLI trusted_folders.toml)",
    "",
  ];
  for (const k of keys) {
    const rec = map.get(k)!;
    // TOML basic string: escape backslash and quotes
    const esc = k.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`[folders."${esc}"]`);
    parts.push(`trusted = ${rec.trusted ? "true" : "false"}`);
    if (typeof rec.decidedAt === "number") {
      parts.push(`decided_at = ${rec.decidedAt}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export function loadFolderTrustMap(home?: string): Map<string, FolderTrustRecord> {
  const p = folderTrustStorePath(home);
  try {
    if (!fs.existsSync(p)) return new Map();
    return parseTrustedFoldersToml(fs.readFileSync(p, "utf8"));
  } catch {
    return new Map();
  }
}

export function saveFolderTrustMap(
  map: Map<string, FolderTrustRecord>,
  home?: string,
): void {
  const p = folderTrustStorePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = serializeTrustedFoldersToml(map);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, p);
}

/**
 * 最长前缀匹配（路径组件级），对齐 CLI TrustStore::is_trusted 精神。
 */
export function isFolderTrusted(cwd: string, home?: string): boolean {
  const key = workspaceKeyForCwd(cwd);
  if (isUnsafeTrustRoot(key)) return false;
  const map = loadFolderTrustMap(home);
  const keyNorm = normalizeKey(key);
  let bestDepth = -1;
  let trusted = false;
  for (const [folder, rec] of map) {
    const f = normalizeKey(folder);
    if (isUnsafeTrustRoot(f)) continue;
    const keyL = keyNorm.toLowerCase();
    const fL = f.toLowerCase();
    if (keyL !== fL && !keyL.startsWith(fL.endsWith(path.sep) ? fL : fL + path.sep)) {
      // also allow exact after normalize
      if (keyL !== fL) continue;
    }
    const depth = f.split(/[/\\]/).filter(Boolean).length;
    if (depth > bestDepth) {
      bestDepth = depth;
      trusted = rec.trusted === true;
    } else if (depth === bestDepth) {
      trusted = trusted && rec.trusted === true;
    }
  }
  return trusted;
}

export function grantFolderTrust(cwd: string, home?: string): {
  ok: boolean;
  key: string;
  skipped?: string;
} {
  const key = workspaceKeyForCwd(cwd);
  if (isUnsafeTrustRoot(key)) {
    return { ok: false, key, skipped: "unsafe_root" };
  }
  const map = loadFolderTrustMap(home);
  map.set(normalizeKey(key), {
    trusted: true,
    decidedAt: Math.floor(Date.now() / 1000),
  });
  saveFolderTrustMap(map, home);
  return { ok: true, key: normalizeKey(key) };
}

/**
 * 仅当已 trusted 时写 untrusted（对齐 CLI：避免对从未信任路径写 child DENY 毒化 cascade）。
 */
export function revokeFolderTrust(cwd: string, home?: string): {
  ok: boolean;
  key: string;
  wasTrusted: boolean;
  skipped?: string;
} {
  const key = workspaceKeyForCwd(cwd);
  if (isUnsafeTrustRoot(key)) {
    return { ok: false, key, wasTrusted: false, skipped: "unsafe_root" };
  }
  const nk = normalizeKey(key);
  const map = loadFolderTrustMap(home);
  const prev = map.get(nk);
  // also match by isFolderTrusted cascade
  const wasTrusted = isFolderTrusted(cwd, home);
  if (!wasTrusted && !prev?.trusted) {
    return { ok: true, key: nk, wasTrusted: false };
  }
  map.set(nk, {
    trusted: false,
    decidedAt: Math.floor(Date.now() / 1000),
  });
  saveFolderTrustMap(map, home);
  return { ok: true, key: nk, wasTrusted: true };
}
