import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  deriveChromeCssTokens,
  isLowContrastChrome,
  normalizeContrast,
  relativeLuminance,
} from "../src/shared/theme/derive.js";
import type { ChromeTheme } from "../src/shared/theme/types.js";
import { DEFAULT_CHROME_DARK, DEFAULT_CHROME_LIGHT } from "../src/shared/theme/presets.js";

const NORD_DARK: ChromeTheme = {
  accent: "#68c0d8",
  contrast: 70,
  fonts: { ui: "Inter", code: null },
  ink: "#cad1e0",
  opaqueWindows: true,
  semanticColors: {
    diffAdded: "#a3be8c",
    diffRemoved: "#bf616a",
    skill: "#b48ead",
  },
  surface: "#2d384e",
};

describe("theme derive (Codex-aligned)", () => {
  it("normalizeContrast anchors light=45 dark=60", () => {
    expect(normalizeContrast(45, "light")).toBeCloseTo(0.45, 2);
    expect(normalizeContrast(60, "dark")).toBeCloseTo(0.6, 2);
    // 高于锚点应抬升
    expect(normalizeContrast(80, "dark")).toBeGreaterThan(
      normalizeContrast(60, "dark"),
    );
    // 低于锚点应压低但仍 >= 0
    expect(normalizeContrast(20, "light")).toBeLessThan(
      normalizeContrast(45, "light"),
    );
    expect(normalizeContrast(0, "light")).toBeGreaterThanOrEqual(0);
  });

  it("primary text is ink; secondary/tertiary stay readable on surface", () => {
    const t = deriveChromeCssTokens(NORD_DARK, "dark");
    expect(t["--text"]).toBe("#cad1e0");
    expect(t["--bg"]).toBe("#2d384e");
    expect(t["--accent"]).toBe("#68c0d8");

    const sec = t["--text-2"]!;
    const ter = t["--text-3"]!;
    // solid hex
    expect(sec).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ter).toMatch(/^#[0-9a-f]{6}$/i);
    // secondary 对 surface ≥ 3:1；主字更高
    expect(contrastRatio(t["--text"]!, t["--bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(sec, t["--bg"]!)).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(ter, t["--bg"]!)).toBeGreaterThanOrEqual(2.5);
  });

  it("shell (sidebar/titlebar) shares color; main content is elevated card", () => {
    const light = deriveChromeCssTokens(DEFAULT_CHROME_LIGHT, "light");
    const dark = deriveChromeCssTokens(NORD_DARK, "dark");
    // chrome shell 同色
    expect(light["--bg"]).toBe(light["--bg-sidebar"]);
    expect(dark["--bg"]).toBe(dark["--bg-sidebar"]);
    expect(dark["--bg"]).toBe("#2d384e");
    // 中间会话区与外壳分离
    expect(light["--bg-main"]).not.toBe(light["--bg"]);
    expect(dark["--bg-main"]).not.toBe(dark["--bg"]);
    expect(light["--bg-card"]).toBe(light["--bg-main"]);
    // 浅色：主区更亮（近白卡片），外壳略灰
    expect(relativeLuminance(light["--bg-main"]!)).toBeGreaterThan(
      relativeLuminance(light["--bg"]!),
    );
    // 深色：主区略抬亮
    expect(relativeLuminance(dark["--bg-main"]!)).toBeGreaterThan(
      relativeLuminance(dark["--bg"]!),
    );
  });

  it("higher contrast increases text-2 separation from surface", () => {
    const low = deriveChromeCssTokens({ ...NORD_DARK, contrast: 30 }, "dark");
    const high = deriveChromeCssTokens({ ...NORD_DARK, contrast: 90 }, "dark");
    // 高对比时 secondary 更接近 ink → 与 surface 对比更大
    expect(contrastRatio(high["--text-2"]!, high["--bg"]!)).toBeGreaterThanOrEqual(
      contrastRatio(low["--text-2"]!, low["--bg"]!) - 0.05,
    );
  });

  it("default light/dark presets produce usable tokens", () => {
    const light = deriveChromeCssTokens(DEFAULT_CHROME_LIGHT, "light");
    const dark = deriveChromeCssTokens(DEFAULT_CHROME_DARK, "dark");
    expect(contrastRatio(light["--text"]!, light["--bg"]!)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(dark["--text"]!, dark["--bg"]!)).toBeGreaterThanOrEqual(4.5);
    expect(light["--text-2"]).toBeTruthy();
    expect(dark["--bg-sidebar"]).toBeTruthy();
  });

  it("isLowContrastChrome flags extreme low contrast", () => {
    const bad: ChromeTheme = {
      ...NORD_DARK,
      ink: "#3a4558",
      surface: "#2d384e",
      contrast: 10,
    };
    expect(isLowContrastChrome(bad, "dark")).toBe(true);
    expect(isLowContrastChrome(NORD_DARK, "dark")).toBe(false);
  });
});
