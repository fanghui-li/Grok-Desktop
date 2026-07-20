/**
 * 助手消息 Markdown 渲染（对齐 Codex/Claude 对话区）
 * - GFM 表格 / 列表 / 代码块
 * - highlight.js 语法高亮
 * - DOMPurify 消毒
 * - 流式未闭合 fence 容错
 */
import { marked, type Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";
import DOMPurify from "dompurify";
import { isLinkableFilePath, linkifyFilePaths } from "./file-links.js";
import { isDiffLanguage, renderDiffBlockHtml } from "./diff-view.js";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", shell);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 流式时未闭合的 ``` 自动补闭，避免正文被吞进代码块 */
export function fixStreamingFences(src: string): string {
  // 只计行首 fence（标准 GFM）
  const lines = src.split("\n");
  let open = 0;
  for (const line of lines) {
    if (/^```/.test(line)) open ^= 1;
  }
  if (open) return src + "\n```";
  return src;
}

function highlightCode(code: string, lang?: string): string {
  const raw = lang?.trim().toLowerCase() || "";
  const alias =
    raw === "js" || raw === "javascript"
      ? "javascript"
      : raw === "ts" || raw === "typescript" || raw === "tsx"
        ? "typescript"
        : raw === "py"
          ? "python"
          : raw === "sh"
            ? "bash"
            : raw || "plaintext";
  try {
    if (alias && hljs.getLanguage(alias)) {
      return hljs.highlight(code, { language: alias, ignoreIllegals: true })
        .value;
    }
  } catch {
    /* fall through */
  }
  return hljs.highlight(code, { language: "plaintext", ignoreIllegals: true })
    .value;
}

/** 是否对代码块做 hljs（流式关闭，定稿开启） */
let highlightEnabled = true;

const mdRenderer = new marked.Renderer();

mdRenderer.code = function codeToken({ text, lang }: Tokens.Code): string {
  const language = (lang || "").trim();
  // Diff / patch：专用绿红行视图（可点路径）
  if (isDiffLanguage(language)) {
    return renderDiffBlockHtml(text);
  }
  const langLabel = language || "text";
  // 轻量路径可关 hljs；流式阶段我们根本不 parse，定稿默认开高亮
  const body = highlightEnabled
    ? highlightCode(text, language)
    : escAttr(text);
  return (
    `<div class="code-block">` +
    `<div class="code-block-head">` +
    `<span class="code-lang">${escAttr(langLabel)}</span>` +
    `<button type="button" class="code-copy" data-copy-code title="Copy">Copy</button>` +
    `</div>` +
    `<pre><code class="hljs language-${escAttr(langLabel)}">${body}</code></pre>` +
    `</div>`
  );
};

/** 标题 slug，供 # 锚点滚动 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

mdRenderer.heading = function headingToken({
  tokens,
  depth,
}: Tokens.Heading): string {
  const body = this.parser.parseInline(tokens);
  const plain = body.replace(/<[^>]+>/g, "");
  const id = slugifyHeading(plain);
  return `<h${depth} id="${escAttr(id)}">${body}</h${depth}>\n`;
};

mdRenderer.link = function linkToken({
  href,
  title,
  text,
}: Tokens.Link): string {
  const raw = (href || "").trim();
  const t = title ? ` title="${escAttr(title)}"` : "";
  const h = escAttr(raw);
  // 外链：不使用 target=_blank（Electron 会黑屏/空窗）；交给点击委托 + openExternal
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    return `<a href="${h}" class="md-external-link" data-external-url="${h}" rel="noopener noreferrer"${t}>${text}</a>`;
  }
  // 页内锚点
  if (raw.startsWith("#")) {
    return `<a href="${h}" class="md-anchor-link" data-anchor-id="${escAttr(raw.slice(1))}"${t}>${text}</a>`;
  }
  // file: 或像真实文件的路径 → md-path-link，由 linkifyFilePaths 转 file-link
  // 不把 /sessions/、纯目录、无扩展伪路径标成可点（避免大量 FIL 空按钮）
  if (/^file:/i.test(raw)) {
    return `<a href="${h}" class="md-path-link" data-md-path="${h}"${t}>${text}</a>`;
  }
  let checkPath = raw;
  const lineM = /^(.+):(\d{1,7})(?::\d{1,7})?$/.exec(raw);
  if (
    lineM &&
    !/^[A-Za-z]:[\\/]/.test(raw) &&
    !/^[A-Za-z]:$/.test(lineM[1] ?? "")
  ) {
    checkPath = lineM[1]!;
  }
  if (isLinkableFilePath(checkPath)) {
    return `<a href="${h}" class="md-path-link" data-md-path="${h}"${t}>${text}</a>`;
  }
  return `<a href="${h}"${t}>${text}</a>`;
};

marked.setOptions({
  gfm: true,
  breaks: false,
  // marked 类型参数过严，运行时无问题
  renderer: mdRenderer as never,
});

export type RenderMdOpts = {
  /** 语法高亮；默认 true。流式中间态应 false */
  highlight?: boolean;
  /** 是否补闭合 fence；流式 true、定稿 true */
  fixFences?: boolean;
};

export function renderMarkdownToSafeHtml(
  raw: string,
  opts?: RenderMdOpts,
): string {
  const prev = highlightEnabled;
  highlightEnabled = opts?.highlight !== false;
  const fix = opts?.fixFences !== false;
  const src = fix ? fixStreamingFences(raw) : raw;
  let html: string;
  try {
    html = marked.parse(src, { async: false }) as string;
  } catch {
    html = `<p>${escAttr(raw).replace(/\n/g, "<br>")}</p>`;
  } finally {
    highlightEnabled = prev;
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      "target",
      "rel",
      "class",
      "id",
      "data-copy-code",
      "data-copy-source",
      "data-file-path",
      "data-line",
      "data-tool-id",
      "data-tool-kind",
      "data-external-url",
      "data-md-path",
      "data-anchor-id",
      "title",
      "href",
      "role",
      "type",
    ],
    ADD_TAGS: ["button"],
  });
}

