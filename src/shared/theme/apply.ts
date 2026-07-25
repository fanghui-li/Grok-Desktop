/**
 * 将 ChromeTheme 映射为 document 上的 CSS 变量（覆盖 styles.css 基座）。
 * 推导见 derive.ts（对齐 Codex Desktop）。
 */
import type { ChromeTheme, ThemeVariant } from "./types.js";
import {
  DERIVED_CSS_KEYS,
  deriveChromeCssTokens,
} from "./derive.js";

/** 清除自定义覆盖，回到静态 light/dark 表 */
export function clearChromeThemeOverrides(
  root: HTMLElement = document.documentElement,
): void {
  for (const k of DERIVED_CSS_KEYS) root.style.removeProperty(k);
  root.removeAttribute("data-theme-custom");
  root.classList.remove("theme-translucent-sidebar");
  root.classList.remove("theme-switching");
}

/**
 * 应用 chrome 色板。
 * 始终走 derive（含默认预设），保证设置页改色 / 导入 / 预设同一管道。
 * 静态 :root / [data-theme=dark] 仅作 theme-boot 闪屏兜底。
 */
export function applyChromeTheme(
  theme: ChromeTheme,
  variant: ThemeVariant,
  opts?: {
    root?: HTMLElement;
    /** @deprecated 忽略：一律 derive，保留参数以免调用方报错 */
    isDefaultPreset?: boolean;
    /** 主题切换时短暂开 CSS 过渡 */
    animate?: boolean;
  },
): void {
  const root = opts?.root ?? document.documentElement;
  root.dataset.theme = variant;
  root.style.colorScheme = variant;

  root.setAttribute("data-theme-custom", "1");
  const tokens = deriveChromeCssTokens(theme, variant);

  // 先清可能遗留的 font（derive 未带时回到 CSS 默认）
  if (!tokens["--font"]) root.style.removeProperty("--font");
  if (!tokens["--font-mono"]) root.style.removeProperty("--font-mono");

  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(k, v);
  }

  root.classList.toggle("theme-translucent-sidebar", !theme.opaqueWindows);

  if (opts?.animate) {
    root.classList.add("theme-switching");
    window.setTimeout(() => {
      root.classList.remove("theme-switching");
    }, 220);
  }
}

/** 供 theme-boot / localStorage 缓存的精简快照 */
export interface ThemeBootSnapshot {
  variant: ThemeVariant;
  codeThemeId: string;
  chrome: ChromeTheme;
  isDefault: boolean;
}
