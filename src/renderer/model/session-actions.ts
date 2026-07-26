/**
 * 会话模型 / effort 热切换与「新会话」路径（自 main 迁出）。
 * 对齐 CLI `/model` `/effort`：热切换或 MODEL_SWITCH_INCOMPATIBLE → 新会话。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { effortOptions, type EffortLevel } from "./effort.js";
import { shortModelName, type ModelRow } from "./display.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string; details?: unknown };
}>;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** agent 因 harness 不兼容拒绝热切换（对齐 CLI：需新会话） */
export function isModelSwitchNeedsNewSession(err?: {
  message?: string;
  details?: unknown;
}): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  if (/MODEL_SWITCH_INCOMPATIBLE_AGENT/i.test(msg)) return true;
  if (/start a new session/i.test(msg) && /model/i.test(msg)) return true;
  if (/requires agent/i.test(msg) && /active agent/i.test(msg)) return true;
  if (/Cannot switch to model/i.test(msg)) return true;

  const walk = (v: unknown, depth = 0): boolean => {
    if (!v || depth > 4) return false;
    if (typeof v === "string") {
      return (
        v === "MODEL_SWITCH_INCOMPATIBLE_AGENT" ||
        v === "start_new_session" ||
        /MODEL_SWITCH_INCOMPATIBLE/i.test(v)
      );
    }
    if (typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (
      o.code === "MODEL_SWITCH_INCOMPATIBLE_AGENT" ||
      o.suggestion === "start_new_session"
    ) {
      return true;
    }
    if (o.data != null && walk(o.data, depth + 1)) return true;
    if (o.details != null && walk(o.details, depth + 1)) return true;
    return false;
  };
  return walk(err.details);
}

export type ModelSessionActionsDeps = {
  inv: Inv;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  showToast: (text: string, kind?: "info" | "error") => void;
  promptText: (opts: {
    title: string;
    hint?: string;
    defaultValue?: string;
    placeholder?: string;
  }) => Promise<string | null>;
  confirmText: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  getModelLabel: () => string;
  setModelId: (id: string) => void;
  getEffortLevel: () => EffortLevel;
  setEffortLevel: (level: EffortLevel) => void;
  effortLabel: (level?: EffortLevel) => string;
  getTurnActive: () => boolean;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  getActiveCwd: () => string | null;
  ensureLiveThread: () => Promise<string | null>;
  setDefaultModelLabel: (id: string) => void;
  setDefaultEffortLevel: (level: EffortLevel) => void;
  setModelsCache: (list: ModelRow[] | null) => void;
  getModelsCache: () => ModelRow[] | null;
  getMaxTurnsLimit: () => number | null;
  getAccessMode: () => string;
  isPlanOn: () => boolean;
  getSelectedProject: () =>
    | { id: string; path: string; title?: string }
    | undefined;
  getSelectedProjectId: () => string | null;
  setSelectedProjectId: (id: string | null) => void;
  setProjectChoiceTouched: (v: boolean) => void;
  leaveCurrentSessionToWelcome: (opts?: {
    clearQueue?: boolean;
  }) => void | Promise<void>;
  setActiveCwd: (cwd: string | null) => void;
  clearPromptHistoryStore: () => void;
  setWelcomeTitle: () => void;
  showWelcome: (show: boolean) => void;
  clearTranscript: () => void;
  setActiveThreadId: (id: string | null) => void;
  setActiveSessionId: (id: string | null) => void;
  syncChatTopTitle: () => void;
  onSessionChanged: () => void;
  expandChatsGroup: () => void;
  setSuspendLiveTranscript: (v: boolean) => void;
  startContextPolling: () => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
  focusChatInput: () => void;
};

export class ModelSessionActions {
  constructor(private readonly deps: ModelSessionActionsDeps) {}

