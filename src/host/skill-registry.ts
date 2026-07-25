/**
 * Skill 单源注册表（对齐 CLI SkillInfo[] + path 绑定；交互学 Codex list 缓存）。
 *
 * - list：唯一 discovery（inspect → FS 回退由调用方注入）
 * - resolve：path 优先；否则仅在缓存内按 name 查，禁止另开扫盘
 * - 失败显式：not_found / ambiguous / read_error（无假成功 fallback）
 */
import fs from "node:fs";
import path from "node:path";
import type { SkillInfo } from "../shared/types.js";

export type SkillsResolveMode =
  | "resolved"
  | "not_found"
  | "ambiguous"
  | "read_error";

export type SkillsResolveResult = {
  name: string;
  mode: SkillsResolveMode;
  /** 仅 mode=resolved 时有完整 envelope prompt */
  prompt?: string;
  path?: string;
  description?: string;
  message?: string;
  candidates?: Array<{ name: string; path: string; scope: string }>;
};

export type SkillListFn = (projectPath?: string) => SkillInfo[];

const DEFAULT_TTL_MS = 60_000;
const MAX_BODY = 12_000;

export class SkillRegistry {
  private cache = new Map<string, { at: number; skills: SkillInfo[] }>();
  private ttlMs: number;
  private listFn: SkillListFn;

  constructor(opts: { list: SkillListFn; ttlMs?: number }) {
    this.listFn = opts.list;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** 列出 skills；force 时绕过 TTL（插件页 Refresh / 创建草稿后） */
  list(projectPath?: string, force = false): SkillInfo[] {
    const key = cacheKey(projectPath);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (!force && hit && now - hit.at < this.ttlMs) {
      return hit.skills;
    }
    const skills = this.listFn(projectPath);
    this.cache.set(key, { at: now, skills });
    return skills;
  }

  /** 清空缓存；传 projectPath 只清该 key，否则全清 */
  invalidate(projectPath?: string): void {
    if (projectPath !== undefined) {
      this.cache.delete(cacheKey(projectPath));
      return;
    }
    this.cache.clear();
  }

  /**
   * path 优先读盘；否则在 registry（cwd 对应 list）内按 name 查找。
   * 不再按名扫多个 home 根目录。
   */
  resolve(
    name: string,
    cwd?: string,
    opts?: { args?: string; path?: string },
  ): SkillsResolveResult {
    const n = normalizeSkillName(name);
    if (!n) {
      return {
        name: "",
        mode: "not_found",
        message: "skill name required",
      };
    }
    const args = (opts?.args ?? "").trim();

    // ── path-first ──
    const explicitPath = (opts?.path ?? "").trim();
    if (explicitPath) {
      return this.loadAtPath(n, explicitPath, args);
    }

    // ── registry name lookup（与 list 同集合）──
    const skills = this.list(cwd);
    const matches = findByName(skills, n);
    if (matches.length === 0) {
      return {
        name: n,
        mode: "not_found",
        message: `Skill not found: ${n}`,
      };
    }
    if (matches.length > 1) {
      return {
        name: n,
        mode: "ambiguous",
        message: `Ambiguous skill name "${n}"; use a qualified name or pick from the menu.`,
        candidates: matches.map((s) => ({
          name: s.name,
          path: s.path,
          scope: s.scope,
        })),
      };
    }
    const skill = matches[0]!;
    const skillPath = (skill.path || "").trim();
    if (!skillPath) {
      return {
        name: n,
        mode: "not_found",
        message: `Skill "${n}" has no path`,
      };
    }
    return this.loadAtPath(skill.name || n, skillPath, args);
  }

  private loadAtPath(
    displayName: string,
    rawPath: string,
    args: string,
  ): SkillsResolveResult {
    const skillMd = resolveSkillMdPath(rawPath);
    if (!skillMd) {
      return {
        name: displayName,
        mode: "read_error",
        path: rawPath,
        message: `Skill file not found: ${rawPath}`,
      };
    }
    try {
      const raw = fs.readFileSync(skillMd, "utf8");
      const { description, body } = parseSkillMd(raw);
      const content = body.slice(0, MAX_BODY);
      const n = displayName;
      const descAttr = xmlAttr(description || n);
      const pathAttr = xmlAttr(skillMd);
      const nameAttr = xmlAttr(n);
      const argsAttr = args ? ` args="${xmlAttr(args)}"` : "";
      const envelope =
        `<skill name="${nameAttr}" description="${descAttr}" path="${pathAttr}"${argsAttr}>\n` +
        `${content}\n` +
        `</skill>`;
      const prompt = buildSkillInformationPrompt(n, skillMd, envelope);
      return {
        name: n,
        mode: "resolved",
        path: skillMd,
        description: description || undefined,
        prompt,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        name: displayName,
        mode: "read_error",
        path: skillMd,
        message: `Failed to read skill: ${msg}`,
      };
    }
  }
}

function cacheKey(projectPath?: string): string {
  return (projectPath ?? "").trim();
}

export function normalizeSkillName(name: string): string {
  return name.trim().replace(/^\//, "").replace(/^skill:/i, "");
}

/** slash 菜单：userInvocable !== false（缺省 true） */
export function isUserInvocableSkill(s: SkillInfo): boolean {
  return s.userInvocable !== false;
}

function findByName(skills: SkillInfo[], n: string): SkillInfo[] {
  const lower = n.toLowerCase();
  const exact = skills.filter(
    (s) => s.name === n || s.name.toLowerCase() === lower,
  );
  if (exact.length > 0) return exact;
  // 裸名：匹配 "scope:name" 后缀唯一时（学 Codex endsWith :name）
  if (!n.includes(":")) {
    const suffixed = skills.filter((s) =>
      s.name.toLowerCase().endsWith(`:${lower}`),
    );
    if (suffixed.length === 1) return suffixed;
  }
  return [];
}

function resolveSkillMdPath(rawPath: string): string | null {
  const p = rawPath.trim();
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (st.isFile()) return p;
    if (st.isDirectory()) {
      for (const name of ["SKILL.md", "skill.md"]) {
        const md = path.join(p, name);
        if (fs.existsSync(md) && fs.statSync(md).isFile()) return md;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function parseSkillMd(raw: string): { description: string; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!fm) {
    return { description: "", body: text.trim() };
  }
  const head = fm[1] ?? "";
  const body = (fm[2] ?? "").trim();
  const d = /^description:\s*(.+)$/m.exec(head);
  let description = d?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!description) {
    const nm = /^name:\s*(.+)$/m.exec(head);
    description = nm?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  }
  return { description, body };
}

function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSkillInformationPrompt(
  name: string,
  skillPath: string,
  skillEnvelope: string,
): string {
  return (
    `<skill_information>\n` +
    `<skills_referenced>\n` +
    `- name="${xmlAttr(name)}" path="${xmlAttr(skillPath)}"\n` +
    `</skills_referenced>\n` +
    `${skillEnvelope}\n` +
    `</skill_information>`
  );
}
