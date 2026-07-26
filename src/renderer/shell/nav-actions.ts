/**
 * Shell 导航 / deep-link / notice（自 main 迁出）。
 * 对齐 CLI shell.navigate / shell.handoff / shell.notice 事件。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import type { ThreadRow } from "../thread/model.js";

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

export type ShellNavDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  showWelcome: (show: boolean) => void;
  getModalBody: () => HTMLElement | null;
  getThreads: () => ThreadRow[];
  setSelectedProjectId: (id: string | null) => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
  openThread: (row: ThreadRow) => void | Promise<void>;
};

export class ShellNavActions {
  constructor(private readonly deps: ShellNavDeps) {}

  async handleDeepLinkPayload(payload: string): Promise<void> {
    const parsed = await this.deps.inv<{ kind: string; id?: string }>(
      "shell.parseDeepLink",
      { raw: payload },
    );
    if (!parsed.ok || !parsed.data) return;
    if (parsed.data.kind === "project" && parsed.data.id) {
      this.deps.setSelectedProjectId(parsed.data.id);
      await this.deps.refreshProjectsAndThreads();
      this.deps.showWelcome(true);
    }
    if (parsed.data.kind === "inbox") {
      /* could open modal */
    }
  }

  handleShellNavigate(view: "command" | "inbox" | string): void {
    if (view === "inbox") {
      void this.openInboxModal();
      return;
    }
    if (view === "command") {
      try {
        this.deps.closeModal();
      } catch {
        /* ignore */
      }
      this.deps.showWelcome(true);
    }
  }

  handleShellNotice(code: string, message?: string): void {
    if (code === "agent_missing") {
      this.deps.showToast(message || tr("agent.missing"), "error");
    } else if (message) {
      this.deps.showToast(message, "info");
    }
  }

  private async openInboxModal(): Promise<void> {
    try {
      const res = await this.deps.inv<
        Array<{
          id: string;
          title?: string;
          body?: string;
          read?: boolean;
          type?: string;
          createdAt?: string;
          sessionId?: string;
          threadId?: string;
          projectId?: string;
        }>
      >("inbox.list", {});
      const items = res.ok ? (res.data ?? []) : [];
      const rows = items.length
        ? items
            .map((it) => {
              const unread = it.read ? "" : " is-unread";
              const when = it.createdAt
                ? esc(it.createdAt.replace("T", " ").slice(0, 16))
                : "";
              return (
                '<div class="item inbox-item' +
                unread +
                '" data-inbox-id="' +
                esc(it.id) +
                '">' +
                '<div class="item-title">' +
                esc(it.title || it.type || "notice") +
                "</div>" +
                '<div class="item-sub">' +
                esc((it.body || "").slice(0, 200)) +
                "</div>" +
                '<div class="item-sub mono">' +
                esc(it.type || "") +
                " · " +
                when +
                "</div>" +
                '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
                '<button type="button" class="btn-dark" data-inbox-act="open" data-id="' +
                esc(it.id) +
                '">' +
                esc(tr("common.open")) +
                "</button>" +
                '<button type="button" class="btn-ghost" data-inbox-act="dismiss" data-id="' +
                esc(it.id) +
                '">' +
                esc(tr("common.delete")) +
                "</button>" +
                "</div></div>"
              );
            })
            .join("")
        : '<div class="item-sub">' + esc(tr("common.none")) + "</div>";
      this.deps.openModal(
        tr("nav.inbox"),
        '<div style="display:flex;justify-content:flex-end;margin-bottom:8px">' +
          '<button type="button" class="btn-ghost" id="btn-inbox-mark-all">' +
          esc(tr("common.ok")) +
          "</button></div><div class=\"inbox-list\">" +
          rows +
          "</div>",
      );
      const body = this.deps.getModalBody();
      if (!body) return;
      body.onclick = async (e) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.id === "btn-inbox-mark-all") {
          await this.deps.inv("inbox.markAllRead");
          this.handleShellNavigate("inbox");
          return;
        }
        const act = target.dataset.inboxAct;
        const id = target.dataset.id;
        if (!act || !id) return;
        const item = items.find((x) => x.id === id);
        if (act === "open") {
          if (item?.id) await this.deps.inv("inbox.markRead", { id: item.id });
          if (item?.sessionId) {
            const row = this.deps
              .getThreads()
              .find((x) => x.sessionId === item.sessionId);
            if (row) {
              this.deps.closeModal();
              await this.deps.openThread(row);
            }
          } else if (item?.projectId) {
            this.deps.setSelectedProjectId(item.projectId);
            await this.deps.refreshProjectsAndThreads();
          }
          return;
        }
        if (act === "dismiss") {
          await this.deps.inv("inbox.dismiss", { id });
          this.handleShellNavigate("inbox");
        }
      };
    } catch (err) {
      this.deps.showToast(
        err instanceof Error ? err.message : tr("common.error"),
        "error",
      );
    }
  }
}
