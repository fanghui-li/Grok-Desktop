/**
 * Composer 上方/旁侧斜杠命令浮层（Codex 式列表）
 *
 * 选中语义：
 * - Tab：一律只补全 `/name `（+ hint），不执行
 * - Enter / 点击：按 acceptMode — run 执行 / insert 补全 / compose 编写态
 */
import { tr } from "../shared/i18n/index.js";
import {
  buildSlashInsertText,
  filterSlashCommands,
  getSlashTrigger,
  replaceSlashToken,
  resolveAcceptMode,
  slashInsertToken,
  stripSlashToken,
  type SlashCommandDef,
} from "./slash-commands.js";
import { refreshComposerSlashHighlight } from "./composer-slash-highlight.js";

export type SlashRunResult =
  | { ok: true; message?: string }
  | { ok: false; message?: string };

export interface SlashPaletteOptions {
  getCommands: () => SlashCommandDef[] | Promise<SlashCommandDef[]>;
  onRun: (cmd: SlashCommandDef) => void | Promise<SlashRunResult | void>;
  /** 可选：执行后提示 */
  onMessage?: (text: string, kind?: "info" | "error") => void;
  /** 打开浮层时（用于关闭 @ 面板等） */
  onOpen?: () => void;
  /** 命令列表加载后（用于输入框 slash 着色目录） */
  onCommandsLoaded?: (cmds: SlashCommandDef[]) => void;
}

export class SlashPaletteController {
  private el: HTMLElement;
  private open = false;
  private items: SlashCommandDef[] = [];
  private active = 0;
  private trigger: { start: number; query: string } | null = null;
  private ta: HTMLTextAreaElement | null = null;
  private cache: SlashCommandDef[] | null = null;

  constructor(private readonly opts: SlashPaletteOptions) {
    this.el = document.createElement("div");
    this.el.id = "slash-palette";
    this.el.className = "slash-palette hidden";
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", tr("slash.aria"));
    document.body.appendChild(this.el);
  }

  /** 绑定一个 composer textarea */
  attach(ta: HTMLTextAreaElement): void {
    ta.addEventListener("input", () => void this.onInput(ta));
    ta.addEventListener("keydown", (e) => this.onKeyDown(ta, e), true);
    ta.addEventListener("blur", () => {
      // 延迟，允许 mousedown 选中
      setTimeout(() => {
        if (document.activeElement !== ta) this.hide();
      }, 150);
    });
    ta.addEventListener("click", () => void this.onInput(ta));
  }

