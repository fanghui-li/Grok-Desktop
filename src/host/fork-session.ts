import fs from "node:fs";
import path from "node:path";

/** Files to copy from source → child on fork (plan P1-D). */
export const FORK_COPY_NAMES = [
  "chat_history.jsonl",
  "updates.jsonl",
  "plan.md",
  "plan_status.json",
  "goal.json",
  "subagents.json",
] as const;

export interface ForkCopyResult {
  historyCopied: boolean;
  copied: string[];
  missing: string[];
}

/**
 * Copy session artifacts into destDir. Creates destDir if needed.
 * Does not start agent processes.
 */
export function copySessionHistoryForFork(
  srcDir: string,
  destDir: string,
): ForkCopyResult {
  const copied: string[] = [];
  const missing: string[] = [];
  if (!fs.existsSync(srcDir)) {
    return { historyCopied: false, copied, missing: [...FORK_COPY_NAMES] };
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of FORK_COPY_NAMES) {
    const from = path.join(srcDir, name);
    if (!fs.existsSync(from)) {
      missing.push(name);
      continue;
    }
    fs.copyFileSync(from, path.join(destDir, name));
    copied.push(name);
  }
  return {
    historyCopied: copied.includes("chat_history.jsonl") || copied.length > 0,
    copied,
    missing,
  };
}

export function writeForkSummary(opts: {
  destDir: string;
  sessionId: string;
  parentSessionId: string;
  cwd: string;
  title?: string;
  sourceSummaryPath?: string;
}): void {
  const sumPath = path.join(opts.destDir, "summary.json");
  let summary: Record<string, unknown> = {};
  if (fs.existsSync(sumPath)) {
    try {
      summary = JSON.parse(fs.readFileSync(sumPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      summary = {};
    }
  }
  if (opts.sourceSummaryPath && fs.existsSync(opts.sourceSummaryPath)) {
    try {
      const src = JSON.parse(
        fs.readFileSync(opts.sourceSummaryPath, "utf8"),
      ) as Record<string, unknown>;
      if (src.title && !opts.title) {
        summary.title = `分支 · ${String(src.title)}`.slice(0, 80);
      }
    } catch {
      /* ignore */
    }
  }
  if (opts.title) summary.title = opts.title;
  summary.session_kind = "fork";
  summary.parent_session_id = opts.parentSessionId;
  summary.updated_at = new Date().toISOString();
  const info = (summary.info as Record<string, unknown>) || {};
  info.id = opts.sessionId;
  info.cwd = path.resolve(opts.cwd);
  summary.info = info;
  fs.mkdirSync(opts.destDir, { recursive: true });
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), "utf8");
}

/**
 * Count non-empty lines in chat_history.jsonl (for tests / verification).
 */
export function countHistoryLines(sessionDir: string): number {
  const p = path.join(sessionDir, "chat_history.jsonl");
  if (!fs.existsSync(p)) return 0;
  const raw = fs.readFileSync(p, "utf8");
  return raw.split(/\r?\n/).filter((l) => l.trim()).length;
}
