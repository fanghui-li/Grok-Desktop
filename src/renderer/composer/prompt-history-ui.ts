/**
 * S17 prompt 历史：↑↓ 召回 + 搜索弹层（自 main 迁出）。
 * 状态真源在 PromptHistoryStore。
 */
import { tr } from "../../shared/i18n/index.js";
import { PromptHistoryStore } from "../prompt-history-store.js";

export type PromptHistoryUiDeps = {
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  activeComposerInput: () => HTMLTextAreaElement;
  isSlashPaletteOpen: () => boolean;
};

export class PromptHistoryUi {
  private readonly store = new PromptHistoryStore();

  constructor(private readonly deps: PromptHistoryUiDeps) {}

  get length(): number {
    return this.store.length;
  }

  resetBrowse(): void {
    this.store.resetBrowse();
  }

  clear(): void {
    this.store.clear();
  }

  record(text: string): void {
    this.store.record(text);
  }

  seedFromUserTexts(texts: string[]): void {
    this.store.seedFromUserTexts(texts);
  }

  applyToComposer(
    text: string,
    ta?: HTMLTextAreaElement | null,
  ): void {
    const input = ta ?? this.deps.activeComposerInput();
    input.value = text;
    const pos = text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /**
   * ↑/↓ 浏览 prompt 历史。
   * 仅在：slash/@ 未打开、光标在开头（或已在浏览中）时拦截。
   */
  handleKey(ta: HTMLTextAreaElement, e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
    if (this.deps.isSlashPaletteOpen()) return false;
    const atEl = document.getElementById("at-file-palette");
    if (atEl && !atEl.classList.contains("hidden")) return false;

    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const browsing = this.store.isBrowsing;

    if (e.key === "ArrowUp") {
      if (!browsing) {
        const before = ta.value.slice(0, start);
        if (before.includes("\n")) return false;
        if (start !== end) return false;
        if (ta.value.length > 0 && start > 0) return false;
      }
      const next = this.store.browseUp(ta.value);
      if (next == null) return false;
      e.preventDefault();
      this.applyToComposer(next, ta);
      return true;
    }

    const next = this.store.browseDown();
    if (next == null) return false;
    e.preventDefault();
    this.applyToComposer(next, ta);
    return true;
  }

  showSearch(): { ok: boolean; message?: string } {
    const esc = this.deps.esc;
    this.deps.openModal(
      tr("history.modalTitle"),
      `<div class="session-search-wrap">
      <input id="prompt-hist-q" class="prompt-dlg-input" type="search"
        placeholder="${esc(tr("history.searchPh"))}" autocomplete="off" />
      <div id="prompt-hist-hits" class="session-search-list prompt-hist-list"></div>
      <p class="prompt-dlg-hint" id="prompt-hist-hint">${esc(tr("history.hint"))}</p>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
      </div>
    </div>`,
    );
    const qEl = document.getElementById(
      "prompt-hist-q",
    ) as HTMLInputElement;
    const hitsEl = document.getElementById("prompt-hist-hits")!;
    let active = 0;
    let filtered: string[] = [];

    const render = () => {
      filtered = this.store.filter(qEl.value);
      active = Math.min(active, Math.max(0, filtered.length - 1));
      if (!filtered.length) {
        hitsEl.innerHTML = `<div class="session-search-empty">${esc(
          this.store.length
            ? tr("history.noMatch")
            : tr("history.empty"),
        )}</div>`;
        return;
      }
      hitsEl.innerHTML = filtered
        .slice(0, 40)
        .map((line, i) => {
          const short =
            line.length > 160
              ? line.slice(0, 160).replace(/\s+/g, " ") + "…"
              : line.replace(/\s+/g, " ");
          return `<button type="button" class="session-search-item prompt-hist-item${i === active ? " is-active" : ""}" data-hist-i="${i}" role="option">
          <span class="session-search-title">${esc(short)}</span>
        </button>`;
        })
        .join("");
      hitsEl.querySelectorAll<HTMLElement>("[data-hist-i]").forEach((btn) => {
        btn.onclick = () => {
          const i = Number(btn.dataset.histI);
          pick(i);
        };
      });
      hitsEl
        .querySelector(".prompt-hist-item.is-active")
        ?.scrollIntoView({ block: "nearest" });
    };

    const pick = (i: number) => {
      const text = filtered[i];
      if (text == null) return;
      this.deps.closeModal();
      this.store.resetBrowse();
      this.applyToComposer(text);
      this.deps.showToast(tr("history.inserted"));
    };

    qEl.oninput = () => {
      active = 0;
      render();
    };
    qEl.onkeydown = (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (filtered.length) {
          active = Math.min(filtered.length - 1, active + 1);
          render();
        }
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (filtered.length) {
          active = Math.max(0, active - 1);
          render();
        }
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        pick(active);
      } else if (ev.key === "Escape") {
        this.deps.closeModal();
      }
    };
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
    render();
    window.setTimeout(() => qEl.focus(), 0);
    return { ok: true };
  }
}
