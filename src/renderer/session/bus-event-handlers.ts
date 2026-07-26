/**
 * onEvent 非 transcript 总线：shell / app.update / attach / queue / session.status 等。
 * transcript 范围事件返回 false，由调用方走 bg / suspend / TranscriptEventHandlers。
 */
import { tr } from "../../shared/i18n/index.js";
import {
  shouldIgnoreLateSessionWorking,
  type TurnUiPhase,
} from "../../shared/turn-ui-state.js";
/** wire 上常见扩展字段（NormalizedEvent 并集的宽松视图） */
export type BusEvent = {
  type?: string;
  activity?: string;
  phase?: string;
  currentVersion?: string;
  latestVersion?: string;
  percent?: number;
  error?: string;
  canUpdate?: boolean;
  releasesUrl?: string;
  payload?: string;
  view?: string;
  code?: string;
  message?: string;
  sessionId?: string;
  threadId?: string;
  state?: string;
  lastError?: string;
  syncError?: string;
  status?: string;
};

export type AppUpdateBusSnap = {
  phase: string;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  error?: string;
  canUpdate: boolean;
  releasesUrl: string;
};

export type BusEventHandlersDeps = {
  handleDeepLinkPayload: (payload: string) => void | Promise<void>;
  handleShellNavigate: (view: string) => void;
  handleShellNotice: (code: string, message?: string) => void;
  onAppUpdate: (upd: AppUpdateBusSnap) => void;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  getTurnActive: () => boolean;
  getTurnUiPhase: () => TurnUiPhase;
  isUserStopSuppressed: () => boolean;
  eventBelongsToActiveSession: (ev: {
    sessionId?: string;
    threadId?: string;
  }) => boolean;
  setAttachUiState: (state: string, lastError?: string) => void;
  demoteLiveThreadToDisk: () => void;
  endTurn: (opts?: {
    outcome?: "worked" | "stopped";
    skipQueueDrain?: boolean;
  }) => void;
  setComposerBusy: (busy: boolean) => void;
  markSessionWorking: (sessionId: string, working: boolean) => void;
  reloadPromptQueueFromHost: () => void | Promise<void>;
  showToast: (text: string, kind?: "info" | "error") => void;
  applyAvailableCommandsEvent: (ev: BusEvent & { commands?: unknown }) => void;
  scheduleRefreshFileTree: () => void;
  handlePlanApprovalRequested: (ev: BusEvent) => void | Promise<void>;
  handlePlanModeChanged: (ev: BusEvent) => void;
  applyAgentGoalEvent: (ev: BusEvent) => void;
  handleSubagentUpdated: (ev: BusEvent) => void;
  handleTaskUpdated: (ev: BusEvent) => void;
};

/**
 * 欢迎页（无活动会话）：是否丢弃带 thread/session 的直播事件。
 */
export function shouldDropLiveEventOnWelcome(opts: {
  activeThreadId: string | null;
  activeSessionId: string | null;
  threadId?: string;
  sessionId?: string;
}): boolean {
  if (opts.activeThreadId || opts.activeSessionId) return false;
  return Boolean(opts.threadId || opts.sessionId);
}

/** 规范化 app.update 推送字段 */
export function normalizeAppUpdateEvent(ev: BusEvent): AppUpdateBusSnap {
  return {
    phase: String(ev.phase ?? ""),
    currentVersion: String(ev.currentVersion ?? ""),
    latestVersion: ev.latestVersion,
    percent: ev.percent,
    error: ev.error,
    canUpdate: Boolean(ev.canUpdate),
    releasesUrl: String(
      ev.releasesUrl ?? "https://github.com/fanghui-li/Grok-Desktop/releases",
    ),
  };
}

/**
 * detach 后是否应将 live threadId 降为 disk_。
 */
export function shouldDemoteLiveOnAttachState(opts: {
  state: string;
  activeSessionId: string | null;
  activeThreadId: string | null;
}): boolean {
  const st = String(opts.state || "").toLowerCase();
  return (
    (st === "history_only" || st === "failed") &&
    !!opts.activeSessionId &&
    !!opts.activeThreadId &&
    !opts.activeThreadId.startsWith("disk_")
  );
}

export function isSessionBusyStatus(status: string | undefined): boolean {
  return (
    status === "working" ||
    status === "needs_input" ||
    status === "blocked"
  );
}

export class BusEventHandlers {
  constructor(private readonly deps: BusEventHandlersDeps) {}

