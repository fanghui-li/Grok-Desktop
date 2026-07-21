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
          raw: update,
        });
        const goalEv = deriveGoalFromUpdateGoalTool(
          threadId,
          sessionId,
          update,
          toolCallId,
          status,
        );
        if (goalEv) events.push(goalEv);
        if (toolCallId) goalToolInputByCallId.delete(toolCallId);
      } else {
        // 中间态：Goal: marking complete + completed:true → 先记 pending，等 goal_updated
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
        const mid = deriveGoalFromUpdateGoalTool(
          threadId,
          sessionId,
          update,
          toolCallId,
          status ?? "pending",
        );
        // 中间态不推 complete，避免误完成
        if (mid && mid.type === "goal.updated" && mid.status !== "complete") {
          events.push(mid);
        }
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
      const objective =
        (update.objective as string) ?? (update.title as string) ?? "";
      events.push({
        type: "goal.updated",
        threadId,
        sessionId,
        goalId: (update.goal_id as string) ?? (update.goalId as string),
        objective,
        status: String(update.status ?? "active"),
        phase: update.phase as string | undefined,
        elapsedMs:
          typeof update.elapsed_ms === "number"
            ? update.elapsed_ms
            : typeof update.elapsedMs === "number"
              ? update.elapsedMs
              : undefined,
        lastEvent: update.last_event as string | undefined,
        message:
          typeof update.message === "string" ? update.message : undefined,
        raw: update,
      });
      break;
    }
    default: {
      // 兜底：任意 payload 带 goal_id + status 的扩展事件
      if (
        (update.goal_id || update.goalId) &&
        (update.status || update.objective)
      ) {
        events.push({
          type: "goal.updated",
          threadId,
          sessionId,
          goalId: (update.goal_id as string) ?? (update.goalId as string),
          objective: String(update.objective ?? update.title ?? ""),
          status: String(update.status ?? "active"),
          elapsedMs:
            typeof update.elapsed_ms === "number"
              ? update.elapsed_ms
              : undefined,
          lastEvent: update.last_event as string | undefined,
          raw: update,
        });
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

function deriveGoalFromUpdateGoalTool(
  threadId: string,
  sessionId: string,
  update: Record<string, unknown>,
  toolCallId: string,
  toolStatus: string,
): NormalizedEvent | null {
  const cached = goalToolInputByCallId.get(toolCallId) ?? {};
  const rawIn = {
    ...cached,
    ...((update.rawInput as Record<string, unknown>) ?? {}),
  };
  const rawOut = (update.rawOutput as Record<string, unknown>) ?? {};
  const title = String(update.title ?? rawIn.__title ?? "");
  const meta = update._meta as { "x.ai/tool"?: { name?: string } } | undefined;
  const toolName =
    meta?.["x.ai/tool"]?.name ??
    (update.name as string) ??
    title;
  const isGoalTool =
    rawIn.__isGoalTool === true ||
    toolName === "update_goal" ||
    title === "update_goal" ||
    title.startsWith("Goal:") ||
    rawOut.type === "UpdateGoal";
  if (!isGoalTool) return null;

  const markingComplete =
    title.toLowerCase().includes("marking complete") ||
    rawIn.completed === true;
  const blocked =
    rawIn.blocked_reason != null && String(rawIn.blocked_reason).length > 0;
  const outSuccess = rawOut.success === true || rawOut.type === "UpdateGoal";
  const summary = String(rawOut.summary ?? "");

  // 终态 completed + UpdateGoal success：若仍在 classifier 排队，不立刻 complete
  // 最终以 goal_updated status=complete 为准；此处仅作 progress 提示
  if (toolStatus === "completed" && outSuccess) {
    if (
      summary.toLowerCase().includes("queued") ||
      summary.toLowerCase().includes("pending") ||
      summary.toLowerCase().includes("classifier")
    ) {
      // 不推 complete，避免把 UI 打成完成又被 active 冲掉
      return null;
    }
    // 无排队语义且明确 completed → 视为完成
    if (markingComplete || rawIn.completed === true) {
      return {
        type: "goal.updated",
        threadId,
        sessionId,
        objective: String(rawIn.message ?? title.replace(/^Goal:\s*/i, "")),
        status: "complete",
        message:
          typeof rawIn.message === "string" ? rawIn.message : undefined,
        lastEvent: "tool_update_goal_completed",
        raw: update,
      };
    }
  }

  if (toolStatus === "failed") {
    return null;
  }

  // 中间进度（非完成）
  if (blocked) {
    return {
      type: "goal.updated",
      threadId,
      sessionId,
      objective: String(rawIn.message ?? ""),
      status: "blocked",
      message:
        typeof rawIn.blocked_reason === "string"
          ? rawIn.blocked_reason
          : typeof rawIn.message === "string"
            ? rawIn.message
            : undefined,
      raw: update,
    };
  }

  if (typeof rawIn.message === "string" && rawIn.message && !markingComplete) {
    return {
      type: "goal.updated",
      threadId,
      sessionId,
      objective: rawIn.message,
      status: "active",
      message: rawIn.message,
      raw: update,
    };
  }

  return null;
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
