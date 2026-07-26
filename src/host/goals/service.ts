/**
 * Goals / Plans / Subagents 门面（DesktopHost IPC 层委托）。
 * 磁盘与 jsonl 真源在 disk.ts；内存 harness 投影在 session/goal-store。
 */
import type { GoalState, PlanState, SubagentNode } from "../../shared/types.js";
import type { HostLogger } from "../logger.js";
import type { PlanApprovalClient } from "../permission/respond.js";
import {
  planStatusAfterRespond,
  respondPlanApprovalAcrossClients,
} from "../permission/respond.js";
import {
  getSessionGoal,
  markGoalClearedLocal,
} from "../session/goal-store.js";
import {
  clearGoal,
  loadPlan,
  loadSubagentTree,
  projectionToLegacyState,
  setGoalStatus,
  setPlanStatus,
  syncGoalFromAgentLog,
  writeGoal,
  writePlan,
} from "./disk.js";

export type GoalsServiceDeps = {
  home?: string;
  logger: HostLogger;
  /** 当前 live clients（plan approval 路由） */
  listPlanClients: () => Array<PlanApprovalClient | null | undefined>;
};

export class GoalsService {
  constructor(private readonly deps: GoalsServiceDeps) {}

  get(sessionId: string): GoalState | null {
    const proj = getSessionGoal(sessionId);
    if (proj) return projectionToLegacyState(proj);
    return null;
  }

  /** @deprecated 本地写非权威；控制面应发 /goal slash */
  set(
    sessionId: string,
    title: string,
    status?: GoalState["status"],
  ): GoalState {
    return writeGoal(
      sessionId,
      title,
      this.deps.home,
      status ?? "active",
    );
  }

  /** @deprecated pause/resume 应走 agent slash */
  setStatus(
    sessionId: string,
    status: GoalState["status"],
  ): GoalState | null {
    return setGoalStatus(sessionId, status, this.deps.home);
  }

  clear(sessionId: string): { cleared: boolean } {
    markGoalClearedLocal(sessionId);
    return { cleared: clearGoal(sessionId, this.deps.home) };
  }

  sync(sessionId: string) {
    return syncGoalFromAgentLog(sessionId, this.deps.home);
  }

  plansGet(sessionId: string): PlanState | null {
    return loadPlan(sessionId, this.deps.home);
  }

  plansWrite(sessionId: string, content: string): PlanState {
    return writePlan(sessionId, content, this.deps.home);
  }

  plansApprove(sessionId: string): PlanState {
    return setPlanStatus(sessionId, "approved", this.deps.home);
  }

  plansReject(sessionId: string): PlanState {
    return setPlanStatus(sessionId, "rejected", this.deps.home);
  }

  plansRespond(
    requestId: string,
    outcome: "approved" | "cancelled" | "abandoned",
    feedback?: string,
    sessionId?: string,
  ): { ok: true } {
    const result = respondPlanApprovalAcrossClients(
      this.deps.listPlanClients(),
      requestId,
      outcome,
      feedback,
    );
    if (sessionId) {
      setPlanStatus(
        sessionId,
        planStatusAfterRespond(outcome),
        this.deps.home,
      );
    }
    this.deps.logger.info("plans.respond", {
      requestId,
      outcome,
      feedback: Boolean(feedback),
    });
    return result;
  }

  subagentsTree(sessionId: string): SubagentNode[] {
    return loadSubagentTree(sessionId, this.deps.home);
  }
}
