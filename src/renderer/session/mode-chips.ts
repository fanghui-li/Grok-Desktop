/**
 * 输入栏 plan / goal chip 互斥焦点（纯逻辑 + DOM 同步）。
 */
import { tr } from "../../shared/i18n/index.js";

export type SessionModeChipFocus = "plan" | "goal" | null;

export type SessionModeChipsState = {
  focus: SessionModeChipFocus;
  planOn: boolean;
  goalTitle: string | null;
  goalComposeActive: boolean;
  goalCompleted: boolean;
};

/** 对齐 focus 与真实 plan/goal 可见态 */
export function reconcileSessionModeChipFocus(
  state: SessionModeChipsState,
): SessionModeChipFocus {
  const goalOn = Boolean(state.goalTitle) || state.goalComposeActive;
  let focus = state.focus;

  if (focus === "goal" && !goalOn) {
    focus = state.planOn ? "plan" : null;
  } else if (focus === "plan" && !state.planOn) {
    focus = goalOn ? "goal" : null;
  } else if (focus == null) {
    if (goalOn && state.planOn) focus = "goal";
    else if (goalOn) focus = "goal";
    else if (state.planOn) focus = "plan";
  }
  return focus;
}

export type SessionModeChipsVisibility = {
  showGoal: boolean;
  showPlan: boolean;
  focus: SessionModeChipFocus;
};

export function computeSessionModeChipsVisibility(
  state: SessionModeChipsState,
): SessionModeChipsVisibility {
  const goalOn = Boolean(state.goalTitle) || state.goalComposeActive;
  const focus = reconcileSessionModeChipFocus(state);
  return {
    focus,
    showGoal: goalOn && focus === "goal",
    showPlan: state.planOn && focus === "plan",
  };
}

/** 将 chip 可见性写到 DOM（#chip-plan / #chip-goal 及 -2） */
export function paintSessionModeChips(opts: {
  showPlan: boolean;
  showGoal: boolean;
  planOn: boolean;
  goalTitle: string | null;
  goalComposeActive: boolean;
  goalCompleted: boolean;
  /** plan 面板 chrome 等副作用 */
  onAfterPlanChips?: () => void;
}): void {
  for (const id of ["chip-plan", "chip-plan-2"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !opts.showPlan);
    el.title = opts.planOn ? tr("plan.modeChipOpen") : tr("plan.modeChip");
  }
  opts.onAfterPlanChips?.();
  for (const id of ["chip-goal", "chip-goal-2"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !opts.showGoal);
    el.classList.toggle(
      "is-draft",
      opts.goalComposeActive && !opts.goalTitle,
    );
    if (opts.goalTitle) {
      const prefix = opts.goalCompleted
        ? tr("goal.kickerDone")
        : tr("composer.goal");
      el.title = `${prefix}: ${opts.goalTitle}`;
    } else if (opts.goalComposeActive) {
      el.title = tr("goal.bannerActive");
    }
  }
}
