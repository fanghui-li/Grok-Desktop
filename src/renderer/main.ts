/**
 * Codex Desktop 对齐交互：
 * 左：新对话 / 搜索 / 插件 / 自动化 · 项目列表 · 对话列表 · 设置
 * 中：欢迎语 + 输入卡 / 对话流
 * 右：文件 · 浏览器 · 终端
 */
import type { HostIpcMethod } from "../shared/host-api.js";
import type { NormalizedEvent } from "../shared/events.js";
import { formatFriendlyErrorLabelTitle } from "../shared/friendly-error-title.js";
import {
  armClearsHistoryResyncBlock,
  assistantsAfterLastUser,
  historyLastUserMatchesTimeline,
  isCleanAssistantStreamForResyncUnlock,
  shouldSkipHistoryResync,
} from "../shared/history-resync-policy.js";
import {
  resolveBusySendWhileCancelling,
  shouldJoinInFlightCancel,
  shouldPaintStoppedPhase,
  type TurnUiPhase,
} from "../shared/turn-ui-state.js";
import {
  getSessionTurn,
  idleProjection,
  markSessionTurnIdle,
  patchSessionTurn,
  setSessionTurn,
  shouldRehydrateBusy,
  type SessionTurnProjection,
} from "./session/turn-store.js";
import {
  eventBelongsToActiveSession as eventBelongsToActiveSessionPure,
  isTranscriptScopedEvent as isTranscriptScopedEventPure,
} from "./session/event-scope.js";
import {
  applyBackgroundTranscriptEvent,
  applySuspendedLiveTranscriptEvent,
} from "./session/bg-turn-events.js";
import { PlanEventHandlers } from "./plan/event-handlers.js";
import { TranscriptEventHandlers } from "./session/transcript-handlers.js";
import { BusEventHandlers } from "./session/bus-event-handlers.js";
import {
  paintHistoryEntries,
  resolveThreadIdAfterAttachState,
} from "./session/history-replay.js";
import {
  bindPlanProjectionForOpen,
  planOpenThreadLeave,
  shouldApplyAttachUiState,
  shouldForceBackgroundTurnActive,
} from "./session/open-thread-phases.js";
import { SubagentTaskEventHandlers } from "./tasks/event-handlers.js";
import {
  deriveSessionActivity,
  sessionActivityIsDraining,
  type SessionActivity,
} from "./session/activity.js";
import {
  clearSessionPlan,
  getSessionPlan,
  patchSessionPlan,
  type PlanPhase,
  type SessionPlanPendingApproval,
} from "./session/plan-store.js";
import {
  cancelSessionBtwFlight,
  type BtwExchange,
} from "./session/btw-store.js";
import {
  applyDomI18n,
  onLocaleChange,
  resolveLocale,
  setLocale,
  tr,
  type LocalePreference,
} from "../shared/i18n/index.js";
import {
  bindCodeCopyDelegate,
  bindExternalLinkDelegate,
  paintAssistantHtml,
  paintAssistantStreaming,
  renderMarkdownToSafeHtml,
} from "./markdown.js";
import { bindFileLinkDelegate } from "./file-links.js";
import {
  openWorkspacePath,
  type OpenWorkspacePathOpts,
} from "./open-workspace-path.js";
import { SidePaneController } from "./side-pane.js";
import {
  SettingsPageController,
  type SettingsOpenTarget,
  type SettingsPermMode,
  type SettingsThemePreference,
} from "./settings-page.js";
import type { ThemeVariant, VariantAppearance } from "../shared/theme/types.js";
import { defaultAppearance } from "../shared/theme/index.js";
import { ThemeController } from "./lib/theme-controller.js";
import { PermPromptUi } from "./perm/prompt-ui.js";
import { PluginsPageController } from "./plugins-page.js";
import {
  sendButtonIconHtml,
  sidebarIcon,
  type SidebarIconName,
} from "./sidebar/icons.js";
import {
  agentAdvertisedCommands,
  buildSlashKindCatalog,
  getStaticSlashCommands,
  skillCommands,
  type SlashCommandDef,
} from "./slash/commands.js";
import { SlashPaletteController } from "./slash/palette.js";
import {
  bindComposerSlashHighlight,
  refreshComposerSlashHighlight,
  setSlashHighlightCatalog,
} from "./composer/slash-highlight.js";
import {
  AtFilePaletteController,
  type AtFileHit,
} from "./slash/at-file-palette.js";
import {
  buildToolCardHtml,
  updateToolCardDone,
} from "./agent-blocks.js";
import { syncAttachPillDom } from "./attach/pill-dom.js";
import { PromptQueueController } from "./prompt-queue/controller.js";
import {
  formatAge,
  formatElapsedCompact,
  formatTurnElapsed,
  formatTurnStopped,
  formatUserMsgTime,
} from "./lib/format-utils.js";
import { looksLikeGoalProcessText } from "./goal/process.js";
import { formatTurnErrorMessage } from "./lib/turn-error-format.js";
import { effortOptions, parseEffort, type EffortLevel } from "./model/effort.js";
import {
  parseGoalBudget,
  parseGoalInput as parseGoalInputPure,
} from "./goal/input.js";
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_COMPOSER_IMAGES,
  MAX_PASTE_IMAGE_BYTES_UI,
  arrayBufferToBase64,
  attachIcon,
  planAddAttachments,
  resolveLocalFilePath as resolveLocalFilePathPure,
  type ComposerAttachment,
} from "./composer/attachments.js";
import {
  CHATS_GROUP_ID,
  isLiveThreadId,
  isThreadOpen as isThreadOpenPure,
  parentThreadTitle as parentThreadTitlePure,
  projectIdOfThread,
  threadDisplayTitle as threadDisplayTitlePure,
  threadsForChatsGroup as threadsForChatsGroupPure,
  threadsForProject as threadsForProjectPure,
  type Project,
  type ThreadRow,
} from "./thread/model.js";
import { SidebarListController } from "./sidebar/list.js";
import { ComposerAttachUi } from "./composer/attach-ui.js";
import { ComposerBindUi } from "./composer/bind-ui.js";
import { ModelMenuController } from "./model/menu-ui.js";
import { BtwSideUi } from "./btw/side-ui.js";
import { BtwActions } from "./btw/actions.js";
import { ChatScrollLayout } from "./chat/scroll-layout.js";
import { GoalBannerUi, type GoalUiProjection as GoalUiProjectionMod } from "./goal/banner-ui.js";
import { GoalRuntimeActions } from "./goal/runtime-actions.js";
import { GoalSlashActions } from "./goal/slash-actions.js";
import { SkillActions } from "./slash/skill-actions.js";
import { SlashDispatch } from "./slash/dispatch.js";
import { ShellNavActions } from "./shell/nav-actions.js";
import { ContextUi, type ContextUsageRow } from "./context/ui.js";
import { PermMenuUi } from "./perm/menu-ui.js";
import { PlanPanelUi } from "./plan/panel-ui.js";
import { TasksPanelUi } from "./tasks/panel-ui.js";
import { MemoryBrowserUi } from "./memory/browser-ui.js";
import { PromptHistoryUi } from "./composer/prompt-history-ui.js";
import { CrashBannerUi } from "./lib/crash-banner-ui.js";
import { PlusMenuUi } from "./composer/plus-menu-ui.js";
import { ProjectPickerUi } from "./sidebar/project-picker-ui.js";
import { ProjectActions } from "./sidebar/project-actions.js";
import { AvailableCommandsCache } from "./slash/available-commands.js";
import { AutomationsModalUi } from "./automations/modal-ui.js";
import { SessionSearchUi } from "./session/search-ui.js";
import { ForkActions } from "./session/fork-actions.js";
import { RewindActions } from "./session/rewind-actions.js";
import { SessionOpsActions } from "./session/ops-actions.js";
import { ModelSessionActions } from "./model/session-actions.js";
import {
  type SessionModeChipFocus as SessionModeChipFocusMod,
} from "./session/mode-chips.js";
import { SessionPolicyActions } from "./session/policy-actions.js";
import {
  closeModal as closeModalDlg,
  confirmText as confirmTextDlg,
  openModal as openModalDlg,
  promptText as promptTextDlg,
  showToast as showToastDlg,
} from "./lib/dialogs.js";
import {
  syncAppUpdateTopButton as syncAppUpdateTopButtonPure,
  type AppUpdateUiSnap,
} from "./lib/app-update-ui.js";
import { type AgentGoalEvent } from "./goal/apply.js";
import { parseInlineBtwOrInterject } from "./composer/inline.js";
import {
  goalStatusKicker,
  parseGoalUiStatus,
  type GoalUiStatus,
} from "./goal/status.js";
import { type ModelRow } from "./model/display.js";
import { type SessionInfoRow } from "./session/info-format.js";
import {
  assistantTextsRoughlyEqual,
  looksLikeGluedNewAssistantReply,
  normalizeAssistantForDedupe,
} from "./lib/assistant-dedupe.js";
import type { AttachState } from "../shared/types.js";

interface Bridge {
  invoke(method: HostIpcMethod, params?: unknown): Promise<unknown>;
  onEvent(handler: (event: unknown) => void): () => void;
  /** Electron 32+：从 File 取本地绝对路径（File.path 已不可用） */
  getPathForFile?: (file: File) => string;
}

declare global {
  interface Window {
    grokDesktop: Bridge;
  }
}

interface HostRes<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}





const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let projects: Project[] = [];
let threads: ThreadRow[] = [];
let selectedProjectId: string | null = null;
/** 用户是否手动选过项目 /「不使用项目」（避免 refresh 强制回填首项） */
let projectChoiceTouched = false;
let activeThreadId: string | null = null;
/**
 * 会话视图代次：openThread / 切会话时递增。
 * await history/attach 返回后若 gen 已变，丢弃结果，防止串台。
 */
let sessionViewGen = 0;
let activeSessionId: string | null = null;
let activeCwd: string | null = null;
/** 写入 activeCwd 并通知侧栏文件树重监听 */
function setActiveCwd(cwd: string | null): void {
  const prev = activeCwd;
  activeCwd = cwd;
  if ((prev ?? "") !== (cwd ?? "")) {
    sidePane?.onCwdChanged();
  }
}
/** 当前 transcript 中下一条 user 消息的 prompt_index（与 agent rewind 对齐） */
let nextUserPromptIndex = 0;
/**
 * 访问权限（对齐 Grok Build always-approve / default）。
 * 与 plan 正交：plan 激活时 yolo 仍可 armed underneath。
 */
let accessMode: SettingsPermMode = "normal";
/**
 * Plan 状态（对齐 CLI Pending / Active）：
 * - pending：用户开了 plan，尚未发下一条消息
 * - active：agent 已进 plan（set_mode 或 plan.mode.changed）
 * 与 accessMode 独立，不再塞进同一个三态枚举。
 */
let planPhase: PlanPhase = "off";

function isPlanOn(): boolean {
  return planPhase !== "off";
}
/** 当前前台待审批的 exit_plan_mode 请求（仅 active 会话） */
let pendingPlanApproval: SessionPlanPendingApproval | null = null;
/**
 * turns.prompt IPC 返回与 turn.completed / 末包 message.delta 可能乱序；
 * endTurn 后短窗口内仍接受本 turn 的 assistant 流，避免「会话断了、最后一泡没了」。
 * 用户主动停止时清零，避免 cancel 后仍复活工具/流。
 */
let lateStreamUntil = 0;
/**
 * 用户点停止后，忽略会「复活」turn 的迟到事件（tool.started / turn.started 等），
 * 直到 Host 对本轮发出 turn.started（闸门已开）再 arm。
 * 窗口宜短：隔离靠 Host generation gate，不靠长 suppress / 内容毒化。
 */
let userStopSuppressUntil = 0;
/**
 * 用户停止后：本轮必须等 armTurnForLiveStream 才收流。
 * 防止 beginTurn 后、Host 闸门打开前误收 T1 残留。
 */
let streamArmedThisTurn = true;
/**
 * 用户停止后：禁止 history 回补（agent 可能把 T1 续写落盘到 T2 下）。
 * **仅**本轮出现干净助手流后解除（arm 不解除，见 history-resync-policy）。
 * 禁止词级毒化。
 */
let blockHistoryResyncAfterStop = false;
/** cancelTurn 进行中：二次停止 join 同一 in-flight（Phase4 Cancelling） */
let cancelTurnInFlight: Promise<void> | null = null;
/**
 * Turn UI 相位（Phase4）：idle | working | cancelling。
 * cancelling 可与 turnActive=false 并存（乐观 stop 后 host 仍在 cancel）。
 */
let turnUiPhase: TurnUiPhase = "idle";
/** 本 stop 是否已乐观画过「已停止」（防双条） */
let alreadyPaintedStopped = false;
/**
 * 回合进行中再次发送：queue（默认入队）| send_now（打断并发送）。
 * 来自 settings `busySendMode`。
 */
type BusySendMode = "queue" | "send_now";
let busySendMode: BusySendMode = "queue";
/**
 * 用户 Stop/Esc 取消后，下一条真正发给 agent 的 prompt 前做
 * conversation_only rewind（摘掉被取消 user 轮）。send_now 不设。
 * 不在 Desktop 拼 focus system-reminder（对齐 CLI agent 侧独立 reminder）。
 */
let pendingPostCancelFocus = false;
/** 被取消轮的 prompt_index（UI data-prompt-index；conversation_only rewind 用） */
let lastCancelledPromptIndex: number | null = null;
/**
 * 同一 turn 内错误只展示一次：turn.completed(error) 与 turns.prompt IPC 失败
 * 会先后带同一条 Internal error（#6 起双路径都画红条）。
 */
let lastShownTurnError: { turnId: number; key: string } | null = null;
/**
 * chip 显示：当前上下文的模型/推理。
 * - 打开某会话时 = 该会话记忆
 * - 欢迎页 / 新对话 = defaultModelLabel / defaultEffortLevel
 */
let modelLabel = "grok";
/** 推理力度（对齐 CLI /effort：low|medium|high|xhigh） */
let effortLevel: EffortLevel = "high";
/** 新对话默认（设置页 / 欢迎页改 chip 时更新；不因打开旧会话而改） */
let defaultModelLabel = "grok";
let defaultEffortLevel: EffortLevel = "high";
let defaultOpenTarget: SettingsOpenTarget = "explorer";
/** UI language preference from settings (`system` | zh-CN | en-US) */
let localePreference: LocalePreference = "system";
/** Appearance preference（对齐 Codex Appearance：system | light | dark） */
let themePreference: SettingsThemePreference = "system";
/** 分 variant 的 chrome + codeThemeId（经 ThemeController 持有） */
let appearanceLight: VariantAppearance = defaultAppearance("light");
let appearanceDark: VariantAppearance = defaultAppearance("dark");
/** Codex 可拖拽文件侧栏 */
let sidePane: SidePaneController | null = null;
/** Codex 式全页设置 */
let settingsPage: SettingsPageController | null = null;
/** Codex 式全页插件 / 技能 */
let pluginsPage: PluginsPageController | null = null;
/** 斜杠命令中心 */
let slashPalette: SlashPaletteController | null = null;
let atFilePalette: AtFilePaletteController | null = null;
/**
 * Goal UI 真源：agent goal_updated 投影（对齐 CLI AgentView.goal_state）。
 * compose 草稿仅本地，未 setup 前不算有目标。
 */
type GoalUiProjection = GoalUiProjectionMod;

/** 当前会话投影（null = 无目标 UI） */
let goalProjection: GoalUiProjection | null = null;
/** 尚无 session / 发送中暂存的标题（optimistic，等 wire） */
let pendingGoalTitle: string | null = null;
/** 下一次发送将文本设为 goal（/goal 或 +目标 后，直接在输入框写） */
let goalComposeActive = false;
/**
 * 输入栏 plan/goal chip 互斥焦点：最后一次被激活的一侧占 chip 位。
 * plan 与 goal 状态可同时存在于会话，但 UI **只显示一个** chip。
 */
type SessionModeChipFocus = SessionModeChipFocusMod;
let sessionModeChipFocus: SessionModeChipFocus = null;
/** wall-clock：live active 时从 received 起外推 */
let goalElapsedAnchorAt: number | null = null;
let goalCompleteHideTimer: ReturnType<typeof setTimeout> | null = null;
/** 目标 token 预算（CLI `/goal … --budget N`）；发送时拼进 /goal */
let goalTokenBudget: number | null = null;
/** clear 后本地记 id，防迟到事件复活（与 Host store 双保险） */
const goalLocalClearedIds = new Set<string>();
/** 本会话 / 默认 max-turns（写入 create meta；0=不限） */
let maxTurnsLimit: number | null = null;
/** agent available_commands_update 缓存（按 session） */
/** 崩溃后展示「重新附着」条 */
async function inv<T>(
  method: HostIpcMethod,
  params?: unknown,
): Promise<HostRes<T>> {
  if (!window.grokDesktop) {
    return { ok: false, error: { code: "INTERNAL", message: "no bridge" } };
  }
  return (await window.grokDesktop.invoke(method, params)) as HostRes<T>;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 侧栏项目/会话列表（DOM + 展开态） */
let sidebarList: SidebarListController | null = null;
let modelMenu: ModelMenuController | null = null;
let btwSideUi: BtwSideUi | null = null;
let btwActions: BtwActions | null = null;
let chatScroll: ChatScrollLayout | null = null;
let slashDispatch: SlashDispatch | null = null;
let shellNavActions: ShellNavActions | null = null;
let goalBannerUi: GoalBannerUi | null = null;
let goalRuntime: GoalRuntimeActions | null = null;
let planEventHandlers: PlanEventHandlers | null = null;
let transcriptHandlers: TranscriptEventHandlers | null = null;
let busEventHandlers: BusEventHandlers | null = null;
let subagentTaskHandlers: SubagentTaskEventHandlers | null = null;
let contextUi: ContextUi | null = null;
let permMenuUi: PermMenuUi | null = null;
let composerBindUi: ComposerBindUi | null = null;
let planPanelUi: PlanPanelUi | null = null;
let tasksPanelUi: TasksPanelUi | null = null;
let memoryBrowserUi: MemoryBrowserUi | null = null;
let promptHistoryUi: PromptHistoryUi | null = null;
let crashBannerUi: CrashBannerUi | null = null;
let plusMenuUi: PlusMenuUi | null = null;
let projectPickerUi: ProjectPickerUi | null = null;
let availableCommandsCache: AvailableCommandsCache | null = null;
let automationsModalUi: AutomationsModalUi | null = null;
let sessionSearchUi: SessionSearchUi | null = null;
let promptQueueCtrl: PromptQueueController | null = null;
let forkActions: ForkActions | null = null;
let rewindActions: RewindActions | null = null;
let sessionOpsActions: SessionOpsActions | null = null;
let modelSessionActions: ModelSessionActions | null = null;
let projectActions: ProjectActions | null = null;
let goalSlashActions: GoalSlashActions | null = null;
let sessionPolicyActions: SessionPolicyActions | null = null;
let skillActions: SkillActions | null = null;
let themeCtrl: ThemeController | null = null;
let permPromptUi: PermPromptUi | null = null;
/** 附件 chips / 添加 */
let attachUi: ComposerAttachUi | null = null;

function threadsForProject(projectId: string): ThreadRow[] {
  return threadsForProjectPure(projects, threads, projectId);
}
function threadsForChatsGroup(): ThreadRow[] {
  return threadsForChatsGroupPure(projects, threads);
}
function threadDisplayTitle(
  t: ThreadRow | undefined,
  fallbackId?: string,
): string {
  return threadDisplayTitlePure(t, fallbackId, tr("slash.forkDefaultTitle"));
}
function parentThreadTitle(parentSessionId: string | undefined): string | null {
  return parentThreadTitlePure(
    threads,
    parentSessionId,
    tr("slash.forkDefaultTitle"),
  );
}
function isThreadOpen(t: ThreadRow): boolean {
  return isThreadOpenPure(t, activeThreadId, activeSessionId);
}

function ensureSidebarList(): SidebarListController {
  if (sidebarList) return sidebarList;
  sidebarList = new SidebarListController({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getProjects: () => projects,
    setProjects: (p) => {
      projects = p;
    },
    getThreads: () => threads,
    setThreads: (t) => {
      threads = t;
    },
    getSelectedProjectId: () => selectedProjectId,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    getProjectChoiceTouched: () => projectChoiceTouched,
    setProjectChoiceTouched: (v) => {
      projectChoiceTouched = v;
    },
    getActiveThreadId: () => activeThreadId,
    getActiveSessionId: () => activeSessionId,
    isSessionWorking: (sid) => workingSessions.has(sid),
    onListRefreshed: () => {
      syncChatTopTitle();
      setWelcomeTitle();
    },
    onOpenThread: (t) => {
      void openThread(t);
    },
    onProjectSelected: () => {
      if (!activeThreadId && !activeSessionId) {
        setWelcomeTitle();
        showWelcome(true);
      }
    },
    onRemoveProject: (id, title, path) =>
      removeProjectFromList(id, title, path),
    onRenameThread: (t) => renameThread(t),
    onExportThread: async (t, destination) => {
      const r = await exportActiveSession({ destination, threadId: t.id });
      if (r.message) showToast(r.message, r.ok ? "info" : "error");
    },
    onForkThread: async (t) => {
      const r = await forkSessionFrom(t, { confirm: true });
      if (r.message) showToast(r.message, r.ok ? "info" : "error");
    },
    onArchiveThread: (t, archived) => archiveThread(t, archived),
    onDeleteThread: (t) => deleteThread(t),
    onOpenParentThread: (parent) => {
      selectedProjectId =
        parent.projectId || projectIdOfThread(parent) || selectedProjectId;
      if (selectedProjectId) {
        ensureSidebarList().expandedProjectIds.add(selectedProjectId);
      }
      void openThread(parent);
    },
  });
  return sidebarList;
}

function ensureAttachUi(): ComposerAttachUi {
  if (attachUi) return attachUi;
  attachUi = new ComposerAttachUi({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getSessionId: () => activeSessionId,
    getPickDefaultPath: () => selectedProject()?.path,
    openPathInWorkspace: (opts) => openPathInWorkspace(opts),
  });
  return attachUi;
}

function hideThreadMenu(): void {
  ensureSidebarList().hideThreadMenu();
}
async function refreshProjectsAndThreads(): Promise<void> {
  await ensureSidebarList().refreshProjectsAndThreads();
}

function addAttachments(
  paths: string[],
  opts?: {
    kind?: ComposerAttachment["kind"];
    previewMap?: Record<string, string>;
  },
): number {
  return ensureAttachUi().add(paths, opts);
}
function removeAttachment(path: string): void {
  ensureAttachUi().remove(path);
}
function clearAttachments(): void {
  ensureAttachUi().clear();
}
function renderAttachmentChips(): void {
  ensureAttachUi().renderChips();
}
function buildPromptWithAttachments(userText: string): {
  display: string;
  content: string;
} {
  return ensureAttachUi().buildPrompt(userText);
}
async function pickAndAddAttachments(): Promise<void> {
  await ensureAttachUi().pickAndAdd();
}

function ensureModelMenu(): ModelMenuController {
  if (modelMenu) return modelMenu;
  modelMenu = new ModelMenuController({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getModelLabel: () => modelLabel,
    setModelLabel: (id) => {
      modelLabel = id;
    },
    getDefaultModelLabel: () => defaultModelLabel,
    setDefaultModelLabel: (id) => {
      defaultModelLabel = id;
    },
    getEffortLevel: () => effortLevel,
    setEffortLevel: (level) => setEffortLevel(level),
    effortLabel,
    isMainShellOverlayOpen,
    getActiveThreadId: () => activeThreadId,
    getActiveSessionId: () => activeSessionId,
    applySessionModelAndEffort,
    promptSetModel,
  });
  return modelMenu;
}

function ensureBtwSideUi(): BtwSideUi {
  if (btwSideUi) return btwSideUi;
  btwSideUi = new BtwSideUi({
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    ensureBtwSideOpen: () => ensureBtwSideOpen(),
    renderMarkdownToSafeHtml,
  });
  return btwSideUi;
}

function ensureChatScroll(): ChatScrollLayout {
  if (chatScroll) return chatScroll;
  chatScroll = new ChatScrollLayout({
    hideEphemeralMenus,
    getTranscriptEl: () => document.getElementById("transcript"),
  });
  return chatScroll;
}

function ensurePlanEventHandlers(): PlanEventHandlers {
  if (planEventHandlers) return planEventHandlers;
  planEventHandlers = new PlanEventHandlers({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    getThreads: () => threads,
    eventBelongsToActiveSession,
    markSessionWorking,
    endStreamBubble,
    setTurnStatus,
    getPlanPhase: () => planPhase,
    setPlanPhase: (phase) => {
      planPhase = phase;
    },
    setPendingApproval: (p) => {
      pendingPlanApproval = p;
    },
    syncPermLabels,
    openPlanPanel,
    isPlanOn,
    isPlanApprovalArmed,
    snapshotActiveSessionPlan,
  });
  return planEventHandlers;
}

function demoteLiveThreadToDisk(): void {
  if (
    activeThreadId &&
    !activeThreadId.startsWith("disk_") &&
    activeSessionId
  ) {
    activeThreadId = `disk_${activeSessionId}`;
  }
}

function ensureTranscriptHandlers(): TranscriptEventHandlers {
  if (transcriptHandlers) return transcriptHandlers;
  transcriptHandlers = new TranscriptEventHandlers({
    showWelcome,
    appendLine,
    appendThoughtDelta,
    appendProcessText,
    beginTurn,
    endTurn,
    armTurnForLiveStream,
    setTurnStatus,
    endStreamBubble,
    markToolStarted,
    markToolCompleted,
    markToolIncomplete,
    maybeGoalFromToolRaw,
    notePlanArtifactFromTool,
    scheduleRefreshFileTree: (delayMs) =>
      sidePane?.scheduleRefreshFileTree(delayMs),
    showAskUserDialog,
    showPermission,
    showTurnErrorOnce,
    showAgentCrashBanner,
    refreshContextAfterCompact,
    syncGoalFromAgent,
    refreshContextUsage,
    maybeSurfacePlanAfterTurn,
    afterTurnSettled,
    markSessionWorking,
    setComposerBusy,
    demoteLiveThreadToDisk,
    getTurnActive: () => turnActive,
    isUserStopSuppressed,
    getTurnUiPhase: () => turnUiPhase,
    getAlreadyPaintedStopped: () => alreadyPaintedStopped,
    getAssistantStartedThisTurn: () => assistantStartedThisTurn,
    getBlockHistoryResyncAfterStop: () => blockHistoryResyncAfterStop,
    getActiveSessionId: () => activeSessionId,
  });
  return transcriptHandlers;
}

function ensureBusEventHandlers(): BusEventHandlers {
  if (busEventHandlers) return busEventHandlers;
  busEventHandlers = new BusEventHandlers({
    handleDeepLinkPayload,
    handleShellNavigate,
    handleShellNotice,
    onAppUpdate: (upd) => {
      settingsPage?.onAppUpdateEvent(upd);
      syncAppUpdateTopButton(upd);
    },
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    getTurnActive: () => turnActive,
    getTurnUiPhase: () => turnUiPhase,
    isUserStopSuppressed,
    eventBelongsToActiveSession,
    setAttachUiState: (state, lastError) =>
      setAttachUiState(state as AttachState, lastError),
    demoteLiveThreadToDisk,
    endTurn,
    setComposerBusy,
    markSessionWorking,
    reloadPromptQueueFromHost,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    applyAvailableCommandsEvent: (ev) =>
      applyAvailableCommandsEvent(
        ev as Parameters<AvailableCommandsCache["applyEvent"]>[0],
      ),
    scheduleRefreshFileTree: () => sidePane?.scheduleRefreshFileTree(),
    handlePlanApprovalRequested: (ev) =>
      handlePlanApprovalRequested(
        ev as Parameters<PlanEventHandlers["handleApprovalRequested"]>[0],
      ),
    handlePlanModeChanged: (ev) =>
      handlePlanModeChanged(
        ev as Parameters<PlanEventHandlers["handleModeChanged"]>[0],
      ),
    applyAgentGoalEvent: (ev) =>
      applyAgentGoalEvent(ev as Parameters<typeof applyAgentGoalEvent>[0]),
    handleSubagentUpdated: (ev) =>
      handleSubagentUpdated(
        ev as Parameters<typeof handleSubagentUpdated>[0],
      ),
    handleTaskUpdated: (ev) =>
      handleTaskUpdated(ev as Parameters<typeof handleTaskUpdated>[0]),
  });
  return busEventHandlers;
}

function ensureSubagentTaskHandlers(): SubagentTaskEventHandlers {
  if (subagentTaskHandlers) return subagentTaskHandlers;
  subagentTaskHandlers = new SubagentTaskEventHandlers({
    getActiveSessionId: () => activeSessionId,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    appendProcessText,
    applySubagentUpdate: (ev) => sidePane?.applySubagentUpdate(ev),
    rememberTaskSnap,
  });
  return subagentTaskHandlers;
}

function ensureGoalRuntime(): GoalRuntimeActions {
  if (goalRuntime) return goalRuntime;
  goalRuntime = new GoalRuntimeActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    confirmText,
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    ensureLiveThread,
    isPlanOn,
    getProjection: () => goalProjection,
    setProjection: (p) => {
      goalProjection = p;
    },
    getPendingTitle: () => pendingGoalTitle,
    setPendingTitle: (t) => {
      pendingGoalTitle = t;
    },
    getComposeActive: () => goalComposeActive,
    setComposeActive: (v) => {
      goalComposeActive = v;
    },
    getTokenBudget: () => goalTokenBudget,
    setTokenBudget: (n) => {
      goalTokenBudget = n;
    },
    getElapsedAnchorAt: () => goalElapsedAnchorAt,
    setElapsedAnchorAt: (n) => {
      goalElapsedAnchorAt = n;
    },
    getLocalClearedIds: () => goalLocalClearedIds,
    getCompleteHideTimer: () => goalCompleteHideTimer,
    setCompleteHideTimer: (t) => {
      goalCompleteHideTimer = t;
    },
    getSessionModeChipFocus: () => sessionModeChipFocus,
    setSessionModeChipFocus: (f) => {
      sessionModeChipFocus = f;
    },
    setComposerPlaceholders,
    syncSessionModeChips,
    renderBanner: () => renderGoalBanner(),
    stopSyncTimer: () => stopGoalSyncTimer(),
    stopElapsedTimer: () => stopGoalElapsedTimer(),
    elapsedMsNow: () => goalElapsedMsNow(),
    currentTitle: () => currentGoalTitle(),
    paused: () => goalPaused(),
    completed: () => goalCompleted(),
    refreshTurnPhaseActivityLabel,
    scheduleReconcileTurnAfterGoalStopped,
    activeComposerInput: () => activeComposerInput(),
    promptEditGoal,
    runGoalCommand,
  });
  return goalRuntime;
}

