#!/usr/bin/env node
/**
 * Minimal ACP agent over stdio JSON-RPC for Host integration tests.
 * Speaks the same wire protocol Host uses with real `grok agent stdio`.
 */
import fs from "node:fs";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const rl = readline.createInterface({ input: process.stdin });
let sessionId = null;
const askPermission = process.env.FAKE_ACP_ASK_PERMISSION === "1";
/** When set, session/prompt hangs until session/cancel (mid-turn cancel tests). */
let hungPromptId = null;

/**
 * Minimal goal harness for Host E2E (maps checklist P/L/N/M).
 * Only responds to user `/goal …` slash — never invents goal on plain prompts.
 * Env FAKE_ACP_GOAL=0 disables.
 */
const goalHarnessEnabled = process.env.FAKE_ACP_GOAL !== "0";
/** @type {{ goalId: string, objective: string, status: string, tokenBudget: number|null, elapsedMs: number } | null} */
let goalState = null;

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notifyUpdate(update) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function request(method, params) {
  const id = `srv_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

const pending = new Map();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Response to our reverse request
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(String(msg.id));
    if (p) {
      pending.delete(String(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? "error"));
      else p.resolve(msg.result);
    }
    return;
  }

  const { id, method, params } = msg;
  if (!method) return;

  if (method === "initialize") {
    // Capture for contract tests (FAKE_ACP_INIT_LOG=path)
    const logPath = process.env.FAKE_ACP_INIT_LOG;
    if (logPath) {
      try {
        fs.writeFileSync(logPath, JSON.stringify(params ?? {}, null, 2), "utf8");
      } catch {
        /* ignore */
      }
    }
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        serverInfo: { name: "fake-acp-agent", version: "0.1.0" },
        agentCapabilities: { loadSession: true },
        _meta: { agentVersion: "fake-0.1.0", "x.ai/hooks": true },
      },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "session/new") {
    sessionId = `sess_fake_${randomUUID()}`;
    write({
      jsonrpc: "2.0",
      id,
      result: { sessionId },
    });
    return;
  }

  if (method === "session/load") {
    sessionId = params?.sessionId ?? sessionId ?? `sess_fake_${randomUUID()}`;
    write({
      jsonrpc: "2.0",
      id,
      result: { sessionId },
    });
    return;
  }

  if (method === "session/cancel") {
    // ACP CancelNotification: real agent accepts notification (no id).
    // Desktop must send notify; tests may still send request with id.
    const cancelLog = process.env.FAKE_ACP_CANCEL_LOG;
    if (cancelLog) {
      try {
        const prev = fs.existsSync(cancelLog)
          ? JSON.parse(fs.readFileSync(cancelLog, "utf8"))
          : [];
        const list = Array.isArray(prev) ? prev : [prev];
        list.push({
          ...(params ?? {}),
          _testWire: id != null ? "request" : "notification",
        });
        fs.writeFileSync(cancelLog, JSON.stringify(list, null, 2), "utf8");
      } catch {
        /* ignore */
      }
    }
    // Resolve hung prompt if mid-turn cancel test
    if (hungPromptId != null) {
      write({
        jsonrpc: "2.0",
        id: hungPromptId,
        result: { stopReason: "cancelled" },
      });
      hungPromptId = null;
    }
    // Only respond when client used request (id present)
    if (id != null) {
      write({ jsonrpc: "2.0", id, result: {} });
    }
    return;
  }

  if (method === "session/prompt") {
    // Mid-turn cancel tests: hold the prompt open until session/cancel
    if (process.env.FAKE_ACP_SLOW_PROMPT === "1") {
      hungPromptId = id;
      notifyUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "slow…" },
      });
      return;
    }
    const text =
      params?.prompt?.[0]?.text ??
      params?.prompt?.find?.((p) => p.type === "text")?.text ??
      "";

    // ── Goal harness (CLI-aligned: only /goal slash starts goal) ──
    if (goalHarnessEnabled) {
      const trimmed = String(text || "").trim();
      const goalMatch = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
      if (goalMatch) {
        const args = (goalMatch[1] ?? "").trim();
        const lower = args.toLowerCase();
        if (!args || lower === "status") {
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: goalState
                ? `goal status: ${goalState.status} — ${goalState.objective}`
                : "No goal is currently set",
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        if (lower === "pause") {
          if (goalState && goalState.status === "active") {
            goalState = { ...goalState, status: "user_paused" };
            emitGoalUpdated(goalState);
          }
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "goal paused" },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        if (lower === "resume") {
          if (goalState && goalState.status !== "cleared") {
            goalState = { ...goalState, status: "active" };
            emitGoalUpdated(goalState);
          }
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "goal resumed" },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        if (lower === "clear") {
          const prevId = goalState?.goalId ?? "";
          goalState = null;
          notifyUpdate({
            sessionUpdate: "goal_updated",
            goal_id: prevId,
            objective: "",
            status: "cleared",
            phase: "idle",
            elapsed_ms: 0,
            tokens_used: 0,
          });
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "goal cleared" },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        // Test-only: complete path (checklist C1) — real CLI uses classifier
        if (lower === "complete" || lower === "done") {
          if (goalState) {
            goalState = {
              ...goalState,
              status: "complete",
              elapsedMs: Math.max(goalState.elapsedMs, 1200),
            };
            emitGoalUpdated(goalState, {
              phase: "done",
              last_event: "goal_completed",
              verifying_completion: false,
            });
          }
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "goal complete" },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn" },
          });
          return;
        }
        // GoalSet: parse trailing --budget N
        let objective = args;
        let tokenBudget = null;
        const budgetM = args.match(/^(.*?)\s+--budget\s+(\d+)\s*$/i);
        if (budgetM) {
          objective = budgetM[1].trim();
          tokenBudget = Number(budgetM[2]);
        }
        if (objective) {
          goalState = {
            goalId: `g_fake_${randomUUID().slice(0, 8)}`,
            objective,
            status: "active",
            tokenBudget:
              tokenBudget != null && tokenBudget > 0 ? tokenBudget : null,
            elapsedMs: 0,
          };
          emitGoalUpdated(goalState, {
            phase: "planning",
            planning: true,
            last_event: "goal_created",
          });
          // second tick: executing
          goalState = { ...goalState, elapsedMs: 500 };
          emitGoalUpdated(goalState, {
            phase: "executing",
            planning: false,
            last_event: "worker_started",
          });
          notifyUpdate({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Working on goal: ${objective}`,
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: { stopReason: "end_turn", text: "goal started" },
          });
          return;
        }
      }
    }

    // Plain prompt: must NOT emit goal_updated (checklist N1–N2)
    notifyUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "pong" },
    });
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      tool: "echo",
      title: "echo",
    });

    // Optional: noisy update_goal tool without harness (must not create goal UI alone)
    if (process.env.FAKE_ACP_NOISE_UPDATE_GOAL === "1") {
      notifyUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc_goal_noise",
        tool: "update_goal",
        title: "update_goal",
        _meta: { "x.ai/tool": { name: "update_goal" } },
        rawInput: { message: "should not create goal", completed: false },
      });
      notifyUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_goal_noise",
        status: "completed",
        title: "update_goal",
        _meta: { "x.ai/tool": { name: "update_goal" } },
        rawOutput: { type: "UpdateGoal", success: true, summary: "ok" },
      });
    }

    if (askPermission) {
      try {
        await request("session/request_permission", {
          sessionId,
          description: "Allow fake tool?",
          toolCall: { toolCallId: "tc1", title: "echo" },
          // 对齐 Grok Build 连字符 optionId（Desktop 须原样回传）
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
      } catch {
        /* client may deny */
      }
    }

    notifyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
    });

    write({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn", text: "pong" },
    });
    return;
  }

  function emitGoalUpdated(g, extra = {}) {
    notifyUpdate({
      sessionUpdate: "goal_updated",
      goal_id: g.goalId,
      objective: g.objective,
      status: g.status,
      phase: extra.phase ?? "executing",
      token_budget: g.tokenBudget,
      tokens_used: extra.tokens_used ?? 100,
      elapsed_ms: g.elapsedMs,
      last_event: extra.last_event,
      pause_message: extra.pause_message,
      planning: extra.planning === true ? true : undefined,
      verifying_completion:
        extra.verifying_completion === true ? true : undefined,
    });
  }

  // Desktop PR-A/C: true compact + session/info
  if (
    method === "_x.ai/compact_conversation" ||
    method === "x.ai/compact_conversation"
  ) {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "_x.ai/session/info" || method === "x.ai/session/info") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId: sessionId ?? params?.sessionId ?? "sess_fake",
        cwd: process.cwd(),
        agentName: "fake-acp-agent",
        model: "fake-model",
        modelDisplayName: "Fake Model",
        turns: 1,
        turnIndex: 0,
        context: {
          used: 1200,
          total: 128000,
          systemPromptTokens: 400,
          toolDefinitionsCount: 3,
          toolDefinitionsTokens: 200,
          compactionCount: 0,
          turnCount: 1,
          toolCallCount: 0,
          messageCount: 2,
          messageTokens: 600,
          freeTokens: 126800,
          usagePct: 1,
          autoCompactThresholdPercent: 85,
          usageCategories: [
            { label: "Skills", tokens: 50, detail: "1 skill" },
          ],
        },
      },
    });
    return;
  }

  // S20: kill background task (CLI x.ai/task/kill)
  if (method === "_x.ai/task/kill" || method === "x.ai/task/kill") {
    const tid = params?.taskId ?? params?.task_id ?? "unknown";
    write({
      jsonrpc: "2.0",
      id,
      result: {
        taskId: tid,
        outcome: "killed",
      },
    });
    return;
  }

  // CLI memory flush / rewrite
  if (method === "_x.ai/memory/flush" || method === "x.ai/memory/flush") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "_x.ai/memory/rewrite" || method === "x.ai/memory/rewrite") {
    const raw = params?.rawText ?? params?.raw_text ?? "";
    write({
      jsonrpc: "2.0",
      id,
      result: { rewritten: `## Preferences\n\n- ${raw}` },
    });
    return;
  }

  // /btw side question (CLI: x.ai/btw · Desktop wire: _x.ai/btw)
  if (method === "_x.ai/btw" || method === "x.ai/btw") {
    const q = String(params?.question ?? "").trim();
    write({
      jsonrpc: "2.0",
      id,
      result: {
        answer: q ? `btw-echo: ${q}` : "No response",
      },
    });
    return;
  }

  // mid-turn interject (does not cancel turn)
  if (method === "_x.ai/interject" || method === "x.ai/interject") {
    const interjectionId =
      params?.interjectionId ??
      params?.interjection_id ??
      `ij_fake_${randomUUID()}`;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        status: hungPromptId ? "queued" : "accepted",
        interjectionId,
      },
    });
    return;
  }

  if (id != null) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
