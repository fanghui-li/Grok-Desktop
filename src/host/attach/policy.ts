/** Attach lifecycle states (plan §3.2). */
export type AttachState =
  | "history_only"
  | "attaching"
  | "live"
  | "failed"
  | "detaching";

export interface LiveAttachSnapshot {
  threadId: string;
  sessionId: string;
  state: AttachState;
  /** Last successful attach time (ms) */
  attachedAt?: number;
  /** Last user/agent activity (ms) */
  lastActiveAt?: number;
  working?: boolean;
  hasPendingPermission?: boolean;
  hasRunningTask?: boolean;
  hasSendingQueueItem?: boolean;
}

export interface IdleDetachConfig {
  /** 0 = disabled */
  idleDetachMs: number;
  maxLiveAttaches: number;
}

export const DEFAULT_IDLE_DETACH: IdleDetachConfig = {
  idleDetachMs: 20 * 60 * 1000,
  maxLiveAttaches: 4,
};

export function isProtectedFromIdleDetach(s: LiveAttachSnapshot): boolean {
  if (s.state !== "live") return true;
  if (s.working) return true;
  if (s.hasPendingPermission) return true;
  if (s.hasRunningTask) return true;
  if (s.hasSendingQueueItem) return true;
  return false;
}

/**
 * Whether a live attach is idle long enough to detach.
 */
export function shouldIdleDetach(
  s: LiveAttachSnapshot,
  nowMs: number,
  cfg: IdleDetachConfig = DEFAULT_IDLE_DETACH,
): boolean {
  if (cfg.idleDetachMs <= 0) return false;
  if (isProtectedFromIdleDetach(s)) return false;
  const last = s.lastActiveAt ?? s.attachedAt ?? 0;
  if (!last) return false;
  return nowMs - last >= cfg.idleDetachMs;
}

/**
 * LRU among detachable live threads when over maxLiveAttaches.
 * Returns threadIds that should be detached (oldest first).
 */
export function pickLruDetachTargets(
  lives: LiveAttachSnapshot[],
  cfg: IdleDetachConfig = DEFAULT_IDLE_DETACH,
  nowMs = Date.now(),
): string[] {
  const live = lives.filter((s) => s.state === "live");
  if (cfg.maxLiveAttaches <= 0) return [];
  if (live.length <= cfg.maxLiveAttaches) {
    // still apply idle TTL
    return live
      .filter((s) => shouldIdleDetach(s, nowMs, cfg))
      .map((s) => s.threadId);
  }
  const detachable = live
    .filter((s) => !isProtectedFromIdleDetach(s))
    .sort((a, b) => {
      const la = a.lastActiveAt ?? a.attachedAt ?? 0;
      const lb = b.lastActiveAt ?? b.attachedAt ?? 0;
      return la - lb;
    });
  const excess = live.length - cfg.maxLiveAttaches;
  const byLru = detachable.slice(0, Math.max(0, excess)).map((s) => s.threadId);
  const byIdle = live
    .filter((s) => shouldIdleDetach(s, nowMs, cfg))
    .map((s) => s.threadId);
  return [...new Set([...byLru, ...byIdle])];
}

/** Process-level liveness for Mode B agent. */
export function isProcessAlive(proc: {
  killed?: boolean;
  exitCode?: number | null;
} | null): boolean {
  if (!proc) return false;
  if (proc.killed) return false;
  if (proc.exitCode != null) return false;
  return true;
}
