/**
 * 会话 rename / export / compact / archive / delete / status / continue（自 main 迁出）。
 * compact 对齐 CLI CompactSession：ACP `_x.ai/compact_conversation`。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import type { ContextUsageRow } from "../context/ui.js";
import type { Project, ThreadRow } from "../thread/model.js";
import {
  formatSessionInfoLines,
  type SessionInfoRow,
} from "./info-format.js";

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

export type SessionOpsDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  promptText: (opts: {
    title: string;
    hint?: string;
    defaultValue?: string;
    placeholder?: string;
  }) => Promise<string | null>;
  confirmText: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  /** disk_ 或真实 threadId，供 export 默认目标 */
  activeThreadRefId: () => string | null;
  getTurnActive: () => boolean;
  ensureLiveThread: () => Promise<string | null>;
  appendLine: (text: string, kind: "system" | "assistant" | "user") => void;
  refreshContextAfterCompact: (ev: Record<string, unknown>) => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
  /** 归档/删除当前打开线程时退回欢迎页 */
  leaveThreadIfOpen: (t: ThreadRow) => void;
  /** 归档展开态：projectId → 侧栏展开归档组 */
  expandArchiveForProject: (projectId: string) => void;
  getMaxTurnsLimit: () => number | null;
  setMaxTurnsLimit: (n: number | null) => void;
  /** /status 展示用 */
  getSelectedProject: () => Project | undefined;
  getActiveCwd: () => string | null;
  getModelLabel: () => string;
  getEffortLevel: () => string;
  effortLabel: () => string;
  permLabel: () => string;
  getDefaultOpenTarget: () => string;
  setLastContextUsage: (row: ContextUsageRow | null) => void;
  syncContextLabels: () => void;
  /** continue recent */
  getThreads: () => ThreadRow[];
  getProjects: () => Project[];
  setSelectedProjectId: (id: string | null) => void;
  expandProject: (projectId: string) => void;
  openThread: (row: ThreadRow) => void | Promise<void>;
};

export class SessionOpsActions {
  constructor(private readonly deps: SessionOpsDeps) {}

  async renameThread(t: ThreadRow): Promise<void> {
    const next = await this.deps.promptText({
      title: tr("slash.renameTitle"),
      hint: tr("slash.renameHint"),
      defaultValue: t.title || "",
      placeholder: tr("slash.renamePh"),
    });
    if (next == null) return;
    const title = next.trim();
    if (!title) {
      this.deps.showToast(tr("slash.renameEmpty"), "error");
      return;
    }
    const res = await this.deps.inv("threads.rename", {
      threadId: t.id,
      title,
    });
    if (!res.ok) {
      this.deps.showToast(
        res.error?.message ?? tr("slash.renameFail"),
        "error",
      );
      return;
    }
    await this.deps.refreshProjectsAndThreads();
    this.deps.showToast(`已重命名为「${title}」`);
  }

  async exportActiveSession(opts?: {
    destination?: "clipboard" | "file";
    /** 指定线程；默认当前活动会话 */
    threadId?: string;
  }): Promise<{ ok: boolean; message?: string }> {
    const tid = opts?.threadId ?? this.deps.activeThreadRefId();
    if (!tid) return { ok: false, message: tr("slash.needSession") };
    const destination = opts?.destination ?? "clipboard";
    const res = await this.deps.inv<{
      canceled?: boolean;
      path?: string | null;
      destination?: "clipboard" | "file";
    }>("threads.export", { threadId: tid, destination });
    if (!res.ok) {
      return {
        ok: false,
        message: res.error?.message ?? tr("slash.exportFail"),
      };
    }
    if (res.data?.canceled) {
      return { ok: true, message: tr("slash.exportCancel") };
    }
    if (
      res.data?.destination === "clipboard" ||
      destination === "clipboard"
    ) {
      return { ok: true, message: tr("slash.exportClipboardOk") };
    }
    return {
      ok: true,
      message: res.data?.path
        ? tr("slash.exported", { path: res.data.path })
        : tr("slash.exportedOk"),
    };
  }

  /**
   * 真压缩：ACP `_x.ai/compact_conversation`（对齐 CLI CompactSession）。
   * 可选 userContext 作为 two-pass「保留说明」。
   */
  async compactActiveSession(): Promise<{ ok: boolean; message?: string }> {
    if (!this.deps.getActiveThreadId() && !this.deps.getActiveSessionId()) {
      return { ok: false, message: tr("slash.needSession") };
    }
    if (this.deps.getTurnActive()) {
      return { ok: false, message: tr("slash.waitTurn") };
    }

    const userContext = await this.promptCompactUserContext();
    if (userContext === null) {
      return { ok: true, message: tr("slash.cancelled") };
    }

    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      return { ok: false, message: tr("slash.compactAttachFail") };
    }

