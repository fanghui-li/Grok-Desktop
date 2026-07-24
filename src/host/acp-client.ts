import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { enrichAcpErrorMessage } from "../shared/enrich-acp-error.js";
import { HostError } from "../shared/errors.js";
import type { NormalizedEvent } from "../shared/events.js";
import type { GrokCapabilities } from "../shared/types.js";
import {
  ACP_WIRE_CLIENT_IDENTIFIER,
  readAppVersion,
} from "./app-version.js";
import {
  BASELINE_CAPABILITIES,
  parseInitializeCapabilities,
} from "./capabilities.js";
import type { HostLogger } from "./logger.js";
import {
  normalizeSessionNotification,
  normalizeSessionUpdate,
} from "./normalize.js";
import {
  extractPermissionOptions,
  resolvePermissionOptionId,
  type PermissionDecisionWire,
  type PermissionOptionLike,
} from "./permission-options.js";

type JsonRpcId = number | string;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: HostLogger;
  threadId: string;
  onEvent: (event: NormalizedEvent) => void;
  allowFs?: boolean;
}

/** 从 tool.completed raw 抽出失败原因（权限 option 错误等） */
function extractToolFailureMessage(
  raw: unknown,
  name?: string,
): string | null {
  const parts: string[] = [];
  if (name?.trim()) parts.push(name.trim());
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const content = r.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        const inner = (c as { content?: { text?: string }; text?: string })
          .content;
        const t =
          (typeof inner === "object" && inner && "text" in inner
            ? String((inner as { text?: string }).text ?? "")
            : "") ||
          String((c as { text?: string }).text ?? "");
        if (t.trim()) {
          parts.push(t.trim().slice(0, 240));
          break;
        }
      }
    }
    const out = r.rawOutput ?? r.raw_output;
    if (out && typeof out === "object") {
      const m = (out as { message?: string; error?: string }).message ??
        (out as { error?: string }).error;
      if (typeof m === "string" && m.trim()) parts.push(m.trim().slice(0, 240));
    }
    if (typeof r.message === "string" && r.message.trim()) {
      parts.push(r.message.trim().slice(0, 240));
    }
  }
  if (parts.length <= (name?.trim() ? 1 : 0)) return null;
  return parts.join(": ").slice(0, 320);
}

/**
 * JSON-RPC over stdio ACP client — the real path used by Desktop Host.
 */
