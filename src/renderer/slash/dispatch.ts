/**
 * runSlashCommand 分发（自 main 迁出）。
 * 各 case 经 deps 回调到既有 ensureXxx / main 薄封装，不搬业务实现。
 */
import { tr } from "../../shared/i18n/index.js";
import type { EffortLevel } from "../model/effort.js";
import type { SlashCommandDef } from "./commands.js";

type OkMsg = { ok: boolean; message?: string };
type OkMsgR = OkMsg | Promise<OkMsg>;

export type SlashDispatchDeps = {
  getAccessMode: () => "normal" | "always_approve";
  setAccessMode: (mode: "normal" | "always_approve") => void;
  isPlanOn: () => boolean;
  syncSessionPolicyLive: (opts: {
    alwaysApprove: boolean;
    plan: boolean;
  }) => Promise<OkMsg>;
  syncPermLabels: () => void;
  exitPlanMode: () => void;
  enterPlanMode: () => Promise<OkMsg>;
  showViewPlan: () => Promise<OkMsg>;
  runGoalCommand: (
    sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
  ) => Promise<OkMsg>;
  promptSetMaxTurns: (turns?: number) => Promise<OkMsg>;
  findSkillPathFromPaletteCache: (name: string) => string | undefined;
  runResolvedSkillSlash: (
    name: string,
    args: string,
    opts?: { path?: string },
  ) => Promise<{ handled: boolean; ok?: boolean; message?: string }>;
  insertComposerText: (text: string) => void;
  runMemoryCommand: (
    sub: "list" | "add" | "search" | "status" | "flush" | "dream",
  ) => Promise<OkMsg>;
  promptSetModel: () => Promise<OkMsg>;
  isWelcomeVisible: () => boolean;
  getModelMenuAnchorWelcome: () => HTMLElement | null;
  getModelMenuAnchorChat: () => HTMLElement | null;
  showModelMenu: (anchor: HTMLElement) => void;
  showContextDetails: () => Promise<OkMsg>;
  applySessionModelAndEffort: (opts: {
    effort: EffortLevel;
    focus: "effort";
  }) => Promise<OkMsg>;
  promptSetEffort: () => Promise<OkMsg>;
  showStatus: () => OkMsgR;
  exportActiveSession: (opts: { destination: "clipboard" }) => Promise<OkMsg>;
  compactActiveSession: () => Promise<OkMsg>;
  forkActiveSession: (args?: string) => Promise<OkMsg>;
  rewindViaSlash: () => Promise<OkMsg>;
  showPromptQueueModal: () => OkMsgR;
  promptQueueLength: () => number;
  clearPromptQueue: () => void;
  showTasksPanel: () => OkMsgR;
  showPromptHistorySearch: () => OkMsgR;
  runBtwCommand: (question?: string) => Promise<OkMsg>;
  runInterjectCommand: (text?: string) => Promise<OkMsg>;
  permLabel: () => string;
  getComposerInput: () => HTMLTextAreaElement | null;
  getChatInput: () => HTMLTextAreaElement | null;
  getFocusInput: () => HTMLTextAreaElement | null;
  isChatVisible: () => boolean;
};

export class SlashDispatch {
  constructor(private readonly deps: SlashDispatchDeps) {}

