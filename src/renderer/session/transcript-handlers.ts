/**
 * 前台 transcript / turn 事件处理（自 main onEvent switch 迁出）。
 * beginTurn / endTurn / 流式闸门真源仍经 deps；本模块不持有 turn 状态。
 */
import { tr } from "../../shared/i18n/index.js";
import {
  shouldIgnoreCancelledTurnCompleted,
  shouldIgnoreLateTurnStarted,
  type TurnUiPhase,
} from "../../shared/turn-ui-state.js";
import { shouldSkipHistoryResync } from "../../shared/history-resync-policy.js";
import { extractToolMeta } from "../agent-blocks.js";
import { extractToolFailHint } from "../lib/tool-fail-hint.js";
import { formatTokenK } from "../lib/format-utils.js";

/** 前台 switch 关心的事件字段（比 NormalizedEvent 宽松，兼容 wire 扩展） */
export type FgTranscriptEvent = {
  type?: string;
  role?: string;
  text?: string;
  name?: string;
  toolCallId?: string;
  raw?: unknown;
  status?: string;
  kind?: string;
  message?: string;
  requestId?: string;
  summary?: string;
  stopReason?: string;
  error?: string;
  hadAssistantText?: boolean;
  hadToolActivity?: boolean;
  hadToolFailures?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  percentage?: number;
};

export type TranscriptHandlersDeps = {
  showWelcome: (show: boolean) => void;
  appendLine: (
    text: string,
    role: "assistant" | "user" | "system" | "error",
    opts?: { fromStream?: boolean },
  ) => void;
  appendThoughtDelta: (text: string) => void;
  appendProcessText: (text: string) => void;
  beginTurn: () => void;
  endTurn: (opts?: {
    outcome?: "worked" | "stopped";
    skipQueueDrain?: boolean;
  }) => void;
  armTurnForLiveStream: () => void;
  setTurnStatus: (label: string) => void;
  endStreamBubble: () => void;
  markToolStarted: (
    name: string,
    toolCallId?: string,
    raw?: unknown,
  ) => void;
  markToolCompleted: (
    toolCallId?: string,
    name?: string,
    raw?: unknown,
  ) => void;
  markToolIncomplete: (
    toolCallId?: string,
    name?: string,
    failed?: boolean,
  ) => void;
  maybeGoalFromToolRaw: (name?: string, raw?: unknown) => void;
  notePlanArtifactFromTool: (name: string | undefined, raw: unknown) => void;
  scheduleRefreshFileTree: (delayMs?: number) => void;
  showAskUserDialog: (ev: {
    requestId: string;
    mode?: string;
    questions?: Array<{
      question: string;
      multiSelect?: boolean;
      options: Array<{ label: string; description?: string }>;
    }>;
  }) => void | Promise<void>;
  showPermission: (requestId: string, summary: string) => void;
  showTurnErrorOnce: (message: string) => void;
  showAgentCrashBanner: (message?: string) => void;
  refreshContextAfterCompact: (ev: {
    tokensBefore?: number;
    tokensAfter?: number;
  }) => void;
  syncGoalFromAgent: () => unknown;
  refreshContextUsage: () => unknown;
  maybeSurfacePlanAfterTurn: () => unknown;
  afterTurnSettled: () => unknown;
  markSessionWorking: (sessionId: string, working: boolean) => void;
  setComposerBusy: (busy: boolean) => void;
  /** 将 live thread 降为 disk_（agent.error 后） */
  demoteLiveThreadToDisk: () => void;
  getTurnActive: () => boolean;
  isUserStopSuppressed: () => boolean;
  getTurnUiPhase: () => TurnUiPhase;
  getAlreadyPaintedStopped: () => boolean;
  getAssistantStartedThisTurn: () => boolean;
  getBlockHistoryResyncAfterStop: () => boolean;
  getActiveSessionId: () => string | null;
};

export class TranscriptEventHandlers {
  constructor(private readonly deps: TranscriptHandlersDeps) {}

