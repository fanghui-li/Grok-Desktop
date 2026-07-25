/**
 * ChromeTheme → CSS token 表（对齐 Codex Desktop 推导语义）。
 *
 * 证据：Codex asar `diff-view-mode-*.js`
 * - 主字 = ink；次级字 = ink 的较高 alpha（随 contrast）
 * - 背景层级 = surface↔ink / 黑白 lerp，系数随 contrast
 * - contrast 先相对 light=45 / dark=60 做归一化
 *
 * 输出映射到 Grok Desktop 现有 `--text*` / `--bg-*` 等变量，不照搬 Codex 命名。
 */
import type { ChromeTheme, ThemeVariant } from "./types.js";

export type ThemeCssTokens = Record<string, string>;

type Rgb = { r: number; g: number; b: number };

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Codex 默认 contrast 锚点 */
const BASELINE: Record<ThemeVariant, number> = { light: 45, dark: 60 };
const CONTRAST_SLOPE = 0.7;
const CONTRAST_BOOST = 2;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t);
  return {
    r: lerpChannel(a.r, b.r, u),
    g: lerpChannel(a.g, b.g, u),
    b: lerpChannel(a.b, b.b, u),
  };
}

function toHex(c: Rgb): string {
  const x = (n: number) =>
    Math.min(255, Math.max(0, n)).toString(16).padStart(2, "0");
  return `#${x(c.r)}${x(c.g)}${x(c.b)}`;
}

