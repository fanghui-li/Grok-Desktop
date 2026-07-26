/**
 * 权限条 + ask_user_question 对话框（自 main 迁出）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";

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

export type PermPromptUiDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  showWelcome: (show: boolean) => void;
  getAccessMode: () => "normal" | "always_approve";
  isPlanOn: () => boolean;
  setPlanPhaseActive: () => void;
  syncPermLabels: () => void;
};

export class PermPromptUi {
  constructor(private readonly deps: PermPromptUiDeps) {}

  showPermission(requestId: string, summary: string): void {
    const low = summary.toLowerCase();
    if (
      /enter_plan|enter-plan|进入计划|plan mode/i.test(low) &&
      this.deps.isPlanOn()
    ) {
      void this.deps.inv("permissions.respond", {
        requestId,
        decision: "allow_once",
      });
      this.deps.setPlanPhaseActive();
      this.deps.syncPermLabels();
      return;
    }
    if (this.deps.getAccessMode() === "always_approve") {
      void this.deps
        .inv("permissions.respond", {
          requestId,
          decision: "allow_once",
        })
        .catch(() => undefined);
      return;
    }
    const bar = document.getElementById("permission-bar");
    if (!bar) return;
    bar.classList.remove("hidden");
    bar.innerHTML = `<div>${esc(tr("perm.needApprove", { summary }) || `需要批准：${summary}`)}</div>`;
    for (const [label, decision] of [
      [tr("perm.allow") || "允许", "allow_once"],
      [tr("perm.deny") || "拒绝", "deny"],
    ] as const) {
      const b = document.createElement("button");
      b.className = decision === "allow_once" ? "btn-dark" : "btn-ghost";
      b.textContent = label;
      b.onclick = async () => {
        await this.deps.inv("permissions.respond", { requestId, decision });
        bar.classList.add("hidden");
        if (
          decision === "allow_once" &&
          /enter_plan|enter-plan|进入计划/i.test(low)
        ) {
          this.deps.setPlanPhaseActive();
          this.deps.syncPermLabels();
        }
      };
      bar.appendChild(b);
    }
    this.deps.showWelcome(false);
  }

  /**
   * ask_user_question UI：单选/多选题目；提交 → askUser.respond accepted。
   */
  async showAskUser(ev: {
    requestId: string;
    mode?: string;
    questions?: Array<{
      question: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
  }): Promise<void> {
    const questions = ev.questions ?? [];
    if (!questions.length) {
      void this.deps.inv("askUser.respond", {
        requestId: ev.requestId,
        outcome: "cancelled",
      });
      return;
    }

    const parts: string[] = [
      `<p class="prompt-dlg-hint">${esc(tr("askUser.hint") || "请选择后继续")}</p>`,
    ];
    questions.forEach((q, qi) => {
      const multi = Boolean(q.multiSelect);
      parts.push(
        `<div class="ask-user-q" data-qi="${qi}" data-multi="${multi ? "1" : "0"}">
        <div class="ask-user-q-title">${esc(q.question)}</div>
        <div class="ask-user-opts">`,
      );
      (q.options ?? []).forEach((opt, oi) => {
        const inputType = multi ? "checkbox" : "radio";
        const name = `ask_q_${qi}`;
        const id = `ask_q_${qi}_${oi}`;
        parts.push(
          `<label class="ask-user-opt" for="${id}">
          <input type="${inputType}" name="${name}" id="${id}" value="${esc(opt.label)}" />
          <span class="ask-user-opt-label">${esc(opt.label)}</span>
          ${opt.description ? `<span class="ask-user-opt-desc">${esc(opt.description)}</span>` : ""}
        </label>`,
        );
      });
      parts.push(`</div></div>`);
    });
    parts.push(`
    <div class="prompt-dlg-actions">
      <button type="button" class="btn-ghost" id="ask-user-cancel">${esc(tr("common.cancel"))}</button>
      <button type="button" class="btn-dark" id="ask-user-ok">${esc(tr("askUser.submit") || "提交")}</button>
    </div>`);

    this.deps.openModal(tr("askUser.title") || "需要你的选择", parts.join(""));

    const finish = async (
      outcome: "accepted" | "cancelled",
      answers?: Record<string, string[]>,
    ) => {
      this.deps.closeModal();
      try {
        await this.deps.inv("askUser.respond", {
          requestId: ev.requestId,
          outcome,
          answers,
        });
      } catch (err) {
        this.deps.showToast(
          err instanceof Error
            ? err.message
            : tr("askUser.fail") || "提交失败",
          "error",
        );
      }
    };

    const cancel = document.getElementById("ask-user-cancel");
    const ok = document.getElementById("ask-user-ok");
    if (cancel) cancel.onclick = () => void finish("cancelled");
    if (ok) {
      ok.onclick = () => {
        const answers: Record<string, string[]> = {};
        let missing = false;
        questions.forEach((q, qi) => {
          const wrap = document.querySelector(
            `.ask-user-q[data-qi="${qi}"]`,
          ) as HTMLElement | null;
          if (!wrap) return;
          const multi = wrap.dataset.multi === "1";
          const inputs = Array.from(
            wrap.querySelectorAll("input:checked"),
          ) as HTMLInputElement[];
          const labels = inputs.map((i) => i.value).filter(Boolean);
          if (!labels.length) missing = true;
          else answers[q.question] = multi ? labels : [labels[0]!];
        });
        if (missing) {
          this.deps.showToast(
            tr("askUser.needPick") || "请完成所有选择",
            "error",
          );
          return;
        }
        void finish("accepted", answers);
      };
    }
  }
}
