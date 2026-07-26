/**
 * Context chip 用量：类型 + auto-compact 乐观合并（无 DOM）。
 */

export type ContextUsageRow = {
  sessionId: string;
  used: number;
  total: number;
  percent: number;
  available: boolean;
  source: string;
  path?: string;
};

/**
 * auto-compact 事件里的 tokens 往往比 signals.json 写回更早。
 * 纯函数：返回新的 usage 行（或 null 表示不更新）。
 */
export function mergeOptimisticContextFromCompact(
  prev: ContextUsageRow | null,
  ev: { tokensBefore?: number; tokensAfter?: number },
  sessionId: string,
): ContextUsageRow | null {
  if (ev.tokensAfter == null || !Number.isFinite(ev.tokensAfter)) return null;
  const after = Math.max(0, ev.tokensAfter);
  const total =
    prev?.total && prev.total > 0
      ? prev.total
      : ev.tokensBefore != null && ev.tokensBefore > after
        ? Math.max(ev.tokensBefore, after)
        : after > 0
          ? Math.round(after / 0.15)
          : 0;
  return {
    sessionId: sessionId || prev?.sessionId || "",
    used: after,
    total,
    percent: total > 0 ? Math.min(100, (after / total) * 100) : 0,
    available: total > 0 || after > 0,
    source: prev?.source === "signals" ? "signals" : "signals",
    path: prev?.path,
  };
}