  /** 主动打开（工具栏 / 按钮） */
  async openFor(ta: HTMLTextAreaElement): Promise<void> {
    this.ta = ta;
    const cur = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cur);
    if (!/(?:^|[\s\n])\/[^\s]*$/.test(before)) {
      const insertAt = cur;
      const needsSpace = insertAt > 0 && !/\s$/.test(ta.value.slice(0, insertAt));
      const token = `${needsSpace ? " " : ""}/`;
      ta.value = ta.value.slice(0, insertAt) + token + ta.value.slice(insertAt);
      const pos = insertAt + token.length;
      ta.setSelectionRange(pos, pos);
    }
    ta.focus();
    await this.onInput(ta);
  }

  hide(): void {
    this.open = false;
    this.trigger = null;
    this.el.classList.add("hidden");
    this.el.innerHTML = "";
  }

  isOpen(): boolean {
    return this.open;
  }

  private async loadCommands(): Promise<SlashCommandDef[]> {
    if (this.cache) return this.cache;
    const list = await this.opts.getCommands();
    this.cache = list;
    this.opts.onCommandsLoaded?.(list);
    // 短缓存，skills 变化时可 invalidate
    setTimeout(() => {
      this.cache = null;
    }, 5000);
    return list;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async onInput(ta: HTMLTextAreaElement): Promise<void> {
    this.ta = ta;
    const cursor = ta.selectionStart ?? ta.value.length;
    const trig = getSlashTrigger(ta.value, cursor);
    if (!trig) {
      this.hide();
      return;
    }
    this.trigger = trig;
    this.opts.onOpen?.();
    const all = await this.loadCommands();
    this.items = filterSlashCommands(all, trig.query);
    this.active = 0;
    if (this.items.length === 0) {
      this.renderEmpty(trig.query);
      this.position(ta);
      return;
    }
    this.render();
    this.position(ta);
  }

  private onKeyDown(ta: HTMLTextAreaElement, e: KeyboardEvent): void {
    if (!this.open) {
      // Ctrl+/ 打开
      if (e.ctrlKey && e.key === "/") {
        e.preventDefault();
        void this.openFor(ta);
      }
      return;
    }
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
        void this.pick(this.items[this.active], ta, "accept");
      }
      return;
    }
    // Tab：只补全，不执行（对齐 Codex complete-query）
    if (e.key === "Tab" && this.items[this.active]) {
      e.preventDefault();
      e.stopPropagation();
      void this.pick(this.items[this.active], ta, "complete");
    }
  }

  private renderEmpty(query: string): void {
    this.open = true;
    this.el.classList.remove("hidden");
    this.el.innerHTML = `<div class="slash-empty">${escapeHtml(
      query ? tr("slash.noMatchQ", { q: query }) : tr("slash.noMatch"),
    )}</div>`;
  }

  private render(): void {
    this.open = true;
    this.el.classList.remove("hidden");
    // 静态命令 / agent 广告 / skills 三分区（P3 轻量分组）
    const builtins = this.items.filter(
      (c) => !c.dynamic && !c.id.startsWith("acp:"),
    );
    const agentCmds = this.items.filter(
      (c) => c.dynamic && c.id.startsWith("acp:"),
    );
    const skills = this.items.filter(
      (c) => c.dynamic && c.id.startsWith("skill:"),
    );
    // 其它 dynamic（兜底）并入 skills 区
    const otherDyn = this.items.filter(
      (c) =>
        c.dynamic &&
        !c.id.startsWith("acp:") &&
        !c.id.startsWith("skill:"),
    );
    const skillGroup = [...skills, ...otherDyn];
    const parts: string[] = [];

    const renderItem = (c: SlashCommandDef, i: number) => {
      const active = i === this.active ? " active" : "";
      const mode = resolveAcceptMode(c);
      const skillCls = c.id.startsWith("skill:")
        ? " slash-item-skill"
        : c.id.startsWith("acp:")
          ? " slash-item-agent"
          : "";
      const modeCls =
        mode === "insert"
          ? " is-insert"
          : mode === "compose"
            ? " is-compose"
            : " is-run";
      const badge = c.badge
        ? `<span class="slash-item-badge">${escapeHtml(c.badge)}</span>`
        : "";
      const hint = c.argumentHint?.trim();
      const hintEl = hint
        ? `<span class="slash-item-hint" title="${escapeHtml(hint)}">${escapeHtml(hint)}</span>`
        : "";
      // 右侧动作提示：补全 / 执行（P2–P3 可见性）
      const aff =
        mode === "insert" || mode === "compose"
          ? `<span class="slash-item-affordance" aria-hidden="true">${escapeHtml(tr("slash.affordanceInsert"))}</span>`
          : `<span class="slash-item-affordance slash-item-affordance-run" aria-hidden="true">${escapeHtml(tr("slash.affordanceRun"))}</span>`;
      const titleMain = c.id.startsWith("skill:")
        ? `/${c.title}`
        : c.title.startsWith("/")
          ? c.title
          : c.title;
      return `<button type="button" class="slash-item${skillCls}${modeCls}${active}" role="option" data-idx="${i}" aria-selected="${i === this.active}">
          <span class="slash-item-ico" aria-hidden="true">${escapeHtml(c.icon ?? "·")}</span>
          <span class="slash-item-body">
            <span class="slash-item-title-row">
              <span class="slash-item-title">${escapeHtml(titleMain)}</span>
              ${hintEl}
            </span>
            <span class="slash-item-desc">${escapeHtml(c.description)}</span>
          </span>
          ${badge}
          ${aff}
        </button>`;
    };

    const pushGroup = (label: string | null, list: SlashCommandDef[]) => {
      if (!list.length) return;
      if (label) {
        parts.push(
          `<div class="slash-section" role="presentation">${escapeHtml(label)}</div>`,
        );
      }
      for (const c of list) {
        const i = this.items.indexOf(c);
        if (i >= 0) parts.push(renderItem(c, i));
      }
    };

    pushGroup(null, builtins);
    pushGroup(tr("slash.sectionAgent"), agentCmds);
    pushGroup(tr("slash.sectionSkills"), skillGroup);

    this.el.innerHTML = parts.join("");
    for (const btn of Array.from(this.el.querySelectorAll(".slash-item"))) {
      const el = btn as HTMLElement;
      el.onmousedown = (ev) => {
        ev.preventDefault();
        const idx = Number(el.dataset.idx);
        const cmd = this.items[idx];
        if (cmd && this.ta) void this.pick(cmd, this.ta, "accept");
      };
    }
    const activeEl = this.el.querySelector(
      ".slash-item.active",
    ) as HTMLElement | null;
    activeEl?.scrollIntoView({ block: "nearest" });
  }

  private position(ta: HTMLTextAreaElement): void {
    const card = ta.closest(".composer-card") ?? ta;
    const r = card.getBoundingClientRect();
    const maxH = 320;
    const spaceAbove = r.top;
    const placeAbove = spaceAbove > maxH + 24 || spaceAbove > window.innerHeight - r.bottom;
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

  /**
   * @param mode accept = Enter/点击（按 acceptMode）；complete = Tab 只补全
   */
  private async pick(
    cmd: SlashCommandDef,
    ta: HTMLTextAreaElement,
    mode: "accept" | "complete",
  ): Promise<void> {
    const cursor = ta.selectionStart ?? ta.value.length;
    const trig = this.trigger ?? getSlashTrigger(ta.value, cursor);
    const accept = resolveAcceptMode(cmd);

    // Tab 一律补全；insert 的 accept 也只补全；compose/run 的 accept 走执行
    const onlyComplete = mode === "complete" || accept === "insert";

    if (onlyComplete) {
      const token = slashInsertToken(cmd);
      // 只补全 `/name `；argumentHint 仅在列表展示，不预填进输入框
      // （避免把「侧问内容」等占位文案当真实参数发出）
      const ins = buildSlashInsertText(token);
      if (trig) {
        const { text, cursor: c } = replaceSlashToken(
          ta.value,
          trig.start,
          cursor,
          ins,
        );
        ta.value = text;
        ta.setSelectionRange(c, c);
      } else {
        ta.value = ins;
        ta.setSelectionRange(ins.length, ins.length);
      }
      this.hide();
      ta.focus();
      // 触发 input，便于其它监听（高度自适应等）
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      refreshComposerSlashHighlight(ta);
      // 不 toast：输入框里的 `/name ` 即反馈；避免每次点选刷提示
      return;
    }

    // run / compose：剥掉 /query 后执行
    if (trig) {
      const { text, cursor: c } = stripSlashToken(ta.value, trig.start, cursor);
      ta.value = text;
      ta.setSelectionRange(c, c);
    }
    this.hide();
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    refreshComposerSlashHighlight(ta);
    try {
      const res = await this.opts.onRun(cmd);
      if (res && res.message) {
        this.opts.onMessage?.(res.message, res.ok === false ? "error" : "info");
      }
    } catch (err) {
      this.opts.onMessage?.(String(err), "error");
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
