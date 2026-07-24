/**
 * 阶段一：每会话 Plan UI 投影（对齐 CLI per-AgentView plan 状态）。
 *
 * - 切换会话 = 换焦点：切走 stash，切回 rehydrate；默认不 abandoned exit_plan waiter。
 * - 后台 session 的 exit_plan / plan.mode 只写本 store，不抢前台侧栏。
 * - 不持有 DOM；审批正文 seed 仅作切回预填。
 */

export type PlanPhase = "off" | "pending" | "active";

export type SessionPlanPendingApproval = {
  requestId: string;
  sessionId: string;
  planContent: string;
};

export type SessionPlanProjection = {
  planPhase: PlanPhase;
  pendingApproval: SessionPlanPendingApproval | null;
  updatedAtMs: number;
};

const store = new Map<string, SessionPlanProjection>();

export function idlePlanProjection(): SessionPlanProjection {
  return {
    planPhase: "off",
    pendingApproval: null,
    updatedAtMs: Date.now(),
  };
}

export function getSessionPlan(
  sessionId: string | null | undefined,
): SessionPlanProjection | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return store.get(sid) ?? null;
}

export function getOrCreateSessionPlan(
  sessionId: string,
): SessionPlanProjection {
  const sid = sessionId.trim();
  let p = store.get(sid);
  if (!p) {
    p = idlePlanProjection();
    store.set(sid, p);
  }
  return p;
}

export function setSessionPlan(
  sessionId: string,
  projection: Omit<SessionPlanProjection, "updatedAtMs"> & {
    updatedAtMs?: number;
  },
): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.set(sid, {
    planPhase: projection.planPhase,
    pendingApproval: projection.pendingApproval
      ? {
          requestId: projection.pendingApproval.requestId,
          sessionId: projection.pendingApproval.sessionId || sid,
          planContent: projection.pendingApproval.planContent ?? "",
        }
      : null,
    updatedAtMs: projection.updatedAtMs ?? Date.now(),
  });
}

export function patchSessionPlan(
  sessionId: string,
  patch: Partial<
    Pick<SessionPlanProjection, "planPhase" | "pendingApproval">
  >,
): SessionPlanProjection {
  const cur = getOrCreateSessionPlan(sessionId);
  const next: SessionPlanProjection = {
    planPhase: patch.planPhase ?? cur.planPhase,
    pendingApproval:
      patch.pendingApproval !== undefined
        ? patch.pendingApproval
        : cur.pendingApproval,
    updatedAtMs: Date.now(),
  };
  store.set(sessionId.trim(), next);
  return next;
}

export function clearSessionPlan(sessionId: string | null | undefined): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.delete(sid);
}

/** 是否有未决 exit_plan 审批（侧栏徽标 / 列表提示用） */
export function sessionHasPlanApproval(
  sessionId: string | null | undefined,
): boolean {
  const p = getSessionPlan(sessionId);
  return Boolean(p?.pendingApproval?.requestId?.trim());
}
