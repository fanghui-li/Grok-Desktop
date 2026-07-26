/**
 * 巨石拆出的纯模块契约：格式化 / effort / goal / dedupe / prompt history / session-mode。
 */
import { describe, expect, it } from "vitest";
import {
  assistantTextsRoughlyEqual,
  looksLikeGluedNewAssistantReply,
  normalizeAssistantForDedupe,
} from "../src/renderer/lib/assistant-dedupe.js";
import { effortOptions, parseEffort } from "../src/renderer/model/effort.js";
import {
  formatContextChipText,
  formatElapsedCompact,
  formatTokenK,
} from "../src/renderer/lib/format-utils.js";
import { looksLikeGoalProcessText } from "../src/renderer/goal/process.js";
import {
  goalPauseHintText,
  goalStatusKicker,
  parseGoalUiStatus,
} from "../src/renderer/goal/status.js";
import { PromptHistoryStore } from "../src/renderer/prompt-history-store.js";
import { formatTurnErrorMessage } from "../src/renderer/lib/turn-error-format.js";
import {
  deriveSessionMode,
  legacyModeToPatch,
} from "../src/host/session/mode.js";
import {
  computeModelMenuPosition,
  modelDisplayName,
  resolveChipModelFallback,
  shortModelName,
} from "../src/renderer/model/display.js";
import { mergeOptimisticContextFromCompact } from "../src/renderer/context/usage.js";
import {
  agentContentForSend,
  computeGoalElapsedMs,
  formatGoalElapsed,
  isGoalPausedStatus,
  parseGoalBudget,
  parseGoalInput,
} from "../src/renderer/goal/input.js";
import {
  attachmentKind,
  buildPromptWithAttachments,
  parseUserHistoryPayload,
  planAddAttachments,
} from "../src/renderer/composer/attachments.js";
import {
  extractPlanArtifactPath,
  isPlanDocumentBaseName,
  planPanelStatusBits,
  preferPlanContent,
  resolvePlanRailActivity,
  shouldKeepPlanDraft,
} from "../src/renderer/plan/artifact.js";
import { formatSessionInfoLines } from "../src/renderer/session/info-format.js";
import {
  mergeModelsCatalog,
  parseGrokModelsCliOutput,
} from "../src/host/models/catalog.js";
import { buildHistoryExportMarkdown } from "../src/host/history/export.js";
import {
  canScheduleQueueDrain,
  enqueueToastKey,
  newQueueItemId,
  normalizeQueueEditPatch,
  queueItemActionGate,
  swapAdjacentOrderedIds,
} from "../src/renderer/prompt-queue/logic.js";
import { parseInlineBtwOrInterject } from "../src/renderer/composer/inline.js";
import {
  buildThreadForest,
  flattenThreadForest,
  visibleThreadForest,
} from "../src/renderer/thread/forest.js";
import { formatUserMsgTime } from "../src/renderer/lib/format-utils.js";
import {
  eventBelongsToActiveSession,
  isTranscriptScopedEvent,
} from "../src/renderer/session/event-scope.js";
import { TranscriptEventHandlers } from "../src/renderer/session/transcript-handlers.js";
import {
  isSameOpenSession,
  paintHistoryEntries,
  resolveThreadIdAfterAttachState,
  sanitizePendingApprovalForSession,
  shouldKeepBackgroundWorking,
} from "../src/renderer/session/history-replay.js";
import {
  bindPlanProjectionForOpen,
  planOpenThreadLeave,
  shouldApplyAttachUiState,
  shouldForceBackgroundTurnActive,
} from "../src/renderer/session/open-thread-phases.js";
import {
  BusEventHandlers,
  isSessionBusyStatus,
  normalizeAppUpdateEvent,
  shouldDemoteLiveOnAttachState,
  shouldDropLiveEventOnWelcome,
} from "../src/renderer/session/bus-event-handlers.js";
import {
  isSubagentEventForActiveSession,
  isTaskEventForActiveSession,
  SubagentTaskEventHandlers,
  taskEventLabel,
} from "../src/renderer/tasks/event-handlers.js";
import {
  planStatusAfterRespond,
  respondAskUserAcrossClients,
  respondPermissionAcrossClients,
  respondPlanApprovalAcrossClients,
} from "../src/host/permission/respond.js";
import { PromptQueueService } from "../src/host/prompt-queue/service.js";
import { setLocale } from "../src/shared/i18n/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("format-utils", () => {
  it("formatTokenK scales", () => {
    expect(formatTokenK(500)).toBe("500");
    expect(formatTokenK(1500)).toMatch(/k$/i);
    expect(formatTokenK(2_500_000)).toMatch(/M$/);
  });

  it("formatContextChipText empty when unavailable", () => {
    expect(
      formatContextChipText({
        used: 1,
        total: 0,
        percent: 0,
        available: false,
      }),
    ).toBe("—");
  });

  it("formatElapsedCompact non-negative", () => {
    setLocale("en-US");
    const s = formatElapsedCompact(0);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("effort", () => {
  it("parseEffort accepts known levels", () => {
    expect(parseEffort("high")).toBe("high");
    expect(parseEffort("XHIGH")).toBe("xhigh");
    expect(parseEffort("nope")).toBeNull();
  });

  it("effortOptions has four levels", () => {
    setLocale("en-US");
    expect(effortOptions().map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("goal-process / goal-status", () => {
  it("looksLikeGoalProcessText detects verifier jargon", () => {
    expect(looksLikeGoalProcessText("Not Refuted: objective ok")).toBe(true);
    expect(looksLikeGoalProcessText("你好，请帮我写代码")).toBe(false);
  });

  it("parseGoalUiStatus maps aliases", () => {
    expect(parseGoalUiStatus("paused")).toBe("user_paused");
    expect(parseGoalUiStatus("completed")).toBe("complete");
    expect(parseGoalUiStatus("cancelled")).toBe("cleared");
  });

  it("goalStatusKicker respects verifying context", () => {
    setLocale("en-US");
    const plain = goalStatusKicker("active");
    const verifying = goalStatusKicker("active", {
      verifyingCompletion: true,
    });
    expect(verifying).not.toBe(plain);
    expect(goalPauseHintText("blocked").length).toBeGreaterThan(0);
  });
});

describe("assistant-dedupe", () => {
  it("normalize + roughly equal", () => {
    expect(normalizeAssistantForDedupe("Hello **World**")).toBe("hello world");
    expect(
      assistantTextsRoughlyEqual(
        "这是一段足够长的回复内容用来测试去重逻辑是否生效。",
        "这是一段足够长的回复内容用来测试去重逻辑是否生效！",
      ),
    ).toBe(true);
  });

  it("looksLikeGluedNewAssistantReply detects restart", () => {
    // 阈值：chunk 长度须 >32（短增量视为正常 token）；prev 像已收尾
    const prev =
      "苹果是一种水果，常见于温带地区，营养丰富，口感清脆香甜，很多人喜欢生吃。";
    const chunk =
      "你好，螺蛳粉是广西柳州的特色小吃，味道鲜辣，汤底浓郁，配上花生和酸笋特别下饭。";
    expect(looksLikeGluedNewAssistantReply(prev, chunk)).toBe(true);
    expect(looksLikeGluedNewAssistantReply(prev, " 继续补充一句。")).toBe(
      false,
    );
  });
});

describe("prompt-history-store", () => {
  it("record / browse / filter", () => {
    const s = new PromptHistoryStore(5);
    s.record("first");
    s.record("second");
    s.record("/status"); // pure slash skipped
    expect(s.length).toBe(2);
    expect(s.list()[0]).toBe("second");

    const up = s.browseUp("draft");
    expect(up).toBe("second");
    expect(s.isBrowsing).toBe(true);
    const up2 = s.browseUp("draft");
    expect(up2).toBe("first");
    const down = s.browseDown();
    expect(down).toBe("second");
    const exit = s.browseDown();
    expect(exit).toBe("draft");
    expect(s.isBrowsing).toBe(false);

    expect(s.filter("fir")).toEqual(["first"]);
  });

  it("seedFromUserTexts newest first", () => {
    const s = new PromptHistoryStore();
    s.seedFromUserTexts(["a", "b", "c"]);
    expect([...s.list()]).toEqual(["c", "b", "a"]);
  });
});

describe("turn-error-format", () => {
  it("unwraps nested ACP shell", () => {
    setLocale("en-US");
    const msg = formatTurnErrorMessage("Internal error", {
      data: { message: "provider rate limited 429" },
    });
    expect(msg.toLowerCase()).toMatch(/rate|429|provider|error|app/i);
  });
});

describe("session-mode", () => {
  it("deriveSessionMode prefers plan", () => {
    expect(deriveSessionMode("normal", true)).toBe("plan");
    expect(deriveSessionMode("always_approve", false)).toBe("always_approve");
  });

  it("legacyModeToPatch maps three-state", () => {
    expect(legacyModeToPatch("plan")).toEqual({
      alwaysApprove: false,
      plan: true,
    });
    expect(legacyModeToPatch("always_approve")).toEqual({
      alwaysApprove: true,
      plan: false,
    });
    expect(legacyModeToPatch("normal")).toEqual({
      alwaysApprove: false,
      plan: false,
    });
  });
});

describe("event-scope", () => {
  it("isTranscriptScopedEvent covers turn stream types", () => {
    expect(isTranscriptScopedEvent({ type: "message.delta" })).toBe(true);
    expect(isTranscriptScopedEvent({ type: "turn.completed" })).toBe(true);
    expect(isTranscriptScopedEvent({ type: "shell.navigate" })).toBe(false);
  });

  it("eventBelongsToActiveSession prefers sessionId", () => {
    expect(
      eventBelongsToActiveSession(
        { sessionId: "s1" },
        { activeSessionId: "s1", activeThreadId: "t1" },
      ),
    ).toBe(true);
    expect(
      eventBelongsToActiveSession(
        { sessionId: "s2" },
        { activeSessionId: "s1", activeThreadId: "t1" },
      ),
    ).toBe(false);
    expect(
      eventBelongsToActiveSession(
        { threadId: "t1" },
        { activeSessionId: "s1", activeThreadId: "disk_s1" },
      ),
    ).toBe(false);
  });
});

describe("transcript-handlers", () => {
  function stubDeps(
    overrides: Partial<ConstructorParameters<typeof TranscriptEventHandlers>[0]> = {},
  ) {
    const calls: string[] = [];
    const deps = {
      showWelcome: () => calls.push("showWelcome"),
      appendLine: (t: string, role: string) =>
        calls.push(`appendLine:${role}:${t.slice(0, 20)}`),
      appendThoughtDelta: () => calls.push("thought"),
      appendProcessText: () => calls.push("process"),
      beginTurn: () => calls.push("beginTurn"),
      endTurn: (opts?: { outcome?: string }) =>
        calls.push(`endTurn:${opts?.outcome ?? "default"}`),
      armTurnForLiveStream: () => calls.push("arm"),
      setTurnStatus: () => calls.push("status"),
      endStreamBubble: () => calls.push("endStream"),
      markToolStarted: () => calls.push("toolStart"),
      markToolCompleted: () => calls.push("toolDone"),
      markToolIncomplete: () => calls.push("toolFail"),
      maybeGoalFromToolRaw: () => {},
      notePlanArtifactFromTool: () => {},
      scheduleRefreshFileTree: () => {},
      showAskUserDialog: () => calls.push("askUser"),
      showPermission: () => calls.push("perm"),
      showTurnErrorOnce: () => calls.push("turnErr"),
      showAgentCrashBanner: () => calls.push("crash"),
      refreshContextAfterCompact: () => {},
      syncGoalFromAgent: () => {},
      refreshContextUsage: () => {},
      maybeSurfacePlanAfterTurn: () => calls.push("surfacePlan"),
      afterTurnSettled: () => calls.push("afterSettled"),
      markSessionWorking: () => {},
      setComposerBusy: () => {},
      demoteLiveThreadToDisk: () => calls.push("demote"),
      getTurnActive: () => true,
      isUserStopSuppressed: () => false,
      getTurnUiPhase: () => "working" as const,
      getAlreadyPaintedStopped: () => false,
      getAssistantStartedThisTurn: () => true,
      getBlockHistoryResyncAfterStop: () => false,
      getActiveSessionId: () => "s1",
      ...overrides,
    };
    return { handlers: new TranscriptEventHandlers(deps), calls };
  }

  it("handle returns false for unknown types", () => {
    const { handlers } = stubDeps();
    expect(handlers.handle({ type: "shell.navigate" })).toBe(false);
  });

  it("message.delta appends assistant stream; skips user role", () => {
    const { handlers, calls } = stubDeps();
    expect(handlers.handle({ type: "message.delta", role: "user", text: "u" })).toBe(
      true,
    );
    expect(calls.some((c) => c.startsWith("appendLine"))).toBe(false);
    expect(
      handlers.handle({
        type: "message.delta",
        role: "assistant",
        text: "hi",
      }),
    ).toBe(true);
    expect(calls).toContain("appendLine:assistant:hi");
  });

  it("permission.requested ends stream and shows permission", () => {
    const { handlers, calls } = stubDeps();
    expect(
      handlers.handle({
        type: "permission.requested",
        requestId: "r1",
        summary: "run rm",
      }),
    ).toBe(true);
    expect(calls).toContain("endStream");
    expect(calls).toContain("perm");
  });

  it("agent.error ends turn and demotes live thread", () => {
    const { handlers, calls } = stubDeps();
    expect(
      handlers.handle({ type: "agent.error", message: "boom" }),
    ).toBe(true);
    expect(calls).toContain("endTurn:default");
    expect(calls).toContain("demote");
    expect(calls).toContain("crash");
  });
});

describe("history-replay", () => {
  it("shouldKeepBackgroundWorking only when leaving a busy session", () => {
    expect(
      shouldKeepBackgroundWorking({
        sameSession: false,
        prevSessionId: "s1",
        wasActivelyTurning: true,
        isSidebarWorking: false,
        threadListedWorking: false,
      }),
    ).toBe(true);
    expect(
      shouldKeepBackgroundWorking({
        sameSession: true,
        prevSessionId: "s1",
        wasActivelyTurning: true,
        isSidebarWorking: true,
        threadListedWorking: true,
      }),
    ).toBe(false);
    expect(
      shouldKeepBackgroundWorking({
        sameSession: false,
        prevSessionId: null,
        wasActivelyTurning: true,
        isSidebarWorking: false,
        threadListedWorking: false,
      }),
    ).toBe(false);
  });

  it("isSameOpenSession / sanitizePending / resolveThreadId", () => {
    expect(
      isSameOpenSession({
        activeSessionId: "s1",
        activeThreadId: "t1",
        targetSessionId: "s1",
        targetThreadId: "t2",
      }),
    ).toBe(true);
    expect(
      isSameOpenSession({
        activeSessionId: "s1",
        activeThreadId: "t1",
        targetSessionId: "s2",
        targetThreadId: "t2",
      }),
    ).toBe(false);
    expect(
      sanitizePendingApprovalForSession(
        { requestId: "r", sessionId: "s1" },
        "s1",
      ),
    ).toEqual({ requestId: "r", sessionId: "s1" });
    expect(
      sanitizePendingApprovalForSession(
        { requestId: "r", sessionId: "s2" },
        "s1",
      ),
    ).toBeNull();
    expect(
      resolveThreadIdAfterAttachState({
        activeThreadId: "disk_s1",
        attachThreadId: "live_1",
        attachState: "live",
      }),
    ).toBe("live_1");
    expect(
      resolveThreadIdAfterAttachState({
        activeThreadId: "live_1",
        attachThreadId: "live_2",
        attachState: "live",
      }),
    ).toBe("live_1");
  });

  it("paintHistoryEntries walks roles and collects user texts", () => {
    const lines: string[] = [];
    const tools: string[] = [];
    const users = paintHistoryEntries(
      [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
        {
          role: "tool",
          text: "",
          toolName: "bash",
          toolStatus: "running",
        },
        { role: "thought", text: "thinking…" },
      ],
      {
        willBusyEarly: false,
        endStreamBubble: () => lines.push("end"),
        paintUserMessage: (t) => lines.push(`user:${t}`),
        replayHistoryTool: (e) =>
          tools.push(`${e.toolName}:${e.toolStatus}`),
        appendProcessText: (t) => lines.push(`proc:${t}`),
        appendLine: (t, role) => lines.push(`${role}:${t}`),
      },
    );
    expect(users).toEqual(["hello"]);
    expect(lines).toContain("user:hello");
    expect(lines).toContain("assistant:hi");
    expect(lines).toContain("proc:thinking…");
    // idle rehydrate：running 历史 tool 强制 failed
    expect(tools).toEqual(["bash:failed"]);
  });
});

describe("bus-event-handlers", () => {
  it("pure helpers for welcome drop / demote / busy status", () => {
    expect(
      shouldDropLiveEventOnWelcome({
        activeThreadId: null,
        activeSessionId: null,
        threadId: "t1",
      }),
    ).toBe(true);
    expect(
      shouldDropLiveEventOnWelcome({
        activeThreadId: "t1",
        activeSessionId: "s1",
        sessionId: "s1",
      }),
    ).toBe(false);
    expect(
      shouldDemoteLiveOnAttachState({
        state: "history_only",
        activeSessionId: "s1",
        activeThreadId: "live_1",
      }),
    ).toBe(true);
    expect(
      shouldDemoteLiveOnAttachState({
        state: "live",
        activeSessionId: "s1",
        activeThreadId: "live_1",
      }),
    ).toBe(false);
    expect(isSessionBusyStatus("working")).toBe(true);
    expect(isSessionBusyStatus("idle")).toBe(false);
    expect(normalizeAppUpdateEvent({ phase: "available", canUpdate: true }).canUpdate).toBe(
      true,
    );
  });

  it("tryHandle consumes shell/queue and leaves transcript for caller", () => {
    const calls: string[] = [];
    const h = new BusEventHandlers({
      handleDeepLinkPayload: () => calls.push("deep"),
      handleShellNavigate: (v) => calls.push(`nav:${v}`),
      handleShellNotice: (c) => calls.push(`notice:${c}`),
      onAppUpdate: () => calls.push("upd"),
      getActiveSessionId: () => "s1",
      getActiveThreadId: () => "t1",
      getTurnActive: () => false,
      getTurnUiPhase: () => "idle",
      isUserStopSuppressed: () => false,
      eventBelongsToActiveSession: () => true,
      setAttachUiState: () => calls.push("attach"),
      demoteLiveThreadToDisk: () => calls.push("demote"),
      endTurn: () => calls.push("endTurn"),
      setComposerBusy: () => {},
      markSessionWorking: (sid, w) => calls.push(`work:${sid}:${w}`),
      reloadPromptQueueFromHost: () => calls.push("queue"),
      showToast: () => {},
      applyAvailableCommandsEvent: () => calls.push("cmds"),
      scheduleRefreshFileTree: () => calls.push("files"),
      handlePlanApprovalRequested: () => calls.push("planA"),
      handlePlanModeChanged: () => calls.push("planM"),
      applyAgentGoalEvent: () => calls.push("goal"),
      handleSubagentUpdated: () => calls.push("sub"),
      handleTaskUpdated: () => calls.push("task"),
    });
    expect(h.tryHandle({ type: "shell.navigate", view: "inbox" })).toBe(true);
    expect(calls).toContain("nav:inbox");
    expect(h.tryHandle({ type: "goal.updated" })).toBe(true);
    expect(calls).toContain("goal");
    expect(h.tryHandle({ type: "files.changed" })).toBe(true);
    expect(
      h.tryHandle({
        type: "queue.changed",
        sessionId: "s1",
      }),
    ).toBe(true);
    expect(calls).toContain("queue");
    // transcript types not consumed by bus
    expect(h.tryHandle({ type: "message.delta" })).toBe(false);
    expect(h.tryHandle({ type: "turn.completed" })).toBe(false);
  });
});

describe("open-thread-phases", () => {
  it("planOpenThreadLeave snapshots when leaving a different session", () => {
    const leave = planOpenThreadLeave({
      activeSessionId: "s1",
      activeThreadId: "t1",
      targetSessionId: "s2",
      targetThreadId: "t2",
      turnActive: true,
      isSidebarWorking: () => true,
      isThreadListedWorking: () => false,
    });
    expect(leave.sameSession).toBe(false);
    expect(leave.shouldSnapshot).toBe(true);
    expect(leave.keepBgWorking).toBe(true);
    expect(leave.shouldResetCrossSessionUi).toBe(true);
  });

  it("bindPlanProjectionForOpen drops cross-session pending", () => {
    expect(
      bindPlanProjectionForOpen(
        {
          planPhase: "active",
          pendingApproval: {
            requestId: "r1",
            sessionId: "other",
            planContent: "x",
          },
        },
        "s1",
      ),
    ).toEqual({ planPhase: "active", pendingApproval: null });
    expect(shouldApplyAttachUiState("live")).toBe(true);
    expect(shouldApplyAttachUiState("history_only")).toBe(false);
    expect(
      shouldForceBackgroundTurnActive({
        keepBgWorking: true,
        prevSid: "s1",
        snapTurnActive: false,
      }),
    ).toBe(true);
  });
});

describe("subagent-task-events", () => {
  it("filters non-active session events", () => {
    expect(
      isSubagentEventForActiveSession(
        { parentSessionId: "p1", sessionId: "c1" },
        "s1",
      ),
    ).toBe(false);
    expect(
      isSubagentEventForActiveSession(
        { parentSessionId: "s1", sessionId: "c1" },
        "s1",
      ),
    ).toBe(true);
    expect(
      isTaskEventForActiveSession({ sessionId: "s2" }, "s1"),
    ).toBe(false);
    expect(taskEventLabel({ taskId: "t", phase: "x", command: "ls" })).toBe(
      "ls",
    );
  });

  it("handleTaskUpdated paints process + toast for foreground", () => {
    const lines: string[] = [];
    const toasts: string[] = [];
    const snaps: string[] = [];
    const h = new SubagentTaskEventHandlers({
      getActiveSessionId: () => "s1",
      showToast: (t) => toasts.push(t),
      appendProcessText: (t) => lines.push(t),
      applySubagentUpdate: () => {},
      rememberTaskSnap: (ev) => snaps.push(ev.taskId),
    });
    h.handleTaskUpdated({
      sessionId: "s1",
      taskId: "abcdef12",
      phase: "backgrounded",
      command: "sleep 1",
    });
    expect(snaps).toEqual(["abcdef12"]);
    expect(lines.length).toBe(1);
    expect(toasts.length).toBe(1);
    // background session: snap only
    h.handleTaskUpdated({
      sessionId: "s2",
      taskId: "zzzz",
      phase: "backgrounded",
      command: "x",
    });
    expect(snaps).toContain("zzzz");
    expect(lines.length).toBe(1);
  });
});

describe("host-permission-respond", () => {
  it("planStatusAfterRespond maps outcomes", () => {
    expect(planStatusAfterRespond("approved")).toBe("approved");
    expect(planStatusAfterRespond("cancelled")).toBe("drafting");
    expect(planStatusAfterRespond("abandoned")).toBe("rejected");
  });

  it("respondPermissionAcrossClients hits exact requestId", () => {
    const calls: string[] = [];
    const clients = [
      {
        hasPermission: (id: string) => id === "r2",
        respondPermission: (id: string) => calls.push(`ok:${id}`),
      },
      {
        hasPermission: () => false,
        respondPermission: () => calls.push("wrong"),
      },
    ];
    respondPermissionAcrossClients(clients, "r2", "allow_once", {
      markReadByRequestId: (rid) => calls.push(`read:${rid}`),
    });
    expect(calls).toEqual(["ok:r2", "read:r2"]);
  });

  it("respondAskUser / planApproval require pending waiter", () => {
    expect(() =>
      respondAskUserAcrossClients([], "r1", { outcome: "cancelled" }),
    ).toThrow(/No pending ask_user/);
    const planCalls: string[] = [];
    respondPlanApprovalAcrossClients(
      [
        {
          hasPlanApproval: (id?: string) => !id || id === "p1",
          respondPlanApproval: (id, outcome) =>
            planCalls.push(`${id}:${outcome}`),
        },
      ],
      "p1",
      "approved",
    );
    expect(planCalls).toEqual(["p1:approved"]);
  });
});

describe("host-prompt-queue-service", () => {
  it("enqueue / takeNext drain lock / completeSending", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gd-pq-"));
    const events: string[] = [];
    const svc = new PromptQueueService({
      home,
      logger: {
        path: "",
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      threadIdForSession: () => "t1",
      resolveWritableClient: () => null,
      emit: (ev) => events.push(String((ev as { type?: string }).type)),
    });
    try {
      const q = svc.enqueue("sid-a", { content: "first" });
      expect(q.items).toHaveLength(1);
      expect(events).toContain("queue.changed");
      const taken = svc.takeNext("sid-a");
      expect(taken.item?.content).toBe("first");
      // second take blocked while drain locked
      expect(svc.takeNext("sid-a").item).toBeNull();
      svc.completeSending("sid-a", taken.item!.id, true);
      expect(svc.get("sid-a").items).toHaveLength(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("model-display", () => {
  it("display name prefers catalog name", () => {
    const cat = [{ id: "grok-4", name: "Grok 4", source: "official" as const }];
    expect(modelDisplayName("grok-4", cat)).toBe("Grok 4");
    expect(shortModelName("grok-4", cat)).toBe("Grok 4");
    expect(shortModelName("grok-code", [])).toBe("code");
  });

  it("resolveChipModelFallback only when missing", () => {
    const list = [
      { id: "a", isDefault: true },
      { id: "b" },
    ];
    expect(resolveChipModelFallback("a", list, "a")).toBeNull();
    expect(resolveChipModelFallback("gone", list, "a")).toBe("a");
    expect(resolveChipModelFallback("gone", list, "gone")).toBe("a");
  });

  it("computeModelMenuPosition flips flyout left when needed", () => {
    const layout = computeModelMenuPosition({
      anchor: { top: 100, bottom: 120, right: 900 },
      primaryW: 160,
      primaryH: 200,
      flyoutW: 180,
      flyoutOpen: true,
      viewportW: 950,
      viewportH: 800,
    });
    expect(layout.openLeft).toBe(true);
    expect(layout.left).toBeLessThan(900 - 160);
  });
});

describe("context-usage", () => {
  it("mergeOptimisticContextFromCompact", () => {
    expect(
      mergeOptimisticContextFromCompact(null, { tokensAfter: undefined }, "s1"),
    ).toBeNull();
    const next = mergeOptimisticContextFromCompact(
      { sessionId: "s1", used: 1000, total: 10000, percent: 10, available: true, source: "signals" },
      { tokensBefore: 9000, tokensAfter: 2000 },
      "s1",
    );
    expect(next?.used).toBe(2000);
    expect(next?.total).toBe(10000);
    expect(next?.percent).toBe(20);
  });
});

describe("goal-input", () => {
  it("parseGoalBudget", () => {
    expect(parseGoalBudget("ship it --budget 5000")).toEqual({
      objective: "ship it",
      budget: 5000,
    });
    expect(parseGoalBudget("no budget")).toEqual({
      objective: "no budget",
      budget: null,
    });
  });

  it("parseGoalInput slash and compose", () => {
    expect(parseGoalInput("/goal")).toMatchObject({
      enterComposeOnly: true,
      goalTitle: null,
    });
    expect(parseGoalInput("/goal build app --budget 100")).toMatchObject({
      goalTitle: "build app",
      budget: 100,
    });
    expect(
      parseGoalInput("plain text", { goalComposeActive: true }),
    ).toMatchObject({
      goalTitle: "plain text",
      message: "plain text",
    });
  });

  it("agentContentForSend + elapsed", () => {
    expect(agentContentForSend("hi", null, null)).toBe("hi");
    expect(agentContentForSend("hi", "obj", 99)).toBe("/goal obj --budget 99");
    expect(isGoalPausedStatus("blocked")).toBe(true);
    expect(isGoalPausedStatus("active")).toBe(false);
    expect(
      computeGoalElapsedMs({
        elapsedFloorMs: 1000,
        elapsedMs: 500,
        paused: false,
        completed: false,
        anchorAt: 1000,
        now: 2500,
      }),
    ).toBe(2500);
    expect(formatGoalElapsed(65_000)).toMatch(/1m/);
  });
});

describe("composer-attachments", () => {
  it("planAddAttachments caps and dedupes", () => {
    const existing = [
      { path: "a.png", name: "a.png", kind: "image" as const },
    ];
    const plan = planAddAttachments(existing, ["a.png", "b.txt", "c.md"]);
    expect(plan.skippedDup).toBe(1);
    expect(plan.toAdd.map((a) => a.path)).toEqual(["b.txt", "c.md"]);
    expect(attachmentKind("x.PNG")).toBe("image");
    expect(attachmentKind("x.ts")).toBe("file");
  });

  it("build/parse attachment history payload are inverse", () => {
    const built = buildPromptWithAttachments("hello", [
      { path: "D:/a.png", name: "a.png", kind: "image" },
      { path: "D:/src", name: "src/", kind: "folder" },
    ]);
    expect(built.display).toBe("hello");
    expect(built.content).toContain("hello");
    expect(built.content).toContain("- image: D:/a.png");
    const parsed = parseUserHistoryPayload(built.content);
    expect(parsed.text).toBe("hello");
    expect(parsed.attachments).toEqual([
      { path: "D:/a.png", name: "a.png", kind: "image" },
      { path: "D:/src", name: "src/", kind: "folder" },
    ]);
  });
});

describe("prompt-queue-logic", () => {
  it("swapAdjacentOrderedIds", () => {
    expect(swapAdjacentOrderedIds(["a", "b", "c"], "b", -1)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(swapAdjacentOrderedIds(["a", "b"], "a", -1)).toBeNull();
    expect(swapAdjacentOrderedIds(["a", "b"], "z", 1)).toBeNull();
  });

  it("normalizeQueueEditPatch + gates", () => {
    expect(normalizeQueueEditPatch("  ", "  ")).toBeNull();
    expect(normalizeQueueEditPatch("hi", "")).toEqual({
      display: "hi",
      content: "hi",
    });
    expect(enqueueToastKey(true)).toBe("queue.enqueuedPaused");
    expect(newQueueItemId(1, 0.5)).toMatch(/^q_/);
    expect(
      canScheduleQueueDrain({
        pausedByInterrupt: false,
        queueLength: 1,
        alreadyScheduled: false,
      }),
    ).toBe(true);
    expect(
      canScheduleQueueDrain({
        pausedByInterrupt: true,
        queueLength: 1,
        alreadyScheduled: false,
      }),
    ).toBe(false);
    expect(
      queueItemActionGate(
        { status: "pending" },
        {
          turnUiPhase: "working",
          turnActive: true,
          requireWorkingTurn: true,
        },
      ),
    ).toEqual({ ok: true });
    expect(
      queueItemActionGate(
        { status: "sending" },
        {
          turnUiPhase: "working",
          turnActive: true,
          requireWorkingTurn: false,
        },
      ).ok,
    ).toBe(false);
  });
});

describe("composer-inline", () => {
  it("parseInlineBtwOrInterject", () => {
    expect(parseInlineBtwOrInterject("/btw what")).toEqual({
      kind: "btw",
      body: "what",
    });
    expect(parseInlineBtwOrInterject("  /interject go")).toEqual({
      kind: "interject",
      body: "go",
    });
    expect(parseInlineBtwOrInterject("hello")).toBeNull();
  });
});

describe("thread-forest", () => {
  it("builds forest and visible slice", () => {
    const list = [
      { sessionId: "root", updatedAt: "2020-01-02", parentSessionId: undefined },
      {
        sessionId: "child",
        updatedAt: "2020-01-03",
        parentSessionId: "root",
      },
      { sessionId: "other", updatedAt: "2020-01-01" },
    ];
    const forest = buildThreadForest(list);
    expect(forest.map((n) => n.thread.sessionId)).toEqual(["root", "other"]);
    expect(forest[0]!.children.map((c) => c.thread.sessionId)).toEqual([
      "child",
    ]);
    const flat = flattenThreadForest(forest);
    expect(flat.map((x) => [x.thread.sessionId, x.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["other", 0],
    ]);
    const vis = visibleThreadForest(list, false, 1);
    expect(vis.rootCount).toBe(2);
    expect(vis.flat.map((x) => x.thread.sessionId)).toEqual(["root", "child"]);
  });
});

describe("thread-model", () => {
  it("threadsForProject and chats group", async () => {
    const { threadsForProject, threadsForChatsGroup, isThreadOpen, isLiveThreadId } =
      await import("../src/renderer/thread/model.js");
    const projects = [
      { id: "p1", path: "D:/proj", title: "P", trust: "trusted" },
    ];
    const threads = [
      {
        id: "t1",
        sessionId: "s1",
        projectId: "p1",
        title: "A",
        cwd: "D:/proj",
        status: "idle",
        updatedAt: "2020-02-01",
      },
      {
        id: "t2",
        sessionId: "s2",
        title: "orphan",
        cwd: "D:/other",
        status: "idle",
        updatedAt: "2020-01-01",
      },
    ];
    expect(threadsForProject(projects, threads, "p1").map((t) => t.sessionId)).toEqual([
      "s1",
    ]);
    expect(threadsForChatsGroup(projects, threads).map((t) => t.sessionId)).toEqual([
      "s2",
    ]);
    expect(isThreadOpen(threads[0]!, "t1", null)).toBe(true);
    expect(isLiveThreadId("disk_x")).toBe(false);
    expect(isLiveThreadId("abc")).toBe(true);
  });
});

describe("history-export", () => {
  it("buildHistoryExportMarkdown", () => {
    const md = buildHistoryExportMarkdown(
      {
        title: "T",
        sessionId: "s1",
        cwd: "/w",
        exportedAt: "2020-01-01T00:00:00.000Z",
      },
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "yo" },
        { role: "tool", toolName: "bash", text: "ok" },
      ],
    );
    expect(md).toContain("# T");
    expect(md).toContain("## User");
    expect(md).toContain("### Tool · bash");
    expect(md).toContain("yo");
  });
});

describe("formatUserMsgTime", () => {
  it("omits year when same calendar year", () => {
    const now = new Date(2026, 5, 21, 12, 0, 0);
    const d = new Date(2026, 5, 21, 18, 49, 0);
    expect(formatUserMsgTime(d, now)).toBe("6月21日 18:49");
    const old = new Date(2024, 0, 2, 9, 5, 0);
    expect(formatUserMsgTime(old, now)).toBe("2024年1月2日 09:05");
  });
});

describe("plan-artifact", () => {
  it("isPlanDocumentBaseName", () => {
    expect(isPlanDocumentBaseName("plan.md")).toBe(true);
    expect(isPlanDocumentBaseName("foo-plan.zh.md")).toBe(true);
    expect(isPlanDocumentBaseName("readme.md")).toBe(false);
  });

  it("extractPlanArtifactPath from title", () => {
    expect(
      extractPlanArtifactPath("Write", {
        title: "Write `docs/perf-plan.md`",
      }),
    ).toBe("docs/perf-plan.md");
  });

  it("rail activity + draft keep + prefer content", () => {
    expect(
      resolvePlanRailActivity({
        approvalArmed: true,
        planOn: true,
        hasBody: true,
        turnStatusText: "",
        revisingLabel: "revising",
      }),
    ).toBe("pending");
    expect(
      resolvePlanRailActivity({
        approvalArmed: false,
        planOn: true,
        hasBody: false,
        turnStatusText: "revising…",
        revisingLabel: "revising",
      }),
    ).toBe("revising");
    expect(
      shouldKeepPlanDraft({
        forceReload: false,
        dirty: true,
        editorHasText: true,
      }),
    ).toBe(true);
    expect(preferPlanContent("", "seed body")).toBe("seed body");
    expect(preferPlanContent("session", "seed")).toBe("session");
    expect(
      planPanelStatusBits({
        planOn: true,
        planPhase: "active",
        dirty: true,
        armed: false,
        modeChipLabel: "Plan",
        unsavedLabel: "unsaved",
        awaitingLabel: "await",
      }),
    ).toEqual(["Active", "unsaved"]);
  });
});

describe("session-info-format", () => {
  it("formatSessionInfoLines includes session id", () => {
    setLocale("en-US");
    const lines = formatSessionInfoLines({
      sessionId: "abc-123",
      turns: 1,
      turnIndex: 0,
      context: {
        used: 100,
        total: 1000,
        systemPromptTokens: 10,
        toolDefinitionsCount: 0,
        toolDefinitionsTokens: 0,
        compactionCount: 0,
        turnCount: 1,
        toolCallCount: 0,
        messageCount: 2,
        messageTokens: 90,
        freeTokens: 900,
        usagePct: 10,
        autoCompactThresholdPercent: 85,
        usageCategories: [],
      },
    });
    expect(lines.some((l) => l.includes("abc-123"))).toBe(true);
  });
});

describe("models-catalog", () => {
  it("parseGrokModelsCliOutput", () => {
    const out = parseGrokModelsCliOutput(`
Default model: grok-4
  * grok-4 (default)
  - grok-code
`);
    expect(out.map((m) => m.id)).toEqual(["grok-4", "grok-code"]);
    expect(out.find((m) => m.id === "grok-4")?.isDefault).toBe(true);
  });

  it("mergeModelsCatalog filters official when logged out", () => {
    const list = mergeModelsCatalog(
      [{ id: "grok-4", name: "Grok 4", source: "official" }],
      false,
      {
        providers: [{ id: "my-proxy", name: "Proxy", model: "x" }],
        defaultModel: "my-proxy",
      },
    );
    expect(list.map((m) => m.id)).toEqual(["my-proxy"]);
    expect(list[0].isDefault).toBe(true);
  });

  it("mergeModelsCatalog keeps official when authenticated", () => {
    const list = mergeModelsCatalog(
      [{ id: "grok-4", name: "Grok 4", source: "official" }],
      true,
      {
        providers: [{ id: "my-proxy", name: "Proxy" }],
        defaultModel: "grok-4",
      },
    );
    expect(list.some((m) => m.id === "grok-4")).toBe(true);
    expect(list.some((m) => m.id === "my-proxy")).toBe(true);
  });
});
