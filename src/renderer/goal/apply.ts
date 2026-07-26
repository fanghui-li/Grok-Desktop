/**
 * applyAgentGoalEvent 纯归约（无 DOM / 无 IPC）。
 * main 只消费 outcome 写投影与副作用。
 */
import { tr } from "../../shared/i18n/index.js";
import type { GoalUiProjection } from "./banner-ui.js";
import { isGoalPausedStatus } from "./input.js";
import { parseGoalUiStatus, type GoalUiStatus } from "./status.js";

export type AgentGoalEvent = {
  sessionId?: string;
  goalId?: string;
  objective?: string;
  status: string;
  phase?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  elapsedMs?: number;
  message?: string;
  lastEvent?: string;
  lastEventDetail?: string;
  verifyingCompletion?: boolean;
  planning?: boolean;
};

export type GoalApplyState = {
  activeSessionId: string | null;
  projection: GoalUiProjection | null;
  pendingTitle: string | null;
  /** 已 clear 的 goalId 集合（只读比对；写入由 outcome 指示） */
  localClearedIds: ReadonlySet<string>;
  goalTokenBudget: number | null;
  elapsedAnchorAt: number | null;
  now: number;
};

export type GoalApplyToast = {
  text: string;
  kind: "info" | "error";
};

export type GoalApplyOutcome =
  | { type: "noop" }
  | {
      type: "cleared";
      had: boolean;
      toast?: GoalApplyToast;
      addClearedIds: string[];
      hostClear: boolean;
    }
  | {
      type: "update";
      projection: GoalUiProjection;
      prevStatus: GoalUiStatus | undefined;
      elapsedAnchorAt: number | null;
      clearCompose: boolean;
      clearPending: boolean;
      setTokenBudget: number | null | undefined;
      /** undefined = 不改 complete hide timer；null = 清 timer */
      clearCompleteHideTimer: boolean;
      toast?: GoalApplyToast;
      markComplete?: { toast: boolean; objective: string };
      refreshTurnPhase: boolean;
      reconcileAfterStop: boolean;
      renderBanner: boolean;
      removeClearedId?: string;
    };

function phaseOf(
  ev: AgentGoalEvent,
  prev: GoalUiProjection | null,
): GoalUiProjection["phase"] {
  if (
    ev.phase === "planning" ||
    ev.phase === "executing" ||
    ev.phase === "idle"
  ) {
    return ev.phase;
  }
  return prev?.phase ?? "idle";
}

/**
 * 纯函数：根据 wire 事件与当前投影，产出下一步状态与副作用标志。
 */
