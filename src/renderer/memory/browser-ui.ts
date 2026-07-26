/**
 * Memory 浏览 / 添加 / flush / dream（自 main 迁出）。
 * CLI 对齐 A18/E5：GROK_HOME/memory Global/Workspace/Sessions。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { formatAge } from "../lib/format-utils.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type MemoryBrowserUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  getActiveCwd: () => string | undefined;
  getActiveThreadId: () => string | null;
  ensureLiveThread: () => Promise<string | null>;
};

export class MemoryBrowserUi {
  constructor(private readonly deps: MemoryBrowserUiDeps) {}

  /**
   * CLI 对齐 Memory：/memory 浏览；/remember 写入；/flush /dream 指挥 agent。
   */
  async runCommand(
    sub: "list" | "add" | "search" | "status" | "flush" | "dream",
  ): Promise<{ ok: boolean; message?: string }> {
    if (sub === "status") {
      const st = await this.deps.inv<{
        enabled: boolean;
        fileCount: number;
        storePath: string;
        productNote?: string;
        message?: string;
      }>("memory.status");
      if (!st.ok) return { ok: false, message: st.error?.message };
      const s = st.data!;
      return {
        ok: true,
        message: `${s.enabled ? tr("settings.memoryOn") : tr("settings.memoryOff")} · ${tr("settings.memoryFileCount", { n: s.fileCount })} · ${s.storePath}`,
      };
    }
    if (sub === "add") {
      return this.promptAdd();
    }
    if (sub === "flush") {
      return this.flush();
    }
    if (sub === "dream") {
      return this.dream();
    }
    return this.showBrowser(sub === "search");
  }

  async flush(): Promise<{ ok: boolean; message?: string }> {
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) return { ok: false, message: tr("memory.needAttach") };
    const st = await this.deps.inv<{ enabled: boolean }>("memory.status");
    if (st.ok && !st.data?.enabled) {
      return { ok: false, message: tr("memory.needEnable") };
    }
    const res = await this.deps.inv("threads.memoryFlush", { threadId });
    if (!res.ok) {
      return {
        ok: false,
        message: res.error?.message ?? tr("memory.flushFail"),
      };
    }
    return { ok: true, message: tr("memory.flushOk") };
  }

  async dream(): Promise<{ ok: boolean; message?: string }> {
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) return { ok: false, message: tr("memory.needAttach") };
    const st = await this.deps.inv<{ enabled: boolean }>("memory.status");
    if (st.ok && !st.data?.enabled) {
      return { ok: false, message: tr("memory.needEnable") };
    }
    const res = await this.deps.inv("threads.memoryDream", { threadId });
    if (!res.ok) {
      return {
        ok: false,
        message: res.error?.message ?? tr("memory.dreamFail"),
      };
    }
    return { ok: true, message: tr("memory.dreamOk") };
  }

  async promptAdd(): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const esc = this.deps.esc;
      this.deps.openModal(
        tr("slash.remember"),
        `<p class="prompt-dlg-hint">${esc(tr("memory.addHint"))}</p>
       <textarea id="mem-add-text" class="prompt-dlg-input" rows="4"
         placeholder="${esc(tr("memory.addPh"))}"></textarea>
       <div class="memory-scope-row">
         <label><input type="radio" name="mem-scope" value="global" checked /> ${esc(tr("memory.scopeGlobal"))}</label>
         <label><input type="radio" name="mem-scope" value="workspace" /> ${esc(tr("memory.scopeWorkspace"))}</label>
       </div>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("memory.addOk"))}</button>
       </div>`,
      );
      const ta = document.getElementById(
        "mem-add-text",
      ) as HTMLTextAreaElement;
      const cancel = document.getElementById("prompt-dlg-cancel");
      const ok = document.getElementById("prompt-dlg-ok");
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve({ ok: true, message: tr("slash.cancelled") });
        };
      }
      if (ok) {
        ok.onclick = async () => {
          const text = ta.value.trim();
          if (!text) {
            this.deps.showToast(tr("memory.addEmpty"), "error");
            return;
          }
          const scopeEl = document.querySelector(
            'input[name="mem-scope"]:checked',
          ) as HTMLInputElement | null;
          const scope =
            scopeEl?.value === "workspace" ? "workspace" : "global";
          const cwd = this.deps.getActiveCwd();
          const activeThreadId = this.deps.getActiveThreadId();
          const res = await this.deps.inv<{ path: string; scope: string }>(
            "memory.remember",
            {
              text,
              scope,
              cwd,
              threadId:
                activeThreadId && !activeThreadId.startsWith("disk_")
                  ? activeThreadId
                  : undefined,
              rewrite: Boolean(
                activeThreadId && !activeThreadId.startsWith("disk_"),
              ),
            },
          );
          this.deps.closeModal();
          if (!res.ok) {
            resolve({
              ok: false,
              message: res.error?.message ?? tr("memory.addFail"),
            });
            return;
          }
          resolve({
            ok: true,
            message: tr("memory.addedTo", {
              scope:
                res.data?.scope === "workspace"
                  ? tr("memory.scopeWorkspace")
                  : tr("memory.scopeGlobal"),
              path: res.data?.path ?? "",
            }),
          });
        };
      }
      requestAnimationFrame(() => ta.focus());
    });
  }

  async showBrowser(
    focusSearch: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const st = await this.deps.inv<{
      enabled: boolean;
      fileCount: number;
      storePath: string;
      productNote?: string;
      message?: string;
      legacyEntryCount?: number;
    }>("memory.status");
    if (!st.ok) return { ok: false, message: st.error?.message };

    const cwd = this.deps.getActiveCwd();
    const esc = this.deps.esc;

    this.deps.openModal(
      tr("memory.browserTitle"),
      `<p class="prompt-dlg-hint">${esc(st.data?.productNote || tr("memory.productNote"))}</p>
     <p class="prompt-dlg-hint mono-sm">${esc(tr("memory.storePath", { path: st.data?.storePath ?? "—" }))}</p>
     <div class="memory-toolbar">
       <input id="mem-q" class="prompt-dlg-input" type="search"
         placeholder="${esc(tr("memory.searchPh"))}" autocomplete="off" />
       <button type="button" class="btn-dark sm" id="mem-add-btn">${esc(tr("memory.addBtn"))}</button>
     </div>
     <div class="memory-split">
       <div id="mem-list" class="memory-list"></div>
       <pre id="mem-preview" class="memory-preview mono-sm">${esc(tr("memory.previewEmpty"))}</pre>
     </div>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.close"))}</button>
     </div>`,
    );

    let selectedPath = "";

    const renderList = async () => {
      const q = (
        document.getElementById("mem-q") as HTMLInputElement
      ).value.trim();
      const browse = await this.deps.inv<{
        files: Array<{
          id: string;
          source: string;
          label: string;
          path: string;
          deletable: boolean;
          current?: boolean;
          mtimeMs: number;
        }>;
        currentWorkspaceKey?: string;
      }>("memory.browse", { cwd });
      let files = browse.data?.files ?? [];
      if (q) {
        const ql = q.toLowerCase();
        files = files.filter(
          (f) =>
            f.label.toLowerCase().includes(ql) ||
            f.path.toLowerCase().includes(ql) ||
            f.source.toLowerCase().includes(ql),
        );
      }
      const el = document.getElementById("mem-list")!;
      if (!files.length) {
        el.innerHTML = `<div class="item-sub">${esc(
          st.data?.enabled === false
            ? tr("memory.disabledHint")
            : tr("memory.empty"),
        )}</div>`;
        return;
      }
      const groups: Record<string, typeof files> = {
        global: [],
        workspace: [],
        session: [],
      };
      for (const f of files) {
        (groups[f.source] ?? groups.session).push(f);
      }
      const parts: string[] = [];
      for (const src of ["global", "workspace", "session"] as const) {
        const list = groups[src];
        if (!list.length) continue;
        parts.push(
          `<div class="memory-group-h">${esc(tr(`memory.group.${src}`))}</div>`,
        );
        for (const f of list.slice(0, 80)) {
          parts.push(`<div class="memory-row${f.path === selectedPath ? " on" : ""}${f.current ? " current" : ""}" data-mem-path="${esc(f.path)}" data-mem-id="${esc(f.id)}">
          <div class="memory-row-text" title="${esc(f.path)}">${esc(f.label)}${f.current ? ` · ${esc(tr("memory.currentWs"))}` : ""}</div>
          <div class="memory-row-meta">
            <span>${esc(formatAge(new Date(f.mtimeMs).toISOString()) || "")}</span>
            ${
              f.deletable
                ? `<button type="button" class="btn-ghost sm" data-mem-del-path="${esc(f.path)}">${esc(tr("common.delete"))}</button>`
                : ""
            }
          </div>
        </div>`);
        }
      }
      el.innerHTML = parts.join("");

      for (const row of Array.from(el.querySelectorAll("[data-mem-path]"))) {
        (row as HTMLElement).onclick = async (ev) => {
          if ((ev.target as HTMLElement).closest("[data-mem-del-path]")) return;
          selectedPath = (row as HTMLElement).dataset.memPath ?? "";
          await showPreview(selectedPath);
          void renderList();
        };
      }
      for (const btn of Array.from(
        el.querySelectorAll("[data-mem-del-path]"),
      )) {
        (btn as HTMLElement).onclick = async (ev) => {
          ev.stopPropagation();
          const pth = (btn as HTMLElement).dataset.memDelPath ?? "";
          if (!pth) return;
          if (!window.confirm(tr("memory.deleteConfirm"))) return;
          await this.deps.inv("memory.deletePath", { path: pth });
          if (selectedPath === pth) {
            selectedPath = "";
            const pre = document.getElementById("mem-preview");
            if (pre) pre.textContent = tr("memory.previewEmpty");
          }
          await renderList();
          this.deps.showToast(tr("memory.deleted"));
        };
      }
    };

    const showPreview = async (filePath: string) => {
      if (!filePath) return;
      const res = await this.deps.inv<{ content: string; truncated: boolean }>(
        "memory.read",
        { path: filePath },
      );
      const pre = document.getElementById("mem-preview")!;
      if (!res.ok) {
        pre.textContent = res.error?.message ?? tr("memory.readFail");
        return;
      }
      pre.textContent =
        (res.data?.content ?? "") +
        (res.data?.truncated ? `\n\n… (${tr("memory.truncated")})` : "");
    };

    const memQ = document.getElementById("mem-q");
    if (memQ) memQ.oninput = () => void renderList();
    const addBtn = document.getElementById("mem-add-btn");
    if (addBtn) {
      addBtn.onclick = async () => {
        this.deps.closeModal();
        const r = await this.promptAdd();
        if (r.message) this.deps.showToast(r.message, r.ok ? "info" : "error");
        if (r.ok && r.message !== tr("slash.cancelled")) {
          void this.showBrowser(false);
        }
      };
    }
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
    await renderList();
    if (focusSearch) {
      requestAnimationFrame(() =>
        (document.getElementById("mem-q") as HTMLInputElement).focus(),
      );
    }
    return { ok: true };
  }
}