function ensureBtwActions(): BtwActions {
  if (btwActions) return btwActions;
  btwActions = new BtwActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    showWelcome,
    appendLine,
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    getSessionViewGen: () => sessionViewGen,
    getTurnActive: () => turnActive,
    getTurnUiPhase: () => turnUiPhase,
    ensureLiveThread,
    openBtwCategory: (focusInput) =>
      sidePane?.openBtwCategory(focusInput) ?? false,
    syncBtwAvailability: () => {
      sidePane?.syncBtwAvailability();
    },
    paintExchangeUi: (sessionId, ex, opts) =>
      applyBtwExchangeUi(sessionId, ex, opts),
    rebindForSession: (sessionId) => rebindBtwSideForSession(sessionId),
    syncComposer: (sessionId) => syncBtwSideComposer(sessionId),
    stopQuestion: () => stopBtwSideQuestion(),
    clearThread: () => clearBtwSideThread(),
    activeComposerInput: () => activeComposerInput(),
    takeComposerPrompt: () => takeComposerPrompt(),
    recordPromptHistory,
    scrollTranscriptIfSticky,
    getTranscriptEl: () => document.getElementById("transcript"),
  });
  return btwActions;
}

function ensureSlashDispatch(): SlashDispatch {
  if (slashDispatch) return slashDispatch;
  slashDispatch = new SlashDispatch({
    getAccessMode: () => accessMode,
    setAccessMode: (mode) => {
      accessMode = mode;
    },
    isPlanOn,
    syncSessionPolicyLive,
    syncPermLabels,
    exitPlanMode,
    enterPlanMode,
    showViewPlan,
    runGoalCommand,
    promptSetMaxTurns,
    findSkillPathFromPaletteCache,
    runResolvedSkillSlash,
    insertComposerText,
    runMemoryCommand,
    promptSetModel,
    isWelcomeVisible: () => !$("welcome").classList.contains("hidden"),
    getModelMenuAnchorWelcome: () => $("btn-model"),
    getModelMenuAnchorChat: () => $("btn-model-2"),
    showModelMenu,
    showContextDetails,
    applySessionModelAndEffort,
    promptSetEffort,
    showStatus: () => ensureSessionOps().showStatus(),
    exportActiveSession,
    compactActiveSession,
    forkActiveSession,
    rewindViaSlash,
    showPromptQueueModal,
    promptQueueLength: () => ensurePromptQueue().length,
    clearPromptQueue,
    showTasksPanel,
    showPromptHistorySearch,
    runBtwCommand,
    runInterjectCommand,
    permLabel,
    getComposerInput: () => $("composer-input") as HTMLTextAreaElement,
    getChatInput: () => $("chat-input") as HTMLTextAreaElement,
    getFocusInput: () => $("focus-input") as HTMLTextAreaElement,
    isChatVisible: () => !$("chat").classList.contains("hidden"),
  });
  return slashDispatch;
}

function ensureShellNav(): ShellNavActions {
  if (shellNavActions) return shellNavActions;
  shellNavActions = new ShellNavActions({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    showWelcome,
    getModalBody: () => $("modal-body"),
    getThreads: () => threads,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    refreshProjectsAndThreads,
    openThread,
  });
  return shellNavActions;
}

function ensureGoalBanner(): GoalBannerUi {
  if (goalBannerUi) return goalBannerUi;
  goalBannerUi = new GoalBannerUi({
    getProjection: () => goalProjection,
    getPendingTitle: () => pendingGoalTitle,
    getComposeActive: () => goalComposeActive,
    getElapsedAnchorAt: () => goalElapsedAnchorAt,
    syncSessionModeChips,
    syncGoalFromAgent: () => syncGoalFromAgent(),
  });
  return goalBannerUi;
}

function ensureContextUi(): ContextUi {
  if (contextUi) return contextUi;
  contextUi = new ContextUi({
    inv,
    esc,
    getActiveSessionId: () => activeSessionId,
    openModal,
    closeModal,
    fetchSessionInfoForActive: () => fetchSessionInfoForActive(),
    bindModalCancel: (onCancel) => {
      const el = document.getElementById("prompt-dlg-cancel");
      if (el) el.onclick = () => onCancel();
    },
  });
  return contextUi;
}

function ensurePermMenu(): PermMenuUi {
  if (permMenuUi) return permMenuUi;
  permMenuUi = new PermMenuUi({
    getAccessMode: () => accessMode,
    hideModelMenu,
    hidePlusMenu,
    getMenuEl: () => document.getElementById("perm-menu"),
  });
  return permMenuUi;
}

function ensureComposerBind(): ComposerBindUi {
  if (composerBindUi) return composerBindUi;
  composerBindUi = new ComposerBindUi({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    resolveLocalFilePath,
    addAttachments,
  });
  return composerBindUi;
}

function ensurePlanPanel(): PlanPanelUi {
  if (planPanelUi) return planPanelUi;
  planPanelUi = new PlanPanelUi({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    getActiveCwd: () => activeCwd,
    getSessionViewGen: () => sessionViewGen,
    getPlanPhase: () => planPhase,
    setPlanPhase: (phase) => {
      planPhase = phase;
    },
    getPendingApproval: () => pendingPlanApproval,
    setPendingApproval: (p) => {
      pendingPlanApproval = p;
    },
    isPlanOn,
    syncPermLabels,
    syncSessionPolicyLive,
    paintAssistantHtml,
    openPlanCategory: () => {
      sidePane?.openPlanCategory();
    },
    closePlanCategory: () => {
      sidePane?.closePlanCategory();
    },
    setPlanRailActivity: (activity) => {
      sidePane?.setPlanRailActivity(activity);
    },
    hasSidePane: () => Boolean(sidePane),
    getTurnStatusText: () =>
      document.querySelector(".turn-status")?.textContent ??
      document.getElementById("turn-status")?.textContent ??
      "",
    setTurnStatus,
    removeTurnStatus,
    getTurnActive: () => turnActive,
    markSessionWorking,
    setComposerBusy,
    appendLine,
    paintUserMessage,
    showWelcome,
  });
  return planPanelUi;
}

function ensureTasksPanel(): TasksPanelUi {
  if (tasksPanelUi) return tasksPanelUi;
  tasksPanelUi = new TasksPanelUi({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    openModal,
    closeModal,
    getActiveSessionId: () => activeSessionId,
    ensureLiveThread,
    appendProcessText,
  });
  return tasksPanelUi;
}

function ensureMemoryBrowser(): MemoryBrowserUi {
  if (memoryBrowserUi) return memoryBrowserUi;
  memoryBrowserUi = new MemoryBrowserUi({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    openModal,
    closeModal,
    getActiveCwd: () => getActiveCwd(),
    getActiveThreadId: () => activeThreadId,
    ensureLiveThread,
  });
  return memoryBrowserUi;
}

function ensurePromptHistory(): PromptHistoryUi {
  if (promptHistoryUi) return promptHistoryUi;
  promptHistoryUi = new PromptHistoryUi({
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    openModal,
    closeModal,
    activeComposerInput,
    isSlashPaletteOpen: () => Boolean(slashPalette?.isOpen()),
  });
  return promptHistoryUi;
}

function ensureCrashBanner(): CrashBannerUi {
  if (crashBannerUi) return crashBannerUi;
  crashBannerUi = new CrashBannerUi({
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    getActiveCwd: () => activeCwd,
    getActiveThreadId: () => activeThreadId,
    setActiveThreadId: (id) => {
      activeThreadId = id;
    },
    appendLine,
    ensureLiveThread,
    refreshAgentAvailableCommands,
  });
  return crashBannerUi;
}

function ensurePlusMenu(): PlusMenuUi {
  if (plusMenuUi) return plusMenuUi;
  plusMenuUi = new PlusMenuUi({
    onPickFiles: () => pickAndAddAttachments(),
    onPlan: () =>
      runSlashCommand({
        id: "plan",
        title: tr("plan.modeChip"),
        description: "",
        action: { kind: "set-perm", mode: "plan" },
      }).then((r) => {
        if (r.message) showToast(r.message, r.ok ? "info" : "error");
      }),
    onGoal: () => runGoalCommand("set"),
  });
  return plusMenuUi;
}

function ensureProjectPicker(): ProjectPickerUi {
  if (projectPickerUi) return projectPickerUi;
  projectPickerUi = new ProjectPickerUi({
    esc,
    getProjects: () => projects,
    getSelectedProjectId: () => selectedProjectId,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    markChoiceTouched: () => {
      projectChoiceTouched = true;
    },
    setWelcomeTitle,
    showWelcome,
    refreshProjectsAndThreads,
  });
  return projectPickerUi;
}

function ensureAvailableCommands(): AvailableCommandsCache {
  if (availableCommandsCache) return availableCommandsCache;
  availableCommandsCache = new AvailableCommandsCache({
    inv,
    getActiveThreadId: () => activeThreadId,
    getActiveSessionId: () => activeSessionId,
    onChanged: () => {
      slashPalette?.invalidate();
    },
  });
  return availableCommandsCache;
}

function ensureAutomationsModal(): AutomationsModalUi {
  if (automationsModalUi) return automationsModalUi;
  automationsModalUi = new AutomationsModalUi({
    inv,
    esc,
    openModal,
    getProjects: () => projects,
  });
  return automationsModalUi;
}

function ensureSessionSearch(): SessionSearchUi {
  if (sessionSearchUi) return sessionSearchUi;
  sessionSearchUi = new SessionSearchUi({
    inv,
    esc,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getProjects: () => projects,
    getThreads: () => threads,
    getSelectedProject: () => selectedProject(),
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    markProjectChoiceTouched: () => {
      projectChoiceTouched = true;
    },
    showWelcome,
    refreshProjectsAndThreads,
    openThread,
    openPathInWorkspace,
  });
  return sessionSearchUi;
}

function ensurePromptQueue(): PromptQueueController {
  if (promptQueueCtrl) return promptQueueCtrl;
  promptQueueCtrl = new PromptQueueController({
    inv,
    esc,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    openModal,
    closeModal,
    getActiveSessionId: () => activeSessionId,
    getTurnActive: () => turnActive,
    getTurnUiPhase: () => turnUiPhase,
    dispatchAgentPrompt,
    runInterjectCommand,
    syncChatComposerReserve,
    scrollTranscriptIfSticky,
  });
  return promptQueueCtrl;
}

function ensureForkActions(): ForkActions {
  if (forkActions) return forkActions;
  forkActions = new ForkActions({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    getActiveCwd: () => activeCwd,
    getSelectedProject: () => selectedProject(),
    getModelLabel: () => modelLabel,
    getEffortLevel: () => effortLevel,
    getTurnActive: () => turnActive,
    cancelTurn: () => {
      void cancelTurn();
    },
    closePlanPanelOnSessionChange,
    threadDisplayTitle,
    getThreads: () => threads,
    setThreads: (next) => {
      threads = next;
    },
    openThread,
    refreshProjectsAndThreads,
  });
  return forkActions;
}

function ensureRewindActions(): RewindActions {
  if (rewindActions) return rewindActions;
  rewindActions = new RewindActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getTurnActive: () => turnActive,
    getActiveSessionId: () => activeSessionId,
    ensureLiveThread,
    confirmText,
    promptText,
    endTurn: () => endTurn(),
    truncateTranscriptFromPrompt,
    fillComposerAfterRewind: (text) => {
      const ta = (
        document.getElementById("chat")?.classList.contains("hidden")
          ? document.getElementById("composer-input")
          : document.getElementById("chat-input")
      ) as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = text;
        ta.focus();
      }
    },
    appendLine,
    setComposerBusy,
    markSessionWorking,
    refreshContextUsage,
    refreshProjectsAndThreads,
  });
  return rewindActions;
}

function ensureSessionOps(): SessionOpsActions {
  if (sessionOpsActions) return sessionOpsActions;
  sessionOpsActions = new SessionOpsActions({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    promptText,
    confirmText,
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    activeThreadRefId,
    getTurnActive: () => turnActive,
    ensureLiveThread,
    appendLine,
    refreshContextAfterCompact,
    refreshProjectsAndThreads,
    leaveThreadIfOpen,
    expandArchiveForProject: (projectId) => {
      ensureSidebarList().expandedArchiveIds.add(projectId);
    },
    getMaxTurnsLimit: () => maxTurnsLimit,
    setMaxTurnsLimit: (n) => {
      maxTurnsLimit = n;
    },
    getSelectedProject: () => selectedProject(),
    getActiveCwd: () => activeCwd,
    getModelLabel: () => modelLabel,
    getEffortLevel: () => effortLevel,
    effortLabel: () => effortLabel(),
    permLabel: () => permLabel(),
    getDefaultOpenTarget: () => defaultOpenTarget,
    setLastContextUsage,
    syncContextLabels,
    getThreads: () => threads,
    getProjects: () => projects,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    expandProject: (projectId) => {
      ensureSidebarList().expandedProjectIds.add(projectId);
    },
    openThread,
  });
  return sessionOpsActions;
}

function ensureTheme(): ThemeController {
  if (themeCtrl) return themeCtrl;
  themeCtrl = new ThemeController({ inv });
  themeCtrl.setPreferenceOnly(themePreference);
  themeCtrl.setAppearanceLight(appearanceLight);
  themeCtrl.setAppearanceDark(appearanceDark);
  return themeCtrl;
}

function ensurePermPromptUi(): PermPromptUi {
  if (permPromptUi) return permPromptUi;
  permPromptUi = new PermPromptUi({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    showWelcome,
    getAccessMode: () => accessMode,
    isPlanOn,
    setPlanPhaseActive: () => {
      planPhase = "active";
    },
    syncPermLabels,
  });
  return permPromptUi;
}

function ensureSkillActions(): SkillActions {
  if (skillActions) return skillActions;
  skillActions = new SkillActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveCwd: () => activeCwd,
    getSelectedProjectPath: () => selectedProject()?.path,
    getActiveSessionId: () => activeSessionId,
    ensureSessionForAgentSlash,
    showWelcome,
    appendLine,
    dispatchAgentPrompt,
    getStaticSlashCommands,
    runSlashCommand,
    activeComposerInput: () => activeComposerInput(),
    hideSlashPalette: () => {
      slashPalette?.hide();
    },
    findSkillPathFromPaletteCache,
  });
  return skillActions;
}

function ensureSessionPolicy(): SessionPolicyActions {
  if (sessionPolicyActions) return sessionPolicyActions;
  sessionPolicyActions = new SessionPolicyActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getAccessMode: () => accessMode,
    setAccessMode: (mode) => {
      accessMode = mode;
    },
    isPlanOn,
    getPlanPhase: () => planPhase,
    setPlanPhase: (phase) => {
      planPhase = phase;
    },
    getPendingApproval: () => pendingPlanApproval,
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    getActiveCwd: () => activeCwd,
    setActiveCwd,
    findThreadCwdBySession: (sessionId) =>
      threads.find((t) => t.sessionId === sessionId)?.cwd,
    ensureLiveThread,
    patchSessionPlan: (sessionId, patch) => {
      patchSessionPlan(sessionId, patch as Parameters<typeof patchSessionPlan>[1]);
    },
    getSessionModeChipFocus: () => sessionModeChipFocus,
    setSessionModeChipFocusOnly: (focus) => {
      sessionModeChipFocus = focus;
    },
    currentGoalTitle,
    getGoalComposeActive: () => goalComposeActive,
    setGoalComposeActive: (v) => {
      goalComposeActive = v;
    },
    goalCompleted,
    syncPermLabelsOnly: () => {
      const v = permLabel();
      for (const id of ["perm-label", "perm-label-2"] as const) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      }
    },
    openPlanPanel,
    syncPlanPanelChrome,
    setComposerPlaceholders,
    beginGoalCompose,
    runGoalCommand,
    activeComposerInput: () => activeComposerInput(),
  });
  return sessionPolicyActions;
}

function ensureGoalSlashActions(): GoalSlashActions {
  if (goalSlashActions) return goalSlashActions;
  goalSlashActions = new GoalSlashActions({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getActiveSessionId: () => activeSessionId,
    getGoalProjection: () => goalProjection,
    getGoalTokenBudget: () => goalTokenBudget,
    setGoalTokenBudget: (n) => {
      goalTokenBudget = n;
    },
    currentGoalTitle,
    goalCompleted,
    pauseGoal,
    resumeGoal,
    resetGoalUiState,
    renderGoalBanner,
    beginGoalCompose,
    markGoalLocalCleared: (goalId) => {
      goalLocalClearedIds.add(goalId);
    },
    sendAgentGoalSlash,
    applyGoalTitle,
    getPendingGoalTitle: () => pendingGoalTitle,
    agentContentForSend,
  });
  return goalSlashActions;
}

function ensureProjectActions(): ProjectActions {
  if (projectActions) return projectActions;
  projectActions = new ProjectActions({
    inv,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    getSelectedProjectId: () => selectedProjectId,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    setProjectChoiceTouched: (v) => {
      projectChoiceTouched = v;
    },
    getProjects: () => projects,
    onProjectRemovedFromSidebar: (id) => {
      const sb = ensureSidebarList();
      sb.expandedProjectIds.delete(id);
      sb.projectShowAllThreads.delete(id);
      sb.expandedArchiveIds.delete(id);
    },
    refreshProjectsAndThreads,
    setWelcomeTitle,
    showWelcome,
    getActiveThreadId: () => activeThreadId,
    getActiveSessionId: () => activeSessionId,
  });
  return projectActions;
}

function ensureModelSessionActions(): ModelSessionActions {
  if (modelSessionActions) return modelSessionActions;
  modelSessionActions = new ModelSessionActions({
    inv,
    openModal,
    closeModal,
    showToast: (text, kind) => showToast(text, kind ?? "info"),
    promptText,
    confirmText,
    getModelLabel: () => modelLabel,
    setModelId,
    getEffortLevel: () => effortLevel,
    setEffortLevel,
    effortLabel: (level) => effortLabel(level),
    getTurnActive: () => turnActive,
    getActiveSessionId: () => activeSessionId,
    getActiveThreadId: () => activeThreadId,
    getActiveCwd: () => activeCwd,
    ensureLiveThread,
    setDefaultModelLabel: (id) => {
      defaultModelLabel = id;
    },
    setDefaultEffortLevel: (level) => {
      defaultEffortLevel = level;
    },
    setModelsCache,
    getModelsCache,
    getMaxTurnsLimit: () => maxTurnsLimit,
    getAccessMode: () => accessMode,
    isPlanOn,
    getSelectedProject: () => selectedProject(),
    getSelectedProjectId: () => selectedProjectId,
    setSelectedProjectId: (id) => {
      selectedProjectId = id;
    },
    setProjectChoiceTouched: (v) => {
      projectChoiceTouched = v;
    },
    leaveCurrentSessionToWelcome,
    setActiveCwd,
    clearPromptHistoryStore,
    setWelcomeTitle,
    showWelcome,
    clearTranscript,
    setActiveThreadId: (id) => {
      activeThreadId = id;
    },
    setActiveSessionId: (id) => {
      activeSessionId = id;
    },
    syncChatTopTitle,
    onSessionChanged: () => {
      sidePane?.onSessionChanged();
    },
    expandChatsGroup: () => {
      ensureSidebarList().expandedProjectIds.add(CHATS_GROUP_ID);
    },
    setSuspendLiveTranscript: (v) => {
      suspendLiveTranscript = v;
    },
    startContextPolling,
    refreshProjectsAndThreads,
    focusChatInput: () => {
      ($("chat-input") as HTMLTextAreaElement | null)?.focus();
    },
  });
  return modelSessionActions;
}

function parseGoalInput(
  raw: string,
  opts?: { forceGoal?: boolean },
): ReturnType<typeof parseGoalInputPure> {
  return parseGoalInputPure(raw, {
    forceGoal: opts?.forceGoal,
    goalComposeActive,
  });
}

function resolveLocalFilePath(file: File): string {
  return resolveLocalFilePathPure(file, window.grokDesktop?.getPathForFile);
}


function selectedProject(): Project | undefined {
  return projects.find((p) => p.id === selectedProjectId);
}

function setWelcomeTitle(): void {
  const p = selectedProject();
  $("welcome-title").textContent = p
    ? tr("welcome.askProject", { title: p.title })
    : tr("welcome.askGeneric");
  $("project-chip-label").textContent = p?.title ?? tr("picker.usingNone");
  syncChatTopTitle();
}

/** Codex 式会话列顶栏标题：当前线程名 / 欢迎态文案 */
function syncChatTopTitle(): void {
  const el = document.getElementById("chat-top-title");
  if (!el) return;
  const row =
    threads.find((t) => t.sessionId === activeSessionId) ??
    threads.find((t) => t.id === activeThreadId);
  if (row || activeSessionId) {
    const title = threadDisplayTitle(row, activeSessionId ?? undefined);
    el.textContent = title;
    el.title = title;
    return;
  }
  const p = selectedProject();
  const fallback = p
    ? tr("welcome.askProject", { title: p.title })
    : tr("chat.topTitleEmpty");
  el.textContent = fallback;
  el.title = fallback;
}

function closeProjectPicker(): void {
  ensureProjectPicker().close();
}

function renderProjectPickerList(filter = ""): void {
  ensureProjectPicker().renderList(filter);
}

function openProjectPicker(): void {
  ensureProjectPicker().open({
    hideOtherMenus: () => {
      document.getElementById("perm-menu")?.classList.add("hidden");
    },
  });
}

function showWelcome(show: boolean): void {
  $("welcome").classList.toggle("hidden", !show);
  $("chat").classList.toggle("hidden", show);
  syncChatTopTitle();
  if (!show) {
    requestAnimationFrame(() => {
      syncChatComposerReserve();
      scrollTranscript();
    });
  }
}

/**
 * Codex 式：流式更新绑定到「当前 turn 的 assistant item」，
 * 绝不用「最后一个 assistant 气泡」跨 turn 拼接。
 */
let streamBubble: HTMLElement | null = null;
let streamRole: string | null = null;
/** 当前流式助手气泡的 raw markdown（仅本 turn） */
let streamAssistantRaw = "";
/** 当前 turn 的稳定 id；只允许匹配的流写入对应气泡 */
let currentTurnId = 0;
let streamTurnId = 0;
/**
 * When true, drop live transcript events (create/openThread race:
 * invoke 返回后仍可能有滞留的 session/update，会与 history 叠出双份气泡)。
 */
let suspendLiveTranscript = false;

// ── Codex 时间线：Turn 状态机 ──────────────────────────────
let turnActive = false;
/** S19 follow-up 队列状态 → PromptQueueController（ensurePromptQueue） */
/** Mode B 附着状态（驱动 pill） */
let attachUiState: AttachState = "history_only";

/**
 * S17 本会话 prompt 历史（最新在前）：
 * ↑ 空输入/光标行首召回；/history 模糊搜索插入。
 */
/** 当前 turn 开始时间（Working for / Worked for 计时） */
let turnStartedAt = 0;
let turnStatusEl: HTMLElement | null = null;
/** Codex 式时间线分隔：进行中 Working for / 结束后 Worked for */
let turnPhaseEl: HTMLElement | null = null;
let turnPhaseTimer: ReturnType<typeof setInterval> | null = null;
/** 完成态状态条淡出定时器 */
let turnStatusDoneTimer: ReturnType<typeof setTimeout> | null = null;
let thoughtBlockEl: HTMLElement | null = null;
let thoughtBodyEl: HTMLElement | null = null;
/** 方案 A：工具 + goal 验证过程默认折叠 */
let processBlockEl: HTMLElement | null = null;
let processBodyEl: HTMLElement | null = null;
let processItemCount = 0;
/** 当前 assistant 流是否写入过程块 */
let streamIsProcess = false;
let assistantStartedThisTurn = false;
/** sessionId → working（侧栏转圈） */
const workingSessions = new Set<string>();


function updateProcessHeader(): void {
  if (!processBlockEl) return;
  const label = processBlockEl.querySelector(".process-label");
  if (label) {
    // 对齐 Codex：已运行 N 条命令 / 过程摘要
    label.textContent =
      processItemCount > 0
        ? tr("process.expand") + ` · ${processItemCount}`
        : tr("process.label");
  }
  const hint = processBlockEl.querySelector(".process-hint");
  if (hint) {
    hint.textContent =
      processItemCount > 0 ? tr("process.expand") : tr("process.expandHint");
  }
}



function formatTurnWorking(ms: number): string {
  // 目标已停、回合仍 busy：勿用「工作中」装成自驱
  if (sessionActivityIsDraining(currentSessionActivity(true))) {
    return tr("goal.drainingFor", { time: formatElapsedCompact(ms) });
  }
  return tr("turn.workingFor", { time: formatElapsedCompact(ms) });
}

/**
 * 当前会话合成态（goal × turn）。
 * turnBusy 可显式传入（rehydrate 时用 willBusy，避免读到尚未 apply 的 turnActive）。
 */
function currentSessionActivity(turnBusy?: boolean): SessionActivity {
  const busy = turnBusy ?? turnActive;
  return deriveSessionActivity(
    {
      hasGoal: Boolean(goalProjection || pendingGoalTitle),
      goalActive:
        Boolean(goalProjection) &&
        goalProjection!.status === "active" &&
        !goalPaused() &&
        !goalCompleted(),
      goalPaused: goalPaused(),
      goalCompleted: goalCompleted(),
    },
    busy,
  );
}

/**
 * 历史回放 / 进会话后：收口仍标 running 的 tool 行（无 in-flight 时勿假忙）。
 */
function settleStaleRunningTools(opts?: { asFailed?: boolean }): void {
  const root = $("transcript");
  if (!root) return;
  const rows = Array.from(
    root.querySelectorAll(".line.tool.running"),
  ) as HTMLElement[];
  for (const row of rows) {
    const id = row.dataset.toolId;
    const nameEl = row.querySelector(".tool-name");
    const name = nameEl?.textContent?.trim() || undefined;
    markToolIncomplete(id, name, opts?.asFailed ?? true);
  }
}

