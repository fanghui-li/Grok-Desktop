/**
 * Goal 运行时：投影归约、pause/resume、compose、发送拼装（自 main 迁出）。
 * slash 子命令仍在 GoalSlashActions；banner DOM 在 GoalBannerUi。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  reduceAgentGoalEvent,
  type AgentGoalEvent,
} from "./apply.js";
import {
  agentContentForSend as agentContentForSendPure,
  parseGoalBudget,
  parseGoalInput,
} from "./input.js";
import type { GoalUiProjection } from "./banner-ui.js";
import type { SessionModeChipFocus } from "../session/mode-chips.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type GoalRuntimeDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  confirmText: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  ensureLiveThread: () => Promise<string | null>;
  isPlanOn: () => boolean;
  getProjection: () => GoalUiProjection | null;
  setProjection: (p: GoalUiProjection | null) => void;
  getPendingTitle: () => string | null;
  setPendingTitle: (t: string | null) => void;
  getComposeActive: () => boolean;
  setComposeActive: (v: boolean) => void;
  getTokenBudget: () => number | null;
  setTokenBudget: (n: number | null) => void;
  getElapsedAnchorAt: () => number | null;
  setElapsedAnchorAt: (n: number | null) => void;
  getLocalClearedIds: () => Set<string>;
  getCompleteHideTimer: () => ReturnType<typeof setTimeout> | null;
  setCompleteHideTimer: (t: ReturnType<typeof setTimeout> | null) => void;
  getSessionModeChipFocus: () => SessionModeChipFocus;
  setSessionModeChipFocus: (f: SessionModeChipFocus) => void;
  setComposerPlaceholders: (goalMode: boolean) => void;
  syncSessionModeChips: () => void;
  renderBanner: () => void;
  stopSyncTimer: () => void;
  stopElapsedTimer: () => void;
  elapsedMsNow: () => number;
  currentTitle: () => string | null;
  paused: () => boolean;
  completed: () => boolean;
  refreshTurnPhaseActivityLabel: () => void;
  scheduleReconcileTurnAfterGoalStopped: () => void;
  activeComposerInput: () => HTMLTextAreaElement | null;
  promptEditGoal: () => void | Promise<void>;
  runGoalCommand: (
    sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
  ) => Promise<{ ok: boolean; message?: string }>;
};

export class GoalRuntimeActions {
  constructor(private readonly deps: GoalRuntimeDeps) {}

  beginCompose(
    prefill?: string,
    opts?: { toastKey?: "slash.goalDesc" | "goal.composeArmed" | null },
  ): void {
    this.deps.setComposeActive(true);
    this.deps.setSessionModeChipFocus("goal");
    this.deps.setComposerPlaceholders(true);
    this.deps.syncSessionModeChips();
    const ta = this.deps.activeComposerInput();
    if (!ta) return;
    if (prefill != null) ta.value = prefill;
    requestAnimationFrame(() => {
      ta.focus();
      const n = ta.value.length;
      ta.setSelectionRange(n, n);
    });
    const toastKey =
      opts?.toastKey === null ? null : (opts?.toastKey ?? "slash.goalDesc");
    if (toastKey) this.deps.showToast(tr(toastKey));
  }

  resetUiState(): void {
    this.deps.setPendingTitle(null);
    this.deps.setProjection(null);
    this.deps.setElapsedAnchorAt(null);
    this.deps.setComposeActive(false);
    if (this.deps.getSessionModeChipFocus() === "goal") {
      this.deps.setSessionModeChipFocus(
        this.deps.isPlanOn() ? "plan" : null,
      );
    }
    const hide = this.deps.getCompleteHideTimer();
    if (hide) {
      clearTimeout(hide);
      this.deps.setCompleteHideTimer(null);
    }
    this.deps.stopSyncTimer();
    this.deps.stopElapsedTimer();
    this.deps.setComposerPlaceholders(false);
  }

  async sendAgentSlash(slashLine: string): Promise<boolean> {
    const line = slashLine.trim();
    if (!line.startsWith("/goal")) return false;
    try {
      const threadId = await this.deps.ensureLiveThread();
      if (!threadId) return false;
      const res = await this.deps.inv("turns.prompt", {
        threadId,
        content: line,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  applyAgentEvent(ev: AgentGoalEvent): void {
    const outcome = reduceAgentGoalEvent(
      {
        activeSessionId: this.deps.getActiveSessionId(),
        projection: this.deps.getProjection(),
        pendingTitle: this.deps.getPendingTitle(),
        localClearedIds: this.deps.getLocalClearedIds(),
        goalTokenBudget: this.deps.getTokenBudget(),
        elapsedAnchorAt: this.deps.getElapsedAnchorAt(),
        now: Date.now(),
      },
      ev,
    );
    if (outcome.type === "noop") return;
    if (outcome.type === "cleared") {
      for (const id of outcome.addClearedIds) {
        this.deps.getLocalClearedIds().add(id);
      }
      this.resetUiState();
      this.deps.renderBanner();
      this.deps.refreshTurnPhaseActivityLabel();
      const sid = this.deps.getActiveSessionId();
      if (outcome.hostClear && sid) {
        void this.deps.inv("goals.clear", { sessionId: sid });
      }
      if (outcome.toast) {
        this.deps.showToast(outcome.toast.text, outcome.toast.kind);
      }
      return;
    }
    if (outcome.removeClearedId) {
      this.deps.getLocalClearedIds().delete(outcome.removeClearedId);
    }
    this.deps.setProjection(outcome.projection);
    if (outcome.clearPending) this.deps.setPendingTitle(null);
    if (outcome.clearCompose) {
      this.deps.setComposeActive(false);
      this.deps.setComposerPlaceholders(false);
    }
    if (outcome.setTokenBudget !== undefined && outcome.setTokenBudget != null) {
      this.deps.setTokenBudget(outcome.setTokenBudget);
    }
    this.deps.setElapsedAnchorAt(outcome.elapsedAnchorAt);
    if (outcome.clearCompleteHideTimer) {
      const hide = this.deps.getCompleteHideTimer();
      if (hide) {
        clearTimeout(hide);
        this.deps.setCompleteHideTimer(null);
      }
    }
    if (outcome.markComplete) {
      this.markCompletedUi(outcome.markComplete.objective, {
        toast: outcome.markComplete.toast,
      });
    }
    if (outcome.toast) {
      this.deps.showToast(outcome.toast.text, outcome.toast.kind);
    }
    if (outcome.renderBanner) this.deps.renderBanner();
    if (outcome.refreshTurnPhase) this.deps.refreshTurnPhaseActivityLabel();
    if (outcome.reconcileAfterStop) {
      this.deps.scheduleReconcileTurnAfterGoalStopped();
    }
  }

  markCompletedUi(message: string, opts?: { toast?: boolean }): void {
    const hide = this.deps.getCompleteHideTimer();
    if (hide) {
      clearTimeout(hide);
      this.deps.setCompleteHideTimer(null);
    }
    const cur = this.deps.getProjection();
    if (!cur) {
      this.deps.setProjection({
        goalId: "complete",
        objective: message || tr("composer.goal"),
        status: "complete",
        phase: "idle",
        tokenBudget: this.deps.getTokenBudget(),
        tokensUsed: 0,
        elapsedMs: 0,
        elapsedFloorMs: 0,
        verifyingCompletion: false,
        planning: false,
      });
    } else {
      this.deps.setProjection({
        ...cur,
        status: "complete",
        objective:
          cur.objective?.trim() || message || tr("composer.goal"),
      });
    }
    this.deps.setElapsedAnchorAt(null);
    this.deps.setComposeActive(false);
    this.deps.stopSyncTimer();
    this.deps.setComposerPlaceholders(false);
    this.deps.setSessionModeChipFocus("goal");
    this.deps.renderBanner();
    if (opts?.toast) this.deps.showToast(tr("goal.completedToast"));
  }

  async pause(opts?: { fromStop?: boolean }): Promise<void> {
    if (
      !this.deps.currentTitle() ||
      this.deps.paused() ||
      this.deps.completed()
    ) {
      return;
    }
    const proj = this.deps.getProjection();
    if (proj) {
      const elapsed = this.deps.elapsedMsNow();
      this.deps.setProjection({
        ...proj,
        status: "user_paused",
        elapsedMs: elapsed,
        elapsedFloorMs: Math.max(proj.elapsedFloorMs, elapsed),
      });
    }
    this.deps.setElapsedAnchorAt(null);
    this.deps.renderBanner();
    this.deps.showToast(
      opts?.fromStop ? tr("goal.pausedStop") : tr("goal.pausedToast"),
    );
    const tid = this.deps.getActiveThreadId();
    if (tid && !tid.startsWith("disk_")) {
      const ok = await this.sendAgentSlash("/goal pause");
      if (!ok) this.deps.showToast(tr("goal.pauseFail"), "error");
    } else {
      void this.sendAgentSlash("/goal pause");
    }
  }

  async resume(): Promise<void> {
    if (!this.deps.currentTitle() || !this.deps.paused()) return;
    const proj = this.deps.getProjection();
    if (proj) {
      this.deps.setProjection({ ...proj, status: "active" });
    }
    this.deps.setElapsedAnchorAt(Date.now());
    this.deps.renderBanner();
    this.deps.showToast(tr("goal.resumedToast"));
    const ok = await this.sendAgentSlash("/goal resume");
    if (!ok) this.deps.showToast(tr("goal.resumeFail"), "error");
  }

  bindBannerClicks(): void {
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        "[data-goal-act]",
      ) as HTMLElement | null;
      if (!btn) return;
      const act = btn.dataset.goalAct;
      if (act === "edit") void this.deps.promptEditGoal();
      if (act === "pause") void this.pause();
      if (act === "resume") void this.resume();
      if (act === "clear") {
        void this.deps.runGoalCommand("clear").then((r) => {
          if (r.message) {
            this.deps.showToast(r.message, r.ok ? "info" : "error");
          }
        });
      }
    });
  }

  async confirmReplaceIfNeeded(newTitle: string): Promise<boolean> {
    const prev = this.deps.getProjection()?.objective?.trim();
    const next = newTitle.trim();
    if (!prev || !next || prev === next) return true;
    return this.deps.confirmText({
      title: tr("goal.replaceTitle"),
      message: tr("goal.replaceBody", { prev, next }),
      okLabel: tr("goal.replaceConfirm"),
    });
  }

  composerNeedsReplaceConfirm(raw?: string): boolean {
    const text =
      (raw ?? this.deps.activeComposerInput()?.value ?? "").trim();
    if (!text) return false;
    const g = parseGoalInput(text, {
      forceGoal: this.deps.getComposeActive(),
    });
    if (!g.goalTitle) return false;
    const prev = this.deps.getProjection()?.objective?.trim();
    const next = g.goalTitle.trim();
    return Boolean(prev && next && prev !== next);
  }

  async applyTitle(
    title: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const parsed = parseGoalBudget(title.trim());
    const t = parsed.objective;
    if (parsed.budget != null) this.deps.setTokenBudget(parsed.budget);
    if (!t) return { ok: false, message: tr("goal.emptyTitle") };
    this.deps.setComposeActive(false);
    this.deps.setComposerPlaceholders(false);
    this.deps.setPendingTitle(t);
    this.deps.setSessionModeChipFocus("goal");
    const hide = this.deps.getCompleteHideTimer();
    if (hide) {
      clearTimeout(hide);
      this.deps.setCompleteHideTimer(null);
    }
    this.deps.renderBanner();
    return { ok: true };
  }

  agentContentForSend(
    userContent: string,
    goalJustSet: string | null,
  ): string {
    return agentContentForSendPure(
      userContent,
      goalJustSet,
      this.deps.getTokenBudget(),
    );
  }

  async syncFromAgent(): Promise<void> {
    const sid = this.deps.getActiveSessionId();
    if (!sid) return;
    const res = await this.deps.inv<{
      projection?: GoalUiProjection | null;
      agent?: {
        objective?: string;
        status?: string;
        lastEvent?: string;
        lastEventDetail?: string;
        elapsedMs?: number;
        goalId?: string;
        phase?: string;
        tokenBudget?: number | null;
        tokensUsed?: number;
        message?: string;
        verifyingCompletion?: boolean;
        planning?: boolean;
      } | null;
    }>("goals.sync", { sessionId: sid });
    if (!res.ok) return;
    const agent = res.data?.agent;
    if (agent?.status) {
      this.applyAgentEvent({
        sessionId: sid,
        goalId: agent.goalId,
        objective: agent.objective,
        status: agent.status,
        phase: agent.phase,
        tokenBudget: agent.tokenBudget,
        tokensUsed: agent.tokensUsed,
        lastEvent: agent.lastEvent,
        lastEventDetail: agent.lastEventDetail,
        elapsedMs: agent.elapsedMs,
        message: agent.message,
        verifyingCompletion: agent.verifyingCompletion,
        planning: agent.planning,
      });
    }
  }
}
