/**
 * Goal UI 状态枚举与文案（对齐 CLI GoalDisplayStatus 子集）。
 */
import { tr } from "../../shared/i18n/index.js";

export type GoalUiStatus =
  | "active"
  | "user_paused"
  | "back_off_paused"
  | "no_progress_paused"
  | "infra_paused"
  | "blocked"
  | "budget_limited"
  | "complete";

export function parseGoalUiStatus(raw: string): GoalUiStatus | "cleared" {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim();
  switch (s) {
    case "active":
      return "active";
    case "user_paused":
    case "paused":
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
      return s ? "user_paused" : "user_paused";
  }
}

export type GoalKickerContext = {
  verifyingCompletion?: boolean;
  planning?: boolean;
  phase?: string;
};

export function goalStatusKicker(
  st: GoalUiStatus,
  ctx?: GoalKickerContext,
): string {
  switch (st) {
    case "complete":
      return tr("goal.kickerDone");
    case "user_paused":
      return tr("goal.kickerPaused");
    case "back_off_paused":
      return tr("goal.kickerBackOff");
    case "no_progress_paused":
      return tr("goal.kickerNoProgress");
    case "infra_paused":
      return tr("goal.kickerInfra");
    case "blocked":
      return tr("goal.kickerBlocked");
    case "budget_limited":
      return tr("goal.kickerBudget");
    case "active":
    default: {
      if (ctx?.verifyingCompletion) return tr("goal.kickerVerifying");
      if (ctx?.planning || ctx?.phase === "planning") {
        return tr("goal.kickerPlanning");
      }
      return tr("goal.kicker");
    }
  }
}

/**
 * paused 状态的短提示（仅 i18n，不展示 agent pauseMessage / 错误全文）。
 */
export function goalPauseHintText(st: GoalUiStatus): string {
  switch (st) {
    case "user_paused":
      return tr("goal.hintUserPaused");
    case "back_off_paused":
      return tr("goal.hintBackOff");
    case "no_progress_paused":
      return tr("goal.hintNoProgress");
    case "infra_paused":
      return tr("goal.hintInfra");
    case "blocked":
      return tr("goal.hintBlocked");
    case "budget_limited":
      return tr("goal.hintBudget");
    default:
      return "";
  }
}