/** goal/turn 变化后：刷新 Working 条文案（draining vs 自驱） */
function refreshTurnPhaseActivityLabel(): void {
  if (!turnActive || !turnPhaseEl?.isConnected) return;
  if (!turnPhaseEl.classList.contains("is-working")) return;
  const ms = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
  const lab = turnPhaseEl.querySelector(".turn-phase-label");
  const text = formatTurnWorking(ms);
  if (lab) lab.textContent = text;
  turnPhaseEl.setAttribute("aria-label", text);
  turnPhaseEl.classList.toggle(
    "is-draining",
    sessionActivityIsDraining(currentSessionActivity(true)),
  );
}

/**
 * goal 已 pause/complete 且 UI 仍 busy 时：用 Host promptInFlight 对账。
 * CLI：InfraPaused 在 turn 以基础设施错误结束后写入；若 wire 已 pause 而
 * Desktop 仍 spinner/停止钮，多为 turn.completed 丢失或 tool 未收口。
 * 仅在 Host 确认无 in-flight 时 endTurn——不乐观冒充已停。
 */
let goalTurnReconcileGen = 0;
async function reconcileTurnAfterGoalStopped(): Promise<void> {
  if (!turnActive || !activeSessionId) return;
  if (!goalPaused() && !goalCompleted()) return;
  const gen = ++goalTurnReconcileGen;
  const sid = activeSessionId;
  const st = await inv<{
    promptInFlight?: boolean;
    threadStatus?: string;
  }>("threads.attachState", {
    threadId:
      activeThreadId && !activeThreadId.startsWith("disk_")
        ? activeThreadId
        : undefined,
    sessionId: sid,
  });
  if (gen !== goalTurnReconcileGen) return;
  if (activeSessionId !== sid || !turnActive) return;
  if (!goalPaused() && !goalCompleted()) return;
  // 未 live / 查失败：勿强行 idle（可能仍在附着）
  if (!st.ok) return;
  const inFlight = st.data?.promptInFlight === true;
  if (inFlight) {
    // 真还在跑：只刷新 draining 文案，用户可点停止
    refreshTurnPhaseActivityLabel();
    return;
  }
  // Host 已无 prompt：结算 UI（工具按失败收口，勿绿勾冒充成功）
  settleStaleRunningTools({ asFailed: true });
  endTurn({ outcome: "worked", skipQueueDrain: false });
  refreshTurnPhaseActivityLabel();
}

/** goal → paused/complete 后调度对账（短延迟吃掉同帧 turn.completed） */
function scheduleReconcileTurnAfterGoalStopped(): void {
  // 350ms：让同帧/紧随的 turn.completed 先 endTurn
  window.setTimeout(() => {
    void reconcileTurnAfterGoalStopped();
  }, 350);
  // 二次：429/子代理失败后 agent 可能晚清 in-flight
  window.setTimeout(() => {
    void reconcileTurnAfterGoalStopped();
  }, 2000);
}


function stopTurnPhaseTimer(): void {
  if (turnPhaseTimer != null) {
    clearInterval(turnPhaseTimer);
    turnPhaseTimer = null;
  }
}

function clearTurnStatusDoneTimer(): void {
  if (turnStatusDoneTimer != null) {
    clearTimeout(turnStatusDoneTimer);
    turnStatusDoneTimer = null;
  }
}

/**
 * Codex：Working for {time} — 进行中分隔条，计时 live。
 * 挂在 transcript 末尾（工具/过程之后会自然落在活动段下方）。
 */
function ensureTurnPhaseWorking(): void {
  const root = $("transcript");
  if (!turnPhaseEl?.isConnected) {
    const div = document.createElement("div");
    div.className = "line turn-phase is-working";
    div.setAttribute("role", "status");
    div.innerHTML =
      `<span class="turn-phase-dots" aria-hidden="true"><i></i><i></i><i></i></span>` +
      `<span class="turn-phase-label"></span>`;
    root.appendChild(div);
    turnPhaseEl = div;
  } else {
    turnPhaseEl.classList.add("is-working");
    turnPhaseEl.classList.remove("is-done", "is-stopped", "is-history");
    // 工具/过程追加后仍把 Working 钉在时间线末尾
    if (turnPhaseEl.parentElement === root && root.lastElementChild !== turnPhaseEl) {
      root.appendChild(turnPhaseEl);
    }
  }
  let drainTick = 0;
  const tick = () => {
    if (!turnActive || !turnPhaseEl?.isConnected) return;
    const ms = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
    const lab = turnPhaseEl.querySelector(".turn-phase-label");
    const text = formatTurnWorking(ms);
    if (lab) lab.textContent = text;
    turnPhaseEl.setAttribute("aria-label", text);
    const draining = sessionActivityIsDraining(currentSessionActivity(true));
    turnPhaseEl.classList.toggle("is-draining", draining);
    // draining 时每 ~3s 再对账 Host（子代理 429 后 goal 先 pause、turn 晚清）
    if (draining) {
      drainTick += 1;
      if (drainTick % 3 === 0) {
        void reconcileTurnAfterGoalStopped();
      }
    } else {
      drainTick = 0;
    }
    // 每秒顺带把条钉回底部（tool/assistant 插入后）
    const rootEl = $("transcript");
    if (
      turnPhaseEl.parentElement === rootEl &&
      rootEl.lastElementChild !== turnPhaseEl
    ) {
      rootEl.appendChild(turnPhaseEl);
    }
  };
  tick();
  stopTurnPhaseTimer();
  turnPhaseTimer = setInterval(tick, 1000);
  refreshTurnPhaseActivityLabel();
  // 仅创建 Working 条时可能贴底；之后每秒钉位置不改 scroll
  scrollTranscriptIfSticky();
}

/**
 * Codex：Worked for / You stopped after — 固定留在时间线。
 * 必须钉在 transcript **末尾**（过程块 + 助手气泡之后）。
 * 旧逻辑插在 processBlock 后会把「已停止」挤到助手正文前面，
 * 看起来像「停了还在出毛玻璃长文」。
 */
function paintTurnPhaseDone(
  kind: "worked" | "stopped",
  elapsedMs: number,
): void {
  stopTurnPhaseTimer();
  const label =
    kind === "stopped"
      ? formatTurnStopped(elapsedMs)
      : formatTurnElapsed(elapsedMs);
  const root = $("transcript");
  // 复用进行中的 phase 节点，改成完成态（避免两条分隔）
  if (turnPhaseEl?.isConnected) {
    turnPhaseEl.classList.remove("is-working");
    turnPhaseEl.classList.add(kind === "stopped" ? "is-stopped" : "is-done");
    turnPhaseEl.innerHTML = `<span class="turn-phase-label">${esc(label)}</span>`;
    turnPhaseEl.setAttribute("aria-label", label);
    // 钉回末尾：助手气泡可能在 Working 条之后又追加了
    if (root.lastElementChild !== turnPhaseEl) {
      root.appendChild(turnPhaseEl);
    }
    scrollTranscriptIfSticky();
    return;
  }

  // 清掉旧 footer 类名节点（兼容）
  const stale = root.querySelector(".line.turn-elapsed");
  if (stale) stale.remove();

  const foot = document.createElement("div");
  foot.className = `line turn-phase ${kind === "stopped" ? "is-stopped" : "is-done"}`;
  foot.setAttribute("role", "status");
  foot.setAttribute("aria-label", label);
  foot.innerHTML = `<span class="turn-phase-label">${esc(label)}</span>`;
  root.appendChild(foot);
  turnPhaseEl = foot;
  scrollTranscriptIfSticky();
}

/** @deprecated 名保留；逻辑并入 paintTurnPhaseDone */
function paintProcessElapsedFooter(elapsedMs: number): void {
  paintTurnPhaseDone("worked", elapsedMs);
}

function ensureProcessBlock(): { block: HTMLElement; body: HTMLElement } {
  const el = $("transcript");
  if (processBlockEl?.isConnected && processBodyEl?.isConnected) {
    return { block: processBlockEl, body: processBodyEl };
  }
  const block = document.createElement("div");
  block.className = "line process-block collapsed";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "process-toggle";
  toggle.innerHTML = `<span class="process-label">${esc(tr("process.label"))}</span><span class="process-hint">${esc(tr("process.expand"))}</span><span class="process-caret">▸</span>`;
  const body = document.createElement("div");
  body.className = "process-body";
  toggle.onclick = () => {
    block.classList.toggle("collapsed");
    const c = toggle.querySelector(".process-caret");
    if (c) c.textContent = block.classList.contains("collapsed") ? "▸" : "▾";
  };
  block.appendChild(toggle);
  block.appendChild(body);
  if (turnStatusEl?.isConnected) {
    el.insertBefore(block, turnStatusEl);
  } else {
    el.appendChild(block);
  }
  processBlockEl = block;
  processBodyEl = body;
  processItemCount = 0;
  updateProcessHeader();
  return { block, body };
}

function appendProcessText(text: string): void {
  const t = text.trim();
  if (!t) return;
  const { body } = ensureProcessBlock();
  const last = body.lastElementChild as HTMLElement | null;
  if (last?.classList.contains("process-text") && last.dataset.streaming === "1") {
    last.textContent = (last.textContent ?? "") + text;
  } else {
    const p = document.createElement("div");
    p.className = "process-text";
    p.dataset.streaming = "1";
    p.textContent = text;
    body.appendChild(p);
    processItemCount += 1;
    updateProcessHeader();
  }
  scrollTranscriptIfSticky();
}

function endProcessTextStream(): void {
  if (!processBodyEl) return;
  const last = processBodyEl.lastElementChild as HTMLElement | null;
  if (last?.classList.contains("process-text")) {
    delete last.dataset.streaming;
  }
}

function appendProcessNode(node: HTMLElement): void {
  const { body } = ensureProcessBlock();
  body.appendChild(node);
  processItemCount += 1;
  updateProcessHeader();
  scrollTranscriptIfSticky();
}

function resetStreamState(finalize = true): void {
  if (finalize && streamRole === "assistant" && streamBubble?.isConnected) {
    const raw = streamBubble.dataset.raw ?? streamAssistantRaw;
    if (raw) {
      if (streamIsProcess || looksLikeGoalProcessText(raw)) {
        // 过程流：保持纯文本在过程块内
        endProcessTextStream();
      } else {
        paintAssistantHtml(streamBubble, raw, {
          highlight: true,
          cwd: activeCwd,
        });
      }
    }
  }
  streamBubble = null;
  streamRole = null;
  streamAssistantRaw = "";
  streamIsProcess = false;
  streamTurnId = 0;
  ensureChatScroll().cancelStreamRaf();
}

function clearTranscript(): void {
  $("transcript").innerHTML = "";
  nextUserPromptIndex = 0;
  resetStreamState(false);
  clearTurnStatusDoneTimer();
  stopTurnPhaseTimer();
  turnStatusEl = null;
  turnPhaseEl = null;
  thoughtBlockEl = null;
  thoughtBodyEl = null;
  processBlockEl = null;
  processBodyEl = null;
  processItemCount = 0;
  streamIsProcess = false;
  // 新时间线默认重新 stick
  ensureChatScroll().forceStick();
}


function showTurnErrorOnce(
  message: string | undefined,
  details?: unknown,
): void {
  const text = formatTurnErrorMessage(message, details);
  const key = normalizeAssistantForDedupe(text).slice(0, 120) || text;
  if (lastShownTurnError && lastShownTurnError.turnId === currentTurnId) {
    return;
  }
  lastShownTurnError = { turnId: currentTurnId, key };
  appendLine(text, "error");
}

function findDedupeAssistantBubble(
  turnId: number,
  nextRaw: string,
): HTMLElement | null {
  const el = $("transcript");
  const nodes = Array.from(
    el.querySelectorAll(".line.assistant"),
  ) as HTMLElement[];
  if (!nodes.length) return null;
  const nextN = normalizeAssistantForDedupe(nextRaw);
  if (nextN.length < 12) return null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.dataset.turnId && n.dataset.turnId !== String(turnId)) continue;
    const prev = (n.dataset.raw ?? n.textContent ?? "").trim();
    if (!prev) continue;
    if (assistantTextsRoughlyEqual(nextRaw, prev)) {
      return n;
    }
  }
  return null;
}

/** 流式：只追加纯文本（O(1) DOM 文本更新），不做 MD/高亮 */
function appendAssistantStream(el: HTMLElement, raw: string): void {
  paintAssistantStreaming(el, raw);
  ensureChatScroll().scheduleStreamScroll();
}

/** 定稿：完整 Markdown + 高亮 + 文件路径可点（每条消息一次） */
function flushAssistantMarkdown(el: HTMLElement | null): void {
  if (!el) return;
  ensureChatScroll().flushStreamScroll();
  const raw = el.dataset.raw ?? "";
  if (raw) {
    paintAssistantHtml(el, raw, { highlight: true, cwd: activeCwd });
    scrollTranscriptIfSticky();
  }
}

/** 发消息 / FAB / 进会话：强制 stick 并滚到底 */
function scrollTranscript(): void {
  ensureChatScroll().scrollToBottom();
}

/** 流式 / 工具 / DOM 变更：仅 stick 时贴底，否则零写入 */
function scrollTranscriptIfSticky(): void {
  ensureChatScroll().scrollIfSticky();
}

/** 底栏贴底：消息区优先让位 */
function syncChatComposerReserve(): void {
  ensureChatScroll().syncComposerReserve();
}

function bindChatScrollLayout(): void {
  ensureChatScroll().bind();
}

/** 空闲 / 进行中：仅由发送钮 arrow-up / stop 表达（方案 2） */
function setComposerBusy(busy: boolean): void {
  for (const id of ["btn-send", "btn-send-chat"] as const) {
    const b = $(id);
    if (busy) {
      b.classList.add("stop");
      b.innerHTML = sendButtonIconHtml(true);
      b.title = tr("common.stop");
      b.setAttribute("aria-label", tr("common.stop"));
    } else {
      b.classList.remove("stop");
      b.innerHTML = sendButtonIconHtml(false);
      b.title = tr("common.send");
      b.setAttribute("aria-label", tr("common.send"));
    }
  }
  syncPromptQueueBar();
}

/** S19 follow-up 队列 → PromptQueueController（保留入口名供 boot/onEvent 绑定） */
const syncPromptQueueBar = () => ensurePromptQueue().syncBar();
const applyHostQueueMirror = (
  file: Parameters<PromptQueueController["applyHostMirror"]>[0],
) => ensurePromptQueue().applyHostMirror(file);
const reloadPromptQueueFromHost = () => ensurePromptQueue().reloadFromHost();
const clearPromptQueue = (opts?: { silent?: boolean }) =>
  ensurePromptQueue().clear(opts);
const removeQueuedPrompt = (id: string) => ensurePromptQueue().remove(id);
const appendQueuedSystemLine = (id: string, preview: string) =>
  ensurePromptQueue().appendQueuedSystemLine(id, preview);
const interjectQueuedPrompt = (id: string) => ensurePromptQueue().interject(id);
const sendNowQueuedPrompt = (id: string) => ensurePromptQueue().sendNow(id);
const moveQueuedPrompt = (id: string, dir: -1 | 1) =>
  ensurePromptQueue().move(id, dir);
const openEditQueuedPrompt = (id: string) => ensurePromptQueue().openEdit(id);
const resumePromptQueue = () => ensurePromptQueue().resume();
const enqueuePrompt = (item: {
  display: string;
  content: string;
  attachments: ComposerAttachment[];
  status?: "pending" | "sending" | "failed";
  lastError?: string | null;
}) => ensurePromptQueue().enqueue(item);
const scheduleDrainPromptQueue = () => ensurePromptQueue().scheduleDrain();
const showPromptQueueModal = () => ensurePromptQueue().showModal();

/** S20：后台任务面板 → TasksPanelUi */
const rememberTaskSnap = (ev: {
  sessionId?: string;
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  exitCode?: number | null;
}) => ensureTasksPanel().noteUpdated(ev);
const showTasksPanel = () => ensureTasksPanel().show();

/** agent available_commands → AvailableCommandsCache */
const refreshAgentAvailableCommands = () => ensureAvailableCommands().refresh();
const applyAvailableCommandsEvent = (
  ev: Parameters<AvailableCommandsCache["applyEvent"]>[0],
) => ensureAvailableCommands().applyEvent(ev);

/** R4：agent 崩溃条 → CrashBannerUi */
const showAgentCrashBanner = (message?: string) =>
  ensureCrashBanner().show(message);
const hideAgentCrashBanner = () => ensureCrashBanner().hide();

// ── S17 prompt history → PromptHistoryUi ───────────────────
const clearPromptHistoryStore = () => ensurePromptHistory().clear();
const recordPromptHistory = (text: string) => ensurePromptHistory().record(text);
const seedPromptHistoryFromUserTexts = (texts: string[]) =>
  ensurePromptHistory().seedFromUserTexts(texts);
const handlePromptHistoryKey = (ta: HTMLTextAreaElement, e: KeyboardEvent) =>
  ensurePromptHistory().handleKey(ta, e);
const showPromptHistorySearch = () => ensurePromptHistory().showSearch();

/**
 * 方案 B：把当前主区 turn 投影快照到 session 槽（切走前调用）。
 * 对齐 CLI：每个 agent 自带 TurnRunning，切换不清 Host turn。
 */
function snapshotActiveSessionTurn(sessionId: string | null | undefined): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  const prev = getSessionTurn(sid);
  setSessionTurn(sid, {
    turnActive,
    turnUiPhase,
    alreadyPaintedStopped,
    turnStartedAt,
    assistantStartedThisTurn,
    streamArmedThisTurn,
    blockHistoryResyncAfterStop,
    userStopSuppressUntil,
    lateStreamUntil,
    currentTurnId,
    pendingAssistantText: prev?.pendingAssistantText ?? "",
    updatedAtMs: Date.now(),
  });
}

/** 将 store 投影应用到主区全局变量（不含 DOM 补画） */
function applySessionTurnProjection(p: SessionTurnProjection): void {
  turnActive = p.turnActive;
  turnUiPhase = p.turnUiPhase;
  alreadyPaintedStopped = p.alreadyPaintedStopped;
  turnStartedAt = p.turnStartedAt > 0 ? p.turnStartedAt : p.turnActive ? Date.now() : 0;
  assistantStartedThisTurn = p.assistantStartedThisTurn;
  streamArmedThisTurn = p.streamArmedThisTurn;
  blockHistoryResyncAfterStop = p.blockHistoryResyncAfterStop;
  userStopSuppressUntil = p.userStopSuppressUntil;
  lateStreamUntil = p.lateStreamUntil;
  if (p.currentTurnId > currentTurnId) currentTurnId = p.currentTurnId;
  streamTurnId = p.turnActive && p.streamArmedThisTurn ? currentTurnId : 0;
}

/**
 * 切回会话：按 Host promptInFlight / 投影 / 侧栏 恢复 busy 主区。
 * promptInFlight===false 时强制 idle（后台已完成不可再显示工作中）。
 */
function rehydrateSessionTurnProjection(
  sessionId: string,
  opts?: {
    threadStatus?: string;
    promptInFlight?: boolean;
  },
): void {
  const proj = getSessionTurn(sessionId);
  const busy = shouldRehydrateBusy({
    projection: proj,
    sidebarWorking: workingSessions.has(sessionId),
    threadStatus: opts?.threadStatus,
    promptInFlight: opts?.promptInFlight,
  });
  if (!busy) {
    // 与 Host 对齐：清过期 busy 投影
    markSessionTurnIdle(sessionId);
    markSessionWorking(sessionId, false);
    turnActive = false;
    turnUiPhase = "idle";
    turnStartedAt = 0;
    streamArmedThisTurn = false;
    streamTurnId = 0;
    setComposerBusy(false);
    removeTurnStatus();
    stopTurnPhaseTimer();
    // P0：无 in-flight 时收口假 running tool
    settleStaleRunningTools({ asFailed: true });
    if (turnPhaseEl?.isConnected && turnPhaseEl.classList.contains("is-working")) {
      // 历史已画完回复时，去掉卡住的「工作中」条
      turnPhaseEl.remove();
      turnPhaseEl = null;
    }
    return;
  }
  const base = proj ?? {
    ...idleProjection(),
    turnActive: true,
    turnUiPhase: "working" as TurnUiPhase,
    turnStartedAt: Date.now(),
    streamArmedThisTurn: true,
  };
  applySessionTurnProjection({
    ...base,
    turnActive: true,
    turnUiPhase:
      base.turnUiPhase === "cancelling" ? "cancelling" : "working",
    streamArmedThisTurn: true,
  });
  if (currentTurnId <= 0) currentTurnId = 1;
  streamTurnId = currentTurnId;
  setComposerBusy(true);
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  ensureTurnStatus(tr("turn.thinking"));
  ensureTurnPhaseWorking();
  // P1：目标已暂停时 Working 条显示「收尾中」
  refreshTurnPhaseActivityLabel();
  // 切走期间积压的助手增量（history 可能尚未落盘）
  const pending = (proj?.pendingAssistantText || "").trim();
  if (pending) {
    appendLine(pending, "assistant", { fromStream: true });
    patchSessionTurn(sessionId, { pendingAssistantText: "" });
  }
}

/** 当前会话 turn 变化时写回 store，保持与 CLI AgentView.state 同步 */
function syncActiveSessionTurnToStore(): void {
  if (!activeSessionId) return;
  snapshotActiveSessionTurn(activeSessionId);
}

function markSessionWorking(sessionId: string | null, working: boolean): void {
  if (!sessionId) return;
  if (working) workingSessions.add(sessionId);
  else workingSessions.delete(sessionId);
  // 侧栏 ↔ 投影：idle 必须清 turnActive（修后台完成后仍 rehydrate busy）
  if (!working) {
    markSessionTurnIdle(sessionId);
  } else if (sessionId !== activeSessionId) {
    const p = getSessionTurn(sessionId);
    if (!p?.turnActive) {
      patchSessionTurn(sessionId, {
        turnActive: true,
        turnUiPhase: "working",
        turnStartedAt: p?.turnStartedAt || Date.now(),
        streamArmedThisTurn: true,
      });
    }
  }
  // 轻量刷新侧栏 working 样式（不全量 rebuild 时只改 class）
  const list = $("project-list");
  Array.from(list.querySelectorAll<HTMLElement>(".thread-item")).forEach(
    (row) => {
      const sid = row.dataset.sessionId;
      if (!sid) return;
      const on = workingSessions.has(sid);
      row.classList.toggle("working", on);
      const main =
        row.querySelector<HTMLElement>(".thread-item-main") ?? row;
      let spin = main.querySelector(".thread-spin");
      if (on && !spin) {
        spin = document.createElement("span");
        spin.className = "thread-spin";
        main.insertBefore(spin, main.firstChild);
      } else if (!on && spin) {
        spin.remove();
      }
    },
  );
}

function ensureTurnStatus(label = tr("turn.thinking")): HTMLElement {
  clearTurnStatusDoneTimer();
  if (turnStatusEl && turnStatusEl.isConnected) {
    turnStatusEl.classList.remove("is-done", "is-stopped");
    const lab = turnStatusEl.querySelector(".status-label");
    if (lab) lab.textContent = label;
    // 恢复进行中圆点
    if (!turnStatusEl.querySelector(".status-dots")) {
      turnStatusEl.innerHTML = `<span class="status-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="status-label">${esc(label)}</span>`;
    }
    return turnStatusEl;
  }
  const el = $("transcript");
  const div = document.createElement("div");
  div.className = "line turn-status";
  div.innerHTML = `<span class="status-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="status-label">${esc(label)}</span>`;
  el.appendChild(div);
  turnStatusEl = div;
  scrollTranscriptIfSticky();
  return div;
}

function removeTurnStatus(): void {
  clearTurnStatusDoneTimer();
  if (turnStatusEl?.isConnected) turnStatusEl.remove();
  turnStatusEl = null;
}

/** 结束时：状态条改完成文案，短暂保留后移除（不立刻消失） */
function promoteTurnStatusToDone(
  label: string,
  kind: "done" | "stopped" = "done",
): void {
  clearTurnStatusDoneTimer();
  if (!turnStatusEl?.isConnected) {
    const div = document.createElement("div");
    div.className = `line turn-status ${kind === "stopped" ? "is-stopped" : "is-done"}`;
    div.innerHTML = `<span class="status-check" aria-hidden="true">${kind === "stopped" ? "■" : "✓"}</span><span class="status-label">${esc(label)}</span>`;
    $("transcript").appendChild(div);
    turnStatusEl = div;
  } else {
    turnStatusEl.classList.add(kind === "stopped" ? "is-stopped" : "is-done");
    turnStatusEl.classList.remove("is-working");
    turnStatusEl.innerHTML = `<span class="status-check" aria-hidden="true">${kind === "stopped" ? "■" : "✓"}</span><span class="status-label">${esc(label)}</span>`;
  }
  scrollTranscriptIfSticky();
  turnStatusDoneTimer = setTimeout(() => {
    turnStatusDoneTimer = null;
    if (turnStatusEl?.isConnected) {
      turnStatusEl.classList.add("is-fading");
      const el = turnStatusEl;
      window.setTimeout(() => {
        if (el.isConnected) el.remove();
        if (turnStatusEl === el) turnStatusEl = null;
      }, 320);
    }
  }, 2800);
}

function setTurnStatus(label: string): void {
  if (!turnActive) return;
  ensureTurnStatus(label);
  // 工具名变化时同步刷新 Working for 旁的辅助信息（可选）
  if (turnPhaseEl?.classList.contains("is-working")) {
    const ms = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
    const lab = turnPhaseEl.querySelector(".turn-phase-label");
    const text = formatTurnWorking(ms);
    if (lab) lab.textContent = text;
  }
}


function beginTurn(): void {
  // 先定稿并切断上一 turn 的流式指针，防止新 delta 拼进旧气泡
  resetStreamState(true);
  clearTurnStatusDoneTimer();
  stopTurnPhaseTimer();
  // 若上一轮刚用户停止：保持 suppress，streamTurnId=0，streamArmed=false，
  // 直到 Host 发出本轮 turn.started（闸门已开：prompt 在线 + 残留静默）再 arm。
  // 注意：turns.prompt IPC 要等整轮结束才返回，绝不能在 inv 成功后再 arm。
  const holdSuppress = isUserStopSuppressed();
  // 新回合开始：上一轮 phase 留在时间线，本轮新建
  turnPhaseEl = null;
  turnActive = true;
  turnUiPhase = "working";
  alreadyPaintedStopped = false;
  lateStreamUntil = 0;
  turnStartedAt = Date.now();
  currentTurnId += 1;
  if (holdSuppress) {
    streamTurnId = 0;
    streamArmedThisTurn = false;
  } else {
    userStopSuppressUntil = 0;
    streamTurnId = currentTurnId;
    streamArmedThisTurn = true;
  }
  assistantStartedThisTurn = false;
  lastShownTurnError = null;
  thoughtBlockEl = null;
  thoughtBodyEl = null;
  processBlockEl = null;
  processBodyEl = null;
  processItemCount = 0;
  streamIsProcess = false;
  ensureTurnStatus(tr("turn.thinking"));
  ensureTurnPhaseWorking();
  setComposerBusy(true);
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  syncActiveSessionTurnToStore();
}

/**
 * Host 已打开本轮流闸门（turn.started）后调用。
 * 解除停止抑制并接受流式。turns.prompt IPC 返回太晚，不能依赖它。
 * 注意：arm **不**解除 blockHistoryResyncAfterStop（Phase3：防 T2 空完成贴 T1 落盘）。
 */
function armTurnForLiveStream(): void {
  userStopSuppressUntil = 0;
  streamTurnId = currentTurnId;
  streamArmedThisTurn = true;
  lateStreamUntil = 0;
  if (armClearsHistoryResyncBlock()) {
    blockHistoryResyncAfterStop = false;
  }
  syncActiveSessionTurnToStore();
}

/** 本 turn 出现过干净助手流 → 允许后续 history 回补 */
function noteCleanAssistantStream(text: string): void {
  if (!blockHistoryResyncAfterStop) return;
  if (!isCleanAssistantStreamForResyncUnlock(text)) return;
  blockHistoryResyncAfterStop = false;
}

