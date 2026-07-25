/**
 * Desktop hooks 磁盘发现（只读列表，供设置页）。
 * 运行时执行仍由 agent（xai-grok-hooks）负责。
 */
import fs from "node:fs";
import path from "node:path";
import { isFolderTrusted } from "./folder-trust.js";
import { hooksDir } from "./paths.js";

export type HookListItem = {
  id: string;
  name: string;
  path: string;
  scope: "user" | "project";
  /** 全局恒 true；项目 = folder-trust */
  trusted: boolean;
  source: string;
};

function listJsonHooksInDir(
  dir: string,
  scope: "user" | "project",
  trusted: boolean,
  source: string,
): HookListItem[] {
  const out: HookListItem[] = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".json")) continue;
      const full = path.join(dir, ent.name);
      const name = ent.name.replace(/\.json$/i, "");
      out.push({
        id: `${scope}:${full}`,
        name,
        path: full,
        scope,
        trusted,
        source,
      });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listDesktopHooks(
  home?: string,
  opts?: { projectPath?: string },
): {
  hooks: HookListItem[];
  hooksDir: string;
  note?: string;
} {
  const userDir = hooksDir(home);
  const hooks: HookListItem[] = [
    ...listJsonHooksInDir(userDir, "user", true, "user_hooks"),
  ];

  const projectPath = opts?.projectPath?.trim();
  if (projectPath) {
    const projHooks = path.join(projectPath, ".grok", "hooks");
    const trusted = isFolderTrusted(projectPath, home);
    hooks.push(
      ...listJsonHooksInDir(
        projHooks,
        "project",
        trusted,
        trusted ? "project_hooks" : "project_hooks_untrusted",
      ),
    );
  }

  return {
    hooks,
    hooksDir: userDir,
    note:
      hooks.length === 0
        ? "No hook JSON files under Desktop GROK_HOME/hooks (or project .grok/hooks). Runtime is agent-side."
        : undefined,
  };
}
