/**
 * openThread 阶段规划（纯逻辑）：leave / bind plan / attach 回写。
 * 副作用（endTurn / DOM）仍由 main 执行。
 */
import {
  isSameOpenSession,
  sanitizePendingApprovalForSession,
  shouldKeepBackgroundWorking,
} from "./history-replay.js";
import type { PlanPhase, SessionPlanPendingApproval } from "./plan-store.js";

export type OpenThreadLeavePlan = {
  sameSession: boolean;
  prevSid: string | null;
  wasActivelyTurning: boolean;
  keepBgWorking: boolean;
  /** 切走前应 snapshot turn/plan */
  shouldSnapshot: boolean;
  /** 切走后应清 prompt history / goal / plan stash */
  shouldResetCrossSessionUi: boolean;
};

export function planOpenThreadLeave(opts: {
  activeSessionId: string | null;
  activeThreadId: string | null;
  targetSessionId: string;
  targetThreadId: string;
  turnActive: boolean;
  isSidebarWorking: (sessionId: string) => boolean;
  isThreadListedWorking: (sessionId: string) => boolean;
}): OpenThreadLeavePlan {
  const prevSid = opts.activeSessionId;
  const sameSession = isSameOpenSession({
    activeSessionId: opts.activeSessionId,
    activeThreadId: opts.activeThreadId,
    targetSessionId: opts.targetSessionId,
    targetThreadId: opts.targetThreadId,
  });
  const wasActivelyTurning = opts.turnActive;
  const keepBgWorking = shouldKeepBackgroundWorking({
    sameSession,
    prevSessionId: prevSid,
    wasActivelyTurning,
    isSidebarWorking: !!prevSid && opts.isSidebarWorking(prevSid),
    threadListedWorking:
      !!prevSid && opts.isThreadListedWorking(prevSid),
  });
  return {
    sameSession,
    prevSid,
    wasActivelyTurning,
    keepBgWorking,
    shouldSnapshot: !sameSession && !!prevSid,
    shouldResetCrossSessionUi: !sameSession,
  };
}

export type BoundPlanProjection = {
  planPhase: PlanPhase;
  pendingApproval: SessionPlanPendingApproval | null;
};

/** 从 session-plan-store 投影绑定到前台 plan 状态 */
export function bindPlanProjectionForOpen(
  planProj:
    | {
        planPhase?: PlanPhase;
        pendingApproval?: SessionPlanPendingApproval | null;
      }
    | null
    | undefined,
  sessionId: string,
): BoundPlanProjection {
  const pendingApproval = sanitizePendingApprovalForSession(
    planProj?.pendingApproval
      ? { ...planProj.pendingApproval }
      : null,
    sessionId,
  );
  return {
    planPhase: planProj?.planPhase ?? "off",
    pendingApproval,
  };
}

/**
 * 后台 keep-working：若 snapshot 已 idle，是否应强制补回 turnActive。
 */
export function shouldForceBackgroundTurnActive(opts: {
  keepBgWorking: boolean;
  prevSid: string | null;
  snapTurnActive: boolean | undefined;
}): boolean {
  return (
    opts.keepBgWorking &&
    !!opts.prevSid &&
    opts.snapTurnActive === false
  );
}

/** attachState 是否应更新 attach UI（live/attaching/failed） */
export function shouldApplyAttachUiState(
  state: string | undefined,
): boolean {
  const s = String(state || "").toLowerCase();
  return s === "live" || s === "attaching" || s === "failed";
}
