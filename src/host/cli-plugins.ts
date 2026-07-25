/**
 * 通过 `grok plugin|mcp|inspect` 与 CLI 同源管理扩展。
 * 一律在调用方传入的 env（含 GROK_HOME=Desktop profile）下执行。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  McpServerInfo,
  PluginComponentSummary,
  PluginInfo,
  PluginMarketplaceSource,
  SkillInfo,
} from "../shared/types.js";
import { HostError } from "../shared/errors.js";
import {
  listMcpFromConfig,
  listPlugins as listPluginsFs,
  listSkills as listSkillsFs,
} from "./extensibility.js";
import { isVendorCompatPath, isVendorCompatSkill } from "./compat.js";

/** inspect 未带 argument-hint 时，从 SKILL.md frontmatter 补全 */
function readArgumentHintFromPath(skillPath: string): string | undefined {
  if (!skillPath) return undefined;
  const candidates = [
    skillPath,
    path.join(skillPath, "SKILL.md"),
    path.join(skillPath, "skill.md"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      const text = fs.readFileSync(p, "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      if (!fm) continue;
      const h =
        /^argument-hint:\s*(.+)$/m.exec(fm[1]) ||
        /^argumentHint:\s*(.+)$/m.exec(fm[1]) ||
        /^argument_hint:\s*(.+)$/m.exec(fm[1]);
      if (h) return h[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* next */
    }
  }
  return undefined;
}

export type GrokCliRunner = {
  binary: string;
  env: NodeJS.ProcessEnv;
  /** OS home 传入 list* 回退扫描 */
  home?: string;
};

function runGrok(
  runner: GrokCliRunner,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(runner.binary, args, {
    encoding: "utf8",
    timeout: opts?.timeoutMs ?? 90_000,
    env: runner.env,
    cwd: opts?.cwd,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
}

function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // 截掉可能的日志前缀，取首个 [ 或 {
    const iArr = t.indexOf("[");
    const iObj = t.indexOf("{");
    let i = -1;
    if (iArr >= 0 && iObj >= 0) i = Math.min(iArr, iObj);
    else i = Math.max(iArr, iObj);
    if (i < 0) throw new Error("not json");
    return JSON.parse(t.slice(i));
  }
}

function failFrom(r: { code: number | null; stdout: string; stderr: string }, fallback: string): never {
  const msg =
    (r.stderr || r.stdout || fallback).trim().split(/\r?\n/).filter(Boolean).slice(0, 6).join("\n") ||
    fallback;
  throw new HostError("IO_ERROR", msg);
}

// ── Skills（P0：inspect 同源）────────────────────────────────

export function skillsListCli(
  runner: GrokCliRunner | null,
  projectPath?: string,
): SkillInfo[] {
  if (runner?.binary) {
    try {
      const r = runGrok(runner, ["inspect", "--json"], {
        cwd: projectPath || undefined,
        timeoutMs: 45_000,
      });
      if (r.code === 0) {
        const data = parseJsonLoose(r.stdout) as {
          skills?: Array<{
            name?: string;
            description?: string;
            source?: { type?: string; path?: string };
            vendor?: string;
            argumentHint?: string;
            argument_hint?: string;
            "argument-hint"?: string;
          }>;
        } | null;
        if (Array.isArray(data?.skills) && data!.skills!.length) {
          return data!.skills!
            .filter((s) => {
              // 兼容已关闭 / 被 disabled 的不展示、不进入「可用」心智
              if (s && typeof s === "object") {
                const o = s as {
                  disabled?: boolean;
                  compatibilityStatus?: string;
                  vendor?: string;
                  source?: { path?: string };
                };
                if (o.disabled) return false;
                if (o.compatibilityStatus === "disabled") return false;
                if (isVendorCompatSkill({
                  path: o.source?.path,
                  category: o.vendor,
                  sourceType: o.vendor,
                })) {
                  return false;
                }
              }
              return true;
            })
            .map((s) => {
              const srcType = s.source?.type ?? "unknown";
              let scope: SkillInfo["scope"] = "unknown";
              if (
                srcType === "project" ||
                srcType === "repo" ||
                srcType === "local"
              ) {
                scope = "project";
              } else if (
                srcType === "user" ||
                srcType === "bundled" ||
                srcType === "plugin"
              ) {
                scope = "user";
              }
              const hintRaw =
                s.argumentHint ??
                s.argument_hint ??
                s["argument-hint"];
              const skillPath = s.source?.path ?? "";
              let argumentHint =
                typeof hintRaw === "string" && hintRaw.trim()
                  ? hintRaw.trim()
                  : undefined;
              if (!argumentHint && skillPath) {
                argumentHint = readArgumentHintFromPath(skillPath);
              }
              return {
                name: String(s.name ?? "skill"),
                path: skillPath,
                description: s.description,
                scope,
                category: s.vendor || srcType,
                sourceType: srcType,
                argumentHint,
              };
            });
        }
      }
    } catch {
      /* fallback fs */
    }
  }
  return listSkillsFs({ home: runner?.home, projectPath });
}

// ── Plugins list（P0）──────────────────────────────────────

function mapPluginRow(raw: Record<string, unknown>): PluginInfo {
  const components = raw.components as
    | {
        skills?: unknown[];
        agents?: unknown[];
        hooks?: unknown[];
        mcpServers?: unknown[];
        commands?: unknown[];
      }
    | undefined;
  const provides = raw.provides as
    | {
        skills?: number;
        agents?: number;
        hooks?: boolean | number;
        mcpServers?: number;
      }
    | undefined;

  const summary: PluginComponentSummary | undefined =
    components || provides
      ? {
          skills:
            provides?.skills ??
            (Array.isArray(components?.skills) ? components!.skills!.length : 0),
          agents:
            provides?.agents ??
            (Array.isArray(components?.agents) ? components!.agents!.length : 0),
          hooks: Boolean(
            provides?.hooks ??
              (Array.isArray(components?.hooks) && components!.hooks!.length > 0),
          ),
          mcpServers:
            provides?.mcpServers ??
            (Array.isArray(components?.mcpServers)
              ? components!.mcpServers!.length
              : 0),
          commands: Array.isArray(components?.commands)
            ? components!.commands!.length
            : undefined,
        }
      : undefined;

  const status = String(raw.status ?? (raw.enabled === false ? "disabled" : "installed"));
  const scopeRaw = String(raw.scope ?? raw.marketplace ?? "user");
  let scope: PluginInfo["scope"] = "unknown";
  if (scopeRaw === "project") scope = "project";
  else if (scopeRaw === "user" || scopeRaw === "cli" || scopeRaw === "custom") scope = "user";
  else if (raw.marketplace) scope = "user";

  return {
    name: String(raw.name ?? "plugin"),
    path: String(raw.path ?? ""),
    enabled: status !== "disabled" && raw.enabled !== false && status !== "available",
    trusted: raw.trusted !== false,
    scope,
    description: raw.description ? String(raw.description) : undefined,
    version: raw.version != null ? String(raw.version) : undefined,
    status: status as PluginInfo["status"],
    marketplace: raw.marketplace ? String(raw.marketplace) : undefined,
    components: summary,
  };
}

export function pluginsListCli(
  runner: GrokCliRunner | null,
  opts?: { projectPath?: string; available?: boolean },
): PluginInfo[] {
  if (runner?.binary) {
    try {
      const args = ["plugin", "list", "--json"];
      if (opts?.available) args.push("--available");
      const r = runGrok(runner, args, {
        cwd: opts?.projectPath || undefined,
        timeoutMs: opts?.available ? 120_000 : 45_000,
      });
      if (r.code === 0) {
        const data = parseJsonLoose(r.stdout);
        if (Array.isArray(data)) {
          const list = data
            .map((x) => mapPluginRow(x as Record<string, unknown>))
            .filter((p) => !isVendorCompatPath(p.path));
          // 无 --available 时 CLI 可能返回 []，再合并 inspect（排除 .claude/.cursor）
          if (!opts?.available) {
            const discovered = pluginsFromInspect(runner, opts?.projectPath).filter(
              (p) => !isVendorCompatPath(p.path),
            );
            const names = new Set(list.map((p) => p.name.toLowerCase()));
            for (const d of discovered) {
              if (!names.has(d.name.toLowerCase())) list.push(d);
            }
          }
          return list;
        }
      }
    } catch {
      /* fallback */
    }
  }
  return listPluginsFs({ home: runner?.home, projectPath: opts?.projectPath });
}

function pluginsFromInspect(
  runner: GrokCliRunner,
  projectPath?: string,
): PluginInfo[] {
  try {
    const r = runGrok(runner, ["inspect", "--json"], {
      cwd: projectPath || undefined,
      timeoutMs: 45_000,
    });
    if (r.code !== 0) return [];
    const data = parseJsonLoose(r.stdout) as {
      plugins?: Array<Record<string, unknown>> | Record<string, unknown>;
    } | null;
    if (!data?.plugins) return [];
    const arr = Array.isArray(data.plugins) ? data.plugins : [data.plugins];
    return arr
      .map((p) => {
        const mapped = mapPluginRow(p);
        if (!mapped.status) mapped.status = "discovered";
        return mapped;
      })
      .filter((p) => !isVendorCompatPath(p.path));
  } catch {
    return [];
  }
}

// ── Plugin mutations（P1）──────────────────────────────────

export function pluginsInstall(
  runner: GrokCliRunner,
  source: string,
  opts?: { trust?: boolean },
): { ok: true; message: string } {
  const args = ["plugin", "install", source];
  if (opts?.trust !== false) args.push("--trust");
  const r = runGrok(runner, args, { timeoutMs: 180_000 });
  if (r.code !== 0) failFrom(r, `plugin install failed: ${source}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已安装 ${source}`).trim().slice(0, 400),
  };
}

export function pluginsUninstall(
  runner: GrokCliRunner,
  name: string,
  opts?: { confirm?: boolean; keepData?: boolean },
): { ok: true; message: string } {
  const args = ["plugin", "uninstall", name];
  if (opts?.confirm !== false) args.push("--confirm");
  if (opts?.keepData) args.push("--keep-data");
  const r = runGrok(runner, args, { timeoutMs: 90_000 });
  if (r.code !== 0) failFrom(r, `plugin uninstall failed: ${name}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已卸载 ${name}`).trim().slice(0, 400),
  };
}

