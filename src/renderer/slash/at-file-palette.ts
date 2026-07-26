/**
 * Composer @ 文件引用浮层（对齐 CLI file_search 语义，Web 实现）
 *
 * - 触发：光标在 @token 内，且 @ 前非字母数字/下划线（防邮箱）
 * - 选择：插入 @rel/path，并回调 onPick 以便加入附件上下文
 */
import { tr } from "../../shared/i18n/index.js";

export type AtFileHit = {
  path: string;
  absPath: string;
  name: string;
  isDirectory: boolean;
  score: number;
};

export type AtContext = {
  /** 含 @ 的 token 起点 */
  start: number;
  /** token 终点（不含尾部空白） */
  end: number;
  query: string;
  dirsOnly: boolean;
  /** @! 隐藏模式（对齐 CLI） */
  hiddenMode: boolean;
};

export interface AtFilePaletteOptions {
  /** 当前搜索根目录（项目 path / session cwd） */
  getCwd: () => string | null | undefined;
  search: (opts: {
    cwd: string;
    query: string;
    dirsOnly?: boolean;
    includeHidden?: boolean;
  }) => Promise<AtFileHit[]>;
  /** 选中文件后：插入引用之外的副作用（如加入附件） */
  onPick?: (hit: AtFileHit) => void;
  onMessage?: (text: string, kind?: "info" | "error") => void;
  /** 打开时通知（用于关闭 slash 等） */
  onOpen?: () => void;
  onClose?: () => void;
}

export function detectAtContext(text: string, cursor: number): AtContext | null {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return null;

  // 邮箱等：@ 前为字母数字或下划线则不触发
  if (atIdx > 0) {
    const prev = text[atIdx - 1]!;
    if (/[A-Za-z0-9_]/.test(prev)) return null;
  }

  // token：从 @ 到空白/逗号/分号/换行
  let end = atIdx + 1;
  while (end < text.length) {
    const ch = text[end]!;
    if (/\s/.test(ch) || ch === "," || ch === ";" || ch === "\n") break;
    end += 1;
  }
  // 光标须在 token 内（含末尾可继续输入）
  if (cursor < atIdx + 1 || cursor > end) return null;

  let rawQuery = text.slice(atIdx + 1, cursor);
  const hiddenMode = rawQuery.startsWith("!");
  if (hiddenMode) rawQuery = rawQuery.slice(1);
  const dirsOnly = rawQuery.endsWith("/") || rawQuery.endsWith("\\");
  const query = dirsOnly ? rawQuery.replace(/[/\\]+$/, "") : rawQuery;

  return { start: atIdx, end, query, dirsOnly, hiddenMode };
}

export class AtFilePaletteController {
  private el: HTMLElement;
  private open = false;
  private items: AtFileHit[] = [];
  private active = 0;
  private trigger: AtContext | null = null;
  private ta: HTMLTextAreaElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(private readonly opts: AtFilePaletteOptions) {
    this.el = document.createElement("div");
    this.el.id = "at-file-palette";
    this.el.className = "at-file-palette hidden";
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", tr("at.aria"));
    document.body.appendChild(this.el);
  }