/** 时间线最后一条用户可见正文（供 history 回补对齐） */
function timelineLastUserText(): string {
  const blocks = $("transcript").querySelectorAll(".user-msg-block");
  if (blocks.length) {
    const last = blocks[blocks.length - 1] as HTMLElement;
    const raw = last.dataset.rawText ?? "";
    if (raw.trim()) return raw.replace(/\s+/g, " ").trim().slice(0, 120);
    const textEl =
      last.querySelector(".user-msg-text") ||
      last.querySelector(".msg-user-text") ||
      last.querySelector(".msg-text");
    return (textEl?.textContent ?? last.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }
  const lines = $("transcript").querySelectorAll(".line.user");
  if (lines.length) {
    return (lines[lines.length - 1].textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }
  return "";
}

/** 用户刚点停止：丢弃会复活 turn 的迟到直播事件 */
function isUserStopSuppressed(): boolean {
  return userStopSuppressUntil > 0 && Date.now() < userStopSuppressUntil;
}

function endTurn(opts?: {
  keepThought?: boolean;
  skipQueueDrain?: boolean;
  /** 对齐 Codex：正常完成 Worked for / 用户停止 You stopped after */
  outcome?: "worked" | "stopped";
  /**
   * 方案 B：切会话清主区时勿把「仍在后台跑」的投影写成 idle。
   * 调用方须已 snapshotActiveSessionTurn；且勿 markSessionWorking(false)。
   */
  skipSessionStoreSync?: boolean;
}): void {
  // 无活跃回合时只做清理，不画「已完成 · 0ms」（openThread/rewind 会误触）
  const hadTurn = turnActive || turnStartedAt > 0;
  const outcome = opts?.outcome ?? "worked";
  const preserveBgWorking = opts?.skipSessionStoreSync === true;

  // Phase4：乐观 stop 后迟到 endTurn(stopped) — 只清 busy，不二次 paint
  if (
    outcome === "stopped" &&
    !shouldPaintStoppedPhase({ alreadyPaintedStopped })
  ) {
    turnActive = false;
    if (turnUiPhase !== "cancelling") turnUiPhase = "idle";
    lateStreamUntil = 0;
    setComposerBusy(false);
    if (activeSessionId && !preserveBgWorking) {
      markSessionWorking(activeSessionId, false);
    }
    removeTurnStatus();
    if (!opts?.skipSessionStoreSync) syncActiveSessionTurnToStore();
    if (!opts?.skipQueueDrain) scheduleDrainPromptQueue();
    return;
  }

  // 正常完成：短窗口接受本 turn 末包；用户停止：禁止任何迟到流/回补
  if (hadTurn && outcome !== "stopped") {
    lateStreamUntil = Date.now() + 4000;
  } else if (outcome === "stopped") {
    lateStreamUntil = 0;
  }
  const elapsed = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
  turnActive = false;
  if (outcome === "stopped") {
    alreadyPaintedStopped = true;
    // cancelling 保持到 cancelTurn finally；否则 idle
    if (turnUiPhase !== "cancelling") turnUiPhase = "idle";
  } else {
    turnUiPhase = "idle";
    alreadyPaintedStopped = false;
  }
  stopTurnPhaseTimer();

  endProcessTextStream();
  // 折叠思考块（保留在时间线）
  if (thoughtBlockEl?.isConnected && !opts?.keepThought) {
    thoughtBlockEl.classList.add("collapsed");
    const caret = thoughtBlockEl.querySelector(".thought-caret");
    if (caret) caret.textContent = "▸";
  }
  // 过程块默认收起
  if (processBlockEl?.isConnected) {
    processBlockEl.classList.add("collapsed");
    const caret = processBlockEl.querySelector(".process-caret");
    if (caret) caret.textContent = "▸";
    updateProcessHeader();
  }
  if (hadTurn) {
    // Codex：Worked for / You stopped after — 有无过程块都固定留下
    paintTurnPhaseDone(outcome === "stopped" ? "stopped" : "worked", elapsed);
    if (outcome === "stopped") {
      // 停止只保留 turn-phase 一条「已停止」，勿再 promote 状态条（会双条）
      removeTurnStatus();
    } else {
      // 正常完成：状态条短暂显示完成态再淡出
      promoteTurnStatusToDone(formatTurnElapsed(elapsed), "done");
    }
  } else {
    removeTurnStatus();
  }

  turnStartedAt = 0;
  // 未完成的 tool 行：停止/错误/目标已停 → 失败收口；正常完成才绿勾
  const toolAsFailed =
    outcome === "stopped" || goalPaused() || goalCompleted();
  Array.from(
    $("transcript").querySelectorAll(".line.tool.running"),
  ).forEach((row) => {
    const id = (row as HTMLElement).dataset.toolId;
    const nameEl = row.querySelector(".tool-name");
    const name = nameEl?.textContent?.trim() || undefined;
    if (toolAsFailed) {
      markToolIncomplete(id, name, true);
      return;
    }
    row.classList.remove("running");
    row.classList.add("done");
    const spin = row.querySelector(".tool-spin");
    if (spin) {
      spin.classList.add("done");
      spin.textContent = "✓";
    }
    const st = row.querySelector(".tool-state");
    if (st) st.textContent = tr("tool.completed");
  });
  setComposerBusy(false);
  // 切会话：保留侧栏 working + store 快照，勿 mark false
  if (activeSessionId && !preserveBgWorking) {
    markSessionWorking(activeSessionId, false);
  }
  // 定稿当前助手 Markdown，但保留 stream 指针，供 grace 内迟到 delta 续写
  if (
    streamRole === "assistant" &&
    streamBubble?.isConnected &&
    streamBubble.classList.contains("assistant")
  ) {
    flushAssistantMarkdown(streamBubble);
    streamBubble.classList.remove("streaming");
  } else {
    endStreamBubble();
  }
  // 方案 B：同步投影（切会话时 skip，避免覆盖切前 snapshot）
  if (!opts?.skipSessionStoreSync) syncActiveSessionTurnToStore();
  // S19：turn 结束后发送队首 follow-up（force 续发时跳过，避免与新 prompt 竞态）
  if (!opts?.skipQueueDrain) scheduleDrainPromptQueue();
}

/**
 * P0-A：历史回放结束 — 仅弱提示「已加载历史 · N」。
 * 空闲语义交给发送钮 ↑；勿与 Working 混淆，不写「会话空闲」。
 */
function paintHistoryReplayDone(entryCount: number): void {
  removeTurnStatus();
  stopTurnPhaseTimer();
  // 历史不是进行中 turn，切断 phase 指针
  if (turnPhaseEl?.classList.contains("is-working")) {
    turnPhaseEl.remove();
  }
  turnPhaseEl = null;
  turnStartedAt = 0;

  if (entryCount <= 0) return;

  const main = tr("history.replayDone", { n: String(entryCount) });
  const div = document.createElement("div");
  div.className = "line turn-phase is-history";
  div.setAttribute("role", "status");
  div.setAttribute("aria-label", main);
  div.innerHTML = `<span class="turn-phase-label">${esc(main)}</span>`;
  $("transcript").appendChild(div);
  scrollTranscript();
}

/**
 * 用户停止当前 turn。
 * - interrupt 语义：默认保留队列并 pause 自动 drain（对齐 CLI/Codex）
 * - send_now：不 pause 队列（用户在继续工作）
 * - 立即结算 UI；Host session/cancel 带 _meta
 * - 并发 stop 加入同一 cancelInFlight
 * - trigger：stop | esc | send_now
 */
async function cancelTurn(opts?: {
  clearQueue?: boolean;
  /** CLI cancelTrigger：stop | esc | send_now */
  trigger?: string;
  /**
   * 是否 pause 自动 drain。
   * 默认 true（Stop/Esc）；send_now 传 false。
   */
  pauseQueue?: boolean;
}): Promise<void> {
  // Phase4：Cancelling 中二次 stop → join，不新开、不双条
  if (
    shouldJoinInFlightCancel({ cancelInFlight: Boolean(cancelTurnInFlight) })
  ) {
    await cancelTurnInFlight;
    if (!turnActive) return;
  }
  if (!turnActive && !cancelTurnInFlight) return;

  const trigger = opts?.trigger?.trim() || "stop";
  const pauseQueue = opts?.pauseQueue !== false;
  turnUiPhase = "cancelling";
  cancelTurnInFlight = (async () => {
    const tid =
      activeThreadId && !activeThreadId.startsWith("disk_")
        ? activeThreadId
        : null;
    const shouldPauseGoal = Boolean(
      currentGoalTitle() && !goalPaused() && !goalCompleted(),
    );
    // interrupt：保留队列 + 暂停 drain；send_now / clearQueue 另议
    if (opts?.clearQueue) {
      clearPromptQueue({ silent: true });
    } else if (pauseQueue && ensurePromptQueue().length) {
      ensurePromptQueue().setPausedSyncHost(true);
    } else if (!pauseQueue) {
      // send_now：用户继续工作，解除 interrupt pause
      if (ensurePromptQueue().isPaused) {
        ensurePromptQueue().setPausedSyncHost(false);
      }
    }
    // 停止后短暂禁止 history 回补（下一轮干净流后解除）
    blockHistoryResyncAfterStop = true;
    // 下一用户题：conversation_only rewind 摘掉本取消轮（send_now 除外）
    // 不在 Desktop 注入 focus system-reminder（对齐 CLI：agent 侧独立 reminder）
    if (trigger !== "send_now") {
      pendingPostCancelFocus = true;
      const lastUser = $("transcript").querySelector(
        ".user-msg-block:last-of-type",
      ) as HTMLElement | null;
      const idx = Number(lastUser?.dataset.promptIndex);
      lastCancelledPromptIndex = Number.isFinite(idx) && idx >= 0 ? idx : null;
    }
    // 先锁 UI：关闭 late grace；短 suppress，等本轮 turn.started 再 arm
    lateStreamUntil = 0;
    userStopSuppressUntil = Date.now() + 8_000;
    streamTurnId = 0;
    streamArmedThisTurn = false;
    // 立即结算 UI（不必等 session/cancel 往返）；endTurn 幂等防双条
    // interrupt 暂停时 skipQueueDrain：队列保留，用户 resume 后再发
    // send_now 也 skip：本路径紧接着会发新 prompt，勿 drain 队首抢发
    if (turnActive || !alreadyPaintedStopped) {
      endTurn({
        outcome: "stopped",
        skipQueueDrain:
          !pauseQueue ||
          ensurePromptQueue().isPaused ||
          Boolean(opts?.clearQueue),
      });
    }
    if (tid) {
      const res = await inv("turns.cancel", { threadId: tid, trigger });
      if (!res.ok) {
        appendLine(res.error?.message ?? tr("turn.stopFailed"), "error");
      }
    }
    // send_now：不因 Stop 暂停 goal；普通 stop 仍 pause
    if (shouldPauseGoal && pauseQueue) {
      await pauseGoal({ fromStop: true });
    }
  })().finally(() => {
    cancelTurnInFlight = null;
    if (turnUiPhase === "cancelling") turnUiPhase = "idle";
  });
  await cancelTurnInFlight;
}

function appendThoughtDelta(text: string): void {
  // 产品：会话中不展示思考过程（thought 块 /「思考中」条）
  // 仍消费事件以免影响流式状态机；仅不渲染 DOM。
  void text;
  return;
}

function markToolStarted(
  name: string,
  toolCallId?: string,
  raw?: unknown,
): void {
  if (streamBubble && streamRole === "assistant") {
    if (streamIsProcess) {
      endProcessTextStream();
      streamBubble = null;
      streamRole = null;
      streamAssistantRaw = "";
      streamIsProcess = false;
    } else {
      flushAssistantMarkdown(streamBubble);
      streamBubble = null;
      streamRole = null;
      streamAssistantRaw = "";
    }
  }
  const id = toolCallId || name;
  const scope = processBodyEl ?? $("transcript");
  const existing = scope.querySelector(
    `.line.tool.running[data-tool-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  if (existing) {
    const n = existing.querySelector(".tool-name");
    if (n) n.textContent = name;
    return;
  }
  // 也在全文找，避免重复
  const existingAll = $("transcript").querySelector(
    `.line.tool.running[data-tool-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  if (existingAll) return;

  const wrap = document.createElement("div");
  wrap.innerHTML = buildToolCardHtml({
    name,
    toolCallId: id,
    running: true,
    raw,
  });
  const div = wrap.firstElementChild as HTMLElement;
  // 方案 A：工具进过程块
  appendProcessNode(div);
  if (turnActive) setTurnStatus(tr("process.runningTool", { name }));
}

function markToolCompleted(
  toolCallId?: string,
  name?: string,
  raw?: unknown,
): void {
  const el = $("transcript");
  let row: HTMLElement | null = null;
  if (toolCallId) {
    row = el.querySelector(
      `.line.tool[data-tool-id="${CSS.escape(toolCallId)}"]`,
    ) as HTMLElement | null;
  }
  if (!row && name) {
    const rows = Array.from(el.querySelectorAll(".line.tool.running"));
    for (const r of rows) {
      if ((r.textContent ?? "").includes(name)) {
        row = r as HTMLElement;
        break;
      }
    }
  }
  if (!row) {
    const all = el.querySelectorAll(".line.tool.running");
    row = (all[all.length - 1] as HTMLElement) ?? null;
  }
  if (!row) {
    if (name) {
      const wrap = document.createElement("div");
      wrap.innerHTML = buildToolCardHtml({
        name,
        toolCallId,
        running: false,
        raw,
      });
      appendProcessNode(wrap.firstElementChild as HTMLElement);
    }
    return;
  }
  updateToolCardDone(row, raw);
  if (turnActive && !assistantStartedThisTurn) {
    setTurnStatus(tr("turn.thinking"));
  }
}

/**
 * Append a transcript line.
 * - assistant stream chunks merge into one bubble
 * - user messages only from optimistic send / history
 * - thought/tool go through timeline helpers
 */
function appendLine(
  text: string,
  cls: string,
  opts?: { fromStream?: boolean },
): void {
  if (!text) return;
  if (cls === "system" && !text.trim()) return;

  const el = $("transcript");
  const fromStream = opts?.fromStream === true;
  const trimmed = text.trim();

  if (cls === "user") {
    if (fromStream) return;
    // 走结构化渲染（含附件 chip）；history 用 paintUserMessage 解析
    paintUserMessage(trimmed);
    return;
  }

  if (cls === "thought") {
    appendThoughtDelta(text);
    return;
  }

  if (cls === "assistant" && fromStream) {
    // 用户停止后一律丢弃流式（含跨 turn 的 T1 迟到包）
    if (isUserStopSuppressed()) return;
    // 停止后本轮尚未 arm：禁止写入（Host 闸门未开前的残留）
    if (!streamArmedThisTurn || !streamTurnId) return;
    // 活跃 turn，或 endTurn 后 grace 内的本 turn 迟到末包
    const inLateGrace =
      !turnActive &&
      lateStreamUntil > 0 &&
      Date.now() <= lateStreamUntil &&
      streamTurnId === currentTurnId &&
      streamArmedThisTurn &&
      currentTurnId > 0;
    if (
      (!turnActive && !inLateGrace) ||
      !streamTurnId ||
      streamTurnId !== currentTurnId
    ) {
      return;
    }
    // 累计流式文本；若检测到「新答复粘在旧尾巴上」则拆开旧气泡（generation 隔离为主）
    let nextRaw = streamAssistantRaw;
    if (
      streamBubble &&
      streamRole === "assistant" &&
      streamBubble.isConnected &&
      streamBubble.dataset.turnId === String(streamTurnId)
    ) {
      if (text.startsWith(streamAssistantRaw) && text.length > streamAssistantRaw.length) {
        nextRaw = text;
      } else if (
        streamAssistantRaw.startsWith(text) &&
        text.length < streamAssistantRaw.length
      ) {
        return;
      } else if (looksLikeGluedNewAssistantReply(streamAssistantRaw, text)) {
        // 截断旧气泡（多为被取消轮次的迟到全文），只用新段开新流
        if (streamAssistantRaw.length > 40) {
          streamBubble.remove();
        } else {
          flushAssistantMarkdown(streamBubble);
          streamBubble.classList.remove("streaming");
        }
        streamBubble = null;
        streamAssistantRaw = "";
        nextRaw = text;
      } else {
        nextRaw = streamAssistantRaw + text;
      }
    } else {
      nextRaw = streamAssistantRaw ? streamAssistantRaw + text : text;
    }

    noteCleanAssistantStream(nextRaw);
    // 首段助手输出：移除 Thinking 占位
    if (!assistantStartedThisTurn) {
      assistantStartedThisTurn = true;
      removeTurnStatus();
    }

    const asProcess = looksLikeGoalProcessText(nextRaw) || streamIsProcess;

    // 从主气泡切到过程：丢掉空主气泡，改写过程块
    if (asProcess) {
      if (
        streamBubble &&
        !streamIsProcess &&
        streamBubble.isConnected &&
        streamBubble.classList.contains("assistant")
      ) {
        streamBubble.remove();
        streamBubble = null;
      }
      streamIsProcess = true;
      streamRole = "assistant";
      streamAssistantRaw = nextRaw;
      streamTurnId = currentTurnId;
      // 过程流：用单个 process-text 节点承载全文
      const { body } = ensureProcessBlock();
      let p = body.querySelector(
        `.process-text[data-turn-id="${streamTurnId}"]`,
      ) as HTMLElement | null;
      if (!p) {
        p = document.createElement("div");
        p.className = "process-text";
        p.dataset.turnId = String(streamTurnId);
        p.dataset.streaming = "1";
        body.appendChild(p);
        processItemCount += 1;
        updateProcessHeader();
      }
      p.textContent = nextRaw;
      streamBubble = p;
      scrollTranscriptIfSticky();
      return;
    }

    // 主对话气泡
    if (streamIsProcess) {
      endProcessTextStream();
      streamIsProcess = false;
      streamBubble = null;
      streamAssistantRaw = "";
    }
    if (
      streamBubble &&
      streamRole === "assistant" &&
      streamBubble.isConnected &&
      streamBubble.dataset.turnId === String(streamTurnId) &&
      streamBubble.classList.contains("assistant")
    ) {
      streamAssistantRaw = nextRaw;
      appendAssistantStream(streamBubble, streamAssistantRaw);
      return;
    }
    // 同 turn 去重：agent 常在过程后再次完整推送同一段交付
    const reuse = findDedupeAssistantBubble(streamTurnId, nextRaw);
    if (reuse) {
      streamBubble = reuse;
      streamRole = "assistant";
      streamIsProcess = false;
      const prev = (reuse.dataset.raw ?? "").trim();
      streamAssistantRaw =
        nextRaw.length >= prev.length ? nextRaw : prev || nextRaw;
      reuse.classList.add("streaming");
      appendAssistantStream(reuse, streamAssistantRaw);
      return;
    }
    streamAssistantRaw = nextRaw;
    const div = document.createElement("div");
    div.className = "line assistant prose streaming";
    div.dataset.messageAuthorRole = "assistant";
    div.dataset.turnId = String(streamTurnId);
    appendAssistantStream(div, streamAssistantRaw);
    if (turnStatusEl?.isConnected) {
      el.insertBefore(div, turnStatusEl);
    } else {
      el.appendChild(div);
    }
    streamBubble = div;
    streamRole = "assistant";
    return;
  }

  // 完整 assistant（history 回放 / 非流式）— 只渲染一次，且不进入流式指针
  if (cls === "assistant" && !fromStream) {
    // 停止后禁止 history 回补把 T1 贴到时间线末尾（「已停止」下方再出长文）
    if (
      isUserStopSuppressed() ||
      blockHistoryResyncAfterStop ||
      turnUiPhase === "cancelling"
    ) {
      return;
    }
    if (looksLikeGoalProcessText(text)) {
      resetStreamState(true);
      const { body } = ensureProcessBlock();
      const p = document.createElement("div");
      p.className = "process-text";
      p.textContent = text;
      body.appendChild(p);
      processItemCount += 1;
      updateProcessHeader();
      // history 回放后保持折叠
      if (processBlockEl) processBlockEl.classList.add("collapsed");
      scrollTranscriptIfSticky();
      return;
    }
    // 仅合并「紧邻上一条」实质相同的助手气泡（history 回补 vs 流式定稿）。
    // 禁止跨轮全文扫描：两轮各回「好的」仍应各占一泡。
    const last = el.lastElementChild as HTMLElement | null;
    if (last?.classList.contains("assistant")) {
      const prev = (last.dataset.raw ?? last.textContent ?? "").trim();
      if (prev && assistantTextsRoughlyEqual(trimmed, prev)) {
        return;
      }
    }
    resetStreamState(true);
    const div = document.createElement("div");
    div.className = "line assistant prose";
    div.dataset.messageAuthorRole = "assistant";
    paintAssistantHtml(div, text, { highlight: true, cwd: activeCwd });
    el.appendChild(div);
    scrollTranscriptIfSticky();
    return;
  }

  // tool/system/error 等：不打断本 turn 的 assistant 流指针（工具中插在时间线）
  if (cls === "tool" || cls === "system" || cls === "error") {
    /* keep streamBubble */
  } else {
    resetStreamState(true);
  }

  const div = document.createElement("div");
  div.className = `line ${cls}`;
  if (cls === "system" || cls === "error") {
    div.dataset.messageAuthorRole = cls;
  }
  div.textContent = text;
  el.appendChild(div);
  // 错误/系统行：流式中不强制打断用户上滑阅读
  if (cls === "error") scrollTranscript();
  else scrollTranscriptIfSticky();
}

function endStreamBubble(): void {
  resetStreamState(true);
}

function renderMsgImages(
  host: HTMLElement,
  attachments: ComposerAttachment[],
): void {
  const images = attachments.filter((a) => a.kind === "image");
  if (!images.length) return;
  const row = document.createElement("div");
  row.className = "msg-attach-media";
  for (const a of images) {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "msg-attach-thumb";
    thumb.title = `${a.name} · 点击查看`;
    thumb.dataset.path = a.path;
    if (a.previewUrl) {
      const img = document.createElement("img");
      img.className = "msg-attach-thumb-img";
      img.src = a.previewUrl;
      img.alt = a.name;
      img.draggable = false;
      thumb.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "msg-attach-thumb-ph";
      ph.textContent = attachIcon("image");
      thumb.appendChild(ph);
      void inv<{ dataUrl: string }>("files.readDataUrl", {
        path: a.path,
        // 历史 session 图在 sessions/.../images/，需放行
        sessionId: activeSessionId || undefined,
      }).then((res) => {
        if (!res.ok || !res.data?.dataUrl) return;
        a.previewUrl = res.data.dataUrl;
        const img = document.createElement("img");
        img.className = "msg-attach-thumb-img";
        img.src = res.data.dataUrl;
        img.alt = a.name;
        img.draggable = false;
        ph.replaceWith(img);
      });
    }
    thumb.onclick = (e) => {
      e.stopPropagation();
      void openPathInWorkspace({
        path: a.path,
        kind: "image",
        previewUrl: a.previewUrl,
        name: a.name,
        sessionId: activeSessionId,
      });
    };
    row.appendChild(thumb);
  }
  host.appendChild(row);
}

/** 非图片附件 chip（可放在气泡内） */
function renderMsgFileChips(
  host: HTMLElement,
  attachments: ComposerAttachment[],
): void {
  const files = attachments.filter((a) => a.kind !== "image");
  if (!files.length) return;
  const chips = document.createElement("div");
  chips.className = "msg-attach-chips";
  for (const a of files) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "msg-attach-chip";
    chip.title = a.path;
    chip.innerHTML = `<span class="msg-attach-ico" aria-hidden="true">${attachIcon(a.kind)}</span><span class="msg-attach-name">${esc(a.name)}</span>`;
    chip.onclick = (e) => {
      e.stopPropagation();
      void openPathInWorkspace({
        path: a.path,
        kind: a.kind === "folder" ? "folder" : a.kind === "image" ? "image" : "file",
        name: a.name,
        sessionId: activeSessionId,
      });
    };
    chips.appendChild(chip);
  }
  host.appendChild(chips);
}

function paintUserMessage(
  text: string,
  attachments?: ComposerAttachment[],
  at?: Date | string | number | null,
  promptIndex?: number,
): void {
  const t = text.trim();
  const atts = attachments ? [...attachments] : [];
  if (!t && !atts.length) return;

  // 注意：禁止按正文去重。用户可连续发送相同内容（如两次「你好」），
  // 直播 user 回声已在 message.delta / appendLine(fromStream) 丢弃，不靠内容去重。
  resetStreamState(true);
  const el = $("transcript");

  let when: Date | null = null;
  if (at === null) {
    when = null;
  } else if (at === undefined) {
    when = new Date();
  } else if (at instanceof Date && !Number.isNaN(at.getTime())) {
    when = at;
  } else if (typeof at === "number" && Number.isFinite(at)) {
    when = new Date(at);
  } else if (typeof at === "string" && at.trim()) {
    const p = Date.parse(at);
    if (Number.isFinite(p)) when = new Date(p);
  }

  const idx =
    typeof promptIndex === "number" && Number.isFinite(promptIndex)
      ? Math.max(0, Math.floor(promptIndex))
      : nextUserPromptIndex++;
  if (idx >= nextUserPromptIndex) nextUserPromptIndex = idx + 1;

  const wrap = document.createElement("div");
  wrap.className = "user-msg-block";
  wrap.dataset.messageAuthorRole = "user";
  wrap.dataset.msgId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  wrap.dataset.rawText = t;
  wrap.dataset.promptIndex = String(idx);

  // 图片：独立媒体行，不进灰色气泡
  renderMsgImages(wrap, atts);

  const fileAtts = atts.filter((a) => a.kind !== "image");
  // 仅文字或非图片附件才渲染气泡
  if (t || fileAtts.length) {
    const div = document.createElement("div");
    div.className = "line user";
    renderMsgFileChips(div, fileAtts);
    if (t) {
      const body = document.createElement("div");
      body.className = "msg-user-text";
      body.textContent = t;
      div.appendChild(body);
    }
    wrap.appendChild(div);
  }

  const meta = document.createElement("div");
  meta.className = "msg-user-meta";
  if (when) {
    const timeEl = document.createElement("span");
    timeEl.className = "msg-user-time";
    timeEl.textContent = formatUserMsgTime(when);
    timeEl.title = when.toLocaleString();
    meta.appendChild(timeEl);
  }

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-user-copy";
  copyBtn.title = tr("common.copy");
  copyBtn.setAttribute("aria-label", tr("chat.copyMessage"));
  copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const raw = wrap.dataset.rawText ?? t;
    try {
      await navigator.clipboard.writeText(raw);
      showToast(tr("common.copied"));
    } catch {
      showToast(tr("common.copyFailed"), "error");
    }
  };
  meta.appendChild(copyBtn);

  const rewindBtn = document.createElement("button");
  rewindBtn.type = "button";
  rewindBtn.className = "msg-user-rewind";
  rewindBtn.title = tr("chat.rewindTitle");
  rewindBtn.setAttribute("aria-label", tr("chat.rewind"));
  rewindBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
  rewindBtn.onclick = (e) => {
    e.stopPropagation();
    void rewindToUserPrompt(idx, t);
  };
  meta.appendChild(rewindBtn);

  wrap.appendChild(meta);

  el.appendChild(wrap);
  scrollTranscript();
}

/** 截断 transcript：移除 promptIndex >= target 的用户块及其后全部节点 */
function truncateTranscriptFromPrompt(targetPromptIndex: number): void {
  const el = $("transcript");
  const blocks = Array.from(
    el.querySelectorAll(".user-msg-block[data-prompt-index]"),
  ) as HTMLElement[];
  const hit = blocks.find(
    (b) => Number(b.dataset.promptIndex) === targetPromptIndex,
  );
  if (!hit) {
    // 找不到精确块：从第一个 >= target 的 user 块起删
    const later = blocks.find(
      (b) => Number(b.dataset.promptIndex) >= targetPromptIndex,
    );
    if (!later) {
      // 无匹配：清空助手尾部？保险起见不乱删
      return;
    }
    let n: ChildNode | null = later;
    while (n) {
      const nxt: ChildNode | null = n.nextSibling;
      el.removeChild(n);
      n = nxt;
    }
  } else {
    let n: ChildNode | null = hit;
    while (n) {
      const nxt: ChildNode | null = n.nextSibling;
      el.removeChild(n);
      n = nxt;
    }
  }
  nextUserPromptIndex = targetPromptIndex;
  // 清理过程块指针
  processBlockEl = null;
  processBodyEl = null;
  processItemCount = 0;
  resetStreamState(true);
}

async function rewindToUserPrompt(
  promptIndex: number,
  previewText: string,
): Promise<void> {
  await ensureRewindActions().toUserPrompt(promptIndex, previewText);
}

function permLabel(): string {
  // 权限 chip 只体现访问策略；plan 用独立 chip（对齐 Build）
  if (accessMode === "always_approve") return tr("composer.permFull");
  return tr("composer.permDefault");
}

function syncPermLabels(): void {
  const v = permLabel();
  for (const id of ["perm-label", "perm-label-2"] as const) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }
  syncSessionModeChips();
}

function effortLabel(level: EffortLevel = effortLevel): string {
  return effortOptions().find((e) => e.id === level)?.label ?? level;
}

function modelChipText(): string {
  return ensureModelMenu().modelChipText();
}

function syncModelLabels(): void {
  ensureModelMenu().syncLabels();
}

function syncContextLabels(): void {
  ensureContextUi().syncLabels();
}

async function refreshContextUsage(): Promise<ContextUsageRow | null> {
  return ensureContextUi().refresh();
}

/** auto-compact 事件里的 tokens 往往比 signals.json 写回更早，先乐观刷新 chip */
function applyOptimisticContextFromCompact(ev: {
  tokensBefore?: number;
  tokensAfter?: number;
}): void {
  ensureContextUi().applyOptimisticFromCompact(ev);
}

/** compact 完成后：乐观 chip + 多次回读 signals（写盘有延迟） */
function refreshContextAfterCompact(ev: {
  tokensBefore?: number;
  tokensAfter?: number;
}): void {
  ensureContextUi().refreshAfterCompact(ev);
}

function startContextPolling(): void {
  ensureContextUi().startPolling();
}

function stopContextPolling(): void {
  ensureContextUi().stopPolling();
}

async function showContextDetails(): Promise<{ ok: boolean; message?: string }> {
  return ensureContextUi().showDetails();
}

/** 兼容旧 getLastContextUsage() 读写 */
function getLastContextUsage(): ContextUsageRow | null {
  return ensureContextUi().getLast();
}
function setLastContextUsage(row: ContextUsageRow | null): void {
  ensureContextUi().setLast(row);
}

function setEffortLevel(level: EffortLevel): void {
  effortLevel = level;
  syncModelLabels();
}

function setModelId(id: string): void {
  modelLabel = id.trim() || modelLabel;
  syncModelLabels();
}

function applyDefaultToChip(): void {
  modelLabel = defaultModelLabel || "grok";
  effortLevel = defaultEffortLevel;
  syncModelLabels();
}

/** 打开会话：chip 显示该会话记忆的模型（Host 已 resolve 幽灵 id；再异步校验目录） */
function applyThreadToChip(t: {
  model?: string;
  effort?: string;
}): void {
  const m = t.model?.trim();
  modelLabel = m || defaultModelLabel || "grok";
  effortLevel = parseEffort(t.effort) ?? defaultEffortLevel;
  syncModelLabels();
  // 目录可能刚删提供商：异步确认 chip 仍可选
  void ensureChipModelAvailable({ toast: Boolean(m) });
}

async function startFreshSessionWithModel(
  modelId: string,
  effort: EffortLevel,
): Promise<{ ok: boolean; message?: string }> {
  return ensureModelSessionActions().startFreshSessionWithModel(
    modelId,
    effort,
  );
}

async function applySessionModelAndEffort(opts?: {
  modelId?: string;
  effort?: EffortLevel;
  focus?: "model" | "effort" | "both";
}): Promise<{ ok: boolean; message?: string }> {
  return ensureModelSessionActions().applySessionModelAndEffort(opts);
}

async function promptSetModel(): Promise<{ ok: boolean; message?: string }> {
  return ensureModelSessionActions().promptSetModel();
}

async function promptSetEffort(): Promise<{ ok: boolean; message?: string }> {
  return ensureModelSessionActions().promptSetEffort();
}



/** 兼容旧代码对 modelsCache 的读写（实际缓存在 ModelMenuController） */
function getModelsCache(): ModelRow[] | null {
  return ensureModelMenu().cache();
}
function setModelsCache(list: ModelRow[] | null): void {
  ensureModelMenu().setCache(list);
}

/** 登录/登出后丢弃缓存，强制重新拉可见 catalog */
function invalidateModelsCache(): void {
  ensureModelMenu().invalidateCache();
}

function hideModelMenu(): void {
  ensureModelMenu().hideMenu();
}

/** 设置 / 插件全页是否盖住主壳（此时勿 setModel、勿抢焦点） */
function isMainShellOverlayOpen(): boolean {
  if (settingsPage?.isOpen()) return true;
  const plugins = document.getElementById("plugins-page");
  if (plugins && !plugins.classList.contains("hidden")) return true;
  return false;
}

/**
 * chip 模型须在可选目录内；否则回退默认（对齐 CLI reselect）。
 * @returns true = 未改动；false = 已回退
 */
async function ensureChipModelAvailable(opts?: {
  toast?: boolean;
  allowSetModel?: boolean;
  force?: boolean;
}): Promise<boolean> {
  return ensureModelMenu().ensureChipAvailable(opts);
}

function fetchModelsList(opts?: { force?: boolean }): Promise<ModelRow[]> {
  return ensureModelMenu().fetchList(opts);
}

/** 启动后预取，首点 chip 也尽量命中缓存 */
function prefetchModelsList(): void {
  ensureModelMenu().prefetch();
}

/** 同步立刻弹出（用缓存/回退）；模型列表后台刷新 */
function showModelMenu(anchor: HTMLElement): void {
  ensureModelMenu().showMenu(anchor);
}

function currentGoalTitle(): string | null {
  return ensureGoalBanner().currentTitle();
}

function goalPaused(): boolean {
  return ensureGoalBanner().paused();
}

function goalCompleted(): boolean {
  return ensureGoalBanner().completed();
}

function setSessionModeChipFocus(focus: SessionModeChipFocus): void {
  ensureSessionPolicy().setChipFocus(focus);
}

/** 输入栏：计划 / 目标 chip **互斥**（只显示 focus 一侧） */
function syncSessionModeChips(): void {
  ensureSessionPolicy().syncChips();
}

/**
 * 同步访问权限 + plan 到 agent（两维正交）。
 * 旧会话是 disk_*，必须先 attach 成 live thread。
 */
async function syncSessionPolicyLive(opts?: {
  plan?: boolean;
  alwaysApprove?: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionPolicy().syncLive(opts);
}

/** @deprecated 兼容旧调用名 → 两维 sync */
async function setThreadModeLive(
  mode: "plan" | "normal" | "always_approve",
): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionPolicy().setThreadModeLive(mode);
}

function exitPlanMode(): void {
  ensureSessionPolicy().exitPlanMode();
}

/** 开启计划模式（UI + ACP session/set_mode plan）；保留当前 accessMode */
async function enterPlanMode(): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionPolicy().enterPlanMode();
}