  /**
   * 对齐 CLI「Start a new session with &lt;model&gt;」：
   * 结束当前会话 UI，用目标模型新建空会话（不自动发消息）。
   */
  async startFreshSessionWithModel(
    modelId: string,
    effort: EffortLevel,
  ): Promise<{ ok: boolean; message?: string }> {
    const p = this.deps.getSelectedProject();
    const selectedProjectId = this.deps.getSelectedProjectId();
    const noProject = !p && !selectedProjectId;
    const cwd = this.deps.getActiveCwd() || p?.path;
    if (!cwd && !noProject) {
      return { ok: false, message: tr("model.needProject") };
    }
    const keepProjectId = selectedProjectId;
    const keepCwd = cwd;
    await this.deps.leaveCurrentSessionToWelcome({ clearQueue: false });
    if (keepProjectId) this.deps.setSelectedProjectId(keepProjectId);
    else {
      this.deps.setSelectedProjectId(null);
      this.deps.setProjectChoiceTouched(true);
    }
    if (keepCwd) this.deps.setActiveCwd(keepCwd);
    this.deps.clearPromptHistoryStore();

    this.deps.setModelId(modelId);
    this.deps.setEffortLevel(effort);
    this.deps.setWelcomeTitle();
    this.deps.showWelcome(false);
    this.deps.clearTranscript();

    const res = await this.deps.inv<{
      threadId: string;
      sessionId: string;
      cwd: string;
    }>("threads.create", {
      cwd: keepCwd,
      projectId: keepProjectId ?? p?.id,
      noProject: noProject || undefined,
      title: `新会话 · ${shortModelName(modelId, this.deps.getModelsCache())}`.slice(
        0,
        48,
      ),
      model: modelId,
      effort,
      maxTurns: this.deps.getMaxTurnsLimit() ?? undefined,
      alwaysApprove: this.deps.getAccessMode() === "always_approve",
      plan: this.deps.isPlanOn(),
      mode: this.deps.isPlanOn()
        ? "plan"
        : this.deps.getAccessMode() === "always_approve"
          ? "always_approve"
          : "normal",
    });

    if (!res.ok) {
      this.deps.showWelcome(true);
      return {
        ok: false,
        message: res.error?.message ?? tr("model.createFailed"),
      };
    }

    this.deps.setActiveThreadId(res.data!.threadId);
    this.deps.setActiveSessionId(res.data!.sessionId);
    this.deps.syncChatTopTitle();
    this.deps.setActiveCwd(res.data!.cwd);
    this.deps.onSessionChanged();
    if (p?.id) this.deps.setSelectedProjectId(p.id);
    else {
      this.deps.setSelectedProjectId(null);
      this.deps.setProjectChoiceTouched(true);
      this.deps.expandChatsGroup();
    }
    this.deps.setSuspendLiveTranscript(false);
    this.deps.clearTranscript();
    this.deps.showWelcome(false);
    this.deps.startContextPolling();
    await this.deps.refreshProjectsAndThreads();
    this.deps.focusChatInput();
    return {
      ok: true,
      message: `已用 ${modelId} 开启新会话（未复制历史，对齐 CLI）`,
    };
  }

  /**
   * 对齐 CLI `/model` `/effort`：
   * - 无会话：只改本地默认
   * - 有会话且 harness 兼容：session/set_model 热切换
   * - harness 不兼容（已有 turn）：弹窗询问是否新会话
   */
  async applySessionModelAndEffort(opts?: {
    modelId?: string;
    effort?: EffortLevel;
    focus?: "model" | "effort" | "both";
  }): Promise<{ ok: boolean; message?: string }> {
    const prevModel = this.deps.getModelLabel();
    const prevEffort = this.deps.getEffortLevel();
    const nextModel =
      (opts?.modelId ?? prevModel).trim() || prevModel;
    const nextEffort = opts?.effort ?? prevEffort;

    if (opts?.modelId) this.deps.setModelId(opts.modelId);
    if (opts?.effort) this.deps.setEffortLevel(opts.effort);

    const revert = () => {
      this.deps.setModelId(prevModel);
      this.deps.setEffortLevel(prevEffort);
    };

    const modelLabel = this.deps.getModelLabel();
    const effortLevel = this.deps.getEffortLevel();
    const hasLiveSession = Boolean(
      this.deps.getActiveSessionId() &&
        (this.deps.getActiveThreadId() || this.deps.getActiveCwd()),
    );
    if (!hasLiveSession) {
      if (opts?.modelId) {
        this.deps.setDefaultModelLabel(modelLabel);
        try {
          const persist = await this.deps.inv<{ defaultModel: string }>(
            "providers.setDefault",
            { modelId: modelLabel },
          );
          if (persist.ok) {
            this.deps.setModelsCache(null);
          }
        } catch {
          /* 内存默认仍生效 */
        }
      }
      if (opts?.effort) this.deps.setDefaultEffortLevel(effortLevel);
      const focus = opts?.focus ?? "both";
      if (focus === "effort") {
        return {
          ok: true,
          message: `默认推理 → ${this.deps.effortLabel()}（${effortLevel}）；将用于新会话`,
        };
      }
      if (focus === "model") {
        return {
          ok: true,
          message: tr("model.defaultPersisted", { model: modelLabel }),
        };
      }
      return {
        ok: true,
        message: tr("model.defaultPersisted", { model: modelLabel }),
      };
    }

    if (this.deps.getTurnActive()) {
      revert();
      return {
        ok: false,
        message: tr("model.waitTurn"),
      };
    }

    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      return {
        ok: true,
        message: tr("mode.attachFail"),
      };
    }

