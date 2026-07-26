/**
 * L1 持久 prompt 队列编排（自 DesktopHost 迁出）。
 * drain 互斥 + emit + wire 经 deps；文件真源在 queue.ts。
 */
import type { NormalizedEvent } from "../../shared/events.js";
import type { HostLogger } from "../logger.js";
import {
  clearQueue,
  completeSending,
  enqueueItem,
  loadQueue,
  removeItem,
  reorderItems,
  saveQueue,
  setQueueFlags,
  takeNextPending,
  updateItem,
  type PromptQueueAttachment,
  type PromptQueueFile,
  type PromptQueueItem,
} from "./queue.js";
import {
  tryQueueWire,
  type QueueWireClient,
} from "./wire.js";

export type PromptQueueServiceDeps = {
  home?: string;
  logger: HostLogger;
  /** sessionId → live threadId（emit 用） */
  threadIdForSession: (sessionId: string) => string | undefined;
  resolveWritableClient: (sessionId: string) => QueueWireClient | null;
  emit: (event: NormalizedEvent) => void;
};

export class PromptQueueService {
  /** 队列 drain 互斥：take→complete 之间禁止二次 take */
  private drainLocked = new Set<string>();

  constructor(private readonly deps: PromptQueueServiceDeps) {}

  get(sessionId: string): PromptQueueFile {
    return loadQueue(sessionId, this.deps.home);
  }

  set(sessionId: string, file: PromptQueueFile): PromptQueueFile {
    const next = saveQueue({ ...file, sessionId }, this.deps.home);
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  enqueue(
    sessionId: string,
    item: {
      display?: string;
      content: string;
      attachments?: PromptQueueAttachment[];
      id?: string;
    },
  ): PromptQueueFile {
    const next = enqueueItem(
      sessionId,
      {
        id: item.id,
        display: item.display || item.content.slice(0, 80),
        content: item.content,
        attachments: item.attachments ?? [],
      },
      this.deps.home,
    );
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  remove(sessionId: string, itemId: string): PromptQueueFile {
    const next = removeItem(sessionId, itemId, this.deps.home);
    void this.wire(sessionId, "remove", { itemId });
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  reorder(sessionId: string, orderedIds: string[]): PromptQueueFile {
    const next = reorderItems(sessionId, orderedIds, this.deps.home);
    void this.wire(sessionId, "reorder", { orderedIds });
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  update(
    sessionId: string,
    itemId: string,
    patch: Partial<
      Pick<
        PromptQueueItem,
        "display" | "content" | "attachments" | "status" | "lastError"
      >
    >,
  ): PromptQueueFile {
    const next = updateItem(sessionId, itemId, patch, this.deps.home);
    void this.wire(sessionId, "edit", { itemId, ...patch });
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  clear(sessionId: string): PromptQueueFile {
    const next = clearQueue(sessionId, this.deps.home);
    void this.wire(sessionId, "clear", {});
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  setFlags(
    sessionId: string,
    flags: {
      queueingEnabled?: boolean;
      pausedByInterrupt?: boolean;
      syncError?: string | null;
    },
  ): PromptQueueFile {
    const next = setQueueFlags(sessionId, flags, this.deps.home);
    this.emitChanged(sessionId, "local", next);
    return next;
  }

  /** 释放队列 drain 互斥（detach/delete/complete 共用） */
  releaseDrainLock(sessionId: string): void {
    const sid = sessionId.trim();
    if (sid) this.drainLocked.delete(sid);
  }

  takeNext(sessionId: string): {
    queue: PromptQueueFile;
    item: PromptQueueItem | null;
  } {
    const sid = sessionId.trim();
    if (!sid) {
      return { queue: loadQueue("", this.deps.home), item: null };
    }
    if (this.drainLocked.has(sid)) {
      return {
        queue: loadQueue(sid, this.deps.home, {
          recoverOrphanSending: false,
        }),
        item: null,
      };
    }
    const result = takeNextPending(sid, this.deps.home);
    if (result.item) this.drainLocked.add(sid);
    this.emitChanged(sid, "local", result.queue);
    return result;
  }

  completeSending(
    sessionId: string,
    itemId: string,
    ok: boolean,
    error?: string,
  ): PromptQueueFile {
    const sid = sessionId.trim();
    try {
      const next = completeSending(
        sid,
        itemId,
        ok,
        error,
        this.deps.home,
      );
      this.emitChanged(sid, "local", next);
      return next;
    } finally {
      this.releaseDrainLock(sid);
    }
  }

  private emitChanged(
    sessionId: string,
    source: "local" | "agent",
    q: PromptQueueFile,
  ): void {
    const tid = this.deps.threadIdForSession(sessionId);
    this.deps.emit({
      type: "queue.changed",
      threadId: tid,
      sessionId,
      source,
      itemCount: q.items.length,
      pausedByInterrupt: q.pausedByInterrupt,
      syncError: q.syncError,
    });
  }

  private async wire(
    sessionId: string,
    op: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    return tryQueueWire(
      {
        home: this.deps.home,
        logger: this.deps.logger,
        resolveWritableClient: this.deps.resolveWritableClient,
      },
      sessionId,
      op,
      params,
    );
  }
}
