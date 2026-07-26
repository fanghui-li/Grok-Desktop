/**
 * 会话 fork（slash / 侧栏确认，自 main 迁出）。
 * 对话框 HTML 见 lib/fork-session-ui；IPC threads.fork。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  buildForkDialogHtml,
  parseForkSlashArgs,
  readForkDialogResult,
  type ForkWorktreeMode,
} from "../lib/fork-session-ui.js";
import type { ThreadRow } from "../thread/model.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ForkActionsDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  getActiveCwd: () => string | null;
  getSelectedProject: () =>
    | { id: string; path: string; title?: string }
    | undefined;
  getModelLabel: () => string;
  getEffortLevel: () => string;
  getTurnActive: () => boolean;
  cancelTurn: () => void;
  closePlanPanelOnSessionChange: (opts?: {
    stashSessionId?: string | null;
    abandonPending?: boolean;
  }) => void;
  threadDisplayTitle: (
    row: ThreadRow | undefined,
    sessionId?: string,
  ) => string;
  getThreads: () => ThreadRow[];
  setThreads: (next: ThreadRow[]) => void;
  openThread: (row: ThreadRow) => void | Promise<void>;
  refreshProjectsAndThreads: () => void | Promise<void>;
};

export class ForkActions {
  constructor(private readonly deps: ForkActionsDeps) {}

  openDialog(initial: {
    worktreeMode: ForkWorktreeMode;
  }): Promise<{ worktreeMode: ForkWorktreeMode } | null> {
    return new Promise((resolve) => {
      this.deps.openModal(
        tr("session.forkConfirmTitle"),
        buildForkDialogHtml(),
      );
      const radios = document.querySelectorAll('input[name="fork-wt"]');
      for (const r of Array.from(radios)) {
        const input = r as HTMLInputElement;
        if (input.value === initial.worktreeMode) input.checked = true;
      }
      const ok = document.getElementById("fork-dlg-ok");
      if (ok) {
        ok.onclick = () => {
          const result = readForkDialogResult();
          this.deps.closeModal();
          resolve(result);
        };
      }
      const cancel = document.getElementById("prompt-dlg-cancel");
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve(null);
        };
      }
    });
  }

  async forkFrom(
    source: ThreadRow,
    opts?: {
      confirm?: boolean;
      directive?: string;
      worktreeMode?: ForkWorktreeMode;
    },
  ): Promise<{ ok: boolean; message?: string }> {
    const cwd =
      source.cwd ||
      this.deps.getActiveCwd() ||
      this.deps.getSelectedProject()?.path;
    if (!cwd) return { ok: false, message: tr("slash.forkNeedProject") };
    if (!source.sessionId) {
      return { ok: false, message: tr("slash.forkNeedSession") };
    }

    const baseTitle = this.deps.threadDisplayTitle(source);
    let directive = opts?.directive?.trim() ?? "";
    let worktreeMode = opts?.worktreeMode ?? "use_main";

    if (opts?.confirm) {
      const dlg = await this.openDialog({ worktreeMode });
      if (!dlg) return { ok: false };
      worktreeMode = dlg.worktreeMode;
    }

    if (
      this.deps.getTurnActive() &&
      (source.sessionId === this.deps.getActiveSessionId() ||
        source.id === this.deps.getActiveThreadId())
    ) {
      void this.deps.cancelTurn();
    }

    const projectId =
      source.projectId || this.deps.getSelectedProject()?.id;
    const forkTitle = tr("slash.forkTitle", { title: baseTitle }).slice(
      0,
      48,
    );
    this.deps.closePlanPanelOnSessionChange({
      stashSessionId: this.deps.getActiveSessionId(),
      abandonPending: false,
    });
    const res = await this.deps.inv<{
      threadId: string;
      sessionId: string;
      cwd: string;
      historyCopied?: boolean;
      parentSessionId?: string;
      directiveSent?: boolean;
      historyCopyError?: string;
      directiveError?: string;
      sourceHistoryLines?: number;
    }>("threads.fork", {
      sourceSessionId: source.sessionId,
      cwd,
      projectId,
      title: forkTitle,
      model: source.model || this.deps.getModelLabel(),
      effort: source.effort || this.deps.getEffortLevel(),
      directive: directive || undefined,
      worktree:
        worktreeMode === "create_new"
          ? { mode: "create_new" as const }
          : { mode: "use_main" as const },
    });
    if (!res.ok) {
      return {
        ok: false,
        message: res.error?.message ?? tr("slash.forkFail"),
      };
    }

    const row: ThreadRow = {
      id: res.data!.threadId,
      sessionId: res.data!.sessionId,
      title: forkTitle,
      cwd: res.data!.cwd,
      status: "idle",
      updatedAt: new Date().toISOString(),
      projectId,
      sessionKind: "fork",
      parentSessionId: res.data!.parentSessionId || source.sessionId,
      model: source.model || this.deps.getModelLabel(),
      effort: source.effort || this.deps.getEffortLevel(),
    };
    const threads = this.deps.getThreads();
    if (!threads.some((t) => t.sessionId === row.sessionId)) {
      this.deps.setThreads([row, ...threads]);
    }
    await this.deps.openThread(row);
    await this.deps.refreshProjectsAndThreads();
    const d = res.data!;
    let msg = d.historyCopied
      ? tr("slash.forkOkCopied")
      : (d.sourceHistoryLines ?? 0) > 0 || d.historyCopyError
        ? tr("slash.forkOkCopyFailed", {
            err: d.historyCopyError || tr("slash.forkCopyUnknown"),
          })
        : tr("slash.forkOkEmpty");
    if (d.directiveSent) {
      msg += " · " + tr("slash.forkDirectiveSent");
    } else if (directive && d.directiveError) {
      msg +=
        " · " + tr("slash.forkDirectiveFail", { err: d.directiveError });
    }
    if (
      !d.historyCopied &&
      ((d.sourceHistoryLines ?? 0) > 0 || d.historyCopyError)
    ) {
      this.deps.showToast(msg, "error");
    }
    return { ok: true, message: msg };
  }

  async forkActive(
    rawArg?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const p = this.deps.getSelectedProject();
    const cwd = this.deps.getActiveCwd() || p?.path;
    if (!cwd) return { ok: false, message: tr("slash.forkNeedProject") };
    const activeSessionId = this.deps.getActiveSessionId();
    if (!activeSessionId) {
      return { ok: false, message: tr("slash.forkNeedSession") };
    }
    const { directive: arg, worktreeMode } = parseForkSlashArgs(
      rawArg ?? "",
    );
    const threads = this.deps.getThreads();
    const source =
      threads.find((t) => t.sessionId === activeSessionId) ??
      ({
        id:
          this.deps.getActiveThreadId() || `disk_${activeSessionId}`,
        sessionId: activeSessionId,
        title: this.deps.threadDisplayTitle(
          threads.find((t) => t.sessionId === activeSessionId),
          activeSessionId,
        ),
        cwd,
        status: "idle",
        projectId: p?.id,
        model: this.deps.getModelLabel(),
        effort: this.deps.getEffortLevel(),
      } satisfies ThreadRow);
    return this.forkFrom(source, {
      confirm: false,
      directive: arg || undefined,
      worktreeMode,
    });
  }
}
