/**
 * Goal banner DOM + 耗时/同步计时器（自 main 迁出）。
 * 投影真源与 applyAgentGoalEvent 状态机仍在 main；本模块只读 deps 并刷新 UI。
 */
import { tr } from "../../shared/i18n/index.js";
import {
  computeGoalElapsedMs,
  formatGoalElapsed,
  isGoalPausedStatus,
} from "./input.js";
import {
  goalPauseHintText,
  goalStatusKicker,
  type GoalUiStatus,
} from "./status.js";

export type GoalUiProjection = {
  goalId: string;
  objective: string;
  status: GoalUiStatus;
  phase: "idle" | "planning" | "executing";
  tokenBudget: number | null;
  tokensUsed: number;
  elapsedMs: number;
  elapsedFloorMs: number;
  pauseMessage?: string;
  lastEvent?: string;
  verifyingCompletion: boolean;
  planning: boolean;
};

export type GoalBannerUiDeps = {
  getProjection: () => GoalUiProjection | null;
  getPendingTitle: () => string | null;
  getComposeActive: () => boolean;
  getElapsedAnchorAt: () => number | null;
  syncSessionModeChips: () => void;
  syncGoalFromAgent: () => void | Promise<void>;
};

export class GoalBannerUi {
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: GoalBannerUiDeps) {}

  currentTitle(): string | null {
    return this.deps.getProjection()?.objective || this.deps.getPendingTitle();
  }

  paused(): boolean {
    return isGoalPausedStatus(this.deps.getProjection()?.status);
  }

  completed(): boolean {
    return this.deps.getProjection()?.status === "complete";
  }

  elapsedMsNow(): number {
    const p = this.deps.getProjection();
    if (!p) return 0;
    return computeGoalElapsedMs({
      elapsedFloorMs: p.elapsedFloorMs,
      elapsedMs: p.elapsedMs,
      paused: this.paused(),
      completed: this.completed(),
      anchorAt: this.deps.getElapsedAnchorAt(),
    });
  }

  stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  startElapsedTimer(): void {
    this.stopElapsedTimer();
    if (!this.deps.getProjection() || this.paused() || this.completed()) return;
    const tick = () => {
      const el = formatGoalElapsed(this.elapsedMsNow());
      for (const node of Array.from(
        document.querySelectorAll("[data-goal-elapsed]"),
      )) {
        node.textContent = el;
      }
    };
    tick();
    this.elapsedTimer = setInterval(tick, 1000);
  }

  stopSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  ensureSyncTimer(): void {
    if (this.syncTimer) return;
    if (!this.deps.getProjection() || this.completed()) return;
    this.syncTimer = setInterval(() => {
      if (!this.deps.getProjection() || this.completed()) {
        this.stopSyncTimer();
        return;
      }
      void this.deps.syncGoalFromAgent();
    }, 1500);
  }

  /** 清计时器（投影字段由 main resetGoalUiState 负责） */
  stopAllTimers(): void {
    this.stopSyncTimer();
    this.stopElapsedTimer();
  }

  render(): void {
    const title = this.currentTitle();
    const projection = this.deps.getProjection();
    const pending = this.deps.getPendingTitle();
    const paused = this.paused();
    const done = this.completed();
    for (const id of ["goal-banner-welcome", "goal-banner-chat"] as const) {
      const el = document.getElementById(id);
      if (!el) continue;
      // compose 草稿：chip 已显，banner 仅有投影时显
      el.classList.toggle("hidden", !projection && !pending);
      el.classList.toggle("is-paused", paused && !done);
      el.classList.toggle("is-completed", done);
      const t = el.querySelector("[data-goal-title]");
      if (t) t.textContent = title ?? "";
      const kicker = el.querySelector(".goal-banner-kicker");
      if (kicker) {
        kicker.textContent = projection
          ? goalStatusKicker(projection.status)
          : tr("goal.kicker");
      }
      // 目标条只保留 kicker + 标题 + 耗时；phase/hint 与 kicker 重复且撑爆单行
      const phaseEl = el.querySelector("[data-goal-phase]");
      if (phaseEl) phaseEl.textContent = "";
      const hintEl = el.querySelector("[data-goal-hint]");
      if (hintEl) hintEl.textContent = "";
      const pauseBtn = el.querySelector(
        "[data-goal-pause]",
      ) as HTMLElement | null;
      const resumeBtn = el.querySelector(
        "[data-goal-resume]",
      ) as HTMLElement | null;
      const editBtn = el.querySelector(
        '[data-goal-act="edit"]',
      ) as HTMLElement | null;
      pauseBtn?.classList.toggle("hidden", paused || done || !projection);
      resumeBtn?.classList.toggle("hidden", !paused || done);
      resumeBtn?.classList.toggle("is-primary", Boolean(paused && !done));
      // complete：保留 banner 看 objective；暂停/恢复无意义，编辑仍可开新目标文案
      if (resumeBtn) {
        if (paused && !done && projection) {
          resumeBtn.title =
            goalPauseHintText(projection.status) || tr("goal.resumeHint");
        } else {
          resumeBtn.title = tr("goal.resume");
        }
      }
      if (editBtn && done) {
        editBtn.title = tr("goal.edit");
      }
    }
    const anchor = this.deps.getElapsedAnchorAt();
    const canTick =
      Boolean(projection) && !paused && !done && anchor != null;
    if (canTick) {
      this.startElapsedTimer();
      this.ensureSyncTimer();
    } else {
      this.stopElapsedTimer();
      if (projection && !done) this.ensureSyncTimer();
      else this.stopSyncTimer();
      const base = projection
        ? Math.max(projection.elapsedFloorMs, projection.elapsedMs)
        : 0;
      const el = formatGoalElapsed(this.elapsedMsNow());
      for (const node of Array.from(
        document.querySelectorAll("[data-goal-elapsed]"),
      )) {
        node.textContent = projection && base > 0 ? el : "";
      }
    }
    this.deps.syncSessionModeChips();
  }
}
