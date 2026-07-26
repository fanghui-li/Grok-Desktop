/**
 * 方案 B：每会话 Turn UI 投影（对齐 CLI per-AgentView.session.state）。
 *
 * - 切换会话 = 换焦点：切走时快照，切回时恢复；不 cancel Host turn。
 * - 非当前会话的 turn 事件仍写入本 store，保证侧栏 working 与切回 busy 同源。
 * - 不持有 DOM；直播缓冲区仅保留切走期间未进 history 的助手增量文本。
 */

import type { TurnUiPhase } from "../../shared/turn-ui-state.js";

export type SessionTurnProjection = {
  turnActive: boolean;
  turnUiPhase: TurnUiPhase;
  alreadyPaintedStopped: boolean;
  turnStartedAt: number;
  assistantStartedThisTurn: boolean;
  streamArmedThisTurn: boolean;
  blockHistoryResyncAfterStop: boolean;
  userStopSuppressUntil: number;
  lateStreamUntil: number;
  currentTurnId: number;
  /** 切走期间积累的 assistant 增量（切回后补画） */
  pendingAssistantText: string;
  updatedAtMs: number;
};

const store = new Map<string, SessionTurnProjection>();

export function idleProjection(): SessionTurnProjection {
  return {
    turnActive: false,
    turnUiPhase: "idle",
    alreadyPaintedStopped: false,
    turnStartedAt: 0,
    assistantStartedThisTurn: false,
    streamArmedThisTurn: true,
    blockHistoryResyncAfterStop: false,
    userStopSuppressUntil: 0,
    lateStreamUntil: 0,
    currentTurnId: 0,
    pendingAssistantText: "",
    updatedAtMs: Date.now(),
  };
}

export function getSessionTurn(sessionId: string): SessionTurnProjection | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return store.get(sid) ?? null;
}

export function getOrCreateSessionTurn(sessionId: string): SessionTurnProjection {
  const sid = sessionId.trim();
  let p = store.get(sid);
  if (!p) {
    p = idleProjection();
    store.set(sid, p);
  }
  return p;
}

export function setSessionTurn(
  sessionId: string,
  projection: SessionTurnProjection,
): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.set(sid, { ...projection, updatedAtMs: Date.now() });
}

/** 合并补丁（后台事件用） */
export function patchSessionTurn(
  sessionId: string,
  patch: Partial<SessionTurnProjection>,
): SessionTurnProjection {
  const cur = getOrCreateSessionTurn(sessionId);
  const next: SessionTurnProjection = {
    ...cur,
    ...patch,
    updatedAtMs: Date.now(),
  };
  store.set(sessionId.trim(), next);
  return next;
}

/** 后台 assistant 增量追加 */
export function appendBackgroundAssistantDelta(
  sessionId: string,
  text: string,
): void {
  if (!text) return;
  const cur = getOrCreateSessionTurn(sessionId);
  patchSessionTurn(sessionId, {
    turnActive: true,
    turnUiPhase: cur.turnUiPhase === "cancelling" ? "cancelling" : "working",
    assistantStartedThisTurn: true,
    streamArmedThisTurn: true,
    pendingAssistantText: (cur.pendingAssistantText || "") + text,
    turnStartedAt: cur.turnStartedAt > 0 ? cur.turnStartedAt : Date.now(),
  });
}

export function clearSessionTurn(sessionId: string): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.delete(sid);
}

/**
 * 切回时是否应显示 busy。
 * 真源优先：Host `promptInFlight`；若明确 idle 则不 busy（防过期投影）。
 */
export function shouldRehydrateBusy(opts: {
  projection: SessionTurnProjection | null;
  sidebarWorking: boolean;
  threadStatus?: string;
  /** Host：session/prompt 是否仍在飞；undefined = 未知 */
  promptInFlight?: boolean;
}): boolean {
  // Host 明确：prompt 已结束 → 绝不 rehydrate busy（修：后台已完成仍显示工作中）
  if (opts.promptInFlight === false) return false;
  if (opts.promptInFlight === true) return true;

  const st = (opts.threadStatus || "").toLowerCase();
  if (st === "idle" || st === "inactive" || st === "failed") return false;

  if (opts.projection?.turnActive) return true;
  if (opts.projection?.turnUiPhase === "working") return true;
  if (opts.projection?.turnUiPhase === "cancelling") return true;
  if (opts.sidebarWorking) return true;
  if (st === "working" || st === "needs_input" || st === "blocked") return true;
  return false;
}

/** 标记会话 turn 已结束（后台 completed / status idle） */
export function markSessionTurnIdle(sessionId: string): void {
  patchSessionTurn(sessionId, {
    turnActive: false,
    turnUiPhase: "idle",
    pendingAssistantText: "",
    alreadyPaintedStopped: false,
    streamArmedThisTurn: false,
  });
}
