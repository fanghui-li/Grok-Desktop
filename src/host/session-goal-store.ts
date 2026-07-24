/**
 * per-session Goal 投影（对齐 CLI AgentView.goal_state）。
 *
 * 真源：agent `sessionUpdate: goal_updated`。
 * - clear 后同 goal_id 迟到事件丢弃（防复活）
 * - 新 goal_id 重置 elapsed floor
 * - 未知 status → user_paused（fail-safe，不当 Active）
 * - 不把 update_goal tool 当创建路径
 */

import type {
  GoalPhase,
  GoalWireStatus,
  SessionGoalProjection,
} from "../shared/types.js";

export type GoalUpdatedInput = {
  sessionId: string;
  goalId?: string;
  objective?: string;
  status: string;
  phase?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  elapsedMs?: number;
  lastEvent?: string;
  lastEventDetail?: string;
  message?: string;
  verifyingCompletion?: boolean;
  planning?: boolean;
  classifierRunsAttempted?: number;
  classifierMaxRuns?: number;
  lastClassifierVerdict?: string;
  lastClassifierDetailsPath?: string;
  tokenBaseline?: number;
  finishedSubagentTokens?: number;
  liveSubagentTokens?: number;
};

type SessionGoalControl = {
  projection: SessionGoalProjection | null;
  /** clear 后禁止同 id 复活 */
  clearedGoalIds: Set<string>;
  updatedAtMs: number;
};

const store = new Map<string, SessionGoalControl>();

function emptyControl(): SessionGoalControl {
  return {
    projection: null,
    clearedGoalIds: new Set(),
    updatedAtMs: Date.now(),
  };
}

function getOrCreate(sessionId: string): SessionGoalControl {
  const sid = sessionId.trim();
  let c = store.get(sid);
  if (!c) {
    c = emptyControl();
    store.set(sid, c);
  }
  return c;
}

/** CLI GoalDisplayStatus::parse — 未知 → user_paused */
export function parseGoalWireStatus(raw: string): GoalWireStatus {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim();
  switch (s) {
    case "active":
      return "active";
    case "user_paused":
    case "paused": // legacy
      return "user_paused";
    case "back_off_paused":
      return "back_off_paused";
    case "no_progress_paused":
      return "no_progress_paused";
    case "infra_paused":
      return "infra_paused";
    case "blocked":
      return "blocked";
    case "budget_limited":
      return "budget_limited";
    case "complete":
    case "completed":
      return "complete";
    case "cleared":
    case "cancelled":
    case "canceled":
      return "cleared";
    default:
      // fail-safe：不可解释不当 Active
      return s ? "user_paused" : "user_paused";
  }
}

export function parseGoalPhase(raw?: string): GoalPhase {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim();
  if (s === "planning") return "planning";
  if (s === "executing") return "executing";
  return "idle";
}

export function isGoalPausedStatus(st: GoalWireStatus): boolean {
  return (
    st === "user_paused" ||
    st === "back_off_paused" ||
    st === "no_progress_paused" ||
    st === "infra_paused" ||
    st === "blocked"
  );
}

export function isGoalTerminalUi(st: GoalWireStatus): boolean {
  return st === "complete" || st === "budget_limited" || st === "cleared";
}

/**
 * 对齐 CLI GoalTracker：`pause` 仅从 Active；`complete` 后 pause 为 no-op。
 * 同 goal 上已 terminal 时，拒绝被 active/paused/blocked 等降级覆盖
 *（防 rate-limit 迟到 goal_updated 把「已完成」打成「已暂停(错误)」）。
 * cleared / 新 goal_id / 重复 complete 仍放行。
 */
export function shouldDropGoalStatusDowngrade(
  prevStatus: GoalWireStatus | undefined,
  nextStatus: GoalWireStatus,
  sameGoal: boolean,
): boolean {
  if (!prevStatus || !sameGoal) return false;
  if (nextStatus === "cleared") return false;
  if (prevStatus === "complete") {
    // complete 粘性：仅允许再次 complete（刷新字段）
    return nextStatus !== "complete";
  }
  if (prevStatus === "budget_limited") {
    // budget_limited 也是终端；仅 complete / 再 budget 可覆盖
    return nextStatus !== "complete" && nextStatus !== "budget_limited";
  }
  return false;
}

/** 粗粒度兼容映射（旧 GoalState.status） */
export function wireStatusToLegacy(
  st: GoalWireStatus,
): "active" | "paused" | "blocked" | "completed" | "cancelled" {
  if (st === "complete") return "completed";
  if (st === "cleared") return "cancelled";
  if (st === "blocked") return "blocked";
  if (st === "budget_limited") return "paused";
  if (isGoalPausedStatus(st)) return "paused";
  return "active";
}

export function getSessionGoal(
  sessionId: string,
): SessionGoalProjection | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return store.get(sid)?.projection ?? null;
}

export function getSessionGoalControl(
  sessionId: string,
): SessionGoalControl | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return store.get(sid) ?? null;
}

/**
 * 应用一条 goal_updated。
 * @returns 更新后的投影；cleared 返回 null；被丢弃的迟到事件返回 `{ dropped: true }`
 */
