/** Normalized Host events (architecture §5.4). */

export type ThreadStatus =
  | "needs_input"
  | "working"
  | "idle"
  | "inactive"
  | "completed"
  | "failed"
  | "blocked";

export type NormalizedEvent =
  | { type: "turn.started"; threadId: string; sessionId: string }
  | {
      type: "turn.completed";
      threadId: string;
      sessionId: string;
      stopReason?: string;
    }
  | {
      type: "message.delta";
      threadId: string;
      sessionId: string;
      role: "assistant" | "user" | "system";
      text: string;
    }
  | {
      type: "thought.delta";
      threadId: string;
      sessionId: string;
      text: string;
    }
  | {
      type: "tool.started";
      threadId: string;
      sessionId: string;
      toolCallId?: string;
      name: string;
      raw?: unknown;
    }
  | {
      type: "tool.completed";
      threadId: string;
      sessionId: string;
      toolCallId?: string;
      name?: string;
      raw?: unknown;
    }
  | {
      type: "permission.requested";
      threadId: string;
      sessionId: string;
      requestId: string;
      summary: string;
      raw?: unknown;
    }
  | {
      type: "session.status";
      threadId: string;
      sessionId: string;
      status: ThreadStatus;
      /** nav:command | handoff:grok://session/... */
      activity?: string;
    }
  | {
      type: "agent.error";
      threadId?: string;
      sessionId?: string;
      message: string;
      code?: string;
    }
  /** 与 grok agent 运行时 goal 同源（sessionUpdate: goal_updated） */
  | {
      type: "goal.updated";
      threadId: string;
      sessionId: string;
      goalId?: string;
      objective: string;
      /** agent: active | user_paused | complete | … */
      status: string;
      phase?: string;
      elapsedMs?: number;
      lastEvent?: string;
      message?: string;
      raw?: unknown;
    }
  /** agent auto-compact / 手动 compact 完成（x.ai/session_notification） */
  | {
      type: "context.compacted";
      threadId: string;
      sessionId: string;
      /** auto | manual | unknown */
      kind: "auto" | "manual" | "unknown";
      status: "started" | "completed" | "failed" | "cancelled";
      tokensBefore?: number;
      tokensAfter?: number;
      percentage?: number;
      message?: string;
      raw?: unknown;
    }
  /** 项目目录变更（侧栏文件树 fs.watch 防抖后推送） */
  | {
      type: "files.changed";
      cwd: string;
    }
  /** agent 请求计划审批（x.ai/exit_plan_mode） */
  | {
      type: "plan.approval.requested";
      threadId: string;
      sessionId: string;
      requestId: string;
      toolCallId?: string;
      planContent?: string | null;
      raw?: unknown;
    }
  /** 会话模式变更（plan / default 等） */
  | {
      type: "plan.mode.changed";
      threadId: string;
      sessionId: string;
      modeId: string;
      active: boolean;
    }
  /** 父会话上的 subagent 生命周期（x.ai/session_notification） */
  | {
      type: "subagent.updated";
      threadId: string;
      sessionId: string;
      /** parent session（通常与 sessionId 相同） */
      parentSessionId: string;
      subagentId: string;
      childSessionId?: string;
      subagentType?: string;
      description?: string;
      /** spawned | progress | finished */
      phase: "spawned" | "progress" | "finished";
      status: string;
      durationMs?: number;
      turnCount?: number;
      toolCallCount?: number;
      tokensUsed?: number;
      error?: string;
      output?: string;
      raw?: unknown;
    }
  /** 后台任务 / monitor（x.ai/task_backgrounded|task_completed|monitor_event） */
  | {
      type: "task.updated";
      threadId: string;
      sessionId: string;
      taskId: string;
      /** backgrounded | completed | monitor */
      phase: "backgrounded" | "completed" | "monitor";
      command?: string;
      description?: string;
      cwd?: string;
      outputFile?: string;
      toolCallId?: string;
      /** monitor 类后台任务 */
      isMonitor?: boolean;
      exitCode?: number | null;
      signal?: string;
      success?: boolean;
      /** 完成后 agent 是否会 auto-wake 再开一轮 */
      willWake?: boolean;
      durationMs?: number;
      output?: string;
      /** monitor_event 增量文本 */
      eventText?: string;
      /** session_restart 等冷加载合成完成，勿当新失败 */
      staleOnLoad?: boolean;
      raw?: unknown;
    }
  /** agent 广告 slash / skills（sessionUpdate: available_commands_update） */
  | {
      type: "session.available_commands";
      threadId: string;
      sessionId: string;
      commands: AvailableCommandInfo[];
      /** meta.tools 工具名集合（可选） */
      tools?: string[];
      raw?: unknown;
    }
  | {
      type: "shell.handoff";
      /** deep link / focus payload */
      payload: string;
      at?: string;
    }
  | {
      type: "shell.navigate";
      view: "command" | "inbox";
      at?: string;
    }
  | {
      type: "shell.notice";
      code: string;
      message?: string;
      at?: string;
    };

/** ACP AvailableCommand 精简形态 */
export interface AvailableCommandInfo {
  name: string;
  description?: string;
  input?: { hint?: string };
}


/** Shell-only control events on HOST_EVENT_CHANNEL (preferred over session.status activity). */
export const SHELL_EVENT = {
  handoff: "shell.handoff",
  navigate: "shell.navigate",
  notice: "shell.notice",
} as const;

export type ShellNavigateView = "command" | "inbox";

export function shellHandoffEvent(payload: string): Extract<NormalizedEvent, { type: "shell.handoff" }> {
  return {
    type: SHELL_EVENT.handoff,
    payload: String(payload ?? ""),
    at: new Date().toISOString(),
  };
}

export function shellNavigateEvent(
  view: ShellNavigateView,
): Extract<NormalizedEvent, { type: "shell.navigate" }> {
  return {
    type: SHELL_EVENT.navigate,
    view,
    at: new Date().toISOString(),
  };
}

export function shellNoticeEvent(
  code: string,
  message?: string,
): Extract<NormalizedEvent, { type: "shell.notice" }> {
  return {
    type: SHELL_EVENT.notice,
    code,
    message: message || undefined,
    at: new Date().toISOString(),
  };
}

/**
 * Map legacy session.status activity fields used as a control bus.
 * Returns a shell event object or null.
 */
export function shellEventFromLegacyActivity(
  activity?: string | null,
):
  | Extract<NormalizedEvent, { type: "shell.handoff" }>
  | Extract<NormalizedEvent, { type: "shell.navigate" }>
  | Extract<NormalizedEvent, { type: "shell.notice" }>
  | null {
  if (!activity) return null;
  if (activity === "nav:inbox") return shellNavigateEvent("inbox");
  if (activity === "nav:command") return shellNavigateEvent("command");
  if (activity === "system:agent_missing") return shellNoticeEvent("agent_missing");
  if (activity.startsWith("handoff:")) {
    return shellHandoffEvent(activity.slice("handoff:".length));
  }
  return null;
}
