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
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    const text =
      params?.prompt?.[0]?.text ??
      params?.prompt?.find?.((p) => p.type === "text")?.text ??
      "";

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

    if (askPermission) {
      try {
        await request("session/request_permission", {
          sessionId,
          description: "Allow fake tool?",
          toolCall: { toolCallId: "tc1", title: "echo" },
          options: [
            { optionId: "allow_once", name: "Allow once" },
            { optionId: "reject", name: "Reject" },
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

  if (id != null) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});
