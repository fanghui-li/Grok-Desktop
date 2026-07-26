/**
 * 计划侧栏面板（整段自 main 迁出）。
 * - DOM / 脏检测 / 预览 / 保存 / 审批底栏在此
 * - planPhase / pendingApproval 真源仍由 main 经 deps 持有（与 chip / onEvent 耦合）
 * - per-session 投影读写 session-plan-store
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  getSessionPlan,
  patchSessionPlan,
  setSessionPlan,
  type PlanPhase,
  type SessionPlanPendingApproval,
} from "../session/plan-store.js";
import {
  extractPlanArtifactPath,
  planPanelStatusBits,
  preferPlanContent,
  resolvePlanRailActivity,
  shouldKeepPlanDraft,
} from "./artifact.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type PlanPanelUiDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  getActiveCwd: () => string | null;
  getSessionViewGen: () => number;
  getPlanPhase: () => PlanPhase;
  setPlanPhase: (phase: PlanPhase) => void;
  getPendingApproval: () => SessionPlanPendingApproval | null;
  setPendingApproval: (p: SessionPlanPendingApproval | null) => void;
  isPlanOn: () => boolean;
  syncPermLabels: () => void;
  syncSessionPolicyLive: (opts?: {
    plan?: boolean;
    alwaysApprove?: boolean;
  }) => Promise<{ ok: boolean; message?: string }>;
  paintAssistantHtml: (
    el: HTMLElement,
    md: string,
    opts: { highlight: boolean; cwd: string | null },
  ) => void;
  openPlanCategory: () => void;
  closePlanCategory: () => void;
  setPlanRailActivity: (
    activity: "pending" | "revising" | "soft" | "none",
  ) => void;
  hasSidePane: () => boolean;
  getTurnStatusText: () => string;
  setTurnStatus: (label: string) => void;
  removeTurnStatus: () => void;
  getTurnActive: () => boolean;
  markSessionWorking: (sessionId: string | null, working: boolean) => void;
  setComposerBusy: (busy: boolean) => void;
  appendLine: (text: string, kind: "system" | "assistant" | "user") => void;
  paintUserMessage: (text: string) => void;
  showWelcome: (show: boolean) => void;
};

export class PlanPanelUi {
  private savedContent = "";
  private path: string | null = null;
  private bound = false;
  private busy = false;
  private viewMode: "source" | "preview" = "source";
  /** 本 turn 内 agent 写入的类 plan 文档路径（非 session plan.md 时兜底） */
  private lastArtifactPath: string | null = null;

  constructor(private readonly deps: PlanPanelUiDeps) {}

  getLastArtifactPath(): string | null {
    return this.lastArtifactPath;
  }

  setLastArtifactPath(path: string | null): void {
    this.lastArtifactPath = path;
  }

  clearLastArtifactPath(): void {
    this.lastArtifactPath = null;
  }

  private editorEl(): HTMLTextAreaElement | null {
    return document.getElementById(
      "plan-panel-editor",
    ) as HTMLTextAreaElement | null;
  }

  private feedbackEl(): HTMLTextAreaElement | null {
    return document.getElementById(
      "plan-panel-feedback",
    ) as HTMLTextAreaElement | null;
  }

  private previewEl(): HTMLElement | null {
    return document.getElementById("plan-panel-preview");
  }

  dirty(): boolean {
    const ed = this.editorEl();
    if (!ed) return false;
    return ed.value !== this.savedContent;
  }

  /**
   * 方案 A：审批底栏仅在 exit_plan_mode reverse-RPC 挂起时可用。
   * 对齐 CLI PlanApprovalView（有 response_tx）；无 requestId 不显示 a/s/q。
   */
  isApprovalArmed(): boolean {
    return Boolean(this.deps.getPendingApproval()?.requestId?.trim());
  }

  /**
   * 阶段一：把前台 plan 状态写入 per-session 投影（切走前调用）。
   * 对齐 CLI：切焦点不 resolve exit_plan waiter。
   */
  snapshotActive(sessionId: string | null | undefined): void {
    const sid = sessionId?.trim();
    if (!sid) return;
    const pending = this.deps.getPendingApproval();
    setSessionPlan(sid, {
      planPhase: this.deps.getPlanPhase(),
      pendingApproval: pending
        ? {
            requestId: pending.requestId,
            sessionId: pending.sessionId || sid,
            planContent: pending.planContent ?? "",
          }
        : null,
    });
  }

  /**
   * 新建/切换会话时关闭计划侧栏，并清理前台 plan UI。
   * 默认 stash pending（不 abandoned）；硬离开且 abandonPending 时才 resolve waiter。
   */
  closeOnSessionChange(opts?: {
    stashSessionId?: string | null;
    abandonPending?: boolean;
  }): void {
    const abandon = opts?.abandonPending === true;
    const pending = this.deps.getPendingApproval();
    const stashSid =
      (
        opts?.stashSessionId ??
        pending?.sessionId ??
        this.deps.getActiveSessionId()
      )?.trim() || null;

    if (abandon && pending?.requestId) {
      void this.deps.inv("plans.respond", {
        requestId: pending.requestId,
        outcome: "abandoned",
        sessionId: pending.sessionId,
      });
      if (stashSid) {
        setSessionPlan(stashSid, {
          planPhase: "off",
          pendingApproval: null,
        });
      }
    } else if (stashSid) {
      this.snapshotActive(stashSid);
    }

    this.deps.setPendingApproval(null);
    this.deps.setPlanPhase("off");
    this.path = null;
    this.savedContent = "";
    this.busy = false;
    const ed = this.editorEl();
    if (ed) ed.value = "";
    const fb = this.feedbackEl();
    if (fb) fb.value = "";
    this.deps.closePlanCategory();
    this.syncChrome();
    this.syncRailActivity();
  }

  /**
   * 切回会话：从 per-session 投影恢复 planPhase / pending。
   * 有未决审批时打开计划侧栏（不抢其它会话焦点）。
   */
  async rehydrate(
    sessionId: string,
    opts?: { viewGen?: number },
  ): Promise<void> {
    const sid = sessionId?.trim();
    if (!sid) return;
    const viewGen = opts?.viewGen;
    const proj = getSessionPlan(sid);
    this.deps.setPlanPhase(proj?.planPhase ?? "off");
    let pending: SessionPlanPendingApproval | null = proj?.pendingApproval
      ? {
          requestId: proj.pendingApproval.requestId,
          sessionId: proj.pendingApproval.sessionId || sid,
          planContent: proj.pendingApproval.planContent ?? "",
        }
      : null;
    if (pending?.sessionId && pending.sessionId !== sid) {
      pending = null;
    }
    this.deps.setPendingApproval(pending);
    this.deps.syncPermLabels();
    this.syncChrome();

    if (!pending?.requestId) return;
    if (viewGen !== undefined && viewGen !== this.deps.getSessionViewGen())
      return;
    if (this.deps.getActiveSessionId() !== sid) return;

    await this.open({
      requestId: pending.requestId,
      seedContent: pending.planContent || null,
      forceReload: true,
      ownerSessionId: sid,
    });
    if (viewGen !== undefined && viewGen !== this.deps.getSessionViewGen())
      return;
    if (this.deps.getActiveSessionId() !== sid) return;
    this.deps.setTurnStatus(tr("plan.awaiting") || "等待计划审批…");
    this.deps.showToast(
      tr("plan.reopenedAwaiting") || tr("plan.awaiting"),
      "info",
    );
  }

  syncChrome(): void {
    const status = document.getElementById("plan-panel-status");
    const pathEl = document.getElementById("plan-panel-path");
    const empty = document.getElementById("plan-panel-empty");
    const ed = this.editorEl();
    const prev = this.previewEl();
    const modeBtn = document.getElementById("btn-plan-view-mode");
    const footer = document.querySelector(
      "#side-cat-plan .plan-panel-footer",
    ) as HTMLElement | null;
    const armed = this.isApprovalArmed();
    const planPhase = this.deps.getPlanPhase();
    if (pathEl) {
      pathEl.textContent = this.path ?? tr("plan.noPlanMd");
      pathEl.title = this.path ?? "";
    }
    if (status) {
      status.textContent = planPanelStatusBits({
        planOn: this.deps.isPlanOn(),
        planPhase,
        dirty: this.dirty(),
        armed,
        modeChipLabel: tr("plan.modeChip"),
        unsavedLabel: tr("plan.unsaved"),
        awaitingLabel: tr("plan.awaiting"),
      }).join(" · ");
    }
    if (modeBtn) {
      const isPreview = this.viewMode === "preview";
      modeBtn.textContent = isPreview
        ? tr("common.source")
        : tr("common.preview");
      modeBtn.title = tr("side.planToggleView");
      modeBtn.setAttribute("aria-pressed", isPreview ? "true" : "false");
    }
    if (footer) {
      footer.classList.toggle("hidden", !armed);
      footer.setAttribute("aria-hidden", armed ? "false" : "true");
    }
    const text = ed?.value ?? "";
    const hasBody = Boolean(text.trim()) || this.dirty();
    empty?.classList.toggle("hidden", hasBody);
    const showSource = this.viewMode === "source";
    ed?.classList.toggle("hidden", !showSource || !hasBody);
    prev?.classList.toggle("hidden", showSource || !hasBody);
    if (ed) ed.readOnly = !showSource;
    this.syncRailActivity();
  }

  /** 右侧轨「计划」活动点：待批准 > 修订中 > 计划模式/有内容 */
  syncRailActivity(): void {
    if (!this.deps.hasSidePane()) return;
    const ed = this.editorEl();
    const hasBody = Boolean((ed?.value ?? "").trim() || this.path);
    const activity = resolvePlanRailActivity({
      approvalArmed: this.isApprovalArmed(),
      planOn: this.deps.isPlanOn(),
      hasBody,
      turnStatusText: this.deps.getTurnStatusText(),
      revisingLabel: tr("plan.revising"),
    });
    this.deps.setPlanRailActivity(activity);
  }

  private renderPreview(): void {
    const ed = this.editorEl();
    const prev = this.previewEl();
    if (!prev || !ed) return;
    const raw = ed.value;
    if (!raw.trim()) {
      prev.innerHTML = "";
      return;
    }
    try {
      this.deps.paintAssistantHtml(prev, raw, {
        highlight: true,
        cwd: this.deps.getActiveCwd(),
      });
    } catch {
      prev.textContent = raw;
    }
  }

  setViewMode(mode: "source" | "preview"): void {
    if (mode === this.viewMode) {
      this.syncChrome();
      return;
    }
    this.viewMode = mode;
    if (mode === "preview") this.renderPreview();
    this.syncChrome();
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;
    const ed = this.editorEl();
    ed?.addEventListener("input", () => this.syncChrome());
    document.getElementById("btn-plan-reload")?.addEventListener("click", () => {
      void this.open({
        requestId: this.deps.getPendingApproval()?.requestId ?? null,
        forceReload: true,
      });
    });
    document.getElementById("btn-plan-save")?.addEventListener("click", () => {
      void this.save().then((ok) => {
        if (ok) this.deps.showToast(tr("plan.saved"));
      });
    });
    document
      .getElementById("btn-plan-view-mode")
      ?.addEventListener("click", () => {
        this.setViewMode(this.viewMode === "source" ? "preview" : "source");
      });
    document
      .getElementById("btn-plan-approve")
      ?.addEventListener("click", () => {
        void this.respond("approved");
      });
    document.getElementById("btn-plan-revise")?.addEventListener("click", () => {
      void this.respond("cancelled");
    });
    document
      .getElementById("btn-plan-abandon")
      ?.addEventListener("click", () => {
        void this.respond("abandoned");
      });
    ed?.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save().then((ok) => {
          if (ok) this.deps.showToast(tr("plan.saved"));
        });
      }
    });
  }

  /**
   * 打开右栏「计划」面板并加载 session plan.md。
   * 真源优先 session；空则镜像工作区 *plan* 产物。
   */
  async open(opts?: {
    requestId?: string | null;
    forceReload?: boolean;
    seedContent?: string | null;
    ownerSessionId?: string | null;
  }): Promise<void> {
    this.bind();
    const activeSid = this.deps.getActiveSessionId();
    if (!activeSid) {
      this.deps.showToast(tr("plan.noSession"), "error");
      return;
    }
    const ownerSid =
      (opts?.ownerSessionId ?? activeSid)?.trim() || activeSid;
    if (ownerSid !== activeSid) {
      patchSessionPlan(ownerSid, {
        planPhase: "active",
        pendingApproval: opts?.requestId
          ? {
              requestId: opts.requestId,
              sessionId: ownerSid,
              planContent: opts.seedContent ?? "",
            }
          : (getSessionPlan(ownerSid)?.pendingApproval ?? null),
      });
      return;
    }
    if (opts?.requestId) {
      const pending: SessionPlanPendingApproval = {
        requestId: opts.requestId,
        sessionId: ownerSid,
        planContent: opts.seedContent ?? "",
      };
      this.deps.setPendingApproval(pending);
      const phase = this.deps.getPlanPhase();
      patchSessionPlan(ownerSid, {
        planPhase: phase === "off" ? "active" : phase,
        pendingApproval: pending,
      });
    }

    this.deps.openPlanCategory();

    const res = await this.deps.inv<{
      sessionId: string;
      status: string;
      content: string;
      path?: string | null;
    } | null>("plans.get", { sessionId: ownerSid });

    let content = preferPlanContent(
      (res.ok ? res.data?.content : "") ?? "",
      opts?.seedContent,
    );
    let path = (res.ok ? res.data?.path : null) ?? null;

    if (!content.trim() && this.lastArtifactPath) {
      const fileRes = await this.deps.inv<{
        content?: string;
        binary?: boolean;
        isDirectory?: boolean;
        absPath?: string;
      }>("files.read", {
        path: this.lastArtifactPath,
        cwd: this.deps.getActiveCwd() ?? undefined,
        maxBytes: 512_000,
      });
      const body =
        fileRes.ok && !fileRes.data?.binary && !fileRes.data?.isDirectory
          ? (fileRes.data?.content ?? "")
          : "";
      if (body.trim()) {
        content = body;
        await this.deps.inv("plans.write", {
          sessionId: ownerSid,
          content: body,
        });
        const again = await this.deps.inv<{ path?: string | null } | null>(
          "plans.get",
          { sessionId: ownerSid },
        );
        path = again.ok ? (again.data?.path ?? path) : path;
      }
    }

    if (this.deps.getActiveSessionId() !== ownerSid) {
      if (opts?.requestId) {
        patchSessionPlan(ownerSid, {
          planPhase: "active",
          pendingApproval: {
            requestId: opts.requestId,
            sessionId: ownerSid,
            planContent: content || opts.seedContent || "",
          },
        });
      }
      return;
    }

    const ed = this.editorEl();
    if (ed) {
      if (
        shouldKeepPlanDraft({
          forceReload: opts?.forceReload,
          dirty: this.dirty(),
          editorHasText: Boolean(ed.value.trim()),
        })
      ) {
        /* keep draft */
      } else {
        ed.value = content;
        this.savedContent = content;
      }
    }
    this.path = path;
    if (this.viewMode === "preview") this.renderPreview();
    this.syncChrome();
    const sid = this.deps.getActiveSessionId();
    if (sid) this.snapshotActive(sid);
  }

  async save(): Promise<boolean> {
    const activeSid = this.deps.getActiveSessionId();
    if (!activeSid) {
      this.deps.showToast(tr("plan.noSession"), "error");
      return false;
    }
    const ed = this.editorEl();
    if (!ed) return false;
    const content = ed.value;
    const r = await this.deps.inv<{ path?: string }>("plans.write", {
      sessionId: activeSid,
      content,
    });
    if (!r.ok) {
      this.deps.showToast(
        r.error?.message ?? tr("plan.saveFailed"),
        "error",
      );
      return false;
    }
    this.savedContent = content;
    if (r.data?.path) this.path = r.data.path;
    this.syncChrome();
    return true;
  }

  private setBusy(busy: boolean, approveLabel?: string): void {
    this.busy = busy;
    for (const id of [
      "btn-plan-approve",
      "btn-plan-revise",
      "btn-plan-abandon",
      "btn-plan-save",
      "btn-plan-reload",
      "btn-plan-view-mode",
    ]) {
      const b = document.getElementById(id) as HTMLButtonElement | null;
      if (b) b.disabled = busy;
    }
    const ap = document.getElementById("btn-plan-approve");
    if (ap) {
      ap.textContent =
        busy && approveLabel ? approveLabel : tr("plan.approveBtn");
    }
  }

  /**
   * 计划面板底栏：批准 / 要求修改 / 放弃
   * 方案 A：仅 exit_plan 挂起（有 requestId）时可点。
   */
  async respond(
    outcome: "approved" | "cancelled" | "abandoned",
  ): Promise<void> {
    if (this.busy) return;
    const activeSid = this.deps.getActiveSessionId();
    if (!activeSid) {
      this.deps.showToast(tr("plan.noSession"), "error");
      return;
    }
    const pending = this.deps.getPendingApproval();
    const requestId = pending?.requestId?.trim() || null;
    const ownerSid = (pending?.sessionId || activeSid)?.trim() || null;
    if (!requestId || !ownerSid) {
      this.deps.showToast(tr("plan.approvalRequired"), "info");
      this.syncChrome();
      return;
    }
    if (ownerSid !== activeSid) {
      this.deps.showToast(tr("plan.approvalRequired"), "info");
      this.syncChrome();
      return;
    }
    this.setBusy(
      true,
      outcome === "approved"
        ? tr("plan.approving")
        : outcome === "cancelled"
          ? tr("plan.sending")
          : tr("plan.processing"),
    );
    const feedback = (this.feedbackEl()?.value ?? "").trim();

    try {
      if (outcome === "approved" || outcome === "cancelled") {
        if (this.dirty() || (this.editorEl()?.value ?? "").trim()) {
          const ok = await this.save();
          if (!ok && outcome === "approved") {
            this.setBusy(false);
            return;
          }
        }
      }

      const r = await this.deps.inv("plans.respond", {
        requestId,
        outcome,
        feedback:
          outcome === "cancelled" || outcome === "approved"
            ? feedback || undefined
            : undefined,
        sessionId: ownerSid,
      });
      if (!r.ok) {
        this.deps.showToast(
          r.error?.message ?? tr("plan.respondFail"),
          "error",
        );
        this.setBusy(false);
        return;
      }

      this.deps.setPendingApproval(null);
      if (this.feedbackEl()) this.feedbackEl()!.value = "";

      this.clearApprovalWaitingUi(
        outcome === "abandoned" ? tr("plan.abandoned") : tr("turn.thinking"),
      );

      if (outcome === "approved") {
        this.deps.setPlanPhase("off");
        patchSessionPlan(ownerSid, {
          planPhase: "off",
          pendingApproval: null,
        });
        this.deps.syncPermLabels();
        await this.deps.syncSessionPolicyLive({ plan: false });
        this.setBusy(false);
        this.deps.closePlanCategory();
        this.syncChrome();
        this.deps.showToast(tr("plan.approvedToast"));
        this.deps.appendLine(tr("plan.approvedLine"), "system");
      } else if (outcome === "abandoned") {
        this.deps.setPlanPhase("off");
        patchSessionPlan(ownerSid, {
          planPhase: "off",
          pendingApproval: null,
        });
        this.deps.syncPermLabels();
        await this.deps.syncSessionPolicyLive({ plan: false });
        this.setBusy(false);
        this.deps.closePlanCategory();
        this.syncChrome();
        this.deps.showToast(tr("plan.abandonToast"));
        this.deps.appendLine(tr("plan.abandonLine"), "system");
      } else {
        this.deps.setPlanPhase("active");
        patchSessionPlan(ownerSid, {
          planPhase: "active",
          pendingApproval: null,
        });
        this.deps.syncPermLabels();
        this.setBusy(false);
        const reviseDisplay = feedback
          ? `${tr("plan.reviseUser")}\n${feedback}`
          : tr("plan.reviseUser");
        this.deps.showWelcome(false);
        this.deps.openPlanCategory();
        this.syncChrome();
        this.deps.paintUserMessage(reviseDisplay);
        this.deps.showToast(
          feedback ? tr("plan.reviseToastFb") : tr("plan.reviseToast"),
        );
        this.deps.setTurnStatus(tr("plan.revising"));
        this.syncRailActivity();
      }
    } catch (err) {
      this.deps.showToast(
        err instanceof Error ? err.message : tr("plan.opFail"),
        "error",
      );
      this.setBusy(false);
    }
  }

  /** 审批结束后清掉「等待计划审批」状态条 */
  clearApprovalWaitingUi(nextLabel?: string): void {
    if (this.deps.getTurnActive()) {
      if (nextLabel) this.deps.setTurnStatus(nextLabel);
      else this.deps.removeTurnStatus();
    } else {
      this.deps.removeTurnStatus();
    }
    const sid = this.deps.getActiveSessionId();
    if (sid) this.deps.markSessionWorking(sid, true);
    this.deps.setComposerBusy(this.deps.getTurnActive());
  }

  /** 从 write 类 tool raw 识别计划文档路径 */
  noteArtifactFromTool(name: string | undefined, raw: unknown): void {
    const p = extractPlanArtifactPath(name, raw);
    if (p) this.lastArtifactPath = p;
  }

  /**
   * 计划模式回合结束：有正文则自动打开侧栏；否则 toast 引导。
   */
  async maybeSurfaceAfterTurn(): Promise<void> {
    if (!this.deps.isPlanOn()) return;
    const activeSid = this.deps.getActiveSessionId();
    if (!activeSid) return;
    if (this.deps.getPendingApproval()) return;

    const res = await this.deps.inv<{ content?: string } | null>("plans.get", {
      sessionId: activeSid,
    });
    let content = (res.ok ? res.data?.content : "")?.trim() ?? "";
    if (!content && this.lastArtifactPath) {
      const fileRes = await this.deps.inv<{
        content?: string;
        binary?: boolean;
        isDirectory?: boolean;
      }>("files.read", {
        path: this.lastArtifactPath,
        cwd: this.deps.getActiveCwd() ?? undefined,
        maxBytes: 512_000,
      });
      const body =
        fileRes.ok && !fileRes.data?.binary && !fileRes.data?.isDirectory
          ? (fileRes.data?.content ?? "").trim()
          : "";
      if (body) {
        content = body;
        await this.deps.inv("plans.write", {
          sessionId: activeSid,
          content: body,
        });
      }
    }
    if (content) {
      await this.open({ forceReload: false });
      this.deps.showToast(tr("chat.planReady"), "info");
    } else if (this.lastArtifactPath) {
      this.deps.showToast(
        tr("chat.planArtifact", {
          name:
            this.lastArtifactPath.split(/[/\\]/).pop() ?? this.lastArtifactPath,
        }),
        "info",
      );
    } else {
      this.deps.showToast(tr("plan.waitingContent"), "info");
    }
  }
}
