/**
 * Map agent / provider error text → responsibility domain (+ optional title key).
 *
 * Presentation:
 * - 提供商 / 中转返回（upstream、config）：「标签 · 原样错误信息」
 * - 本机 / 软件（local、app）：「标签 · 短标题」
 * - 无映射：调用方自行展示原文（不加伪标签）
 */

export type FriendlyErrorTitleKey =
  | "err.apiKeyInvalid"
  | "err.unauthorized"
  | "err.forbidden"
  | "err.modelNotFound"
  | "err.rateLimited"
  | "err.providerUnavailable"
  | "err.badRequest"
  | "err.toolCallInvalid"
  | "err.timeout"
  | "err.network"
  | "err.sessionDisconnected"
  | "err.internal";

/** 责任域：谁的锅（用户可一眼区分软件 / 配置 / 上游） */
export type ErrorDomain = "upstream" | "config" | "local" | "app";

export type ErrorDomainI18nKey =
  | "err.domain.upstream"
  | "err.domain.config"
  | "err.domain.local"
  | "err.domain.app";

export interface FriendlyErrorMatch {
  titleKey: FriendlyErrorTitleKey;
  domain: ErrorDomain;
  domainKey: ErrorDomainI18nKey;
}

const DOMAIN_I18N: Record<ErrorDomain, ErrorDomainI18nKey> = {
  upstream: "err.domain.upstream",
  config: "err.domain.config",
  local: "err.domain.local",
  app: "err.domain.app",
};

/** title → 责任域 */
export function domainForTitleKey(titleKey: FriendlyErrorTitleKey): ErrorDomain {
  switch (titleKey) {
    case "err.apiKeyInvalid":
    case "err.unauthorized":
    case "err.forbidden":
    case "err.modelNotFound":
    case "err.badRequest":
      return "config";
    case "err.rateLimited":
    case "err.providerUnavailable":
    case "err.timeout":
    case "err.network":
      return "upstream";
    case "err.sessionDisconnected":
      return "local";
    case "err.toolCallInvalid":
    case "err.internal":
      return "app";
  }
}

/**
 * 提供商/中转原文展示前轻清理：去壳前缀、压空白；不改写语义。
 * 过长时截断（红条可读），完整内容仍在日志。
 */
export function displayProviderErrorBody(
  text: string,
  maxLen = 280,
): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return s;
  s = s
    .replace(/^side question model call failed:\s*/i, "")
    .replace(/^internal error:\s*/i, "")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

/**
 * Return domain + title key for a known error pattern, or null if unmapped.
 */
export function matchFriendlyError(
  text: string,
): FriendlyErrorMatch | null {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  let titleKey: FriendlyErrorTitleKey | null = null;

  if (
    /invalid[_\s-]?api[_\s-]?key/i.test(s) ||
    /api[_\s-]?key.*(invalid|incorrect|wrong|expired)/i.test(s) ||
    /code["']?\s*:\s*["']?invalid_api_key/i.test(s)
  ) {
    titleKey = "err.apiKeyInvalid";
  } else if (
    /\b401\b/.test(s) ||
    /unauthorized/i.test(s) ||
    /authentication failed/i.test(s)
  ) {
    titleKey = "err.unauthorized";
  } else if (
    /\b403\b/.test(s) ||
    /forbidden/i.test(s) ||
    /permission denied/i.test(s)
  ) {
    titleKey = "err.forbidden";
  } else if (
    /model_not_found/i.test(s) ||
    /model .*not (found|supported)/i.test(s) ||
    /is not supported by any configured/i.test(s)
  ) {
    titleKey = "err.modelNotFound";
  } else if (
    /\b429\b/.test(s) ||
    /rate[_\s-]?limit/i.test(s) ||
    /too many requests/i.test(s) ||
    /upstream rate limit/i.test(s)
  ) {
    titleKey = "err.rateLimited";
  } else if (
    /\b424\b/.test(s) ||
    /failed dependency/i.test(s) ||
    /upstream_error/i.test(s) ||
    /no healthy.*oauth/i.test(s) ||
    /\b502\b/.test(s) ||
    /\b503\b/.test(s) ||
    /\b504\b/.test(s) ||
    /\b524\b/.test(s) ||
    /bad gateway/i.test(s) ||
    /service (temporarily )?unavailable/i.test(s) ||
    /gateway timeout/i.test(s) ||
    (/cloudflare/i.test(s) && /timeout|524/i.test(s)) ||
    /no available channel/i.test(s)
  ) {
    // 中转/网关：无通道、上游 OAuth 池挂、5xx 等
    titleKey = "err.providerUnavailable";
  } else if (
    /name\s*不能为空/i.test(s) ||
    /tool not found/i.test(s) ||
    /parse_failure/i.test(s) ||
    /tool_error/i.test(s)
  ) {
    titleKey = "err.toolCallInvalid";
  } else if (
    /agent process/i.test(s) ||
    /stdin not writable/i.test(s) ||
    /AGENT_CRASHED/i.test(s) ||
    /NOT_ATTACHED/i.test(s) ||
    /No ACP session attached/i.test(s) ||
    /助手进程/i.test(s)
  ) {
    titleKey = "err.sessionDisconnected";
  } else if (
    /timed?\s*out/i.test(s) ||
    /\btimeout\b/i.test(lower) ||
    /请求超时/i.test(s)
  ) {
    titleKey = "err.timeout";
  } else if (
    /network/i.test(s) ||
    /econnrefused/i.test(s) ||
    /enotfound/i.test(s) ||
    /fetch failed/i.test(s) ||
    /socket hang up/i.test(s)
  ) {
    titleKey = "err.network";
  } else if (/^internal error/i.test(s) || lower === "internal error") {
    titleKey = "err.internal";
  } else if (
    /\b400\b/.test(s) ||
    /bad request/i.test(s) ||
    /invalid_request/i.test(s)
  ) {
    titleKey = "err.badRequest";
  } else if (
    // 通用采样/中转外壳：未命中更细规则时仍标上游，正文用原文
    /API error \(status\s+\d+/i.test(s) ||
    /Request URL:\s*https?:\/\//i.test(s)
  ) {
    titleKey = "err.providerUnavailable";
  }

  if (!titleKey) return null;
  const domain = domainForTitleKey(titleKey);
  return {
    titleKey,
    domain,
    domainKey: DOMAIN_I18N[domain],
  };
}

/**
 * @deprecated Prefer {@link matchFriendlyError}; kept for callers that only need the title key.
 */
export function matchFriendlyErrorTitleKey(
  text: string,
): FriendlyErrorTitleKey | null {
  return matchFriendlyError(text)?.titleKey ?? null;
}

/**
 * 拼展示文案。`t` 为 i18n 查找（与 renderer `tr` / shared `t` 兼容）。
 * - upstream / config：标签 · 原样错误信息
 * - local / app：标签 · 短标题
 *
 * @param text 用于模式匹配（可含多段拼接）
 * @param opts.body 提供商原文展示源；缺省用 text（避免 haystack 重复拼接）
 */
export function formatFriendlyErrorLabelTitle(
  text: string,
  t: (key: string) => string,
  opts?: { body?: string },
): string | null {
  const m = matchFriendlyError(text);
  if (!m) return null;
  if (m.domain === "upstream" || m.domain === "config") {
    const body = displayProviderErrorBody(opts?.body ?? text);
    if (!body) return `${t(m.domainKey)} · ${t(m.titleKey)}`;
    return `${t(m.domainKey)} · ${body}`;
  }
  return `${t(m.domainKey)} · ${t(m.titleKey)}`;
}
