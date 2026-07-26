/**
 * /goal slash 子命令（set/status/clear/pause/resume/budget，自 main 迁出）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { goalStatusKicker } from "./status.js";
import type { GoalUiProjection } from "./banner-ui.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type GoalSlashActionsDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  getGoalProjection: () => GoalUiProjection | null;
  getGoalTokenBudget: () => number | null;
  setGoalTokenBudget: (n: number | null) => void;
  currentGoalTitle: () => string | null;
  goalCompleted: () => boolean;
  pauseGoal: () => void | Promise<void>;
  resumeGoal: () => void | Promise<void>;
  resetGoalUiState: () => void;
  renderGoalBanner: () => void;
  beginGoalCompose: () => void;
  markGoalLocalCleared: (goalId: string) => void;
  sendAgentGoalSlash: (line: string) => void | Promise<unknown>;
  applyGoalTitle: (
    title: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  getPendingGoalTitle: () => string | null;
  agentContentForSend: (
    userContent: string,
    goalJustSet: string | null,
  ) => string;
};

export class GoalSlashActions {
  constructor(private readonly deps: GoalSlashActionsDeps) {}

  async runCommand(
    sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
  ): Promise<{ ok: boolean; message?: string }> {
    if (sub === "status") {
      const t = this.deps.currentGoalTitle();
      if (!t) return { ok: true, message: tr("goal.noneActive") };
      const projection = this.deps.getGoalProjection();
      const budgetVal =
        projection?.tokenBudget ?? this.deps.getGoalTokenBudget();
      const budget =
        budgetVal != null
          ? tr("goal.budgetLine", { n: String(budgetVal) })
          : "";
      const st = projection
        ? goalStatusKicker(projection.status)
        : tr("goal.kicker");
      return {
        ok: true,
        message: `${st}：${t}${budget ? ` · ${budget}` : ""}`,
      };
    }
    if (sub === "pause") {
      await this.deps.pauseGoal();
      return { ok: true, message: tr("goal.pausedToast") };
    }
    if (sub === "resume") {
      await this.deps.resumeGoal();
      return { ok: true, message: tr("goal.resumedToast") };
    }
    if (sub === "budget") {
      return this.promptBudget();
    }
    if (sub === "clear") {
      const projection = this.deps.getGoalProjection();
      if (projection?.goalId) {
        this.deps.markGoalLocalCleared(projection.goalId);
      }
      this.deps.setGoalTokenBudget(null);
      this.deps.resetGoalUiState();
      const sid = this.deps.getActiveSessionId();
      if (sid) {
        await this.deps.inv("goals.clear", { sessionId: sid });
      }
      this.deps.renderGoalBanner();
      void this.deps.sendAgentGoalSlash("/goal clear");
      return { ok: true, message: tr("goal.cleared") };
    }
    this.deps.beginGoalCompose();
    return { ok: true };
  }

  /**
   * 编辑目标：弹窗改写 objective（不占用主输入框）。
   * 确认后 optimistic 更新 banner；若已有未完成 goal 则立刻 `/goal …` 重设。
   */
  promptEditGoal(): Promise<void> {
    const prefill = this.deps.currentGoalTitle() ?? "";
    return new Promise((resolve) => {
      this.deps.openModal(
        tr("goal.edit"),
        `<p class="prompt-dlg-hint">${esc(tr("goal.editHint"))}</p>
       <textarea id="goal-edit-input" class="prompt-dlg-input prompt-dlg-textarea" rows="4"
         placeholder="${esc(tr("goal.editPlaceholder"))}">${esc(prefill)}</textarea>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("common.ok"))}</button>
       </div>`,
      );
      const input = document.getElementById(
        "goal-edit-input",
      ) as HTMLTextAreaElement | null;
      const cancel = document.getElementById("prompt-dlg-cancel");
      const ok = document.getElementById("prompt-dlg-ok");
      const finish = (v: string | null) => {
        this.deps.closeModal();
        if (v == null) {
          resolve();
          return;
        }
        void (async () => {
          const hadLive =
            Boolean(this.deps.getGoalProjection()) &&
            !this.deps.goalCompleted();
          const r = await this.deps.applyGoalTitle(v);
          if (!r.ok) {
            if (r.message) this.deps.showToast(r.message, "error");
            resolve();
            return;
          }
          const pending = this.deps.getPendingGoalTitle();
          if (hadLive && pending) {
            const line = this.deps.agentContentForSend("", pending);
            const sent = await this.deps.sendAgentGoalSlash(line);
            const okSent = sent !== false;
            this.deps.showToast(
              okSent ? tr("goal.editedToast") : tr("goal.setFail"),
              okSent ? "info" : "error",
            );
          } else {
            this.deps.showToast(tr("goal.editedToast"));
          }
          resolve();
        })();
      };
      if (cancel) cancel.onclick = () => finish(null);
      if (ok) ok.onclick = () => finish(input?.value ?? "");
      if (input) {
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            finish(null);
          }
          if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            finish(input.value);
          }
        };
      }
      requestAnimationFrame(() => {
        if (!input) return;
        input.focus();
        const n = input.value.length;
        input.setSelectionRange(n, n);
      });
    });
  }

  async promptBudget(): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const curBudget = this.deps.getGoalTokenBudget();
      const cur = curBudget != null ? String(curBudget) : "";
      this.deps.openModal(
        tr("slash.goalBudget"),
        `<p class="prompt-dlg-hint">${esc(tr("slash.goalBudgetHint"))}</p>
       <input id="goal-budget-input" class="prompt-dlg-input" type="number" min="1" step="1000"
         value="${esc(cur)}" placeholder="${esc(tr("slash.goalBudgetPh"))}" />
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-ghost" id="goal-budget-clear">${esc(tr("slash.goalBudgetClear"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("common.ok"))}</button>
       </div>`,
      );
      const cancel = document.getElementById("prompt-dlg-cancel");
      const clear = document.getElementById("goal-budget-clear");
      const ok = document.getElementById("prompt-dlg-ok");
      const input = document.getElementById(
        "goal-budget-input",
      ) as HTMLInputElement | null;
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve({ ok: true, message: tr("slash.cancelled") });
        };
      }
      if (clear) {
        clear.onclick = () => {
          this.deps.setGoalTokenBudget(null);
          this.deps.closeModal();
          resolve({ ok: true, message: tr("slash.goalBudgetCleared") });
        };
      }
      if (ok) {
        ok.onclick = () => {
          const raw = (input?.value ?? "").trim();
          if (!raw) {
            this.deps.setGoalTokenBudget(null);
            this.deps.closeModal();
            resolve({ ok: true, message: tr("slash.goalBudgetCleared") });
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 1) {
            this.deps.showToast(tr("slash.goalBudgetInvalid"), "error");
            return;
          }
          const floor = Math.floor(n);
          this.deps.setGoalTokenBudget(floor);
          this.deps.closeModal();
          const t = this.deps.currentGoalTitle();
          if (t && !this.deps.goalCompleted()) {
            void this.deps.sendAgentGoalSlash(
              `/goal ${t} --budget ${floor}`,
            );
          }
          resolve({
            ok: true,
            message: tr("slash.goalBudgetSet", { n: String(floor) }),
          });
        };
      }
      requestAnimationFrame(() => input?.focus());
    });
  }
}
