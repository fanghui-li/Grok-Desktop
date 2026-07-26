/**
 * plan.approval.requested / plan.mode.changed（自 main 迁出）。
 * planPhase / pendingApproval 真源仍经 deps 读写。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  getSessionPlan,
  patchSessionPlan,
  type PlanPhase,
  type SessionPlanPendingApproval,
} from "../session/plan-store.js";
import type { ThreadRow } from "../thread/model.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type PlanEventHandlersDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  getThreads: () => ThreadRow[];
  eventBelongsToActiveSession: (ev: {
    sessionId?: string;
    threadId?: string;
  }) => boolean;
  markSessionWorking: (sessionId: string, working: boolean) => void;
  endStreamBubble: () => void;
  setTurnStatus: (label: string) => void;
  getPlanPhase: () => PlanPhase;
  setPlanPhase: (phase: PlanPhase) => void;
  setPendingApproval: (p: SessionPlanPendingApproval | null) => void;
  syncPermLabels: () => void;
  openPlanPanel: (opts: {
    requestId?: string | null;
    forceReload?: boolean;
    seedContent?: string | null;
    ownerSessionId?: string | null;
  }) => Promise<void>;
  isPlanOn: () => boolean;
  isPlanApprovalArmed: () => boolean;
  snapshotActiveSessionPlan: (sessionId: string | null | undefined) => void;
};

export class PlanEventHandlers {
  constructor(private readonly deps: PlanEventHandlersDeps) {}

  /**
   * agent 发起 x.ai/exit_plan_mode。
   * 阶段一：仅当前前台会话打开侧栏；后台只写入 session-plan-store。
   */
  async handleApprovalRequested(ev: {
    requestId: string;
    sessionId: string;
    threadId?: string;
    toolCallId?: string;
    planContent?: string | null;
  }): Promise<void> {
    const ownerSid = (ev.sessionId || "").trim();
    if (!ownerSid || !ev.requestId?.trim()) return;

    let content = (ev.planContent ?? "").trim();
    if (!content) {
      const res = await this.deps.inv<{
        content?: string;
      } | null>("plans.get", { sessionId: ownerSid });
      if (res.ok && res.data?.content) {
        content = res.data.content.trim();
      }
    }
    if (content) {
      const cur = await this.deps.inv<{ content?: string } | null>(
        "plans.get",
        { sessionId: ownerSid },
      );
      if (cur.ok && !(cur.data?.content ?? "").trim()) {
        await this.deps.inv("plans.write", {
          sessionId: ownerSid,
          content,
        });
      }
    }

    const pending: SessionPlanPendingApproval = {
      requestId: ev.requestId.trim(),
      sessionId: ownerSid,
      planContent: content,
    };
    patchSessionPlan(ownerSid, {
      planPhase: "active",
      pendingApproval: pending,
    });

    if (!this.deps.eventBelongsToActiveSession(ev)) {
      this.deps.markSessionWorking(ownerSid, true);
      const row = this.deps.getThreads().find((t) => t.sessionId === ownerSid);
      const title = row?.title?.trim() || ownerSid.slice(0, 8);
      this.deps.showToast(tr("plan.bgAwaiting", { title }), "info");
      return;
    }

    this.deps.endStreamBubble();
    this.deps.setTurnStatus(tr("plan.awaiting") || "等待计划审批…");
    this.deps.setPlanPhase("active");
    this.deps.setPendingApproval(pending);
    this.deps.syncPermLabels();
    await this.deps.openPlanPanel({
      requestId: pending.requestId,
      seedContent: content || null,
      forceReload: true,
      ownerSessionId: ownerSid,
    });
    if (this.deps.getActiveSessionId() !== ownerSid) return;
    this.deps.showToast(
      tr("plan.pleaseReview") || "请在右侧「计划」面板审阅并批准",
      "info",
    );
  }

  /** plan.mode.changed：按 session 写入投影；仅前台改 chip */
  handleModeChanged(ev: {
    sessionId?: string;
    threadId?: string;
    active: boolean;
    modeId?: string;
  }): void {
    const sid = (ev.sessionId || "").trim();
    if (sid) {
      if (ev.active) {
        const cur = getSessionPlan(sid);
        const keepPending =
          this.deps.eventBelongsToActiveSession(ev) &&
          this.deps.getPlanPhase() === "pending";
        const nextPhase: PlanPhase = keepPending
          ? "pending"
          : cur?.planPhase === "pending"
            ? "pending"
            : "active";
        patchSessionPlan(sid, { planPhase: nextPhase });
      } else {
        const cur = getSessionPlan(sid);
        patchSessionPlan(sid, {
          planPhase: cur?.pendingApproval ? "active" : "off",
        });
      }
    }

    if (!this.deps.eventBelongsToActiveSession(ev) && sid) {
      return;
    }

    if (ev.active) {
      if (this.deps.getPlanPhase() === "off") {
        this.deps.setPlanPhase("active");
      }
    } else if (this.deps.isPlanOn()) {
      if (!this.deps.isPlanApprovalArmed()) {
        this.deps.setPlanPhase("off");
      }
    }
    if (this.deps.getActiveSessionId()) {
      this.deps.snapshotActiveSessionPlan(this.deps.getActiveSessionId());
    }
    this.deps.syncPermLabels();
  }
}