    const res = await this.deps.inv<{
      modelId: string;
      effort?: string;
      sessionId: string;
    }>("threads.setModel", {
      threadId,
      modelId: nextModel,
      effort: nextEffort,
    });

    if (res.ok) {
      const focus = opts?.focus ?? "both";
      if (focus === "effort") {
        return {
          ok: true,
          message: `本会话推理 → ${this.deps.effortLabel()}（${effortLevel}）`,
        };
      }
      if (focus === "model") {
        return {
          ok: true,
          message: `本会话模型 → ${modelLabel}`,
        };
      }
      return {
        ok: true,
        message: `本会话已切换：${modelLabel} · ${this.deps.effortLabel()}`,
      };
    }

    if (isModelSwitchNeedsNewSession(res.error)) {
      const displayName = shortModelName(
        nextModel,
        this.deps.getModelsCache(),
      );
      const ok = await this.deps.confirmText({
        title: tr("model.newSessionTitle"),
        message: `切换到 ${nextModel} 需要开启新会话（与 CLI 一致：当前会话的 agent 类型不兼容）。\n\n是：用 ${displayName} 新建会话（不复制历史）\n否：留在当前会话`,
        okLabel: tr("model.newSessionOk"),
        cancelLabel: tr("model.stayCurrent"),
      });
      if (!ok) {
        revert();
        return { ok: true, message: tr("model.keepCurrent") };
      }
      return this.startFreshSessionWithModel(nextModel, nextEffort);
    }

    revert();
    return {
      ok: false,
      message: res.error?.message ?? tr("model.switchFailed"),
    };
  }

  async promptSetModel(): Promise<{ ok: boolean; message?: string }> {
    const next = await this.deps.promptText({
      title: tr("model.customTitle"),
      hint: tr("model.customHint"),
      defaultValue: this.deps.getModelLabel(),
      placeholder: tr("model.customPh"),
    });
    if (next == null) return { ok: true };
    const v = next.trim();
    if (!v) return { ok: false, message: tr("model.empty") };
    return this.applySessionModelAndEffort({
      modelId: v,
      focus: "model",
    });
  }

  async promptSetEffort(): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const effortLevel = this.deps.getEffortLevel();
      this.deps.openModal(
        tr("slash.effort"),
        `<p class="prompt-dlg-hint">对齐 CLI <code>/effort</code>：low / medium / high / xhigh。已打开会话时立即热切换。</p>
       <div class="effort-pick-list" id="effort-pick-list">
         ${effortOptions()
           .map(
             (e) =>
               `<button type="button" class="menu-item effort-pick${e.id === effortLevel ? " is-checked" : ""}" data-effort="${e.id}">
               <span>${esc(e.label)} <span class="slash-item-desc">(${esc(e.id)})</span></span>
               <span class="menu-check">${e.id === effortLevel ? "✓" : ""}</span>
             </button>`,
           )
           .join("")}
       </div>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">取消</button>
       </div>`,
      );
      const cancel = document.getElementById("prompt-dlg-cancel");
      if (cancel) {
        cancel.onclick = () => {
          this.deps.closeModal();
          resolve({ ok: true });
        };
      }
      for (const btn of Array.from(
        document.querySelectorAll("#effort-pick-list [data-effort]"),
      )) {
        (btn as HTMLElement).onclick = () => {
          const id = (btn as HTMLElement).dataset.effort as EffortLevel;
          if (!id) return;
          this.deps.closeModal();
          void this.applySessionModelAndEffort({
            effort: id,
            focus: "effort",
          }).then(resolve);
        };
      }
    });
  }
}
