/**
 * 读取会话目录 btw_history.jsonl（CLI /btw 落盘）。
 * 与 chat_history 分离；失败返回空列表，不抛。
 */
import fs from "node:fs";
import path from "node:path";
import { findSessionDir } from "../paths.js";

export type BtwHistoryEntry = {
  btwSessionId: string;
  parentSessionId: string;
  askedAt?: string;
  question: string;
  answer: string;
  model?: string;
  success: boolean;
  error?: string;
};

export function loadBtwHistory(
  sessionId: string,
  home?: string,
  opts?: { maxEntries?: number },
): { sessionId: string; entries: BtwHistoryEntry[]; sessionDir: string | null } {
  const sid = (sessionId ?? "").trim();
  const maxEntries =
    opts?.maxEntries != null && Number.isFinite(opts.maxEntries)
      ? Math.max(1, Math.floor(opts.maxEntries))
      : 200;
  if (!sid) {
    return { sessionId: sid, entries: [], sessionDir: null };
  }
  const sessionDir = findSessionDir(sid, home);
  if (!sessionDir) {
    return { sessionId: sid, entries: [], sessionDir: null };
  }
  const file = path.join(sessionDir, "btw_history.jsonl");
  if (!fs.existsSync(file)) {
    return { sessionId: sid, entries: [], sessionDir };
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { sessionId: sid, entries: [], sessionDir };
  }
  const entries: BtwHistoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const question =
        typeof o.question === "string"
          ? o.question
          : typeof o.Question === "string"
            ? o.Question
            : "";
      if (!question.trim()) continue;
      const answer =
        typeof o.answer === "string"
          ? o.answer
          : typeof o.Answer === "string"
            ? o.Answer
            : "";
      const success =
        typeof o.success === "boolean"
          ? o.success
          : typeof o.Success === "boolean"
            ? o.Success
            : !o.error;
      const btwSessionId =
        (typeof o.btwSessionId === "string" && o.btwSessionId) ||
        (typeof o.btw_session_id === "string" && o.btw_session_id) ||
        `btw_disk_${entries.length}`;
      const parentSessionId =
        (typeof o.parentSessionId === "string" && o.parentSessionId) ||
        (typeof o.parent_session_id === "string" && o.parent_session_id) ||
        sid;
      const err =
        typeof o.error === "string"
          ? o.error
          : typeof o.Error === "string"
            ? o.Error
            : undefined;
      const askedAt =
        typeof o.askedAt === "string"
          ? o.askedAt
          : typeof o.asked_at === "string"
            ? o.asked_at
            : undefined;
      entries.push({
        btwSessionId,
        parentSessionId,
        askedAt,
        question,
        answer,
        model: typeof o.model === "string" ? o.model : undefined,
        success,
        error: err,
      });
    } catch {
      /* skip bad line */
    }
  }
  // 文件顺序通常为时间正序；保留较新 maxEntries 条
  const sliced =
    entries.length > maxEntries
      ? entries.slice(entries.length - maxEntries)
      : entries;
  return { sessionId: sid, entries: sliced, sessionDir };
}
