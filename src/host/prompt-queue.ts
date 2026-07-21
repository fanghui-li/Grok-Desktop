import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopDir } from "./paths.js";

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

export function loadQueue(sessionId: string, home?: string): PromptQueueFile {
  const sid = sessionId.trim();
  if (!sid) return emptyQueue("");
  const p = queueFilePath(sid, home);
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
      items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
      syncError: raw.syncError ?? null,
    };
  } catch {
    return emptyQueue(sid);
  }
}

function normalizeItem(it: Partial<PromptQueueItem>): PromptQueueItem {
  return {
    id: String(it.id || `q_${randomUUID()}`),
    display: String(it.display ?? it.content ?? ""),
    content: String(it.content ?? ""),
    attachments: Array.isArray(it.attachments) ? it.attachments : [],
    createdAt: it.createdAt || new Date().toISOString(),
    status:
      it.status === "sending" || it.status === "failed" ? it.status : "pending",
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
    items: q.items.map(normalizeItem),
  };
  fs.writeFileSync(queueFilePath(sid, home), JSON.stringify(next, null, 2), "utf8");
  return next;
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
  patch: Partial<Pick<PromptQueueItem, "display" | "content" | "attachments" | "status" | "lastError">>,
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
  flags: { queueingEnabled?: boolean; pausedByInterrupt?: boolean; syncError?: string | null },
  home?: string,
): PromptQueueFile {
  const q = loadQueue(sessionId, home);
  if (flags.queueingEnabled !== undefined) q.queueingEnabled = flags.queueingEnabled;
  if (flags.pausedByInterrupt !== undefined) q.pausedByInterrupt = flags.pausedByInterrupt;
  if (flags.syncError !== undefined) q.syncError = flags.syncError;
  return saveQueue(q, home);
}

/** Shift next pending item for drain (marks sending). */
export function takeNextPending(
  sessionId: string,
  home?: string,
): { queue: PromptQueueFile; item: PromptQueueItem | null } {
  const q = loadQueue(sessionId, home);
  if (q.pausedByInterrupt || !q.queueingEnabled) {
    return { queue: q, item: null };
  }
  const idx = q.items.findIndex((i) => i.status === "pending" || i.status === "failed");
  if (idx < 0) return { queue: q, item: null };
  const item = { ...q.items[idx]!, status: "sending" as const, lastError: null };
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
  const q = loadQueue(sessionId, home);
  if (ok) {
    q.items = q.items.filter((i) => i.id !== itemId);
  } else {
    q.items = q.items.map((i) =>
      i.id === itemId
        ? { ...i, status: "failed" as const, lastError: error ?? "send failed" }
        : i,
    );
  }
  return saveQueue(q, home);
}
