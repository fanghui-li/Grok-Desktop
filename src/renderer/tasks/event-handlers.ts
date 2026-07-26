/**
 * subagent.updated / task.updated 前台提示（自 main 迁出）。
 * 侧栏树 / 任务面板投影经 deps；本模块不持有 session 真源。
 */
import { tr } from "../../shared/i18n/index.js";

export type SubagentUpdatedEvent = {
  sessionId?: string;
  parentSessionId?: string;
  subagentId: string;
  phase: string;
  status: string;
  subagentType?: string;
  description?: string;
  error?: string;
  childSessionId?: string;
};

export type TaskUpdatedEvent = {
  sessionId?: string;
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  willWake?: boolean;
  exitCode?: number | null;
  signal?: string;
  durationMs?: number;
  eventText?: string;
  staleOnLoad?: boolean;
};

/**
 * 子代理事件是否应对当前前台会话可见。
 * parent 与 session 均非前台时丢弃（后台树仍可由 Host 侧栏刷新）。
 */
export function isSubagentEventForActiveSession(
  ev: Pick<
    SubagentUpdatedEvent,
    "sessionId" | "parentSessionId"
  >,
  activeSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  const parent = ev.parentSessionId || ev.sessionId;
  if (
    parent &&
    parent !== activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== activeSessionId
  ) {
    return false;
  }
  return true;
}

export function isTaskEventForActiveSession(
  ev: Pick<TaskUpdatedEvent, "sessionId">,
  activeSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  if (ev.sessionId && ev.sessionId !== activeSessionId) return false;
  return true;
}

export function taskEventLabel(ev: TaskUpdatedEvent): string {
  return (
    (ev.description || ev.command || "").trim() ||
    (ev.isMonitor ? "monitor" : "task")
  );
}

export type SubagentTaskHandlersDeps = {
  getActiveSessionId: () => string | null;
  showToast: (text: string, kind?: "info" | "error") => void;
  appendProcessText: (text: string) => void;
  applySubagentUpdate: (ev: SubagentUpdatedEvent) => void;
  rememberTaskSnap: (ev: TaskUpdatedEvent) => void;
};

export class SubagentTaskEventHandlers {
  constructor(private readonly deps: SubagentTaskHandlersDeps) {}

  handleSubagentUpdated(ev: SubagentUpdatedEvent): void {
    if (
      !isSubagentEventForActiveSession(ev, this.deps.getActiveSessionId())
    ) {
      return;
    }
    this.deps.applySubagentUpdate(ev);
    const short = (ev.subagentId || "").slice(0, 8);
    const kind = ev.subagentType || "subagent";
    if (ev.phase === "spawned") {
      this.deps.showToast(
        tr("subagent.spawned", { type: kind, id: short }),
        "info",
      );
      return;
    }
    if (ev.phase === "finished") {
      const st = String(ev.status || "").toLowerCase();
      if (st === "failed" || st === "error") {
        this.deps.showToast(
          ev.error || tr("subagent.failed", { type: kind, id: short }),
          "error",
        );
      } else if (st === "cancelled" || st === "canceled") {
        this.deps.showToast(tr("subagent.cancelled", { id: short }));
      } else {
        this.deps.showToast(
          tr("subagent.completed", { type: kind, id: short }),
        );
      }
    }
  }

  handleTaskUpdated(ev: TaskUpdatedEvent): void {
    this.deps.rememberTaskSnap(ev);
    if (!isTaskEventForActiveSession(ev, this.deps.getActiveSessionId())) {
      return;
    }
    const short = (ev.taskId || "").slice(0, 8);
    const label = taskEventLabel(ev);

    if (ev.phase === "backgrounded") {
      const line = ev.isMonitor
        ? tr("task.monitorStarted", { desc: label, id: short })
        : tr("task.started", { cmd: label, id: short });
      this.deps.appendProcessText(line);
      this.deps.showToast(line, "info");
      return;
    }

    if (ev.phase === "monitor") {
      const text = (ev.eventText || "").trim();
      if (text) {
        this.deps.appendProcessText(
          tr("task.monitorEvent", {
            desc: label,
            text: text.length > 200 ? text.slice(0, 200) + "…" : text,
          }),
        );
      }
      return;
    }

    if (ev.phase === "completed") {
      if (ev.staleOnLoad) {
        this.deps.appendProcessText(
          tr("task.staleOnLoad", { desc: label, id: short }),
        );
        return;
      }
      const ok = ev.success !== false;
      let line: string;
      if (ok) {
        line = tr("task.completed", { desc: label, id: short });
        if (ev.willWake) {
          line += " · " + tr("task.willWake");
        }
        this.deps.appendProcessText(line);
        this.deps.showToast(line, "info");
      } else {
        const detail =
          ev.signal ||
          (ev.exitCode != null ? `exit ${ev.exitCode}` : "") ||
          "";
        line = tr("task.failed", {
          desc: label,
          id: short,
          detail: detail || "error",
        });
        this.deps.appendProcessText(line);
        this.deps.showToast(line, "error");
      }
    }
  }
}