  /**
   * 处理非 transcript 总线事件。
   * @returns true 表示已消费（onEvent 应 return）；false 继续 transcript 路径。
   */
  tryHandle(ev: BusEvent): boolean {
    if (ev.type === "shell.handoff") {
      void this.deps.handleDeepLinkPayload(ev.payload || "");
      return true;
    }
    if (ev.type === "shell.navigate") {
      this.deps.handleShellNavigate(ev.view || "command");
      return true;
    }
    if (ev.type === "app.update") {
      this.deps.onAppUpdate(normalizeAppUpdateEvent(ev));
      return true;
    }
    if (ev.type === "shell.notice") {
      this.deps.handleShellNotice(ev.code || "", ev.message);
      return true;
    }

    if (
      shouldDropLiveEventOnWelcome({
        activeThreadId: this.deps.getActiveThreadId(),
        activeSessionId: this.deps.getActiveSessionId(),
        threadId: ev.threadId,
        sessionId: ev.sessionId,
      })
    ) {
      return true;
    }

    if (ev.type === "goal.updated") {
      this.deps.applyAgentGoalEvent(ev);
      return true;
    }
    if (ev.type === "subagent.updated") {
      this.deps.handleSubagentUpdated(ev);
      return true;
    }
    if (ev.type === "task.updated") {
      this.deps.handleTaskUpdated(ev);
      return true;
    }

    if (ev.type === "session.attach_state") {
      this.onAttachState(ev);
      return true;
    }
    if (ev.type === "queue.changed") {
      this.onQueueChanged(ev);
      return true;
    }
    if (ev.type === "session.available_commands") {
      this.deps.applyAvailableCommandsEvent(ev);
      return true;
    }
    if (ev.type === "files.changed") {
      this.deps.scheduleRefreshFileTree();
      return true;
    }
    if (ev.type === "plan.approval.requested") {
      void this.deps.handlePlanApprovalRequested(ev);
      return true;
    }
    if (ev.type === "plan.mode.changed") {
      this.deps.handlePlanModeChanged(ev);
      return true;
    }
    if (ev.type === "session.status") {
      this.onSessionStatus(ev);
      return true;
    }

    return false;
  }

  private onAttachState(ev: BusEvent): void {
    const activeSid = this.deps.getActiveSessionId();
    if (ev.sessionId && activeSid && ev.sessionId !== activeSid) {
      return;
    }
    this.deps.setAttachUiState(String(ev.state ?? ""), ev.lastError);
    if (
      shouldDemoteLiveOnAttachState({
        state: String(ev.state || ""),
        activeSessionId: activeSid,
        activeThreadId: this.deps.getActiveThreadId(),
      })
    ) {
      this.deps.demoteLiveThreadToDisk();
      if (this.deps.getTurnActive()) {
        this.deps.endTurn({ skipQueueDrain: true, outcome: "stopped" });
      } else if (activeSid) {
        this.deps.setComposerBusy(false);
        this.deps.markSessionWorking(activeSid, false);
      }
    }
  }

  private onQueueChanged(ev: BusEvent): void {
    const activeSid = this.deps.getActiveSessionId();
    if (ev.sessionId && activeSid && ev.sessionId === activeSid) {
      void this.deps.reloadPromptQueueFromHost();
      if (ev.syncError) {
        this.deps.showToast(
          tr("queue.localOnly", { err: String(ev.syncError) }),
          "error",
        );
      }
    }
  }

  private onSessionStatus(ev: BusEvent): void {
    // Legacy control bus (pre shell.* events)
    if (ev.activity === "nav:inbox" || ev.activity === "nav:command") {
      this.deps.handleShellNavigate(
        ev.activity === "nav:inbox" ? "inbox" : "command",
      );
      return;
    }
    if (ev.activity === "system:agent_missing") {
      this.deps.handleShellNotice("agent_missing");
      return;
    }
    if (ev.activity?.startsWith("handoff:")) {
      void this.deps.handleDeepLinkPayload(
        ev.activity.slice("handoff:".length),
      );
    }
    if (!ev.sessionId) return;

    const busyStatus = isSessionBusyStatus(ev.status);
    if (
      busyStatus &&
      shouldIgnoreLateSessionWorking({
        userStopSuppressed: this.deps.isUserStopSuppressed(),
        phase: this.deps.getTurnUiPhase(),
        eventBelongsToActiveSession:
          this.deps.eventBelongsToActiveSession(ev),
      })
    ) {
      this.deps.markSessionWorking(ev.sessionId, false);
      return;
    }
    this.deps.markSessionWorking(ev.sessionId, busyStatus);
    if (
      !busyStatus &&
      this.deps.getActiveSessionId() === ev.sessionId &&
      this.deps.getTurnActive()
    ) {
      this.deps.endTurn({ skipQueueDrain: true, outcome: "worked" });
    }
  }
}
