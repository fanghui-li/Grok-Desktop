/**
 * Prompt queue pure helpers (reorder / edit / id / drain gates).
 * IPC + DOM stay in main; this module has no Host or document deps.
 */

/** Local queue item id when Host is unavailable (rare path). */
export function newQueueItemId(now = Date.now(), rand = Math.random()): string {
  return `q_${now.toString(36)}_${rand.toString(36).slice(2, 7)}`;
}

/**
 * Swap id with neighbor in ordered id list.
 * Returns null when id missing or move would leave bounds.
 */
export function swapAdjacentOrderedIds(
  orderedIds: readonly string[],
  id: string,
  dir: -1 | 1,
): string[] | null {
  const i = orderedIds.indexOf(id);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= orderedIds.length) return null;
  const next = orderedIds.slice();
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  return next;
}

/**
 * Normalize edit patch: empty both → null; one empty uses the other.
 */
export function normalizeQueueEditPatch(
  display: string,
  content: string,
): { display: string; content: string } | null {
  const d = display.trim();
  const c = content.trim();
  if (!d && !c) return null;
  return { display: d || c, content: c || d };
}

/** Toast i18n key after enqueue. */
export function enqueueToastKey(pausedByInterrupt: boolean): string {
  return pausedByInterrupt ? "queue.enqueuedPaused" : "queue.enqueued";
}

/**
 * Whether to arm the post-turn drain timer.
 * Does not check turnActive (drain itself no-ops while busy);
 * does not schedule — caller owns setTimeout.
 */
export function canScheduleQueueDrain(opts: {
  pausedByInterrupt: boolean;
  queueLength: number;
  alreadyScheduled: boolean;
}): boolean {
  if (opts.alreadyScheduled) return false;
  if (opts.pausedByInterrupt) return false;
  return opts.queueLength > 0;
}

/** Gates for interject / send_now from a queue row. */
export function queueItemActionGate(
  item: { status?: string } | undefined | null,
  opts: {
    turnUiPhase: string;
    turnActive: boolean;
    /** interject requires working turn; send_now does not */
    requireWorkingTurn: boolean;
  },
): { ok: true } | { ok: false; reason: "missing" | "sending" | "cancelling" | "needTurn" } {
  if (!item) return { ok: false, reason: "missing" };
  if (item.status === "sending") return { ok: false, reason: "sending" };
  if (opts.turnUiPhase === "cancelling") {
    return { ok: false, reason: "cancelling" };
  }
  if (opts.requireWorkingTurn) {
    if (!opts.turnActive || opts.turnUiPhase !== "working") {
      return { ok: false, reason: "needTurn" };
    }
  }
  return { ok: true };
}