export function pluginsEnable(
  runner: GrokCliRunner,
  name: string,
): { ok: true; message: string } {
  const r = runGrok(runner, ["plugin", "enable", name], { timeoutMs: 60_000 });
  if (r.code !== 0) failFrom(r, `plugin enable failed: ${name}`);
  return { ok: true, message: (r.stdout || `已启用 ${name}`).trim().slice(0, 400) };
}

export function pluginsDisable(
  runner: GrokCliRunner,
  name: string,
): { ok: true; message: string } {
  const r = runGrok(runner, ["plugin", "disable", name], { timeoutMs: 60_000 });
  if (r.code !== 0) failFrom(r, `plugin disable failed: ${name}`);
  return { ok: true, message: (r.stdout || `已禁用 ${name}`).trim().slice(0, 400) };
}

export function pluginsUpdate(
  runner: GrokCliRunner,
  name?: string,
): { ok: true; message: string } {
  const args = name ? ["plugin", "update", name] : ["plugin", "update"];
  const r = runGrok(runner, args, { timeoutMs: 180_000 });
  if (r.code !== 0) failFrom(r, "plugin update failed");
  return {
    ok: true,
    message: (r.stdout || r.stderr || "已更新").trim().slice(0, 400),
  };
}

/** P2：详情（CLI 多为文本） */
export function pluginsDetails(
  runner: GrokCliRunner,
  name: string,
): { name: string; text: string; components?: PluginComponentSummary } {
  const r = runGrok(runner, ["plugin", "details", name], { timeoutMs: 45_000 });
  if (r.code !== 0) {
    // 尝试从 available 列表取 components
    try {
      const list = pluginsListCli(runner, { available: true });
      const hit = list.find((p) => p.name === name);
      if (hit) {
        return {
          name,
          text: [
            hit.description ?? "",
            hit.marketplace ? `marketplace: ${hit.marketplace}` : "",
            hit.components
              ? `skills=${hit.components.skills} agents=${hit.components.agents} hooks=${hit.components.hooks} mcp=${hit.components.mcpServers}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          components: hit.components,
        };
      }
    } catch {
      /* ignore */
    }
    failFrom(r, `plugin details failed: ${name}`);
  }
  return { name, text: (r.stdout || r.stderr).trim() };
}

// ── Marketplace（P2）───────────────────────────────────────

export function marketplaceListCli(
  runner: GrokCliRunner,
): PluginMarketplaceSource[] {
  const r = runGrok(runner, ["plugin", "marketplace", "list", "--json"], {
    timeoutMs: 60_000,
  });
  if (r.code !== 0) failFrom(r, "marketplace list failed");
  const data = parseJsonLoose(r.stdout);
  if (!Array.isArray(data)) return [];
  return data.map((x) => {
    const o = x as Record<string, unknown>;
    const source = o.source as Record<string, unknown> | string | undefined;
    let url = "";
    if (typeof source === "string") url = source;
    else if (source && typeof source === "object") {
      url = String(source.url ?? source.path ?? "");
    }
    return {
      name: String(o.name ?? (url || "marketplace")),
      kind: o.kind ? String(o.kind) : undefined,
      url: url || String(o.url ?? ""),
      branch:
        source && typeof source === "object" && source.branch != null
          ? String(source.branch)
          : undefined,
    };
  });
}

export function marketplaceAdd(
  runner: GrokCliRunner,
  url: string,
): { ok: true; message: string } {
  const r = runGrok(runner, ["plugin", "marketplace", "add", url], {
    timeoutMs: 120_000,
  });
  if (r.code !== 0) failFrom(r, `marketplace add failed: ${url}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已添加源 ${url}`).trim().slice(0, 400),
  };
}

export function marketplaceRemove(
  runner: GrokCliRunner,
  url: string,
): { ok: true; message: string } {
  const r = runGrok(runner, ["plugin", "marketplace", "remove", url], {
    timeoutMs: 90_000,
  });
  if (r.code !== 0) failFrom(r, `marketplace remove failed: ${url}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已移除源 ${url}`).trim().slice(0, 400),
  };
}

export function marketplaceUpdate(
  runner: GrokCliRunner,
  name?: string,
): { ok: true; message: string } {
  const args = name
    ? ["plugin", "marketplace", "update", name]
    : ["plugin", "marketplace", "update"];
  const r = runGrok(runner, args, { timeoutMs: 180_000 });
  if (r.code !== 0) failFrom(r, "marketplace update failed");
  return {
    ok: true,
    message: (r.stdout || r.stderr || "市场源已刷新").trim().slice(0, 400),
  };
}

// ── MCP（P0 list + P1 add/remove/doctor）───────────────────

export function mcpListCli(runner: GrokCliRunner | null): McpServerInfo[] {
  if (runner?.binary) {
    try {
      const r = runGrok(runner, ["mcp", "list", "--json"], { timeoutMs: 30_000 });
      if (r.code === 0) {
        const data = parseJsonLoose(r.stdout);
        if (Array.isArray(data)) {
          return data.map((x) => {
            const o = x as Record<string, unknown>;
            return {
              name: String(o.name ?? "mcp"),
              status: (o.enabled === false ? "disabled" : "configured") as McpServerInfo["status"],
              transport: o.transport
                ? String(o.transport)
                : o.url
                  ? "http"
                  : o.command
                    ? "stdio"
                    : undefined,
              command: o.command ? String(o.command) : undefined,
              url: o.url ? String(o.url) : undefined,
              enabled: o.enabled !== false,
            };
          });
        }
      }
      // inspect fallback
      const ins = runGrok(runner, ["inspect", "--json"], { timeoutMs: 45_000 });
      if (ins.code === 0) {
        const data = parseJsonLoose(ins.stdout) as {
          mcpServers?: Array<Record<string, unknown>> | Record<string, unknown>;
        } | null;
        if (data?.mcpServers) {
          const arr: Record<string, unknown>[] = Array.isArray(data.mcpServers)
            ? data.mcpServers
            : Object.entries(data.mcpServers).map(([name, v]) => ({
                name,
                ...(typeof v === "object" && v && !Array.isArray(v)
                  ? (v as Record<string, unknown>)
                  : {}),
              }));
          return arr.map((o) => ({
            name: String(o.name ?? "mcp"),
            status: "configured" as const,
            transport: o.transport ? String(o.transport) : undefined,
            command: o.command ? String(o.command) : undefined,
            url: o.url ? String(o.url) : undefined,
          }));
        }
      }
    } catch {
      /* fs */
    }
  }
  return listMcpFromConfig(runner?.home);
}

export function mcpAddCli(
  runner: GrokCliRunner,
  input: {
    name: string;
    commandOrUrl?: string;
    args?: string[];
    transport?: "stdio" | "http" | "sse";
    scope?: "user" | "project";
    env?: string[];
    headers?: string[];
    cwd?: string;
  },
): { ok: true; message: string } {
  const args = ["mcp", "add", input.name];
  if (input.transport) args.push("--transport", input.transport);
  if (input.scope) args.push("--scope", input.scope);
  for (const e of input.env ?? []) args.push("-e", e);
  for (const h of input.headers ?? []) args.push("--header", h);
  if (input.commandOrUrl) {
    if (input.transport === "http" || input.transport === "sse") {
      args.push(input.commandOrUrl);
    } else {
      // stdio: grok mcp add name -- cmd args...
      args.push("--", input.commandOrUrl, ...(input.args ?? []));
    }
  }
  const r = runGrok(runner, args, {
    cwd: input.cwd,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) failFrom(r, `mcp add failed: ${input.name}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已添加 MCP ${input.name}`).trim().slice(0, 400),
  };
}

export function mcpRemoveCli(
  runner: GrokCliRunner,
  name: string,
  opts?: { scope?: "user" | "project"; cwd?: string },
): { ok: true; message: string } {
  const args = ["mcp", "remove", name];
  if (opts?.scope) args.push("--scope", opts.scope);
  const r = runGrok(runner, args, { cwd: opts?.cwd, timeoutMs: 45_000 });
  if (r.code !== 0) failFrom(r, `mcp remove failed: ${name}`);
  return {
    ok: true,
    message: (r.stdout || r.stderr || `已移除 MCP ${name}`).trim().slice(0, 400),
  };
}

export function mcpDoctorCli(
  runner: GrokCliRunner,
  name?: string,
): { text: string; json?: unknown } {
  const args = ["mcp", "doctor", "--json"];
  if (name) args.push(name);
  const r = runGrok(runner, args, { timeoutMs: 90_000 });
  // doctor 可能非 0 仍有诊断输出
  let json: unknown;
  try {
    json = parseJsonLoose(r.stdout);
  } catch {
    json = undefined;
  }
  const text = (r.stdout || r.stderr || "").trim();
  if (r.code !== 0 && !text) failFrom(r, "mcp doctor failed");
  return { text, json };
}