/** /view-plan · chip：打开右栏计划面板（可编辑真源） */
async function showViewPlan(): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionPolicy().showViewPlan();
}

/**
 * 前台 plan 投影 / 侧栏面板 → PlanPanelUi。
 * planPhase / pendingApproval 仍由 main 持有。
 */
const snapshotActiveSessionPlan = (sessionId: string | null | undefined) =>
  ensurePlanPanel().snapshotActive(sessionId);
const closePlanPanelOnSessionChange = (opts?: {
  stashSessionId?: string | null;
  abandonPending?: boolean;
}) => ensurePlanPanel().closeOnSessionChange(opts);
const rehydrateSessionPlan = (
  sessionId: string,
  opts?: { viewGen?: number },
) => ensurePlanPanel().rehydrate(sessionId, opts);
const isPlanApprovalArmed = () => ensurePlanPanel().isApprovalArmed();
const syncPlanPanelChrome = () => ensurePlanPanel().syncChrome();
const syncPlanRailActivity = () => ensurePlanPanel().syncRailActivity();
const bindPlanPanel = () => ensurePlanPanel().bind();
const openPlanPanel = (opts?: {
  requestId?: string | null;
  forceReload?: boolean;
  seedContent?: string | null;
  ownerSessionId?: string | null;
}) => ensurePlanPanel().open(opts);

/** invoke 返回后若仍 turnActive，延迟 endTurn，并回补 history */
function scheduleTurnSettle(turnId: number): void {
  // Never force-end an active turn from the 1.5s settle timer.
  // (Previously endTurn() at 1.5s killed long tool runs while IPC still awaited.)
  window.setTimeout(() => {
    if (currentTurnId !== turnId) return;
    if (turnActive) {
      // Still running - leave UI as-is; turn.completed / error path will settle.
      return;
    }
    // Stop / block 窗口内禁止 history 贴迟到落盘
    if (
      shouldSkipHistoryResync({
        assistantStartedThisTurn,
        userStopSuppressed: isUserStopSuppressed(),
        blockAfterStop: blockHistoryResyncAfterStop,
      })
    ) {
      return;
    }
    void afterTurnSettled();
  }, 1500);
}

/**
 * turn 结束后：从磁盘 history 回补未显示的助手消息；
 * 计划模式且无 exit_plan 弹窗时自动打开计划预览。
 */
async function afterTurnSettled(): Promise<void> {
  await resyncMissingAssistantFromHistory();
  await maybeSurfacePlanAfterTurn();
}

async function resyncMissingAssistantFromHistory(): Promise<void> {
  if (!activeSessionId) return;
  /**
   * Phase3 契约（history-resync-policy）：
   * - 已流式助手 → 不 resync（防重复）
   * - stop suppress / blockAfterStop → 不 resync（防 T1 落盘贴 T2）
   * - 只取 last user 之后的 assistant；无词级毒化
   */
  if (
    shouldSkipHistoryResync({
      assistantStartedThisTurn,
      userStopSuppressed: isUserStopSuppressed(),
      blockAfterStop: blockHistoryResyncAfterStop,
    })
  ) {
    return;
  }

  const wantSession = activeSessionId;
  const viewGen = sessionViewGen;
  const hist = await inv<{
    entries: Array<{ role: string; text: string }>;
  }>("history.load", { sessionId: wantSession });
  if (viewGen !== sessionViewGen || activeSessionId !== wantSession) return;
  if (!hist.ok || !hist.data?.entries?.length) return;
  if (
    shouldSkipHistoryResync({
      assistantStartedThisTurn,
      userStopSuppressed: isUserStopSuppressed(),
      blockAfterStop: blockHistoryResyncAfterStop,
    })
  ) {
    return;
  }

  const entries = hist.data.entries;
  // 时间线 user 与 history last user 不一致 → 视图/会话竞态，跳过
  if (!historyLastUserMatchesTimeline(entries, timelineLastUserText())) {
    return;
  }

  const shownNodes = Array.from(
    $("transcript").querySelectorAll(".line.assistant"),
  ) as HTMLElement[];
  const shownRaws = shownNodes.map((n) =>
    (n.dataset.raw ?? n.textContent ?? "").trim(),
  );

  for (const text of assistantsAfterLastUser(entries)) {
    const n = normalizeAssistantForDedupe(text);
    if (!n || n.length < 12) continue;
    const exists = shownRaws.some((s) => assistantTextsRoughlyEqual(text, s));
    if (exists) continue;
    appendLine(text, "assistant");
    shownRaws.push(text);
  }
}

function notePlanArtifactFromTool(name: string | undefined, raw: unknown): void {
  ensurePlanPanel().noteArtifactFromTool(name, raw);
}

async function maybeSurfacePlanAfterTurn(): Promise<void> {
  await ensurePlanPanel().maybeSurfaceAfterTurn();
}

/**
 * 系统代发一条用户消息并跑一轮。
 * force：计划批准等场景下若 UI 仍标 turnActive（exit_plan 挂起/事件乱序），先 endTurn 再发。
 * interrupt:"send_now"：cancel 当前 turn 后再发（CLI send_now）。
 * attachments：图片 path → Host 组装 ACP Image blocks（历史 path 块仍在 content 里）。
 * @returns 是否已成功提交到 agent（队列 L1 complete 依赖此值）
 */
async function dispatchAgentPrompt(
  content: string,
  display?: string,
  opts?: {
    force?: boolean;
    interrupt?: "queue" | "send_now";
    attachments?: ComposerAttachment[];
  },
): Promise<{ ok: boolean; error?: string }> {
  const shown = (display ?? content).trim();
  const agentText = content.trim();
  if (!agentText) return { ok: false, error: "empty" };

  if (turnActive) {
    if (opts?.interrupt === "send_now") {
      await cancelTurn({ trigger: "send_now", pauseQueue: false });
    } else if (opts?.force) {
      // 不 cancel agent（可能已 idle）；只清 UI 锁，允许新 prompt
      // 跳过 drain：本函数紧接着 beginTurn，避免与队列竞态
      endTurn({ skipQueueDrain: true });
    } else {
      showToast(tr("chat.turnBusy"), "error");
      return { ok: false, error: tr("chat.turnBusy") };
    }
  }

  // 先连接再画用户气泡：避免 attach 失败留下「假已发送」消息
  showWelcome(false);
  // 若上一轮刚停止，保持 suppress，直到 prompt 成功
  beginTurn();
  setTurnStatus(tr("chat.connecting"));

  const threadId = await ensureLiveThread();
  if (!threadId) {
    endTurn({ outcome: "stopped" });
    appendLine(tr("chat.connectFail"), "error");
    return { ok: false, error: tr("chat.connectFail") };
  }
  paintUserMessage(shown, opts?.attachments);
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  setTurnStatus(tr("turn.thinking"));
  const wireContent = await prepareAgentContentAfterCancel(threadId, agentText);
  const res = await inv("turns.prompt", {
    threadId,
    content: wireContent,
    attachments: wireAttachmentsForPrompt(opts?.attachments),
  });
  if (!res.ok) {
    // prompt 未进 agent：标失败气泡，勿当作已成功发出
    markLastUserMessageSendFailed();
    endTurn({ outcome: "stopped" });
    // turn.completed(error) 可能已画过同一条；去重
    const errMsg = res.error?.message ?? tr("chat.sendFail");
    showTurnErrorOnce(
      errMsg,
      res.error && "details" in res.error
        ? (res.error as { details?: unknown }).details
        : undefined,
    );
    void refreshContextUsage();
    void refreshProjectsAndThreads();
    return { ok: false, error: errMsg };
  }
  // 注意：arm 已在 turn.started 事件里完成（IPC 返回时整轮已结束）
  scheduleTurnSettle(currentTurnId);
  void refreshContextUsage();
  void refreshProjectsAndThreads();
  return { ok: true };
}

/** turns.prompt 的 attachments 载荷：仅 path/kind（图由 Host 读盘） */
function wireAttachmentsForPrompt(
  attachments?: ComposerAttachment[] | unknown[] | null,
): Array<{ path: string; kind?: string }> | undefined {
  if (!attachments?.length) return undefined;
  const out: Array<{ path: string; kind?: string }> = [];
  for (const raw of attachments) {
    const a = raw as { path?: string; kind?: string };
    const p = typeof a?.path === "string" ? a.path.trim() : "";
    if (!p) continue;
    out.push({
      path: p,
      kind: typeof a.kind === "string" ? a.kind : undefined,
    });
  }
  return out.length ? out : undefined;
}

/** turns.prompt 失败：给最近一条用户消息加失败态（不删，便于对照重发） */
function markLastUserMessageSendFailed(): void {
  const nodes = Array.from(
    $("transcript").querySelectorAll(".user-msg-block"),
  ) as HTMLElement[];
  const last = nodes[nodes.length - 1];
  if (!last) return;
  last.classList.add("is-send-failed");
  last.dataset.sendFailed = "1";
  if (!last.querySelector(".msg-send-failed")) {
    const tag = document.createElement("span");
    tag.className = "msg-send-failed";
    tag.textContent = tr("chat.sendFail") || "发送失败";
    const meta = last.querySelector(".msg-user-meta");
    if (meta) meta.appendChild(tag);
    else last.appendChild(tag);
  }
}

function bindSessionModeChips(): void {
  ensureSessionPolicy().bindModeChips();
}

/**
 * 目标 chip 点击（对齐 Codex：进 goal 模式时保留输入框正文）。
 */
function onGoalChipClick(): void {
  ensureSessionPolicy().onGoalChipClick();
}

/**
 * Electron 沙箱不支持 window.prompt / confirm，用应用内 modal。
 */
function promptText(opts: {
  title: string;
  hint?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
}): Promise<string | null> {
  return promptTextDlg(opts);
}

function confirmText(opts: {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return confirmTextDlg(opts);
}

function showToast(text: string, kind: "info" | "error" = "info"): void {
  showToastDlg(text, kind);
}

/**
 * 无 live session 时先 threads.create（与 startNewChat 同源），再供 skill / agent prompt。
 * 已有 session 则 ensureLiveThread。不发送消息、不 beginTurn。
 */
async function ensureSessionForAgentSlash(opts?: {
  title?: string;
}): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
  if (activeSessionId && activeCwd) {
    const tid = await ensureLiveThread();
    if (tid) return { ok: true, threadId: tid };
    return { ok: false, error: tr("chat.connectFail") };
  }

  let p = selectedProject();
  let cwd: string | undefined;
  let projectId: string | undefined;
  let noProject = false;
  if (p) {
    if (p.trust !== "trusted") {
      await inv("projects.update", { id: p.id, patch: { trust: "trusted" } });
    }
    cwd = p.path;
    projectId = p.id;
  } else {
    noProject = true;
    projectId = undefined;
    cwd = undefined;
  }

  closePlanPanelOnSessionChange({
    stashSessionId: activeSessionId,
    abandonPending: false,
  });

  // 欢迎页可能仍挂着旧 id 镜像：清掉再 create
  if (isLiveThreadId(activeThreadId) || activeSessionId) {
    const prevLive = isLiveThreadId(activeThreadId) ? activeThreadId : null;
    if (turnActive) await cancelTurn({ clearQueue: true });
    if (prevLive) {
      await inv("threads.detach", { threadId: prevLive });
    }
    activeThreadId = null;
    activeSessionId = null;
  }

  showWelcome(false);
  clearTranscript();
  setTurnStatus(tr("chat.connecting") || "正在启动会话…");

  const title =
    (opts?.title || "").trim().slice(0, 48) || tr("nav.newChat");
  const res = await inv<{
    threadId: string;
    sessionId: string;
    cwd: string;
  }>("threads.create", {
    cwd,
    projectId,
    noProject: noProject || undefined,
    title,
    model: modelLabel,
    effort: effortLevel,
    maxTurns: maxTurnsLimit ?? undefined,
    alwaysApprove: accessMode === "always_approve",
    plan: isPlanOn(),
    mode: isPlanOn()
      ? "plan"
      : accessMode === "always_approve"
        ? "always_approve"
        : "normal",
  });

  if (!res.ok || !res.data?.threadId) {
    return {
      ok: false,
      error: res.error?.message ?? tr("chat.connectFail"),
    };
  }

  activeThreadId = res.data.threadId;
  activeSessionId = res.data.sessionId;
  setActiveCwd(res.data.cwd);
  if (projectId) selectedProjectId = projectId;
  else {
    selectedProjectId = null;
    projectChoiceTouched = true;
    ensureSidebarList().expandedProjectIds.add(CHATS_GROUP_ID);
  }
  suspendLiveTranscript = false;
  startContextPolling();
  void refreshAgentAvailableCommands().then(() => slashPalette?.invalidate());
  void refreshProjectsAndThreads();
  return { ok: true, threadId: res.data.threadId };
}

/**
 * resolve skill →（必要时先建会话）→ dispatchAgentPrompt。
 * @returns handled：是否已作为 skill 路径处理（含失败 toast）
 */
async function runResolvedSkillSlash(
  name: string,
  skillArgs: string,
  opts?: { path?: string },
): Promise<{ handled: boolean; ok?: boolean; message?: string }> {
  return ensureSkillActions().runResolved(name, skillArgs, opts);
}

/**
 * 发送路径：若整行是已知 slash（含 paletteHidden 如 /always-approve），本地执行不交 agent。
 * 返回 true 表示已处理并应中止发送。
 *
 * 优先级：静态原生命令 > skill resolve（registry / path）> 其它。
 * 原生命令不走 skills.resolve。
 * skill / 需 agent 的命令：无 session 时先 threads.create 再 dispatch。
 */
async function tryRunComposerSlashLine(raw: string): Promise<boolean> {
  return ensureSkillActions().tryRunComposerLine(raw);
}

/** 从最近一次 palette 加载的 skill 命令中取 path（同名优先） */
function findSkillPathFromPaletteCache(name: string): string | undefined {
  const n = name.replace(/^\//, "").toLowerCase();
  for (const c of lastSlashCommandsCache) {
    if (c.action.kind !== "agent-command") continue;
    if (c.action.path && c.action.name.replace(/^\//, "").toLowerCase() === n) {
      return c.action.path;
    }
    if (c.id.toLowerCase() === `skill:${n}` && c.action.path) {
      return c.action.path;
    }
  }
  return undefined;
}

/** palette onCommandsLoaded 写入，供手打 /name 发送时绑 path */
let lastSlashCommandsCache: SlashCommandDef[] = [];

/** 仅处理会话斜杠命令（导航类走侧栏 / 顶栏 UI） */
async function runSlashCommand(
  cmd: SlashCommandDef,
  args = "",
): Promise<{ ok: boolean; message?: string }> {
  return ensureSlashDispatch().run(cmd, args);
}

function composerCwd(): string | null {
  return (
    selectedProject()?.path ||
    activeCwd ||
    null
  );
}

function activeThreadRefId(): string | null {
  return activeThreadId || (activeSessionId ? `disk_${activeSessionId}` : null);
}

async function renameThread(t: ThreadRow): Promise<void> {
  return ensureSessionOps().renameThread(t);
}

async function exportActiveSession(opts?: {
  destination?: "clipboard" | "file";
  threadId?: string;
}): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionOps().exportActiveSession(opts);
}

async function compactActiveSession(): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionOps().compactActiveSession();
}

async function promptSetMaxTurns(
  preset?: number,
): Promise<{ ok: boolean; message?: string }> {
  return ensureSessionOps().promptSetMaxTurns(preset);
}

/** 向当前可见 composer 插入文本 */
function insertComposerText(text: string): void {
  const welcome = !$("welcome").classList.contains("hidden");
  const ta = (
    welcome ? $("composer-input") : $("chat-input")
  ) as HTMLTextAreaElement | null;
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const pos = start + text.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  refreshComposerSlashHighlight(ta);
}

/**
 * CLI 对齐 Memory（A18/E5）→ MemoryBrowserUi。
 * /memory 浏览；/remember 写入；/flush /dream 指挥 agent。
 */
async function runMemoryCommand(
  sub: "list" | "add" | "search" | "status" | "flush" | "dream",
): Promise<{ ok: boolean; message?: string }> {
  return ensureMemoryBrowser().runCommand(sub);
}

async function showMemoryBrowser(
  focusSearch: boolean,
): Promise<{ ok: boolean; message?: string }> {
  return ensureMemoryBrowser().showBrowser(focusSearch);
}

function getActiveCwd(): string | undefined {
  if (activeCwd) return activeCwd;
  return selectedProject()?.path;
}

async function fetchSessionInfoForActive(): Promise<SessionInfoRow | null> {
  return ensureSessionOps().fetchSessionInfoForActive();
}


/** /rewind：列出可回退点并确认后执行（对齐 CLI slash 入口） */
async function rewindViaSlash(): Promise<{ ok: boolean; message?: string }> {
  return ensureRewindActions().viaSlash();
}

async function forkSessionFrom(
  source: ThreadRow,
  opts?: {
    confirm?: boolean;
    directive?: string;
    worktreeMode?: "use_main" | "create_new";
  },
): Promise<{ ok: boolean; message?: string }> {
  return ensureForkActions().forkFrom(source, opts);
}

function openForkDialog(initial: {
  worktreeMode: "use_main" | "create_new";
}): Promise<{ worktreeMode: "use_main" | "create_new" } | null> {
  return ensureForkActions().openDialog(initial);
}

/** slash `/fork [directive]`：解析 --worktree / --no-worktree */
async function forkActiveSession(
  rawArg?: string,
): Promise<{ ok: boolean; message?: string }> {
  return ensureForkActions().forkActive(rawArg);
}

/** 粘贴图片 → 附件（实现见 composer-bind-ui） */
function bindImagePaste(): void {
  ensureComposerBind().bindImagePaste();
}

/** 拖放文件/图片到主输入区 */
function bindComposerDrop(): void {
  ensureComposerBind().bindComposerDrop();
}

function bindSlashPalette(): void {
  slashPalette = new SlashPaletteController({
    getCommands: async () => {
      const path0 = selectedProject()?.path;
      const skills = await inv<
        Array<{
          name: string;
          description?: string;
          scope?: string;
          argumentHint?: string;
          path?: string;
          userInvocable?: boolean;
        }>
      >("skills.list", { projectPath: path0 });
      const staticCmds = getStaticSlashCommands();
      const staticIds = new Set(staticCmds.map((c) => c.id.toLowerCase()));
      // 尝试刷新 live 广告（若已附着）
      await refreshAgentAvailableCommands();
      const acpCmds = agentAdvertisedCommands(ensureAvailableCommands().list() as Array<{ name: string; description?: string; input?: { hint?: string } }>, staticIds);
      return [
        ...staticCmds,
        ...acpCmds,
        ...skillCommands(skills.data ?? []),
      ];
    },
    onRun: (cmd) => runSlashCommand(cmd),
    onMessage: (text, kind) => showToast(text, kind ?? "info"),
    onOpen: () => atFilePalette?.hide(),
    onCommandsLoaded: (cmds) => {
      lastSlashCommandsCache = cmds;
      setSlashHighlightCatalog(buildSlashKindCatalog(cmds));
    },
  });
  for (const id of [
    "composer-input",
    "chat-input",
    "focus-input",
    "btw-side-input",
  ] as const) {
    const ta = document.getElementById(id) as HTMLTextAreaElement | null;
    if (ta) slashPalette.attach(ta);
  }
  // 输入框 slash 着色（skill / agent / builtin）
  bindComposerSlashHighlight();
  // 先用静态目录上色；完整 skills 在首次打开 palette 时刷新
  setSlashHighlightCatalog(buildSlashKindCatalog(getStaticSlashCommands()));
  // 命令中心入口：在输入框键入 `/`（或 Ctrl+/）；不再提供工具栏 `/` 按钮
}

function bindAtFilePalette(): void {
  atFilePalette = new AtFilePaletteController({
    getCwd: () => composerCwd(),
    search: async ({ cwd, query, dirsOnly, includeHidden }) => {
      const res = await inv<{ hits: AtFileHit[] }>("files.search", {
        cwd,
        query,
        dirsOnly,
        includeHidden,
        limit: 40,
      });
      if (!res.ok) {
        throw new Error(res.error?.message ?? "搜索失败");
      }
      return res.data?.hits ?? [];
    },
    onPick: (hit) => {
      // 文件/文件夹均作为上下文附件（对齐 CLI @ 引用）
      addAttachments([hit.absPath], {
        kind: hit.isDirectory ? "folder" : undefined,
      });
    },
    onMessage: (text, kind) => showToast(text, kind ?? "info"),
    onOpen: () => slashPalette?.hide(),
  });
  for (const id of [
    "composer-input",
    "chat-input",
    "focus-input",
    "btw-side-input",
  ] as const) {
    const ta = document.getElementById(id) as HTMLTextAreaElement | null;
    if (ta) atFilePalette.attach(ta);
  }
}

// ── 附件 / + 菜单 ─────────────────────────────────────────

function openPathInWorkspace(
  opts: OpenWorkspacePathOpts,
): Promise<"lightbox" | "side-pane" | "system" | "noop"> {
  return openWorkspacePath(
    {
      inv,
      getSidePane: () => sidePane,
      getCwd: () => activeCwd ?? selectedProject()?.path ?? null,
      openImageLightbox: ({ path, name, previewUrl }) => {
        openModal(
          name || path.split(/[/\\]/).pop() || "图片预览",
          `<div class="img-lightbox">
      <img class="img-lightbox-img" src="${previewUrl.replace(/"/g, "&quot;")}" alt="${esc(name || path)}" />
      <div class="img-lightbox-path mono">${esc(path)}</div>
    </div>`,
        );
      },
    },
    opts,
  );
}





function activeComposerInput(): HTMLTextAreaElement {
  const welcomeHidden = $("welcome").classList.contains("hidden");
  return (
    welcomeHidden
      ? $("chat-input")
      : $("composer-input")
  ) as HTMLTextAreaElement;
}

function setComposerPlaceholders(goalMode: boolean): void {
  const w = $("composer-input") as HTMLTextAreaElement;
  const c = $("chat-input") as HTMLTextAreaElement;
  w.placeholder = goalMode
    ? tr("composer.placeholderGoal")
    : tr("composer.placeholder");
  c.placeholder = goalMode
    ? tr("composer.placeholderGoal")
    : tr("composer.placeholderChat");
  w.closest(".composer-card")?.classList.toggle("goal-compose-active", goalMode);
  c.closest(".composer-card")?.classList.toggle("goal-compose-active", goalMode);
}

