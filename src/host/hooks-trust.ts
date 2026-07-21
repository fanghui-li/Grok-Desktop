/**
 * Desktop-side hooks trust map + config.toml event scan (P3-B).
 * Trust is stored under desktop/hooks-trust.json; list always merges this map.
 */
import fs from "node:fs";
import path from "node:path";
import { desktopDir, grokHomeDir } from "./paths.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
] as const;

export type HookListItem = {
  id: string;
  source: string;
  event?: string;
  command?: string;
  trusted: boolean;
  path?: string;
};

export function hooksTrustPath(home?: string): string {
  return path.join(desktopDir(home), "hooks-trust.json");
}

/** Load trust map; missing file → empty. */
export function loadHooksTrustMap(home?: string): Record<string, boolean> {
  const p = hooksTrustPath(home);
  try {
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
      string,
      boolean
    >;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveHooksTrustMap(
  map: Record<string, boolean>,
  home?: string,
): void {
  const p = hooksTrustPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map, null, 2), "utf8");
}

export function setHookTrusted(
  id: string,
  trusted: boolean,
  home?: string,
): Record<string, boolean> {
  const map = loadHooksTrustMap(home);
  map[id] = trusted;
  saveHooksTrustMap(map, home);
  return map;
}

/**
 * Whether a hook id is trusted.
 * Explicit false in map → untrusted; explicit true → trusted;
 * missing key → defaultTrusted (scanned config events default false until user trusts).
 */
export function isHookTrusted(
  id: string,
  map: Record<string, boolean>,
  defaultTrusted = false,
): boolean {
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    return map[id] === true;
  }
  return defaultTrusted;
}

/** Scan Desktop GROK_HOME config.toml for known hook event name mentions. */
export function scanConfigHookEvents(home?: string): HookListItem[] {
  const configPath = path.join(grokHomeDir(home), "config.toml");
  const trust = loadHooksTrustMap(home);
  const hooks: HookListItem[] = [];
  try {
    if (!fs.existsSync(configPath)) return hooks;
    const text = fs.readFileSync(configPath, "utf8");
    for (const ev of HOOK_EVENTS) {
      if (!text.includes(ev)) continue;
      const id = `config:${ev}`;
      hooks.push({
        id,
        source: "user_config",
        event: ev,
        trusted: isHookTrusted(id, trust, false),
        path: configPath,
      });
    }
  } catch {
    /* ignore */
  }
  return hooks;
}

export function listDesktopHooks(home?: string): {
  hooks: HookListItem[];
  note?: string;
} {
  const hooks = scanConfigHookEvents(home);
  return {
    hooks,
    note: hooks.length
      ? undefined
      : "No hooks detected in Desktop GROK_HOME config; use Open config or CLI hooks-*",
  };
}
