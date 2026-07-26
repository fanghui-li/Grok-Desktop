/**
 * Composer 输入框内 slash 命令着色：
 * 在 textarea 下方叠一层 backdrop，按 skill / agent / builtin 上色。
 * 真源仍是 textarea.value；backdrop 仅展示、aria-hidden。
 */
import type { SlashTokenKind } from "../slash/commands.js";

export type SlashKindCatalog = Map<string, SlashTokenKind>;

const COMPOSER_TA_IDS = [
  "composer-input",
  "chat-input",
  "focus-input",
  "btw-side-input",
] as const;

interface Bound {
  ta: HTMLTextAreaElement;
  backdrop: HTMLElement;
  wrap: HTMLElement;
  onInput: () => void;
  onScroll: () => void;
  ro?: ResizeObserver;
}

const bound = new Map<HTMLTextAreaElement, Bound>();
let catalog: SlashKindCatalog = new Map();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 将纯文本转为带 slash 着色的 HTML（保留换行与空格） */
export function renderSlashHighlightHtml(
  text: string,
  kinds: SlashKindCatalog,
): string {
  if (!text) return "";
  // 行首或空白后的 /token（token 允许字母数字 . : _ -）
  const re = /(^|[\s\n])(\/)([A-Za-z0-9][\w.:-]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fullStart = m.index;
    const lead = m[1] ?? "";
    const slash = m[2] ?? "/";
    const name = m[3] ?? "";
    const tokenStart = fullStart + lead.length;
    if (tokenStart > last) {
      out += escapeHtml(text.slice(last, tokenStart));
    }
    const kind = kinds.get(name.toLowerCase()) ?? "unknown";
    const token = slash + name;
    out += `<span class="composer-slash composer-slash--${kind}">${escapeHtml(token)}</span>`;
    last = tokenStart + token.length;
  }
  if (last < text.length) {
    out += escapeHtml(text.slice(last));
  }
  // 末尾换行在 pre-wrap 下可能被吞：补零宽占位
  if (text.endsWith("\n")) {
    out += "\n";
  }
  return out;
}

function syncStyles(ta: HTMLTextAreaElement, backdrop: HTMLElement): void {
  const cs = getComputedStyle(ta);
  backdrop.style.padding = cs.padding;
  backdrop.style.border = cs.border;
  backdrop.style.borderColor = "transparent";
  backdrop.style.font = cs.font;
  backdrop.style.fontSize = cs.fontSize;
  backdrop.style.fontFamily = cs.fontFamily;
  backdrop.style.fontWeight = cs.fontWeight;
  backdrop.style.lineHeight = cs.lineHeight;
  backdrop.style.letterSpacing = cs.letterSpacing;
  backdrop.style.wordSpacing = cs.wordSpacing;
  backdrop.style.textAlign = cs.textAlign;
  backdrop.style.boxSizing = cs.boxSizing;
  backdrop.style.whiteSpace = "pre-wrap";
  backdrop.style.wordWrap = "break-word";
  backdrop.style.overflowWrap = "break-word";
}

function paint(b: Bound): void {
  const { ta, backdrop } = b;
  const text = ta.value;
  // 无 slash 时清空，避免空层干扰
  if (!text.includes("/")) {
    backdrop.innerHTML = "";
    ta.classList.remove("has-slash-highlight");
    return;
  }
  ta.classList.add("has-slash-highlight");
  backdrop.innerHTML = renderSlashHighlightHtml(text, catalog);
  backdrop.scrollTop = ta.scrollTop;
  backdrop.scrollLeft = ta.scrollLeft;
}

function ensureWrap(ta: HTMLTextAreaElement): Bound {
  const existing = bound.get(ta);
  if (existing) return existing;

  const parent = ta.parentElement;
  if (!parent) {
    throw new Error("composer slash highlight: no parent");
  }

  // 已包过则复用
  let wrap = ta.closest(".composer-input-highlight") as HTMLElement | null;
  let backdrop: HTMLElement;
  if (wrap) {
    backdrop =
      (wrap.querySelector(".composer-slash-backdrop") as HTMLElement) ||
      document.createElement("div");
  } else {
    wrap = document.createElement("div");
    wrap.className = "composer-input-highlight";
    parent.insertBefore(wrap, ta);
    wrap.appendChild(ta);
    backdrop = document.createElement("div");
  }

  backdrop.className = "composer-slash-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  if (!backdrop.parentElement) {
    wrap.insertBefore(backdrop, ta);
  }
  ta.classList.add("composer-input-ta");

  const onInput = () => paint(b);
  const onScroll = () => {
    backdrop.scrollTop = ta.scrollTop;
    backdrop.scrollLeft = ta.scrollLeft;
  };
  const b: Bound = { ta, backdrop, wrap, onInput, onScroll };
  ta.addEventListener("input", onInput);
  ta.addEventListener("scroll", onScroll);
  // 程序化 set value 后可能不触发 input：暴露 refresh
  if (typeof ResizeObserver !== "undefined") {
    b.ro = new ResizeObserver(() => {
      syncStyles(ta, backdrop);
      paint(b);
    });
    b.ro.observe(ta);
  }
  syncStyles(ta, backdrop);
  bound.set(ta, b);
  paint(b);
  return b;
}

/** 更新命令目录并重绘所有已绑定输入框 */
export function setSlashHighlightCatalog(kinds: SlashKindCatalog): void {
  catalog = kinds;
  for (const b of bound.values()) paint(b);
}

/** 绑定主 composer 输入框 */
export function bindComposerSlashHighlight(
  ids: readonly string[] = COMPOSER_TA_IDS,
): void {
  for (const id of ids) {
    const ta = document.getElementById(id) as HTMLTextAreaElement | null;
    if (ta) {
      try {
        ensureWrap(ta);
      } catch {
        /* ignore missing parent */
      }
    }
  }
}

/** 在程序化改 value 后调用（slash pick / 历史召回等） */
export function refreshComposerSlashHighlight(
  ta?: HTMLTextAreaElement | null,
): void {
  if (ta) {
    const b = bound.get(ta) ?? (ta.parentElement ? ensureWrap(ta) : null);
    if (b) {
      syncStyles(b.ta, b.backdrop);
      paint(b);
    }
    return;
  }
  for (const b of bound.values()) {
    syncStyles(b.ta, b.backdrop);
    paint(b);
  }
}