    this.deps.appendLine(tr("slash.compactRunning"), "system");
    const pr = await this.deps.inv<{ sessionId: string; ok: true }>(
      "threads.compact",
      {
        threadId,
        userContext: userContext || undefined,
      },
    );
    if (!pr.ok) {
      return {
        ok: false,
        message: pr.error?.message ?? tr("slash.compactFail"),
      };
    }
    this.deps.refreshContextAfterCompact({});
    this.deps.appendLine(
      userContext ? tr("slash.compactDoneWithCtx") : tr("slash.compactDone"),
      "system",
    );
    return {
      ok: true,
      message: userContext
        ? tr("slash.compactDoneWithCtx")
        : tr("slash.compactDone"),
    };
  }

  /** compact 确认 + 可选保留说明（对齐 CLI `/compact [user_context]`） */
  private promptCompactUserContext(): Promise<string | null> {
    return new Promise((resolve) => {
      this.deps.openModal(
        tr("slash.compactTitle"),
        `<p class="prompt-dlg-hint">${esc(tr("slash.compactBody"))}</p>
       <label class="prompt-dlg-label" for="compact-ctx">${esc(tr("slash.compactCtxLabel"))}</label>
       <textarea id="compact-ctx" class="prompt-dlg-input" rows="3"
         placeholder="${esc(tr("slash.compactCtxPh"))}"></textarea>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("slash.compactOk"))}</button>
       </div>`,
      );
      const ta = document.getElementById(
        "compact-ctx",
      ) as HTMLTextAreaElement | null;
      const cancel = document.getElementById("prompt-dlg-cancel");
      const ok = document.getElementById("prompt-dlg-ok");
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve(null);
        };
      }
      if (ok) {
        ok.onclick = () => {
          const v = (ta?.value ?? "").trim();
          this.deps.closeModal();
          resolve(v);
        };
      }
      requestAnimationFrame(() => ta?.focus());
    });
  }

  async archiveThread(t: ThreadRow, archived: boolean): Promise<void> {
    const res = await this.deps.inv<ThreadRow>("threads.archive", {
      threadId: t.id,
      archived,
    });
    if (!res.ok) {
      this.deps.showToast(
        res.error?.message ?? (archived ? "归档失败" : "恢复失败"),
        "error",
      );
      return;
    }
    if (archived) {
      this.deps.leaveThreadIfOpen(t);
      if (t.projectId) this.deps.expandArchiveForProject(t.projectId);
      this.deps.showToast("已收进归档");
    } else {
      this.deps.showToast("已恢复到项目列表");
    }
    await this.deps.refreshProjectsAndThreads();
  }

  async deleteThread(t: ThreadRow): Promise<void> {
    const title = t.title || t.sessionId.slice(0, 8);
    const ok = await this.deps.confirmText({
      title: tr("session.deleteTitle"),
      message: tr("archive.deleteConfirm", { title }),
      okLabel: tr("common.delete"),
    });
    if (!ok) return;
    const res = await this.deps.inv<{ deleted: true; sessionId: string }>(
      "threads.delete",
      { threadId: t.id },
    );
    if (!res.ok) {
      this.deps.showToast(
        res.error?.message ?? tr("session.deleteFail"),
        "error",
      );
      return;
    }
    this.deps.leaveThreadIfOpen(t);
    this.deps.showToast(tr("archive.deleted"));
    await this.deps.refreshProjectsAndThreads();
  }

  async fetchSessionInfoForActive(): Promise<SessionInfoRow | null> {
    if (
      !this.deps.getActiveSessionId() &&
      !this.deps.getActiveThreadId()
    ) {
      return null;
    }
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) return null;
    const res = await this.deps.inv<SessionInfoRow>("threads.sessionInfo", {
      threadId,
    });
    if (!res.ok || !res.data) return null;
    return res.data;
  }

  /** slash `/status`：优先 agent session/info，失败回退本地简表 */
  async showStatus(): Promise<{ ok: boolean; message?: string }> {
    const p = this.deps.getSelectedProject();
    const projectLine = p
      ? `${p.title} (${p.path})`
      : tr("slash.none");
    const info = await this.fetchSessionInfoForActive();
    if (info) {
      const lines = formatSessionInfoLines(info, {
        project: projectLine,
        effort: `${this.deps.effortLabel()}（${this.deps.getEffortLevel()}）`,
        perm: this.deps.permLabel(),
      });
      this.deps.openModal(
        tr("slash.statusTitle"),
        `<pre class="slash-status-pre">${esc(lines.join("\n"))}</pre>`,
      );
      const c = info.context;
      if (c.total > 0 || c.used > 0) {
        this.deps.setLastContextUsage({
          sessionId: info.sessionId,
          used: c.used,
          total: c.total,
          percent:
            c.usagePct ||
            (c.total > 0 ? Math.min(100, (c.used / c.total) * 100) : 0),
          available: true,
          source: "signals",
        });
        this.deps.syncContextLabels();
      }
      return { ok: true };
    }
    const openTarget = this.deps.getDefaultOpenTarget();
    const lines = [
      tr("status.project", { project: projectLine }),
      tr("status.thread", {
        id: this.deps.getActiveThreadId() ?? "—",
      }),
      tr("status.sessionId", {
        id: this.deps.getActiveSessionId() ?? "—",
      }),
      tr("status.cwd", {
        cwd: this.deps.getActiveCwd() ?? p?.path ?? "—",
      }),
      tr("status.perm", { perm: this.deps.permLabel() }),
      tr("status.model", { model: this.deps.getModelLabel() }),
      tr("status.effort", {
        effort: `${this.deps.effortLabel()}（${this.deps.getEffortLevel()}）`,
      }),
      tr("status.openTarget", {
        target:
          !openTarget || openTarget === "explorer"
            ? tr("slash.openExplorer")
            : openTarget === "editor"
              ? tr("slash.openEditor")
              : openTarget,
      }),
      "",
      tr("status.needAttach"),
    ];
    this.deps.openModal(
      tr("slash.statusTitle"),
      `<pre class="slash-status-pre">${esc(lines.join("\n"))}</pre>`,
    );
    return { ok: true };
  }

  async continueRecentSession(): Promise<void> {
    const res = await this.deps.inv<{
      sessionId: string;
      cwd: string;
      title: string;
      threadId?: string;
    } | null>("threads.continueRecent");
    if (!res.ok) {
      this.deps.showToast(
        res.error?.message ?? tr("nav.continueFail"),
        "error",
      );
      return;
    }
    if (!res.data) {
      this.deps.showToast(tr("nav.continueNone"));
      return;
    }
    const row = {
      id: res.data.threadId ?? `disk_${res.data.sessionId}`,
      sessionId: res.data.sessionId,
      title: res.data.title,
      cwd: res.data.cwd,
      status: "inactive" as const,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const hit =
      this.deps.getThreads().find((t) => t.sessionId === res.data!.sessionId) ??
      (row as ThreadRow);
    if (hit.projectId) {
      this.deps.setSelectedProjectId(hit.projectId);
      this.deps.expandProject(hit.projectId);
    } else {
      const byPath = this.deps.getProjects().find((p) => {
        const cwd = hit.cwd.replace(/\\/g, "/").toLowerCase();
        const root = p.path.replace(/\\/g, "/").toLowerCase();
        return cwd === root || cwd.startsWith(root + "/");
      });
      if (byPath) {
        this.deps.setSelectedProjectId(byPath.id);
        this.deps.expandProject(byPath.id);
      }
    }
    await this.deps.openThread(hit);
    this.deps.showToast(
      tr("nav.continueOk", {
        title: hit.title || hit.sessionId.slice(0, 8),
      }),
    );
  }

  async promptSetMaxTurns(
    preset?: number,
  ): Promise<{ ok: boolean; message?: string }> {
    if (preset != null && Number.isFinite(preset) && preset > 0) {
      const n = Math.floor(preset);
      this.deps.setMaxTurnsLimit(n);
      return {
        ok: true,
        message: tr("slash.maxTurnsSet", { n: String(n) }),
      };
    }
    return new Promise((resolve) => {
      const curLimit = this.deps.getMaxTurnsLimit();
      const cur = curLimit != null ? String(curLimit) : "";
      this.deps.openModal(
        tr("slash.maxTurns"),
        `<p class="prompt-dlg-hint">${esc(tr("slash.maxTurnsHint"))}</p>
       <input id="max-turns-input" class="prompt-dlg-input" type="number" min="0" step="1"
         value="${esc(cur)}" placeholder="${esc(tr("slash.maxTurnsPh"))}" />
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-ghost" id="max-turns-clear">${esc(tr("slash.maxTurnsClear"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("common.ok"))}</button>
       </div>`,
      );
      const cancel = document.getElementById("prompt-dlg-cancel");
      const clear = document.getElementById("max-turns-clear");
      const ok = document.getElementById("prompt-dlg-ok");
      const input = document.getElementById(
        "max-turns-input",
      ) as HTMLInputElement | null;
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve({ ok: true, message: tr("slash.cancelled") });
        };
      }
      if (clear) {
        clear.onclick = () => {
          this.deps.setMaxTurnsLimit(null);
          this.deps.closeModal();
          resolve({ ok: true, message: tr("slash.maxTurnsCleared") });
        };
      }
      if (ok) {
        ok.onclick = () => {
          const raw = (input?.value ?? "").trim();
          if (!raw) {
            this.deps.setMaxTurnsLimit(null);
            this.deps.closeModal();
            resolve({ ok: true, message: tr("slash.maxTurnsCleared") });
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 1) {
            this.deps.showToast(tr("slash.maxTurnsInvalid"), "error");
            return;
          }
          const floor = Math.floor(n);
          this.deps.setMaxTurnsLimit(floor);
          this.deps.closeModal();
          resolve({
            ok: true,
            message: tr("slash.maxTurnsSet", { n: String(floor) }),
          });
        };
      }
      requestAnimationFrame(() => input?.focus());
    });
  }
}