export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  /**
   * Pending RPC idle timers — reset on any ACP traffic so long tool chains
   * do not hit a fixed wall-clock timeout while the agent is still working.
   */
  private pendingTimers = new Map<
    JsonRpcId,
    {
      idleMs: number;
      maxMs: number;
      startedAt: number;
      timer: ReturnType<typeof setTimeout>;
      fire: () => void;
    }
  >();
  private sessionId: string | null = null;
  private closed = false;
  /** True if we already streamed assistant message chunks this turn. */
  private streamedAssistantThisTurn = false;
  /** True if any tool/process activity was observed this turn. */
  private hadToolActivityThisTurn = false;
  /** True if any tool ended failed this turn. */
  private hadToolFailuresThisTurn = false;
  /** Last tool failure text for UI. */
  private lastToolFailureThisTurn: string | null = null;
  /**
   * RPC id of the in-flight `session/prompt` (if any).
   * cancel() rejects this so Host does not hang on a cancelled turn.
   */
  private activePromptRpcId: JsonRpcId | null = null;
  /**
   * Client-generated prompt id for the in-flight turn (CLI cancelPromptId).
   * Sent on session/cancel `_meta` so agent can attribute cancel delivery.
   */
  private activeClientPromptId: string | null = null;
  /**
   * Monotonic generation for each session/prompt.
   * cancel() bumps it so late agent stdout from a cancelled turn never
   * paints into the next user prompt (cross-turn bleed).
   * Isolation is generation-gate only (CLI-aligned) — no content poison filter.
   */
  private promptGeneration = 0;
  /** Generation currently accepted for stream/tool events (0 = none). */
  private activePromptGeneration = 0;
  /** True while the current generation was cancelled (redundant with gen mismatch). */
  private turnCancelled = false;
  /** Serialize cancel so prompt() waits for in-flight cancel to finish. */
  private cancelInFlight: Promise<void> | null = null;
  /**
   * Last time we saw assistant/tool stream traffic (even if dropped).
   * Brief quiet after cancel; no multi-second drain (CLI cancels without long wait).
   */
  private lastStreamAtMs = 0;
  /**
   * Only forward stream/tool after this prompt generation was written to agent.
   * 0 = drop all stream (between prompts / after cancel).
   */
  private streamAcceptGeneration = 0;
  /** When the current session/prompt was written to agent stdin. */
  private promptWireAtMs = 0;
  /** Last cancel() finish time — next prompt may brief-settle first. */
  private lastCancelAtMs = 0;
  /** Generation for which turn.started was already emitted (gate open). */
  private turnStartedEmittedGen = 0;
  /** Tool call ids seen while gate was closed — never re-paint after open. */
  private residualToolCallIds = new Set<string>();
  private permissionWaiters = new Map<
    string,
    {
      resolve: (optionId: string) => void;
      /** agent 在 request_permission 里给出的合法 option 列表 */
      options: PermissionOptionLike[];
    }
  >();
  /** x.ai/exit_plan_mode 审批等待 */
  private planApprovalWaiters = new Map<
    string,
    {
      resolve: (resp: {
        outcome: "approved" | "cancelled" | "abandoned";
        feedback?: string;
      }) => void;
    }
  >();
  /** x.ai/ask_user_question 等待 UI 回答 */
  private askUserWaiters = new Map<
    string,
    {
      resolve: (resp: {
        outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
        answers?: Record<string, string[]>;
        partialAnswers?: Record<string, string>;
      }) => void;
    }
  >();
  /** Parsed from initialize (P2-C). */
  private agentCaps: GrokCapabilities = { ...BASELINE_CAPABILITIES };
  /** Last initialize params (tests / diagnostics). */
  lastInitializeParams: Record<string, unknown> | null = null;

  constructor(private readonly opts: AcpClientOptions) {}

  get attachedSessionId(): string | null {
    return this.sessionId;
  }

  get capabilities(): GrokCapabilities {
    return { ...this.agentCaps };
  }

  /** 是否有未结束的 session/prompt（切回会话 rehydrate 真源） */
  isPromptInFlight(): boolean {
    return this.activePromptRpcId != null && !this.turnCancelled;
  }

  /** Mode B liveness: process still running. */
  isAlive(): boolean {
    if (this.closed) return false;
    const p = this.proc;
    if (!p) return false;
    if (p.killed) return false;
    if (p.exitCode != null) return false;
    return true;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.opts.logger?.info("acp.spawn", {
      command: this.opts.command,
      args: this.opts.args,
    });

    const appVersion = readAppVersion();
    const env = {
      ...(this.opts.env ?? process.env),
      // 与 ACP wire 身份一致：process 级 header 默认也走 shell 准入
      GROK_CLIENT_NAME: ACP_WIRE_CLIENT_IDENTIFIER,
      GROK_CLIENT_VERSION: appVersion,
    };

    this.proc = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.on("error", (err) => {
      this.opts.logger?.error("acp.process_error", { err: String(err) });
      this.failAll(
        new HostError("AGENT_CRASHED", `Agent process error: ${err.message}`),
      );
    });

    this.proc.on("exit", (code, signal) => {
      this.opts.logger?.info("acp.exit", { code, signal });
      if (!this.closed) {
        this.failAll(
          new HostError(
            "AGENT_CRASHED",
            `Agent exited (code=${code}, signal=${signal})`,
          ),
        );
        this.opts.onEvent({
          type: "agent.error",
          threadId: this.opts.threadId,
          sessionId: this.sessionId ?? undefined,
          message: `Agent exited (code=${code})`,
          code: "AGENT_CRASHED",
        });
      }
    });

    this.proc.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8").trim();
      if (text) {
        // stderr chatter also proves the agent is alive
        this.touchPendingActivity();
        this.opts.logger?.debug("acp.stderr", { text: text.slice(0, 2000) });
      }
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    const initParams = {
      protocolVersion: 1,
      clientInfo: {
        name: ACP_WIRE_CLIENT_IDENTIFIER,
        version: appVersion,
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
      _meta: {
        clientIdentifier: ACP_WIRE_CLIENT_IDENTIFIER,
        clientVersion: appVersion,
      },
    };
    this.lastInitializeParams = initParams;
    this.opts.logger?.info("acp.initialize", {
      version: appVersion,
      clientIdentifier: ACP_WIRE_CLIENT_IDENTIFIER,
      wireCompat: "shell-for-official-proxy",
    });

    const initResult = await this.request("initialize", initParams);
    this.agentCaps = parseInitializeCapabilities(initResult);

    this.notify("notifications/initialized", {});
  }

  async createSession(params: {
    cwd: string;
    mcpServers?: unknown[];
    meta?: Record<string, unknown>;
  }): Promise<string> {
    const result = (await this.request("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params.meta ? { _meta: params.meta } : {}),
    })) as { sessionId?: string };

    if (!result?.sessionId) {
      throw new HostError(
        "INTERNAL",
        "session/new did not return sessionId",
        result,
      );
    }
    this.sessionId = result.sessionId;
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: this.sessionId,
      status: "idle",
    });
    return this.sessionId;
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<string> {
    const result = (await this.request("session/load", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    })) as { sessionId?: string };

    this.sessionId = result?.sessionId ?? params.sessionId;
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: this.sessionId,
      status: "idle",
    });
    return this.sessionId;
  }

  /** Wait until agent stops emitting stream/tool (or maxMs). */
  private async waitStreamQuiet(
    quietMs = 600,
    maxMs = 4_000,
  ): Promise<void> {
    const start = Date.now();
    // If we never saw stream, still brief yield so cancel can flush
    if (this.lastStreamAtMs <= 0) {
      await new Promise((r) => setTimeout(r, 120));
      return;
    }
    while (Date.now() - start < maxMs) {
      const idle = Date.now() - this.lastStreamAtMs;
      if (idle >= quietMs) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Open the stream gate for this prompt generation and emit turn.started once.
   * Call only after session/prompt is on the wire; residual T1 is dropped by
   * generation mismatch (no content-level poison filter).
   */
  private openStreamGate(gen: number): void {
    if (
      this.turnCancelled ||
      this.activePromptGeneration !== gen ||
      gen <= 0
    ) {
      return;
    }
    this.streamAcceptGeneration = gen;
    if (this.turnStartedEmittedGen === gen) return;
    this.turnStartedEmittedGen = gen;
    this.opts.onEvent({
      type: "turn.started",
      threadId: this.opts.threadId,
      sessionId: this.sessionId ?? "",
    });
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: this.sessionId ?? "",
      status: "working",
    });
  }

  /**
   * 发送 session/prompt。
   * - string：纯文本（兼容旧路径）
   * - blocks：ACP ContentBlock 数组（图 = type:image + data + mimeType）
   */
  async prompt(
    content:
      | string
      | Array<Record<string, unknown>>,
  ): Promise<{ stopReason?: string }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }

    const promptBlocks: Array<Record<string, unknown>> = Array.isArray(content)
      ? content.length
        ? content
        : [{ type: "text", text: "" }]
      : [{ type: "text", text: content }];

    // Wait out any cancel; never stack a new prompt on a half-dead turn
    if (this.cancelInFlight) {
      await this.cancelInFlight;
    }
    if (this.activePromptRpcId != null) {
      await this.cancel();
    }
    // After cancel notification, ensure residual T1 is quiet before new prompt
    if (this.lastCancelAtMs > 0 && Date.now() - this.lastCancelAtMs < 5_000) {
      await this.waitStreamQuiet(300, 3_000);
    }

    // New user prompt: invalidate any cancelled turn's late stdout
    this.promptGeneration += 1;
    const myGen = this.promptGeneration;
    this.activePromptGeneration = myGen;
    // Drop all stream until this prompt is on the wire + short settle
    this.streamAcceptGeneration = 0;
    this.promptWireAtMs = 0;
    this.turnStartedEmittedGen = 0;
    this.streamedAssistantThisTurn = false;
    this.hadToolActivityThisTurn = false;
    this.hadToolFailuresThisTurn = false;
    this.lastToolFailureThisTurn = null;
    this.residualToolCallIds.clear();
    this.turnCancelled = false;
    this.activePromptRpcId = null;
    // Client prompt id for cancel `_meta.cancelPromptId` (CLI-aligned)
    const clientPromptId = `p_${randomUUID()}`;
    this.activeClientPromptId = clientPromptId;
    // turn.started deferred until openStreamGate() after write + short settle

    try {
      // Idle-reset (#5) + turn.completed metadata for UI settle UX (#6).
      // streamAcceptGeneration / turn.started set inside request() after write.
      const result = (await this.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: promptBlocks,
          _meta: { promptId: clientPromptId },
        },
        { idleMs: 15 * 60_000, maxMs: 2 * 60 * 60_000 },
        { trackAsPrompt: true, acceptStreamGeneration: myGen },
      )) as { stopReason?: string; stop_reason?: string; text?: string };

      // Stale: cancel() or a newer prompt superseded this generation
      if (myGen !== this.activePromptGeneration || this.turnCancelled) {
        return { stopReason: "cancelled" };
      }

      // Only emit final text if no streaming chunks were received (avoid duplicate full paste)
      if (
        result?.text &&
        !this.streamedAssistantThisTurn &&
        myGen === this.activePromptGeneration &&
        !this.turnCancelled
      ) {
        if (this.turnStartedEmittedGen !== myGen) {
          this.openStreamGate(myGen);
        }
        this.streamedAssistantThisTurn = true;
        this.opts.onEvent({
          type: "message.delta",
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          role: "assistant",
          text: result.text,
        });
      }

      // Re-check after await: cancel may have raced in
      if (myGen !== this.activePromptGeneration || this.turnCancelled) {
        return { stopReason: "cancelled" };
      }

      const rawStop = result?.stopReason ?? result?.stop_reason;
      this.opts.onEvent({
        type: "turn.completed",
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        stopReason: rawStop,
        hadAssistantText:
          this.streamedAssistantThisTurn || Boolean(result?.text),
        hadToolActivity: this.hadToolActivityThisTurn,
        hadToolFailures: this.hadToolFailuresThisTurn,
        lastToolFailure: this.lastToolFailureThisTurn ?? undefined,
      });
      this.opts.onEvent({
        type: "session.status",
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        status: "idle",
      });
      return result ?? {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code ?? "")
          : "";
      // cancel() rejects prompt with CANCELLED — already emitted turn.completed
      if (
        code === "CANCELLED" ||
        this.turnCancelled ||
        myGen !== this.activePromptGeneration
      ) {
        return { stopReason: "cancelled" };
      }
      const stopReason =
        code === "TIMEOUT" || /timed out/i.test(message) ? "timeout" : "error";
      this.opts.onEvent({
        type: "turn.completed",
        threadId: this.opts.threadId,
        sessionId: this.sessionId ?? "",
        stopReason,
        error: message,
        hadAssistantText: this.streamedAssistantThisTurn,
        hadToolActivity: this.hadToolActivityThisTurn,
        hadToolFailures: this.hadToolFailuresThisTurn,
        lastToolFailure: this.lastToolFailureThisTurn ?? undefined,
      });
      this.opts.onEvent({
        type: "session.status",
        threadId: this.opts.threadId,
        sessionId: this.sessionId ?? "",
        status: "failed",
      });
      throw err;
    } finally {
      // Close stream gate for this generation
      if (this.streamAcceptGeneration === myGen) {
        this.streamAcceptGeneration = 0;
      }
      // Do not zero activePromptGeneration: cancel may have advanced it for isolation
      if (myGen === this.activePromptGeneration) {
        this.activePromptRpcId = null;
        if (this.activeClientPromptId === clientPromptId) {
          this.activeClientPromptId = null;
        }
      }
    }
  }

  /**
   * Cancel the in-flight turn (user Stop / Esc / send_now).
   * Aligns with CLI `session/cancel` + `_meta`:
   * - cancelSubagents: true (stop nested agents)
   * - cancelTrigger: "stop" | "esc" | "send_now" | …
   * - cancelPromptId: client prompt id of the cancelled turn (when known)
   * - rewindIfPristine: false by default
   * Concurrent cancel() joins the same in-flight promise (retry-safe Cancelling).
   */
  async cancel(opts?: {
    /** CLI cancelTrigger: stop button, esc, send_now, … */
    trigger?: string;
    /** Override cancelPromptId; default = in-flight client prompt id */
    cancelPromptId?: string;
  }): Promise<void> {
    if (!this.sessionId) return;
    if (this.cancelInFlight) {
      await this.cancelInFlight;
      return;
    }
    const trigger = opts?.trigger?.trim() || "stop";
    const cancelPromptId =
      opts?.cancelPromptId?.trim() || this.activeClientPromptId || undefined;
    this.cancelInFlight = this.runCancel(trigger, cancelPromptId).finally(
      () => {
        this.cancelInFlight = null;
      },
    );
    await this.cancelInFlight;
  }

  private async runCancel(
    trigger: string,
    cancelPromptId?: string,
  ): Promise<void> {
    if (!this.sessionId) return;
    this.turnCancelled = true;
    // Invalidate current generation so late stdout cannot attach to next prompt
    this.promptGeneration += 1;
    this.activePromptGeneration = this.promptGeneration;
    // Hard-close stream gate (T1 tokens must not pass until next prompt is on wire)
    this.streamAcceptGeneration = 0;
    this.turnStartedEmittedGen = 0;

    // Abort local wait on session/prompt immediately (do not wait for agent).
    // Emit turn.completed once — UI also endTurns optimistically; renderer
    // ignores duplicate cancelled settle while stop-suppressed.
    const promptId = this.activePromptRpcId;
    let settled = false;
    if (promptId != null) {
      const pending = this.pending.get(promptId);
      if (pending) {
        const entry = this.pendingTimers.get(promptId);
        if (entry) clearTimeout(entry.timer);
        this.pendingTimers.delete(promptId);
        this.pending.delete(promptId);
        this.activePromptRpcId = null;
        this.opts.onEvent({
          type: "turn.completed",
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          stopReason: "cancelled",
          hadAssistantText: this.streamedAssistantThisTurn,
          hadToolActivity: this.hadToolActivityThisTurn,
          hadToolFailures: this.hadToolFailuresThisTurn,
          lastToolFailure: this.lastToolFailureThisTurn ?? undefined,
        });
        this.opts.onEvent({
          type: "session.status",
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          status: "idle",
        });
        settled = true;
        pending.reject(
          new HostError("CANCELLED", "Turn cancelled by user"),
        );
      } else {
        this.activePromptRpcId = null;
      }
    }
    if (!settled) {
      this.opts.onEvent({
        type: "turn.completed",
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        stopReason: "cancelled",
        hadAssistantText: this.streamedAssistantThisTurn,
        hadToolActivity: this.hadToolActivityThisTurn,
        hadToolFailures: this.hadToolFailuresThisTurn,
        lastToolFailure: this.lastToolFailureThisTurn ?? undefined,
      });
      this.opts.onEvent({
        type: "session.status",
        threadId: this.opts.threadId,
        sessionId: this.sessionId,
        status: "idle",
      });
    }

    /**
     * ROOT CAUSE FIX (2026-07-22 host logs):
     * ACP `session/cancel` is a **notification** (`CancelNotification`), not a
     * request. Sending `{id, method:"session/cancel"}` makes real `grok agent`
     * answer **Method not found** — cancel never runs, T1 keeps generating,
     * and T2 (e.g. 苹果) mixes with 玻璃. CLI sends CancelNotification (no id).
     */
    const meta: Record<string, unknown> = {
      cancelSubagents: true,
      cancelTrigger: trigger,
      rewindIfPristine: false,
    };
    if (cancelPromptId) meta.cancelPromptId = cancelPromptId;
    this.opts.logger?.info("acp.cancel", {
      sessionId: this.sessionId,
      trigger,
      cancelPromptId: cancelPromptId ?? null,
      promptGen: this.promptGeneration,
      streamAcceptGen: this.streamAcceptGeneration,
      wire: "notification",
    });
    try {
      this.notify("session/cancel", {
        sessionId: this.sessionId,
        _meta: meta,
      });
    } catch (err) {
      this.opts.logger?.warn("acp.cancel_notify_failed", { err: String(err) });
    }
    this.activeClientPromptId = null;
    // Cancel is fire-and-forget on agent; wait until residual T1 traffic quiets
    // before the next session/prompt (abort is async after the notification).
    await this.waitStreamQuiet(400, 4_000);
    this.lastCancelAtMs = Date.now();
    this.streamAcceptGeneration = 0;
  }

  /**
   * ACP 扩展方法：wire 名为 `_x.ai/...`（无下划线前缀会 Method not found）。
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    const m = method.startsWith("_") ? method : `_${method}`;
    return this.request(m, params, timeoutMs);
  }

  /** 列出可回退点（每条 user prompt 一个） */
  async rewindPoints(): Promise<{
    rewind_points: Array<{
      prompt_index: number;
      created_at?: string;
      num_file_snapshots?: number;
      has_file_changes?: boolean;
      prompt_preview?: string;
    }>;
  }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const result = (await this.extMethod("_x.ai/rewind/points", {
      sessionId: this.sessionId,
    })) as {
      rewind_points?: Array<Record<string, unknown>>;
      rewindPoints?: Array<Record<string, unknown>>;
    };
    const raw = result?.rewind_points ?? result?.rewindPoints ?? [];
    return {
      rewind_points: raw.map((p) => ({
        prompt_index: Number(p.prompt_index ?? p.promptIndex ?? 0),
        created_at: (p.created_at ?? p.createdAt) as string | undefined,
        num_file_snapshots: Number(
          p.num_file_snapshots ?? p.numFileSnapshots ?? 0,
        ),
        has_file_changes: Boolean(p.has_file_changes ?? p.hasFileChanges),
        prompt_preview: (p.prompt_preview ?? p.promptPreview) as
          | string
          | undefined,
      })),
    };
  }

  /**
   * 回退到 targetPromptIndex 执行前（丢弃 index 及之后）。
   * - mode=all：对话+文件（默认，UI 完整 rewind）
   * - mode=conversation_only：只砍 agent 对话上下文，不动文件
   *   （Stop 后下一题隔离：UI 仍显示被停轮，agent 不再续写）
   */
  async rewindExecute(
    targetPromptIndex: number,
    opts?: { force?: boolean; mode?: "all" | "conversation_only" | "files_only" },
  ): Promise<{
    success: boolean;
    target_prompt_index: number;
    mode?: string;
    reverted_files?: string[];
    clean_files?: string[];
    conflicts?: Array<{ path?: string; conflict_type?: string }>;
    prompt_text?: string;
    error?: string;
  }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    if (!Number.isFinite(targetPromptIndex) || targetPromptIndex < 0) {
      throw new HostError("INVALID_ARGUMENT", "invalid targetPromptIndex");
    }
    const mode =
      opts?.mode === "conversation_only"
        ? "conversation_only"
        : opts?.mode === "files_only"
          ? "files_only"
          : "all";
    const result = (await this.extMethod(
      "_x.ai/rewind/execute",
      {
        sessionId: this.sessionId,
        targetPromptIndex,
        // agent：false=dry-run 预览；true=真正执行
        force: opts?.force === true,
        mode,
      },
      120_000,
    )) as Record<string, unknown>;

    const conflicts = (result.conflicts as Array<Record<string, unknown>>) ?? [];
    return {
      success: result.success === true,
      target_prompt_index: Number(
        result.target_prompt_index ?? result.targetPromptIndex ?? targetPromptIndex,
      ),
      mode: (result.mode as string) ?? "all",
      reverted_files: (result.reverted_files ??
        result.revertedFiles ??
        []) as string[],
      clean_files: (result.clean_files ?? result.cleanFiles ?? []) as string[],
      conflicts: conflicts.map((c) => ({
        path: c.path as string | undefined,
        conflict_type: (c.conflict_type ?? c.conflictType) as string | undefined,
      })),
      prompt_text: (result.prompt_text ?? result.promptText) as string | undefined,
      error:
        typeof result.error === "string"
          ? result.error
          : result.error != null
            ? String(result.error)
            : undefined,
    };
  }

  /**
   * 对齐 CLI `x.ai/memory/flush`：把当前会话要点刷到 memory 后端。
   */
  async memoryFlush(): Promise<void> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    await this.extMethod(
      "_x.ai/memory/flush",
      {
        sessionId: this.sessionId,
        session_id: this.sessionId,
      },
      120_000,
    );
    this.opts.logger?.info("acp.memoryFlush", { sessionId: this.sessionId });
  }

  /**
   * 对齐 CLI `x.ai/memory/rewrite`：把原始笔记整理成结构化 markdown。
   */
  async memoryRewrite(
    rawText: string,
    contextSummary = "",
  ): Promise<{ rewritten: string }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const raw = (await this.extMethod(
      "_x.ai/memory/rewrite",
      {
        sessionId: this.sessionId,
        session_id: this.sessionId,
        rawText,
        raw_text: rawText,
        contextSummary,
        context_summary: contextSummary,
      },
      120_000,
    )) as Record<string, unknown>;
    const nested =
      raw?.result && typeof raw.result === "object"
        ? (raw.result as Record<string, unknown>)
        : raw;
    const rewritten =
      typeof nested?.rewritten === "string"
        ? nested.rewritten
        : typeof nested?.text === "string"
          ? nested.text
          : rawText;
    this.opts.logger?.info("acp.memoryRewrite", {
      sessionId: this.sessionId,
      inLen: rawText.length,
      outLen: rewritten.length,
    });
    return { rewritten };
  }

  /**
   * 杀后台任务 / monitor：对齐 CLI pager `x.ai/task/kill`
   *（KillTaskRequest: sessionId + taskId）。
   */
  async killTask(taskId: string): Promise<{
    taskId: string;
    outcome: string;
    raw?: unknown;
  }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const id = taskId.trim();
    if (!id) {
      throw new HostError("INVALID_ARGUMENT", "taskId is required");
    }
    const raw = (await this.extMethod(
      "_x.ai/task/kill",
      {
        sessionId: this.sessionId,
        taskId: id,
        // 兼容 snake_case 解析器
        session_id: this.sessionId,
        task_id: id,
      },
      30_000,
    )) as Record<string, unknown>;
    const nested =
      raw?.result && typeof raw.result === "object"
        ? (raw.result as Record<string, unknown>)
        : raw;
    const outcome =
      typeof nested?.outcome === "string"
        ? nested.outcome
        : nested?.outcome != null
          ? String(nested.outcome)
          : typeof nested?.status === "string"
            ? nested.status
            : "killed";
    this.opts.logger?.info("acp.killTask", {
      sessionId: this.sessionId,
      taskId: id,
      outcome,
    });
    return {
      taskId: String(nested?.taskId ?? nested?.task_id ?? id),
      outcome,
      raw,
    };
  }

  /**
   * 真压缩：对齐 CLI `_x.ai/compact_conversation`（Shell CompactSession 管道）。
   * 可选 userContext 作为「保留说明」传入 two-pass 压缩。
   */
  async compactConversation(userContext?: string): Promise<void> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const params: Record<string, unknown> = {
      sessionId: this.sessionId,
    };
    const ctx = userContext?.trim();
    if (ctx) {
      params.userContext = ctx;
      params.user_context = ctx;
    }
    // 压缩可能触发 LLM 双 pass，超时放宽
    await this.extMethod("_x.ai/compact_conversation", params, 300_000);
    this.opts.logger?.info("acp.compactConversation", {
      sessionId: this.sessionId,
      hasUserContext: Boolean(ctx),
    });
  }

  /**
   * `/btw` 旁路侧问：`_x.ai/btw`。
   * 不打断当前 turn、不进主对话；同步返回 answer（可能较慢，超时放宽）。
   */
  async sideQuestion(question: string): Promise<string> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const q = question.trim();
    if (!q) {
      throw new HostError("INVALID_ARGUMENT", "btw question is empty");
    }
    const raw = (await this.extMethod(
      "_x.ai/btw",
      { sessionId: this.sessionId, question: q },
      300_000,
    )) as Record<string, unknown>;
    // 兼容 { answer } / { result: { answer } } / 纯字符串
    const nested =
      raw.result && typeof raw.result === "object"
        ? (raw.result as Record<string, unknown>)
        : raw;
    const answer =
      (typeof nested.answer === "string" && nested.answer) ||
      (typeof raw.answer === "string" && raw.answer) ||
      (typeof nested.response === "string" && nested.response) ||
      null;
    if (answer != null) return answer;
    if (typeof raw === "string") return raw;
    this.opts.logger?.warn("acp.btw_unexpected_shape", {
      keys: Object.keys(raw ?? {}),
    });
    return JSON.stringify(raw);
  }

  /**
   * 中途插话：`_x.ai/interject`。
   * 插入当前 turn 的 pending interjection 缓冲；不取消 turn。
   */
  async interject(
    text: string,
    opts?: { interjectionId?: string },
  ): Promise<{ status: string; interjectionId: string }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const t = text.trim();
    if (!t) {
      throw new HostError("INVALID_ARGUMENT", "interject text is empty");
    }
    const interjectionId =
      opts?.interjectionId?.trim() ||
      `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const raw = (await this.extMethod(
      "_x.ai/interject",
      {
        sessionId: this.sessionId,
        text: t,
        interjectionId,
      },
      30_000,
    )) as Record<string, unknown>;
    const nested =
      raw?.result && typeof raw.result === "object"
        ? (raw.result as Record<string, unknown>)
        : raw;
    const status =
      (typeof nested?.status === "string" && nested.status) ||
      (typeof raw?.status === "string" && raw.status) ||
      "queued";
    return { status, interjectionId };
  }

  /**
   * 会话信息 + ContextInfo 明细：`_x.ai/session/info`。
   * 对齐 CLI /session-info、/context、/status。
   */
  async sessionInfo(): Promise<{
    sessionId: string;
    cwd?: string;
    agentName?: string;
    model?: string;
    modelDisplayName?: string;
    resolvedModelId?: string;
    modelFingerprint?: string;
    showModelFingerprint?: boolean;
    apiBackend?: string;
    conversationId?: string;
    turns: number;
    turnIndex: number;
    context: {
      used: number;
      total: number;
      systemPromptTokens: number;
      toolDefinitionsCount: number;
      toolDefinitionsTokens: number;
      compactionCount: number;
      turnCount: number;
      toolCallCount: number;
      messageCount: number;
      messageTokens: number;
      freeTokens: number;
      usagePct: number;
      autoCompactThresholdPercent: number;
      usageCategories: Array<{
        label: string;
        tokens: number;
        detail?: string;
      }>;
    };
  }> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const raw = (await this.extMethod(
      "_x.ai/session/info",
      { sessionId: this.sessionId },
      30_000,
    )) as Record<string, unknown>;

    const data =
      raw.data && typeof raw.data === "object"
        ? (raw.data as Record<string, unknown>)
        : raw;
    const ctxRaw =
      (data.context as Record<string, unknown> | undefined) ??
      (raw.context as Record<string, unknown> | undefined) ??
      {};

    const n = (v: unknown): number => {
      if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
        return Math.max(0, Number(v));
      }
      return 0;
    };
    const s = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v : undefined;

    const catsRaw = (ctxRaw.usageCategories ??
      ctxRaw.usage_categories ??
      []) as Array<Record<string, unknown>>;

    return {
      sessionId: s(raw.sessionId ?? raw.session_id ?? data.sessionId) ?? this.sessionId,
      cwd: s(raw.cwd ?? data.cwd),
      agentName: s(data.agentName ?? data.agent_name),
      model: s(data.model),
      modelDisplayName: s(data.modelDisplayName ?? data.model_display_name),
      resolvedModelId: s(data.resolvedModelId ?? data.resolved_model_id),
      modelFingerprint: s(data.modelFingerprint ?? data.model_fingerprint),
      showModelFingerprint: Boolean(
        data.showModelFingerprint ?? data.show_model_fingerprint,
      ),
      apiBackend: s(data.apiBackend ?? data.api_backend),
      conversationId: s(data.conversationId ?? data.conversation_id),
      turns: n(data.turns),
      turnIndex: n(data.turnIndex ?? data.turn_index),
      context: {
        used: n(ctxRaw.used),
        total: n(ctxRaw.total),
        systemPromptTokens: n(
          ctxRaw.systemPromptTokens ?? ctxRaw.system_prompt_tokens,
        ),
        toolDefinitionsCount: n(
          ctxRaw.toolDefinitionsCount ?? ctxRaw.tool_definitions_count,
        ),
        toolDefinitionsTokens: n(
          ctxRaw.toolDefinitionsTokens ?? ctxRaw.tool_definitions_tokens,
        ),
        compactionCount: n(
          ctxRaw.compactionCount ?? ctxRaw.compaction_count,
        ),
        turnCount: n(ctxRaw.turnCount ?? ctxRaw.turn_count),
        toolCallCount: n(ctxRaw.toolCallCount ?? ctxRaw.tool_call_count),
        messageCount: n(ctxRaw.messageCount ?? ctxRaw.message_count),
        messageTokens: n(ctxRaw.messageTokens ?? ctxRaw.message_tokens),
        freeTokens: n(ctxRaw.freeTokens ?? ctxRaw.free_tokens),
        usagePct: n(ctxRaw.usagePct ?? ctxRaw.usage_pct),
        autoCompactThresholdPercent: n(
          ctxRaw.autoCompactThresholdPercent ??
            ctxRaw.auto_compact_threshold_percent ??
            85,
        ),
        usageCategories: catsRaw.map((c) => ({
          label: String(c.label ?? ""),
          tokens: n(c.tokens),
          detail: s(c.detail),
        })),
      },
    };
  }

  /**
   * 会话中途切换模型 / 推理力度（对齐 CLI `/model` `/effort`）。
   * wire 方法名：当前 grok agent 认 `session/set_model`（snake）；
   * 部分文档/leader 测试写 `session/setModel`（camel）— 失败时回退尝试。
   * params: { sessionId, modelId, _meta?: { reasoningEffort } }
   */
  async setModel(
    modelId: string,
    opts?: { effort?: string },
  ): Promise<void> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const id = modelId.trim();
    if (!id) {
      throw new HostError("INVALID_ARGUMENT", "modelId is required");
    }
    const params: Record<string, unknown> = {
      sessionId: this.sessionId,
      modelId: id,
    };
    const effort = (opts?.effort ?? "").toString().trim().toLowerCase();
    if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
      params._meta = { reasoningEffort: effort };
    }
    // 实测 grok 0.2.x：session/set_model 可用；session/setModel → Method not found
    const methods = ["session/set_model", "session/setModel"] as const;
    let lastErr: unknown;
    for (const method of methods) {
      try {
        await this.request(method, params, 30_000);
        this.opts.logger?.info("acp.setModel", {
          sessionId: this.sessionId,
          modelId: id,
          effort: effort || undefined,
          method,
        });
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/method not found/i.test(msg)) throw err;
        this.opts.logger?.warn("acp.setModel_method_fallback", {
          method,
          msg,
        });
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new HostError("INTERNAL", String(lastErr));
  }

  /** 是否有未决 permission（含精确 requestId 或任意一个） */
  hasPermission(requestId?: string): boolean {
    if (requestId) return this.permissionWaiters.has(requestId);
    return this.permissionWaiters.size > 0;
  }

  respondPermission(
    requestId: string,
    decision: PermissionDecisionWire,
  ): void {
    const waiter = this.permissionWaiters.get(requestId);
    if (!waiter) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `Unknown permission requestId: ${requestId}`,
      );
    }
    this.permissionWaiters.delete(requestId);
    // 必须回 agent 给出的 optionId（allow-once 等），禁止写死 allow_once
    const optionId = resolvePermissionOptionId(decision, waiter.options);
    this.opts.logger?.info("acp.permission_option_resolved", {
      requestId,
      decision,
      optionId,
      optionCount: waiter.options.length,
    });
    waiter.resolve(optionId);
  }

  hasAskUser(requestId?: string): boolean {
    if (requestId) return this.askUserWaiters.has(requestId);
    return this.askUserWaiters.size > 0;
  }

  /**
   * UI 回答 ask_user_question。
   * accepted: answers 为 question text → 所选 label[]。
   */
  respondAskUser(
    requestId: string,
    resp: {
      outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
      answers?: Record<string, string[]>;
      partialAnswers?: Record<string, string>;
    },
  ): void {
    const waiter = this.askUserWaiters.get(requestId);
    if (!waiter) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `Unknown ask_user requestId: ${requestId}`,
      );
    }
    this.askUserWaiters.delete(requestId);
    waiter.resolve(resp);
  }

  /**
   * 会话模式切换（对齐 CLI /plan · Shift+Tab）。
   * ACP: session/set_mode { sessionId, modeId: "plan" | "default" | "ask" }
   */
  async setSessionMode(modeId: "plan" | "default" | "ask"): Promise<void> {
    if (!this.sessionId) {
      throw new HostError("NOT_ATTACHED", "No ACP session attached");
    }
    const params = {
      sessionId: this.sessionId,
      modeId,
    };
    const methods = ["session/set_mode", "session/setMode"] as const;
    let lastErr: unknown;
    for (const method of methods) {
      try {
        await this.request(method, params, 20_000);
        this.opts.logger?.info("acp.setSessionMode", {
          sessionId: this.sessionId,
          modeId,
          method,
        });
        this.opts.onEvent({
          type: "plan.mode.changed",
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          modeId,
          active: modeId === "plan",
        });
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/method not found/i.test(msg)) throw err;
        this.opts.logger?.warn("acp.setSessionMode_fallback", { method, msg });
      }
    }
    // 回退：ext 通知 toggle（仅翻转，无绝对 mode）
    if (modeId === "plan" || modeId === "default") {
      try {
        this.notify("x.ai/toggle_plan_mode", {
          sessionId: this.sessionId,
        });
        this.opts.onEvent({
          type: "plan.mode.changed",
          threadId: this.opts.threadId,
          sessionId: this.sessionId,
          modeId,
          active: modeId === "plan",
        });
        return;
      } catch {
        /* fall through */
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new HostError("INTERNAL", String(lastErr));
  }

  /** 是否有未决 plan 审批（含精确 requestId 或任意一个） */
  hasPlanApproval(requestId?: string): boolean {
    if (requestId) return this.planApprovalWaiters.has(requestId);
    return this.planApprovalWaiters.size > 0;
  }

  /** 响应用户对 exit_plan_mode 的审批 */
  respondPlanApproval(
    requestId: string,
    outcome: "approved" | "cancelled" | "abandoned",
    feedback?: string,
  ): void {
    let waiter = this.planApprovalWaiters.get(requestId);
    let resolvedId = requestId;
    // 容错：requestId 对不上时，若仅有一个未决审批则认领
    if (!waiter && this.planApprovalWaiters.size === 1) {
      const only = this.planApprovalWaiters.entries().next().value as
        | [string, { resolve: (r: {
            outcome: "approved" | "cancelled" | "abandoned";
            feedback?: string;
          }) => void }]
        | undefined;
      if (only) {
        resolvedId = only[0];
        waiter = only[1];
        this.opts.logger?.warn("acp.plan_approval_id_fallback", {
          wanted: requestId,
          used: resolvedId,
        });
      }
    }
    if (!waiter) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `Unknown plan approval requestId: ${requestId}`,
      );
    }
    this.planApprovalWaiters.delete(resolvedId);
    waiter.resolve({
      outcome,
      feedback: feedback?.trim() || undefined,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new HostError("AGENT_CRASHED", "ACP client closed"));
    this.rl?.close();
    this.rl = null;
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
  }

  private failAll(err: Error): void {
    for (const [, meta] of this.pendingTimers) {
      clearTimeout(meta.timer);
    }
    this.pendingTimers.clear();
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    // 未决 plan 审批：放弃
    for (const [id, w] of this.planApprovalWaiters) {
      w.resolve({ outcome: "abandoned" });
      this.planApprovalWaiters.delete(id);
    }
    // 未决权限：回 reject，避免 agent 永久挂起
    for (const [id, w] of this.permissionWaiters) {
      const rejectId = resolvePermissionOptionId("deny", w.options);
      w.resolve(rejectId);
      this.permissionWaiters.delete(id);
    }
    // 未决 ask_user：取消
    for (const [id, w] of this.askUserWaiters) {
      w.resolve({ outcome: "cancelled" });
      this.askUserWaiters.delete(id);
    }
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /**
   * @param timeout
   *   number = fixed wall-clock ms (legacy)
   *   object = idle-reset timeout (resets on any ACP line while pending)
   * @param opts.trackAsPrompt — mark RPC as active session/prompt for cancel()
   * @param opts.acceptStreamGeneration — after write, accept stream only for this gen
   */
  private request(
    method: string,
    params: unknown,
    timeout: number | { idleMs?: number; maxMs?: number } = 120_000,
    opts?: { trackAsPrompt?: boolean; acceptStreamGeneration?: number },
  ): Promise<unknown> {
    const id = this.nextId++;
    const idleMs =
      typeof timeout === "number"
        ? timeout
        : Math.max(5_000, Number(timeout?.idleMs) || 120_000);
    const maxMs =
      typeof timeout === "number"
        ? timeout
        : Math.max(idleMs, Number(timeout?.maxMs) || idleMs);
    const startedAt = Date.now();
    if (opts?.trackAsPrompt) {
      this.activePromptRpcId = id;
    }
    return new Promise((resolve, reject) => {
      const fire = () => {
        const entry = this.pendingTimers.get(id);
        if (entry) clearTimeout(entry.timer);
        this.pendingTimers.delete(id);
        this.pending.delete(id);
        if (this.activePromptRpcId === id) this.activePromptRpcId = null;
        if (
          opts?.acceptStreamGeneration != null &&
          this.streamAcceptGeneration === opts.acceptStreamGeneration
        ) {
          this.streamAcceptGeneration = 0;
        }
        reject(
          new HostError(
            "TIMEOUT",
            `ACP request timed out: ${method} (idle ${Math.round(idleMs / 1000)}s / max ${Math.round(maxMs / 1000)}s)`,
          ),
        );
      };
      const arm = () => {
        const prev = this.pendingTimers.get(id);
        if (prev) clearTimeout(prev.timer);
        const elapsed = Date.now() - startedAt;
        const remainingMax = Math.max(0, maxMs - elapsed);
        const wait = Math.min(idleMs, remainingMax || idleMs);
        if (remainingMax <= 0) {
          fire();
          return;
        }
        const timer = setTimeout(fire, wait);
        this.pendingTimers.set(id, { idleMs, maxMs, startedAt, timer, fire });
      };
      arm();
      this.pending.set(id, {
        resolve: (v) => {
          const entry = this.pendingTimers.get(id);
          if (entry) clearTimeout(entry.timer);
          this.pendingTimers.delete(id);
          if (this.activePromptRpcId === id) this.activePromptRpcId = null;
          if (
            opts?.acceptStreamGeneration != null &&
            this.streamAcceptGeneration === opts.acceptStreamGeneration
          ) {
            this.streamAcceptGeneration = 0;
          }
          resolve(v);
        },
        reject: (e) => {
          const entry = this.pendingTimers.get(id);
          if (entry) clearTimeout(entry.timer);
          this.pendingTimers.delete(id);
          if (this.activePromptRpcId === id) this.activePromptRpcId = null;
          if (
            opts?.acceptStreamGeneration != null &&
            this.streamAcceptGeneration === opts.acceptStreamGeneration
          ) {
            this.streamAcceptGeneration = 0;
          }
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
      // After write: brief settle then open gate. Isolation is generation-only;
      // never wait for stream quiet (that hung UI on 思考中 after cancel→新问题).
      if (
        opts?.acceptStreamGeneration != null &&
        opts.acceptStreamGeneration > 0
      ) {
        const gen = opts.acceptStreamGeneration;
        this.streamAcceptGeneration = 0;
        this.promptWireAtMs = Date.now();
        const afterRecentCancel =
          this.lastCancelAtMs > 0 &&
          Date.now() - this.lastCancelAtMs < 8_000;
        // Generation mismatch already drops T1. Only brief settle after cancel
        // so residual frames stay behind the closed gate; 0ms otherwise so
        // first thought/message chunks are not lost (fake + real agent).
        const minSettleMs = afterRecentCancel ? 100 : 0;
        const openGate = () => {
          if (
            this.turnCancelled ||
            this.activePromptGeneration !== gen ||
            this.activePromptRpcId !== id
          ) {
            return;
          }
          this.openStreamGate(gen);
        };
        if (minSettleMs <= 0) openGate();
        else setTimeout(openGate, minSettleMs);
      }
    });
  }

  /** Reset idle countdown for all pending RPCs (agent still producing traffic). */
  private touchPendingActivity(): void {
    for (const [id, meta] of this.pendingTimers) {
      const elapsed = Date.now() - meta.startedAt;
      const remainingMax = Math.max(0, meta.maxMs - elapsed);
      if (remainingMax <= 0) {
        clearTimeout(meta.timer);
        this.pendingTimers.delete(id);
        meta.fire();
        continue;
      }
      clearTimeout(meta.timer);
      const wait = Math.min(meta.idleMs, remainingMax);
      meta.timer = setTimeout(meta.fire, wait);
      this.pendingTimers.set(id, meta);
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: JsonRpcId, message: string): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    });
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin.writable) {
      throw new HostError("AGENT_CRASHED", "Agent stdin not writable");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Any stdout traffic means the agent is alive — reset idle timeouts.
    this.touchPendingActivity();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.opts.logger?.warn("acp.bad_json", { line: trimmed.slice(0, 200) });
      return;
    }

    if ("id" in msg && (msg.result !== undefined || msg.error !== undefined)) {
      const id = msg.id as JsonRpcId;
      const pending = this.pending.get(id);
      // Late response after cancel() already rejected the prompt — ignore
      if (!pending) return;
      this.pending.delete(id);
      if (msg.error) {
        const err = msg.error as {
          message?: string;
          data?: unknown;
          code?: number | string;
        };
        // Agent 常把真实原因塞进 data / message 内嵌 JSON，勿只留下 "Internal error"
        const rich = enrichAcpErrorMessage(err.message, err.data ?? msg.error);
        // 透传 data（如 MODEL_SWITCH_INCOMPATIBLE_AGENT），供 UI 对齐 CLI 新会话确认
        pending.reject(
          new HostError(
            "INTERNAL",
            rich,
            err.data !== undefined
              ? { code: err.code, message: err.message, data: err.data }
              : msg.error,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    if (!method) return;

    // session/update + _x.ai/* 扩展（goal_updated 常走 _x.ai/session/update）
    if (
      method === "session/update" ||
      method === "_x.ai/session/update" ||
      method.endsWith("/session/update")
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? params) as Record<string, unknown>;
      const sid = (params.sessionId as string) ?? this.sessionId ?? "unknown";
      for (const ev of normalizeSessionUpdate(this.opts.threadId, sid, update)) {
        // Stream/tool only while the *current* prompt is on the wire.
        // activePromptRpcId alone is NOT enough: after T1 cancel + T2 prompt,
        // leftover T1 session/update still arrives and would glue into T2.
        // streamAcceptGeneration is set only after session/prompt is written,
        // and cleared on cancel / prompt settle.
        const isStreamOrTool =
          ev.type === "message.delta" ||
          ev.type === "thought.delta" ||
          ev.type === "tool.started" ||
          ev.type === "tool.completed";
        if (isStreamOrTool) {
          this.lastStreamAtMs = Date.now();
          // Track tool ids seen while gate closed — residual T1 tools
          if (
            (ev.type === "tool.started" || ev.type === "tool.completed") &&
            (this.streamAcceptGeneration === 0 ||
              this.turnCancelled ||
              this.streamAcceptGeneration !== this.activePromptGeneration)
          ) {
            const tid = String(
              (ev as { toolCallId?: string }).toolCallId ?? "",
            ).trim();
            if (tid) this.residualToolCallIds.add(tid);
          }

          // Generation gate only (CLI-aligned). No content poison/quarantine.
          const accept =
            !this.turnCancelled &&
            this.activePromptRpcId != null &&
            this.streamAcceptGeneration > 0 &&
            this.streamAcceptGeneration === this.activePromptGeneration &&
            this.promptWireAtMs > 0 &&
            Date.now() >= this.promptWireAtMs;
          if (!accept) {
            continue;
          }
          // Drop residual tool lifecycle even after gate open
          if (ev.type === "tool.started" || ev.type === "tool.completed") {
            const tid = String(
              (ev as { toolCallId?: string }).toolCallId ?? "",
            ).trim();
            if (tid && this.residualToolCallIds.has(tid)) {
              if (ev.type === "tool.completed") this.residualToolCallIds.delete(tid);
              continue;
            }
          }
        }
        if (ev.type === "message.delta" && ev.role === "assistant") {
          this.streamedAssistantThisTurn = true;
        }
        if (ev.type === "tool.started" || ev.type === "tool.completed") {
          this.hadToolActivityThisTurn = true;
        }
        if (ev.type === "tool.completed" && ev.status === "failed") {
          this.hadToolFailuresThisTurn = true;
          const failMsg = extractToolFailureMessage(ev.raw, ev.name);
          if (failMsg) this.lastToolFailureThisTurn = failMsg;
        }
        this.opts.onEvent(ev);
      }
      return;
    }

    // auto-compact / subagent / 后台任务：x.ai/session_notification
    // 以及专用扩展：x.ai/task_backgrounded|task_completed|monitor_event
    if (
      method === "x.ai/session_notification" ||
      method === "_x.ai/session_notification" ||
      method.endsWith("/session_notification") ||
      method === "x.ai/task_backgrounded" ||
      method === "_x.ai/task_backgrounded" ||
      method.endsWith("/task_backgrounded") ||
      method === "x.ai/task_completed" ||
      method === "_x.ai/task_completed" ||
      method.endsWith("/task_completed") ||
      method === "x.ai/monitor_event" ||
      method === "_x.ai/monitor_event" ||
      method.endsWith("/monitor_event")
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sid =
        (params.sessionId as string) ??
        (params.session_id as string) ??
        this.sessionId ??
        "unknown";
      // 专用 method 的 params 常为 SessionNotification 信封 { sessionId, update }
      const update = (params.update ?? params) as Record<string, unknown>;
      // 若 method 暗示类型而 update 缺 sessionUpdate，补上（兼容扁平 payload）
      if (
        !update.sessionUpdate &&
        !update.session_update &&
        !update.type
      ) {
        if (method.endsWith("task_backgrounded")) {
          (update as { sessionUpdate?: string }).sessionUpdate =
            "task_backgrounded";
        } else if (method.endsWith("task_completed")) {
          (update as { sessionUpdate?: string }).sessionUpdate =
            "task_completed";
        } else if (method.endsWith("monitor_event")) {
          (update as { sessionUpdate?: string }).sessionUpdate =
            "monitor_event";
        }
      }
      for (const ev of normalizeSessionNotification(
        this.opts.threadId,
        sid,
        update,
      )) {
        this.opts.onEvent(ev);
      }
      return;
    }

    if (
      method === "session/request_permission" ||
      method === "request_permission"
    ) {
      void this.handlePermissionRequest(msg);
      return;
    }

    // Plan 审批：shell → client reverse request
    if (
      method === "x.ai/exit_plan_mode" ||
      method === "exit_plan_mode" ||
      method.endsWith("/exit_plan_mode")
    ) {
      void this.handleExitPlanMode(msg);
      return;
    }

    // 用户选择题：shell → client reverse request
    if (
      method === "x.ai/ask_user_question" ||
      method === "_x.ai/ask_user_question" ||
      method === "ask_user_question" ||
      method.endsWith("/ask_user_question")
    ) {
      void this.handleAskUserQuestion(msg);
      return;
    }

    if (method === "fs/read_text_file" || method === "read_text_file") {
      void this.handleReadTextFile(msg);
      return;
    }

    if ("id" in msg) {
      this.respondError(msg.id as JsonRpcId, `Unsupported method: ${method}`);
    }
  }

  private async handleExitPlanMode(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as JsonRpcId;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const requestId = `plan_${this.opts.threadId}_${String(id)}`;
    const sid =
      (params.sessionId as string) ??
      this.sessionId ??
      "unknown";
    const planContent =
      (params.planContent as string | undefined) ??
      (params.plan_content as string | undefined) ??
      null;
    const toolCallId =
      (params.toolCallId as string | undefined) ??
      (params.tool_call_id as string | undefined);

    // 先登记 waiter 再发事件，避免同步自动响应路径找不到 requestId
    const decisionPromise = new Promise<{
      outcome: "approved" | "cancelled" | "abandoned";
      feedback?: string;
    }>((resolve) => {
      this.planApprovalWaiters.set(requestId, { resolve });
    });

    this.opts.onEvent({
      type: "plan.approval.requested",
      threadId: this.opts.threadId,
      sessionId: sid,
      requestId,
      toolCallId,
      planContent,
      raw: params,
    });
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: sid,
      status: "needs_input",
    });

    const decision = await decisionPromise;

    // camelCase wire（对齐 ExitPlanModeExtResponse：outcome + optional feedback）
    try {
      this.respond(id, {
        outcome: decision.outcome,
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      });
      this.opts.logger?.info("acp.exit_plan_mode_responded", {
        requestId,
        outcome: decision.outcome,
        hasFeedback: Boolean(decision.feedback),
      });
      this.opts.onEvent({
        type: "session.status",
        threadId: this.opts.threadId,
        sessionId: sid,
        status: "working",
      });
    } catch (err) {
      this.opts.logger?.warn("acp.exit_plan_mode_respond_failed", {
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async handlePermissionRequest(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const id = msg.id as JsonRpcId;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const requestId = `perm_${this.opts.threadId}_${String(id)}`;
    const sid = this.sessionId ?? (params.sessionId as string) ?? "unknown";

    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const summary =
      (params.description as string) ??
      (toolCall?.title as string) ??
      (toolCall?.kind as string) ??
      JSON.stringify(params).slice(0, 200);

    const options = extractPermissionOptions(params);

    // 必须先登记 waiter，再发 permission.requested：
    // Host YOLO 在 onEvent 同步路径里 respondPermission，否则会 Unknown requestId 挂死 turn。
    const optionIdPromise = new Promise<string>((resolve) => {
      this.permissionWaiters.set(requestId, { resolve, options });
    });

    this.opts.onEvent({
      type: "permission.requested",
      threadId: this.opts.threadId,
      sessionId: sid,
      requestId,
      summary,
      options: options.map((o) => ({
        optionId: o.optionId ?? o.option_id ?? o.id ?? "",
        name: o.name ?? o.label,
        kind: o.kind,
      })),
      raw: params,
    });
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: sid,
      status: "needs_input",
    });

    const optionId = await optionIdPromise;

    this.respond(id, {
      outcome: { outcome: "selected", optionId },
      selectedOption: optionId,
    });
  }

  /**
   * `_x.ai/ask_user_question` / `x.ai/ask_user_question`
   * 协议见 grok-build AskUserQuestionExtRequest/Response。
   */
  private async handleAskUserQuestion(
    msg: Record<string, unknown>,
  ): Promise<void> {
    const id = msg.id as JsonRpcId;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    // 部分 wire 把载荷包在 params 字符串 / params.params 里
    let body: Record<string, unknown> = params;
    if (typeof params.params === "string") {
      try {
        body = JSON.parse(params.params) as Record<string, unknown>;
      } catch {
        body = params;
      }
    } else if (params.params && typeof params.params === "object") {
      body = params.params as Record<string, unknown>;
    }

    const requestId = `ask_${this.opts.threadId}_${String(id)}`;
    const sid =
      (body.sessionId as string) ??
      (body.session_id as string) ??
      this.sessionId ??
      "unknown";
    const toolCallId =
      (body.toolCallId as string) ??
      (body.tool_call_id as string) ??
      undefined;
    const modeRaw = String(body.mode ?? "default").toLowerCase();
    const mode = modeRaw === "plan" ? "plan" : "default";
    const questionsRaw = Array.isArray(body.questions) ? body.questions : [];
    const questions = questionsRaw
      .filter((q) => q && typeof q === "object")
      .map((q) => {
        const qq = q as Record<string, unknown>;
        const opts = Array.isArray(qq.options) ? qq.options : [];
        return {
          question: String(qq.question ?? ""),
          multiSelect: Boolean(qq.multiSelect ?? qq.multi_select),
          options: opts
            .filter((o) => o && typeof o === "object")
            .map((o) => {
              const oo = o as Record<string, unknown>;
              return {
                label: String(oo.label ?? ""),
                description: String(oo.description ?? ""),
                preview:
                  typeof oo.preview === "string" ? oo.preview : undefined,
              };
            }),
        };
      })
      .filter((q) => q.question);

    if (!questions.length) {
      // 无法展示：取消而非 error，避免工具红失败误导
      this.respond(id, { outcome: "cancelled" });
      return;
    }

    const decisionPromise = new Promise<{
      outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
      answers?: Record<string, string[]>;
      partialAnswers?: Record<string, string>;
    }>((resolve) => {
      this.askUserWaiters.set(requestId, { resolve });
    });

    this.opts.onEvent({
      type: "ask_user.requested",
      threadId: this.opts.threadId,
      sessionId: sid,
      requestId,
      toolCallId,
      mode,
      questions,
      raw: body,
    });
    this.opts.onEvent({
      type: "session.status",
      threadId: this.opts.threadId,
      sessionId: sid,
      status: "needs_input",
    });

    const decision = await decisionPromise;

    // camelCase wire：AskUserQuestionExtResponse
    let payload: Record<string, unknown>;
    if (decision.outcome === "accepted") {
      payload = {
        outcome: "accepted",
        answers: decision.answers ?? {},
      };
    } else if (decision.outcome === "chat_about_this") {
      payload = {
        outcome: "chat_about_this",
        partialAnswers: decision.partialAnswers ?? {},
      };
    } else if (decision.outcome === "skip_interview") {
      payload = {
        outcome: "skip_interview",
        partialAnswers: decision.partialAnswers ?? {},
      };
    } else {
      payload = { outcome: "cancelled" };
    }

    try {
      this.respond(id, payload);
      this.opts.logger?.info("acp.ask_user_responded", {
        requestId,
        outcome: decision.outcome,
      });
      this.opts.onEvent({
        type: "session.status",
        threadId: this.opts.threadId,
        sessionId: sid,
        status: "working",
      });
    } catch (err) {
      this.opts.logger?.warn("acp.ask_user_respond_failed", {
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async handleReadTextFile(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as JsonRpcId;
    if (!this.opts.allowFs) {
      this.respondError(id, "fs read not allowed");
      return;
    }
    try {
      const params = (msg.params ?? {}) as { path?: string };
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(params.path ?? "", "utf8");
      this.respond(id, { content });
    } catch (err) {
      this.respondError(id, err instanceof Error ? err.message : String(err));
    }
  }
}
