/**
 * 将 ChromeTheme 映射为 document 上的 CSS 变量（覆盖 styles.css 基座）。
 */
import type { ChromeTheme, ThemeVariant } from "./types.js";

function mix(ink: string, surface: string, inkPct: number): string {
  // color-mix 需现代 Chromium；Electron 35+ 可用
  return `color-mix(in srgb, ${ink} ${inkPct}%, ${surface})`;
}

function contrastFactor(contrast: number): number {
  // 50 为中性；越高 ink 在 muted/border 上占比越大
  return Math.max(0.2, Math.min(1.2, contrast / 50));
}

/** 清除自定义覆盖，回到静态 light/dark 表 */
export function clearChromeThemeOverrides(root: HTMLElement = document.documentElement): void {
  const keys = [
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
    "--font",
    "--font-mono",
    "--shadow",
  ];
  for (const k of keys) root.style.removeProperty(k);
  root.removeAttribute("data-theme-custom");
  root.classList.remove("theme-translucent-sidebar");
}

/**
 * 应用 chrome 色板。
 * @param useDefaults 为 true 时不写 inline（用 CSS 静态表）
 */
export function applyChromeTheme(
  theme: ChromeTheme,
  variant: ThemeVariant,
  opts?: { root?: HTMLElement; isDefaultPreset?: boolean },
): void {
  const root = opts?.root ?? document.documentElement;
  root.dataset.theme = variant;
  root.style.colorScheme = variant;

  if (opts?.isDefaultPreset) {
    clearChromeThemeOverrides(root);
    return;
  }

  root.setAttribute("data-theme-custom", "1");
  const { surface, ink, accent, contrast, fonts, opaqueWindows, semanticColors } =
    theme;
  const cf = contrastFactor(contrast);

  const mutedInk = Math.round(38 * cf);
  const softInk = Math.round(22 * cf);
  const borderInk = Math.round(14 * cf);
  const hoverInk = Math.round(8 * cf);
  const sidebarInk = Math.round(5 * cf);

  root.style.setProperty("--bg", surface);
  root.style.setProperty("--bg-main", surface);
  root.style.setProperty("--bg-card", surface);
  root.style.setProperty(
    "--bg-sidebar",
    mix(ink, surface, sidebarInk),
  );
  root.style.setProperty("--bg-elevated", mix(ink, surface, hoverInk + 2));
  root.style.setProperty("--bg-muted", mix(ink, surface, hoverInk));
  root.style.setProperty("--bg-hover", mix(ink, surface, hoverInk + 4));
  root.style.setProperty("--bg-active", mix(ink, surface, hoverInk + 8));
  root.style.setProperty("--border", mix(ink, surface, borderInk));
  root.style.setProperty("--border-soft", mix(ink, surface, Math.max(8, borderInk - 4)));
  root.style.setProperty("--text", ink);
  root.style.setProperty("--text-2", mix(ink, surface, mutedInk));
  root.style.setProperty("--text-3", mix(ink, surface, softInk));
  root.style.setProperty("--accent", accent);
  // 对比色：简单取 surface（深色底浅字按钮另有 orange 等）
  root.style.setProperty("--accent-contrast", surface);
  root.style.setProperty("--ok", semanticColors.diffAdded);
  root.style.setProperty("--danger", semanticColors.diffRemoved);
  root.style.setProperty("--skill", semanticColors.skill);

  if (fonts.ui) {
    root.style.setProperty(
      "--font",
      `"${fonts.ui}", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`,
    );
  } else {
    root.style.removeProperty("--font");
  }
  if (fonts.code) {
    root.style.setProperty(
      "--font-mono",
      `"${fonts.code}", ui-monospace, "Cascadia Code", Consolas, monospace`,
    );
  } else {
    root.style.removeProperty("--font-mono");
  }

  root.classList.toggle("theme-translucent-sidebar", !opaqueWindows);

  // 阴影随 surface 深浅
  if (variant === "dark") {
    root.style.setProperty("--shadow", "0 8px 32px rgba(0, 0, 0, 0.45)");
  } else {
    root.style.setProperty("--shadow", "0 4px 24px rgba(0, 0, 0, 0.06)");
  }
}

/** 供 theme-boot / localStorage 缓存的精简快照 */
export interface ThemeBootSnapshot {
  variant: ThemeVariant;
  codeThemeId: string;
  chrome: ChromeTheme;
  isDefault: boolean;
}