/**
 * 流式阶段：纯文本追加，零解析成本。
 * 定稿阶段再 paintAssistantHtml 全量 Markdown。
 */
export function paintAssistantStreaming(el: HTMLElement, raw: string): void {
  el.dataset.raw = raw;
  el.dataset.stream = "1";
  el.classList.add("prose", "streaming");
  // textContent 最快，保留换行靠 CSS white-space
  el.textContent = raw;
}

/** 定稿：完整 Markdown + 高亮 + 消毒 + 路径链化（每条消息只应调用 1 次） */
export function paintAssistantHtml(
  el: HTMLElement,
  raw: string,
  opts?: RenderMdOpts & { cwd?: string | null },
): void {
  el.dataset.raw = raw;
  delete el.dataset.stream;
  el.classList.add("prose");
  el.classList.remove("streaming");
  el.innerHTML = renderMarkdownToSafeHtml(raw, {
    highlight: opts?.highlight !== false,
    fixFences: opts?.fixFences !== false,
  });
  // Codex/Claude：路径可点 → 打开编辑器（cwd 解析相对路径）
  linkifyFilePaths(el, opts?.cwd ?? null);
}

/**
 * 链接分流点击：
 * - http(s)/mailto → openExternal
 * - #锚点 → 页内 scrollIntoView
 * - file-link 交给 bindFileLinkDelegate
 */
export function bindExternalLinkDelegate(
  root: HTMLElement,
  openExternal: (url: string) => void | Promise<void>,
): void {
  root.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // 文件路径委托优先
      if (t.closest("a.file-link, button.file-link, [data-file-path].file-link")) {
        return;
      }
      const a = t.closest(
        "a[href], a[data-external-url], a.md-anchor-link",
      ) as HTMLAnchorElement | null;
      if (!a) return;

      // # 锚点：在最近 prose/md 预览或全文内滚动
      const anchorRaw =
        a.getAttribute("data-anchor-id") ||
        (a.getAttribute("href")?.startsWith("#")
          ? a.getAttribute("href")!.slice(1)
          : "");
      if (a.classList.contains("md-anchor-link") || (a.getAttribute("href") || "").startsWith("#")) {
        e.preventDefault();
        e.stopPropagation();
        const id = decodeURIComponent(anchorRaw || "").trim();
        if (!id) return;
        const scope =
          (a.closest(".prose, .md-preview, #transcript, #app") as HTMLElement | null) ??
          document.body;
        let target: HTMLElement | null = null;
        try {
          target = scope.querySelector(`#${CSS.escape(id)}`);
        } catch {
          target = document.getElementById(id);
        }
        if (!target) {
          // 兼容 GitHub 风格：空格变 - 的二次匹配
          const slug = slugifyHeading(id);
          target =
            scope.querySelector(`#${CSS.escape(slug)}`) ||
            document.getElementById(slug);
        }
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      const href =
        (a.getAttribute("data-external-url") || a.getAttribute("href") || "").trim();
      if (!href || href === "#") return;
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        void openExternal(href);
      }
    },
    true,
  );
}

/** 在 transcript 上挂一次复制委托 */
export function bindCodeCopyDelegate(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    const btn = t?.closest?.("[data-copy-code]") as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const block = btn.closest(".code-block, .diff-block");
    // diff 优先复制隐藏 raw；普通代码块复制 code
    const raw = block?.querySelector(".diff-raw-hidden code");
    const code = raw ?? block?.querySelector("code");
    const text = code?.textContent ?? "";
    if (!text) return;
    const done = () => {
      const prev = btn.textContent;
      btn.textContent = "已复制";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = prev || "复制";
        btn.classList.remove("copied");
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(done).catch(() => {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  });
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  ta.remove();
}