  /** 处理前台 transcript 范围事件；未知 type 返回 false */
  handle(ev: FgTranscriptEvent): boolean {
    switch (ev.type) {
      case "message.delta":
        this.onMessageDelta(ev);
        return true;
      case "thought.delta":
        this.onThoughtDelta(ev);
        return true;
      case "tool.started":
        this.onToolStarted(ev);
        return true;
      case "tool.completed":
        this.onToolCompleted(ev);
        return true;
      case "turn.started":
        this.onTurnStarted();
        return true;
      case "turn.completed":
        this.onTurnCompleted(ev);
        return true;
      case "ask_user.requested":
        this.onAskUser(ev);
        return true;
      case "context.compacted":
        this.onContextCompacted(ev);
        return true;
      case "permission.requested":
        this.onPermission(ev);
        return true;
      case "agent.error":
        this.onAgentError(ev);
        return true;
      default:
        return false;
    }
  }

  private onMessageDelta(ev: FgTranscriptEvent): void {
    this.deps.showWelcome(false);
    if (ev.role === "user") return;
    this.deps.appendLine(ev.text ?? "", "assistant", { fromStream: true });
  }

  private onThoughtDelta(ev: FgTranscriptEvent): void {
    this.deps.showWelcome(false);
    if (!this.deps.getTurnActive()) {
      if (this.deps.isUserStopSuppressed()) return;
      this.deps.beginTurn();
    }
    if ((ev.text ?? "").trim()) this.deps.appendThoughtDelta(ev.text ?? "");
  }

  private onToolStarted(ev: FgTranscriptEvent): void {
    this.deps.showWelcome(false);
    if (!this.deps.getTurnActive()) {
      if (this.deps.isUserStopSuppressed()) return;
      this.deps.beginTurn();
    }
    this.deps.markToolStarted(ev.name || "tool", ev.toolCallId, ev.raw);
  }

  private onToolCompleted(ev: FgTranscriptEvent): void {
    const failed = ev.status === "failed";
    if (failed) {
      this.deps.markToolIncomplete(ev.toolCallId, ev.name, true);
      const failHint = extractToolFailHint(ev.raw, ev.name);
      if (failHint) {
        this.deps.appendProcessText(failHint);
      }
    } else {
      this.deps.markToolCompleted(ev.toolCallId, ev.name, ev.raw);
    }
    this.deps.maybeGoalFromToolRaw(ev.name, ev.raw);
    const kind = extractToolMeta(ev.raw, ev.name).kind;
    if (kind === "write" || kind === "shell") {
      this.deps.scheduleRefreshFileTree();
    }
    this.deps.notePlanArtifactFromTool(ev.name, ev.raw);
  }

  private onTurnStarted(): void {
    this.deps.showWelcome(false);
    if (!this.deps.getTurnActive()) {
      if (
        shouldIgnoreLateTurnStarted({
          turnActive: false,
          userStopSuppressed: this.deps.isUserStopSuppressed(),
          phase: this.deps.getTurnUiPhase(),
        })
      ) {
        return;
      }
      this.deps.beginTurn();
    } else {
      this.deps.armTurnForLiveStream();
      this.deps.setTurnStatus(tr("turn.thinking"));
    }
  }