/**
 * /goal 或 +目标 / 点目标 chip：进入 compose。
 * prefill 有值才写入；undefined 保留输入框已有正文。
 */
function beginGoalCompose(
  prefill?: string,
  opts?: { toastKey?: "slash.goalDesc" | "goal.composeArmed" | null },
): void {
  ensureGoalRuntime().beginCompose(prefill, opts);
}

const promptEditGoal = () => ensureGoalSlashActions().promptEditGoal();
const goalElapsedMsNow = () => ensureGoalBanner().elapsedMsNow();
const stopGoalElapsedTimer = () => ensureGoalBanner().stopElapsedTimer();
const stopGoalSyncTimer = () => ensureGoalBanner().stopSyncTimer();
const ensureGoalSyncTimer = () => ensureGoalBanner().ensureSyncTimer();
const syncGoalFromAgent = () => ensureGoalRuntime().syncFromAgent();
const resetGoalUiState = () => ensureGoalRuntime().resetUiState();
const renderGoalBanner = () => ensureGoalBanner().render();
const sendAgentGoalSlash = (slashLine: string) =>
  ensureGoalRuntime().sendAgentSlash(slashLine);

/**
 * 应用 agent 运行时 goal_updated（同源状态机）
 * status: active | user_paused | complete | blocked | …
 *
 * 注意：complete 之后 agent 仍可能短暂推送 active（classifier 前），
 * 不可把已完成状态打回进行中。
 */

/** 父会话 subagent 进度 / 后台 task → SubagentTaskEventHandlers */
const handleSubagentUpdated = (
  ev: Parameters<SubagentTaskEventHandlers["handleSubagentUpdated"]>[0],
) => ensureSubagentTaskHandlers().handleSubagentUpdated(ev);

const handleTaskUpdated = (
  ev: Parameters<SubagentTaskEventHandlers["handleTaskUpdated"]>[0],
) => ensureSubagentTaskHandlers().handleTaskUpdated(ev);

/** 应用 agent goal_updated（归约 + 投影副作用 → GoalRuntimeActions） */
const applyAgentGoalEvent = (ev: AgentGoalEvent) =>
  ensureGoalRuntime().applyAgentEvent(ev);
const pauseGoal = (opts?: { fromStop?: boolean }) =>
  ensureGoalRuntime().pause(opts);
const resumeGoal = () => ensureGoalRuntime().resume();
const bindGoalBanner = () => ensureGoalRuntime().bindBannerClicks();
const confirmGoalReplaceIfNeeded = (newTitle: string) =>
  ensureGoalRuntime().confirmReplaceIfNeeded(newTitle);
const composerNeedsGoalReplaceConfirm = (raw?: string) =>
  ensureGoalRuntime().composerNeedsReplaceConfirm(raw);
const applyGoalTitle = (title: string) => ensureGoalRuntime().applyTitle(title);
const agentContentForSend = (userContent: string, goalJustSet: string | null) =>
  ensureGoalRuntime().agentContentForSend(userContent, goalJustSet);

/**
 * Stop/Esc 后下一条发送前：
 * conversation_only rewind：从 agent 对话里丢掉被取消的 user 轮（及之后）。
 * UI 时间线不动，用户仍能看到「玻璃 · 已停止」。
 *
 * **不对齐 CLI 的旧做法（已移除）**：把长 focus `<system-reminder>` 拼进
 * session/prompt 用户正文。那会落盘进 chat_history，切回会话后用户气泡可见。
 *
 * CLI 真源：cancel 后 agent 自 arm `pending_interrupt_reminder`，下一轮 user
 * prompt 前注入独立合成项 `[Request interrupted by user]`（system_reminder，
 * 非用户正文）。Desktop 只做 rewind + 干净 userContent。
 */
async function prepareAgentContentAfterCancel(
  threadId: string,
  userContent: string,
): Promise<string> {
  if (!pendingPostCancelFocus) return userContent;

  const idx = lastCancelledPromptIndex;
  // 先清 flag，避免重入；rewind 失败仍发干净用户正文
  pendingPostCancelFocus = false;
  lastCancelledPromptIndex = null;

  if (idx != null && idx >= 0 && threadId && !threadId.startsWith("disk_")) {
    try {
      const rw = await inv("threads.rewind", {
        threadId,
        targetPromptIndex: idx,
        force: true,
        mode: "conversation_only",
      });
      if (!rw.ok) {
        console.warn(
          "[cancel-isolate] conversation_only rewind failed",
          rw.error,
        );
      }
    } catch (e) {
      console.warn("[cancel-isolate] conversation_only rewind error", e);
    }
  }

  return userContent;
}

const runGoalCommand = (
  sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
) => ensureGoalSlashActions().runCommand(sub);

/**
 * 建会话后不再 goals.set。
 * pending 标题在 agentContentForSend → /goal 时生效。
 */
async function persistPendingGoal(): Promise<void> {
  // no-op：保留调用点兼容；真源是 /goal slash + goal_updated
  if (pendingGoalTitle) renderGoalBanner();
}

/** 打开会话：bootstrap 自 Host 投影 / jsonl，不信孤立 goal.json */
async function refreshGoalChipFromSession(): Promise<void> {
  if (!activeSessionId) {
    if (!pendingGoalTitle && !goalComposeActive) {
      resetGoalUiState();
    }
    renderGoalBanner();
    return;
  }
  // 先清本地投影，再 sync（避免跨会话残留）
  if (!goalComposeActive) {
    goalProjection = null;
    goalElapsedAnchorAt = null;
  }
  const g = await inv<{
    title?: string;
    status?: string;
    projection?: GoalUiProjection;
  } | null>("goals.get", {
    sessionId: activeSessionId,
  });
  if (g.ok && g.data?.projection) {
    const p = g.data.projection;
    applyAgentGoalEvent({
      sessionId: activeSessionId,
      goalId: p.goalId,
      objective: p.objective,
      status: p.status,
      phase: p.phase,
      tokenBudget: p.tokenBudget,
      tokensUsed: p.tokensUsed,
      elapsedMs: p.elapsedMs,
      message: p.pauseMessage,
      lastEvent: p.lastEvent,
      verifyingCompletion: p.verifyingCompletion,
      planning: p.planning,
    });
  } else if (g.ok && g.data?.title) {
    // 旧 GoalState 无 projection：不自动 opt-in，走 jsonl
  } else if (!pendingGoalTitle && !goalComposeActive) {
    resetGoalUiState();
  }
  renderGoalBanner();
  void syncGoalFromAgent();
}

/**
 * update_goal tool 仅作 UI 提示，不创建/完成目标投影。
 * 完成态等 goal_updated status=complete。
 */
function maybeGoalFromToolRaw(name?: string, raw?: unknown): void {
  if (!goalProjection) return;
  if (!raw || typeof raw !== "object") return;
  const u = raw as Record<string, unknown>;
  const title = String(u.title ?? name ?? "");
  const meta = u._meta as { "x.ai/tool"?: { name?: string } } | undefined;
  const toolName = meta?.["x.ai/tool"]?.name ?? title;
  const rawOut = (u.rawOutput ?? {}) as Record<string, unknown>;
  const isGoal =
    toolName === "update_goal" ||
    title === "update_goal" ||
    title.startsWith("Goal:") ||
    rawOut.type === "UpdateGoal";
  if (!isGoal) return;

  if (rawOut.type === "UpdateGoal" && rawOut.success === true) {
    const summary = String(rawOut.summary ?? "").toLowerCase();
    if (
      summary.includes("queued") ||
      summary.includes("pending") ||
      summary.includes("classifier")
    ) {
      showToast(tr("goal.confirming"));
      ensureGoalSyncTimer();
      void syncGoalFromAgent();
    }
  }
}

function hidePlusMenu(): void {
  ensurePlusMenu().hide();
}

function showPlusMenu(anchor: HTMLElement): void {
  ensurePlusMenu().show(anchor);
}

function bindPlusMenu(): void {
  ensurePlusMenu().bind();
}

// ── Sidebar ────────────────────────────────────────────────




async function leaveCurrentSessionToWelcome(opts?: {
  /** true：连 L1 队列一并清空；默认 false 只清 UI 镜像 */
  clearQueue?: boolean;
  /**
   * true：不 cancel / 不 detach，侧栏可继续 working（对齐 openThread 切会话）。
   * false（默认）：cancel + detach，彻底断开。
   */
  keepBackground?: boolean;
}): Promise<void> {
  const clearQueue = opts?.clearQueue === true;
  const keepBackground = opts?.keepBackground === true;
  const prevLiveId = isLiveThreadId(activeThreadId) ? activeThreadId : null;
  const prevSid = activeSessionId;
  const wasTurning = turnActive;
  const keepBgWorking =
    keepBackground &&
    !!prevSid &&
    (wasTurning ||
      workingSessions.has(prevSid) ||
      threads.some(
        (x) => x.sessionId === prevSid && x.status === "working",
      ));

  if (keepBackground) {
    // 软离开：快照 turn 投影 + 卸主区；磁盘队列保留；不 cancel / 不 detach
    if (prevSid) {
      snapshotActiveSessionTurn(prevSid);
      snapshotActiveSessionPlan(prevSid);
    }
    if (clearQueue) {
      clearPromptQueue({ silent: true });
    } else {
      ensurePromptQueue().clearLocal();
    }
    if (turnActive) {
      endTurn({ skipQueueDrain: true, skipSessionStoreSync: true });
    }
    // 阶段一：软离开保留 exit_plan pending（不 abandoned）
    closePlanPanelOnSessionChange({
      stashSessionId: prevSid,
      abandonPending: false,
    });
  } else {
    if (turnActive) {
      // 停当前 turn；默认不 wipe 队列（interrupt pause 语义仍可用）
      await cancelTurn({ clearQueue });
    } else if (clearQueue) {
      clearPromptQueue({ silent: true });
    } else {
      // 仅卸下 UI 投影，磁盘 queues/{sessionId}.json 保留
      ensurePromptQueue().clearLocal();
    }

    // cancel 失败或竞态时仍强制 UI 空闲
    if (turnActive) {
      endTurn({ skipQueueDrain: true, outcome: "stopped" });
    }

    if (prevLiveId) {
      const det = await inv("threads.detach", { threadId: prevLiveId });
      if (!det.ok) {
        // 会话可能已死；不挡回欢迎页
        console.warn("[leaveSession] detach failed", det.error?.message);
      }
    }
    // detach 后 agent 已停，侧栏不应再转圈
    if (prevSid) markSessionWorking(prevSid, false);
    // 硬离开：agent 将关 → 未决 plan 审批 abandoned（对齐 acp close）
    closePlanPanelOnSessionChange({
      stashSessionId: prevSid,
      abandonPending: true,
    });
    if (prevSid) clearSessionPlan(prevSid);
  }

  sessionViewGen += 1;
  activeThreadId = null;
  activeSessionId = null;
  setActiveCwd(null);
  // B1：离开会话后隐藏旁路侧问轨（协议 btw 必须 sessionId）
  // 硬离开（detach）：丢弃 in-flight 侧问；软离开（后台继续）仅卸 DOM，投影保留
  if (prevSid && !keepBackground) {
    cancelSessionBtwFlight(prevSid, tr("btw.stopped"));
  }
  rebindBtwSideForSession(null);
  sidePane?.onSessionChanged();
  applyDefaultToChip();
  stopContextPolling();
  setLastContextUsage(null);
  syncContextLabels();
  lateStreamUntil = 0;
  suspendLiveTranscript = false;
  hideAgentCrashBanner();

  if (!goalComposeActive) {
    pendingGoalTitle = null;
    goalProjection = null;
    goalElapsedAnchorAt = null;
  }

  clearTranscript();
  resetStreamState(false);
  endTurn({ skipQueueDrain: true });
  setComposerBusy(false);
  attachUiState = "history_only";
  syncAttachPill();
  // 软离开：恢复侧栏 working（endTurn 会清掉 active 的 working 标记）
  if (keepBgWorking && prevSid) {
    markSessionWorking(prevSid, true);
    if (wasTurning) {
      showToast(tr("session.bgStillRunning"), "info");
    }
  }
  showWelcome(true);
  setWelcomeTitle();
  renderGoalBanner();
  void refreshProjectsAndThreads();
}

/**
 * 「新对话」：离开当前会话 → 欢迎页。
 * 默认 **保持** 后台 agent（与切会话一致），不弹确认框。
 */
async function handleNewChatClick(): Promise<void> {
  await leaveCurrentSessionToWelcome({
    clearQueue: false,
    keepBackground: true,
  });
  ($("composer-input") as HTMLTextAreaElement).focus();
}

/** 若归档/删除的是当前会话，退回欢迎页（保留其它会话队列；删除由 Host 清队列文件） */
function leaveThreadIfOpen(t: ThreadRow): void {
  if (!isThreadOpen(t)) return;
  void leaveCurrentSessionToWelcome({ clearQueue: false });
}

async function archiveThread(t: ThreadRow, archived: boolean): Promise<void> {
  return ensureSessionOps().archiveThread(t, archived);
}

async function deleteThread(t: ThreadRow): Promise<void> {
  return ensureSessionOps().deleteThread(t);
}









async function continueRecentSession(): Promise<void> {
  return ensureSessionOps().continueRecentSession();
}

async function openThread(t: ThreadRow): Promise<void> {
  // 加载 history 期间挂起直播事件，避免与磁盘回放叠双份
  suspendLiveTranscript = true;
  const viewGen = ++sessionViewGen;
  // 方案 B（对齐 CLI switch_to_agent）：切走只换焦点，快照 turn 投影，不 cancel
  const leave = planOpenThreadLeave({
    activeSessionId,
    activeThreadId,
    targetSessionId: t.sessionId,
    targetThreadId: t.id,
    turnActive,
    isSidebarWorking: (sid) => workingSessions.has(sid),
    isThreadListedWorking: (sid) =>
      threads.some((x) => x.sessionId === sid && x.status === "working"),
  });
  const {
    sameSession,
    prevSid,
    wasActivelyTurning,
    keepBgWorking,
  } = leave;
  if (leave.shouldSnapshot && prevSid) {
    // 必须在 endTurn 之前快照（含 turnActive=true）
    snapshotActiveSessionTurn(prevSid);
    snapshotActiveSessionPlan(prevSid);
  }
  // 清主区 DOM/锁，勿写回 idle 覆盖 snapshot
  endTurn({ skipQueueDrain: true, skipSessionStoreSync: true });
  if (keepBgWorking && prevSid) {
    markSessionWorking(prevSid, true);
    // 确保投影仍为 running（markSessionWorking 会补 background 槽）
    const snap = getSessionTurn(prevSid);
    if (
      shouldForceBackgroundTurnActive({
        keepBgWorking,
        prevSid,
        snapTurnActive: snap?.turnActive,
      })
    ) {
      patchSessionTurn(prevSid, {
        turnActive: true,
        turnUiPhase: "working",
        streamArmedThisTurn: true,
      });
    }
    if (wasActivelyTurning) {
      showToast(tr("session.bgStillRunning"), "info");
    }
  }
  hideAgentCrashBanner();
  ensureAvailableCommands().clear();
  if (leave.shouldResetCrossSessionUi) {
    // 阶段一：切走 stash plan/pending，不 abandoned
    closePlanPanelOnSessionChange({
      stashSessionId: prevSid,
      abandonPending: false,
    });
    // S17：换会话重置 prompt 历史，稍后从磁盘 seed
    clearPromptHistoryStore();
    goalTokenBudget = null;
    // 换会话先清上一会话 goal UI，再由 refresh 按磁盘恢复
    resetGoalUiState();
    // chip 互斥焦点按会话重算（见下方 plan 恢复 + refreshGoal）
    sessionModeChipFocus = null;
  }
  activeThreadId = t.id;
  activeSessionId = t.sessionId;
  syncChatTopTitle();
  // 先套上目标会话的 plan 投影（避免全局 planPhase 残留导致误 surface）
  if (!sameSession) {
    const bound = bindPlanProjectionForOpen(
      getSessionPlan(t.sessionId),
      t.sessionId,
    );
    planPhase = bound.planPhase;
    pendingPlanApproval = bound.pendingApproval;
    syncPermLabels();
  }
  // 默认 history_only；按 sessionId 同步真实附着（disk_ 也可能已有 live）
  setAttachUiState("history_only");
  // 方案 B：并行查 Host 是否仍有 in-flight prompt（切回 rehydrate 真源）
  const attachStateP = inv<{
    threadId?: string;
    state?: string;
    lastError?: string;
    promptInFlight?: boolean;
    threadStatus?: string;
  }>("threads.attachState", {
    threadId: t.id.startsWith("disk_") ? undefined : t.id,
    sessionId: t.sessionId,
  }).then((st) => {
    if (viewGen !== sessionViewGen) return st;
    if (!st.ok || !st.data?.state) return st;
    const s = st.data.state as AttachState;
    if (shouldApplyAttachUiState(s)) {
      setAttachUiState(s, st.data.lastError);
    }
    // 列表是 disk_ 但 Host 已 live：回写 live threadId，事件路由更准
    const nextTid = resolveThreadIdAfterAttachState({
      activeThreadId,
      attachThreadId: st.data.threadId,
      attachState: s,
    });
    if (nextTid && nextTid !== activeThreadId) {
      activeThreadId = nextTid;
    }
    return st;
  });
  // L1 按会话加载持久队列（勿静默清空）
  void reloadPromptQueueFromHost();
  setActiveCwd(t.cwd);
  // 按会话换绑旁路侧问 DOM（投影在 session-btw-store；勿沿用上一会话线程）
  rebindBtwSideForSession(t.sessionId);
  void loadBtwHistoryForSession(t.sessionId, viewGen);
  sidePane?.onSessionChanged();
  // chip 跟随会话模型，不用全局默认盖住
  applyThreadToChip(t);
  startContextPolling();
  if (t.projectId) {
    selectedProjectId = t.projectId;
    ensureSidebarList().expandedProjectIds.add(t.projectId);
  } else {
    // 无项目会话：归「对话」组，不按 cwd 误选项目
    selectedProjectId = null;
    projectChoiceTouched = true;
    ensureSidebarList().expandedProjectIds.add(CHATS_GROUP_ID);
  }
  showWelcome(false);
  clearTranscript();

  try {
    // P0：先等 attach（promptInFlight）+ goal 投影，再 history
    // 避免「目标已暂停」与假「工作中 / 工具 running」叠出矛盾态
    const [attachStEarly, _goal] = await Promise.all([
      attachStateP.catch(() => null),
      refreshGoalChipFromSession(),
    ]);
    if (viewGen !== sessionViewGen) return;

    const hist = await inv<{
      entries: Array<{
        role: string;
        text: string;
        toolCallId?: string;
        toolName?: string;
        toolStatus?: string;
        toolInput?: unknown;
        toolOutput?: unknown;
      }>;
      truncated?: boolean;
    }>("history.load", { sessionId: t.sessionId });
    // 快速切换：丢弃过期回放，避免画进错误会话
    if (viewGen !== sessionViewGen) return;
    if (hist.data?.truncated) {
      showToast(
        tr("history.truncated") ||
          "历史过长，仅显示较新片段（完整内容仍在磁盘）",
        "info",
      );
    }
    const promptInFlightEarly = attachStEarly?.data?.promptInFlight;
    const hostStatusEarly = attachStEarly?.data?.threadStatus ?? t.status;
    const willBusyEarly = shouldRehydrateBusy({
      projection: getSessionTurn(t.sessionId),
      sidebarWorking: workingSessions.has(t.sessionId),
      threadStatus: hostStatusEarly,
      promptInFlight: promptInFlightEarly,
    });

    // S15：连贯回放 — user / thought / tool / assistant 同一时间线
    const userTexts = paintHistoryEntries(hist.data?.entries, {
      willBusyEarly,
      endStreamBubble,
      paintUserMessage,
      replayHistoryTool,
      appendProcessText,
      appendLine,
    });
    // S17：从磁盘 user 消息 seed（最新在前）
    if (!sameSession || !ensurePromptHistory().length) {
      seedPromptHistoryFromUserTexts(userTexts);
    }
    // 与直播回合结束一致：过程块默认折叠（历史无精确耗时，不写 Worked for）
    if (processBlockEl?.isConnected) {
      processBlockEl.classList.add("collapsed");
      const caret = processBlockEl.querySelector(".process-caret");
      if (caret) caret.textContent = "▸";
      updateProcessHeader();
    }
    // 双保险：回放后仍 running 的 tool 在 idle 时收口
    if (!willBusyEarly) {
      settleStaleRunningTools({ asFailed: true });
    }
    // P0-A：已加载历史（若将 rehydrate busy，不画「已加载 · 空闲」以免与 Working 矛盾）
    const n = hist.data?.entries?.length ?? 0;
    if (!willBusyEarly) {
      paintHistoryReplayDone(n);
    }
    await refreshProjectsAndThreads();
  } finally {
    if (viewGen === sessionViewGen) {
      suspendLiveTranscript = false;
      // 方案 B：以 Host promptInFlight 为准 rehydrate（已结束则强制 idle）
      const attachSt = await attachStateP.catch(() => null);
      rehydrateSessionTurnProjection(t.sessionId, {
        threadStatus: attachSt?.data?.threadStatus ?? t.status,
        promptInFlight: attachSt?.data?.promptInFlight,
      });
      // 阶段一：恢复 plan / 未决 exit_plan（有 pending 则开侧栏）
      void rehydrateSessionPlan(t.sessionId, { viewGen });
      // P1：合成态刷新目标条（draining 不改 kicker，仅过程条）
      renderGoalBanner();
      refreshTurnPhaseActivityLabel();
    }
  }
}

/** 历史 tool 条目 → 与直播相同的过程块 + tool card */
function replayHistoryTool(e: {
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  text?: string;
  toolStatus?: string;
}): void {
  const name = (e.toolName || "tool").trim() || "tool";
  const id = e.toolCallId || `hist_${name}_${processItemCount}`;
  const rawIn =
    e.toolInput ??
    (e.text ? { summary: e.text.slice(0, 200) } : undefined);
  const rawOut =
    e.toolOutput ??
    (e.text
      ? { content: e.text, title: e.text.slice(0, 120) }
      : rawIn);
  markToolStarted(name, id, rawIn);
  // 无 tool_result：incomplete，勿伪装成功 ✓
  if (e.toolStatus === "incomplete" || e.toolStatus === "running") {
    markToolIncomplete(id, name);
  } else if (e.toolStatus === "failed") {
    markToolIncomplete(id, name, true);
  } else {
    markToolCompleted(id, name, rawOut);
  }
}

/** 历史/异常：工具未完成（无 result 或失败） */
function markToolIncomplete(
  toolCallId?: string,
  name?: string,
  failed?: boolean,
): void {
  const el = $("transcript");
  let row: HTMLElement | null = null;
  if (toolCallId) {
    row = el.querySelector(
      `.line.tool[data-tool-id="${CSS.escape(toolCallId)}"]`,
    ) as HTMLElement | null;
  }
  if (!row && name) {
    const rows = Array.from(el.querySelectorAll(".line.tool.running"));
    for (const r of rows) {
      if ((r.textContent ?? "").includes(name)) {
        row = r as HTMLElement;
        break;
      }
    }
  }
  if (!row) {
    const all = el.querySelectorAll(".line.tool.running");
    row = (all[all.length - 1] as HTMLElement) ?? null;
  }
  if (!row) return;
  row.classList.remove("running");
  row.classList.add(failed ? "failed" : "incomplete");
  const spin = row.querySelector(".tool-spin");
  if (spin) {
    spin.classList.add("done");
    spin.textContent = failed ? "!" : "…";
  }
  const st = row.querySelector(".tool-state");
  if (st) {
    st.textContent = failed
      ? tr("tool.failed") || "失败"
      : tr("tool.incomplete") || "未完成";
  }
}

/**
 * 将 chip 上的 model/effort 同步到 live agent。
 * attach/load 后 session 磁盘模型可能与 UI 不一致，发送前再校准一次。
 *
 * 主 turn 进行中禁止 setModel：Desktop 侧问/插话会走 ensureLiveThread，
 * 若在 busy 时再打 session/set_model，会干扰 agent 并发侧问采样（CLI /btw 不会改 model）。
 */
async function syncLiveSessionModel(threadId: string): Promise<void> {
  if (turnActive) return;
  const id = (modelLabel || "").trim();
  if (!id || threadId.startsWith("disk_")) return;
  const r = await inv("threads.setModel", {
    threadId,
    modelId: id,
    effort: effortLevel,
  });
  if (!r.ok) {
    console.warn(
      "[syncLiveSessionModel]",
      r.error?.message ?? "setModel failed",
      id,
    );
  }
}

type EnsureLiveThreadOpts = {
  /**
   * 是否把 chip 模型同步到 agent。主发送默认 true；
   * 旁路侧问 / 插话应 false（对齐 CLI：只发 x.ai/btw，不先 setModel）。
   */
  syncModel?: boolean;
};

/** Disk session → attach live ACP so turns.prompt works. Ping if already live. */
async function ensureLiveThread(
  opts?: EnsureLiveThreadOpts,
): Promise<string | null> {
  const syncModel = opts?.syncModel !== false;
  if (!activeSessionId || !activeCwd) return null;
  const wantSession = activeSessionId;
  const wantCwd = activeCwd;
  const viewGen = sessionViewGen;
  if (activeThreadId && !activeThreadId.startsWith("disk_")) {
    const ping = await inv<{ ok: boolean; alive: boolean; state: string }>(
      "threads.ping",
      { threadId: activeThreadId },
    );
    if (viewGen !== sessionViewGen || activeSessionId !== wantSession) {
      return null;
    }
    if (ping.ok && ping.data?.ok && ping.data.alive) {
      setAttachUiState("live");
      if (syncModel) await syncLiveSessionModel(activeThreadId);
      return activeThreadId;
    }
    // stale live id → force reattach（发送路径自动重连，不要求用户先点）
    activeThreadId = `disk_${activeSessionId}`;
  }
  setAttachUiState("attaching");
  // 发送/续聊时：状态条提示连接，不依赖 composer 常驻 pill
  if (turnActive) {
    setTurnStatus(tr("attach.connectingStatus") || "正在连接 Agent…");
  }
  // R3：attach 期挂起直播，避免与已回放历史叠双份（Mode B 无 load live buffer）
  suspendLiveTranscript = true;
  try {
    const att = await inv<{ threadId: string }>("threads.attach", {
      sessionId: wantSession,
      cwd: wantCwd,
    });
    // 切会话后勿把旧 attach 结果绑到当前 UI
    if (viewGen !== sessionViewGen || activeSessionId !== wantSession) {
      return null;
    }
    if (!att.ok || !att.data?.threadId) {
      const msg = att.error?.message ?? tr("crash.attachFail");
      showTurnErrorOnce(msg);
      setAttachUiState("failed", msg);
      showAgentCrashBanner(msg);
      return null;
    }
    activeThreadId = att.data.threadId;
    setAttachUiState("live");
    hideAgentCrashBanner();
    // Host attach 已按 meta setModel；主路径再用 chip 校准（侧问/插话跳过）
    if (syncModel) await syncLiveSessionModel(activeThreadId);
    if (viewGen !== sessionViewGen || activeSessionId !== wantSession) {
      return null;
    }
    if (turnActive) {
      setTurnStatus(tr("turn.thinking"));
    }
    // attach 后刷新 agent 广告命令
    void refreshAgentAvailableCommands().then(() => slashPalette?.invalidate());
    return activeThreadId;
  } finally {
    if (viewGen === sessionViewGen) {
      suspendLiveTranscript = false;
    }
  }
}

function setAttachUiState(state: AttachState, lastError?: string): void {
  attachUiState = state;
  syncAttachPill(lastError);
  if (state === "failed") {
    showAgentCrashBanner(lastError || tr("crash.default"));
  }
}

function syncAttachPill(lastError?: string): void {
  // 方案 B：无会话强制藏；有会话时仅 attaching/detaching/failed 由 DOM 层决定是否显示
  const forceHide = !activeSessionId && !activeThreadId;
  syncAttachPillDom(
    attachUiState,
    lastError,
    {
      onConnectClick: () => {
        void connectAgentWarm();
      },
    },
    forceHide,
  );
}