  attach(ta: HTMLTextAreaElement): void {
    ta.addEventListener("input", () => void this.onInput(ta));
    ta.addEventListener("keydown", (e) => this.onKeyDown(ta, e), true);
    ta.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement !== ta) this.hide();
      }, 150);
    });
    ta.addEventListener("click", () => void this.onInput(ta));
    ta.addEventListener("keyup", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") void this.onInput(ta);
    });
  }

  hide(): void {
    this.open = false;
    this.trigger = null;
    this.items = [];
    this.el.classList.add("hidden");
    this.el.innerHTML = "";
    this.opts.onClose?.();
  }

  isOpen(): boolean {
    return this.open;
  }

  /** 主动插入 @ 并打开（可选工具栏按钮） */
  async openFor(ta: HTMLTextAreaElement): Promise<void> {
    this.ta = ta;
    const cur = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cur);
    if (!/(?:^|[\s\n(])@[^\s]*$/.test(before)) {
      const needsSpace = cur > 0 && !/\s$/.test(before);
      const token = `${needsSpace ? " " : ""}@`;
      ta.value = ta.value.slice(0, cur) + token + ta.value.slice(cur);
      const pos = cur + token.length;
      ta.setSelectionRange(pos, pos);
    }
    ta.focus();
    await this.onInput(ta);
  }

  private async onInput(ta: HTMLTextAreaElement): Promise<void> {
    this.ta = ta;
    const cursor = ta.selectionStart ?? ta.value.length;
    const trig = detectAtContext(ta.value, cursor);
    if (!trig) {
      this.hide();
      return;
    }
    this.trigger = trig;
    this.opts.onOpen?.();

    const cwd = this.opts.getCwd()?.trim();
    if (!cwd) {
      this.renderMessage("请先选择项目，以便 @ 引用文件");
      this.position(ta);
      return;
    }

    const mySeq = ++this.seq;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      void this.runSearch(ta, cwd, trig, mySeq);
    }, 80);
  }

  private async runSearch(
    ta: HTMLTextAreaElement,
    cwd: string,
    trig: AtContext,
    mySeq: number,
  ): Promise<void> {
    try {
      const hits = await this.opts.search({
        cwd,
        query: trig.query,
        dirsOnly: trig.dirsOnly,
        includeHidden: trig.hiddenMode,
      });
      if (mySeq !== this.seq || this.ta !== ta) return;
      // 仍在 @ 上下文中
      const cur = ta.selectionStart ?? ta.value.length;
      if (!detectAtContext(ta.value, cur)) {
        this.hide();
        return;
      }
      this.items = hits;
      this.active = 0;
      if (!hits.length) {
        this.renderMessage(
          trig.query
            ? `无匹配文件「${trig.query}」`
            : "未找到可引用文件",
        );
      } else {
        this.render();
      }
      this.position(ta);
    } catch (err) {
      if (mySeq !== this.seq) return;
      this.renderMessage(err instanceof Error ? err.message : String(err));
      this.position(ta);
    }
  }

  private onKeyDown(ta: HTMLTextAreaElement, e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.items.length) return;
      this.active = (this.active + 1) % this.items.length;
      this.render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.items.length) return;
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.render();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (this.items[this.active]) {
        e.preventDefault();
        e.stopPropagation();
        this.pick(this.items[this.active], ta);
      }
      return;
    }
    if (e.key === "Tab" && this.items[this.active]) {
      e.preventDefault();
      e.stopPropagation();
      this.pick(this.items[this.active], ta);
    }
  }

  private renderMessage(msg: string): void {
    this.open = true;
    this.el.classList.remove("hidden");
    this.el.innerHTML = `<div class="at-file-empty">${escapeHtml(msg)}</div>`;
  }

  private render(): void {
    this.open = true;
    this.el.classList.remove("hidden");
    const modeHint = this.trigger?.hiddenMode
      ? `<div class="at-file-mode">${escapeHtml(tr("at.hiddenMode"))}</div>`
      : this.trigger?.dirsOnly
        ? `<div class="at-file-mode">${escapeHtml(tr("at.dirsMode"))}</div>`
        : "";
    this.el.innerHTML =
      modeHint +
      this.items
      .map((h, i) => {
        const active = i === this.active ? " active" : "";
        const ico = h.isDirectory ? "📁" : "📄";
        return `<button type="button" class="at-file-item${active}" role="option" data-idx="${i}" aria-selected="${i === this.active}">
          <span class="at-file-ico" aria-hidden="true">${ico}</span>
          <span class="at-file-body">
            <span class="at-file-name">${escapeHtml(h.name)}${h.isDirectory ? "/" : ""}</span>
            <span class="at-file-path">${escapeHtml(h.path)}</span>
          </span>
        </button>`;
      })
      .join("");
    for (const btn of Array.from(this.el.querySelectorAll(".at-file-item"))) {
      const el = btn as HTMLElement;
      el.onmousedown = (ev) => {
        ev.preventDefault();
        const idx = Number(el.dataset.idx);
        const hit = this.items[idx];
        if (hit && this.ta) this.pick(hit, this.ta);
      };
    }
    const activeEl = this.el.querySelector(
      ".at-file-item.active",
    ) as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }

  private position(ta: HTMLTextAreaElement): void {
    const card = ta.closest(".composer-card") ?? ta;
    const r = card.getBoundingClientRect();
    const maxH = 300;
    const spaceAbove = r.top;
    const placeAbove =
      spaceAbove > maxH + 24 || spaceAbove > window.innerHeight - r.bottom;
    this.el.style.width = `${Math.min(Math.max(r.width, 280), 520)}px`;
    this.el.style.left = `${Math.max(8, r.left)}px`;
    if (placeAbove) {
      this.el.style.top = "auto";
      this.el.style.bottom = `${window.innerHeight - r.top + 6}px`;
      this.el.style.maxHeight = `${Math.min(maxH, spaceAbove - 12)}px`;
    } else {
      this.el.style.bottom = "auto";
      this.el.style.top = `${r.bottom + 6}px`;
      this.el.style.maxHeight = `${Math.min(maxH, window.innerHeight - r.bottom - 16)}px`;
    }
  }

  private pick(hit: AtFileHit, ta: HTMLTextAreaElement): void {
    const cursor = ta.selectionStart ?? ta.value.length;
    const trig =
      this.trigger ?? detectAtContext(ta.value, cursor) ?? null;
    if (!trig) {
      this.hide();
      return;
    }
    // 引用只体现在上方附件 tag，输入框去掉 @token，避免与 chip 重复
    const before = ta.value.slice(0, trig.start);
    const after = ta.value.slice(Math.max(trig.end, cursor));
    // 若 @ 前是空格且 after 以空格开头，合并多余空白
    let b = before;
    let a = after;
    if (/\s$/.test(b) && /^\s/.test(a)) {
      a = a.replace(/^\s+/, "");
    }
    const next = b + a;
    const pos = Math.min(b.length, next.length);
    ta.value = next;
    ta.setSelectionRange(pos, pos);
    this.hide();
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    // 文件/文件夹 → 附件条（发送时注入上下文）
    this.opts.onPick?.(hit);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
