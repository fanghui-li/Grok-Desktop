/**
 * 会话合成态：goal 投影 × turn busy → 用户可理解的一档状态。
 *
 * 真源仍分轴（CLI GoalTracker vs promptInFlight）；本模块只做派生，不发明协议。
 * - goal 可 pause 而 turn 仍短暂收尾 → goal_paused_draining
 * - 不用聊天文案猜 complete / pause
 */

export type GoalActivitySlice = {
  /** 有 live/sticky 目标投影（含 complete / paused） */
  hasGoal: boolean;
  /** goal status === active（自驱） */
  goalActive: boolean;
  /** paused 族 / blocked / budget_limited */
  goalPaused: boolean;
  /** complete */
  goalCompleted: boolean;
};

export type SessionActivity =
  | "idle"
  | "chatting"
  | "goal_driving"
  | "goal_paused_draining"
  | "goal_paused"
  | "goal_completed";

/**
 * 从 goal 切片 + turn busy 派生合成态。
 * turnBusy：promptInFlight / turnActive / rehydrate busy（调用方已按 Host 真源算好）。
 */
export function deriveSessionActivity(
  goal: GoalActivitySlice,
  turnBusy: boolean,
): SessionActivity {
  if (!goal.hasGoal) {
    return turnBusy ? "chatting" : "idle";
  }
  if (goal.goalCompleted) {
    // complete 粘性；turn 仍 busy 时归 draining（收尾），否则 goal_completed
    return turnBusy ? "goal_paused_draining" : "goal_completed";
  }
  if (goal.goalActive) {
    return turnBusy ? "goal_driving" : "idle";
  }
  // paused / blocked / budget 等非 active
  if (goal.goalPaused || goal.hasGoal) {
    return turnBusy ? "goal_paused_draining" : "goal_paused";
  }
  return turnBusy ? "chatting" : "idle";
}

/** 合成态是否应显示 composer 停止键 / 工作中条 */
export function sessionActivityShowsBusy(a: SessionActivity): boolean {
  return (
    a === "chatting" ||
    a === "goal_driving" ||
    a === "goal_paused_draining"
  );
}

/** 是否「目标已停、回合收尾」——过程条文案应弱化为 draining，非自驱 */
export function sessionActivityIsDraining(a: SessionActivity): boolean {
  return a === "goal_paused_draining";
}
