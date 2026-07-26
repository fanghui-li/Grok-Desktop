import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopDir } from "../paths.js";

export type QueueItemStatus = "pending" | "sending" | "failed";

export interface PromptQueueAttachment {
  id?: string;
  name?: string;
  path?: string;
  mimeType?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface PromptQueueItem {
  id: string;
  display: string;
  content: string;
  attachments: PromptQueueAttachment[];
  createdAt: string;
  status: QueueItemStatus;
  lastError?: string | null;
}

export interface PromptQueueFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  queueingEnabled: boolean;
  pausedByInterrupt: boolean;
  items: PromptQueueItem[];
  syncError?: string | null;
}

function queuesDir(home?: string): string {
  return path.join(desktopDir(home), "queues");
}

export function queueFilePath(sessionId: string, home?: string): string {
  const safe = sessionId.replace(/[^\w.-]+/g, "_").slice(0, 180);
  return path.join(queuesDir(home), `${safe}.json`);
}

export function emptyQueue(sessionId: string): PromptQueueFile {
  return {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    queueingEnabled: true,
    pausedByInterrupt: false,
    items: [],
    syncError: null,
  };
}

/**
 * @param recoverOrphanSending 默认 true：load 时把崩溃残留的 sending 改回 pending。
 *   idle-detach 探测「正在发送」时传 false。
 */
export function loadQueue(
  sessionId: string,
  home?: string,
  opts?: { recoverOrphanSending?: boolean },
): PromptQueueFile {
  const sid = sessionId.trim();
  if (!sid) return emptyQueue("");
  const p = queueFilePath(sid, home);
  const recover = opts?.recoverOrphanSending !== false;
  try {
    if (!fs.existsSync(p)) return emptyQueue(sid);
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as PromptQueueFile;
    if (!raw || raw.version !== 1) return emptyQueue(sid);
    return {
      version: 1,
      sessionId: sid,
      updatedAt: raw.updatedAt || new Date().toISOString(),
      queueingEnabled: raw.queueingEnabled !== false,
      pausedByInterrupt: Boolean(raw.pausedByInterrupt),
      items: Array.isArray(raw.items)
        ? raw.items.map((it) => normalizeItem(it, { recoverOrphanSending: recover }))
        : [],
      syncError: raw.syncError ?? null,
    };
  } catch {
    return emptyQueue(sid);
  }
}

function normalizeItem(
  it: Partial<PromptQueueItem>,
  opts?: { recoverOrphanSending?: boolean },
): PromptQueueItem {
  let status: QueueItemStatus = "pending";
  if (it.status === "failed") {
    status = "failed";
  } else if (it.status === "sending") {
    // save 路径保留 sending；load 默认恢复为 pending（防永远卡死）
    status = opts?.recoverOrphanSending ? "pending" : "sending";
  }
  return {
    id: String(it.id || `q_${randomUUID()}`),
    display: String(it.display ?? it.content ?? ""),
    content: String(it.content ?? ""),
    attachments: Array.isArray(it.attachments) ? it.attachments : [],
    createdAt: it.createdAt || new Date().toISOString(),
    status,
    lastError: it.lastError ?? null,
  };
}

export function saveQueue(q: PromptQueueFile, home?: string): PromptQueueFile {
  const sid = q.sessionId.trim();
  if (!sid) throw new Error("sessionId required");
  const dir = queuesDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const next: PromptQueueFile = {
    ...q,
    version: 1,
    sessionId: sid,
    updatedAt: new Date().toISOString(),
    // 写入时保留 sending（recoverOrphanSending=false）
    items: q.items.map((it) =>
      normalizeItem(it, { recoverOrphanSending: false }),
    ),
  };
  const dest = queueFilePath(sid, home);
  const tmp = dest + ".tmp";
  // 原子写：避免并发半写损坏后 load 静默清空队列
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, dest);
  return next;
}

