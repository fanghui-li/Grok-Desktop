/**
 * agent/provider 错误 → 可展示文案（纯格式化，无 DOM）。
 */
import { formatFriendlyErrorLabelTitle } from "../../shared/friendly-error-title.js";
import { tr } from "../../shared/i18n/index.js";

/**
 * - 提供商/中转（有映射且域为上游/配置）：责任域 · 原样错误信息
 * - 本机/软件：责任域 · 短标题
 * - 无映射：短原文（不加伪标签）
 */
export function formatTurnErrorMessage(
  message: string | undefined,
  details?: unknown,
): string {
  const raw = (message ?? "").trim() || "";
  const isGenericShell = (s: string) =>
    !s ||
    /^internal error\.?$/i.test(s) ||
    s === "ACP error" ||
    /^method not found\.?$/i.test(s);

  const tryMsg = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      // 纯字符串 data（CLI btw 等）本身即真因
      return isGenericShell(t) ? null : t;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // 优先 data：message 常为 "Internal error" 外壳
      if (o.data != null) {
        const fromData = tryMsg(o.data);
        if (fromData) return fromData;
      }
      if (typeof o.message === "string" && o.message.trim()) {
        const m = o.message.trim();
        if (!isGenericShell(m)) return m;
      }
      if (typeof o.error_message === "string" && o.error_message.trim()) {
        return o.error_message.trim();
      }
    }
    return null;
  };
  let detail: string | null = null;
  const brace = raw.indexOf("{");
  if (brace >= 0) {
    try {
      detail = tryMsg(JSON.parse(raw.slice(brace)));
    } catch {
      /* ignore */
    }
  }
  if (!detail && details != null) detail = tryMsg(details);

  // raw 本身已是 enrich 后的真因时，直接参与匹配
  const primary = raw && !isGenericShell(raw) ? raw : detail || raw;
  // 匹配可用多段；提供商正文只用单条真因（避免 haystack 重复）
  const bodySource =
    (detail && !isGenericShell(detail) ? detail : null) ||
    (primary && !isGenericShell(primary) ? primary : null) ||
    raw;
  const haystack = [bodySource, detail, raw].filter(Boolean).join("\n");
  const labeled = formatFriendlyErrorLabelTitle(haystack, tr, {
    body: bodySource,
  });
  if (labeled) return labeled;

  // 未映射：取首行短标题，去掉 Internal error 外壳（不加伪责任域）
  let line =
    (detail && !isGenericShell(detail) ? detail : primary || tr("err.internal"))
      .split(/\r?\n/)[0]
      ?.trim() || tr("err.internal");
  line = line.replace(/^internal error:\s*/i, "").trim() || tr("err.internal");
  // 侧问常见前缀：缩短展示
  line =
    line.replace(/^side question model call failed:\s*/i, "").trim() || line;
  if (isGenericShell(line) || line === tr("err.internal")) {
    return `${tr("err.domain.app")} · ${tr("err.internal")}`;
  }
  if (line.length > 80) line = line.slice(0, 80) + "…";
  return line;
}
