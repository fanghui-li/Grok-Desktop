/**
 * 全局搜索弹层：项目 / 会话 / 符号（自 main 迁出）。
 * 命中构建见 session/search.ts 纯函数。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  buildSessionSearchHits,
  sessionSearchHitsHtml,
} from "./search.js";
import type { Project, ThreadRow } from "../thread/model.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type SessionSearchUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  getProjects: () => Project[];
  getThreads: () => ThreadRow[];
  getSelectedProject: () => Project | undefined;
  setSelectedProjectId: (id: string | null) => void;
  markProjectChoiceTouched: () => void;
  showWelcome: (show: boolean) => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
  openThread: (t: ThreadRow) => void | Promise<void>;
  openPathInWorkspace: (opts: {
    path: string;
    line?: number;
  }) => unknown;
};

export class SessionSearchUi {
  constructor(private readonly deps: SessionSearchUiDeps) {}

  async show(): Promise<void> {
    await this.deps.refreshProjectsAndThreads();
    const esc = this.deps.esc;
    this.deps.openModal(
      tr("common.search"),
      `<div class="session-search-wrap">
      <p class="prompt-dlg-hint">${esc(tr("search.resumeHint"))}</p>
      <input id="search-q" class="prompt-dlg-input" type="search"
        placeholder="${esc(tr("search.placeholder"))}" autocomplete="off" />
      <div id="search-hits" class="session-search-list"></div>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.close"))}</button>
      </div>
    </div>`,
    );

    const run = async () => {
      const rawQ = (
        document.getElementById("search-q") as HTMLInputElement
      ).value.trim();
      const q = rawQ.toLowerCase();
      let graphHits:
        | Array<{ name: string; path: string; line: number; snippet: string }>
        | undefined;
      const proj = this.deps.getSelectedProject();
      if (proj && q.length >= 2) {
        const g = await this.deps.inv<
          Array<{ name: string; path: string; line: number; snippet: string }>
        >("graph.search", { projectPath: proj.path, query: q });
        graphHits = g.data ?? [];
      }
      const hits = buildSessionSearchHits({
        query: rawQ,
        projects: this.deps.getProjects(),
        threads: this.deps.getThreads(),
        esc,
        graphHits,
      });
      const hitsEl = document.getElementById("search-hits");
      if (!hitsEl) return;
      hitsEl.innerHTML = sessionSearchHitsHtml(hits, esc);
      for (const btn of Array.from(
        hitsEl.querySelectorAll(".session-search-item"),
      )) {
        (btn as HTMLElement).onclick = () => {
          const el = btn as HTMLElement;
          const kind = el.dataset.kind;
          if (kind === "project") {
            this.deps.setSelectedProjectId(el.dataset.id ?? null);
            this.deps.markProjectChoiceTouched();
            this.deps.closeModal();
            this.deps.showWelcome(true);
            void this.deps.refreshProjectsAndThreads();
            return;
          }
          if (kind === "thread") {
            const hit = this.deps
              .getThreads()
              .find((t) => t.sessionId === el.dataset.sid);
            this.deps.closeModal();
            if (hit) {
              this.deps.showToast(
                tr("search.opening", {
                  title: hit.title || hit.sessionId.slice(0, 8),
                }),
              );
              void this.deps.openThread(hit);
            }
            return;
          }
          if (kind === "symbol") {
            const pth = el.dataset.path;
            const line = Number(el.dataset.line);
            this.deps.closeModal();
            if (pth) {
              void this.deps.openPathInWorkspace({
                path: pth,
                line: Number.isFinite(line) ? line : undefined,
              });
            }
          }
        };
      }
    };

    const qEl = document.getElementById("search-q");
    if (qEl) qEl.oninput = () => void run();
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
    void run();
    requestAnimationFrame(() =>
      (document.getElementById("search-q") as HTMLInputElement)?.focus(),
    );
  }
}
