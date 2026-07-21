import fs from "node:fs";
import path from "node:path";
import type { RosterEntry, Thread, ThreadStatus } from "../shared/types.js";
import { cleanUserText, mapHistoryLine } from "./history.js";
import { sessionsRoot } from "./paths.js";

/** 磁盘会话扫描 TTL 缓存（listThreads 高频调用时避免反复 walk 全树） */
const DISK_ROSTER_TTL_MS = 2500;
type DiskRosterRow = {
  sessionId: string;
  sessionDir: string;
  title: string;
  cwd: string;
  updatedAt: string;
  createdAt: string;
  sessionKind?: string;
  parentSessionId?: string;
  isSubagent: boolean;
};
let diskRosterCache: {
  root: string;
  at: number;
  rows: DiskRosterRow[];
} | null = null;

/** 测试 / 写盘后可手动失效 */
export function invalidateDiskRosterCache(): void {
  diskRosterCache = null;
}

function loadDiskRosterRows(home?: string): DiskRosterRow[] {
  const root = sessionsRoot(home);
  const now = Date.now();
  if (
    diskRosterCache &&
    diskRosterCache.root === root &&
    now - diskRosterCache.at < DISK_ROSTER_TTL_MS
  ) {
    return diskRosterCache.rows;
  }
  const rows: DiskRosterRow[] = [];
  if (fs.existsSync(root)) {
    walkSessions(root, (sessionId, sessionDir, cwdHint) => {
      const meta = readSessionMeta(sessionDir, sessionId, cwdHint);
      rows.push({
        sessionId,
        sessionDir,
        title: meta.title,
        cwd: meta.cwd,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
        sessionKind: meta.sessionKind,
        parentSessionId: meta.parentSessionId,
        isSubagent: meta.isSubagent,
      });
    });
  }
  diskRosterCache = { root, at: now, rows };
  return rows;
}

/**
 * Build Command Center roster: live threads + disk sessions projection.
 */
export function buildRoster(opts: {
  home?: string;
  liveThreads: Thread[];
}): RosterEntry[] {
  const liveBySession = new Map(
    opts.liveThreads.map((t) => [t.sessionId, t] as const),
  );
  const entries: RosterEntry[] = [];

  for (const t of opts.liveThreads) {
    entries.push({
      threadId: t.id,
      sessionId: t.sessionId,
      projectId: t.projectId,
      title: t.title,
      cwd: t.cwd,
      status: t.status,
      source: "live",
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      pinned: t.pinned,
    });
  }

  // Disk sessions not already live（带短 TTL 缓存）
  for (const row of loadDiskRosterRows(opts.home)) {
    if (liveBySession.has(row.sessionId)) continue;
    // /goal 会拉起 adversarial verifier / plan writer 等子会话，不当作用户对话
    if (row.isSubagent || isGoalInfraSession(row.title, row.sessionKind)) {
      continue;
    }
    entries.push({
      sessionId: row.sessionId,
      title: row.title,
      cwd: row.cwd,
      status: "inactive" as ThreadStatus,
      source: "disk",
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      sessionKind: row.sessionKind,
      parentSessionId: row.parentSessionId,
    });
  }

  const rank = (s: ThreadStatus): number => {
    switch (s) {
      case "needs_input":
      case "blocked":
        return 0;
      case "working":
        return 1;
      case "failed":
        return 2;
      case "idle":
        return 3;
      case "completed":
        return 4;
      case "inactive":
      default:
        return 5;
    }
  };

  return entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Read display title + timestamps from summary.json / chat_history. */
export function readSessionMeta(
  sessionDir: string,
  sessionId: string,
  cwdHint?: string,
): {
  title: string;
  cwd: string;
  updatedAt: string;
  createdAt: string;
  sessionKind?: string;
  parentSessionId?: string;
  isSubagent: boolean;
} {
  let title = "";
  let cwd = cwdHint ?? sessionDir;
  let updatedAt = new Date(0).toISOString();
  let createdAt = updatedAt;
  let sessionKind: string | undefined;
  let parentSessionId: string | undefined;
  let isSubagent = false;

  try {
    const summaryPath = path.join(sessionDir, "summary.json");
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
        generated_title?: string;
        session_summary?: string;
        title?: string;
        updated_at?: string;
        created_at?: string;
        last_active_at?: string;
        updatedAt?: string;
        lastUpdated?: string;
        session_kind?: string;
        sessionKind?: string;
        parent_session_id?: string;
        parentSessionId?: string;
        agent_name?: string;
        info?: { cwd?: string; id?: string };
      };
      title =
        (s.generated_title || s.session_summary || s.title || "").trim();
      if (s.info?.cwd) cwd = s.info.cwd;
      updatedAt =
        s.last_active_at ??
        s.updated_at ??
        s.updatedAt ??
        s.lastUpdated ??
        updatedAt;
      createdAt = s.created_at ?? createdAt;
      sessionKind = s.session_kind ?? s.sessionKind;
      parentSessionId =
        (s.parent_session_id || s.parentSessionId || "").trim() || undefined;
      if (sessionKind === "subagent" || sessionKind === "worker") {
        isSubagent = true;
      }
    }
  } catch {
    /* ignore */
  }

  // Prefer first real user query (Codex 用首条用户消息作标题更直观)
  // 子代理首条常是角色设定，不当作用户对话标题
  if (!isSubagent) {
    const userTitle = firstUserQueryTitle(sessionDir);
    if (userTitle) title = userTitle;
  }

  title = sanitizeThreadTitle(title);
  if (!title) title = sessionId.slice(0, 8);
  if (!isSubagent && isGoalInfraSession(title, sessionKind)) {
    isSubagent = true;
  }

  try {
    const st = fs.statSync(sessionDir);
    if (updatedAt === new Date(0).toISOString()) {
      updatedAt = st.mtime.toISOString();
    }
    if (createdAt === new Date(0).toISOString()) {
      createdAt = st.birthtime?.toISOString?.() ?? st.mtime.toISOString();
    }
  } catch {
    /* ignore */
  }

  return {
    title: truncateTitle(title, 48),
    cwd,
    updatedAt,
    createdAt,
    sessionKind,
    parentSessionId,
    isSubagent,
  };
}