export function applyGoalUpdated(
  input: GoalUpdatedInput,
): {
  projection: SessionGoalProjection | null;
  dropped: boolean;
  cleared: boolean;
} {
  const sid = input.sessionId?.trim();
  if (!sid) {
    return { projection: null, dropped: true, cleared: false };
  }
  const ctrl = getOrCreate(sid);
  const status = parseGoalWireStatus(input.status);
  const goalId = String(input.goalId ?? "").trim();

  // cleared：清空投影，记录 id（空 id 也清）
  if (status === "cleared") {
    const prevId = ctrl.projection?.goalId;
    if (prevId) ctrl.clearedGoalIds.add(prevId);
    if (goalId) ctrl.clearedGoalIds.add(goalId);
    ctrl.projection = null;
    ctrl.updatedAtMs = Date.now();
    return { projection: null, dropped: false, cleared: true };
  }

  // 同 id 在 clear 后迟到 → 丢弃
  if (goalId && ctrl.clearedGoalIds.has(goalId)) {
    return { projection: ctrl.projection, dropped: true, cleared: false };
  }

  const prev = ctrl.projection;
  const sameGoal = Boolean(
    prev &&
      ((goalId && prev.goalId === goalId) ||
        // wire 偶发缺 goal_id：同会话仅一条 goal 时仍按同 goal 处理
        (!goalId && prev.goalId)),
  );
  const newGoal = Boolean(goalId && prev && prev.goalId !== goalId);

  if (shouldDropGoalStatusDowngrade(prev?.status, status, sameGoal)) {
    return { projection: prev, dropped: true, cleared: false };
  }

  const wireElapsed =
    typeof input.elapsedMs === "number" && input.elapsedMs >= 0
      ? Math.floor(input.elapsedMs)
      : (prev?.elapsedMs ?? 0);

  // elapsed floor：同 goal 不回拨；新 goal 重置
  let elapsedFloorMs = 0;
  if (sameGoal && prev) {
    elapsedFloorMs = Math.max(prev.elapsedFloorMs, prev.elapsedMs, wireElapsed);
  } else if (newGoal || !prev) {
    elapsedFloorMs = wireElapsed;
  } else {
    // 无 goalId 时尽量沿用
    elapsedFloorMs = Math.max(prev?.elapsedFloorMs ?? 0, wireElapsed);
  }

  const objective =
    (input.objective ?? "").trim() ||
    (sameGoal ? prev?.objective : "") ||
    "";

  // 无 objective 且无 prev 且非 complete → 可能是噪声，仍接受 active 空 objective 极少见
  const projection: SessionGoalProjection = {
    sessionId: sid,
    goalId: goalId || prev?.goalId || `anon-${Date.now()}`,
    objective: objective || prev?.objective || "Goal",
    status,
    phase: parseGoalPhase(input.phase) || (prev?.phase ?? "idle"),
    tokenBudget:
      input.tokenBudget !== undefined
        ? input.tokenBudget
        : (prev?.tokenBudget ?? null),
    tokensUsed:
      typeof input.tokensUsed === "number"
        ? input.tokensUsed
        : (prev?.tokensUsed ?? 0),
    elapsedMs: wireElapsed,
    elapsedFloorMs,
    pauseMessage:
      input.message !== undefined
        ? input.message
        : sameGoal
          ? prev?.pauseMessage
          : undefined,
    lastEvent: input.lastEvent ?? (sameGoal ? prev?.lastEvent : undefined),
    lastEventDetail:
      input.lastEventDetail ??
      (sameGoal ? prev?.lastEventDetail : undefined),
    verifyingCompletion: Boolean(
      input.verifyingCompletion ??
        (sameGoal ? prev?.verifyingCompletion : false),
    ),
    planning: Boolean(
      input.planning ?? (sameGoal ? prev?.planning : false),
    ),
    classifierRunsAttempted:
      input.classifierRunsAttempted ??
      (sameGoal ? prev?.classifierRunsAttempted : undefined),
    classifierMaxRuns:
      input.classifierMaxRuns ??
      (sameGoal ? prev?.classifierMaxRuns : undefined),
    lastClassifierVerdict:
      input.lastClassifierVerdict ??
      (sameGoal ? prev?.lastClassifierVerdict : undefined),
    lastClassifierDetailsPath:
      input.lastClassifierDetailsPath ??
      (sameGoal ? prev?.lastClassifierDetailsPath : undefined),
    tokenBaseline:
      input.tokenBaseline ?? (sameGoal ? prev?.tokenBaseline : undefined),
    finishedSubagentTokens:
      input.finishedSubagentTokens ??
      (sameGoal ? prev?.finishedSubagentTokens : undefined),
    liveSubagentTokens:
      input.liveSubagentTokens ??
      (sameGoal ? prev?.liveSubagentTokens : undefined),
    updatedAt: new Date().toISOString(),
  };

  // 新 goal 从 cleared 集合移除（允许新 id）
  if (goalId) ctrl.clearedGoalIds.delete(goalId);

  ctrl.projection = projection;
  ctrl.updatedAtMs = Date.now();
  return { projection, dropped: false, cleared: false };
}

/** 用户 /goal clear 乐观：立刻无投影并记 id */
export function markGoalClearedLocal(
  sessionId: string,
  goalId?: string,
): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  const ctrl = getOrCreate(sid);
  const id = goalId || ctrl.projection?.goalId;
  if (id) ctrl.clearedGoalIds.add(id);
  ctrl.projection = null;
  ctrl.updatedAtMs = Date.now();
}

export function clearSessionGoal(sessionId: string): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.delete(sid);
}

/** live elapsed：floor 与 wire 基线取 max，外推由 Renderer 做 */
export function liveElapsedMs(p: SessionGoalProjection): number {
  return Math.max(p.elapsedFloorMs, p.elapsedMs);
}
