/**
 * 后台任务面板 + 本地 task 快照（自 main 迁出）。
 * Host aggregate（process/monitor/subagent/scheduled）优先；空则回落 taskSnaps。
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

export type TaskSnap = {
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  exitCode?: number | null;
  updatedAt: number;
  sessionId?: string;
};

const TASK_SNAP_MAX = 40;

export type TasksPanelUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  getActiveSessionId: () => string | null;
  ensureLiveThread: () => Promise<string | null>;
  appendProcessText: (text: string) => void;
};

export function isTaskRunningPhase(phase: string): boolean {
  return phase === "backgrounded" || phase === "monitor";
}

export class TasksPanelUi {
  private readonly snaps = new Map<string, TaskSnap>();

  constructor(private readonly deps: TasksPanelUiDeps) {}

  noteUpdated(ev: {
    taskId?: string;
    phase: string;
    sessionId?: string;
    command?: string;
    description?: string;
    isMonitor?: boolean;
    success?: boolean;
    exitCode?: number | null;
  }): void {
    const id = ev.taskId || "";
    if (!id) return;
    this.snaps.set(id, {
      taskId: id,
      phase: ev.phase,
      command: ev.command,
      description: ev.description,
      isMonitor: ev.isMonitor,
      success: ev.success,
      exitCode: ev.exitCode,
      updatedAt: Date.now(),
      sessionId: ev.sessionId,
    });
    if (this.snaps.size > TASK_SNAP_MAX) {
      const sorted = [...this.snaps.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
      );
      for (let i = 0; i < sorted.length - TASK_SNAP_MAX; i++) {
        this.snaps.delete(sorted[i][0]);
      }
    }
  }

  show(): { ok: boolean; message?: string } {
    void this.showAsync();
    return { ok: true };
  }

  async showAsync(): Promise<void> {
    type Agg = {
      id: string;
      kind: string;
      title: string;
      status: string;
      canKill?: boolean;
      canOpen?: boolean;
      automationId?: string;
      childSessionId?: string;
    };
    const activeSessionId = this.deps.getActiveSessionId();
    let agg: Agg[] = [];
    if (activeSessionId) {
      const res = await this.deps.inv<{ items: Agg[] }>("threads.tasksList", {
        sessionId: activeSessionId,
      });
      if (res.ok && res.data?.items) agg = res.data.items;
    }
    if (!agg.length) {
      const rows = [...this.snaps.values()]
        .filter(
          (t) =>
            !activeSessionId ||
            !t.sessionId ||
            t.sessionId === activeSessionId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      agg = rows.map((t) => ({
        id: t.taskId,
        kind: t.isMonitor ? "monitor" : "process",
        title: (t.description || t.command || t.taskId).trim(),
        status:
          t.phase === "completed"
            ? t.success === false
              ? "failed"
              : "ok"
            : t.phase,
        canKill: isTaskRunningPhase(t.phase),
      }));
    }
    const esc = this.deps.esc;
    if (!agg.length) {
      this.deps.openModal(
        tr("tasks.modalTitle"),
        `<p class="prompt-dlg-hint">${esc(tr("tasks.empty"))}</p>
       <p class="prompt-dlg-hint">${esc(tr("tasks.hint"))}</p>
       <p class="prompt-dlg-hint">${esc(tr("tasks.automationsHint"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
      );
      const cancel = document.getElementById("prompt-dlg-cancel");
      if (cancel) cancel.onclick = () => this.deps.closeModal();
      return;
    }
    const items = agg
      .map((t) => {
        const kind = t.kind || "process";
        const label = (t.title || "").trim() || kind;
        const short = t.id.slice(0, 10);
        const st = t.status || "unknown";
        const running = t.canKill || isTaskRunningPhase(st);
        return `<div class="task-panel-row" data-task-id="${esc(t.id)}">
        <div class="task-panel-main">
          <span class="task-panel-st task-st-${esc(st)}">[${esc(st)}]</span>
          <span class="task-panel-kind">${esc(kind)}</span>
          <span class="task-panel-id" title="${esc(t.id)}">${esc(short)}</span>
          <span class="task-panel-label" title="${esc(label)}">${esc(label.slice(0, 100))}</span>
        </div>
        <div class="task-panel-acts">
          <button type="button" class="btn-ghost sm" data-task-copy="${esc(t.id)}">${esc(tr("tasks.copyId"))}</button>
          ${
            running && (kind === "process" || kind === "monitor")
              ? `<button type="button" class="btn-dark sm" data-task-kill="${esc(t.id)}" title="${esc(tr("tasks.killTitle"))}">${esc(tr("tasks.kill"))}</button>`
              : ""
          }
          ${
            kind === "scheduled" || t.canOpen
              ? `<button type="button" class="btn-ghost sm" data-task-open-auto="${esc(t.automationId || t.id)}">${esc(tr("tasks.openAutomations"))}</button>`
              : ""
          }
        </div>
      </div>`;
      })
      .join("");
    this.deps.openModal(
      tr("tasks.modalTitle"),
      `<p class="prompt-dlg-hint">${esc(tr("tasks.panelHint"))}</p>
     <div class="task-panel-list">${items}</div>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
    );
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
    for (const btn of Array.from(
      document.querySelectorAll("[data-task-copy]"),
    )) {
      (btn as HTMLElement).onclick = async () => {
        const id = (btn as HTMLElement).dataset.taskCopy ?? "";
        try {
          await navigator.clipboard.writeText(id);
          this.deps.showToast(tr("common.copied"));
        } catch {
          this.deps.showToast(tr("common.copyFailed"), "error");
        }
      };
    }
    for (const btn of Array.from(
      document.querySelectorAll("[data-task-kill]"),
    )) {
      (btn as HTMLElement).onclick = () => {
        const id = (btn as HTMLElement).dataset.taskKill ?? "";
        if (id) void this.kill(id);
      };
    }
    for (const btn of Array.from(
      document.querySelectorAll("[data-task-open-auto]"),
    )) {
      (btn as HTMLElement).onclick = () => {
        this.deps.closeModal();
        document.getElementById("btn-automations")?.click();
      };
    }
  }

  /** S20：杀后台任务（ACP `_x.ai/task/kill`） */
  async kill(taskId: string): Promise<void> {
    const id = taskId.trim();
    if (!id) return;
    const snap = this.snaps.get(id);
    if (snap && !isTaskRunningPhase(snap.phase)) {
      this.deps.showToast(tr("tasks.notRunning"), "error");
      return;
    }
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      this.deps.showToast(tr("tasks.killNeedAttach"), "error");
      return;
    }
    const btn = Array.from(
      document.querySelectorAll("[data-task-kill]"),
    ).find(
      (el) => (el as HTMLElement).dataset.taskKill === id,
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr("tasks.killing");
    }
    const res = await this.deps.inv<{
      taskId: string;
      outcome: string;
      sessionId: string;
    }>("threads.killTask", { threadId, taskId: id });
    if (!res.ok) {
      this.deps.showToast(
        res.error?.message ?? tr("tasks.killFail"),
        "error",
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = tr("tasks.kill");
      }
      return;
    }
    const prev = this.snaps.get(id);
    if (prev) {
      this.snaps.set(id, {
        ...prev,
        phase: "completed",
        success: false,
        updatedAt: Date.now(),
      });
    }
    const outcome = res.data?.outcome ?? "killed";
    this.deps.showToast(tr("tasks.killOk", { id: id.slice(0, 8), outcome }));
    this.deps.appendProcessText(
      tr("tasks.killProcess", { id: id.slice(0, 8), outcome }),
    );
    this.show();
  }
}