/** 失败态 / 崩溃条：手动重连（主路径仍是发送时 ensureLiveThread 自动 attach） */
async function connectAgentWarm(): Promise<void> {
  if (!activeSessionId) {
    showToast(tr("crash.needSession"), "error");
    return;
  }
  if (activeThreadId && !activeThreadId.startsWith("disk_")) {
    activeThreadId = `disk_${activeSessionId}`;
  }
  setTurnStatus(tr("attach.connectingStatus") || "正在连接 Agent…");
  const tid = await ensureLiveThread();
  if (tid) {
    showToast(tr("attach.connectedToast"));
    removeTurnStatus();
  }
}

async function pickAndAddProject(): Promise<Project | null> {
  const picked = await inv<{ path: string | null; canceled?: boolean }>(
    "system.pickDirectory",
    { title: "选择项目文件夹" },
  );
  if (!picked.ok) {
    alert(picked.error?.message ?? "无法打开文件夹选择器");
    return null;
  }
  if (picked.data?.canceled || !picked.data?.path) return null;

  const res = await inv<Project>("projects.add", {
    path: picked.data.path,
    trust: true,
  });
  if (!res.ok) {
    alert(res.error?.message ?? "添加失败");
    return null;
  }
  selectedProjectId = res.data?.id ?? null;
  projectChoiceTouched = true;
  await refreshProjectsAndThreads();
  showWelcome(true);
  return res.data ?? null;
}

/** 从 Desktop 项目列表移除（不删除磁盘上的文件夹） */
async function removeProjectFromList(
  id: string,
  title: string,
  projectPath: string,
): Promise<void> {
  return ensureProjectActions().removeFromList(id, title, projectPath);
}

async function startNewChat(prompt?: string): Promise<void> {
  let p = selectedProject();
  let cwd: string | undefined;
  let projectId: string | undefined;
  let noProject = false;
  if (p) {
    if (p.trust !== "trusted") {
      await inv("projects.update", { id: p.id, patch: { trust: "trusted" } });
    }
    cwd = p.path;
    projectId = p.id;
  } else {
    // 不使用项目：默认 chats 工作区，不再弹选文件夹
    noProject = true;
    projectId = undefined;
    cwd = undefined;
  }
  // 选定工作目录后再关计划栏（取消选目录时不关）；stash 不 abandon
  closePlanPanelOnSessionChange({
    stashSessionId: activeSessionId,
    abandonPending: false,
  });
  // 目标模式快照：await 前锁定，避免确认框期间 compose 被清掉后当普通消息
  const forceGoal = goalComposeActive;
  const raw =
    prompt ??
    ($("composer-input") as HTMLTextAreaElement).value.trim() ??
    ($("chat-input") as HTMLTextAreaElement).value.trim();
  // 欢迎页手输 /always-approve 等：本地执行，不建空会话
  // 目标模式下正文不是 slash，勿拦截
  if (!prompt && !forceGoal && (await tryRunComposerSlashLine(raw))) return;
  const goalParse = parseGoalInput(raw, { forceGoal });
  if (goalParse.enterComposeOnly) {
    ($("composer-input") as HTMLTextAreaElement).value = "";
    ($("chat-input") as HTMLTextAreaElement).value = "";
    beginGoalCompose();
    return;
  }
  // 替换确认在清空输入框之前；取消则保留草稿
  if (goalParse.goalTitle) {
    if (!(await confirmGoalReplaceIfNeeded(goalParse.goalTitle))) return;
    const gr = await applyGoalTitle(goalParse.goalTitle);
    if (!gr.ok) {
      showToast(gr.message ?? "设置目标失败", "error");
      return;
    }
  }
  const attachSnap = [...ensureAttachUi().list()];
  const { display, content } = buildPromptWithAttachments(goalParse.message);
  if (!content.trim()) {
    showToast(
      tr("chat.needFirstMessage") || "请输入第一条消息以开始新对话",
      "info",
    );
    return;
  }
  // 新会话：重置历史后再记本条
  clearPromptHistoryStore();
  recordPromptHistory(display || content);

  // 若仍挂着旧 live（未点「新对话」或 leave 失败），先 detach 再 create
  if (isLiveThreadId(activeThreadId) || activeSessionId) {
    const prevLive = isLiveThreadId(activeThreadId) ? activeThreadId : null;
    if (turnActive) await cancelTurn({ clearQueue: true });
    if (prevLive) {
      await inv("threads.detach", { threadId: prevLive });
    }
    activeThreadId = null;
    activeSessionId = null;
  }

  // 立刻反馈，不把整轮 prompt 塞进 create（否则要等整轮结束才返回，首字极慢）
  showWelcome(false);
  clearTranscript();
  paintUserMessage(display, attachSnap);
  beginTurn();
  setTurnStatus("正在启动会话…");
  ($("composer-input") as HTMLTextAreaElement).value = "";
  ($("chat-input") as HTMLTextAreaElement).value = "";
  clearAttachments();
  goalComposeActive = false;
  setComposerPlaceholders(false);

  // 只创建 session，不在 create 里 await 完整一轮
  const res = await inv<{
    threadId: string;
    sessionId: string;
    cwd: string;
  }>("threads.create", {
    cwd,
    projectId,
    noProject: noProject || undefined,
    title: display.slice(0, 48) || tr("nav.newChat"),
    model: modelLabel,
    effort: effortLevel,
    maxTurns: maxTurnsLimit ?? undefined,
    // 关键：不传 prompt，避免 Host 阻塞到 turn 结束
    alwaysApprove: accessMode === "always_approve",
    plan: isPlanOn(),
    mode: isPlanOn()
      ? "plan"
      : accessMode === "always_approve"
        ? "always_approve"
        : "normal",
  });

  if (!res.ok) {
    endTurn();
    appendLine(res.error?.message ?? "创建对话失败", "error");
    return;
  }

  activeThreadId = res.data!.threadId;
  activeSessionId = res.data!.sessionId;
  setActiveCwd(res.data!.cwd);
  if (projectId) selectedProjectId = projectId;
  else {
    selectedProjectId = null;
    projectChoiceTouched = true;
    ensureSidebarList().expandedProjectIds.add(CHATS_GROUP_ID);
  }
  suspendLiveTranscript = false;
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  startContextPolling();
  const goalHint = pendingGoalTitle;
  await persistPendingGoal();

  // 目标模式 / 显式 /goal：只发 `/goal …`，绝不当普通消息再发一遍
  const goalJustSet =
    goalParse.goalTitle ||
    goalHint ||
    (forceGoal ? parseGoalBudget(content).objective || null : null);
  const agentContent = agentContentForSend(content, goalJustSet);

  // Pending → Active：下一条消息进入计划 Active
  if (planPhase === "pending") {
    planPhase = "active";
    if (activeSessionId) {
      patchSessionPlan(activeSessionId, { planPhase: "active" });
    }
  }
  ensurePlanPanel().clearLastArtifactPath();
  setTurnStatus(tr("turn.thinking"));
  // 与继续对话相同：直播流式事件，首包即可显示
  const pr = await inv("turns.prompt", {
    threadId: activeThreadId,
    content: agentContent,
    attachments: wireAttachmentsForPrompt(attachSnap),
  });
  if (!pr.ok) {
    endTurn({ outcome: "stopped" });
    showTurnErrorOnce(
      pr.error?.message ?? tr("chat.sendFail"),
      pr.error && "details" in pr.error
        ? (pr.error as { details?: unknown }).details
        : undefined,
    );
  } else {
    // arm 在 turn.started；此处仅 settle 兜底
    scheduleTurnSettle(currentTurnId);
  }
  void refreshContextUsage();
  void refreshProjectsAndThreads();
}

/**
 * 从当前可见输入框读取并清空，构建 display/content。
 * 无内容返回 null。turn 进行中用于入队；空闲时用于直接发送。
 *
 * forceGoal：调用方在 await 前快照的 compose 态；目标模式必须只产出 goalTitle。
 */
function takeComposerPrompt(opts?: { forceGoal?: boolean }): {
  display: string;
  content: string;
  attachSnap: ComposerAttachment[];
  goalTitle: string | null;
} | null {
  const forceGoal = Boolean(opts?.forceGoal || goalComposeActive);
  const input = activeComposerInput();
  const raw = input.value.trim();
  const goalParse = parseGoalInput(raw, { forceGoal });
  if (goalParse.enterComposeOnly) {
    input.value = "";
    beginGoalCompose();
    return null;
  }
  const attachSnap = [...ensureAttachUi().list()];
  const { display, content } = buildPromptWithAttachments(goalParse.message);
  if (!content.trim()) return null;
  input.value = "";
  clearAttachments();
  goalComposeActive = false;
  setComposerPlaceholders(false);
  // S17：记录用户可见文案（不含附件块噪音时用 display）
  recordPromptHistory(display || content);
  // 目标模式硬保证：有正文则 goalTitle 必填，禁止只当普通消息
  const goalTitle =
    goalParse.goalTitle ??
    (forceGoal ? parseGoalBudget(display || content).objective || null : null);
  return {
    display,
    content,
    attachSnap,
    goalTitle,
  };
}

function ensureBtwSideOpen(): boolean {
  return sidePane?.openBtwCategory(false) ?? false;
}

function paintBtwExchangeDom(ex: BtwExchange): void {
  ensureBtwSideUi().paintExchange(ex);
}

/**
 * 按 sessionId 重绘侧问线程（切会话 / 清空 / 离开）。
 * DOM 是全局单例，投影按会话存在 session-btw-store。
 */
function rebindBtwSideForSession(sessionId: string | null): void {
  ensureBtwSideUi().rebindForSession(sessionId);
}

/** 侧栏发送钮：空闲=发送，本会话侧问 in-flight=停止（不禁用输入） */
function syncBtwSideComposer(sessionId?: string | null): void {
  ensureBtwSideUi().syncComposer(sessionId);
}

/** store 更新后：仅当前前台会话刷新对应 DOM 块 */
function applyBtwExchangeUi(
  sessionId: string,
  ex: BtwExchange,
  opts?: { openSide?: boolean },
): void {
  ensureBtwSideUi().applyExchangeUi(sessionId, ex, opts);
}

function clearBtwSideThread(): void {
  ensureBtwSideUi().clearThread();
}

/** 丢弃本会话 in-flight 侧问结果（无 agent cancel API；仅 UI + flightGen） */
function stopBtwSideQuestion(): void {
  ensureBtwSideUi().stopQuestion();
}

/**
 * 打开会话时从磁盘 btw_history.jsonl 合并进 store（可与内存 in-flight 并存）。
 */
async function loadBtwHistoryForSession(
  sessionId: string,
  viewGen: number,
): Promise<void> {
  return ensureBtwActions().loadHistoryForSession(sessionId, viewGen);
}

/** @deprecated 主时间线卡片已弃用；保留 dismiss 以免旧 DOM 残留 */
function dismissBtwCard(): void {
  document.getElementById("btw-live-card")?.remove();
}

async function runBtwCommand(
  questionArg?: string,
): Promise<{ ok: boolean; message?: string }> {
  return ensureBtwActions().runBtwCommand(questionArg);
}

async function runInterjectCommand(
  textArg?: string,
): Promise<{ ok: boolean; message?: string }> {
  return ensureBtwActions().runInterjectCommand(textArg);
}

function bindBtwSidePanel(): void {
  ensureBtwActions().bindSidePanel();
}

/** turn 进行中：将当前输入入队（S19 follow-up） */
function tryEnqueueFromComposer(): boolean {
  if (!turnActive) return false;
  const raw = activeComposerInput()?.value.trim() ?? "";
  const inline = parseInlineBtwOrInterject(raw);
  if (inline?.kind === "btw") {
    // 旁路不占 follow-up 队列；无正文则打开侧栏
    const ta = activeComposerInput();
    if (ta) ta.value = "";
    void runBtwCommand(inline.body || undefined);
    return true;
  }
  if (inline?.kind === "interject") {
    void runInterjectCommand(inline.body);
    const ta = activeComposerInput();
    if (ta) ta.value = "";
    return true;
  }
  // 目标模式快照（入队同步路径，仍先锁标志）
  const forceGoal = goalComposeActive;
  // 纯 `/goal`：进 compose，不算 follow-up
  const goalPeek = parseGoalInput(raw, { forceGoal });
  if (goalPeek.enterComposeOnly) {
    const ta = activeComposerInput();
    if (ta) ta.value = "";
    beginGoalCompose();
    return true;
  }
  // 需替换确认：不能同步入队（无 modal）；调用方应改走 send 路径
  if (composerNeedsGoalReplaceConfirm(raw)) return false;

  const taken = takeComposerPrompt({ forceGoal });
  if (!taken) return false;
  // compose / /goal 入队时 content 即 agent 侧 `/goal …`，避免 drain 时当普通消息
  const agentContent = agentContentForSend(
    taken.content,
    taken.goalTitle ?? pendingGoalTitle ?? null,
  );
  if (taken.goalTitle) {
    void applyGoalTitle(taken.goalTitle);
  }
  const qid = enqueuePrompt({
    display: taken.display,
    content: agentContent,
    attachments: taken.attachSnap,
  });
  // 时间线提示（不画用户气泡）；插话/移出/清空时按 queue id 清除
  appendQueuedSystemLine(qid, taken.display);
  return true;
}

async function sendContinue(): Promise<void> {
  if (!activeThreadId && !activeSessionId) {
    await startNewChat();
    return;
  }
  // 目标模式快照：后续任何 await 都不得让 compose 丢标志后回落普通消息
  const forceGoal = goalComposeActive;
  // 空闲时也可 /btw；/interject 需 turn（目标模式不走 slash/旁路）
  if (!forceGoal) {
    const raw = activeComposerInput()?.value.trim() ?? "";
    if (await tryRunComposerSlashLine(raw)) return;
    const inline = parseInlineBtwOrInterject(raw);
    if (inline?.kind === "btw") {
      const ta = activeComposerInput();
      if (ta) ta.value = "";
      await runBtwCommand(inline.body);
      return;
    }
    if (inline?.kind === "interject") {
      const ta = activeComposerInput();
      if (ta) ta.value = "";
      await runInterjectCommand(inline.body);
      return;
    }
  }

  // Phase4：Cancelling / busy 发送策略
  const hasDraft = Boolean(
    (activeComposerInput()?.value.trim() ?? "") || ensureAttachUi().list().length,
  );
  const busyAction = resolveBusySendWhileCancelling({
    cancelInFlight: Boolean(cancelTurnInFlight),
    turnActive,
    hasDraft,
    busySendMode,
  });
  if (busyAction === "join_only") {
    if (cancelTurnInFlight) await cancelTurnInFlight;
    else if (turnActive) await cancelTurn({ trigger: "stop" });
    return;
  }
  if (busyAction === "enqueue") {
    // 替换目标需确认：不能静默入队失败；提升为 send_now（先停再发）
    if (composerNeedsGoalReplaceConfirm()) {
      if (turnActive || cancelTurnInFlight) {
        await cancelTurn({ trigger: "send_now", pauseQueue: false });
      }
      // fall through 发送路径
    } else {
      if (tryEnqueueFromComposer()) return;
      if (cancelTurnInFlight) await cancelTurnInFlight;
      else if (turnActive) await cancelTurn({ trigger: "stop" });
      return;
    }
  }
  if (busyAction === "wait_then_send") {
    // send_now：等 cancel 完成再发（或先发起 cancel）
    if (turnActive || cancelTurnInFlight) {
      await cancelTurn({ trigger: "send_now", pauseQueue: false });
    }
    // fall through 发送路径
  }
  // send_idle 或 send_now 后：继续下方
  // 先 peek goal：替换确认失败时保留输入框草稿（take 会清空）
  const peekInput = activeComposerInput();
  const peekRaw = (peekInput?.value ?? "").trim();
  const peekGoal = parseGoalInput(peekRaw, { forceGoal });
  if (peekGoal.enterComposeOnly) {
    if (peekInput) peekInput.value = "";
    beginGoalCompose();
    return;
  }
  if (peekGoal.goalTitle) {
    if (!(await confirmGoalReplaceIfNeeded(peekGoal.goalTitle))) return;
  }

  const taken = takeComposerPrompt({ forceGoal });
  if (!taken) return;

  if (taken.goalTitle) {
    const gr = await applyGoalTitle(taken.goalTitle);
    if (!gr.ok) {
      showToast(gr.message ?? "设置目标失败", "error");
      return;
    }
  }
  paintUserMessage(taken.display, taken.attachSnap);
  showWelcome(false);
  // 先出 Thinking，再 attach/prompt（attach 可能要 1s+）
  beginTurn();
  const needAttach =
    !activeThreadId || activeThreadId.startsWith("disk_");
  if (needAttach) setTurnStatus("正在连接会话…");

  const threadId = await ensureLiveThread();
  if (!threadId) {
    endTurn();
    return;
  }
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  await persistPendingGoal();
  // 目标模式：只发 `/goal …` 一条路径（CLI GoalSet）；禁止普通消息
  const goalJustSet =
    taken.goalTitle ??
    pendingGoalTitle ??
    (forceGoal
      ? parseGoalBudget(taken.content).objective || null
      : null);
  const baseContent = agentContentForSend(taken.content, goalJustSet);
  // Pending → Active：下一条消息进入计划 Active
  if (planPhase === "pending") {
    planPhase = "active";
    if (activeSessionId) {
      patchSessionPlan(activeSessionId, { planPhase: "active" });
    }
  }
  ensurePlanPanel().clearLastArtifactPath();
  setTurnStatus(tr("turn.thinking"));

  const agentContent = await prepareAgentContentAfterCancel(
    threadId,
    baseContent,
  );
  const res = await inv("turns.prompt", {
    threadId,
    content: agentContent,
    attachments: wireAttachmentsForPrompt(taken.attachSnap),
  });
  if (!res.ok) {
    endTurn({ outcome: "stopped" });
    showTurnErrorOnce(
      res.error?.message ?? tr("chat.sendFail"),
      res.error && "details" in res.error
        ? (res.error as { details?: unknown }).details
        : undefined,
    );
  } else {
    // arm 在 turn.started；此处仅 settle 兜底
    scheduleTurnSettle(currentTurnId);
    void refreshContextUsage();
    void refreshProjectsAndThreads();
  }
}

// ── 侧栏分类（文件 / 浏览器 / 终端，已收进侧栏） ───────────

async function showFilesPanel(): Promise<void> {
  await sidePane?.showChangesSummary();
}

async function showBrowserPanel(): Promise<void> {
  sidePane?.setCategory("browser", true);
}

async function showTerminalPanel(): Promise<void> {
  sidePane?.setCategory("terminal", true);
}

// ── Modals ─────────────────────────────────────────────────

function openModal(title: string, html: string): void {
  openModalDlg(title, html);
}

function closeModal(): void {
  closeModalDlg();
}

async function showSearchModal(): Promise<void> {
  await ensureSessionSearch().show();
}

async function showPluginsPage(): Promise<void> {
  if (!pluginsPage) {
    pluginsPage = new PluginsPageController({
      inv,
      esc,
      getSelectedProjectPath: () => selectedProject()?.path,
      getSelectedProjectName: () => {
        const p = selectedProject();
        return (
          p?.title?.trim() ||
          p?.path?.split(/[/\\]/).filter(Boolean).pop()
        );
      },
      onUseSkill: (name) => {
        void runSlashCommand({
          id: `skill:${name}`,
          title: name,
          description: "",
          action: {
            kind: "insert-text",
            text: `请使用 skill「${name}」：`,
          },
        });
      },
      /** 新建技能 → 新对话欢迎页，composer 插入 /create-skill（用户再发） */
      onCreateSkill: () => void openNewChatWithCreateSkill(),
      onOpenPath: (path0) => {
        // 插件页路径：统一路由（目录/二进制仍会落到系统打开）
        void openPathInWorkspace({ path: path0 });
      },
      onToast: (msg) => showToast(msg),
      onClosed: restoreComposerAfterOverlay,
    });
  }
  await pluginsPage.show();
}

/**
 * 扩展中心「新建技能」：新会话 + 预填 `/create-skill `。
 * User 落盘路径由 Host skills.resolve 对 create-skill 强制覆盖（~/.grok-desktop/skills），
 * 不依赖 composer 长文案（发送时会被 skill envelope 替换）。
 */
async function openNewChatWithCreateSkill(): Promise<void> {
  await leaveCurrentSessionToWelcome({ keepBackground: true });
  const ta = $("composer-input") as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = "/create-skill ";
    ta.focus();
    const pos = ta.value.length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    refreshComposerSlashHighlight(ta);
  }
  showToast(tr("plug.createSkillReady"), "info");
}

async function showAutomationsModal(): Promise<void> {
  await ensureAutomationsModal().show();
}

function resolveTheme(pref: SettingsThemePreference): ThemeVariant {
  return ensureTheme().resolve(pref);
}

function appearanceForVariant(v: ThemeVariant): VariantAppearance {
  return ensureTheme().appearanceForVariant(v);
}

function paintResolvedTheme(
  resolved: ThemeVariant,
  opts?: { animate?: boolean },
): void {
  ensureTheme().paint(resolved, opts);
}

function bindSystemThemeListener(): void {
  ensureTheme().bindSystemListener();
}

/** 应用 mode（system/light/dark）并刷新 chrome */
function applyThemePreference(pref: SettingsThemePreference): void {
  themePreference = pref;
  ensureTheme().applyPreference(pref);
  // 镜像到 main 本地变量（applyDesktopConfig 等仍读 appearanceLight/Dark）
  appearanceLight = ensureTheme().getAppearanceLight();
  appearanceDark = ensureTheme().getAppearanceDark();
}

/** 写入内存中的某 variant 外观并可选立即绘制 */
function setVariantAppearance(
  variant: ThemeVariant,
  app: VariantAppearance,
  repaint: boolean,
): void {
  if (variant === "light") appearanceLight = app;
  else appearanceDark = app;
  ensureTheme().setVariantAppearance(variant, app, repaint);
}

/** 导出当前 resolved 变体的 codex-theme-v1 串 */
function exportCurrentThemeString(): string {
  return ensureTheme().exportCurrentString();
}

function applyDesktopConfig(cfg: {
  defaultPermMode: SettingsPermMode;
  defaultModel: string;
  defaultOpenTarget: SettingsOpenTarget;
  locale?: LocalePreference;
  theme?: SettingsThemePreference;
  appearanceLight?: VariantAppearance;
  appearanceDark?: VariantAppearance;
  busySendMode?: "queue" | "send_now";
}): void {
  // 只更新「新对话默认」；切换供应商等操作不得覆盖当前会话的权限模式 / 模型 chip
  defaultModelLabel = cfg.defaultModel || "grok";
  defaultOpenTarget = cfg.defaultOpenTarget;
  if (cfg.busySendMode === "send_now" || cfg.busySendMode === "queue") {
    busySendMode = cfg.busySendMode;
  }
  // locale 仅在显式传入且相对当前有变化时刷 DOM（切换提供商不应带 locale）
  if (cfg.locale !== undefined && cfg.locale !== localePreference) {
    localePreference = cfg.locale;
    const resolved = resolveLocale(cfg.locale, navigator.language);
    setLocale(resolved);
    applyDomI18n(document);
    document.title = tr("app.title");
    syncPermLabels();
    setComposerPlaceholders(goalComposeActive);
    syncModelLabels();
  }
  let appearanceDirty = false;
  if (cfg.appearanceLight) {
    appearanceLight = cfg.appearanceLight;
    ensureTheme().setAppearanceLight(cfg.appearanceLight);
    appearanceDirty = true;
  }
  if (cfg.appearanceDark) {
    appearanceDark = cfg.appearanceDark;
    ensureTheme().setAppearanceDark(cfg.appearanceDark);
    appearanceDirty = true;
  }
  if (cfg.theme !== undefined && cfg.theme !== themePreference) {
    applyThemePreference(cfg.theme);
  } else if (appearanceDirty) {
    paintResolvedTheme(resolveTheme(themePreference));
  }
  if (!activeSessionId) {
    accessMode =
      cfg.defaultPermMode === "always_approve" ? "always_approve" : "normal";
    applyDefaultToChip();
    syncPermLabels();
  }
  // 供应商列表可能已变，清掉模型菜单缓存并校验当前 chip
  invalidateModelsCache();
  // 设置仍开着：只后台校准目录/chip，禁止 setModel / toast（关页 restore 再补）
  // 避免与 inert 恢复、用户返回会话抢同一帧
  void ensureChipModelAvailable({
    toast: Boolean(activeSessionId) && !isMainShellOverlayOpen(),
    allowSetModel: !isMainShellOverlayOpen(),
    force: true,
  });
}

/**
 * 强制主壳可交互（防 settings-open / inert 粘住导致无法输入）。
 * 插件全页仍可见时只清 settings 态，保留其 inert。
 */
function forceMainShellInteractive(): void {
  const app = document.getElementById("app");
  if (!app) return;
  // 设置内嵌弹层若残留，会挡点击/抢焦点
  document.getElementById("auth-notice-backdrop")?.remove();
  app.classList.remove("settings-open");
  document.getElementById("settings-page")?.classList.add("hidden");
  const plugins = document.getElementById("plugins-page");
  const pluginsVisible = Boolean(
    plugins && !plugins.classList.contains("hidden"),
  );
  if (pluginsVisible) return;
  app.classList.remove("plugins-open");
  app.removeAttribute("aria-hidden");
  if ("inert" in app) {
    (app as HTMLElement & { inert: boolean }).inert = false;
  }
}

/** 主壳是否仍被 inert / settings-open 锁住（无法聚焦 composer） */
function isAppShellLocked(): boolean {
  const app = document.getElementById("app");
  if (!app) return true;
  if (app.classList.contains("settings-open")) return true;
  if (app.classList.contains("plugins-open")) return true;
  if ("inert" in app && (app as HTMLElement & { inert: boolean }).inert) {
    return true;
  }
  return false;
}

/** 尝试把焦点落到当前 composer；成功返回 true */
function tryFocusActiveComposer(): boolean {
  if (isMainShellOverlayOpen() || isAppShellLocked()) return false;
  const ta = activeComposerInput();
  if (!ta || ta.disabled || ta.readOnly) return false;
  try {
    ta.focus({ preventScroll: true });
    return document.activeElement === ta;
  } catch {
    return false;
  }
}

/**
 * 设置/插件关闭后恢复主界面可输入。
 * 顺序：先清 inert/visibility → 重试 focus → 焦点稳定后再做模型校准/setModel。
 * 避免 models.list / setModel 与 inert 解除抢同一窗口导致「闪一下 + 短期无法输入」。
 */
let overlayRestoreGen = 0;
function restoreComposerAfterOverlay(): void {
  const gen = ++overlayRestoreGen;
  forceMainShellInteractive();
  hideModelMenu();
  $("perm-menu")?.classList.add("hidden");

  const scheduleDeferredChipCheck = () => {
    if (gen !== overlayRestoreGen) return;
    if (isMainShellOverlayOpen() || isAppShellLocked()) return;
    // 不 force：登录/登出时 onAuthChanged 已拉过目录；此处只补 chip/setModel
    // 未登录时 Host 侧 list 瞬时返回 custom，不会再卡数秒
    void ensureChipModelAvailable({
      toast: Boolean(activeSessionId),
      allowSetModel: true,
    });
  };

  const attemptFocus = (n: number) => {
    if (gen !== overlayRestoreGen) return;
    forceMainShellInteractive();
    if (isMainShellOverlayOpen()) return;
    if (tryFocusActiveComposer()) {
      // 先可输入，再异步校准模型（让首击/首键不被 list 抢）
      window.setTimeout(scheduleDeferredChipCheck, 120);
      return;
    }
    // Electron 上 inert/visibility 偶发晚一帧；最多约 ~400ms 重试
    if (n < 12) {
      window.setTimeout(() => attemptFocus(n + 1), 20 + n * 10);
      return;
    }
    // 焦点失败仍做校准，避免 chip 与目录长期不一致
    scheduleDeferredChipCheck();
  };

  // 用户点主区 composer 附近时再兜底 focus（原生 alert/登出后常见丢焦点）
  const onPointer = (e: Event) => {
    if (gen !== overlayRestoreGen) return;
    if (isMainShellOverlayOpen() || isAppShellLocked()) return;
    if (document.activeElement === activeComposerInput()) return;
    const t = e.target as Node | null;
    if (!t || !(t instanceof Element)) return;
    // 仅主聊天/欢迎输入区，勿抢侧栏/菜单点击
    if (
      !t.closest(
        "#chat-input, #composer-input, .chat-composer-dock, .composer-card, #chat, #welcome",
      )
    ) {
      return;
    }
    tryFocusActiveComposer();
  };
  document.addEventListener("pointerdown", onPointer, true);
  window.setTimeout(() => {
    document.removeEventListener("pointerdown", onPointer, true);
  }, 4000);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => attemptFocus(0));
  });
}

