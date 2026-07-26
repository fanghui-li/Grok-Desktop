/**
 * skill resolve + composer 行内 slash 本地执行（自 main 迁出）。
 * 原生命令优先；skill 走 Host skills.resolve envelope。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  resolveSlashCommand,
  type SlashCommandDef,
} from "./commands.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type SkillActionsDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveCwd: () => string | null | undefined;
  getSelectedProjectPath: () => string | undefined;
  getActiveSessionId: () => string | null;
  ensureSessionForAgentSlash: (opts?: {
    title?: string;
  }) => Promise<
    { ok: true; threadId: string } | { ok: false; error: string }
  >;
  showWelcome: (show: boolean) => void;
  appendLine: (text: string, kind: "system" | "assistant" | "user" | "error") => void;
  dispatchAgentPrompt: (
    body: string,
    display: string,
    opts?: { force?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  getStaticSlashCommands: () => SlashCommandDef[];
  runSlashCommand: (
    cmd: SlashCommandDef,
    args: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  activeComposerInput: () => HTMLTextAreaElement | null;
  hideSlashPalette: () => void;
  findSkillPathFromPaletteCache: (name: string) => string | undefined;
};

export class SkillActions {
  constructor(private readonly deps: SkillActionsDeps) {}

  /**
   * resolve skill →（必要时先建会话）→ dispatchAgentPrompt。
   * @returns handled：是否已作为 skill 路径处理（含失败）
   */
  async runResolved(
    name: string,
    skillArgs: string,
    opts?: { path?: string },
  ): Promise<{ handled: boolean; ok?: boolean; message?: string }> {
    const n = name.replace(/^\//, "").toLowerCase();
    const cachedPath =
      opts?.path?.trim() || this.deps.findSkillPathFromPaletteCache(n);
    const resolved = await this.deps.inv<{
      mode: string;
      prompt?: string;
      name: string;
      message?: string;
    }>("skills.resolve", {
      name: n,
      cwd: this.deps.getActiveCwd() || this.deps.getSelectedProjectPath(),
      args: skillArgs || undefined,
      path: cachedPath,
    });

    if (
      resolved.ok &&
      resolved.data?.mode === "resolved" &&
      resolved.data.prompt
    ) {
      const display = `/${n}${skillArgs ? " " + skillArgs : ""}`;
      const body = skillArgs
        ? `${resolved.data.prompt}\n\nUser request:\n${skillArgs}`
        : resolved.data.prompt;

      // 无 session（欢迎页）：先 create，再 dispatch
      if (!this.deps.getActiveSessionId() || !this.deps.getActiveCwd()) {
        const created = await this.deps.ensureSessionForAgentSlash({
          title: display,
        });
        if (!created.ok) {
          this.deps.showWelcome(false);
          this.deps.appendLine(created.error, "error");
          return { handled: true, ok: false, message: created.error };
        }
      }

      const sent = await this.deps.dispatchAgentPrompt(body, display, {
        force: false,
      });
      return {
        handled: true,
        ok: sent.ok,
        message: sent.ok
          ? tr("slash.skillResolved", { name: n })
          : sent.error,
      };
    }

    if (
      resolved.ok &&
      resolved.data &&
      (resolved.data.mode === "ambiguous" ||
        resolved.data.mode === "read_error" ||
        (resolved.data.mode === "not_found" && cachedPath))
    ) {
      return {
        handled: true,
        ok: false,
        message:
          resolved.data.message || tr("slash.skillNotFound", { name: n }),
      };
    }

    return { handled: false };
  }

  /**
   * 发送路径：若整行是已知 slash（含 paletteHidden），本地执行不交 agent。
   * 返回 true 表示已处理并应中止发送。
   */
  async tryRunComposerLine(raw: string): Promise<boolean> {
    const t = raw.trim();
    if (!t.startsWith("/")) return false;
    const m = t.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!m) return false;
    const name = (m[1] ?? "").toLowerCase();
    if (!name) return false;
    const staticCmd = resolveSlashCommand(
      this.deps.getStaticSlashCommands(),
      name,
    );
    if (staticCmd) {
      const ta = this.deps.activeComposerInput();
      if (ta) ta.value = "";
      this.deps.hideSlashPalette();
      const res = await this.deps.runSlashCommand(
        staticCmd,
        (m[2] ?? "").trim(),
      );
      if (res.message) {
        this.deps.showToast(res.message, res.ok ? "info" : "error");
      }
      return true;
    }
    {
      const skillArgs = (m[2] ?? "").trim();
      const skillRes = await this.runResolved(name, skillArgs);
      if (skillRes.handled) {
        const ta = this.deps.activeComposerInput();
        if (ta) ta.value = "";
        this.deps.hideSlashPalette();
        if (skillRes.message && !skillRes.ok) {
          this.deps.showToast(skillRes.message, "error");
        }
        return true;
      }
    }
    return false;
  }
}
