import type { NormalizedEvent } from "../shared/events.js";

/** toolCallId → 最近一次 update_goal 的 rawInput（终态 update 常不带 rawInput） */
const goalToolInputByCallId = new Map<string, Record<string, unknown>>();

/**
 * Map ACP session/update payloads to normalized Host events.
 */
export function normalizeSessionUpdate(
  threadId: string,
  sessionId: string,
  update: Record<string, unknown>,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const kind =
    (update.sessionUpdate as string | undefined) ??
    (update.type as string | undefined) ??
    "";

  switch (kind) {
    case "agent_message_chunk": {
      const content = update.content as { text?: string } | string | undefined;
      const text =
        typeof content === "string"
          ? content
          : (content?.text ?? (update.text as string | undefined) ?? "");
      if (text) {
        events.push({
          type: "message.delta",
          threadId,
          sessionId,
          role: "assistant",
          text,
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      const content = update.content as { text?: string } | string | undefined;
      const text =
        typeof content === "string"
          ? content
          : (content?.text ?? (update.text as string | undefined) ?? "");
      if (text) {
        events.push({
          type: "thought.delta",
          threadId,
          sessionId,
          text,
        });
      }
      break;
    }
    case "tool_call": {
      const toolCallId =
        (update.toolCallId as string) ?? (update.id as string) ?? "";
      const name =
        (update.tool as string) ??
        (update.title as string) ??
        (update.name as string) ??
        "tool";
      cacheGoalToolInput(toolCallId, update);
      events.push({
        type: "tool.started",
        threadId,
        sessionId,
        toolCallId,
        name,
        raw: update,
      });
      // 工具发起时也可能带 completed:true（尚未终态）
      break;
    }
    case "tool_call_update": {
      const toolCallId =
        (update.toolCallId as string) ?? (update.id as string) ?? "";
      cacheGoalToolInput(toolCallId, update);
      const status = (update.status as string | undefined)?.toLowerCase();
      if (status === "completed" || status === "failed") {
        events.push({
          type: "tool.completed",
          threadId,
          sessionId,
          toolCallId,
          name:
            (update.tool as string) ??
            (update.name as string) ??
            (update.title as string),
          status: status === "failed" ? "failed" : "completed",
          raw: update,
        });
        // G1：update_goal tool 不再合成 goal.updated（真源仅 goal_updated wire）
        if (toolCallId) goalToolInputByCallId.delete(toolCallId);
      } else {
        events.push({
          type: "tool.started",
          threadId,
          sessionId,
          toolCallId,
          name:
            (update.tool as string) ??
            (update.name as string) ??
            (update.title as string) ??
            "tool",
          raw: update,
        });
      }
      break;
    }
    case "user_message_chunk": {
      break;
    }
    case "available_commands_update":
    case "AvailableCommandsUpdate": {
      const cmds = parseAvailableCommands(update);
      const tools = parseAvailableToolsMeta(update);
      events.push({
        type: "session.available_commands",
        threadId,
        sessionId,
        commands: cmds,
        tools: tools.length ? tools : undefined,
        raw: update,
      });
      break;
    }
    case "queue_changed":
    case "QueueChanged": {
      const items = update.items ?? update.queue;
      const itemCount =
        typeof update.itemCount === "number"
          ? update.itemCount
          : typeof update.item_count === "number"
            ? (update.item_count as number)
            : Array.isArray(items)
              ? items.length
              : 0;
      events.push({
        type: "queue.changed",
        threadId,
        sessionId,
        source: "agent",
        itemCount,
        pausedByInterrupt: Boolean(
          update.pausedByInterrupt ?? update.paused_by_interrupt,
        ),
        syncError:
          typeof update.syncError === "string"
            ? update.syncError
            : typeof update.sync_error === "string"
              ? (update.sync_error as string)
              : null,
        raw: update,
      });
      break;
    }
    case "goal_updated": {
      events.push(buildGoalUpdatedEvent(threadId, sessionId, update));
      break;
    }
    default: {
      // 兜底：显式 goal_updated 形态或带 sessionUpdate 的扩展
      if (
        update.sessionUpdate === "goal_updated" ||
        ((update.goal_id || update.goalId) &&
          (update.status || update.objective) &&
          // 避免 tool 碎片误抬：要求像 GoalUpdated 的 objective/status 组合
          (typeof update.objective === "string" ||
            typeof update.status === "string"))
      ) {
        events.push(buildGoalUpdatedEvent(threadId, sessionId, update));
      }
      break;
    }
  }

  return events;
}

/**
 * x.ai/session_notification 的 update（auto-compact / model_changed 等）
 */
export function normalizeSessionNotification(
  threadId: string,
  sessionId: string,
  update: Record<string, unknown>,
): NormalizedEvent[] {
  const kind = String(
    update.sessionUpdate ?? update.session_update ?? update.type ?? "",
  );
  // 兼容 snake_case 与 PascalCase
  const k = kind.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return undefined;
  };

  switch (k) {
    case "queue_changed": {
      const items = update.items ?? update.queue;
      const itemCount =
        typeof update.itemCount === "number"
          ? update.itemCount
          : typeof update.item_count === "number"
            ? (update.item_count as number)
            : Array.isArray(items)
              ? items.length
              : 0;
      return [
        {
          type: "queue.changed",
          threadId,
          sessionId,
          source: "agent",
          itemCount,
          pausedByInterrupt: Boolean(
            update.pausedByInterrupt ?? update.paused_by_interrupt,
          ),
          syncError:
            typeof update.syncError === "string"
              ? update.syncError
              : typeof update.sync_error === "string"
                ? (update.sync_error as string)
                : null,
          raw: update,
        },
      ];
    }
    case "auto_compact_started":
      return [
        {
          type: "context.compacted",
          threadId,
          sessionId,
          kind: "auto",
          status: "started",
          tokensBefore: num(update.tokens_used ?? update.tokensUsed),
          percentage: num(update.percentage) as number | undefined,
          message: String(update.reason ?? ""),
          raw: update,
        },
      ];
    case "auto_compact_completed":
      return [
        {
          type: "context.compacted",
          threadId,
          sessionId,
          kind: "auto",
          status: "completed",
          tokensBefore: num(update.tokens_before ?? update.tokensBefore),
          tokensAfter: num(update.tokens_after ?? update.tokensAfter),
          message:
            typeof update.summary_preview === "string"
              ? update.summary_preview
              : typeof update.summaryPreview === "string"
                ? update.summaryPreview
                : undefined,
          raw: update,
        },
      ];
    case "auto_compact_failed":
      return [
        {
          type: "context.compacted",
          threadId,
          sessionId,
          kind: "auto",
          status: "failed",
          message: String(update.error ?? "compact failed"),
          raw: update,
        },
      ];
    case "auto_compact_cancelled":
      return [
        {
          type: "context.compacted",
          threadId,
          sessionId,
          kind: "auto",
          status: "cancelled",
          message: String(update.reason ?? "cancelled"),
          raw: update,
        },
      ];
    case "subagent_spawned": {
      const subagentId = String(
        update.subagent_id ?? update.subagentId ?? "",
      );
      if (!subagentId) return [];
      const parentSessionId = String(
        update.parent_session_id ?? update.parentSessionId ?? sessionId,
      );
      const childSessionId = String(
        update.child_session_id ?? update.childSessionId ?? subagentId,
      );
      const description = String(update.description ?? "");
      return [
        {
          type: "subagent.updated",
          threadId,
          sessionId,
          parentSessionId,
          subagentId,
          childSessionId,
          subagentType: String(
            update.subagent_type ?? update.subagentType ?? "general-purpose",
          ),
          description: description || undefined,
          phase: "spawned",
          status: "working",
          raw: update,
        },
      ];
    }
    case "subagent_progress": {
      const subagentId = String(
        update.subagent_id ?? update.subagentId ?? "",
      );
      if (!subagentId) return [];
      const parentSessionId = String(
        update.parent_session_id ?? update.parentSessionId ?? sessionId,
      );
      const childSessionId = String(
        update.child_session_id ?? update.childSessionId ?? subagentId,
      );
      const turns = num(update.turn_count ?? update.turnCount);
      const tools = num(update.tool_call_count ?? update.toolCallCount);
      const durationMs = num(update.duration_ms ?? update.durationMs);
      const tokensUsed = num(update.tokens_used ?? update.tokensUsed);
      const parts: string[] = [];
      if (turns != null) parts.push(`${turns} turns`);
      if (tools != null) parts.push(`${tools} tools`);
      if (durationMs != null) parts.push(`${Math.round(durationMs / 1000)}s`);
      return [
        {
          type: "subagent.updated",
          threadId,
          sessionId,
          parentSessionId,
          subagentId,
          childSessionId,
          phase: "progress",
          status: "working",
          durationMs,
          turnCount: turns,
          toolCallCount: tools,
          tokensUsed,
          description: parts.length ? parts.join(" · ") : undefined,
          raw: update,
        },
      ];
    }
    case "subagent_finished": {
      const subagentId = String(
        update.subagent_id ?? update.subagentId ?? "",
      );
      if (!subagentId) return [];
      const parentSessionId = String(
        update.parent_session_id ?? update.parentSessionId ?? sessionId,
      );
      const childSessionId = String(
        update.child_session_id ?? update.childSessionId ?? subagentId,
      );
      const status = String(update.status ?? "completed");
      const error =
        typeof update.error === "string" ? update.error : undefined;
      const output =
        typeof update.output === "string" ? update.output : undefined;
      return [
        {
          type: "subagent.updated",
          threadId,
          sessionId,
          parentSessionId,
          subagentId,
          childSessionId,
          phase: "finished",
          status,
          durationMs: num(update.duration_ms ?? update.durationMs),
          turnCount: num(update.turns ?? update.turn_count ?? update.turnCount),
          toolCallCount: num(
            update.tool_calls ?? update.toolCallCount ?? update.tool_call_count,
          ),
          tokensUsed: num(update.tokens_used ?? update.tokensUsed),
          error,
          output,
          description:
            error ||
            (output ? output.slice(0, 200) : undefined) ||
            status,
          raw: update,
        },
      ];
    }

    case "task_backgrounded": {
      const taskId = String(update.task_id ?? update.taskId ?? "");
      if (!taskId) return [];
      const command = String(update.command ?? "");
      const monDesc =
        typeof update.monitor_description === "string"
          ? update.monitor_description
          : typeof update.monitorDescription === "string"
            ? update.monitorDescription
            : undefined;
      const description =
        (typeof update.description === "string" && update.description.trim()
          ? update.description
          : undefined) ||
        monDesc ||
        (command.startsWith("[monitor] ")
          ? command.slice("[monitor] ".length)
          : undefined);
      const isMonitor = Boolean(monDesc) || command.startsWith("[monitor] ");
      return [
        {
          type: "task.updated",
          threadId,
          sessionId,
          taskId,
          phase: "backgrounded",
          toolCallId: String(
            update.tool_call_id ?? update.toolCallId ?? "",
          ) || undefined,
          command: isMonitor && command.startsWith("[monitor] ")
            ? command.slice("[monitor] ".length)
            : command || undefined,
          description,
          cwd: String(update.cwd ?? "") || undefined,
          outputFile: String(
            update.output_file ?? update.outputFile ?? "",
          ) || undefined,
          isMonitor,
          raw: update,
        },
      ];
    }
    case "task_completed": {
      const snap = (update.task_snapshot ??
        update.taskSnapshot ??
        update) as Record<string, unknown>;
      const taskId = String(
        snap.task_id ?? snap.taskId ?? update.task_id ?? update.taskId ?? "",
      );
      if (!taskId) return [];
      const exitRaw = snap.exit_code ?? snap.exitCode;
      const exitCode =
        typeof exitRaw === "number"
          ? exitRaw
          : exitRaw == null
            ? null
            : Number.isFinite(Number(exitRaw))
              ? Number(exitRaw)
              : null;
      const signal =
        typeof snap.signal === "string"
          ? snap.signal
          : typeof update.signal === "string"
            ? update.signal
            : undefined;
      const success =
        exitCode === 0 || (exitCode == null && !signal);
      const staleOnLoad = signal === "session_restart";
      const command = String(
        snap.display_command ??
          snap.displayCommand ??
          snap.command ??
          update.command ??
          "",
      );
      const willWake = Boolean(
        update.will_wake ?? update.willWake ?? false,
      );
      let durationMs: number | undefined;
      const start = snap.start_time ?? snap.startTime;
      const end = snap.end_time ?? snap.endTime;
      // SystemTime JSON 形态不一，仅在两端都是可解析数字/ISO 时算
      try {
        const sMs =
          typeof start === "number"
            ? start
            : typeof start === "string"
              ? Date.parse(start)
              : undefined;
        const eMs =
          typeof end === "number"
            ? end
            : typeof end === "string"
              ? Date.parse(end)
              : undefined;
        if (
          typeof sMs === "number" &&
          typeof eMs === "number" &&
          Number.isFinite(sMs) &&
          Number.isFinite(eMs) &&
          eMs >= sMs
        ) {
          durationMs = eMs - sMs;
        }
      } catch {
        /* ignore */
      }
      const kind = String(snap.kind ?? "").toLowerCase();
      const isMonitor = kind === "monitor";
      const output =
        typeof snap.output === "string" ? snap.output : undefined;
      return [
        {
          type: "task.updated",
          threadId,
          sessionId,
          taskId,
          phase: "completed",
          command: command || undefined,
          description: command || undefined,
          cwd: String(snap.cwd ?? "") || undefined,
          outputFile: String(
            snap.output_file ?? snap.outputFile ?? "",
          ) || undefined,
          toolCallId: String(
            snap.tool_call_id ?? snap.toolCallId ?? "",
          ) || undefined,
          isMonitor,
          exitCode,
          signal,
          success,
          willWake,
          durationMs,
          output: output ? output.slice(0, 4000) : undefined,
          staleOnLoad,
          raw: update,
        },
      ];
    }
    case "monitor_event": {
      const taskId = String(update.task_id ?? update.taskId ?? "");
      if (!taskId) return [];
      const eventText = String(
        update.event_text ?? update.eventText ?? "",
      );
      const description = String(update.description ?? "");
      return [
        {
          type: "task.updated",
          threadId,
          sessionId,
          taskId,
          phase: "monitor",
          description: description || undefined,
          eventText: eventText || undefined,
          isMonitor: true,
          raw: update,
        },
      ];
    }

    default:
      return [];
  }
}

function cacheGoalToolInput(
  toolCallId: string,
  update: Record<string, unknown>,
): void {
  if (!toolCallId) return;
  const rawIn = update.rawInput as Record<string, unknown> | undefined;
  if (rawIn && typeof rawIn === "object") {
    const prev = goalToolInputByCallId.get(toolCallId) ?? {};
    goalToolInputByCallId.set(toolCallId, { ...prev, ...rawIn });
  }
  // 从 title / meta 识别 update_goal
  const title = String(update.title ?? "");
  const meta = update._meta as { "x.ai/tool"?: { name?: string } } | undefined;
  if (
    meta?.["x.ai/tool"]?.name === "update_goal" ||
    title === "update_goal" ||
    title.startsWith("Goal:")
  ) {
    const prev = goalToolInputByCallId.get(toolCallId) ?? {};
    goalToolInputByCallId.set(toolCallId, {
      ...prev,
      __title: title,
      __isGoalTool: true,
    });
  }
}

/**
 * 从 wire GoalUpdated 构建完整 goal.updated 事件（G0/G1 全字段）。
 * 唯一创建 SessionGoalProjection 的事件源。
 */
function buildGoalUpdatedEvent(
  threadId: string,
  sessionId: string,
  update: Record<string, unknown>,
): NormalizedEvent {
  const num = (a: unknown, b?: unknown): number | undefined => {
    if (typeof a === "number" && Number.isFinite(a)) return a;
    if (typeof b === "number" && Number.isFinite(b)) return b;
    return undefined;
  };
  const str = (a: unknown, b?: unknown): string | undefined => {
    if (typeof a === "string") return a;
    if (typeof b === "string") return b;
    return undefined;
  };
  const bool = (a: unknown, b?: unknown): boolean | undefined => {
    if (typeof a === "boolean") return a;
    if (typeof b === "boolean") return b;
    if (a === true || a === false) return Boolean(a);
    return undefined;
  };

  const objective =
    str(update.objective, update.title) ?? "";
  const tokenBudgetRaw =
    update.token_budget !== undefined
      ? update.token_budget
      : update.tokenBudget;
  const tokenBudget =
    tokenBudgetRaw === null
      ? null
      : typeof tokenBudgetRaw === "number"
        ? tokenBudgetRaw
        : undefined;

  return {
    type: "goal.updated",
    threadId,
    sessionId,
    goalId: str(update.goal_id, update.goalId),
    objective,
    status: String(update.status ?? "active"),
    phase: str(update.phase),
    tokenBudget,
    tokensUsed: num(update.tokens_used, update.tokensUsed),
    elapsedMs: num(update.elapsed_ms, update.elapsedMs),
    lastEvent: str(update.last_event, update.lastEvent),
    lastEventDetail: str(update.last_event_detail, update.lastEventDetail),
    message:
      str(update.pause_message, update.pauseMessage) ??
      str(update.message),
    verifyingCompletion: bool(
      update.verifying_completion,
      update.verifyingCompletion,
    ),
    planning: bool(update.planning),
    classifierRunsAttempted: num(
      update.classifier_runs_attempted,
      update.classifierRunsAttempted,
    ),
    classifierMaxRuns: num(
      update.classifier_max_runs,
      update.classifierMaxRuns,
    ),
    lastClassifierVerdict: str(
      update.last_classifier_verdict,
      update.lastClassifierVerdict,
    ),
    lastClassifierDetailsPath: str(
      update.last_classifier_details_path,
      update.lastClassifierDetailsPath,
    ),
    tokenBaseline: num(update.token_baseline, update.tokenBaseline),
    finishedSubagentTokens: num(
      update.finished_subagent_tokens,
      update.finishedSubagentTokens,
    ),
    liveSubagentTokens: num(
      update.live_subagent_tokens,
      update.liveSubagentTokens,
    ),
    raw: update,
  };
}

/** 解析 ACP AvailableCommandsUpdate.available_commands */
function parseAvailableCommands(
  update: Record<string, unknown>,
): import("../shared/events.js").AvailableCommandInfo[] {
  const raw =
    (update.availableCommands as unknown) ??
    (update.available_commands as unknown) ??
    [];
  if (!Array.isArray(raw)) return [];
  const out: import("../shared/events.js").AvailableCommandInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? o.id ?? "").trim();
    if (!name) continue;
    const description =
      typeof o.description === "string"
        ? o.description
        : typeof o.desc === "string"
          ? o.desc
          : undefined;
    const inputRaw = o.input as Record<string, unknown> | undefined;
    const hint =
      inputRaw && typeof inputRaw.hint === "string"
        ? inputRaw.hint
        : typeof o.argumentHint === "string"
          ? o.argumentHint
          : typeof o.argument_hint === "string"
            ? o.argument_hint
            : undefined;
    out.push({
      name,
      description,
      input: hint ? { hint } : undefined,
    });
  }
  return out;
}

/** 从 AvailableCommandsUpdate.meta.tools 提取工具名 */
function parseAvailableToolsMeta(update: Record<string, unknown>): string[] {
  const meta = (update.meta ?? update._meta) as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") return [];
  const tools = meta.tools;
  if (Array.isArray(tools)) {
    return tools.map((t) => String(t).trim()).filter(Boolean);
  }
  if (tools && typeof tools === "object") {
    // 可能是 { name: true } 或 set 序列化
    return Object.keys(tools as Record<string, unknown>).filter(Boolean);
  }
  return [];
}
