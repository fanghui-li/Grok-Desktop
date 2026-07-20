/**
 * 内置主题预设（codeThemeId 作主键，对齐 Codex get_available_themes）。
 * 色板来源：docs/them.md（codex-theme-v1 分享串）。
 */
import type {
  ChromeTheme,
  ThemePresetInfo,
  ThemeVariant,
  VariantAppearance,
} from "./types.js";
import { normalizeChromeTheme } from "./codec.js";

/** GitHub dark */
const GITHUB_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#1f6feb",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#e6edf3",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#3fb950",
    diffRemoved: "#f85149",
    skill: "#bc8cff",
  },
  surface: "#0d1117",
});

/** GitHub light */
const GITHUB_LIGHT: ChromeTheme = normalizeChromeTheme({
  accent: "#0969da",
  contrast: 45,
  fonts: { ui: null, code: null },
  ink: "#1f2328",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#1a7f37",
    diffRemoved: "#cf222e",
    skill: "#8250df",
  },
  surface: "#ffffff",
});

/** Absolutely dark */
const ABSOLUTELY_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#cc7d5e",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#f9f9f7",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#00c853",
    diffRemoved: "#ff5f38",
    skill: "#cc7d5e",
  },
  surface: "#2d2d2b",
});

/** Absolutely light */
const ABSOLUTELY_LIGHT: ChromeTheme = normalizeChromeTheme({
  accent: "#cc7d5e",
  contrast: 45,
  fonts: { ui: null, code: null },
  ink: "#2d2d2b",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#00c853",
    diffRemoved: "#ff5f38",
    skill: "#cc7d5e",
  },
  surface: "#f9f9f7",
});

/** Ayu dark（仅深色） */
const AYU_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#e6b450",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#bfbdb6",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#7fd962",
    diffRemoved: "#ea6c73",
    skill: "#cda1fa",
  },
  surface: "#0b0e14",
});

/** Codex dark */
const CODEX_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#0169cc",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#fcfcfc",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#00a240",
    diffRemoved: "#e02e2a",
    skill: "#b06dff",
  },
  surface: "#111111",
});

/** Codex light */
const CODEX_LIGHT: ChromeTheme = normalizeChromeTheme({
  accent: "#0169cc",
  contrast: 45,
  fonts: { ui: null, code: null },
  ink: "#0d0d0d",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#00a240",
    diffRemoved: "#e02e2a",
    skill: "#751ed9",
  },
  surface: "#ffffff",
});

/** One dark */
const ONE_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#4d78cc",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#abb2bf",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#8cc265",
    diffRemoved: "#e05561",
    skill: "#c162de",
  },
  surface: "#282c34",
});

/** One light */
const ONE_LIGHT: ChromeTheme = normalizeChromeTheme({
  accent: "#526fff",
  contrast: 45,
  fonts: { ui: null, code: null },
  ink: "#383a42",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#3bba54",
    diffRemoved: "#e45649",
    skill: "#526fff",
  },
  surface: "#fafafa",
});

/** VS Code Plus dark */
const VSCODE_PLUS_DARK: ChromeTheme = normalizeChromeTheme({
  accent: "#007acc",
  contrast: 56,
  fonts: { ui: "Inter", code: null },
  ink: "#d4d4d4",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#369432",
    diffRemoved: "#f44747",
    skill: "#000080",
  },
  surface: "#1e1e1e",
});

/** VS Code Plus light */
const VSCODE_PLUS_LIGHT: ChromeTheme = normalizeChromeTheme({
  accent: "#007acc",
  contrast: 45,
  fonts: { ui: null, code: null },
  ink: "#000000",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#008000",
    diffRemoved: "#ee0000",
    skill: "#0000ff",
  },
  surface: "#ffffff",
});

/** 默认回落 = Codex（docs/them.md 主预设） */
export const DEFAULT_CHROME_LIGHT: ChromeTheme = CODEX_LIGHT;
export const DEFAULT_CHROME_DARK: ChromeTheme = CODEX_DARK;

type PresetReg = {
  id: string;
  label: string;
  light?: ChromeTheme;
  dark?: ChromeTheme;
};

/** 与 docs/them.md 一一对应（浅色 one 重复项已去重） */
const PRESETS: PresetReg[] = [
  {
    id: "github",
    label: "GitHub",
    light: GITHUB_LIGHT,
    dark: GITHUB_DARK,
  },
  {
    id: "absolutely",
    label: "Absolutely",
    light: ABSOLUTELY_LIGHT,
    dark: ABSOLUTELY_DARK,
  },
  {
    id: "ayu",
    label: "Ayu",
    dark: AYU_DARK,
  },
  {
    id: "codex",
    label: "Codex",
    light: CODEX_LIGHT,
    dark: CODEX_DARK,
  },
  {
    id: "one",
    label: "One",
    light: ONE_LIGHT,
    dark: ONE_DARK,
  },
  {
    id: "vscode-plus",
    label: "VS Code Plus",
    light: VSCODE_PLUS_LIGHT,
    dark: VSCODE_PLUS_DARK,
  },
];

export function listThemePresets(): ThemePresetInfo[] {
  return PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    supportsLight: Boolean(p.light),
    supportsDark: Boolean(p.dark),
  }));
}

export function isKnownCodeThemeId(id: string): boolean {
  return PRESETS.some((p) => p.id === id);
}

export function getPresetChrome(
  codeThemeId: string,
  variant: ThemeVariant,
): ChromeTheme | null {
  const p = PRESETS.find((x) => x.id === codeThemeId);
  if (!p) return null;
  const chrome = variant === "light" ? p.light : p.dark;
  return chrome ? normalizeChromeTheme(chrome) : null;
}

export function presetsForVariant(variant: ThemeVariant): ThemePresetInfo[] {
  return listThemePresets().filter((p) =>
    variant === "light" ? p.supportsLight : p.supportsDark,
  );
}

export function defaultAppearance(variant: ThemeVariant): VariantAppearance {
  return {
    codeThemeId: "codex",
    chromeTheme:
      variant === "light" ? DEFAULT_CHROME_LIGHT : DEFAULT_CHROME_DARK,
  };
}

/** 选预设：写 codeThemeId + 对应 chrome */
export function appearanceFromPreset(
  codeThemeId: string,
  variant: ThemeVariant,
): VariantAppearance {
  const chrome = getPresetChrome(codeThemeId, variant);
  if (!chrome) {
    return defaultAppearance(variant);
  }
  return { codeThemeId, chromeTheme: chrome };
}