/** 删除会话时清理 L1 队列文件（幂等） */
export function deleteQueueFile(sessionId: string, home?: string): void {
  const sid = sessionId.trim();
  if (!sid) return;
  const p = queueFilePath(sid, home);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  try {
    const tmp = p + ".tmp";
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
}

export function enqueueItem(
  sessionId: string,
  item: Omit<PromptQueueItem, "id" | "createdAt" | "status"> & {
    id?: string;
    status?: QueueItemStatus;
  },
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  const row: PromptQueueItem = {
    id: item.id?.trim() || `q_${randomUUID()}`,
    display: item.display || item.content.slice(0, 80),
    content: item.content,
    attachments: item.attachments ?? [],
    createdAt: new Date().toISOString(),
    status: item.status ?? "pending",
    lastError: null,
  };
  q.items.push(row);
  return saveQueue(q, home);
}

export function removeItem(
  sessionId: string,
  itemId: string,
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  q.items = q.items.filter((i) => i.id !== itemId);
  return saveQueue(q, home);
}

export function updateItem(
  sessionId: string,
  itemId: string,
  patch: Partial<
    Pick<
      PromptQueueItem,
      "display" | "content" | "attachments" | "status" | "lastError"
    >
  >,
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  q.items = q.items.map((i) =>
    i.id === itemId
      ? {
          ...i,
          ...patch,
          display:
            patch.display ??
            (patch.content != null ? patch.content.slice(0, 80) : i.display),
        }
      : i,
  );
  return saveQueue(q, home);
}

export function reorderItems(
  sessionId: string,
  orderedIds: string[],
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  const map = new Map(q.items.map((i) => [i.id, i]));
  const next: PromptQueueItem[] = [];
  for (const id of orderedIds) {
    const hit = map.get(id);
    if (hit) {
      next.push(hit);
      map.delete(id);
    }
  }
  for (const rest of map.values()) next.push(rest);
  q.items = next;
  return saveQueue(q, home);
}

export function clearQueue(sessionId: string, home?: string): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  q.items = [];
  q.pausedByInterrupt = false;
  return saveQueue(q, home);
}

export function setQueueFlags(
  sessionId: string,
  flags: {
    queueingEnabled?: boolean;
    pausedByInterrupt?: boolean;
    syncError?: string | null;
  },
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  if (flags.queueingEnabled !== undefined) {
    q.queueingEnabled = flags.queueingEnabled;
  }
  if (flags.pausedByInterrupt !== undefined) {
    q.pausedByInterrupt = flags.pausedByInterrupt;
  }
  if (flags.syncError !== undefined) q.syncError = flags.syncError;
  return saveQueue(q, home);
}

/** 取出下一条可发送项并标为 sending（L1 drain） */
export function takeNextPending(
  sessionId: string,
  home?: string,
): { queue: PromptQueueFile; item: PromptQueueItem | null } {
  // 保留 sending 可见性；Host queueDrainLocked 保证进程内不双 take。
  // 锁释放后（detach/崩溃恢复）允许重试 orphan sending。
  const q = loadQueue(sessionId, home, { recoverOrphanSending: false });
  if (q.pausedByInterrupt || !q.queueingEnabled) {
    return { queue: q, item: null };
  }
  const idx = q.items.findIndex(
    (i) =>
      i.status === "pending" ||
      i.status === "failed" ||
      i.status === "sending",
  );
  if (idx < 0) return { queue: q, item: null };
  const item: PromptQueueItem = {
    ...q.items[idx]!,
    status: "sending",
    lastError: null,
  };
  q.items[idx] = item;
  return { queue: saveQueue(q, home), item };
}

export function completeSending(
  sessionId: string,
  itemId: string,
  ok: boolean,
  error?: string,
  home?: string,
): PromptQueueFile {
  // 不恢复 sending→pending 再删，避免 id 仍在；直接读盘保留 status
  const q = loadQueue(sessionId, home, { recoverOrphanSending: false });
  if (ok) {
    q.items = q.items.filter((i) => i.id !== itemId);
  } else {
    q.items = q.items.map((i) =>
      i.id === itemId
        ? {
            ...i,
            status: "failed" as const,
            lastError: error ?? "send failed",
          }
        : i,
    );
  }
  return saveQueue(q, home);
}
