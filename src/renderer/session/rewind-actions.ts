/**
 * /rewind：列表选点 + 确认后完整回退（自 main 迁出）。
 * agent 语义：preview force=false；执行 force=true。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type RewindActionsDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getTurnActive: () => boolean;
  getActiveSessionId: () => string | null;
  ensureLiveThread: () => Promise<string | null>;
  confirmText: (opts: {
    title: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  promptText: (opts: {
    title: string;
    hint?: string;
    defaultValue?: string;
    placeholder?: string;
  }) => Promise<string | null>;
  endTurn: () => void;
  truncateTranscriptFromPrompt: (promptIndex: number) => void;
  fillComposerAfterRewind: (text: string) => void;
  appendLine: (text: string, kind: "system" | "assistant" | "user") => void;
  setComposerBusy: (busy: boolean) => void;
  markSessionWorking: (sessionId: string | null, working: boolean) => void;
  refreshContextUsage: () => unknown;
  refreshProjectsAndThreads: () => unknown;
};

export class RewindActions {
  constructor(private readonly deps: RewindActionsDeps) {}

  /**
   * 回退到指定 user prompt 之前（完整：对话+文件）。
   */
  async toUserPrompt(
    promptIndex: number,
    previewText: string,
  ): Promise<void> {
    if (this.deps.getTurnActive()) {
      this.deps.showToast(tr("chat.rewindWait"), "error");
      return;
    }
    if (!this.deps.getActiveSessionId()) {
      this.deps.showToast(tr("chat.rewindNeedSession"), "error");
      return;
    }

    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      this.deps.showToast(tr("chat.rewindAttachFail2"), "error");
      return;
    }

    const previewRes = await this.deps.inv<{
      success: boolean;
      targetPromptIndex: number;
      revertedFiles: string[];
      conflicts: Array<{ path?: string; conflictType?: string }>;
      cleanFiles?: string[];
      error?: string;
    }>("threads.rewindPreview", {
      threadId,
      targetPromptIndex: promptIndex,
    });

    const conflicts = previewRes.data?.conflicts ?? [];
    const conflictN = conflicts.length;
    const cleanN =
      (previewRes.data as { cleanFiles?: string[] } | undefined)?.cleanFiles
        ?.length ?? 0;
    const preview =
      previewText.length > 80
        ? `${previewText.slice(0, 80)}…`
        : previewText;

    let conflictNote = "";
    if (conflictN > 0) {
      const sample = conflicts
        .slice(0, 5)
        .map((c) => c.path || "?")
        .join("\n");
      conflictNote =
        `\n\n⚠ 检测到 ${conflictN} 个文件可能被外部修改，确认后将强制覆盖：\n${sample}` +
        (conflictN > 5 ? "\n…" : "");
    } else if (cleanN > 0) {
      conflictNote = `\n\n将还原约 ${cleanN} 个文件快照。`;
    }

    if (!previewRes.ok && !previewRes.data) {
      this.deps.showToast(
        previewRes.error?.message ?? tr("chat.rewindPreviewFail"),
        "error",
      );
      return;
    }
    const previewErr = previewRes.data?.error || previewRes.error?.message;
    if (
      previewErr &&
      /Cannot rewind|current prompt index|Valid targets/i.test(previewErr)
    ) {
      this.deps.showToast(previewErr, "error");
      return;
    }

    const ok = await this.deps.confirmText({
      title: tr("chat.rewindConfirmTitle"),
      message:
        `将恢复到该用户消息执行前的状态（对齐 CLI /rewind · 完整回退）：\n\n` +
        `· 删除此消息及之后的全部对话\n` +
        `· 将相关文件恢复为当时快照（未进 git 的改动可能丢失）\n\n` +
        `目标消息：${preview || tr("chat.rewindConfirmBodyEmpty")}` +
        conflictNote,
      okLabel: tr("chat.rewindOk"),
      cancelLabel: tr("common.cancel"),
    });
    if (!ok) return;

    this.deps.showToast(tr("chat.rewinding"));
    const res = await this.deps.inv<{
      success: boolean;
      targetPromptIndex: number;
      revertedFiles: string[];
      promptText?: string;
    }>("threads.rewind", {
      threadId,
      targetPromptIndex: promptIndex,
      force: true,
    });

    if (!res.ok || res.data?.success === false) {
      this.deps.endTurn();
      this.deps.showToast(
        res.error?.message ?? tr("chat.rewindFailed"),
        "error",
      );
      return;
    }

    this.deps.endTurn();
    this.deps.truncateTranscriptFromPrompt(promptIndex);
    if (res.data?.promptText) {
      this.deps.fillComposerAfterRewind(res.data.promptText);
    }
    const n = res.data?.revertedFiles?.length ?? 0;
    this.deps.appendLine(
      n > 0
        ? `已回退到消息 #${promptIndex} 之前（对话+文件，还原 ${n} 个文件）`
        : `已回退到消息 #${promptIndex} 之前（对话+文件）`,
      "system",
    );
    this.deps.showToast(
      n > 0 ? tr("chat.rewoundFiles", { n }) : tr("chat.rewound"),
    );
    this.deps.setComposerBusy(false);
    if (this.deps.getActiveSessionId()) {
      this.deps.markSessionWorking(this.deps.getActiveSessionId(), false);
    }
    void this.deps.refreshContextUsage();
    void this.deps.refreshProjectsAndThreads();
  }

  /** /rewind：列出可回退点并确认后执行 */
  async viaSlash(): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.getTurnActive()) {
      return { ok: false, message: tr("chat.rewindWait") };
    }
    if (!this.deps.getActiveSessionId()) {
      return { ok: false, message: tr("chat.rewindNeedSession") };
    }
    const threadId = await this.deps.ensureLiveThread();
    if (!threadId) {
      return { ok: false, message: tr("chat.rewindAttachFail2") };
    }
    const pts = await this.deps.inv<{
      rewindPoints: Array<{
        promptIndex: number;
        promptPreview?: string;
        hasFileChanges?: boolean;
        numFileSnapshots?: number;
      }>;
    }>("threads.rewindPoints", { threadId });
    if (!pts.ok) {
      return {
        ok: false,
        message: pts.error?.message ?? tr("chat.rewindPreviewFail"),
      };
    }
    const list = pts.data?.rewindPoints ?? [];
    if (!list.length) {
      const blocks = Array.from(
        document.querySelectorAll(".user-msg-block[data-prompt-index]"),
      ) as HTMLElement[];
      if (!blocks.length) {
        return { ok: false, message: tr("slash.rewindNone") };
      }
      const last = blocks[blocks.length - 1]!;
      const idx = Number(last.dataset.promptIndex);
      const preview =
        last.querySelector(".msg-user-text")?.textContent?.trim() ||
        tr("chat.rewindConfirmBodyEmpty");
      await this.toUserPrompt(idx, preview);
      return { ok: true, message: tr("slash.rewindStarted") };
    }
    const recent = list.slice(-12).reverse();
    const pick = await this.deps.promptText({
      title: tr("slash.rewindPickTitle"),
      hint: tr("slash.rewindPickHint"),
      defaultValue: "1",
      placeholder: "1",
    });
    if (pick == null) return { ok: true, message: tr("slash.cancelled") };
    const n = Number(String(pick).trim());
    if (!Number.isFinite(n) || n < 1 || n > recent.length) {
      return { ok: false, message: tr("slash.rewindBadPick") };
    }
    const chosen = recent[n - 1]!;
    const preview =
      (chosen.promptPreview || "").trim() ||
      tr("chat.rewindConfirmBodyEmpty");
    await this.toUserPrompt(chosen.promptIndex, preview);
    return { ok: true, message: tr("slash.rewindStarted") };
  }
}
