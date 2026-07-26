/**
 * 事件会话隔离：transcript 范围判定 + 是否属于前台会话（纯逻辑）。
 */

/** 会写入当前 transcript / 改 turn UI 的事件（必须按会话隔离） */
export function isTranscriptScopedEvent(ev: { type?: string }): boolean {
  switch (ev.type) {
    case "message.delta":
    case "thought.delta":
    case "tool.started":
    case "tool.completed":
    case "turn.started":
    case "turn.completed":
    case "permission.requested":
    case "ask_user.requested":
    case "context.compacted":
    case "agent.error":
      return true;
    default:
      return false;
  }
}

/**
 * 事件是否属于当前打开的会话。
 * - 优先 sessionId（disk_* / live 均可靠）
 * - 无 sessionId 时回退 threadId（仅 live id 可比；disk_ 前缀不相等）
 */
export function eventBelongsToActiveSession(
  ev: { sessionId?: string; threadId?: string },
  ctx: {
    activeSessionId: string | null;
    activeThreadId: string | null;
  },
): boolean {
  if (!ctx.activeSessionId && !ctx.activeThreadId) return false;
  if (ev.sessionId) {
    return Boolean(
      ctx.activeSessionId && ev.sessionId === ctx.activeSessionId,
    );
  }
  if (ev.threadId && ctx.activeThreadId) {
    if (ev.threadId === ctx.activeThreadId) return true;
    // live thread 事件 vs 当前 disk_ 展示：若 session 未知则拒绝（防串台）
    if (ctx.activeThreadId.startsWith("disk_")) return false;
  }
  // 无 session/thread 标识的全局事件不走此函数
  return !ev.sessionId && !ev.threadId;
}
