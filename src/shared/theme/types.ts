/**
 * Codex 对齐的外观主题模型（chrome theme + code theme id + variant）。
 * 分享串：codex-theme-v1:{...}
 */

export type ThemeVariant = "light" | "dark";

export type HexColor = string;

export interface ThemeFonts {
  /** UI 字体；null = 系统默认 */
  ui: string | null;
  /** 代码字体；null = 系统默认 */
  code: string | null;
}

export interface ThemeSemanticColors {
  diffAdded: HexColor;
  diffRemoved: HexColor;
  skill: HexColor;
}

/** 外壳色板（与 Codex chromeTheme 字段同构） */
export interface ChromeTheme {
  accent: HexColor;
  /** 0–100 */
  contrast: number;
  fonts: ThemeFonts;
  /** 前景 ink */
  ink: HexColor;
  opaqueWindows: boolean;
  semanticColors: ThemeSemanticColors;
  /** 背景 surface */
  surface: HexColor;
}

/** 单变体外观状态 */
export interface VariantAppearance {
  codeThemeId: string;
  chromeTheme: ChromeTheme;
}

/** codex-theme-v1 载荷 */
export interface CodexThemeV1 {
  codeThemeId: string;
  theme: ChromeTheme;
  variant: ThemeVariant;
}

export interface ThemePresetInfo {
  id: string;
  label: string;
  supportsLight: boolean;
  supportsDark: boolean;
}
