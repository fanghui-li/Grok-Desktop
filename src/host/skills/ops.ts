/**
 * Skill 磁盘操作：打开 / 删除 / 导入（自 DesktopHost 迁出）。
 * 列表与 resolve 仍在 SkillRegistry。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HostError } from "../../shared/errors.js";
import { openInEditor } from "../changes.js";
import type { HostLogger } from "../logger.js";
import { grokHomeDir } from "../paths.js";
import type { SkillRegistry } from "./registry.js";

export type SkillsOpsDeps = {
  home?: string;
  logger: HostLogger;
  skillRegistry: SkillRegistry;
};

function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function underRoot(dirN: string, root: string): boolean {
  const r = normPath(root).replace(/\/+$/, "");
  return dirN === r || dirN.startsWith(`${r}/`);
}

export class SkillsOps {
  constructor(private readonly deps: SkillsOpsDeps) {}

  openPath(skillPath: string): { opened: boolean; path: string } {
    const pth = (skillPath || "").trim();
    if (!pth || !fs.existsSync(pth)) {
      throw new HostError("IO_ERROR", `Skill path not found: ${skillPath}`);
    }
    const target = fs.statSync(pth).isDirectory()
      ? path.join(pth, "SKILL.md")
      : pth;
    const openTarget = fs.existsSync(target) ? target : pth;
    try {
      openInEditor(openTarget);
    } catch {
      try {
        if (process.platform === "win32") {
          spawn("explorer", ["/select,", openTarget], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", ["-R", openTarget], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else {
          spawn("xdg-open", [path.dirname(openTarget)], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      } catch (err) {
        this.deps.logger.warn("skills.openPath_fallback_failed", {
          path: openTarget,
          err: String(err),
        });
      }
    }
    return { opened: true, path: openTarget };
  }

  delete(params: {
    path: string;
    name?: string;
    projectPath?: string;
  }): { deleted: boolean; path: string; name: string } {
    const raw = (params.path || "").trim();
    if (!raw) {
      throw new HostError("INVALID_ARGUMENT", "skill path required");
    }
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      throw new HostError("IO_ERROR", `Skill path not found: ${resolved}`);
    }

    let skillDir = resolved;
    const st = fs.statSync(resolved);
    if (st.isFile()) {
      if (path.basename(resolved).toLowerCase() !== "skill.md") {
        throw new HostError("INVALID_ARGUMENT", "not a skill path");
      }
      skillDir = path.dirname(resolved);
    } else if (!st.isDirectory()) {
      throw new HostError("INVALID_ARGUMENT", "not a skill path");
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      throw new HostError("IO_ERROR", `SKILL.md not found under ${skillDir}`);
    }

    const dirN = normPath(skillDir);
    if (
      underRoot(dirN, path.join(grokHomeDir(this.deps.home), "bundled")) ||
      dirN.includes("/bundled/skills/") ||
      dirN.includes("/resources/skills/")
    ) {
      throw new HostError("PERMISSION_DENIED", "系统内置技能不可删除");
    }

    const desktopSkills = path.join(grokHomeDir(this.deps.home), "skills");
    const projectSkills = params.projectPath
      ? path.join(params.projectPath, ".grok", "skills")
      : null;

    const inUser = underRoot(dirN, desktopSkills);
    const inProject =
      (projectSkills && underRoot(dirN, projectSkills)) ||
      /[/\\]\.grok[/\\]skills([/\\]|$)/i.test(skillDir);

    if (!inUser && !inProject) {
      throw new HostError(
        "PERMISSION_DENIED",
        "仅可删除 Desktop 个人技能（~/.grok-desktop/skills）或项目技能，系统内置与插件技能不可删除",
      );
    }

    const parent = path.dirname(skillDir);
    const parentN = normPath(parent);
    const allowedParents = [
      desktopSkills,
      ...(projectSkills ? [projectSkills] : []),
    ].map((p) => normPath(p));
    const parentIsSkillsRoot =
      allowedParents.includes(parentN) ||
      /[/\\]\.grok[/\\]skills$/i.test(parent.replace(/\\/g, "/"));
    if (!parentIsSkillsRoot) {
      throw new HostError(
        "PERMISSION_DENIED",
        "skill path is not a direct skills/<name> directory",
      );
    }

    const name = (params.name || path.basename(skillDir)).trim();
    fs.rmSync(skillDir, { recursive: true, force: true });
    this.deps.skillRegistry.invalidate(params.projectPath);
    this.deps.skillRegistry.invalidate();
    this.deps.logger.info("skills.delete", { name, path: skillDir });
    return { deleted: true, path: skillDir, name };
  }

  importFromDir(params: {
    sourcePath: string;
    force?: boolean;
  }): { name: string; path: string; overwritten: boolean } {
    const raw = (params.sourcePath || "").trim();
    if (!raw) {
      throw new HostError("INVALID_ARGUMENT", "sourcePath required");
    }
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      throw new HostError("IO_ERROR", `Path not found: ${resolved}`);
    }

    let skillDir = resolved;
    const st = fs.statSync(resolved);
    if (st.isFile()) {
      if (path.basename(resolved).toLowerCase() !== "skill.md") {
        throw new HostError(
          "INVALID_ARGUMENT",
          "请选择含 SKILL.md 的技能目录",
        );
      }
      skillDir = path.dirname(resolved);
    } else if (!st.isDirectory()) {
      throw new HostError("INVALID_ARGUMENT", "请选择技能目录");
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `目录内未找到 SKILL.md：${skillDir}`,
      );
    }

    const name = path.basename(skillDir).trim();
    if (!name || name === "." || name === "..") {
      throw new HostError("INVALID_ARGUMENT", "invalid skill name");
    }

    const destRoot = path.join(grokHomeDir(this.deps.home), "skills");
    fs.mkdirSync(destRoot, { recursive: true });
    const dest = path.join(destRoot, name);

    if (normPath(skillDir) === normPath(dest)) {
      throw new HostError(
        "INVALID_ARGUMENT",
        "源目录已是 Desktop 个人技能目录",
      );
    }

    const overwritten = fs.existsSync(dest);
    if (overwritten && !params.force) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `技能「${name}」已存在，确认覆盖后再导入`,
        { code: "EXISTS", name, path: dest },
      );
    }
    if (overwritten) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(skillDir, dest, { recursive: true });
    this.deps.skillRegistry.invalidate();
    this.deps.logger.info("skills.import", {
      name,
      from: skillDir,
      to: dest,
      overwritten,
    });
    return { name, path: dest, overwritten };
  }
}
