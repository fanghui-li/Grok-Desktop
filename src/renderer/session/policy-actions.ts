/**
 * 会话访问策略 + plan 模式切换（自 main 迁出）。
 * planPhase / pendingApproval 真源仍在 main，经 deps 读写。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import type { PlanPhase } from "./plan-store.js";
import type { SessionModeChipFocus } from "./mode-chips.js";
import {
  computeSessionModeChipsVisibility,
  paintSessionModeChips,
} from "./mode-chips.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type SessionPolicyDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getAccessMode: () => "normal" | "always_approve";
  setAccessMode: (mode: "normal" | "always_approve") => void;
  isPlanOn: () => boolean;
  getPlanPhase: () => PlanPhase;
  setPlanPhase: (phase: PlanPhase) => void;
  getPendingApproval: () => { requestId?: string } | null;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  getActiveCwd: () => string | null;
  setActiveCwd: (cwd: string | null) => void;
  findThreadCwdBySession: (sessionId: string) => string | undefined;
  ensureLiveThread: () => Promise<string | null>;
  patchSessionPlan: (
    sessionId: string,
    patch: {
      planPhase?: PlanPhase;
      pendingApproval?: unknown;
    },
  ) => void;
  getSessionModeChipFocus: () => SessionModeChipFocus;
  setSessionModeChipFocusOnly: (focus: SessionModeChipFocus) => void;
  currentGoalTitle: () => string | null;
  getGoalComposeActive: () => boolean;
  setGoalComposeActive: (v: boolean) => void;
  goalCompleted: () => boolean;
  syncPermLabelsOnly: () => void;
  openPlanPanel: (opts?: {
    requestId?: string | null;
    forceReload?: boolean;
  }) => void | Promise<void>;
  syncPlanPanelChrome: () => void;
  setComposerPlaceholders: (goalMode: boolean) => void;
  beginGoalCompose: (
    prefill?: string,
    opts?: { toastKey?: "goal.composeArmed" | "slash.goalDesc" | null },
  ) => void;
  runGoalCommand: (
    sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
  ) => Promise<{ ok: boolean; message?: string }>;
  activeComposerInput: () => HTMLTextAreaElement | null;
};

export class SessionPolicyActions {
  constructor(private readonly deps: SessionPolicyDeps) {}

  /**
   * 同步访问权限 + plan 到 agent（两维正交）。
   * 旧会话是 disk_*，必须先 attach 成 live thread。
   */
  async syncLive(opts?: {
    plan?: boolean;
    alwaysApprove?: boolean;
  }): Promise<{ ok: boolean; message?: string }> {
    const plan = opts?.plan ?? this.deps.isPlanOn();
    const alwaysApprove =
      opts?.alwaysApprove ?? this.deps.getAccessMode() === "always_approve";
    if (
      !this.deps.getActiveSessionId() &&
      !this.deps.getActiveThreadId()
    ) {
      return { ok: true };
    }
    if (!this.deps.getActiveCwd() && this.deps.getActiveSessionId()) {
      const cwd = this.deps.findThreadCwdBySession(
        this.deps.getActiveSessionId()!,
      );
      if (cwd) this.deps.setActiveCwd(cwd);
    }
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      return {
        ok: false,
        message: tr("mode.attachFail"),
      };
    }
    const r = await this.deps.inv("threads.setMode", {
      threadId,
      plan,
      alwaysApprove,
    });
    if (!r.ok) {
      return {
        ok: false,
        message: r.error?.message ?? tr("mode.syncFail"),
      };
    }
    return { ok: true };
  }

  /** @deprecated 兼容旧调用名 → 两维 sync */
  async setThreadModeLive(
    mode: "plan" | "normal" | "always_approve",
  ): Promise<{ ok: boolean; message?: string }> {
    if (mode === "plan") {
      return this.syncLive({ plan: true });
    }
    if (mode === "always_approve") {
      return this.syncLive({
        plan: this.deps.isPlanOn(),
        alwaysApprove: true,
      });
    }
    return this.syncLive({ plan: false, alwaysApprove: false });
  }

  exitPlanMode(): void {
    if (!this.deps.isPlanOn()) return;
    this.deps.setPlanPhase("off");
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      this.deps.patchSessionPlan(sid, {
        planPhase: "off",
        pendingApproval: this.deps.getPendingApproval(),
      });
    }
    if (this.deps.getSessionModeChipFocus() === "plan") {
      this.deps.setSessionModeChipFocusOnly(
        Boolean(this.deps.currentGoalTitle()) ||
          this.deps.getGoalComposeActive()
          ? "goal"
          : null,
      );
    }
    this.deps.syncPermLabelsOnly();
    this.syncChips();
    void this.syncLive({ plan: false }).then((r) => {
      if (!r.ok) {
        this.deps.showToast(r.message ?? tr("plan.exitSyncFail"), "error");
      }
    });
    this.deps.showToast(tr("plan.exited"));
  }

  async enterPlanMode(): Promise<{ ok: boolean; message?: string }> {
    this.deps.setPlanPhase("pending");
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      this.deps.patchSessionPlan(sid, { planPhase: "pending" });
    }
    this.deps.setSessionModeChipFocusOnly("plan");
    this.deps.syncPermLabelsOnly();
    this.syncChips();
    if (this.deps.getActiveSessionId() || this.deps.getActiveThreadId()) {
      const r = await this.syncLive({ plan: true });
      if (!r.ok) {
        this.deps.setPlanPhase("off");
        if (sid) {
          this.deps.patchSessionPlan(sid, { planPhase: "off" });
        }
        this.deps.setSessionModeChipFocusOnly(
          Boolean(this.deps.currentGoalTitle()) ||
            this.deps.getGoalComposeActive()
            ? "goal"
            : null,
        );
        this.deps.syncPermLabelsOnly();
        this.syncChips();
        return {
          ok: false,
          message: r.message ?? tr("plan.markedSyncFail"),
        };
      }
      if (this.deps.getActiveSessionId()) {
        void this.deps.openPlanPanel({ forceReload: true });
      }
    }
    return {
      ok: true,
      message:
        this.deps.getActiveSessionId() || this.deps.getActiveThreadId()
          ? tr("plan.openedPending")
          : tr("plan.openedNew"),
    };
  }

  async showViewPlan(): Promise<{ ok: boolean; message?: string }> {
    if (!this.deps.getActiveSessionId()) {
      return { ok: false, message: tr("plan.noSession") };
    }
    await this.deps.openPlanPanel({
      requestId: this.deps.getPendingApproval()?.requestId ?? null,
    });
    return { ok: true };
  }

  setChipFocus(focus: SessionModeChipFocus): void {
    this.deps.setSessionModeChipFocusOnly(focus);
    this.syncChips();
  }

  syncChips(): void {
    const planOn = this.deps.isPlanOn();
    const goalTitle = this.deps.currentGoalTitle();
    const vis = computeSessionModeChipsVisibility({
      focus: this.deps.getSessionModeChipFocus(),
      planOn,
      goalTitle,
      goalComposeActive: this.deps.getGoalComposeActive(),
      goalCompleted: this.deps.goalCompleted(),
    });
    this.deps.setSessionModeChipFocusOnly(vis.focus);
    paintSessionModeChips({
      showPlan: vis.showPlan,
      showGoal: vis.showGoal,
      planOn,
      goalTitle,
      goalComposeActive: this.deps.getGoalComposeActive(),
      goalCompleted: this.deps.goalCompleted(),
      onAfterPlanChips: () => this.deps.syncPlanPanelChrome(),
    });
  }

  bindModeChips(): void {
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const close = t.closest("[data-chip-close]") as HTMLElement | null;
      if (close) {
        e.preventDefault();
        e.stopPropagation();
        const kind = close.dataset.chipClose;
        if (kind === "plan") this.exitPlanMode();
        if (kind === "goal") {
          if (
            this.deps.getGoalComposeActive() &&
            !this.deps.currentGoalTitle()
          ) {
            this.deps.setGoalComposeActive(false);
            this.deps.setComposerPlaceholders(false);
            this.syncChips();
            this.deps.showToast(tr("chat.goalCancelled"));
          } else {
            void this.deps.runGoalCommand("clear").then((r) => {
              if (r.message) {
                this.deps.showToast(r.message, r.ok ? "info" : "error");
              }
            });
          }
        }
        return;
      }
      const planChip = t.closest("#chip-plan, #chip-plan-2");
      if (planChip && !t.closest("[data-chip-close]")) {
        void this.showViewPlan().then((r) => {
          if (!r.ok && r.message) this.deps.showToast(r.message, "error");
        });
        return;
      }
      const goalChip = t.closest("#chip-goal, #chip-goal-2");
      if (goalChip && !t.closest("[data-chip-close]")) {
        this.onGoalChipClick();
      }
    });
  }

  /**
   * Shift+Tab：循环主展示模式（对齐 Grok Build CLI）
   * Normal → Plan → Always-approve → Normal
   */
  async cycleSessionMode(): Promise<void> {
    if (!this.deps.isPlanOn() && this.deps.getAccessMode() === "normal") {
      const r = await this.enterPlanMode();
      if (r.message) {
        this.deps.showToast(r.message, r.ok ? "info" : "error");
      }
      return;
    }
    if (this.deps.isPlanOn()) {
      this.deps.setPlanPhase("off");
      const sid = this.deps.getActiveSessionId();
      if (sid) {
        this.deps.patchSessionPlan(sid, {
          planPhase: "off",
          pendingApproval: this.deps.getPendingApproval(),
        });
      }
      this.deps.setAccessMode("always_approve");
      if (this.deps.getSessionModeChipFocus() === "plan") {
        this.deps.setSessionModeChipFocusOnly(
          Boolean(this.deps.currentGoalTitle()) ||
            this.deps.getGoalComposeActive()
            ? "goal"
            : null,
        );
      }
      this.deps.syncPermLabelsOnly();
      this.syncChips();
      const r = await this.syncLive({ plan: false, alwaysApprove: true });
      if (!r.ok) {
        this.deps.showToast(r.message ?? "切换完全访问失败", "error");
        return;
      }
      this.deps.showToast("已开启完全访问");
      return;
    }
    this.deps.setAccessMode("normal");
    this.deps.setPlanPhase("off");
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      this.deps.patchSessionPlan(sid, { planPhase: "off" });
    }
    if (this.deps.getSessionModeChipFocus() === "plan") {
      this.deps.setSessionModeChipFocusOnly(
        Boolean(this.deps.currentGoalTitle()) ||
          this.deps.getGoalComposeActive()
          ? "goal"
          : null,
      );
    }
    this.deps.syncPermLabelsOnly();
    this.syncChips();
    void this.syncLive({ plan: false, alwaysApprove: false });
    this.deps.showToast("已恢复默认确认");
  }

  /**
   * 目标 chip 点击（对齐 Codex：进 goal 模式时保留输入框正文）。
   */
  onGoalChipClick(): void {
    const ta = this.deps.activeComposerInput();
    const draft = (ta?.value ?? "").trim();

    if (this.deps.getGoalComposeActive()) {
      ta?.focus();
      if (!draft) this.deps.showToast(tr("slash.goalDesc"));
      else this.deps.showToast(tr("goal.composeArmed"));
      return;
    }

    if (draft) {
      this.deps.beginGoalCompose(undefined, {
        toastKey: "goal.composeArmed",
      });
      return;
    }

    if (this.deps.currentGoalTitle()) {
      void this.deps.runGoalCommand("status").then((r) => {
        if (r.message) {
          this.deps.showToast(r.message, r.ok ? "info" : "error");
        }
      });
      return;
    }

    this.deps.beginGoalCompose();
  }
}