async function showSettingsPage(section?: string): Promise<void> {
  if (!settingsPage) {
    settingsPage = new SettingsPageController({
      inv,
      esc,
      getSelectedProjectPath: () => selectedProject()?.path,
      getSelectedProjectId: () => selectedProjectId,
      onConfigApplied: applyDesktopConfig,
      onClosed: restoreComposerAfterOverlay,
      onAuthChanged: () => {
        invalidateModelsCache();
        // 登出会 detach 全部 live：本地立刻降为 disk_，勿再对僵尸 id setModel
        if (
          activeSessionId &&
          activeThreadId &&
          !activeThreadId.startsWith("disk_")
        ) {
          activeThreadId = `disk_${activeSessionId}`;
        }
        if (turnActive) {
          endTurn({ skipQueueDrain: true, outcome: "stopped" });
        } else if (activeSessionId) {
          setComposerBusy(false);
          markSessionWorking(activeSessionId, false);
        }
        // 设置仍开着：只校准 chip 目录；禁止 setModel（关页 restore 再补）
        // 未登录时 Host models.list 瞬时返回 custom，不会 spawn CLI
        void ensureChipModelAvailable({
          toast: false,
          force: true,
          allowSetModel: false,
        });
      },
      resolveThemeVariant: () => resolveTheme(themePreference),
      getAppearance: (v) => appearanceForVariant(v),
      exportThemeString: () => exportCurrentThemeString(),
    });
  }
  await settingsPage.show(
    section as
      | "general"
      | "appearance"
      | "account"
      | "about"
      | "memory"
      | "hooks"
      | "shortcuts"
      | undefined,
  );
}

/** 顶栏更新按钮：有可用/已下载更新时显示绿点 */
let lastAppUpdateSnap: AppUpdateUiSnap | null = null;

function syncAppUpdateTopButton(snap?: AppUpdateUiSnap | null): void {
  if (snap) lastAppUpdateSnap = snap;
  lastAppUpdateSnap = syncAppUpdateTopButtonPure(snap, lastAppUpdateSnap);
}

async function onAppUpdateTopClick(): Promise<void> {
  const u = lastAppUpdateSnap;
  const canUpdate = Boolean(u?.canUpdate) && u?.error !== "dev-only";
  // 打包版：无已知更新时先检查；开发版直接进关于页说明
  if (canUpdate) {
    const phase = (u?.phase || "").toLowerCase();
    if (
      phase !== "available" &&
      phase !== "downloaded" &&
      phase !== "downloading" &&
      phase !== "checking"
    ) {
      void inv("app.update.check");
    }
  }
  await showSettingsPage("about");
}

/** 权限菜单关闭动画收尾定时器 */
function isPermMenuVisible(): boolean {
  return ensurePermMenu().isVisible();
}

/**
 * 关闭权限菜单。
 * @param immediate 窗口 resize 等场景跳过动画，避免残影留在原点
 */
function hidePermMenu(opts?: { immediate?: boolean }): void {
  ensurePermMenu().hide(opts);
}

/** 窗口几何变化时关掉 fixed 浮层，避免锚点失效留在原点 */
function hideEphemeralMenus(): void {
  hidePermMenu({ immediate: true });
  hideModelMenu();
  hidePlusMenu();
}

function syncPermMenuActiveItem(): void {
  ensurePermMenu().syncActiveItem();
}

function showPermMenu(anchor: HTMLElement): void {
  ensurePermMenu().show(anchor);
}

/**
 * Shift+Tab：循环主展示模式（对齐 Grok Build CLI）
 * Normal → Plan → Always-approve → Normal
 */
async function cycleSessionMode(): Promise<void> {
  return ensureSessionPolicy().cycleSessionMode();
}

// ── Events ─────────────────────────────────────────────────

function showPermission(requestId: string, summary: string): void {
  ensurePermPromptUi().showPermission(requestId, summary);
}

/**
 * ask_user_question UI：单选/多选题目；提交 → askUser.respond accepted。
 */
async function showAskUserDialog(ev: {
  requestId: string;
  mode?: string;
  questions?: Array<{
    question: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}): Promise<void> {
  return ensurePermPromptUi().showAskUser(ev);
}

async function handleDeepLinkPayload(payload: string): Promise<void> {
  return ensureShellNav().handleDeepLinkPayload(payload);
}

function handleShellNavigate(view: "command" | "inbox" | string): void {
  ensureShellNav().handleShellNavigate(view);
}

function handleShellNotice(code: string, message?: string): void {
  ensureShellNav().handleShellNotice(code, message);
}

const isTranscriptScopedEvent = (ev: { type?: string }) =>
  isTranscriptScopedEventPure(ev);

const eventBelongsToActiveSession = (ev: {
  sessionId?: string;
  threadId?: string;
}) =>
  eventBelongsToActiveSessionPure(ev, {
    activeSessionId,
    activeThreadId,
  });

function onEvent(raw: unknown): void {
  const ev = raw as NormalizedEvent & {
    activity?: string;
    payload?: string;
    view?: string;
    code?: string;
    message?: string;
    state?: string;
    lastError?: string;
    syncError?: string;
    phase?: string;
    currentVersion?: string;
    latestVersion?: string;
    percent?: number;
    error?: string;
    canUpdate?: boolean;
    releasesUrl?: string;
  };
  // shell / app / attach / queue / plan / status 等总线
  if (ensureBusEventHandlers().tryHandle(ev)) return;

  // Transcript / turn 事件：按 sessionId 严格隔离（含 disk_* 浏览态）
  // 方案 B：非当前会话仍更新 per-session 投影（不写当前 transcript）
  const scopeEv = ev as {
    type?: string;
    sessionId?: string;
    threadId?: string;
    role?: string;
    text?: string;
    requestId?: string;
    summary?: string;
  };
  if (isTranscriptScopedEvent(scopeEv) && !eventBelongsToActiveSession(scopeEv)) {
    applyBackgroundTranscriptEvent(scopeEv, { markSessionWorking });
    return;
  }
  // create / openThread 期间：当前会话事件仍更新投影，不写 transcript
  if (suspendLiveTranscript) {
    if (activeSessionId) {
      applySuspendedLiveTranscriptEvent(scopeEv, {
        activeSessionId,
        eventBelongs: eventBelongsToActiveSession(scopeEv),
        showPermission,
        permissionEv: scopeEv,
        markSessionWorking,
      });
    }
    return;
  }
  // 前台 transcript / turn：统一经 TranscriptEventHandlers
  ensureTranscriptHandlers().handle(ev as {
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
  });
}

const handlePlanApprovalRequested = (
  ev: Parameters<PlanEventHandlers["handleApprovalRequested"]>[0],
) => ensurePlanEventHandlers().handleApprovalRequested(ev);

const handlePlanModeChanged = (
  ev: Parameters<PlanEventHandlers["handleModeChanged"]>[0],
) => ensurePlanEventHandlers().handleModeChanged(ev);

// ── Boot ───────────────────────────────────────────────────

/** 将 data-sidebar-icon 占位替换为 Codex 提取的 SVG */
function mountSidebarIcons(root: ParentNode = document): void {
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>("[data-sidebar-icon]"),
  )) {
    const name = el.dataset.sidebarIcon as SidebarIconName | undefined;
    if (!name) continue;
    try {
      el.outerHTML = sidebarIcon(name, el.className || "nav-ico");
    } catch {
      /* 未知 icon 名时保留空占位 */
    }
  }
}

async function boot(): Promise<void> {
  if (!window.grokDesktop) {
    document.body.innerHTML = `
      <div style="padding:32px;font-family:system-ui">
        <h2>请通过 Electron 启动</h2>
        <pre style="background:#f4f4f4;padding:12px;border-radius:8px">cd apps/grok-desktop
npm start</pre>
      </div>`;
    return;
  }
  mountSidebarIcons();
  window.grokDesktop.onEvent(onEvent);
  sidePane = new SidePaneController({
    inv,
    getCwd: () => activeCwd ?? selectedProject()?.path ?? null,
    getSessionId: () => activeSessionId,
    onFocusModeChange: (focus) => {
      if (focus) {
        const fi = $("focus-input") as HTMLTextAreaElement;
        requestAnimationFrame(() => fi.focus());
      }
    },
    // 轨上点「计划」→ 加载 plan 内容（与 chip / /view-plan 同源）
    onSelectPlan: () => {
      void showViewPlan().then((r) => {
        if (!r.ok && r.message) showToast(r.message, "error");
      });
    },
    // 文件树 / MD 内链与 transcript 同源路由
    openPath: async (filePath, line) => {
      await openPathInWorkspace({ path: filePath, line });
    },
  });
  bindPlanPanel();
  syncPlanRailActivity();
  bindCodeCopyDelegate($("transcript"));
  bindFileLinkDelegate($("transcript"), async (filePath, line) => {
    // Codex：点路径 → 统一路由（图 lightbox / 文侧栏 / 目录系统）
    await openPathInWorkspace({ path: filePath, line });
  });
  // 对话 + 侧栏 MD：http(s)/mailto 走系统浏览器，避免 Electron 内黑屏
  bindExternalLinkDelegate(document.body, async (url) => {
    const res = await inv("system.openExternal", { url });
    if (!res.ok) {
      showToast(res.error?.message ?? "无法打开链接", "error");
    }
  });
  // 全屏侧栏底部悬浮输入
  const sendFromFocus = () => {
    const fi = $("focus-input") as HTMLTextAreaElement;
    const text = fi.value.trim();
    if (!text) return;
    // 写入当前可见 composer，复用现有发送路径
    const chatHidden = $("chat").classList.contains("hidden");
    if (chatHidden) {
      ($("composer-input") as HTMLTextAreaElement).value = text;
    } else {
      ($("chat-input") as HTMLTextAreaElement).value = text;
    }
    fi.value = "";
    if (turnActive) {
      void sendContinue();
      return;
    }
    if (activeThreadId || activeSessionId) void sendContinue();
    else void startNewChat(text);
  };
  $("btn-focus-send").onclick = () => sendFromFocus();
  $("focus-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
      e.preventDefault();
      sendFromFocus();
    }
  });
  syncPermLabels();
  syncModelLabels();
  prefetchModelsList();
  bindSlashPalette();
  bindAtFilePalette();
  bindPlusMenu();
  bindChatScrollLayout();
  bindSessionModeChips();
  bindGoalBanner();
  bindImagePaste();
  bindComposerDrop();
  bindBtwSidePanel();
  renderAttachmentChips();
  renderGoalBanner();

  for (const id of ["btn-model", "btn-model-2"] as const) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = $("model-menu");
      if (!menu.classList.contains("hidden") && menu.dataset.anchor === id) {
        hideModelMenu();
        return;
      }
      menu.dataset.anchor = id;
      void showModelMenu(btn);
    };
  }
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#model-menu, #btn-model, #btn-model-2")) {
      hideModelMenu();
    }
  });

  $("btn-continue-recent").onclick = () => {
    if (turnActive) void cancelTurn();
    void continueRecentSession();
  };
  $("btn-new-chat").onclick = () => {
    // 最小集确认 + 默认不保持；发送第一条消息时再 threads.create
    void handleNewChatClick();
  };

  $("btn-context").onclick = () => {
    void showContextDetails();
  };
  $("btn-search").onclick = () => void showSearchModal();
  $("btn-plugins").onclick = () => void showPluginsPage();
  $("btn-automations").onclick = () => void showAutomationsModal();
  $("btn-settings").onclick = () => void showSettingsPage();
  $("btn-app-update").onclick = () => void onAppUpdateTopClick();
  // 侧栏设置行右侧：检查更新（id 不变）
  // 初始态 + 启动后拉一次状态（打包版会静默 check 并推送）
  void inv<{
    phase?: string;
    currentVersion?: string;
    latestVersion?: string;
    canUpdate?: boolean;
    error?: string;
    releasesUrl?: string;
  }>("app.update.status").then((res) => {
    if (res.ok && res.data) {
      syncAppUpdateTopButton({
        phase: res.data.phase,
        currentVersion: res.data.currentVersion,
        latestVersion: res.data.latestVersion,
        canUpdate: res.data.canUpdate,
        error: res.data.error,
        releasesUrl: res.data.releasesUrl,
      });
    } else {
      syncAppUpdateTopButton({ canUpdate: false, phase: "idle" });
    }
  });
  $("btn-modal-close").onclick = () => closeModal();
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) closeModal();
  };

  // 左侧栏展开 / 收起 + 右缘拖宽
  const LS_SIDEBAR = "grok.desktop.sidebarCollapsed";
  const LS_SIDEBAR_W = "grok.desktop.sidebarWidth";
  const SIDEBAR_W_DEFAULT = 220;
  const SIDEBAR_W_MIN = 160;
  const SIDEBAR_W_MAX = 480;
  /**
   * 窄窗自动收起左右栏，只留主会话（对齐 Codex 响应式）。
   * 加宽后恢复进入窄窗前的展开状态；不写入「用户偏好」以免污染 LS。
   */
  const LAYOUT_COMPACT_MAX = 960;
  let layoutCompact = false;
  let preCompactLeftCollapsed = false;
  let preCompactRightOpen = false;
  const applySidebarWidth = (px: number, persist = true) => {
    const maxByViewport = Math.floor(window.innerWidth * 0.45);
    const w = Math.min(
      Math.max(SIDEBAR_W_MIN, Math.round(px)),
      Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, maxByViewport)),
    );
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    if (persist) {
      try {
        localStorage.setItem(LS_SIDEBAR_W, String(w));
      } catch {
        /* ignore */
      }
    }
    return w;
  };
  try {
    const savedW = Number(localStorage.getItem(LS_SIDEBAR_W));
    if (Number.isFinite(savedW) && savedW >= SIDEBAR_W_MIN) {
      applySidebarWidth(savedW, false);
    }
  } catch {
    /* keep CSS default */
  }
  const applyLeftSidebar = (collapsed: boolean, persist = true) => {
    const app = document.getElementById("app");
    const expandBtn = document.getElementById("btn-sidebar-expand");
    app?.classList.toggle("sidebar-collapsed", collapsed);
    expandBtn?.classList.toggle("hidden", !collapsed);
    expandBtn?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (persist) {
      try {
        localStorage.setItem(LS_SIDEBAR, collapsed ? "1" : "0");
      } catch {
        /* ignore */
      }
    }
  };
  const toggleLeftSidebar = () => {
    const app = document.getElementById("app");
    const next = !app?.classList.contains("sidebar-collapsed");
    applyLeftSidebar(next);
  };
  try {
    applyLeftSidebar(localStorage.getItem(LS_SIDEBAR) === "1");
  } catch {
    applyLeftSidebar(false);
  }
  document.getElementById("btn-sidebar-collapse")!.onclick = () =>
    applyLeftSidebar(true);
  document.getElementById("btn-sidebar-expand")!.onclick = () =>
    applyLeftSidebar(false);

  /**
   * 进入/离开窄窗：自动收起或恢复左右栏。
   * 仅在跨越阈值时动作；窄窗内用户可临时展开，不反复强制关、不改 preCompact。
   * 全屏 focusMode 不强制关右栏。
   */
  const syncLayoutCompact = () => {
    const want = window.innerWidth <= LAYOUT_COMPACT_MAX;
    const app = document.getElementById("app");
    app?.classList.toggle("layout-compact", want);
    if (want === layoutCompact) return;

    if (want) {
      layoutCompact = true;
      preCompactLeftCollapsed =
        app?.classList.contains("sidebar-collapsed") ?? false;
      preCompactRightOpen =
        (sidePane?.isOpen() ?? false) && !(sidePane?.isFocusMode() ?? false);
      applyLeftSidebar(true, false);
      if (sidePane?.isOpen() && !sidePane.isFocusMode()) {
        sidePane.setOpen(false);
      }
    } else {
      layoutCompact = false;
      applyLeftSidebar(preCompactLeftCollapsed, true);
      if (preCompactRightOpen && sidePane && !sidePane.isOpen()) {
        sidePane.setOpen(true);
      }
      preCompactLeftCollapsed = false;
      preCompactRightOpen = false;
    }
  };
  syncLayoutCompact();
  window.addEventListener("resize", () => {
    syncLayoutCompact();
    try {
      const cur =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--sidebar-w",
          ),
        ) || SIDEBAR_W_DEFAULT;
      applySidebarWidth(cur, false);
    } catch {
      /* ignore */
    }
  });

  // 左栏右缘拖动改宽
  const sidebarResizer = document.getElementById("sidebar-resizer");
  if (sidebarResizer) {
    sidebarResizer.addEventListener("pointerdown", (e) => {
      const app = document.getElementById("app");
      if (app?.classList.contains("sidebar-collapsed")) return;
      e.preventDefault();
      const pe = e as PointerEvent;
      sidebarResizer.classList.add("dragging");
      document.body.classList.add("sidebar-resizing");
      try {
        sidebarResizer.setPointerCapture(pe.pointerId);
      } catch {
        /* ignore */
      }
      const startX = pe.clientX;
      const startW =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--sidebar-w",
          ),
        ) || SIDEBAR_W_DEFAULT;
      const onMove = (ev: PointerEvent) => {
        // 向右拖 → 侧栏变宽
        applySidebarWidth(startW + (ev.clientX - startX), false);
      };
      const onUp = (ev: PointerEvent) => {
        sidebarResizer.classList.remove("dragging");
        document.body.classList.remove("sidebar-resizing");
        try {
          sidebarResizer.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        const cur =
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--sidebar-w",
            ),
          ) || startW;
        applySidebarWidth(cur, true);
        sidebarResizer.removeEventListener("pointermove", onMove);
        sidebarResizer.removeEventListener("pointerup", onUp);
        sidebarResizer.removeEventListener("pointercancel", onUp);
      };
      sidebarResizer.addEventListener("pointermove", onMove);
      sidebarResizer.addEventListener("pointerup", onUp);
      sidebarResizer.addEventListener("pointercancel", onUp);
    });
  }

  // 侧栏「添加项目」已去掉；欢迎页 / 项目 chip 菜单仍可添加

  $("btn-project-chip").onclick = (e) => {
    e.stopPropagation();
    openProjectPicker();
  };
  $("project-picker-q").addEventListener("input", () => {
    renderProjectPickerList(
      ($("project-picker-q") as HTMLInputElement).value,
    );
  });
  $("project-picker-q").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      e.preventDefault();
      closeProjectPicker();
    }
  });
  $("picker-add-project").onclick = async (e) => {
    e.stopPropagation();
    closeProjectPicker();
    await pickAndAddProject();
  };
  $("picker-no-project").onclick = (e) => {
    e.stopPropagation();
    selectedProjectId = null;
    projectChoiceTouched = true;
    ensureSidebarList().expandedProjectIds.add(CHATS_GROUP_ID);
    closeProjectPicker();
    setWelcomeTitle();
    showWelcome(true);
    void refreshProjectsAndThreads();
  };
  // 点击外部关闭项目选择
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#project-picker, #btn-project-chip")) {
      closeProjectPicker();
    }
  });

  const openProjectLocation = async () => {
    const p = selectedProject();
    if (!p) {
      showToast("请先选择或添加项目", "error");
      await pickAndAddProject();
      return;
    }
    const target = (defaultOpenTarget || "explorer").trim();
    const useExplorer = !target || target === "explorer";
    const res = useExplorer
      ? await inv("system.openPath", { path: p.path })
      : await inv("system.openInEditor", {
          path: p.path,
          // 具体命令由 Host 按 defaultOpenTarget / 探测结果解析
          editor: target === "editor" ? undefined : target,
        });
    if (!res.ok) {
      showToast(
        res.error?.message ??
          (useExplorer ? "无法在资源管理器中打开" : "无法打开编辑器"),
        "error",
      );
    }
  };
  $("btn-open-location").onclick = () => void openProjectLocation();

  $("btn-sandbox-setup").onclick = () => {
    showPermMenu($("btn-sandbox-setup"));
  };
  $("btn-perm-mode").onclick = () => showPermMenu($("btn-perm-mode"));
  $("btn-perm-mode-2").onclick = () => showPermMenu($("btn-perm-mode-2"));
  document.addEventListener("click", (e) => {
    if (!isPermMenuVisible()) return;
    if (
      !(e.target as HTMLElement).closest(
        "#perm-menu, #btn-perm-mode, #btn-perm-mode-2, #btn-sandbox-setup",
      )
    ) {
      hidePermMenu();
    }
  });
  $("perm-menu").onclick = (e) => {
    const t = e.target as HTMLElement;
    const mode = t.dataset.mode as SettingsPermMode | "plan" | undefined;
    if (!mode || mode === "plan") return;
    // 选中高亮先于收起动画，关闭过程中可见反馈
    for (const btn of Array.from($("perm-menu").querySelectorAll<HTMLElement>("[data-mode]"))) {
      btn.classList.toggle("is-active", btn.dataset.mode === mode);
    }
    hidePermMenu();
    // 权限菜单只切访问策略，绝不退出 plan
    if (mode === "always_approve") {
      accessMode = "always_approve";
      syncPermLabels();
      void syncSessionPolicyLive({
        alwaysApprove: true,
        plan: isPlanOn(),
      });
      return;
    }
    accessMode = "normal";
    syncPermLabels();
    void syncSessionPolicyLive({
      alwaysApprove: false,
      plan: isPlanOn(),
    });
  };

  $("btn-send").onclick = () => {
    // 欢迎页：busy 时按 busySendMode / 无输入则 stop；否则新会话
    if (turnActive) void sendContinue();
    else void startNewChat();
  };
  $("btn-send-chat").onclick = () => {
    // busy：有草稿 → queue 或 send_now；无草稿 → stop
    // 空闲：发送
    if (turnActive) {
      void sendContinue();
      return;
    }
    void sendContinue();
  };
  $("composer-input").addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (handlePromptHistoryKey($("composer-input") as HTMLTextAreaElement, ke)) {
      return;
    }
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      if (turnActive) void sendContinue();
      else void startNewChat();
    }
  });
  $("chat-input").addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (handlePromptHistoryKey($("chat-input") as HTMLTextAreaElement, ke)) {
      return;
    }
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      void sendContinue();
    }
  });
  $("focus-input").addEventListener(
    "keydown",
    (e) => {
      const ke = e as KeyboardEvent;
      if (handlePromptHistoryKey($("focus-input") as HTMLTextAreaElement, ke)) {
        return;
      }
    },
    true,
  );

  // btw 卡片关闭
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-btw-dismiss]")) {
      e.preventDefault();
      dismissBtwCard();
      return;
    }
  });

  // 排队条：插话 / 立即发送 / 移除 / 编辑 / 上下移 / 清空 / 恢复发送
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const interjectBtn = t.closest(
      "[data-queue-interject]",
    ) as HTMLElement | null;
    if (
      interjectBtn?.dataset.queueInterject &&
      !interjectBtn.hasAttribute("disabled")
    ) {
      e.preventDefault();
      void interjectQueuedPrompt(interjectBtn.dataset.queueInterject);
      return;
    }
    const sendNowBtn = t.closest(
      "[data-queue-send-now]",
    ) as HTMLElement | null;
    if (
      sendNowBtn?.dataset.queueSendNow &&
      !sendNowBtn.hasAttribute("disabled")
    ) {
      e.preventDefault();
      void sendNowQueuedPrompt(sendNowBtn.dataset.queueSendNow);
      return;
    }
    const rm = t.closest("[data-queue-rm]") as HTMLElement | null;
    if (rm?.dataset.queueRm) {
      e.preventDefault();
      removeQueuedPrompt(rm.dataset.queueRm);
      return;
    }
    const edit = t.closest("[data-queue-edit]") as HTMLElement | null;
    if (edit?.dataset.queueEdit) {
      e.preventDefault();
      openEditQueuedPrompt(edit.dataset.queueEdit);
      return;
    }
    const up = t.closest("[data-queue-up]") as HTMLElement | null;
    if (up?.dataset.queueUp && !up.hasAttribute("disabled")) {
      e.preventDefault();
      moveQueuedPrompt(up.dataset.queueUp, -1);
      return;
    }
    const down = t.closest("[data-queue-down]") as HTMLElement | null;
    if (down?.dataset.queueDown && !down.hasAttribute("disabled")) {
      e.preventDefault();
      moveQueuedPrompt(down.dataset.queueDown, 1);
      return;
    }
    if (t.closest("[data-queue-resume]")) {
      e.preventDefault();
      resumePromptQueue();
      return;
    }
    if (t.closest("[data-queue-clear]")) {
      e.preventDefault();
      clearPromptQueue();
    }
  });

  document.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    // Esc：停止当前 turn（CLI cancelTrigger=esc）；模态打开时留给关闭逻辑
    if (
      ev.key === "Escape" &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      turnActive
    ) {
      const modal = document.getElementById("modal");
      if (modal && !modal.classList.contains("hidden")) return;
      e.preventDefault();
      void cancelTurn({ trigger: "esc" });
      return;
    }
    // Shift+Tab：循环 normal → plan → always_approve（对齐 CLI）
    // 输入框内 Tab 缩进不拦截；仅 Shift+Tab
    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === "Tab") {
      const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase();
      // 模态内让 Tab 正常工作
      if ($("modal") && !$("modal").classList.contains("hidden")) return;
      if (tag === "textarea" || tag === "input" || tag === "select") {
        // 在 composer/chat 输入框：仍响应 Shift+Tab 切模式（与 CLI 一致）
        const id = (ev.target as HTMLElement).id;
        if (
          id === "composer-input" ||
          id === "chat-input" ||
          id === "focus-input"
        ) {
          e.preventDefault();
          void cycleSessionMode();
          return;
        }
        return;
      }
      e.preventDefault();
      void cycleSessionMode();
      return;
    }
    // Ctrl+B：展开/收起左侧栏
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleLeftSidebar();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === "p") {
      e.preventDefault();
      void showFilesPanel();
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === "t") {
      e.preventDefault();
      void showBrowserPanel();
    }
    // Ctrl+\ 切换侧栏（对齐常见分屏快捷键）
    if (ev.ctrlKey && (ev.key === "\\" || ev.code === "Backslash")) {
      e.preventDefault();
      sidePane?.toggle();
    }
  });

  const cfg = await inv<{
    defaultModel?: string;
    defaultPermMode?: SettingsPermMode;
    alwaysApproveDefault?: boolean;
    defaultOpenTarget?: SettingsOpenTarget;
    locale?: LocalePreference;
    theme?: SettingsThemePreference;
    appearanceLight?: VariantAppearance;
    appearanceDark?: VariantAppearance;
    busySendMode?: "queue" | "send_now";
  }>("config.get");
  if (cfg.data) {
    const mode =
      cfg.data.defaultPermMode ??
      (cfg.data.alwaysApproveDefault ? "always_approve" : "normal");
    const pref = (cfg.data.locale ?? "system") as LocalePreference;
    const themePref = (cfg.data.theme ?? "system") as SettingsThemePreference;
    applyDesktopConfig({
      defaultPermMode: mode,
      defaultModel: (cfg.data.defaultModel ?? "").trim() || "grok",
      defaultOpenTarget: cfg.data.defaultOpenTarget ?? "explorer",
      locale: pref,
      theme: themePref,
      appearanceLight: cfg.data.appearanceLight,
      appearanceDark: cfg.data.appearanceDark,
      busySendMode:
        cfg.data.busySendMode === "send_now" ? "send_now" : "queue",
    });
  } else {
    setLocale(resolveLocale("system", navigator.language));
    applyDomI18n(document);
    applyThemePreference("system");
  }

  onLocaleChange(() => {
    applyDomI18n(document);
    document.title = tr("app.title");
    syncPermLabels();
    syncModelLabels();
    syncContextLabels();
    setComposerPlaceholders(goalComposeActive);
    updateProcessHeader();
    setComposerBusy(turnActive);
    renderGoalBanner();
    setWelcomeTitle();
    renderProjectPickerList(
      ($("project-picker-q") as HTMLInputElement | null)?.value ?? "",
    );
    void refreshProjectsAndThreads();
    slashPalette?.invalidate?.();
    // 插件页 chrome / 列表多为运行时 tr()，需显式刷新
    pluginsPage?.refreshLocale?.();
    // 设置页若打开则重绘当前分区
    void settingsPage?.refreshLocale?.();
  });

  await refreshProjectsAndThreads();
  showWelcome(true);
}

void boot();