function toRgba(c: Rgb, alpha: number): string {
  const a = clamp01(alpha);
  // 与 Codex 一致：去掉尾随 0
  const s = a
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${s})`;
}

/**
 * Codex `me(contrast, variant)`：把 0–100 滑条映射为有效 contrast 系数。
 * 低于锚点线性；高于锚点再放大。
 */
export function normalizeContrast(
  contrast: number,
  variant: ThemeVariant,
): number {
  const baseline = BASELINE[variant];
  const c = Math.min(100, Math.max(0, Math.round(contrast)));
  const base = baseline / 100;
  const linear = c / 100 + ((c - baseline) / 60) * CONTRAST_SLOPE;
  if (c <= baseline) return clamp01(linear);
  return clamp01(base + (linear - base) * CONTRAST_BOOST);
}

/** 相对亮度（sRGB，WCAG 近似） */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 对比比（1–21） */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const L1 = relativeLuminance(fgHex);
  const L2 = relativeLuminance(bgHex);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 次级文字是否可能偏弱（用于设置页提示）。
 * 用 solid mix 近似 secondary alpha 后与 surface 比。
 */
export function isLowContrastChrome(
  theme: ChromeTheme,
  variant: ThemeVariant,
): boolean {
  const c = normalizeContrast(theme.contrast, variant);
  const ink = parseHex(theme.ink);
  const surface = parseHex(theme.surface);
  // secondary ≈ ink alpha 0.65+c*0.1 → solid 近似用 alpha 当 mix 到 surface
  const secA = Math.max(0.55, 0.65 + c * 0.1);
  const sec = toHex(lerpRgb(surface, ink, secA));
  return contrastRatio(sec, theme.surface) < 3.0;
}

/**
 * 从 chrome + variant 派生完整 CSS 变量表。
 */
export function deriveChromeCssTokens(
  theme: ChromeTheme,
  variant: ThemeVariant,
): ThemeCssTokens {
  const c = normalizeContrast(theme.contrast, variant);
  const surface = parseHex(theme.surface);
  const ink = parseHex(theme.ink);
  const accent = parseHex(theme.accent);

  // ── 文字：Codex textForeground / Secondary / Tertiary ──
  // secondary: 0.65 + c*0.1；tertiary: light 0.45+c*0.1 / dark 0.42+c*0.13
  // floor：避免滑条过低时糊成灰
  const text2A = Math.max(0.58, Math.min(0.92, 0.65 + c * 0.1));
  const text3Base = variant === "dark" ? 0.42 + c * 0.13 : 0.45 + c * 0.1;
  const text3A = Math.max(0.48, Math.min(0.8, text3Base));

  // solid 兜底（部分组件不吃 rgba 继承）：surface→ink lerp
  const text2Solid = toHex(lerpRgb(surface, ink, text2A));
  const text3Solid = toHex(lerpRgb(surface, ink, text3A));

  // ── 背景层级（Codex 壳层）──
  // chrome/shell：侧栏 + 顶栏 + 窗口底 同色
  // content/main：中间会话 / 设置右栏 独立卡片
  let bgShell: string;
  let bgMain: string;
  let bgElevated: string;
  let bgMuted: string;
  let bgHover: string;
  let bgActive: string;

  if (variant === "light") {
    const surfaceLum = relativeLuminance(theme.surface);
    if (surfaceLum >= 0.9) {
      // surface 近白（默认浅色）：外壳略压成灰，主区纯白卡片
      bgShell = toHex(lerpRgb(surface, ink, 0.045 + c * 0.03));
      bgMain = "#ffffff";
    } else {
      // 有色 surface：外壳=surface，主区掺白抬亮
      bgShell = theme.surface;
      bgMain = toHex(lerpRgb(surface, WHITE, 0.5 + c * 0.25));
    }
    const shellRgb = parseHex(bgShell);
    bgMuted = toHex(lerpRgb(shellRgb, ink, 0.04 + c * 0.03));
    bgHover = toHex(lerpRgb(shellRgb, ink, 0.07 + c * 0.04));
    bgActive = toHex(lerpRgb(shellRgb, ink, 0.11 + c * 0.05));
    bgElevated = toHex(lerpRgb(parseHex(bgMain), WHITE, 0.02));
  } else {
    // 深色：外壳=surface，主区掺 ink 略抬亮
    bgShell = theme.surface;
    bgMain = toHex(lerpRgb(surface, ink, 0.07 + c * 0.05));
    bgMuted = toHex(lerpRgb(surface, ink, 0.05 + c * 0.04));
    bgHover = toHex(lerpRgb(surface, ink, 0.08 + c * 0.05));
    bgActive = toHex(lerpRgb(surface, ink, 0.12 + c * 0.06));
    bgElevated = toHex(lerpRgb(surface, ink, 0.1 + c * 0.05));
  }

  // 边框：相对 chrome shell 的 ink 混色
  const shellRgbForBorder = parseHex(bgShell);
  const borderA = Math.max(0.08, 0.06 + c * 0.04);
  const borderSoftA = Math.max(0.05, 0.04 + c * 0.02);
  const border = toHex(lerpRgb(shellRgbForBorder, ink, borderA * 1.4));
  const borderSoft = toHex(
    lerpRgb(shellRgbForBorder, ink, borderSoftA * 1.4),
  );

  // soft 语义底：落在主内容区底上更自然
  const mainRgb = parseHex(bgMain);
  const okSoft = toHex(
    lerpRgb(mainRgb, parseHex(theme.semanticColors.diffAdded), 0.14),
  );
  const dangerSoft = toHex(
    lerpRgb(mainRgb, parseHex(theme.semanticColors.diffRemoved), 0.14),
  );
  const skillSoft = toHex(
    lerpRgb(mainRgb, parseHex(theme.semanticColors.skill), 0.14),
  );
  const infoSoft = toHex(lerpRgb(mainRgb, accent, 0.12));
  // orange soft：固定橙掺 main
  const orange = variant === "dark" ? "#f0714a" : "#e05a2b";
  const orangeSoft = toHex(lerpRgb(mainRgb, parseHex(orange), 0.16));
  const warn = variant === "dark" ? "#fbbf24" : "#b45309";
  const warnSoft = toHex(lerpRgb(mainRgb, parseHex(warn), 0.14));

  const tokens: ThemeCssTokens = {
    // 外壳：侧栏 / titlebar / 设置左栏 / 窗口底 —— 同色
    "--bg": bgShell,
    "--bg-sidebar": bgShell,
    // 中间会话卡片 / 设置内容区
    "--bg-main": bgMain,
    "--bg-card": bgMain,
    "--bg-elevated": bgElevated,
    "--bg-muted": bgMuted,
    "--bg-hover": bgHover,
    "--bg-active": bgActive,
    "--border": border,
    "--border-soft": borderSoft,
    "--text": theme.ink,
    // 优先 solid，保证对比可预期；alpha 作补充不写
    "--text-2": text2Solid,
    "--text-3": text3Solid,
    "--accent": theme.accent,
    "--accent-contrast": theme.surface,
    "--ok": theme.semanticColors.diffAdded,
    "--danger": theme.semanticColors.diffRemoved,
    "--skill": theme.semanticColors.skill,
    "--ok-soft": okSoft,
    "--danger-soft": dangerSoft,
    "--info": theme.accent,
    "--info-soft": infoSoft,
    "--orange": orange,
    "--orange-soft": orangeSoft,
    "--warn": warn,
    "--warn-soft": warnSoft,
    "--skill-soft": skillSoft,
    "--file-link": theme.accent,
    "--file-link-underline": toRgba(accent, 0.45),
    "--file-link-hover-bg": toRgba(accent, 0.06),
    "--shadow":
      variant === "dark"
        ? "0 8px 32px rgba(0, 0, 0, 0.45)"
        : "0 4px 24px rgba(0, 0, 0, 0.06)",
  };

  if (theme.fonts.ui) {
    tokens["--font"] =
      `"${theme.fonts.ui}", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
  }
  if (theme.fonts.code) {
    tokens["--font-mono"] =
      `"${theme.fonts.code}", ui-monospace, "Cascadia Code", Consolas, monospace`;
  }

  return tokens;
}

/** 所有 derive 可能写入的 key（clear 时用） */
export const DERIVED_CSS_KEYS: readonly string[] = [
  "--bg",
  "--bg-sidebar",
  "--bg-main",
  "--bg-card",
  "--bg-elevated",
  "--bg-muted",
  "--bg-hover",
  "--bg-active",
  "--border",
  "--border-soft",
  "--text",
  "--text-2",
  "--text-3",
  "--accent",
  "--accent-contrast",
  "--ok",
  "--danger",
  "--skill",
  "--ok-soft",
  "--danger-soft",
  "--info",
  "--info-soft",
  "--orange",
  "--orange-soft",
  "--warn",
  "--warn-soft",
  "--skill-soft",
  "--file-link",
  "--file-link-underline",
  "--file-link-hover-bg",
  "--font",
  "--font-mono",
  "--shadow",
] as const;