  async run(
    cmd: SlashCommandDef,
    args = "",
  ): Promise<{ ok: boolean; message?: string }> {
    const act = cmd.action;
    switch (act.kind) {
      case "set-perm":
        if (act.mode === "always_approve") {
          const on = this.deps.getAccessMode() !== "always_approve";
          this.deps.setAccessMode(on ? "always_approve" : "normal");
          const sync = await this.deps.syncSessionPolicyLive({
            alwaysApprove: on,
            plan: this.deps.isPlanOn(),
          });
          this.deps.syncPermLabels();
          return {
            ok: sync.ok,
            message: !sync.ok
              ? sync.message
              : on
                ? tr("slash.fullOn")
                : tr("slash.fullOff"),
          };
        }
        if (act.mode === "plan") {
          if (this.deps.isPlanOn()) {
            this.deps.exitPlanMode();
            return { ok: true, message: tr("slash.exitPlan") };
          }
          return this.deps.enterPlanMode();
        }
        this.deps.setAccessMode("normal");
        await this.deps.syncSessionPolicyLive({
          alwaysApprove: false,
          plan: this.deps.isPlanOn(),
        });
        this.deps.syncPermLabels();
        return {
          ok: true,
          message: tr("slash.permTo", { label: this.deps.permLabel() }),
        };
      case "view-plan":
        return this.deps.showViewPlan();
      case "goal":
        return this.deps.runGoalCommand(act.sub ?? "set");
      case "set-max-turns":
        return this.deps.promptSetMaxTurns(act.turns);
      case "agent-command": {
        const name = act.name.replace(/^\//, "").replace(/^skill:/i, "");
        const skillPath =
          act.path?.trim() || this.deps.findSkillPathFromPaletteCache(name);
        const skillRes = await this.deps.runResolvedSkillSlash(name, args, {
          path: skillPath,
        });
        if (skillRes.handled) {
          return {
            ok: Boolean(skillRes.ok),
            message: skillRes.message,
          };
        }
        this.deps.insertComposerText(`/${name} `);
        return { ok: true, message: tr("slash.agentCmdInserted", { name }) };
      }
      case "memory":
        return this.deps.runMemoryCommand(act.sub ?? "list");
      case "set-model":
        return this.deps.promptSetModel();
      case "open-model-menu": {
        const welcome = this.deps.isWelcomeVisible();
        const anchor = (
          welcome
            ? this.deps.getModelMenuAnchorWelcome()
            : this.deps.getModelMenuAnchorChat()
        ) as HTMLElement;
        this.deps.showModelMenu(anchor);
        return { ok: true };
      }
      case "show-context":
        return this.deps.showContextDetails();
      case "set-effort": {
        if (act.level) {
          return this.deps.applySessionModelAndEffort({
            effort: act.level,
            focus: "effort",
          });
        }
        return this.deps.promptSetEffort();
      }
      case "status":
        return this.deps.showStatus();
      case "export-session":
        return this.deps.exportActiveSession({ destination: "clipboard" });
      case "compact-session":
        return this.deps.compactActiveSession();
      case "fork-session":
        return this.deps.forkActiveSession(args);
      case "rewind-session":
        return this.deps.rewindViaSlash();
      case "show-queue":
        return this.deps.showPromptQueueModal();
      case "clear-queue": {
        if (!this.deps.promptQueueLength()) {
          return { ok: true, message: tr("queue.empty") };
        }
        this.deps.clearPromptQueue();
        return { ok: true, message: tr("queue.cleared") };
      }
      case "show-tasks":
        return this.deps.showTasksPanel();
      case "show-prompt-history":
        return this.deps.showPromptHistorySearch();
      case "btw":
        return this.deps.runBtwCommand(act.question);
      case "interject":
        return this.deps.runInterjectCommand(act.text);
      case "insert-text": {
        const ta = document.activeElement as HTMLTextAreaElement | null;
        const targets = [
          this.deps.getComposerInput(),
          this.deps.getChatInput(),
          this.deps.getFocusInput(),
        ].filter((x): x is HTMLTextAreaElement => Boolean(x));
        const input =
          ta && targets.includes(ta)
            ? ta
            : this.deps.isChatVisible()
              ? targets[1] ?? targets[0]
              : targets[0];
        if (!input) return { ok: false, message: tr("slash.unknown") };
        const cur = input.selectionStart ?? input.value.length;
        const pad = cur > 0 && !/\s$/.test(input.value.slice(0, cur)) ? " " : "";
        const ins = pad + act.text;
        input.value = input.value.slice(0, cur) + ins + input.value.slice(cur);
        const pos = cur + ins.length;
        input.setSelectionRange(pos, pos);
        input.focus();
        return { ok: true };
      }
      default:
        return { ok: false, message: tr("slash.unknown") };
    }
  }
}
