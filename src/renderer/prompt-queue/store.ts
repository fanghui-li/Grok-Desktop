/**
 * Host-backed durable prompt queue projection (plan P1-C).
 * Renderer keeps a local mirror for UI; mutations go through Host IPC.
 */
import type { HostIpcMethod } from "../../shared/host-api.js";

export type QueueItemStatus = "pending" | "sending" | "failed";

export interface HostQueueItem {
  id: string;
  display: string;
  content: string;
  attachments: unknown[];
  createdAt?: string;
  status?: QueueItemStatus;
  lastError?: string | null;
}

export interface HostQueueFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  queueingEnabled: boolean;
  pausedByInterrupt: boolean;
  items: HostQueueItem[];
  syncError?: string | null;
}

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{ ok: boolean; data?: T; error?: { message?: string } }>;

export async function loadSessionQueue(
  inv: Inv,
  sessionId: string,
): Promise<HostQueueFile | null> {
  if (!sessionId) return null;
  const res = await inv<HostQueueFile>("queue.get", { sessionId });
  return res.ok && res.data ? res.data : null;
}

export async function hostEnqueue(
  inv: Inv,
  sessionId: string,
  item: {
    content: string;
    display?: string;
    attachments?: unknown[];
    id?: string;
  },
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.enqueue", {
    sessionId,
    ...item,
  });
  return res.ok && res.data ? res.data : null;
}

export async function hostRemoveItem(
  inv: Inv,
  sessionId: string,
  itemId: string,
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.remove", { sessionId, itemId });
  return res.ok && res.data ? res.data : null;
}

export async function hostClearQueue(
  inv: Inv,
  sessionId: string,
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.clear", { sessionId });
  return res.ok && res.data ? res.data : null;
}

export async function hostReorder(
  inv: Inv,
  sessionId: string,
  orderedIds: string[],
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.reorder", {
    sessionId,
    orderedIds,
  });
  return res.ok && res.data ? res.data : null;
}

export async function hostUpdateItem(
  inv: Inv,
  sessionId: string,
  itemId: string,
  patch: Partial<Pick<HostQueueItem, "display" | "content" | "status" | "lastError">>,
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.update", {
    sessionId,
    itemId,
    patch,
  });
  return res.ok && res.data ? res.data : null;
}

export async function hostSetQueueFlags(
  inv: Inv,
  sessionId: string,
  flags: {
    queueingEnabled?: boolean;
    pausedByInterrupt?: boolean;
    syncError?: string | null;
  },
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.setFlags", {
    sessionId,
    ...flags,
  });
  return res.ok && res.data ? res.data : null;
}

/** L1：取出下一条 pending/failed 并标为 sending */
export async function hostTakeNext(
  inv: Inv,
  sessionId: string,
): Promise<{ queue: HostQueueFile; item: HostQueueItem | null } | null> {
  const res = await inv<{ queue: HostQueueFile; item: HostQueueItem | null }>(
    "queue.takeNext",
    { sessionId },
  );
  return res.ok && res.data ? res.data : null;
}

/** L1：发送完成（ok 删除；失败标 failed） */
export async function hostCompleteSending(
  inv: Inv,
  sessionId: string,
  itemId: string,
  ok: boolean,
  error?: string,
): Promise<HostQueueFile | null> {
  const res = await inv<HostQueueFile>("queue.completeSending", {
    sessionId,
    itemId,
    ok,
    error,
  });
  return res.ok && res.data ? res.data : null;
}

export function mirrorQueueToLocal(
  file: HostQueueFile | null,
): {
  items: Array<{
    id: string;
    display: string;
    content: string;
    attachments: unknown[];
    status?: QueueItemStatus;
    lastError?: string | null;
  }>;
  pausedByInterrupt: boolean;
  queueingEnabled: boolean;
  syncError: string | null;
} {
  if (!file) {
    return {
      items: [],
      pausedByInterrupt: false,
      queueingEnabled: true,
      syncError: null,
    };
  }
  return {
    items: file.items.map((i) => ({
      id: i.id,
      display: i.display,
      content: i.content,
      attachments: i.attachments ?? [],
      status: i.status,
      lastError: i.lastError,
    })),
    pausedByInterrupt: Boolean(file.pausedByInterrupt),
    queueingEnabled: file.queueingEnabled !== false,
    syncError: file.syncError ?? null,
  };
}
