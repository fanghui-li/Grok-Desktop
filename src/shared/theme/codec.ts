/**
 * codex-theme-v1 编解码（对齐 Codex Re / ze / Pe）
 */
import type { ChromeTheme, CodexThemeV1, ThemeVariant } from "./types.js";

export const CODEX_THEME_V1_PREFIX = "codex-theme-v1:";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export class ThemeCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeCodecError";
  }
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export function isChromeTheme(v: unknown): v is ChromeTheme {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (!isHex(t.accent) || !isHex(t.ink) || !isHex(t.surface)) return false;
  if (typeof t.contrast !== "number" || !Number.isInteger(t.contrast)) return false;
  if (t.contrast < 0 || t.contrast > 100) return false;
  if (typeof t.opaqueWindows !== "boolean") return false;
  const fonts = t.fonts as Record<string, unknown> | null;
  if (!fonts || typeof fonts !== "object") return false;
  if (!isNullableString(fonts.ui) || !isNullableString(fonts.code)) return false;
  const sem = t.semanticColors as Record<string, unknown> | null;
  if (!sem || typeof sem !== "object") return false;
  if (!isHex(sem.diffAdded) || !isHex(sem.diffRemoved) || !isHex(sem.skill)) {
    return false;
  }
  return true;
}

export function isCodexThemeV1(v: unknown): v is CodexThemeV1 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.codeThemeId !== "string" || !o.codeThemeId.trim()) return false;
  if (o.variant !== "light" && o.variant !== "dark") return false;
  return isChromeTheme(o.theme);
}

/** 导出：与 Codex `Re()` 一致 */
export function formatCodexThemeV1(payload: CodexThemeV1): string {
  if (!isCodexThemeV1(payload)) {
    throw new ThemeCodecError("Invalid theme payload");
  }
  return CODEX_THEME_V1_PREFIX + JSON.stringify(payload);
}

/**
 * 解析分享串。
 * 支持 `codex-theme-v1:{...}` 或 URI 编码的 JSON 体。
 */
export function parseCodexThemeV1(raw: string): CodexThemeV1 {
  const t = raw.trim();
  if (!t.startsWith(CODEX_THEME_V1_PREFIX)) {
    throw new ThemeCodecError("Theme share string mismatch");
  }
  const body = t.slice(CODEX_THEME_V1_PREFIX.length);
  let jsonText = body;
  if (!body.startsWith("{")) {
    try {
      jsonText = decodeURIComponent(body);
    } catch {
      throw new ThemeCodecError("Theme share string decode failed");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ThemeCodecError("Theme share string is not valid JSON");
  }
  if (!isCodexThemeV1(parsed)) {
    throw new ThemeCodecError("Theme share string failed schema validation");
  }
  return {
    codeThemeId: parsed.codeThemeId.trim(),
    variant: parsed.variant,
    theme: normalizeChromeTheme(parsed.theme),
  };
}

/** 浅合并 chrome（对齐 Codex J()） */
export function mergeChromeTheme(
  base: ChromeTheme,
  patch: Partial<ChromeTheme>,
): ChromeTheme {
  return {
    ...base,
    ...patch,
    fonts:
      patch.fonts == null
        ? base.fonts
        : { ...base.fonts, ...patch.fonts },
    semanticColors:
      patch.semanticColors == null
        ? base.semanticColors
        : { ...base.semanticColors, ...patch.semanticColors },
  };
}

export function normalizeChromeTheme(t: ChromeTheme): ChromeTheme {
  return {
    accent: t.accent.toLowerCase(),
    contrast: Math.max(0, Math.min(100, Math.floor(t.contrast))),
    fonts: {
      ui: t.fonts.ui?.trim() || null,
      code: t.fonts.code?.trim() || null,
    },
    ink: t.ink.toLowerCase(),
    opaqueWindows: Boolean(t.opaqueWindows),
    semanticColors: {
      diffAdded: t.semanticColors.diffAdded.toLowerCase(),
      diffRemoved: t.semanticColors.diffRemoved.toLowerCase(),
      skill: t.semanticColors.skill.toLowerCase(),
    },
    surface: t.surface.toLowerCase(),
  };
}

export function assertVariantMatch(
  payload: CodexThemeV1,
  current: ThemeVariant,
): void {
  if (payload.variant !== current) {
    throw new ThemeCodecError(
      `Theme variant mismatch (share=${payload.variant}, current=${current})`,
    );
  }
}
