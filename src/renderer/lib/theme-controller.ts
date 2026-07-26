/**
 * 主题 preference / variant 外观 / system 监听（自 main 迁出）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import type { ThemeVariant, VariantAppearance } from "../../shared/theme/types.js";
import {
  applyChromeTheme,
  defaultAppearance,
  deriveChromeCssTokens,
  formatCodexThemeV1,
} from "../../shared/theme/index.js";
import type { SettingsThemePreference } from "../settings-page.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ThemeControllerDeps = {
  inv: Inv;
};

export class ThemeController {
  private preference: SettingsThemePreference = "system";
  private appearanceLight: VariantAppearance = defaultAppearance("light");
  private appearanceDark: VariantAppearance = defaultAppearance("dark");
  private systemMql: MediaQueryList | null = null;
  private systemListener: ((ev: MediaQueryListEvent) => void) | null = null;

  constructor(private readonly deps: ThemeControllerDeps) {}

  getPreference(): SettingsThemePreference {
    return this.preference;
  }

  setPreferenceOnly(pref: SettingsThemePreference): void {
    this.preference = pref;
  }

  getAppearanceLight(): VariantAppearance {
    return this.appearanceLight;
  }

  getAppearanceDark(): VariantAppearance {
    return this.appearanceDark;
  }

  setAppearanceLight(app: VariantAppearance): void {
    this.appearanceLight = app;
  }

  setAppearanceDark(app: VariantAppearance): void {
    this.appearanceDark = app;
  }

  resolve(pref: SettingsThemePreference = this.preference): ThemeVariant {
    if (pref === "light" || pref === "dark") return pref;
    try {
      if (typeof matchMedia === "function") {
        return matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      }
    } catch {
      /* ignore */
    }
    return "light";
  }

  appearanceForVariant(v: ThemeVariant): VariantAppearance {
    return v === "light" ? this.appearanceLight : this.appearanceDark;
  }

  paint(
    resolved: ThemeVariant,
    opts?: { animate?: boolean },
  ): void {
    const app = this.appearanceForVariant(resolved);
    const isDefault =
      app.codeThemeId === "default" || app.codeThemeId === "codex";
    applyChromeTheme(app.chromeTheme, resolved, {
      animate: opts?.animate === true,
    });
    try {
      localStorage.setItem("grok-desktop-theme", this.preference);
      localStorage.setItem(
        "grok-desktop-theme-boot",
        JSON.stringify({
          variant: resolved,
          codeThemeId: app.codeThemeId,
          chrome: app.chromeTheme,
          isDefault,
        }),
      );
    } catch {
      /* ignore */
    }
    const tokens = deriveChromeCssTokens(app.chromeTheme, resolved);
    const bg = tokens["--bg"] ?? tokens["--bg-sidebar"];
    const symbol = tokens["--text"];
    void this.deps
      .inv("ui.setChromeTheme", { theme: resolved, bg, symbol })
      .catch(() => {
        /* older shell */
      });
  }

  bindSystemListener(): void {
    if (this.systemMql && this.systemListener) {
      try {
        this.systemMql.removeEventListener("change", this.systemListener);
      } catch {
        /* ignore */
      }
    }
    this.systemMql = null;
    this.systemListener = null;
    if (this.preference !== "system") return;
    try {
      this.systemMql = matchMedia("(prefers-color-scheme: dark)");
      this.systemListener = () => {
        if (this.preference === "system") {
          this.paint(this.resolve("system"));
        }
      };
      this.systemMql.addEventListener("change", this.systemListener);
    } catch {
      /* ignore */
    }
  }

  /** 应用 mode（system/light/dark）并刷新 chrome */
  applyPreference(pref: SettingsThemePreference): void {
    this.preference = pref;
    try {
      localStorage.setItem("grok-desktop-theme", pref);
    } catch {
      /* ignore */
    }
    this.paint(this.resolve(pref), { animate: true });
    this.bindSystemListener();
  }

  /** 写入某 variant 外观并可选立即绘制 */
  setVariantAppearance(
    variant: ThemeVariant,
    app: VariantAppearance,
    repaint: boolean,
  ): void {
    if (variant === "light") this.appearanceLight = app;
    else this.appearanceDark = app;
    if (repaint && this.resolve(this.preference) === variant) {
      this.paint(variant);
    }
  }

  exportCurrentString(): string {
    const variant = this.resolve(this.preference);
    const app = this.appearanceForVariant(variant);
    return formatCodexThemeV1({
      codeThemeId: app.codeThemeId,
      theme: app.chromeTheme,
      variant,
    });
  }
}
