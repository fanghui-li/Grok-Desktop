/**
 * 非前台会话 / suspendLiveTranscript 时的 turn 投影更新（不写 transcript DOM）。
 * 对齐方案 B：后台仍更新 per-session turn-store。
 */
import {
  appendBackgroundAssistantDelta,
  getSessionTurn,
  markSessionTurnIdle,
  patchSessionTurn,
} from "./turn-store.js";

export type BgTurnEvent = {
  type?: string;
  sessionId?: string;
  role?: string;
  text?: string;
};

/**
 * 非当前会话的 transcript 范围事件 → 只改 turn-store / working 标志。
 * @returns true 表示已处理（调用方应 return）
 */
export function applyBackgroundTranscriptEvent(
  ev: BgTurnEvent,
  opts: {
    markSessionWorking: (sessionId: string, working: boolean) => void;
  },
): boolean {
  const bgSid = String(ev.sessionId || "");
  if (!bgSid) return true;
  const bgProj = getSessionTurn(bgSid);
  if (ev.type === "turn.started") {
    patchSessionTurn(bgSid, {
      turnActive: true,
      turnUiPhase: "working",
      alreadyPaintedStopped: false,
      turnStartedAt: Date.now(),
      streamArmedThisTurn: true,
      assistantStartedThisTurn: false,
      pendingAssistantText: "",
    });
    opts.markSessionWorking(bgSid, true);
  } else if (ev.type === "turn.completed") {
    markSessionTurnIdle(bgSid);
    opts.markSessionWorking(bgSid, false);
  } else if (
    bgProj?.turnActive &&
    ev.type === "message.delta" &&
    ev.role !== "user" &&
    ev.text
  ) {
    appendBackgroundAssistantDelta(bgSid, String(ev.text));
    opts.markSessionWorking(bgSid, true);
  } else if (
    bgProj?.turnActive &&
    (ev.type === "tool.started" || ev.type === "tool.completed")
  ) {
    if (ev.type === "tool.started") {
      patchSessionTurn(bgSid, {
        turnActive: true,
        turnUiPhase: "working",
        streamArmedThisTurn: true,
      });
      opts.markSessionWorking(bgSid, true);
    }
  }
  return true;
}

/**
 * create/openThread 期间：当前会话事件仍更新投影，不写 transcript。
 */
export function applySuspendedLiveTranscriptEvent(
  ev: BgTurnEvent,
  opts: {
    activeSessionId: string;
    eventBelongs: boolean;
    showPermission?: (requestId: string, summary: string) => void;
    permissionEv?: { requestId?: string; summary?: string };
    markSessionWorking: (sessionId: string, working: boolean) => void;
  },
): void {
  if (
    ev.type === "permission.requested" &&
    opts.eventBelongs &&
    opts.permissionEv?.requestId
  ) {
    opts.showPermission?.(
      opts.permissionEv.requestId,
      opts.permissionEv.summary ?? "",
    );
  }
  if (!opts.eventBelongs) return;
  const sid = opts.activeSessionId;
  if (ev.type === "turn.started") {
    patchSessionTurn(sid, {
      turnActive: true,
      turnUiPhase: "working",
      streamArmedThisTurn: true,
    });
  } else if (
    getSessionTurn(sid)?.turnActive &&
    ev.type === "message.delta" &&
    ev.text
  ) {
    appendBackgroundAssistantDelta(sid, String(ev.text));
  } else if (ev.type === "turn.completed") {
    markSessionTurnIdle(sid);
    opts.markSessionWorking(sid, false);
  }
}