export function reduceAgentGoalEvent(
  state: GoalApplyState,
  ev: AgentGoalEvent,
): GoalApplyOutcome {
  if (
    state.activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== state.activeSessionId
  ) {
    return { type: "noop" };
  }

  const st = parseGoalUiStatus(ev.status);
  const goalId = String(ev.goalId ?? "").trim();
  const last = String(ev.lastEvent ?? "").toLowerCase();
  const projection = state.projection;
  const pendingTitle = state.pendingTitle;

  if (st === "cleared" || last === "goal_cleared" || last === "goal_cancelled") {
    const had = Boolean(projection || pendingTitle);
    const addClearedIds: string[] = [];
    if (goalId) addClearedIds.push(goalId);
    if (projection?.goalId) addClearedIds.push(projection.goalId);
    const toastCancel =
      had &&
      (String(ev.status).toLowerCase() === "cancelled" ||
        String(ev.status).toLowerCase() === "canceled") &&
      Boolean(last);
    return {
      type: "cleared",
      had,
      addClearedIds,
      hostClear: Boolean(state.activeSessionId),
      toast: toastCancel
        ? { text: tr("goal.cancelledToast"), kind: "info" }
        : undefined,
    };
  }

  if (goalId && state.localClearedIds.has(goalId)) {
    return { type: "noop" };
  }

  // cleared 已在上方 early-return；此处 st 仅为 GoalUiStatus
  const status = st;

  const sameGoal = Boolean(
    projection &&
      ((goalId && projection.goalId === goalId) ||
        (!goalId && projection.goalId)),
  );
  const newGoal = Boolean(
    goalId && projection && projection.goalId !== goalId,
  );

  if (
    sameGoal &&
    projection &&
    ((projection.status === "complete" && status !== "complete") ||
      (projection.status === "budget_limited" &&
        status !== "complete" &&
        status !== "budget_limited"))
  ) {
    return { type: "noop" };
  }

  if (
    projection?.status === "complete" &&
    (status === "active" || last === "goal_created")
  ) {
    return { type: "noop" };
  }

  const wireElapsed =
    typeof ev.elapsedMs === "number" && ev.elapsedMs >= 0
      ? Math.floor(ev.elapsedMs)
      : (projection?.elapsedMs ?? 0);

  let elapsedFloorMs = wireElapsed;
  let elapsedAnchorAt = state.elapsedAnchorAt;
  if (sameGoal && projection) {
    elapsedFloorMs = Math.max(
      projection.elapsedFloorMs,
      projection.elapsedMs,
      wireElapsed,
    );
  } else if (newGoal) {
    elapsedFloorMs = wireElapsed;
    elapsedAnchorAt = null;
  }

  const objective =
    (ev.objective ?? "").trim() ||
    projection?.objective ||
    pendingTitle ||
    "Goal";

  const prevStatus = projection?.status;
  const next: GoalUiProjection = {
    goalId: goalId || projection?.goalId || `anon-${state.now}`,
    objective,
    status,
    phase: phaseOf(ev, projection),
    tokenBudget:
      ev.tokenBudget !== undefined
        ? ev.tokenBudget
        : (projection?.tokenBudget ?? state.goalTokenBudget),
    tokensUsed:
      typeof ev.tokensUsed === "number"
        ? ev.tokensUsed
        : (projection?.tokensUsed ?? 0),
    elapsedMs: wireElapsed,
    elapsedFloorMs,
    pauseMessage: ev.message ?? projection?.pauseMessage,
    lastEvent: ev.lastEvent ?? projection?.lastEvent,
    verifyingCompletion: Boolean(
      ev.verifyingCompletion ?? projection?.verifyingCompletion,
    ),
    planning: Boolean(ev.planning ?? projection?.planning),
  };

  let setTokenBudget: number | null | undefined;
  if (next.tokenBudget != null && next.tokenBudget > 0) {
    setTokenBudget = next.tokenBudget;
  }

  if (status === "complete") {
    return {
      type: "update",
      projection: next,
      prevStatus,
      elapsedAnchorAt: null,
      clearCompose: true,
      clearPending: true,
      setTokenBudget,
      clearCompleteHideTimer: true,
      markComplete: {
        toast: prevStatus != null && prevStatus !== "complete",
        objective: objective || tr("composer.goal"),
      },
      refreshTurnPhase: true,
      reconcileAfterStop: prevStatus !== "complete",
      renderBanner: false,
      removeClearedId: goalId || undefined,
    };
  }

  const becamePaused = isGoalPausedStatus(status);
  let toast: GoalApplyToast | undefined;
  if (becamePaused) {
    elapsedAnchorAt = null;
    if (status === "blocked" && prevStatus !== "blocked") {
      toast = {
        text: ev.message?.trim() || tr("goal.blocked"),
        kind: "error",
      };
    } else if (
      status === "budget_limited" &&
      prevStatus !== "budget_limited"
    ) {
      toast = { text: tr("goal.budgetLimitedToast"), kind: "error" };
    } else if (status === "infra_paused" && prevStatus !== "infra_paused") {
      const msg = (ev.message ?? "").trim();
      toast = {
        text: msg
          ? msg.length > 160
            ? `${msg.slice(0, 160)}…`
            : msg
          : tr("goal.infraPausedToast"),
        kind: "error",
      };
    }
  } else if (status === "active") {
    if (elapsedAnchorAt == null && prevStatus != null) {
      elapsedAnchorAt = state.now;
    } else if (prevStatus && prevStatus !== "active") {
      elapsedAnchorAt = state.now;
    } else if (prevStatus === "active" && elapsedAnchorAt == null) {
      elapsedAnchorAt = state.now;
    }
  }

  return {
    type: "update",
    projection: next,
    prevStatus,
    elapsedAnchorAt,
    clearCompose: true,
    clearPending: true,
    setTokenBudget,
    clearCompleteHideTimer: true,
    toast,
    refreshTurnPhase: true,
    reconcileAfterStop: Boolean(becamePaused && prevStatus !== status),
    renderBanner: true,
    removeClearedId: goalId || undefined,
  };
}
