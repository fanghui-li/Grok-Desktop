/**
 * Desktop 默认关闭 Cursor / Claude 厂商兼容发现。
 * 写入 GROK_HOME/config.toml 的 [compat.*] + 禁用 ~/.claude|cursor/plugins 名，
 * 并提供环境变量覆盖（优先级高于 toml）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokHomeDir } from "./paths.js";

/** 写入 config 时附带的说明行（strip 时按此前缀清理，避免重复堆积） */
const COMPAT_COMMENT =
  "# Desktop：关闭厂商兼容（不扫描 ~/.claude、~/.cursor 的 skills/hooks/mcp 等）";

const COMPAT_BLOCK = `${COMPAT_COMMENT}
[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false
`;

/** 与文档一致的 env 开关（false = 不扫描） */
export const COMPAT_DISABLED_ENV: Record<string, string> = {
  GROK_CLAUDE_SKILLS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_SESSIONS_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_SESSIONS_ENABLED: "false",
};

function configTomlPath(home?: string): string {
  return path.join(grokHomeDir(home), "config.toml");
}

/**
 * 确保 Desktop profile 的 config.toml 含关闭兼容的段。
 * 若已有 [compat.*] 则整段替换为全 false。
 * 并将 ~/.claude/plugins、~/.cursor/plugins 下目录名写入 [plugins].disabled。
 */
export function ensureVendorCompatDisabled(home?: string): void {
  const p = configTomlPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let text = "";
  try {
    if (fs.existsSync(p)) text = fs.readFileSync(p, "utf8");
  } catch {
    text = "";
  }
  let next = upsertCompatSections(text);
  next = upsertPluginsDisabled(next, listVendorPluginNames());
  if (next !== text) {
    fs.writeFileSync(p, next, "utf8");
  }
}

/** Claude 插件根下的系统目录，不是可安装插件包 */
const VENDOR_PLUGIN_SKIP = new Set([
  "cache",
  "data",
  "local",
  "marketplaces",
  "repos",
  "install",
  "tmp",
]);

function looksLikePluginDir(full: string): boolean {
  for (const marker of [
    "plugin.json",
    ".mcp.json",
    ".lsp.json",
    "skills",
    "agents",
    "commands",
    "hooks",
  ]) {
    try {
      if (fs.existsSync(path.join(full, marker))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function listVendorPluginNames(): string[] {
  const osHome = os.homedir();
  const names = new Set<string>();
  for (const dir of [
    path.join(osHome, ".claude", "plugins"),
    path.join(osHome, ".cursor", "plugins"),
  ]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
        if (VENDOR_PLUGIN_SKIP.has(ent.name.toLowerCase())) continue;
        const full = path.join(dir, ent.name);
        if (looksLikePluginDir(full)) names.add(ent.name);
      }
    } catch {
      /* ignore */
    }
  }
  return [...names].sort();
}

/** 是否已是 Desktop 期望的 compat 关闭块（避免每次启动无意义改写） */
function hasDesktopCompatBlock(text: string): boolean {
  const n = text.replace(/\r\n/g, "\n");
  return (
    /\[compat\.claude\]/.test(n) &&
    /\[compat\.cursor\]/.test(n) &&
    /\[compat\.codex\]/.test(n) &&
    /skills\s*=\s*false/.test(n) &&
    /sessions\s*=\s*false/.test(n)
  );
}

function stripDesktopCompatComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // 历史重复行：整行都是这条 Desktop 兼容说明
      if (t === COMPAT_COMMENT.trim()) return false;
      if (/^#\s*Desktop[：:].*厂商兼容/.test(t)) return false;
      return true;
    })
    .join("\n");
}

function upsertCompatSections(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  // 已正确关闭且无重复注释时保持原样（幂等）
  if (hasDesktopCompatBlock(out)) {
    const commentHits = out
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return (
          t === COMPAT_COMMENT.trim() ||
          /^#\s*Desktop[：:].*厂商兼容/.test(t)
        );
      }).length;
    if (commentHits <= 1) return out;
  }
  // 去掉旧 [compat.*] 与可能堆积的说明注释，再写回唯一一块
  out = stripDesktopCompatComments(out);
  out = stripTomlTable(out, "compat.claude");
  out = stripTomlTable(out, "compat.cursor");
  out = stripTomlTable(out, "compat.codex");
  out = out.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (out && !out.endsWith("\n")) out += "\n";
  out += (out ? "\n" : "") + COMPAT_BLOCK;
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * 重写 [plugins].disabled：去掉误加的系统目录名，确保 vendor 插件名在列。
 * 保留用户其它 disable 项。
 */
function upsertPluginsDisabled(text: string, vendorNames: string[]): string {
  let out = text.replace(/\r\n/g, "\n");
  const lines = out.split("\n");
  let inPlugins = false;
  let pluginsStart = -1;
  let disabledLine = -1;
  let existing: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[")) {
      if (/^\[plugins\]\s*$/.test(t)) {
        inPlugins = true;
        pluginsStart = i;
        disabledLine = -1;
        existing = [];
      } else {
        inPlugins = false;
      }
      continue;
    }
    if (!inPlugins) continue;
    const m = t.match(/^disabled\s*=\s*\[(.*)\]\s*$/);
    if (m) {
      disabledLine = i;
      existing = parseTomlStringArray(m[1]);
    }
  }
  // 清掉误写入的 Claude 系统目录名
  const cleaned = existing.filter((n) => !VENDOR_PLUGIN_SKIP.has(n.toLowerCase()));
  const merged = [...new Set([...cleaned, ...vendorNames])].sort();
  if (!merged.length && disabledLine < 0) return text;
  const line = `disabled = [${merged.map((n) => JSON.stringify(n)).join(", ")}]`;
  if (disabledLine >= 0) {
    lines[disabledLine] = line;
    return lines.join("\n");
  }
  if (pluginsStart >= 0) {
    lines.splice(pluginsStart + 1, 0, line);
    return lines.join("\n");
  }
  out = lines.join("\n").trimEnd();
  if (out && !out.endsWith("\n")) out += "\n";
  out += `\n[plugins]\n${line}\n`;
  return out;
}

function parseTomlStringArray(inner: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    out.push((m[1] ?? m[2] ?? "").replace(/\\"/g, '"'));
  }
  return out;
}

/** 删除 [name] 直到下一个 [section] */
function stripTomlTable(text: string, tableName: string): string {
  const lines = text.split("\n");
  const re = new RegExp(`^\\[${tableName.replace(/\./g, "\\.")}\\]\\s*$`);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[")) {
      if (re.test(t)) {
        skipping = true;
        continue;
      }
      if (skipping) skipping = false;
    }
    if (skipping) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** 路径是否落在 Claude / Cursor 兼容目录 */
export function isVendorCompatPath(p?: string | null): boolean {
  if (!p) return false;
  const n = p.replace(/\\/g, "/").toLowerCase();
  return (
    n.includes("/.claude/") ||
    n.endsWith("/.claude") ||
    n.includes("/.cursor/") ||
    n.endsWith("/.cursor")
  );
}

export function isVendorCompatSkill(s: {
  path?: string;
  sourceType?: string;
  category?: string;
}): boolean {
  if (isVendorCompatPath(s.path)) return true;
  const v = (s.category || s.sourceType || "").toLowerCase();
  return v === "claude" || v === "cursor";
}
