import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentBinMeta,
  GrokCapabilities,
  GrokInfo,
} from "../shared/types.js";
import { BASELINE_CAPABILITIES } from "./capabilities.js";

export interface ResolveGrokOptions {
  /** 设置 / 环境变量覆盖路径 */
  overridePath?: string | null;
  /** 项目 agent-bin 或安装包内置路径 */
  bundledPath?: string | null;
  /** 额外搜索目录（测试） */
  extraPathDirs?: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_CAPABILITIES: GrokCapabilities = {
  ...BASELINE_CAPABILITIES,
};

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function candidateNames(): string[] {
  return process.platform === "win32" ? ["grok.exe", "grok"] : ["grok"];
}

function searchDir(dir: string): string | null {
  if (!dir) return null;
  for (const name of candidateNames()) {
    const full = path.join(dir, name);
    if (isExecutableFile(full)) return full;
  }
  return null;
}

/**
 * 解析顺序：
 * 1. override（设置 / GROK_DESKTOP_AGENT）
 * 2. bundled（agent-bin / 安装包 resources/agent）
 * 3. PATH / ~/.grok/bin / ~/.grok-desktop/bin
 *
 * 用户数据始终在 Desktop GROK_HOME（~/.grok-desktop），与二进制来源无关。
 */
export function resolveGrokBinary(opts: ResolveGrokOptions = {}): {
  path: string | null;
  source: GrokInfo["source"];
} {
  const env = opts.env ?? process.env;
  const osHome = opts.home ?? os.homedir();

  if (opts.overridePath && isExecutableFile(opts.overridePath)) {
    return { path: path.resolve(opts.overridePath), source: "override" };
  }

  if (opts.bundledPath && isExecutableFile(opts.bundledPath)) {
    return { path: path.resolve(opts.bundledPath), source: "bundled" };
  }

  const pathEnv = env.PATH ?? env.Path ?? "";
  const dirs = [
    ...(opts.extraPathDirs ?? []),
    ...pathEnv.split(path.delimiter),
    path.join(osHome, ".grok", "bin"),
    path.join(osHome, ".grok-desktop", "bin"),
  ];

  for (const dir of dirs) {
    const hit = searchDir(dir);
    if (hit) return { path: hit, source: "path" };
  }

  return { path: null, source: "missing" };
}

export function readGrokVersion(binaryPath: string): string | null {
  try {
    const r = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const line = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

/** 读取与二进制同目录的 VERSION.txt（sync:agent 生成） */
export function readAgentBinMeta(binaryPath: string | null): AgentBinMeta | null {
  if (!binaryPath) return null;
  const versionFile = path.join(path.dirname(binaryPath), "VERSION.txt");
  try {
    if (!fs.existsSync(versionFile)) return null;
    const text = fs.readFileSync(versionFile, "utf8");
    const pick = (key: string): string | null => {
      const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
      const v = m?.[1]?.trim();
      return v ? v : null;
    };
    return {
      version: pick("version"),
      source: pick("source"),
      syncedAt: pick("synced_at"),
      sha256: pick("sha256"),
      binary: pick("binary"),
    };
  } catch {
    return null;
  }
}

export function buildGrokInfo(opts: ResolveGrokOptions = {}): GrokInfo {
  const resolved = resolveGrokBinary(opts);
  const version = resolved.path ? readGrokVersion(resolved.path) : null;
  const agentBinMeta = readAgentBinMeta(resolved.path);
  return {
    path: resolved.path,
    version,
    source: resolved.source,
    agentBinMeta,
    capabilities: resolved.path
      ? { ...DEFAULT_CAPABILITIES }
      : {
          acp: false,
          goalEvents: false,
          subagentTree: true,
          hunkTimeline: false,
          leaderRoster: false,
          worktreeApi: false,
          availableCommands: false,
        },
  };
}
