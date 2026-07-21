import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerInfo, PluginInfo, SkillInfo } from "../shared/types.js";
import type { VariantAppearance } from "../shared/theme/types.js";
import {
  defaultAppearance,
  isChromeTheme,
  isKnownCodeThemeId,
  normalizeChromeTheme,
} from "../shared/theme/index.js";
import { grokHomeDir } from "./paths.js";

export function listSkills(opts?: {
  home?: string;
  projectPath?: string;
}): SkillInfo[] {
  const home = opts?.home ?? os.homedir();
  const roots: { dir: string; scope: SkillInfo["scope"] }[] = [
    { dir: path.join(grokHomeDir(home), "skills"), scope: "user" },
    { dir: path.join(home, ".grok", "skills"), scope: "user" },
  ];
  if (opts?.projectPath) {
    roots.push({
      dir: path.join(opts.projectPath, ".grok", "skills"),
      scope: "project",
    });
  }
  const out: SkillInfo[] = [];
  for (const { dir, scope } of roots) {
    if (!fs.existsSync(dir)) continue;
    walkSkills(dir, scope, out);
  }
  // dedupe by name, prefer project
  const map = new Map<string, SkillInfo>();
  for (const s of out) {
    const prev = map.get(s.name);
    if (!prev || s.scope === "project") map.set(s.name, s);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function walkSkills(
  dir: string,
  scope: SkillInfo["scope"],
  out: SkillInfo[],
  depth = 0,
): void {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isFile() && ent.name.toLowerCase() === "skill.md") {
      const name = path.basename(dir);
      const meta = readSkillMeta(full);
      out.push({
        name,
        path: full,
        description: meta.description,
        category: meta.category,
        scope,
      });
    } else if (ent.isDirectory()) {
      walkSkills(full, scope, out, depth + 1);
    }
  }
}