  private onTurnCompleted(ev: FgTranscriptEvent): void {
    const stop = String(ev.stopReason || "");
    const errMsg = ev.error ? String(ev.error) : "";
    const hadText = Boolean(ev.hadAssistantText);
    const hadTools = Boolean(ev.hadToolActivity);
    const hadToolFailures = Boolean(ev.hadToolFailures);
    const isCancelled =
      stop === "cancelled" ||
      stop === "canceled" ||
      stop === "user_cancelled" ||
      /cancel/i.test(stop);

    if (
      shouldIgnoreCancelledTurnCompleted({
        turnActive: this.deps.getTurnActive(),
        alreadyPaintedStopped: this.deps.getAlreadyPaintedStopped(),
        userStopSuppressed: this.deps.isUserStopSuppressed(),
        isCancelled,
      })
    ) {
      const sid = this.deps.getActiveSessionId();
      if (sid) this.deps.markSessionWorking(sid, false);
      this.deps.setComposerBusy(false);
      void this.deps.syncGoalFromAgent();
      void this.deps.refreshContextUsage();
      return;
    }

    this.deps.endTurn({ outcome: isCancelled ? "stopped" : "worked" });

    if (isCancelled) {
      /* already painted stopped */
    } else if (stop === "timeout" || /timed out/i.test(errMsg)) {
      this.deps.showTurnErrorOnce(errMsg || "timeout");
    } else if (errMsg && stop === "error") {
      this.deps.showTurnErrorOnce(errMsg);
    } else if (hadToolFailures) {
      this.deps.appendLine(tr("chat.turnToolFailed"), "system");
      if (!hadText) {
        this.deps.appendLine(tr("chat.turnToolsOnly"), "system");
      }
    } else if (!hadText && !hadTools) {
      if (
        !this.deps.getBlockHistoryResyncAfterStop() &&
        !this.deps.isUserStopSuppressed()
      ) {
        this.deps.appendLine(
          tr("chat.turnEmpty") ||
            "Turn finished with no assistant reply. Check agent logs or retry.",
          "system",
        );
      }
    } else if (!hadText && hadTools) {
      if (
        !this.deps.getBlockHistoryResyncAfterStop() &&
        !this.deps.isUserStopSuppressed()
      ) {
        this.deps.appendLine(
          tr("chat.turnToolsOnly") ||
            "Turn finished after tools ran, but no final reply text was streamed.",
          "system",
        );
      }
    }

    void this.deps.syncGoalFromAgent();
    void this.deps.refreshContextUsage();
    this.deps.scheduleRefreshFileTree(400);

    if (
      shouldSkipHistoryResync({
        assistantStartedThisTurn: this.deps.getAssistantStartedThisTurn(),
        userStopSuppressed: this.deps.isUserStopSuppressed(),
        blockAfterStop: this.deps.getBlockHistoryResyncAfterStop(),
      })
    ) {
      void this.deps.maybeSurfacePlanAfterTurn();
    } else {
      void this.deps.afterTurnSettled();
    }
  }

  private onAskUser(ev: FgTranscriptEvent): void {
    this.deps.showWelcome(false);
    if (!this.deps.getTurnActive()) {
      if (this.deps.isUserStopSuppressed()) return;
      this.deps.beginTurn();
    }
    this.deps.setTurnStatus(tr("askUser.waiting") || "等待你的选择…");
    const requestId = String(ev.requestId || "").trim();
    if (!requestId) return;
    void this.deps.showAskUserDialog({
      requestId,
      mode: typeof (ev as { mode?: string }).mode === "string"
        ? (ev as { mode?: string }).mode
        : undefined,
      questions: (ev as {
        questions?: Array<{
          question: string;
          multiSelect?: boolean;
          options: Array<{ label: string; description?: string }>;
        }>;
      }).questions,
    });
  }

  private onContextCompacted(ev: FgTranscriptEvent): void {
    if (ev.status === "completed" && ev.kind === "auto") {
      const detail =
        ev.tokensBefore != null && ev.tokensAfter != null
          ? `（${formatTokenK(ev.tokensBefore)} → ${formatTokenK(ev.tokensAfter)}）`
          : "";
      this.deps.appendLine(tr("chat.autoCompacted", { detail }), "system");
      this.deps.refreshContextAfterCompact(ev);
    } else if (ev.status === "completed") {
      this.deps.refreshContextAfterCompact(ev);
    } else if (ev.status === "failed") {
      this.deps.appendLine(
        tr("chat.autoCompactFail", {
          detail: ev.message ? `：${ev.message}` : "",
        }),
        "error",
      );
    } else if (ev.status === "started" && ev.kind === "auto") {
      this.deps.setTurnStatus(
        ev.percentage != null
          ? tr("chat.autoCompactStartPct", { pct: ev.percentage })
          : tr("chat.autoCompactStart"),
      );
    }
  }

  private onPermission(ev: FgTranscriptEvent): void {
    this.deps.endStreamBubble();
    this.deps.setTurnStatus("等待批准…");
    this.deps.showPermission(ev.requestId ?? "", ev.summary ?? "");
  }

  private onAgentError(ev: FgTranscriptEvent): void {
    this.deps.endTurn();
    this.deps.showTurnErrorOnce(ev.message ?? "");
    this.deps.demoteLiveThreadToDisk();
    this.deps.showAgentCrashBanner(ev.message);
  }
}
