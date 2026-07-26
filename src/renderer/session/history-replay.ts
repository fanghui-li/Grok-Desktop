/**
 * openThread 历史回放：user / tool / thought / assistant 时间线绘制。
 * 不持有 session 真源；paint 副作用经 deps。
 */
import {
  parseUserHistoryPayload,
  type ComposerAttachment,
} from "../composer/attachments.js";

export type HistoryReplayEntry = {
  role: string;
  text: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
};

export type HistoryReplayDeps = {
  /** 将 rehydrate 为 busy：incomplete/running 历史 tool 保留 spinner 语义 */
  willBusyEarly: boolean;
  endStreamBubble: () => void;
  paintUserMessage: (
    text: string,
    attachments?: ComposerAttachment[],
    at?: Date | string | number | null,
  ) => void;
  replayHistoryTool: (e: {
    toolCallId?: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    text?: string;
    toolStatus?: string;
  }) => void;
  appendProcessText: (text: string) => void;
  appendLine: (text: string, role: string) => void;
};

/**
 * 按 history.load 条目顺序回放 transcript。
 * @returns 解析出的 user 正文列表（供 prompt history seed）
 */
export function paintHistoryEntries(
  entries: HistoryReplayEntry[] | undefined | null,
  deps: HistoryReplayDeps,
): string[] {
  const userTexts: string[] = [];
  for (const e of entries ?? []) {
    deps.endStreamBubble();
    const role = (e.role || "").toLowerCase();
    if (role === "user" || role === "human") {
      if (!e.text?.trim()) continue;
      const parsed = parseUserHistoryPayload(e.text);
      if (parsed.text || parsed.attachments.length) {
        deps.paintUserMessage(parsed.text, parsed.attachments, null);
        if (parsed.text.trim()) userTexts.push(parsed.text.trim());
      }
    } else if (role === "tool") {
      if (
        !deps.willBusyEarly &&
        (e.toolStatus === "incomplete" ||
          e.toolStatus === "running" ||
          !e.toolStatus)
      ) {
        deps.replayHistoryTool({ ...e, toolStatus: "failed" });
      } else {
        deps.replayHistoryTool(e);
      }
    } else if (
      role === "thought" ||
      role === "thinking" ||
      role === "reasoning"
    ) {
      if (e.text?.trim()) {
        deps.appendProcessText(e.text.trim());
      }
    } else if (role === "system") {
      if (e.text?.trim()) deps.appendLine(e.text, "system");
    } else if (role === "assistant" || role === "ai") {
      if (!e.text?.trim()) continue;
      deps.appendLine(e.text, "assistant");
    }
    deps.endStreamBubble();
  }
  return userTexts;
}

/** 切会话时是否保留上一会话侧栏 working / 后台 toast */
export function shouldKeepBackgroundWorking(opts: {
  sameSession: boolean;
  prevSessionId: string | null;
  wasActivelyTurning: boolean;
  isSidebarWorking: boolean;
  threadListedWorking: boolean;
}): boolean {
  return (
    !opts.sameSession &&
    !!opts.prevSessionId &&
    (opts.wasActivelyTurning ||
      opts.isSidebarWorking ||
      opts.threadListedWorking)
  );
}

/** openThread：目标是否与当前前台为同一会话 */
export function isSameOpenSession(opts: {
  activeSessionId: string | null;
  activeThreadId: string | null;
  targetSessionId: string;
  targetThreadId: string;
}): boolean {
  return (
    (!!opts.activeSessionId &&
      opts.targetSessionId === opts.activeSessionId) ||
    (!!opts.activeThreadId && opts.targetThreadId === opts.activeThreadId)
  );
}

/**
 * openThread 绑定 plan 投影时：pendingApproval 若跨 session 则丢弃。
 */
export function sanitizePendingApprovalForSession<
  T extends { sessionId?: string },
>(
  pending: T | null | undefined,
  sessionId: string,
): T | null {
  if (!pending) return null;
  if (pending.sessionId && pending.sessionId !== sessionId) return null;
  return pending;
}

/**
 * attachState 回写：disk_ 列表在 Host 已 live 时应升为 live threadId。
 */
export function resolveThreadIdAfterAttachState(opts: {
  activeThreadId: string | null;
  attachThreadId?: string;
  attachState?: string;
}): string | null {
  const s = String(opts.attachState || "").toLowerCase();
  if (
    opts.attachThreadId &&
    (s === "live" || s === "attaching") &&
    opts.activeThreadId?.startsWith("disk_")
  ) {
    return opts.attachThreadId;
  }
  return opts.activeThreadId;
}
