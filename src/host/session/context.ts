/**
 * 从会话目录 signals.json 读取上下文占用（对齐 CLI /context 的数据源）。
 */
import fs from "node:fs";
import path from "node:path";
import { findSessionDir } from "../paths.js";

export interface SessionContextUsage {
  sessionId: string;
  /** 已用 tokens */
  used: number;
  /** 窗口上限 tokens */
  total: number;
  /** 0–100 */
  percent: number;
  /** 是否读到文件 */
  available: boolean;
  source: "signals" | "none";
  path?: string;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Math.max(0, Number(v));
  }
  return 0;
}

/** 兼容 agent 多版本字段名 */
function pickNum(raw: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (k in raw) {
      const n = num(raw[k]);
      if (n > 0 || raw[k] === 0) return n;
    }
  }
  // 一层嵌套（偶发 context: { used, window }）
  const nested = raw.context;
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    for (const k of keys) {
      if (k in o) {
        const n = num(o[k]);
        if (n > 0 || o[k] === 0) return n;
      }
    }
  }
  return 0;
}

export function loadSessionContextUsage(
  sessionId: string,
  home?: string,
): SessionContextUsage {
  const empty: SessionContextUsage = {
    sessionId,
    used: 0,
    total: 0,
    percent: 0,
    available: false,
    source: "none",
  };
  if (!sessionId) return empty;

  const dir = findSessionDir(sessionId, home);
  if (!dir) return empty;

  const signalsPath = path.join(dir, "signals.json");
  if (!fs.existsSync(signalsPath)) return { ...empty, path: dir };

  try {
    const raw = JSON.parse(fs.readFileSync(signalsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const used = pickNum(raw, [
      "contextTokensUsed",
      "context_tokens_used",
      "tokensUsed",
      "tokens_used",
      "usedTokens",
      "used_tokens",
    ]);
    const total = pickNum(raw, [
      "contextWindowTokens",
      "context_window_tokens",
      "contextWindow",
      "context_window",
      "maxTokens",
      "max_tokens",
      "windowTokens",
      "window_tokens",
    ]);
    let percent = 0;
    if (total > 0) {
      percent = Math.min(100, (used / total) * 100);
    } else {
      const usage = pickNum(raw, [
        "contextWindowUsage",
        "context_window_usage",
        "usage",
      ]);
      if (usage > 0) {
        // 0–1 比例或 0–100 百分比
        percent = usage > 0 && usage <= 1 ? usage * 100 : Math.min(100, usage);
      }
    }
    return {
      sessionId,
      used,
      total,
      percent,
      available: total > 0 || used > 0,
      source: "signals",
      path: signalsPath,
    };
  } catch {
    return { ...empty, path: signalsPath };
  }
}