function readSkillMeta(skillMd: string): {
  description?: string;
  category?: string;
} {
  try {
    const text = fs.readFileSync(skillMd, "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    let description: string | undefined;
    let category: string | undefined;
    if (fm) {
      const d = /^description:\s*(.+)$/m.exec(fm[1]);
      if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
      const c = /^category:\s*(.+)$/m.exec(fm[1]);
      if (c) category = c[1].trim().replace(/^["']|["']$/g, "");
    }
    if (!description) {
      const line = text
        .split(/\r?\n/)
        .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
      description = line?.trim().slice(0, 160);
    }
    return { description, category };
  } catch {
    return {};
  }
}

export function listPlugins(opts?: { home?: string; projectPath?: string }): PluginInfo[] {
  const home = opts?.home ?? os.homedir();
  const roots: { dir: string; scope: NonNullable<PluginInfo["scope"]> }[] = [
    { dir: path.join(grokHomeDir(home), "plugins"), scope: "user" },
    { dir: path.join(home, ".grok", "plugins"), scope: "user" },
  ];
  if (opts?.projectPath) {
    roots.push({
      dir: path.join(opts.projectPath, ".grok", "plugins"),
      scope: "project",
    });
  }
  const out: PluginInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, scope } of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      const key = ent.name.toLowerCase();
      if (seen.has(key) && scope !== "project") continue;
      seen.add(key);
      out.push({
        name: ent.name,
        path: full,
        enabled: true,
        trusted: scope === "user" || scope === "project",
        scope,
        description: readPluginDescription(full),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readPluginDescription(pluginDir: string): string | undefined {
  for (const name of ["README.md", "readme.md", "plugin.json", "package.json"]) {
    const p = path.join(pluginDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      if (name.endsWith(".json")) {
        const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
          description?: string;
        };
        if (j.description) return String(j.description).slice(0, 160);
      } else {
        const line = fs
          .readFileSync(p, "utf8")
          .split(/\r?\n/)
          .find((l) => l.trim() && !l.startsWith("#"));
        if (line) return line.trim().slice(0, 160);
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export function listMcpFromConfig(home?: string): McpServerInfo[] {
  const cfgPath = path.join(grokHomeDir(home), "config.toml");
  if (!fs.existsSync(cfgPath)) return [];
  try {
    const text = fs.readFileSync(cfgPath, "utf8");
    // Minimal TOML scrape: [mcp_servers.name] or [mcp_servers.name]
    const names = new Set<string>();
    for (const m of text.matchAll(/\[mcp_servers\.([^\]]+)\]/g)) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(/\[mcp_servers\s*\.\s*"([^"]+)"\]/g)) {
      names.add(m[1]);
    }
    return [...names].map((name) => ({
      name,
      status: "configured" as const,
    }));
  } catch {
    return [];
  }
}

export function authStatus(home?: string): {
  authenticated: boolean;
  label?: string;
  authPath?: string;
  grokHome?: string;
  cliGrokHome?: string;
} {
  const osHome = home ?? os.homedir();
  const grokHome = grokHomeDir(osHome);
  const cliHome = path.join(osHome, ".grok");
  const authPath = path.join(grokHome, "auth.json");
  if (!fs.existsSync(authPath)) {
    return {
      authenticated: false,
      authPath,
      grokHome,
      cliGrokHome: cliHome,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8")) as {
      access_token?: string;
      token?: string;
      email?: string;
      user?: { email?: string };
    };
    const has =
      Boolean(raw.access_token || raw.token) ||
      fs.statSync(authPath).size > 10;
    return {
      authenticated: has,
      label: raw.email ?? raw.user?.email ?? (has ? "signed in" : undefined),
      authPath,
      grokHome,
      cliGrokHome: cliHome,
    };
  } catch {
    return {
      authenticated: true,
      label: "auth present",
      authPath,
      grokHome,
      cliGrokHome: cliHome,
    };
  }
}

/** 清除 Desktop profile 登录态（不碰 CLI ~/.grok/auth.json） */
export function authLogout(home?: string): {
  cleared: boolean;
  authPath: string;
} {
  const authPath = path.join(grokHomeDir(home), "auth.json");
  const lockPath = authPath + ".lock";
  let cleared = false;
  for (const p of [authPath, lockPath]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        cleared = true;
      }
    } catch {
      /* ignore */
    }
  }
  return { cleared, authPath };
}

/** Desktop UI / defaults persisted under ~/.grok/desktop/settings.json */
/** 默认访问权限（不含 plan；plan 是独立会话模式） */
export type DesktopPermMode = "always_approve" | "normal";
/** explorer | code | cursor | codium | windsurf | editor(遗留) */
export type DesktopOpenTarget = string;

/** UI 外观；`system` 跟随 OS / Chromium prefers-color-scheme（对齐 Codex Appearance） */
export type DesktopThemePreference = "system" | "light" | "dark";

export interface DesktopConfig {
  defaultModel?: string;
  grokPathOverride?: string;
  /** @deprecated prefer defaultPermMode */
  alwaysApproveDefault?: boolean;
  /** 新对话默认权限 */
  defaultPermMode?: DesktopPermMode;
  /** 顶栏「打开位置」：explorer 或探测到的编辑器 id */
  defaultOpenTarget?: DesktopOpenTarget;
  /**
   * UI language preference.
   * `system` follows OS / Chromium locale; otherwise `zh-CN` | `en-US`.
   */
  locale?: "zh-CN" | "en-US" | "system";
  /**
   * Appearance: light / dark / follow system.
   * Default when unset: `system`.
   */
  theme?: DesktopThemePreference;
  /**
   * 分 variant 的 chrome + codeThemeId（对齐 Codex light/darkChromeTheme）。
   */
  appearanceLight?: VariantAppearance;
  appearanceDark?: VariantAppearance;
  /**
   * 跨会话 Memory（实验）：对齐 CLI `--experimental-memory` / `GROK_MEMORY`。
   * 真存储在 GROK_HOME/memory/，非 desktop/memory/entries.json。
   */
  experimentalMemory?: boolean;
  /** Mode B：空闲超过该毫秒则 detach（0=关闭） */
  idleDetachMs?: number;
  /** 同时 live 附着上限 */
  maxLiveAttaches?: number;
}

export interface DesktopConfigView extends DesktopConfig {
  defaultPermMode: DesktopPermMode;
  defaultOpenTarget: DesktopOpenTarget;
  paths: {
    settings: string;
    configToml: string;
    grokHome: string;
  };
}

export function readDesktopConfig(home?: string): DesktopConfig {
  const p = path.join(desktopDirSafe(home), "settings.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as DesktopConfig;
  } catch {
    return {};
  }
}

function normalizeVariantAppearance(
  raw: unknown,
  variant: "light" | "dark",
): VariantAppearance {
  const fallback = defaultAppearance(variant);
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const codeThemeId =
    typeof o.codeThemeId === "string" && o.codeThemeId.trim()
      ? o.codeThemeId.trim()
      : fallback.codeThemeId;
  const chrome = isChromeTheme(o.chromeTheme)
    ? normalizeChromeTheme(o.chromeTheme)
    : fallback.chromeTheme;
  // 未知 id 仍保留（导入自定义后可能改过 chrome，id 仅作标签）
  // 历史 default → codex（内置默认预设 id）
  const resolvedId =
    codeThemeId === "default"
      ? "codex"
      : isKnownCodeThemeId(codeThemeId)
        ? codeThemeId
        : codeThemeId || "codex";
  return {
    codeThemeId: resolvedId,
    chromeTheme: chrome,
  };
}

/** Normalized view for UI / Host consumers. */
export function getDesktopConfigView(home?: string): DesktopConfigView {
  const raw = readDesktopConfig(home);
  // 历史配置可能把 plan 写进 defaultPermMode；plan 不是访问权限，回落 normal
  const rawPerm = raw.defaultPermMode;
  const defaultPermMode: DesktopPermMode =
    rawPerm === "always_approve" || raw.alwaysApproveDefault
      ? "always_approve"
      : "normal";
  const theme: DesktopThemePreference =
    raw.theme === "light" || raw.theme === "dark" || raw.theme === "system"
      ? raw.theme
      : "system";
  return {
    ...raw,
    defaultPermMode,
    defaultOpenTarget: raw.defaultOpenTarget ?? "explorer",
    alwaysApproveDefault: defaultPermMode === "always_approve",
    theme,
    appearanceLight: normalizeVariantAppearance(raw.appearanceLight, "light"),
    appearanceDark: normalizeVariantAppearance(raw.appearanceDark, "dark"),
    paths: {
      settings: path.join(desktopDirSafe(home), "settings.json"),
      configToml: path.join(grokHomeDir(home), "config.toml"),
      grokHome: grokHomeDir(home),
    },
  };
}

export function writeDesktopConfig(
  patch: Partial<DesktopConfig>,
  home?: string,
): DesktopConfigView {
  const dir = desktopDirSafe(home);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "settings.json");
  const cur = readDesktopConfig(home);
  const next: DesktopConfig = { ...cur, ...patch };
  // scrub invalid defaultPermMode (plan is a session mode, not an access default)
  if (
    next.defaultPermMode !== undefined &&
    next.defaultPermMode !== "always_approve" &&
    next.defaultPermMode !== "normal"
  ) {
    next.defaultPermMode = "normal";
  }
  // 同步遗留字段
  if (patch.defaultPermMode !== undefined) {
    const mode =
      patch.defaultPermMode === "always_approve" ? "always_approve" : "normal";
    next.defaultPermMode = mode;
    next.alwaysApproveDefault = mode === "always_approve";
  } else if (
    patch.alwaysApproveDefault !== undefined &&
    patch.defaultPermMode === undefined
  ) {
    next.defaultPermMode = patch.alwaysApproveDefault
      ? "always_approve"
      : "normal";
    next.alwaysApproveDefault = !!patch.alwaysApproveDefault;
  }
  if (patch.appearanceLight !== undefined) {
    next.appearanceLight = normalizeVariantAppearance(
      patch.appearanceLight,
      "light",
    );
  }
  if (patch.appearanceDark !== undefined) {
    next.appearanceDark = normalizeVariantAppearance(
      patch.appearanceDark,
      "dark",
    );
  }
  fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  return getDesktopConfigView(home);
}

function desktopDirSafe(home?: string): string {
  return path.join(grokHomeDir(home), "desktop");
}
