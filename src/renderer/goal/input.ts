/**
 * Goal 输入解析与发送拼装（纯逻辑，无 DOM / 无 session 副作用）。
 */
import type { GoalUiStatus } from "./status.js";

/** 解析目标正文与 `--budget N`（对齐 CLI parse_goal_budget） */
export function parseGoalBudget(body: string): {
  objective: string;
  budget: number | null;
} {
  const m = body.match(/^(.*?)\s+--budget\s+(\d+)\s*$/i);
  if (m) {
    const n = Number(m[2]);
    if (Number.isFinite(n) && n > 0) {
      return { objective: m[1].trim(), budget: Math.floor(n) };
    }
  }
  return { objective: body.trim(), budget: null };
}

export type ParseGoalInputResult = {
  /** 纯 `/goal` 无正文 → 进入 compose，不发送 */
  enterComposeOnly: boolean;
  /** 解析出的目标标题 */
  goalTitle: string | null;
  /** 去掉 /goal 前缀后的发送正文 */
  message: string;
  /** 若解析到 --budget，带回供调用方写入状态 */
  budget: number | null;
};

/**
 * 解析输入中的 goal：
 * - forceGoal / goalComposeActive 时整段文本为目标
 * - `/goal 内容` 或单独 `/goal`
 */
export function parseGoalInput(
  raw: string,
  opts?: { forceGoal?: boolean; goalComposeActive?: boolean },
): ParseGoalInputResult {
  const text = raw.trim();
  const m = text.match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (m) {
    const body = (m[1] ?? "").trim();
    if (!body) {
      return {
        enterComposeOnly: true,
        goalTitle: null,
        message: "",
        budget: null,
      };
    }
    const parsed = parseGoalBudget(body);
    return {
      enterComposeOnly: false,
      goalTitle: parsed.objective,
      message: parsed.objective,
      budget: parsed.budget,
    };
  }
  if ((opts?.forceGoal || opts?.goalComposeActive) && text) {
    const parsed = parseGoalBudget(text);
    return {
      enterComposeOnly: false,
      goalTitle: parsed.objective,
      message: parsed.objective,
      budget: parsed.budget,
    };
  }
  return {
    enterComposeOnly: false,
    goalTitle: null,
    message: text,
    budget: null,
  };
}

/** 是否需要替换确认（同步探测） */
export function needsGoalReplaceConfirm(
  prevObjective: string | null | undefined,
  nextTitle: string | null | undefined,
): boolean {
  const prev = prevObjective?.trim();
  const next = nextTitle?.trim();
  return Boolean(prev && next && prev !== next);
}

/**
 * 发给 agent 的正文：新建/重设目标用 CLI 同源 `/goal …`。
 */
export function agentContentForSend(
  userContent: string,
  goalJustSet: string | null,
  tokenBudget: number | null,
): string {
  if (goalJustSet) {
    const budget =
      tokenBudget != null && tokenBudget > 0
        ? ` --budget ${tokenBudget}`
        : "";
    return `/goal ${goalJustSet}${budget}`;
  }
  return userContent;
}

export function isGoalPausedStatus(status: GoalUiStatus | undefined): boolean {
  if (!status) return false;
  return (
    status === "user_paused" ||
    status === "back_off_paused" ||
    status === "no_progress_paused" ||
    status === "infra_paused" ||
    status === "blocked" ||
    status === "budget_limited"
  );
}

export function formatGoalElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `· ${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `· ${m}m${r ? ` ${r}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `· ${h}h${rm ? ` ${rm}m` : ""}`;
}

/** live elapsed：floor 与 wire 基线 + active 时 wall 外推 */
export function computeGoalElapsedMs(opts: {
  elapsedFloorMs: number;
  elapsedMs: number;
  paused: boolean;
  completed: boolean;
  anchorAt: number | null;
  now?: number;
}): number {
  const base = Math.max(opts.elapsedFloorMs, opts.elapsedMs);
  if (opts.paused || opts.completed) return base;
  if (opts.anchorAt == null) return base;
  return base + ((opts.now ?? Date.now()) - opts.anchorAt);
}