/** /goal 流水线产生的子会话（验证器、plan writer、摘要器等） */
export function isGoalInfraSession(
  title: string,
  sessionKind?: string,
): boolean {
  if (sessionKind === "subagent" || sessionKind === "worker") return true;
  const t = title.toLowerCase();
  const needles = [
    "adversarial verifier",
    "adversarial goal",
    "goal plan writer",
    "goal sum",
    "you are an **adversarial",
    "you are the goal",
    "goal classifier",
    "system-reminder",
    "<system-reminder",
    "goal harness",
    "refute round",
  ];
  return needles.some((n) => t.includes(n));
}

/** 去掉 Desktop 旧注入 / 系统噪声，避免标题变成「你是？ [Goal — active…]」 */
export function sanitizeThreadTitle(title: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\[Goal\s*[—–-]\s*active objective:[^\]]*\]\s*/gi, " ");
  t = t.replace(/^<system-reminder>[\s\S]*$/i, "");
  t = t.replace(/^system-reminder\b.*$/i, "");
  return t.replace(/\s+/g, " ").trim();
}

/** Scan chat_history.jsonl for first non-noise user message. */
export function firstUserQueryTitle(sessionDir: string): string | null {
  const historyFile = path.join(sessionDir, "chat_history.jsonl");
  if (!fs.existsSync(historyFile)) return null;
  try {
    const raw = fs.readFileSync(historyFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const mapped = mapHistoryLine(obj);
      if (mapped?.role === "user" && mapped.text.trim()) {
        return cleanUserText(mapped.text).trim() || mapped.text.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function truncateTitle(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function walkSessions(
  root: string,
  visit: (sessionId: string, sessionDir: string, cwdHint?: string) => void,
  depth = 0,
): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const full = path.join(root, ent.name);
    // Heuristic: session dirs contain chat_history or events
    let looksLikeSession = false;
    try {
      const kids = fs.readdirSync(full);
      looksLikeSession = kids.some(
        (k) =>
          k === "chat_history.jsonl" ||
          k === "events.jsonl" ||
          k === "summary.json",
      );
    } catch {
      continue;
    }
    if (looksLikeSession) {
      const cwdHint = decodeCwdSegment(path.basename(path.dirname(full)));
      visit(ent.name, full, cwdHint);
    } else {
      walkSessions(full, visit, depth + 1);
    }
  }
}

function decodeCwdSegment(seg: string): string | undefined {
  try {
    return decodeURIComponent(seg);
  } catch {
    return undefined;
  }
}
