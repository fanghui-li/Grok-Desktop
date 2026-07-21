/**
 * Codex Desktop 对齐交互：
 * 左：新对话 / 搜索 / 插件 / 自动化 · 项目列表 · 对话列表 · 设置
 * 中：欢迎语 + 输入卡 / 对话流
 * 右：文件 · 浏览器 · 终端
 */
import type { HostIpcMethod } from "../shared/host-api.js";
import type { NormalizedEvent } from "../shared/events.js";
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
import { SidePaneController } from "./side-pane.js";
import {
  SettingsPageController,
  type SettingsOpenTarget,
  type SettingsPermMode,
  type SettingsThemePreference,
} from "./settings-page.js";
import type { ThemeVariant, VariantAppearance } from "../shared/theme/types.js";
import {
  applyChromeTheme,
  defaultAppearance,
  formatCodexThemeV1,
} from "../shared/theme/index.js";
import { PluginsPageController } from "./plugins-page.js";
import {
  agentAdvertisedCommands,
  getStaticSlashCommands,
  resolveSlashCommand,
  skillCommands,
  type SlashCommandDef,
} from "./slash-commands.js";
import { SlashPaletteController } from "./slash-palette.js";
import {
  AtFilePaletteController,
  type AtFileHit,
} from "./at-file-palette.js";
import {
  buildToolCardHtml,
  extractToolMeta,
  updateToolCardDone,
} from "./agent-blocks.js";

interface Bridge {
  invoke(method: HostIpcMethod, params?: unknown): Promise<unknown>;
  onEvent(handler: (event: unknown) => void): () => void;
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

type Project = { id: string; path: string; title: string; trust: string };
type ThreadRow = {
  id: string;
  sessionId: string;
  projectId?: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt?: string;
  archived?: boolean;
  /** 该会话使用的模型（list 自 Host / thread-meta） */
  model?: string;
  /** 该会话推理力度 */
  effort?: string;
  /** 磁盘 summary：fork 等 */
  sessionKind?: string;
  /** fork 来源会话 id */
  parentSessionId?: string;
};

/** Codex-style relative age (e.g. 1 周 / 3 天). */
function formatAge(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return tr("time.justNow");
  if (sec < 3600) return tr("time.minutes", { n: Math.floor(sec / 60) });
  if (sec < 86400) return tr("time.hours", { n: Math.floor(sec / 3600) });
  if (sec < 86400 * 7) return tr("time.days", { n: Math.floor(sec / 86400) });
  if (sec < 86400 * 30)
    return tr("time.weeks", { n: Math.floor(sec / (86400 * 7)) });
  if (sec < 86400 * 365)
    return tr("time.months", { n: Math.floor(sec / (86400 * 30)) });
  return tr("time.years", { n: Math.floor(sec / (86400 * 365)) });
}

function threadsForProject(projectId: string): ThreadRow[] {
  const proj = projects.find((p) => p.id === projectId);
  return threads
    .filter((t) => {
      if (t.projectId === projectId) return true;
      if (!proj) return false;
      const cwd = t.cwd.replace(/\\/g, "/").toLowerCase();
      const root = proj.path.replace(/\\/g, "/").toLowerCase();
      return cwd === root || cwd.startsWith(root + "/");
    })
    .sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let projects: Project[] = [];
let threads: ThreadRow[] = [];
let selectedProjectId: string | null = null;
/** 侧栏项目：已展开的文件夹 */
const expandedProjectIds = new Set<string>();
/** 侧栏项目：已点「展开更多」、显示全部会话 */
const projectShowAllThreads = new Set<string>();
/** 项目下「归档」夹是否展开 */
const expandedArchiveIds = new Set<string>();
/** 是否已做过默认展开（避免用户全部收起后刷新又被强制展开） */
let projectExpandInitialized = false;
const THREADS_PREVIEW_LIMIT = 5;
/** 用户是否手动选过项目 /「不使用项目」（避免 refresh 强制回填首项） */
let projectChoiceTouched = false;
let activeThreadId: string | null = null;
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
let planPhase: "off" | "pending" | "active" = "off";

function isPlanOn(): boolean {
  return planPhase !== "off";
}
/** 当前待审批的 exit_plan_mode 请求 */
let pendingPlanApproval: {
  requestId: string;
  sessionId: string;
  planContent: string;
} | null = null;
/**
 * turns.prompt IPC 返回与 turn.completed / 末包 message.delta 可能乱序；
 * endTurn 后短窗口内仍接受本 turn 的 assistant 流，避免「会话断了、最后一泡没了」。
 */
let lateStreamUntil = 0;
/** 本 turn 内 agent 写入的类 plan 文档路径（非 session plan.md 时兜底展示） */
let lastPlanArtifactPath: string | null = null;
/** 计划面板：磁盘已保存内容（用于脏检测） */
let planPanelSavedContent = "";
/** 计划面板显示的真源路径 */
let planPanelPath: string | null = null;
let planPanelBound = false;
let planPanelBusy = false;
/** 计划面板：源码 | Markdown 预览 */
let planPanelViewMode: "source" | "preview" = "source";
/**
 * chip 显示：当前上下文的模型/推理。
 * - 打开某会话时 = 该会话记忆
 * - 欢迎页 / 新对话 = defaultModelLabel / defaultEffortLevel
 */
let modelLabel = "grok";
/** 推理力度（对齐 CLI /effort：low|medium|high|xhigh） */
type EffortLevel = "low" | "medium" | "high" | "xhigh";
let effortLevel: EffortLevel = "high";
/** 新对话默认（设置页 / 欢迎页改 chip 时更新；不因打开旧会话而改） */
let defaultModelLabel = "grok";
let defaultEffortLevel: EffortLevel = "high";
function effortOptions(): Array<{ id: EffortLevel; label: string }> {
  return [
    { id: "low", label: tr("effort.low") },
    { id: "medium", label: tr("effort.medium") },
    { id: "high", label: tr("effort.high") },
    { id: "xhigh", label: tr("effort.xhigh") },
  ];
}
/** 顶栏「打开位置」默认目标 */
let defaultOpenTarget: SettingsOpenTarget = "explorer";
/** UI language preference from settings (`system` | zh-CN | en-US) */
let localePreference: LocalePreference = "system";
/** Appearance preference（对齐 Codex Appearance：system | light | dark） */
let themePreference: SettingsThemePreference = "system";
/** 分 variant 的 chrome + codeThemeId */
let appearanceLight: VariantAppearance = defaultAppearance("light");
let appearanceDark: VariantAppearance = defaultAppearance("dark");
let systemThemeMql: MediaQueryList | null = null;
let systemThemeListener: ((ev: MediaQueryListEvent) => void) | null = null;
/** Codex 可拖拽文件侧栏 */
let sidePane: SidePaneController | null = null;
/** Codex 式全页设置 */
let settingsPage: SettingsPageController | null = null;
/** Codex 式全页插件 / 技能 */
let pluginsPage: PluginsPageController | null = null;
/** 斜杠命令中心 */
let slashPalette: SlashPaletteController | null = null;
let atFilePalette: AtFilePaletteController | null = null;
/** 待发送附件（文件/图片/文件夹路径，注入 prompt 上下文） */
type ComposerAttachment = {
  path: string;
  name: string;
  kind: "file" | "image" | "folder";
  /** 缩略图 / 灯箱用 data URL */
  previewUrl?: string;
};
let composerAttachments: ComposerAttachment[] = [];
/** 尚无 session 时缓存的 goal 标题，建会话后写入 */
let pendingGoalTitle: string | null = null;
/** 当前展示用的目标标题（含已写入 session 的） */
let activeGoalTitle: string | null = null;
/** 下一次发送将文本设为 goal（/goal 或 +目标 后，直接在输入框写） */
let goalComposeActive = false;
/**
 * 用户是否主动开启过目标模式（/goal、+目标、磁盘已有 goal.json）。
 * agent 自发的 goal_updated / update_goal 在未 opt-in 时不得拉起目标条。
 */
let userOptedInGoal = false;
/** 目标是否暂停 */
let goalPaused = false;
/** agent 已标记完成（展示完成后收起） */
let goalCompleted = false;
/** 目标开始时间（用于「· 6s」计时） */
let goalStartedAt: number | null = null;
/** 已累计运行毫秒（暂停时冻结） */
let goalElapsedFrozenMs = 0;
let goalElapsedTimer: ReturnType<typeof setInterval> | null = null;
let goalCompleteHideTimer: ReturnType<typeof setTimeout> | null = null;
/** 进行中 goal 时轮询 agent 日志，防止 ACP 丢 complete 事件 */
let goalSyncTimer: ReturnType<typeof setInterval> | null = null;
/** 目标 token 预算（CLI `/goal … --budget N`） */
let goalTokenBudget: number | null = null;
/** 本会话 / 默认 max-turns（写入 create meta；0=不限） */
let maxTurnsLimit: number | null = null;
/** agent available_commands_update 缓存（按 session） */
let agentAvailableCommands: Array<{
  name: string;
  description?: string;
  input?: { hint?: string };
}> = [];
/** 崩溃后展示「重新附着」条 */
let agentCrashPending = false;
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

function selectedProject(): Project | undefined {
  return projects.find((p) => p.id === selectedProjectId);
}

function setWelcomeTitle(): void {
  const p = selectedProject();
  $("welcome-title").textContent = p
    ? tr("welcome.askProject", { title: p.title })
    : tr("welcome.askGeneric");
  $("project-chip-label").textContent = p?.title ?? tr("picker.usingNone");
}

function closeProjectPicker(): void {
  const picker = $("project-picker");
  const chip = $("btn-project-chip");
  picker.classList.add("hidden");
  chip.classList.remove("open");
  chip.setAttribute("aria-expanded", "false");
}

function renderProjectPickerList(filter = ""): void {
  const box = $("project-picker-list");
  box.innerHTML = "";
  const q = filter.trim().toLowerCase();
  const filtered = projects.filter(
    (p) =>
      !q ||
      p.title.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q),
  );
  if (!filtered.length) {
    box.innerHTML = `<div class="picker-empty">${projects.length ? tr("picker.noMatch") : tr("picker.noProjects")}</div>`;
    return;
  }
  for (const p of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `picker-project${p.id === selectedProjectId ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", p.id === selectedProjectId ? "true" : "false");
    const check =
      p.id === selectedProjectId
        ? `<span class="picker-check">✓</span>`
        : `<span class="picker-check" style="visibility:hidden">✓</span>`;
    row.innerHTML = `<span class="picker-folder">📁</span><span class="picker-name">${esc(p.title)}</span>${check}`;
    row.onclick = () => {
      selectedProjectId = p.id;
      projectChoiceTouched = true;
      closeProjectPicker();
      setWelcomeTitle();
      showWelcome(true);
      void refreshProjectsAndThreads();
    };
    box.appendChild(row);
  }
}

function openProjectPicker(): void {
  const picker = $("project-picker");
  const chip = $("btn-project-chip");
  const wasOpen = !picker.classList.contains("hidden");
  if (wasOpen) {
    closeProjectPicker();
    return;
  }
  // 关闭其它浮层
  $("perm-menu").classList.add("hidden");
  renderProjectPickerList("");
  const q = $("project-picker-q") as HTMLInputElement;
  q.value = "";
  picker.classList.remove("hidden");
  chip.classList.add("open");
  chip.setAttribute("aria-expanded", "true");
  // 下一帧聚焦搜索
  requestAnimationFrame(() => q.focus());
}

function showWelcome(show: boolean): void {
  $("welcome").classList.toggle("hidden", !show);
  $("chat").classList.toggle("hidden", show);
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
/** 流式滚动节流（避免每 token 强制 layout） */
let streamScrollRaf = 0;
/**
 * When true, drop live transcript events (create/openThread race:
 * invoke 返回后仍可能有滞留的 session/update，会与 history 叠出双份气泡)。
 */
let suspendLiveTranscript = false;

// ── Codex 时间线：Turn 状态机 ──────────────────────────────
let turnActive = false;
/**
 * S19 本地 follow-up 队列：当前 turn 进行中用户再发送时入队，
 * turn 正常结束后自动 dispatch。用户停止 turn 时暂停队列（对齐 Codex
 * interrupted steers），需点「继续发送」或等下一轮正常结束后恢复。
 * `/btw`（旁路）与 `/interject`（插进当前 turn）另见 threads.btw / threads.interject。
 */
type QueuedPrompt = {
  id: string;
  display: string;
  content: string;
  attachments: ComposerAttachment[];
};
const promptQueue: QueuedPrompt[] = [];
let queueDrainScheduled = false;
/** 用户 interrupt/停止后为 true，阻止自动 drain */
let queuePausedByInterrupt = false;

/**
 * S17 本会话 prompt 历史（最新在前）：
 * ↑ 空输入/光标行首召回；/history 模糊搜索插入。
 */
const PROMPT_HISTORY_MAX = 100;
let promptHistory: string[] = [];
/** -1 = 未浏览；0 = 最新一条 */
let promptHistoryIndex = -1;
/** 进入 ↑ 浏览前保存的草稿 */
let promptHistoryDraft = "";
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

/** goal 流水线 / 验证器英文过程（不当作主对话气泡） */
function looksLikeGoalProcessText(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const patterns = [
    /\bNot Refuted\b/i,
    /\bRefuted\b/i,
    /\bObjective met\b/i,
    /\bFINAL_RESPONSE\b/,
    /\bAuditing against\b/i,
    /\bAcceptance criteria\b/i,
    /\bWriting the verdict\b/i,
    /\bWriting verdict\b/i,
    /\bWriting a minimal plan\b/i,
    /\bconversational objective\b/i,
    /\badversarial verifier\b/i,
    /\bimplementer evidence\b/i,
    /\bgating check\b/i,
    /\bI'?ll verify\b/i,
    /\bChecking the plan\b/i,
    /\bGoal Plan Writer\b/i,
    /\bYou are an \*\*adversarial\b/i,
    /\bYou are the Goal\b/i,
    /\bverdict files?\b/i,
    /\bclassifier verification\b/i,
    /\bpending_depth\b/i,
    /^Done\.?\s*$/im,
  ];
  if (patterns.some((p) => p.test(t))) return true;
  // 大段英文 + 验证口吻
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const ratio = latin / Math.max(t.length, 1);
  if (
    ratio > 0.55 &&
    t.length > 80 &&
    /\b(objective|plan|evidence|verify|verifier|acceptance|refute)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

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

/** 短耗时：23s / 800ms / 1分5s */
function formatElapsedCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return tr("turn.timeMs", { n: Math.max(ms, 0) });
  const sec = Math.round(ms / 1000);
  if (sec < 60) return tr("turn.timeSec", { n: sec });
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0
    ? tr("turn.timeMinSec", { m, s })
    : tr("turn.timeMin", { m });
}

/** 兼容旧 key：已处理 → 现统一走「已完成 ·」 */
function formatTurnElapsed(ms: number): string {
  return tr("turn.workedFor", { time: formatElapsedCompact(ms) });
}

function formatTurnWorking(ms: number): string {
  return tr("turn.workingFor", { time: formatElapsedCompact(ms) });
}

function formatTurnStopped(ms: number): string {
  return tr("turn.stoppedAfter", { time: formatElapsedCompact(ms) });
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
  const tick = () => {
    if (!turnActive || !turnPhaseEl?.isConnected) return;
    const ms = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
    const lab = turnPhaseEl.querySelector(".turn-phase-label");
    const text = formatTurnWorking(ms);
    if (lab) lab.textContent = text;
    turnPhaseEl.setAttribute("aria-label", text);
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
  scrollTranscript();
}

/**
 * Codex：Worked for / You stopped after — 固定留在时间线。
 * 插在过程块后，否则 transcript 末尾。
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
  // 复用进行中的 phase 节点，改成完成态（避免两条分隔）
  if (turnPhaseEl?.isConnected) {
    turnPhaseEl.classList.remove("is-working");
    turnPhaseEl.classList.add(kind === "stopped" ? "is-stopped" : "is-done");
    turnPhaseEl.innerHTML = `<span class="turn-phase-label">${esc(label)}</span>`;
    turnPhaseEl.setAttribute("aria-label", label);
    // 挪到过程块之后（若过程块在它后面插入过）
    if (processBlockEl?.isConnected) {
      const next = processBlockEl.nextElementSibling;
      if (next !== turnPhaseEl) {
        processBlockEl.insertAdjacentElement("afterend", turnPhaseEl);
      }
    }
    scrollTranscript();
    return;
  }

  // 清掉旧 footer 类名节点（兼容）
  if (processBlockEl?.isConnected) {
    const prev = processBlockEl.nextElementSibling;
    if (prev?.classList.contains("turn-elapsed")) prev.remove();
  }

  const foot = document.createElement("div");
  foot.className = `line turn-phase ${kind === "stopped" ? "is-stopped" : "is-done"}`;
  foot.setAttribute("role", "status");
  foot.setAttribute("aria-label", label);
  foot.innerHTML = `<span class="turn-phase-label">${esc(label)}</span>`;
  if (processBlockEl?.isConnected) {
    processBlockEl.insertAdjacentElement("afterend", foot);
  } else {
    $("transcript").appendChild(foot);
  }
  turnPhaseEl = foot;
  scrollTranscript();
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
  scrollTranscript();
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
  scrollTranscript();
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
  if (streamScrollRaf) {
    cancelAnimationFrame(streamScrollRaf);
    streamScrollRaf = 0;
  }
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
}

function normalizeAssistantForDedupe(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[`*_>#\-]/g, "")
    .trim()
    .toLowerCase();
}

/** 同一 turn 内避免 agent 重复推送几乎相同的主回复 */
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
    const prevN = normalizeAssistantForDedupe(prev);
    if (!prevN) continue;
    // 相同 / 互相包含 / 高度重叠 → 复用气泡
    if (
      nextN === prevN ||
      nextN.startsWith(prevN) ||
      prevN.startsWith(nextN) ||
      (nextN.length > 40 &&
        prevN.length > 40 &&
        (nextN.includes(prevN.slice(0, 40)) || prevN.includes(nextN.slice(0, 40))))
    ) {
      return n;
    }
  }
  return null;
}

/** 流式：只追加纯文本（O(1) DOM 文本更新），不做 MD/高亮 */
function appendAssistantStream(el: HTMLElement, raw: string): void {
  paintAssistantStreaming(el, raw);
  if (streamScrollRaf) return;
  streamScrollRaf = requestAnimationFrame(() => {
    streamScrollRaf = 0;
    scrollTranscript();
  });
}

/** 定稿：完整 Markdown + 高亮 + 文件路径可点（每条消息一次） */
function flushAssistantMarkdown(el: HTMLElement | null): void {
  if (!el) return;
  if (streamScrollRaf) {
    cancelAnimationFrame(streamScrollRaf);
    streamScrollRaf = 0;
  }
  const raw = el.dataset.raw ?? "";
  if (raw) {
    paintAssistantHtml(el, raw, { highlight: true, cwd: activeCwd });
    scrollTranscript();
  }
}

function chatScroller(): HTMLElement {
  return (
    (document.getElementById("chat-scroll") as HTMLElement | null) ??
    $("transcript")
  );
}

function scrollTranscript(): void {
  const scroller = chatScroller();
  scroller.scrollTop = scroller.scrollHeight;
  updateScrollDownFab();
}

/** 底栏贴底：消息区优先让位；坞 max-height 保证完整在 chat 内，工具栏优先 */
function syncChatComposerReserve(): void {
  const chat = document.getElementById("chat");
  const dock = document.getElementById("chat-composer-dock");
  if (!chat || !dock) return;
  if (chat.classList.contains("hidden")) return;

  const chatH = chat.clientHeight || 0;
  if (chatH <= 0) return;

  // 消息区至少 40%（且 ≥72px），剩余全给底栏上限
  const minScroll = Math.max(72, Math.floor(chatH * 0.4));
  const byScroll = Math.max(96, chatH - minScroll);
  const byRatio = Math.floor(chatH * (chatH < 420 ? 0.52 : chatH < 600 ? 0.48 : 0.45));
  const maxDock = Math.min(byScroll, byRatio, 300);
  dock.style.maxHeight = `${maxDock}px`;

  const ta = document.getElementById("chat-input") as HTMLTextAreaElement | null;
  const goal = document.getElementById("goal-banner-chat");
  const perm = document.getElementById("permission-bar");
  const toolbar = dock.querySelector(".composer-toolbar") as HTMLElement | null;
  const goalH =
    goal && !goal.classList.contains("hidden") ? goal.getBoundingClientRect().height + 6 : 0;
  const permH =
    perm && !perm.classList.contains("hidden") ? perm.getBoundingClientRect().height + 8 : 0;
  const toolbarH = toolbar?.getBoundingClientRect().height ?? 36;
  const chrome = 28; // dock padding + gaps
  const maxTa = Math.max(
    22,
    Math.min(120, Math.floor(maxDock - goalH - permH - toolbarH - chrome)),
  );
  if (ta) {
    ta.style.maxHeight = `${maxTa}px`;
    fitChatInputHeight(ta, maxTa);
  }

  const h = Math.ceil(dock.getBoundingClientRect().height);
  chat.style.setProperty("--chat-composer-h", `${Math.max(h, 72)}px`);
  updateScrollDownFab();
}

/** 对话输入框随内容增高，不超过 maxPx，空内容回到默认 */
function fitChatInputHeight(ta: HTMLTextAreaElement, maxPx: number): void {
  if (!ta.value) {
    ta.style.height = "";
    return;
  }
  ta.style.height = "0px";
  const next = Math.min(Math.max(ta.scrollHeight, 28), maxPx);
  ta.style.height = `${next}px`;
}

function updateScrollDownFab(): void {
  const fab = document.getElementById("btn-scroll-down");
  const scroller = document.getElementById("chat-scroll");
  if (!fab || !scroller) return;
  const gap =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  fab.classList.toggle("hidden", gap < 80);
}

function bindChatScrollLayout(): void {
  const scroller = document.getElementById("chat-scroll");
  const dock = document.getElementById("chat-composer-dock");
  const fab = document.getElementById("btn-scroll-down");
  scroller?.addEventListener("scroll", () => updateScrollDownFab(), {
    passive: true,
  });
  fab?.addEventListener("click", () => scrollTranscript());
  const chat = document.getElementById("chat");
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement | null;
  chatInput?.addEventListener("input", () => {
    const maxRaw = chatInput.style.maxHeight;
    const maxPx = maxRaw ? parseInt(maxRaw, 10) : 120;
    fitChatInputHeight(chatInput, Number.isFinite(maxPx) ? maxPx : 120);
    syncChatComposerReserve();
  });
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => syncChatComposerReserve());
    if (dock) ro.observe(dock);
    if (chat) ro.observe(chat);
  }
  window.addEventListener("resize", () => {
    syncChatComposerReserve();
    // 窗口拉伸后 fixed 菜单坐标失效，直接关闭（权限 / 模型 / +）
    hideEphemeralMenus();
  });
  // 显示对话 / 目标条 / 权限条显隐时再量一次
  if (chat && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      if (!chat.classList.contains("hidden")) {
        requestAnimationFrame(() => syncChatComposerReserve());
      }
    }).observe(chat, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }
  requestAnimationFrame(() => syncChatComposerReserve());
}

/** 空闲 / 进行中：仅由发送钮 ↑ / ■ 表达（方案 2） */
function setComposerBusy(busy: boolean): void {
  for (const id of ["btn-send", "btn-send-chat"] as const) {
    const b = $(id);
    if (busy) {
      b.classList.add("stop");
      b.textContent = "■";
      b.title = tr("common.stop");
      b.setAttribute("aria-label", tr("common.stop"));
    } else {
      b.classList.remove("stop");
      b.textContent = "↑";
      b.title = tr("common.send");
      b.setAttribute("aria-label", tr("common.send"));
    }
  }
  syncPromptQueueBar();
}

function queueItemPreview(q: QueuedPrompt, max = 72): string {
  const t = (q.display || q.content).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function renderQueueItemRow(q: QueuedPrompt, i: number, total: number): string {
  const short = queueItemPreview(q);
  const upDis = i === 0 ? " disabled" : "";
  const downDis = i >= total - 1 ? " disabled" : "";
  return `<li class="prompt-queue-item" data-qid="${esc(q.id)}">
    <span class="prompt-queue-idx">${i + 1}</span>
    <span class="prompt-queue-text" title="${esc(q.display || q.content)}">${esc(short)}</span>
    <span class="prompt-queue-actions">
      <button type="button" class="prompt-queue-act" data-queue-up="${esc(q.id)}" title="${esc(tr("queue.moveUp"))}"${upDis}>↑</button>
      <button type="button" class="prompt-queue-act" data-queue-down="${esc(q.id)}" title="${esc(tr("queue.moveDown"))}"${downDis}>↓</button>
      <button type="button" class="prompt-queue-act" data-queue-edit="${esc(q.id)}" title="${esc(tr("queue.edit"))}">✎</button>
      <button type="button" class="prompt-queue-x" data-queue-rm="${esc(q.id)}" title="${esc(tr("queue.remove"))}">×</button>
    </span>
  </li>`;
}

/** 同步输入区上方的排队条 */
function syncPromptQueueBar(): void {
  const bars = ["prompt-queue-bar", "prompt-queue-bar-welcome"]
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el);
  for (const bar of bars) {
    if (!promptQueue.length) {
      bar.classList.add("hidden");
      bar.innerHTML = "";
      queuePausedByInterrupt = false;
      continue;
    }
    bar.classList.remove("hidden");
    const n = promptQueue.length;
    const list = promptQueue
      .map((q, i) => renderQueueItemRow(q, i, n))
      .join("");
    const pauseBanner = queuePausedByInterrupt
      ? `<div class="prompt-queue-pause">
           <span>${esc(tr("queue.pausedHint"))}</span>
           <button type="button" class="prompt-queue-resume" data-queue-resume="1">${esc(tr("queue.resume"))}</button>
         </div>`
      : "";
    bar.innerHTML = `
      <div class="prompt-queue-head">
        <span class="prompt-queue-title">${esc(tr("queue.title", { n }))}</span>
        <span class="prompt-queue-head-actions">
          ${
            queuePausedByInterrupt
              ? `<button type="button" class="prompt-queue-resume" data-queue-resume="1">${esc(tr("queue.resume"))}</button>`
              : ""
          }
          <button type="button" class="prompt-queue-clear" data-queue-clear="1">${esc(tr("queue.clear"))}</button>
        </span>
      </div>
      ${pauseBanner}
      <ul class="prompt-queue-list">${list}</ul>`;
  }
  // 高度变化时重算底栏留白
  requestAnimationFrame(() => {
    try {
      syncChatComposerReserve();
    } catch {
      /* init 前可能未定义 */
    }
  });
}

function clearPromptQueue(opts?: { silent?: boolean }): void {
  if (!promptQueue.length && !queuePausedByInterrupt) return;
  promptQueue.length = 0;
  queuePausedByInterrupt = false;
  syncPromptQueueBar();
  if (!opts?.silent) showToast(tr("queue.cleared"));
}

function refreshQueueModalIfOpen(): void {
  const modal = document.getElementById("modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (!modal.querySelector(".prompt-queue-list--modal")) return;
  showPromptQueueModal();
}

function removeQueuedPrompt(id: string): void {
  const i = promptQueue.findIndex((q) => q.id === id);
  if (i < 0) return;
  promptQueue.splice(i, 1);
  if (!promptQueue.length) queuePausedByInterrupt = false;
  syncPromptQueueBar();
  refreshQueueModalIfOpen();
}

function moveQueuedPrompt(id: string, dir: -1 | 1): void {
  const i = promptQueue.findIndex((q) => q.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= promptQueue.length) return;
  const tmp = promptQueue[i]!;
  promptQueue[i] = promptQueue[j]!;
  promptQueue[j] = tmp;
  syncPromptQueueBar();
  refreshQueueModalIfOpen();
}

function updateQueuedPrompt(
  id: string,
  patch: { display: string; content: string },
): boolean {
  const q = promptQueue.find((x) => x.id === id);
  if (!q) return false;
  const d = patch.display.trim();
  const c = patch.content.trim();
  if (!d && !c) return false;
  q.display = d || c;
  q.content = c || d;
  syncPromptQueueBar();
  refreshQueueModalIfOpen();
  return true;
}

function openEditQueuedPrompt(id: string): void {
  const q = promptQueue.find((x) => x.id === id);
  if (!q) return;
  const initial = q.content || q.display;
  openModal(
    tr("queue.editTitle"),
    `<p class="prompt-dlg-hint">${esc(tr("queue.editHint"))}</p>
     <textarea id="queue-edit-ta" class="queue-edit-ta" rows="6" spellcheck="true"></textarea>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-dark" id="queue-edit-save">${esc(tr("queue.editSave"))}</button>
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
  );
  const ta = $("queue-edit-ta") as HTMLTextAreaElement;
  ta.value = initial;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  $("queue-edit-save").onclick = () => {
    const text = ta.value.replace(/\r\n/g, "\n").trim();
    if (!text) {
      showToast(tr("queue.editEmpty"), "error");
      return;
    }
    // 编辑文本；附件块仍保留在 content 前缀时由用户自行改；简化：整体替换为新文本
    if (updateQueuedPrompt(id, { display: text, content: text })) {
      showToast(tr("queue.edited"));
      closeModal();
    }
  };
  $("prompt-dlg-cancel").onclick = () => closeModal();
}

function resumePromptQueue(): void {
  if (!promptQueue.length) {
    queuePausedByInterrupt = false;
    syncPromptQueueBar();
    return;
  }
  queuePausedByInterrupt = false;
  syncPromptQueueBar();
  showToast(tr("queue.resumed"));
  if (!turnActive) scheduleDrainPromptQueue();
}

function enqueuePrompt(item: Omit<QueuedPrompt, "id">): string {
  const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  promptQueue.push({ ...item, id });
  syncPromptQueueBar();
  const toastKey = queuePausedByInterrupt
    ? "queue.enqueuedPaused"
    : "queue.enqueued";
  showToast(tr(toastKey, { n: promptQueue.length }));
  return id;
}

/**
 * turn 结束后尝试发送队首。用 setTimeout 避免与 endTurn 重入。
 * 用户停止导致的 pause 期间不自动 drain。
 */
function scheduleDrainPromptQueue(): void {
  if (queueDrainScheduled) return;
  if (!promptQueue.length) return;
  if (queuePausedByInterrupt) return;
  queueDrainScheduled = true;
  window.setTimeout(() => {
    queueDrainScheduled = false;
    void drainPromptQueue();
  }, 80);
}

async function drainPromptQueue(): Promise<void> {
  if (turnActive) return;
  if (queuePausedByInterrupt) return;
  const next = promptQueue.shift();
  if (!next) {
    syncPromptQueueBar();
    return;
  }
  syncPromptQueueBar();
  // dispatchAgentPrompt 会 paintUserMessage(display)
  await dispatchAgentPrompt(next.content, next.display, { force: false });
}

function showPromptQueueModal(): { ok: boolean; message?: string } {
  if (!promptQueue.length) {
    openModal(
      tr("queue.modalTitle"),
      `<p class="prompt-dlg-hint">${esc(tr("queue.empty"))}</p>
       <p class="prompt-dlg-hint">${esc(tr("queue.hint"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => closeModal();
    return { ok: true, message: tr("queue.empty") };
  }
  const n = promptQueue.length;
  const list = promptQueue.map((q, i) => renderQueueItemRow(q, i, n)).join("");
  const pauseNote = queuePausedByInterrupt
    ? `<p class="prompt-dlg-hint prompt-queue-pause-note">${esc(tr("queue.pausedHint"))}</p>`
    : "";
  openModal(
    tr("queue.modalTitle"),
    `${pauseNote}
     <ul class="prompt-queue-list prompt-queue-list--modal">${list}</ul>
     <div class="prompt-dlg-actions">
       ${
         queuePausedByInterrupt
           ? `<button type="button" class="btn-dark" id="queue-modal-resume">${esc(tr("queue.resume"))}</button>`
           : ""
       }
       <button type="button" class="btn-ghost" id="queue-modal-clear">${esc(tr("queue.clear"))}</button>
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
  );
  const resumeBtn = document.getElementById("queue-modal-resume");
  if (resumeBtn) {
    resumeBtn.onclick = () => {
      resumePromptQueue();
      closeModal();
    };
  }
  $("queue-modal-clear").onclick = () => {
    clearPromptQueue();
    closeModal();
  };
  $("prompt-dlg-cancel").onclick = () => closeModal();
  return { ok: true };
}

/** S20：本会话最近后台任务快照（来自 task.updated 事件） */
type TaskSnap = {
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  exitCode?: number | null;
  updatedAt: number;
  sessionId?: string;
};
const taskSnaps = new Map<string, TaskSnap>();
const TASK_SNAP_MAX = 40;

function rememberTaskSnap(ev: {
  sessionId?: string;
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  exitCode?: number | null;
}): void {
  const id = ev.taskId || "";
  if (!id) return;
  taskSnaps.set(id, {
    taskId: id,
    phase: ev.phase,
    command: ev.command,
    description: ev.description,
    isMonitor: ev.isMonitor,
    success: ev.success,
    exitCode: ev.exitCode,
    updatedAt: Date.now(),
    sessionId: ev.sessionId,
  });
  // 裁剪最旧
  if (taskSnaps.size > TASK_SNAP_MAX) {
    const sorted = [...taskSnaps.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    for (let i = 0; i < sorted.length - TASK_SNAP_MAX; i++) {
      taskSnaps.delete(sorted[i][0]);
    }
  }
}

function isTaskRunningPhase(phase: string): boolean {
  return phase === "backgrounded" || phase === "monitor";
}

function showTasksPanel(): { ok: boolean; message?: string } {
  const rows = [...taskSnaps.values()]
    .filter((t) => !activeSessionId || !t.sessionId || t.sessionId === activeSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!rows.length) {
    openModal(
      tr("tasks.modalTitle"),
      `<p class="prompt-dlg-hint">${esc(tr("tasks.empty"))}</p>
       <p class="prompt-dlg-hint">${esc(tr("tasks.hint"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => closeModal();
    return { ok: true, message: tr("tasks.empty") };
  }
  const items = rows
    .map((t) => {
      const kind = t.isMonitor ? "monitor" : "task";
      const label =
        (t.description || t.command || "").trim() || kind;
      const short = t.taskId.slice(0, 10);
      const st =
        t.phase === "completed"
          ? t.success === false
            ? "fail"
            : "ok"
          : t.phase;
      const age = formatAge(new Date(t.updatedAt).toISOString()) || "";
      const running = isTaskRunningPhase(t.phase);
      return `<div class="task-panel-row" data-task-id="${esc(t.taskId)}">
        <div class="task-panel-main">
          <span class="task-panel-st task-st-${esc(st)}">[${esc(st)}]</span>
          <span class="task-panel-kind">${esc(kind)}</span>
          <span class="task-panel-id" title="${esc(t.taskId)}">${esc(short)}</span>
          <span class="task-panel-label" title="${esc(label)}">${esc(label.slice(0, 100))}</span>
          ${age ? `<span class="task-panel-age">${esc(age)}</span>` : ""}
        </div>
        <div class="task-panel-acts">
          <button type="button" class="btn-ghost sm" data-task-copy="${esc(t.taskId)}">${esc(tr("tasks.copyId"))}</button>
          ${
            running
              ? `<button type="button" class="btn-dark sm" data-task-kill="${esc(t.taskId)}" title="${esc(tr("tasks.killTitle"))}">${esc(tr("tasks.kill"))}</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");
  openModal(
    tr("tasks.modalTitle"),
    `<p class="prompt-dlg-hint">${esc(tr("tasks.panelHint"))}</p>
     <div class="task-panel-list">${items}</div>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
  );
  $("prompt-dlg-cancel").onclick = () => closeModal();
  for (const btn of Array.from(
    document.querySelectorAll("[data-task-copy]"),
  )) {
    (btn as HTMLElement).onclick = async () => {
      const id = (btn as HTMLElement).dataset.taskCopy ?? "";
      try {
        await navigator.clipboard.writeText(id);
        showToast(tr("common.copied"));
      } catch {
        showToast(tr("common.copyFailed"), "error");
      }
    };
  }
  for (const btn of Array.from(
    document.querySelectorAll("[data-task-kill]"),
  )) {
    (btn as HTMLElement).onclick = () => {
      const id = (btn as HTMLElement).dataset.taskKill ?? "";
      if (id) void killBackgroundTask(id);
    };
  }
  return { ok: true };
}

/** S20：杀后台任务（ACP `_x.ai/task/kill`） */
async function killBackgroundTask(taskId: string): Promise<void> {
  const id = taskId.trim();
  if (!id) return;
  const snap = taskSnaps.get(id);
  if (snap && !isTaskRunningPhase(snap.phase)) {
    showToast(tr("tasks.notRunning"), "error");
    return;
  }
  const threadId = await ensureLiveThread();
  if (!threadId) {
    showToast(tr("tasks.killNeedAttach"), "error");
    return;
  }
  const btn = Array.from(
    document.querySelectorAll("[data-task-kill]"),
  ).find(
    (el) => (el as HTMLElement).dataset.taskKill === id,
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = tr("tasks.killing");
  }
  const res = await inv<{
    taskId: string;
    outcome: string;
    sessionId: string;
  }>("threads.killTask", { threadId, taskId: id });
  if (!res.ok) {
    showToast(res.error?.message ?? tr("tasks.killFail"), "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = tr("tasks.kill");
    }
    return;
  }
  // 乐观：标记本地快照为已结束（真实终态仍等 task.updated）
  const prev = taskSnaps.get(id);
  if (prev) {
    taskSnaps.set(id, {
      ...prev,
      phase: "completed",
      success: false,
      updatedAt: Date.now(),
    });
  }
  const outcome = res.data?.outcome ?? "killed";
  showToast(tr("tasks.killOk", { id: id.slice(0, 8), outcome }));
  appendProcessText(
    tr("tasks.killProcess", { id: id.slice(0, 8), outcome }),
  );
  // 刷新面板
  showTasksPanel();
}

/** 拉取 / 缓存 agent available_commands */
async function refreshAgentAvailableCommands(): Promise<void> {
  if (!activeThreadId || activeThreadId.startsWith("disk_")) return;
  const res = await inv<{
    commands: Array<{
      name: string;
      description?: string;
      input?: { hint?: string };
    }>;
    tools?: string[];
  }>("threads.availableCommands", { threadId: activeThreadId });
  if (res.ok && res.data?.commands) {
    agentAvailableCommands = res.data.commands;
  }
}

function applyAvailableCommandsEvent(ev: {
  sessionId?: string;
  threadId?: string;
  commands: Array<{
    name: string;
    description?: string;
    input?: { hint?: string };
  }>;
}): void {
  if (
    activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== activeSessionId
  ) {
    return;
  }
  if (
    activeThreadId &&
    ev.threadId &&
    ev.threadId !== activeThreadId &&
    !activeThreadId.startsWith("disk_")
  ) {
    return;
  }
  agentAvailableCommands = ev.commands ?? [];
  slashPalette?.invalidate();
}

/** R4：agent 崩溃条 — 提示重新附着 */
function showAgentCrashBanner(message?: string): void {
  agentCrashPending = true;
  let bar = document.getElementById("agent-crash-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "agent-crash-bar";
    bar.className = "agent-crash-bar";
    const host =
      document.querySelector(".chat-composer-wrap") ||
      document.getElementById("chat-view") ||
      document.body;
    host.insertBefore(bar, host.firstChild);
  }
  bar.innerHTML = `<span class="agent-crash-msg">${esc(
    message?.trim() || tr("crash.default"),
  )}</span>
    <button type="button" class="btn-dark sm" id="btn-agent-reattach">${esc(
      tr("crash.reattach"),
    )}</button>
    <button type="button" class="btn-ghost sm" id="btn-agent-crash-dismiss">${esc(
      tr("common.close"),
    )}</button>`;
  bar.classList.remove("hidden");
  const re = document.getElementById("btn-agent-reattach");
  if (re) {
    re.onclick = () => void reattachAfterCrash();
  }
  const dis = document.getElementById("btn-agent-crash-dismiss");
  if (dis) {
    dis.onclick = () => hideAgentCrashBanner();
  }
}

function hideAgentCrashBanner(): void {
  agentCrashPending = false;
  const bar = document.getElementById("agent-crash-bar");
  if (bar) bar.classList.add("hidden");
}

async function reattachAfterCrash(): Promise<void> {
  if (!activeSessionId || !activeCwd) {
    showToast(tr("crash.needSession"), "error");
    return;
  }
  // 强制视为 disk 会话，触发新 attach
  if (activeThreadId && !activeThreadId.startsWith("disk_")) {
    activeThreadId = `disk_${activeSessionId}`;
  }
  appendLine(tr("crash.reattaching"), "system");
  const tid = await ensureLiveThread();
  if (tid) {
    hideAgentCrashBanner();
    showToast(tr("crash.reattachOk"));
    void refreshAgentAvailableCommands();
  } else {
    showToast(tr("crash.reattachFail"), "error");
  }
}

// ── S17 prompt history ─────────────────────────────────────

function resetPromptHistoryBrowse(): void {
  promptHistoryIndex = -1;
  promptHistoryDraft = "";
}

function clearPromptHistoryStore(): void {
  promptHistory = [];
  resetPromptHistoryBrowse();
}

/** 记录一条用户发送文案（最新在前；连续重复去重） */
function recordPromptHistory(text: string): void {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t || t.length < 1) return;
  // 跳过纯 slash 命令
  if (/^\/\S*$/.test(t)) return;
  if (promptHistory[0] === t) {
    resetPromptHistoryBrowse();
    return;
  }
  // 若历史中已有相同项，提到最前
  const prev = promptHistory.indexOf(t);
  if (prev >= 0) promptHistory.splice(prev, 1);
  promptHistory.unshift(t);
  if (promptHistory.length > PROMPT_HISTORY_MAX) {
    promptHistory.length = PROMPT_HISTORY_MAX;
  }
  resetPromptHistoryBrowse();
}

/** 从磁盘 user 消息填充（打开会话时，最新在前） */
function seedPromptHistoryFromUserTexts(texts: string[]): void {
  const seen = new Set<string>();
  const out: string[] = [];
  // texts 通常时间正序；倒序取最新
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = (texts[i] ?? "").replace(/\r\n/g, "\n").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= PROMPT_HISTORY_MAX) break;
  }
  promptHistory = out;
  resetPromptHistoryBrowse();
}

function applyPromptToComposer(text: string, ta?: HTMLTextAreaElement | null): void {
  const input = ta ?? activeComposerInput();
  input.value = text;
  const pos = text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * ↑/↓ 浏览 prompt 历史。
 * 仅在：slash/@ 未打开、光标在开头（或已在浏览中）时拦截。
 */
function handlePromptHistoryKey(
  ta: HTMLTextAreaElement,
  e: KeyboardEvent,
): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  if (slashPalette?.isOpen()) return false;
  // @ 浮层：有则跳过
  const atEl = document.getElementById("at-file-palette");
  if (atEl && !atEl.classList.contains("hidden")) return false;

  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const browsing = promptHistoryIndex >= 0;

  if (e.key === "ArrowUp") {
    // 多行：不在首行则交给浏览器
    if (!browsing) {
      const before = ta.value.slice(0, start);
      if (before.includes("\n")) return false;
      if (start !== end) return false;
      // 非空且光标不在开头：不抢
      if (ta.value.length > 0 && start > 0) return false;
    }
    if (!promptHistory.length) return false;
    e.preventDefault();
    if (!browsing) {
      promptHistoryDraft = ta.value;
      promptHistoryIndex = 0;
    } else if (promptHistoryIndex < promptHistory.length - 1) {
      promptHistoryIndex += 1;
    }
    applyPromptToComposer(promptHistory[promptHistoryIndex] ?? "", ta);
    return true;
  }

  // ArrowDown
  if (!browsing) return false;
  e.preventDefault();
  if (promptHistoryIndex <= 0) {
    applyPromptToComposer(promptHistoryDraft, ta);
    resetPromptHistoryBrowse();
  } else {
    promptHistoryIndex -= 1;
    applyPromptToComposer(promptHistory[promptHistoryIndex] ?? "", ta);
  }
  return true;
}

function filterPromptHistory(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...promptHistory];
  const tokens = q.split(/\s+/).filter(Boolean);
  return promptHistory.filter((line) => {
    const hay = line.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

function showPromptHistorySearch(): { ok: boolean; message?: string } {
  openModal(
    tr("history.modalTitle"),
    `<div class="session-search-wrap">
      <input id="prompt-hist-q" class="prompt-dlg-input" type="search"
        placeholder="${esc(tr("history.searchPh"))}" autocomplete="off" />
      <div id="prompt-hist-hits" class="session-search-list prompt-hist-list"></div>
      <p class="prompt-dlg-hint" id="prompt-hist-hint">${esc(tr("history.hint"))}</p>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
      </div>
    </div>`,
  );
  const qEl = $("prompt-hist-q") as HTMLInputElement;
  const hitsEl = $("prompt-hist-hits");
  let active = 0;
  let filtered: string[] = [];

  const render = () => {
    filtered = filterPromptHistory(qEl.value);
    active = Math.min(active, Math.max(0, filtered.length - 1));
    if (!filtered.length) {
      hitsEl.innerHTML = `<div class="session-search-empty">${esc(
        promptHistory.length ? tr("history.noMatch") : tr("history.empty"),
      )}</div>`;
      return;
    }
    hitsEl.innerHTML = filtered
      .slice(0, 40)
      .map((line, i) => {
        const short =
          line.length > 160
            ? line.slice(0, 160).replace(/\s+/g, " ") + "…"
            : line.replace(/\s+/g, " ");
        return `<button type="button" class="session-search-item prompt-hist-item${i === active ? " is-active" : ""}" data-hist-i="${i}" role="option">
          <span class="session-search-title">${esc(short)}</span>
        </button>`;
      })
      .join("");
    hitsEl.querySelectorAll<HTMLElement>("[data-hist-i]").forEach((btn) => {
      btn.onclick = () => {
        const i = Number(btn.dataset.histI);
        pick(i);
      };
    });
    // 滚到选中项
    hitsEl
      .querySelector(".prompt-hist-item.is-active")
      ?.scrollIntoView({ block: "nearest" });
  };

  const pick = (i: number) => {
    const text = filtered[i];
    if (text == null) return;
    closeModal();
    resetPromptHistoryBrowse();
    applyPromptToComposer(text);
    showToast(tr("history.inserted"));
  };

  qEl.oninput = () => {
    active = 0;
    render();
  };
  qEl.onkeydown = (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (filtered.length) {
        active = Math.min(filtered.length - 1, active + 1);
        render();
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (filtered.length) {
        active = Math.max(0, active - 1);
        render();
      }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      pick(active);
    } else if (ev.key === "Escape") {
      closeModal();
    }
  };
  $("prompt-dlg-cancel").onclick = () => closeModal();
  render();
  window.setTimeout(() => qEl.focus(), 0);
  return { ok: true };
}

function markSessionWorking(sessionId: string | null, working: boolean): void {
  if (!sessionId) return;
  if (working) workingSessions.add(sessionId);
  else workingSessions.delete(sessionId);
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
  scrollTranscript();
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
  scrollTranscript();
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
  // 新回合开始：上一轮 phase 留在时间线，本轮新建
  turnPhaseEl = null;
  turnActive = true;
  lateStreamUntil = 0;
  turnStartedAt = Date.now();
  currentTurnId += 1;
  streamTurnId = currentTurnId;
  assistantStartedThisTurn = false;
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
}

function endTurn(opts?: {
  keepThought?: boolean;
  skipQueueDrain?: boolean;
  /** 对齐 Codex：正常完成 Worked for / 用户停止 You stopped after */
  outcome?: "worked" | "stopped";
}): void {
  // 无活跃回合时只做清理，不画「已完成 · 0ms」（openThread/rewind 会误触）
  const hadTurn = turnActive || turnStartedAt > 0;
  // 先放行迟到流，再关 busy；不立刻丢弃末包
  if (hadTurn) lateStreamUntil = Date.now() + 4000;
  const elapsed = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
  const outcome = opts?.outcome ?? "worked";
  turnActive = false;
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
    // 状态条：先显示完成态再淡出（不立刻消失）
    promoteTurnStatusToDone(
      outcome === "stopped"
        ? formatTurnStopped(elapsed)
        : formatTurnElapsed(elapsed),
      outcome === "stopped" ? "stopped" : "done",
    );
  } else {
    removeTurnStatus();
  }

  turnStartedAt = 0;
  // 未完成的 tool 行标为结束
  Array.from(
    $("transcript").querySelectorAll(".line.tool.running"),
  ).forEach((row) => {
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
  if (activeSessionId) markSessionWorking(activeSessionId, false);
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

async function cancelTurn(opts?: { clearQueue?: boolean }): Promise<void> {
  if (!turnActive) return;
  const tid =
    activeThreadId && !activeThreadId.startsWith("disk_")
      ? activeThreadId
      : null;
  const shouldPauseGoal = Boolean(currentGoalTitle() && !goalPaused && !goalCompleted);
  // 用户点停止：默认保留队列并暂停自动 drain（对齐 Codex interrupt）；显式 clearQueue 时清空
  if (opts?.clearQueue) {
    clearPromptQueue({ silent: true });
  } else if (promptQueue.length) {
    queuePausedByInterrupt = true;
    syncPromptQueueBar();
  }
  if (tid) {
    const res = await inv("turns.cancel", { threadId: tid });
    if (!res.ok) {
      endTurn({ outcome: "stopped" });
      appendLine(res.error?.message ?? tr("turn.stopFailed"), "error");
      return;
    }
  }
  // endTurn → scheduleDrain；queuePausedByInterrupt 时 schedule 为空操作
  endTurn({ outcome: "stopped" });
  // 停止后再同源暂停 goal（避免与 cancel 抢 prompt）
  if (shouldPauseGoal) {
    await pauseGoal({ fromStop: true });
  }
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
    // 活跃 turn，或 endTurn 后 grace 内的本 turn 迟到末包
    const inLateGrace =
      !turnActive &&
      Date.now() <= lateStreamUntil &&
      streamTurnId === currentTurnId &&
      currentTurnId > 0;
    if (
      (!turnActive && !inLateGrace) ||
      !streamTurnId ||
      streamTurnId !== currentTurnId
    ) {
      return;
    }
    // 首段助手输出：移除 Thinking 占位
    if (!assistantStartedThisTurn) {
      assistantStartedThisTurn = true;
      removeTurnStatus();
    }

    // 累积 raw
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
      } else {
        nextRaw = streamAssistantRaw + text;
      }
    } else {
      nextRaw = text;
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
      scrollTranscript();
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
      scrollTranscript();
      return;
    }
    // 仅合并「紧邻上一条」完全相同的助手气泡（流式定稿重复推送），
    // 禁止跨轮/全文扫描去重：两次相同回复（如两个「好的」）必须各占一泡。
    const last = el.lastElementChild as HTMLElement | null;
    if (
      last?.classList.contains("assistant") &&
      (last.dataset.raw ?? last.textContent ?? "").trim() === trimmed
    ) {
      return;
    }
    resetStreamState(true);
    const div = document.createElement("div");
    div.className = "line assistant prose";
    div.dataset.messageAuthorRole = "assistant";
    paintAssistantHtml(div, text, { highlight: true, cwd: activeCwd });
    el.appendChild(div);
    scrollTranscript();
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
  scrollTranscript();
}

function endStreamBubble(): void {
  resetStreamState(true);
}

/** 从 history 正文中拆出附件块（与 buildPromptWithAttachments 对称） */
function parseUserHistoryPayload(raw: string): {
  text: string;
  attachments: ComposerAttachment[];
} {
  const markers = [
    "[Attachments — include these paths in context; for folders, consider the directory tree]",
    "[Attachments — include these paths in context]",
  ];
  let idx = -1;
  let marker = "";
  for (const m of markers) {
    const i = raw.indexOf(m);
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      marker = m;
    }
  }
  if (idx < 0) {
    return { text: raw.trim(), attachments: [] };
  }
  const text = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + marker.length);
  const attachments: ComposerAttachment[] = [];
  for (const line of rest.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*(file|image|folder)\s*:\s*(.+)\s*$/i);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as ComposerAttachment["kind"];
    const pathStr = m[2]!.trim();
    if (!pathStr) continue;
    const base = pathStr.split(/[/\\]/).pop() || pathStr;
    attachments.push({
      path: pathStr,
      name: kind === "folder" ? `${base.replace(/\/$/, "")}/` : base,
      kind,
    });
  }
  return { text, attachments };
}

/** 会话图片：独立媒体区，不放进用户气泡 */
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
      void inv<{ dataUrl: string }>("files.readDataUrl", { path: a.path }).then(
        (res) => {
          if (!res.ok || !res.data?.dataUrl) return;
          a.previewUrl = res.data.dataUrl;
          const img = document.createElement("img");
          img.className = "msg-attach-thumb-img";
          img.src = res.data.dataUrl;
          img.alt = a.name;
          img.draggable = false;
          ph.replaceWith(img);
        },
      );
    }
    thumb.onclick = (e) => {
      e.stopPropagation();
      openComposerImagePreview(a);
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
      void inv("system.openPath", { path: a.path });
    };
    chips.appendChild(chip);
  }
  host.appendChild(chips);
}

/** 用户气泡下时间：6月21日 18:49 */
function formatUserMsgTime(d: Date): string {
  const now = new Date();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) {
    return `${mo}月${day}日 ${hh}:${mm}`;
  }
  return `${d.getFullYear()}年${mo}月${day}日 ${hh}:${mm}`;
}

/**
 * 用户气泡：正文 + 附件；气泡下时间 / 复制 / 回撤（完整 rewind）。
 * at：消息时间。省略=现在；null=不显示时间（历史无戳时）。
 * promptIndex：显式索引；省略则用 nextUserPromptIndex++。
 */
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

/**
 * 回退到指定 user prompt 之前（完整：对话+文件）。
 * agent 语义：force=false 仅为预览（success 恒 false）；确认后必须 force=true 才真正执行。
 */
async function rewindToUserPrompt(
  promptIndex: number,
  previewText: string,
): Promise<void> {
  if (turnActive) {
    showToast(tr("chat.rewindWait"), "error");
    return;
  }
  if (!activeSessionId) {
    showToast(tr("chat.rewindNeedSession"), "error");
    return;
  }

  const threadId = await ensureLiveThread();
  if (!threadId) {
    showToast(tr("chat.rewindAttachFail2"), "error");
    return;
  }

  // 预览：force=false 返回 conflicts / clean_files，不改状态
  const previewRes = await inv<{
    success: boolean;
    targetPromptIndex: number;
    revertedFiles: string[];
    conflicts: Array<{ path?: string; conflictType?: string }>;
    cleanFiles?: string[];
    error?: string;
  }>("threads.rewindPreview", {
    threadId,
    targetPromptIndex: promptIndex,
  });

  const conflicts = previewRes.data?.conflicts ?? [];
  const conflictN = conflicts.length;
  const cleanN =
    (previewRes.data as { cleanFiles?: string[] } | undefined)?.cleanFiles
      ?.length ?? 0;
  const preview =
    previewText.length > 80 ? `${previewText.slice(0, 80)}…` : previewText;

  let conflictNote = "";
  if (conflictN > 0) {
    const sample = conflicts
      .slice(0, 5)
      .map((c) => c.path || "?")
      .join("\n");
    conflictNote =
      `\n\n⚠ 检测到 ${conflictN} 个文件可能被外部修改，确认后将强制覆盖：\n${sample}` +
      (conflictN > 5 ? "\n…" : "");
  } else if (cleanN > 0) {
    conflictNote = `\n\n将还原约 ${cleanN} 个文件快照。`;
  }

  // 预览阶段 agent 失败（如 index 非法）
  if (!previewRes.ok && !previewRes.data) {
    showToast(previewRes.error?.message ?? tr("chat.rewindPreviewFail"), "error");
    return;
  }
  const previewErr = previewRes.data?.error || previewRes.error?.message;
  if (
    previewErr &&
    /Cannot rewind|current prompt index|Valid targets/i.test(previewErr)
  ) {
    showToast(previewErr, "error");
    return;
  }

  const ok = await confirmText({
    title: tr("chat.rewindConfirmTitle"),
    message:
      `将恢复到该用户消息执行前的状态（对齐 CLI /rewind · 完整回退）：\n\n` +
      `· 删除此消息及之后的全部对话\n` +
      `· 将相关文件恢复为当时快照（未进 git 的改动可能丢失）\n\n` +
      `目标消息：${preview || tr("chat.rewindConfirmBodyEmpty")}` +
      conflictNote,
    okLabel: tr("chat.rewindOk"),
    cancelLabel: tr("common.cancel"),
  });
  if (!ok) return;

  showToast(tr("chat.rewinding"));
  // 真正执行：必须 force=true（agent 在 force=false 时只做 dry-run）
  const res = await inv<{
    success: boolean;
    targetPromptIndex: number;
    revertedFiles: string[];
    promptText?: string;
  }>("threads.rewind", {
    threadId,
    targetPromptIndex: promptIndex,
    force: true,
  });

  if (!res.ok || res.data?.success === false) {
    // 确保发送钮不卡在「停止」态
    endTurn();
    showToast(res.error?.message ?? tr("chat.rewindFailed"), "error");
    return;
  }

  // 回退会截断对话/打断 agent 状态：必须清 turn UI（否则发送钮停在 ■）
  endTurn();
  truncateTranscriptFromPrompt(promptIndex);
  if (res.data?.promptText) {
    const ta = (
      $("chat").classList.contains("hidden")
        ? $("composer-input")
        : $("chat-input")
    ) as HTMLTextAreaElement;
    ta.value = res.data.promptText;
    ta.focus();
  }
  const n = res.data?.revertedFiles?.length ?? 0;
  appendLine(
    n > 0
      ? `已回退到消息 #${promptIndex} 之前（对话+文件，还原 ${n} 个文件）`
      : `已回退到消息 #${promptIndex} 之前（对话+文件）`,
    "system",
  );
  showToast(n > 0 ? tr("chat.rewoundFiles", { n }) : tr("chat.rewound"));
  // 双保险：截断后强制发送钮恢复 ↑
  setComposerBusy(false);
  if (activeSessionId) markSessionWorking(activeSessionId, false);
  void refreshContextUsage();
  void refreshProjectsAndThreads();
}

function permLabel(): string {
  // 权限 chip 只体现访问策略；plan 用独立 chip（对齐 Build）
  if (accessMode === "always_approve") return tr("composer.permFull");
  return tr("composer.permDefault");
}

function syncPermLabels(): void {
  $("perm-label").textContent = permLabel();
  $("perm-label-2").textContent = permLabel();
  syncSessionModeChips();
}

function effortLabel(level: EffortLevel = effortLevel): string {
  return effortOptions().find((e) => e.id === level)?.label ?? level;
}

/**
 * CLI 对齐：展示名 = catalog name（config `name` ?? `model` ?? id）。
 * 内部切换仍用 modelLabel（id）。
 */
function modelDisplayName(modelId: string = modelLabel): string {
  const id = (modelId || "grok").trim();
  const hit = modelsCache?.find((m) => m.id === id);
  const n = hit?.name?.trim();
  if (n) return n;
  return id;
}

/** chip 短标：展示名 + 推理档（对齐 CLI display name） */
function modelChipText(): string {
  const id = (modelLabel || "grok").trim();
  let short = modelDisplayName(id);
  // 仅当仍显示 id 且为 grok-* slug 时剥前缀做短标
  if (short === id && /^grok-/i.test(short)) {
    short = short.replace(/^grok-/i, "");
  }
  if (short.length > 18) short = short.slice(0, 16) + "…";
  return `${short} ${effortLabel()}`;
}

function syncModelLabels(): void {
  const v = modelChipText();
  for (const id of ["model-label", "model-label-2"] as const) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }
  const display = modelDisplayName();
  const modelForTitle =
    display !== (modelLabel || "").trim()
      ? `${display} (${modelLabel})`
      : display;
  for (const id of ["btn-model", "btn-model-2"] as const) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.title = tr("chat.modelTitle", {
        model: modelForTitle,
        effort: effortLabel(),
        level: effortLevel,
      });
    }
  }
}

type ContextUsageRow = {
  sessionId: string;
  used: number;
  total: number;
  percent: number;
  available: boolean;
  source: string;
  path?: string;
};

let lastContextUsage: ContextUsageRow | null = null;
let contextPollTimer: ReturnType<typeof setInterval> | null = null;

/** 273k / 500k 风格 */
function formatTokenK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    if (k >= 100) return `${Math.round(k)}k`;
    return `${k.toFixed(k % 1 === 0 ? 0 : 1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

function formatContextChipText(u: ContextUsageRow | null): string {
  if (!u || !u.available || u.total <= 0) return "—";
  const pct = u.percent.toFixed(2);
  return `${formatTokenK(u.used)} / ${formatTokenK(u.total)} (${pct}%)`;
}

function syncContextLabels(): void {
  const text = formatContextChipText(lastContextUsage);
  const pct = lastContextUsage?.percent ?? 0;
  const el = document.getElementById("context-label");
  if (el) el.textContent = text;
  const btn = document.getElementById("btn-context");
  if (!btn) return;
  btn.classList.toggle("is-warn", pct >= 70 && pct < 90);
  btn.classList.toggle("is-high", pct >= 90);
  btn.title = lastContextUsage?.available
    ? tr("chat.contextChip", { text })
    : tr("context.needSession");
}

async function refreshContextUsage(): Promise<ContextUsageRow | null> {
  if (!activeSessionId) {
    lastContextUsage = null;
    syncContextLabels();
    return null;
  }
  const res = await inv<ContextUsageRow>("session.context", {
    sessionId: activeSessionId,
  });
  if (!res.ok || !res.data) {
    lastContextUsage = null;
    syncContextLabels();
    return null;
  }
  lastContextUsage = res.data;
  syncContextLabels();
  return lastContextUsage;
}

/** auto-compact 事件里的 tokens 往往比 signals.json 写回更早，先乐观刷新 chip */
function applyOptimisticContextFromCompact(ev: {
  tokensBefore?: number;
  tokensAfter?: number;
}): void {
  if (ev.tokensAfter == null || !Number.isFinite(ev.tokensAfter)) return;
  const after = Math.max(0, ev.tokensAfter);
  const prev = lastContextUsage;
  const total =
    prev?.total && prev.total > 0
      ? prev.total
      : ev.tokensBefore != null && ev.tokensBefore > after
        ? Math.max(ev.tokensBefore, after)
        : after > 0
          ? Math.round(after / 0.15)
          : 0;
  lastContextUsage = {
    sessionId: activeSessionId ?? prev?.sessionId ?? "",
    used: after,
    total,
    percent: total > 0 ? Math.min(100, (after / total) * 100) : 0,
    available: total > 0 || after > 0,
    source: prev?.source === "signals" ? "signals" : "signals",
    path: prev?.path,
  };
  syncContextLabels();
}

/** compact 完成后：乐观 chip + 多次回读 signals（写盘有延迟） */
function refreshContextAfterCompact(ev: {
  tokensBefore?: number;
  tokensAfter?: number;
}): void {
  applyOptimisticContextFromCompact(ev);
  void refreshContextUsage();
  window.setTimeout(() => void refreshContextUsage(), 600);
  window.setTimeout(() => void refreshContextUsage(), 2000);
  window.setTimeout(() => void refreshContextUsage(), 5000);
}

function startContextPolling(): void {
  stopContextPolling();
  void refreshContextUsage();
  contextPollTimer = setInterval(() => {
    if (activeSessionId) void refreshContextUsage();
  }, 4000);
}

function stopContextPolling(): void {
  if (contextPollTimer) {
    clearInterval(contextPollTimer);
    contextPollTimer = null;
  }
}

async function showContextDetails(): Promise<{ ok: boolean; message?: string }> {
  if (!activeSessionId) {
    openModal(
      tr("context.title"),
      `<p class="prompt-dlg-hint">${esc(tr("context.needOpen"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => closeModal();
    return { ok: true };
  }

  // 优先 session/info 完整 ContextInfo；失败则回退 signals.json
  const info = await fetchSessionInfoForActive();
  if (info) {
    const c = info.context;
    if (c.total > 0 || c.used > 0) {
      lastContextUsage = {
        sessionId: info.sessionId,
        used: c.used,
        total: c.total,
        percent:
          c.usagePct ||
          (c.total > 0 ? Math.min(100, (c.used / c.total) * 100) : 0),
        available: true,
        source: "signals",
      };
      syncContextLabels();
    }
    const bodyLines = [
      tr("status.contextUsed", {
        used: c.used.toLocaleString(),
        total: c.total.toLocaleString(),
        pct:
          c.usagePct ||
          (c.total > 0 ? Math.round((c.used / c.total) * 100) : 0),
      }),
      tr("status.contextFree", { free: c.freeTokens.toLocaleString() }),
      tr("status.contextSystem", {
        tokens: c.systemPromptTokens.toLocaleString(),
      }),
      tr("status.contextTools", {
        count: c.toolDefinitionsCount,
        tokens: c.toolDefinitionsTokens.toLocaleString(),
      }),
      tr("status.contextMessages", {
        count: c.messageCount,
        tokens: c.messageTokens.toLocaleString(),
      }),
      tr("status.contextTurnsTools", {
        turns: c.turnCount,
        tools: c.toolCallCount,
        compact: c.compactionCount,
      }),
      tr("status.autoCompactAt", {
        pct: c.autoCompactThresholdPercent || 85,
      }),
    ];
    if (c.usageCategories?.length) {
      bodyLines.push("", tr("status.categoriesHeader"));
      for (const cat of c.usageCategories) {
        const detail = cat.detail ? ` (${cat.detail})` : "";
        bodyLines.push(
          `  ${cat.label}${detail}: ${cat.tokens.toLocaleString()}`,
        );
      }
    }
    bodyLines.push("", tr("context.tipCompact"));
    openModal(
      tr("context.title"),
      `<pre class="slash-status-pre">${esc(bodyLines.join("\n"))}</pre>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => closeModal();
    return { ok: true };
  }

  await refreshContextUsage();
  const u = lastContextUsage;
  if (!u || !u.available) {
    openModal(
      tr("context.title"),
      `<p class="prompt-dlg-hint">${esc(tr("context.noData"))}</p>
       <pre class="slash-status-pre">${esc(tr("context.sessionLine", { id: activeSessionId }))}</pre>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => closeModal();
    return { ok: true };
  }
  const pathLine = u.path ? tr("chat.contextPathLine", { path: u.path }) : "";
  const body = tr("chat.contextDetail", {
    usedK: formatTokenK(u.used),
    used: u.used.toLocaleString(),
    totalK: formatTokenK(u.total),
    total: u.total.toLocaleString(),
    percent: u.percent.toFixed(2),
    source: u.source,
    pathLine,
  });
  openModal(
    tr("context.title"),
    `<pre class="slash-status-pre">${esc(body)}</pre>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
  );
  $("prompt-dlg-cancel").onclick = () => closeModal();
  return { ok: true };
}

function setEffortLevel(level: EffortLevel): void {
  effortLevel = level;
  syncModelLabels();
}

function setModelId(id: string): void {
  modelLabel = id.trim() || modelLabel;
  syncModelLabels();
}

function parseEffort(v?: string | null): EffortLevel | null {
  const e = (v ?? "").trim().toLowerCase();
  if (e === "low" || e === "medium" || e === "high" || e === "xhigh") return e;
  return null;
}

/** 欢迎页 / 新对话：chip 回到默认模型 */
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

/** agent 因 harness 不兼容拒绝热切换（对齐 CLI：需新会话） */
function isModelSwitchNeedsNewSession(err?: {
  message?: string;
  details?: unknown;
}): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  if (/MODEL_SWITCH_INCOMPATIBLE_AGENT/i.test(msg)) return true;
  if (/start a new session/i.test(msg) && /model/i.test(msg)) return true;
  if (/requires agent/i.test(msg) && /active agent/i.test(msg)) return true;
  if (/Cannot switch to model/i.test(msg)) return true;

  const walk = (v: unknown, depth = 0): boolean => {
    if (!v || depth > 4) return false;
    if (typeof v === "string") {
      return (
        v === "MODEL_SWITCH_INCOMPATIBLE_AGENT" ||
        v === "start_new_session" ||
        /MODEL_SWITCH_INCOMPATIBLE/i.test(v)
      );
    }
    if (typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    if (
      o.code === "MODEL_SWITCH_INCOMPATIBLE_AGENT" ||
      o.suggestion === "start_new_session"
    ) {
      return true;
    }
    if (o.data != null && walk(o.data, depth + 1)) return true;
    if (o.details != null && walk(o.details, depth + 1)) return true;
    return false;
  };
  return walk(err.details);
}

/**
 * 对齐 CLI「Start a new session with &lt;model&gt;」：
 * 结束当前会话 UI，用目标模型新建空会话（不自动发消息）。
 */
async function startFreshSessionWithModel(
  modelId: string,
  effort: EffortLevel,
): Promise<{ ok: boolean; message?: string }> {
  const p = selectedProject();
  const cwd = activeCwd || p?.path;
  if (!cwd) {
    return { ok: false, message: tr("model.needProject") };
  }
  if (turnActive) void cancelTurn();
  clearPromptQueue({ silent: true });
  clearPromptHistoryStore();

  setModelId(modelId);
  setEffortLevel(effort);

  // 离开当前会话（不删除磁盘历史）
  closePlanPanelOnSessionChange();
  activeThreadId = null;
  activeSessionId = null;
  endTurn({ skipQueueDrain: true });
  clearTranscript();
  showWelcome(false);
  setWelcomeTitle();

  const res = await inv<{
    threadId: string;
    sessionId: string;
    cwd: string;
  }>("threads.create", {
    cwd,
    projectId: p?.id,
    title: `新会话 · ${shortModelName(modelId)}`.slice(0, 48),
    model: modelId,
    effort,
    maxTurns: maxTurnsLimit ?? undefined,
    alwaysApprove: accessMode === "always_approve",
    plan: isPlanOn(),
    // 兼容字段：展示用派生 mode
    mode: isPlanOn()
      ? "plan"
      : accessMode === "always_approve"
        ? "always_approve"
        : "normal",
  });

  if (!res.ok) {
    showWelcome(true);
    return {
      ok: false,
      message: res.error?.message ?? tr("model.createFailed"),
    };
  }

  activeThreadId = res.data!.threadId;
  activeSessionId = res.data!.sessionId;
  setActiveCwd(res.data!.cwd);
  sidePane?.onSessionChanged();
  if (p?.id) selectedProjectId = p.id;
  suspendLiveTranscript = false;
  clearTranscript();
  showWelcome(false);
  startContextPolling();
  await refreshProjectsAndThreads();
  ($("chat-input") as HTMLTextAreaElement | null)?.focus();
  return {
    ok: true,
    message: `已用 ${modelId} 开启新会话（未复制历史，对齐 CLI）`,
  };
}

/**
 * 对齐 CLI `/model` `/effort`：
 * - 无会话：只改本地默认
 * - 有会话且 harness 兼容：session/set_model 热切换
 * - harness 不兼容（已有 turn）：弹窗询问是否新会话（对齐 CLI 截图）
 */
async function applySessionModelAndEffort(opts?: {
  modelId?: string;
  effort?: EffortLevel;
  /** 仅改 effort / 仅改 model 时的 toast 文案侧重点 */
  focus?: "model" | "effort" | "both";
}): Promise<{ ok: boolean; message?: string }> {
  const prevModel = modelLabel;
  const prevEffort = effortLevel;
  const nextModel = (opts?.modelId ?? modelLabel).trim() || modelLabel;
  const nextEffort = opts?.effort ?? effortLevel;

  // 乐观更新 chip
  if (opts?.modelId) setModelId(opts.modelId);
  if (opts?.effort) setEffortLevel(opts.effort);

  const revert = () => {
    setModelId(prevModel);
    setEffortLevel(prevEffort);
  };

  const hasLiveSession = Boolean(
    activeSessionId && (activeThreadId || activeCwd),
  );
  if (!hasLiveSession) {
    // 无会话：改的是「新对话默认」，并同步 chip
    if (opts?.modelId) defaultModelLabel = modelLabel;
    if (opts?.effort) defaultEffortLevel = effortLevel;
    const focus = opts?.focus ?? "both";
    if (focus === "effort") {
      return {
        ok: true,
        message: `默认推理 → ${effortLabel()}（${effortLevel}）；将用于新会话`,
      };
    }
    if (focus === "model") {
      return {
        ok: true,
        message: `默认模型 → ${modelLabel}；将用于新会话`,
      };
    }
    return {
      ok: true,
      message: `默认 ${modelLabel} · ${effortLabel()}；将用于新会话`,
    };
  }

  if (turnActive) {
    revert();
    return {
      ok: false,
      message: tr("model.waitTurn"),
    };
  }

  const threadId = await ensureLiveThread();
  if (!threadId) {
    // 无法附着：保留本地 chip，用于下次 create；不强制回退
    return {
      ok: true,
      message: tr("mode.attachFail"),
    };
  }

  const res = await inv<{ modelId: string; effort?: string; sessionId: string }>(
    "threads.setModel",
    {
      threadId,
      modelId: nextModel,
      effort: nextEffort,
    },
  );

  if (res.ok) {
    const focus = opts?.focus ?? "both";
    if (focus === "effort") {
      return {
        ok: true,
        message: `本会话推理 → ${effortLabel()}（${effortLevel}）`,
      };
    }
    if (focus === "model") {
      return {
        ok: true,
        message: `本会话模型 → ${modelLabel}`,
      };
    }
    return {
      ok: true,
      message: `本会话已切换：${modelLabel} · ${effortLabel()}`,
    };
  }

  // 对齐 CLI：跨 harness 且已有对话 → 询问是否新会话
  if (isModelSwitchNeedsNewSession(res.error)) {
    const displayName = shortModelName(nextModel);
    const ok = await confirmText({
      title: tr("model.newSessionTitle"),
      message: `切换到 ${nextModel} 需要开启新会话（与 CLI 一致：当前会话的 agent 类型不兼容）。\n\n是：用 ${displayName} 新建会话（不复制历史）\n否：留在当前会话`,
      okLabel: tr("model.newSessionOk"),
      cancelLabel: tr("model.stayCurrent"),
    });
    if (!ok) {
      revert();
      return { ok: true, message: tr("model.keepCurrent") };
    }
    return startFreshSessionWithModel(nextModel, nextEffort);
  }

  revert();
  return {
    ok: false,
    message: res.error?.message ?? tr("model.switchFailed"),
  };
}

/** 自定义模型 id（高级） */
async function promptSetModel(): Promise<{ ok: boolean; message?: string }> {
  const next = await promptText({
    title: tr("model.customTitle"),
    hint: tr("model.customHint"),
    defaultValue: modelLabel,
    placeholder: tr("model.customPh"),
  });
  if (next == null) return { ok: true };
  const v = next.trim();
  if (!v) return { ok: false, message: tr("model.empty") };
  return applySessionModelAndEffort({ modelId: v, focus: "model" });
}

async function promptSetEffort(): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    openModal(
      tr("slash.effort"),
      `<p class="prompt-dlg-hint">对齐 CLI <code>/effort</code>：low / medium / high / xhigh。已打开会话时立即热切换。</p>
       <div class="effort-pick-list" id="effort-pick-list">
         ${effortOptions().map(
           (e) =>
             `<button type="button" class="menu-item effort-pick${e.id === effortLevel ? " is-checked" : ""}" data-effort="${e.id}">
               <span>${esc(e.label)} <span class="slash-item-desc">(${esc(e.id)})</span></span>
               <span class="menu-check">${e.id === effortLevel ? "✓" : ""}</span>
             </button>`,
         ).join("")}
       </div>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">取消</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => {
      closeModal();
      resolve({ ok: true });
    };
    for (const btn of Array.from(
      document.querySelectorAll("#effort-pick-list [data-effort]"),
    )) {
      (btn as HTMLElement).onclick = () => {
        const id = (btn as HTMLElement).dataset.effort as EffortLevel;
        if (!id) return;
        closeModal();
        void applySessionModelAndEffort({ effort: id, focus: "effort" }).then(
          resolve,
        );
      };
    }
  });
}

type ModelRow = { id: string; name?: string; isDefault?: boolean };

const FALLBACK_MODELS: ModelRow[] = [
  { id: "grok-4.5", name: "grok-4.5", isDefault: true },
  { id: "grok-composer-2.5-fast", name: "grok-composer-2.5-fast" },
  { id: "grok-build", name: "grok-build" },
];

/** 渲染侧缓存：点 chip 不阻塞等待 grok models */
let modelsCache: ModelRow[] | null = null;
let modelsFetch: Promise<ModelRow[]> | null = null;
let modelMenuSeq = 0;

function hideModelMenu(): void {
  modelMenuSeq += 1;
  $("model-menu").classList.add("hidden");
  $("model-menu").innerHTML = "";
  $("model-menu").classList.remove("flyout-left");
}

function modelsForMenu(list: ModelRow[]): ModelRow[] {
  // 不再把「已从目录消失」的幽灵 id 塞回菜单（删提供商后的假选项）
  return list.map((m) => ({ ...m }));
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
  /** 全页设置打开时禁止 setModel（延后到 onClosed） */
  allowSetModel?: boolean;
}): Promise<boolean> {
  const want = (modelLabel || "").trim();
  const list = await fetchModelsList();
  if (want && list.some((m) => m.id === want)) return true;
  const prev = want || "(empty)";
  const next =
    (defaultModelLabel || "").trim() ||
    list.find((m) => m.isDefault)?.id?.trim() ||
    list[0]?.id?.trim() ||
    "grok";
  // 默认本身也可能已从目录消失时，再落到列表首项
  const resolved = list.some((m) => m.id === next)
    ? next
    : list[0]?.id?.trim() || "grok";
  if (resolved === want) return true;
  modelLabel = resolved;
  syncModelLabels();
  // 设置/插件盖住主壳时只改 chip，不打 setModel（避免与 inert 恢复竞态）
  const canSetModel =
    opts?.allowSetModel !== false && !isMainShellOverlayOpen();
  if (
    canSetModel &&
    activeThreadId &&
    !activeThreadId.startsWith("disk_") &&
    activeSessionId
  ) {
    void inv("threads.setModel", {
      threadId: activeThreadId,
      modelId: resolved,
      effort: effortLevel,
    }).catch(() => undefined);
  }
  if (opts?.toast && want && want !== resolved && !isMainShellOverlayOpen()) {
    showToast(tr("model.unavailableFallback", { prev, next: resolved }));
  }
  return false;
}

function shortModelName(id: string = modelLabel): string {
  const mid = (id || "grok").trim();
  let short = modelDisplayName(mid);
  if (short === mid && /^grok-/i.test(short)) {
    short = short.replace(/^grok-/i, "");
  }
  if (short.length > 18) short = short.slice(0, 16) + "…";
  return short;
}

function fetchModelsList(): Promise<ModelRow[]> {
  if (modelsFetch) return modelsFetch;
  modelsFetch = inv<ModelRow[]>("models.list")
    .then((r) => {
      const list = r.data?.length ? r.data : FALLBACK_MODELS;
      modelsCache = list;
      // 列表带上 display name 后刷新 chip（否则仍显示 id）
      syncModelLabels();
      return list;
    })
    .catch(() => modelsCache ?? FALLBACK_MODELS)
    .finally(() => {
      modelsFetch = null;
    });
  return modelsFetch;
}

/** 启动后预取，首点 chip 也尽量命中缓存 */
function prefetchModelsList(): void {
  void fetchModelsList();
}

/**
 * Codex 式：主面板 = 推理 + 当前模型行(>)；
 * 模型侧栏默认收起，点击模型行才展开。
 */
function modelMenuHtml(models: ModelRow[], flyoutOpen: boolean): string {
  const effortHtml = effortOptions().map((e) => {
    const on = e.id === effortLevel;
    return `<button type="button" class="menu-item${on ? " is-checked" : ""}" data-effort="${e.id}" role="menuitem">
      <span>${esc(e.label)}</span>
      <span class="menu-check" aria-hidden="true">✓</span>
    </button>`;
  }).join("");

  const modelHtml = models
    .map((m) => {
      const on = m.id === modelLabel;
      const name = m.name || m.id;
      return `<button type="button" class="menu-item${on ? " is-checked" : ""}" data-model="${esc(m.id)}" role="menuitem">
        <span>${esc(name)}</span>
        <span class="menu-check" aria-hidden="true">✓</span>
      </button>`;
    })
    .join("");

  return `
    <div class="model-menu-primary">
      <div class="menu-section-label">推理</div>
      ${effortHtml}
      <button type="button" class="menu-item model-menu-trigger${flyoutOpen ? " is-open" : ""}" data-open-models role="menuitem" aria-haspopup="true" aria-expanded="${flyoutOpen ? "true" : "false"}">
        <span class="model-trigger-name">${esc(shortModelName())}</span>
        <span class="menu-chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <div class="model-menu-flyout${flyoutOpen ? "" : " hidden"}" role="menu" aria-label="${tr("model.pick")}">
      <div class="menu-section-label">模型</div>
      ${modelHtml}
      <button type="button" class="menu-item" data-model-custom role="menuitem">
        <span>自定义…</span>
        <span class="menu-check"></span>
      </button>
    </div>`;
}

function isModelFlyoutOpen(menu: HTMLElement): boolean {
  const flyout = menu.querySelector(".model-menu-flyout");
  return Boolean(flyout && !flyout.classList.contains("hidden"));
}

function setModelFlyoutOpen(menu: HTMLElement, open: boolean): void {
  const flyout = menu.querySelector(".model-menu-flyout") as HTMLElement | null;
  const trigger = menu.querySelector("[data-open-models]") as HTMLElement | null;
  if (flyout) flyout.classList.toggle("hidden", !open);
  if (trigger) {
    trigger.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

function positionModelMenu(anchor: HTMLElement, menu: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const primary = menu.querySelector(".model-menu-primary") as HTMLElement | null;
  const flyout = menu.querySelector(".model-menu-flyout") as HTMLElement | null;
  const flyoutOpen = Boolean(flyout && !flyout.classList.contains("hidden"));
  const pw = primary?.offsetWidth || 160;
  const ph = primary?.offsetHeight || 200;
  const fw = flyoutOpen ? flyout?.offsetWidth || 180 : 0;

  // 主面板贴 chip 上方或下方（右对齐）
  let left = r.right - pw;
  if (left < 8) left = 8;
  const spaceBelow = window.innerHeight - r.bottom;
  let top: number;
  if (spaceBelow < ph + 12 && r.top > ph + 12) {
    top = Math.max(8, r.top - ph - 6);
  } else {
    top = r.bottom + 6;
  }
  // 侧栏展开时：优先开在主面板左侧（chip 在右下）；空间不够再开右边
  const openLeft =
    flyoutOpen &&
    left + pw + 8 + fw > window.innerWidth - 8 &&
    left - 8 - fw >= 8;
  menu.classList.toggle("flyout-left", openLeft);
  if (openLeft) {
    const total = pw + 8 + fw;
    left = Math.max(8, r.right - total);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function bindModelMenuClicks(menu: HTMLElement, anchor: HTMLElement, seq: number): void {
  menu.onclick = (e) => {
    const t = (e.target as HTMLElement).closest(
      "[data-effort], [data-model], [data-model-custom], [data-open-models]",
    ) as HTMLElement | null;
    if (!t) return;
    if (t.hasAttribute("data-open-models")) {
      // Codex：点模型行才展开/收起侧栏
      const next = !isModelFlyoutOpen(menu);
      setModelFlyoutOpen(menu, next);
      positionModelMenu(anchor, menu);
      return;
    }
    if (t.dataset.effort) {
      const id = t.dataset.effort as EffortLevel;
      // 先更新 UI ✓，再热切换
      setEffortLevel(id);
      if (seq === modelMenuSeq) {
        const open = isModelFlyoutOpen(menu);
        menu.innerHTML = modelMenuHtml(
          modelsForMenu(modelsCache ?? FALLBACK_MODELS),
          open,
        );
        positionModelMenu(anchor, menu);
        bindModelMenuClicks(menu, anchor, seq);
      }
      void applySessionModelAndEffort({ effort: id, focus: "effort" }).then(
        (res) => {
          if (res.message) showToast(res.message, res.ok ? "info" : "error");
        },
      );
      return;
    }
    if (t.hasAttribute("data-model-custom")) {
      hideModelMenu();
      void promptSetModel().then((res) => {
        if (res.message) showToast(res.message, res.ok ? "info" : "error");
      });
      return;
    }
    if (t.dataset.model) {
      const mid = t.dataset.model;
      hideModelMenu();
      void applySessionModelAndEffort({ modelId: mid, focus: "model" }).then(
        (res) => {
          if (res.message) showToast(res.message, res.ok ? "info" : "error");
        },
      );
    }
  };
}

/** 同步立刻弹出（用缓存/回退）；模型列表后台刷新 */
function showModelMenu(anchor: HTMLElement): void {
  $("perm-menu").classList.add("hidden");
  const menu = $("model-menu");
  const seq = ++modelMenuSeq;

  const paint = (list: ModelRow[], keepFlyout?: boolean) => {
    if (seq !== modelMenuSeq) return;
    const open = keepFlyout ? isModelFlyoutOpen(menu) : false;
    menu.innerHTML = modelMenuHtml(modelsForMenu(list), open);
    menu.classList.remove("hidden");
    positionModelMenu(anchor, menu);
    bindModelMenuClicks(menu, anchor, seq);
  };

  // 首帧：仅主菜单（侧栏收起）
  paint(modelsCache ?? FALLBACK_MODELS, false);

  // 后台刷新模型列表；若用户已展开侧栏则保持
  void fetchModelsList().then((list) => {
    if (seq !== modelMenuSeq) return;
    if (menu.classList.contains("hidden")) return;
    paint(list, true);
  });
}

function currentGoalTitle(): string | null {
  return activeGoalTitle || pendingGoalTitle;
}

/** 输入栏红框区域：计划 / 目标状态 chip（对齐 Codex） */
function syncSessionModeChips(): void {
  const planOn = isPlanOn();
  const goalTitle = currentGoalTitle();
  // /goal 进入编写态即显示 chip，发送后仍显示
  const goalOn = Boolean(goalTitle) || goalComposeActive;

  for (const id of ["chip-plan", "chip-plan-2"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !planOn);
    el.title = planOn ? tr("plan.modeChipOpen") : tr("plan.modeChip");
  }
  syncPlanPanelChrome();
  for (const id of ["chip-goal", "chip-goal-2"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !goalOn);
    el.classList.toggle("is-draft", goalComposeActive && !goalTitle);
    if (goalTitle) {
      el.title = `${tr("composer.goal")}: ${goalTitle}`;
    } else if (goalComposeActive) {
      el.title = tr("goal.bannerActive");
    }
  }
}

/**
 * 同步访问权限 + plan 到 agent（两维正交）。
 * 旧会话是 disk_*，必须先 attach 成 live thread。
 */
async function syncSessionPolicyLive(opts?: {
  plan?: boolean;
  alwaysApprove?: boolean;
}): Promise<{ ok: boolean; message?: string }> {
  const plan = opts?.plan ?? isPlanOn();
  const alwaysApprove =
    opts?.alwaysApprove ?? accessMode === "always_approve";
  if (!activeSessionId && !activeThreadId) {
    // 尚无会话：仅 UI 标记，create 时带 meta
    return { ok: true };
  }
  if (!activeCwd && activeSessionId) {
    const row = threads.find((t) => t.sessionId === activeSessionId);
    if (row?.cwd) setActiveCwd(row.cwd);
  }
  const threadId = await ensureLiveThread();
  if (!threadId) {
    return {
      ok: false,
      message: tr("mode.attachFail"),
    };
  }
  const r = await inv("threads.setMode", {
    threadId,
    plan,
    alwaysApprove,
  });
  if (!r.ok) {
    return {
      ok: false,
      message: r.error?.message ?? tr("mode.syncFail"),
    };
  }
  return { ok: true };
}

/** @deprecated 兼容旧调用名 → 两维 sync */
async function setThreadModeLive(
  mode: "plan" | "normal" | "always_approve",
): Promise<{ ok: boolean; message?: string }> {
  if (mode === "plan") {
    return syncSessionPolicyLive({ plan: true });
  }
  if (mode === "always_approve") {
    return syncSessionPolicyLive({ plan: isPlanOn(), alwaysApprove: true });
  }
  // normal：仅关 plan？旧语义是整段重置。保留为关 plan + 默认确认。
  return syncSessionPolicyLive({ plan: false, alwaysApprove: false });
}

function exitPlanMode(): void {
  if (!isPlanOn()) return;
  planPhase = "off";
  // 退出 plan 不碰 accessMode（Build：yolo 标记在 plan 退出后重新露出）
  syncPermLabels();
  void syncSessionPolicyLive({ plan: false }).then((r) => {
    if (!r.ok) {
      showToast(r.message ?? tr("plan.exitSyncFail"), "error");
    }
  });
  showToast(tr("plan.exited"));
}

/** 开启计划模式（UI + ACP session/set_mode plan）；保留当前 accessMode */
async function enterPlanMode(): Promise<{ ok: boolean; message?: string }> {
  planPhase = "pending";
  syncPermLabels();
  if (activeSessionId || activeThreadId) {
    const r = await syncSessionPolicyLive({ plan: true });
    if (!r.ok) {
      return {
        ok: false,
        message: r.message ?? tr("plan.markedSyncFail"),
      };
    }
  }
  return {
    ok: true,
    message:
      activeSessionId || activeThreadId
        ? tr("plan.openedPending")
        : tr("plan.openedNew"),
  };
}

/** /view-plan · chip：打开右栏计划面板（可编辑真源） */
async function showViewPlan(): Promise<{ ok: boolean; message?: string }> {
  if (!activeSessionId) {
    return { ok: false, message: tr("plan.noSession") };
  }
  await openPlanPanel({ requestId: pendingPlanApproval?.requestId ?? null });
  return { ok: true };
}

/**
 * 新建/切换会话时关闭计划侧栏，并清理本会话计划 UI 状态。
 * 若有未决 exit_plan 审批则 abandoned，避免旧 waiter 挂起。
 */
function closePlanPanelOnSessionChange(): void {
  const pending = pendingPlanApproval;
  pendingPlanApproval = null;
  if (pending?.requestId) {
    void inv("plans.respond", {
      requestId: pending.requestId,
      outcome: "abandoned",
      sessionId: pending.sessionId,
    });
  }
  planPanelPath = null;
  planPanelSavedContent = "";
  planPanelBusy = false;
  const ed = planEditorEl();
  if (ed) ed.value = "";
  const fb = planFeedbackEl();
  if (fb) fb.value = "";
  sidePane?.closePlanCategory();
  syncPlanPanelChrome();
}

function planEditorEl(): HTMLTextAreaElement | null {
  return document.getElementById("plan-panel-editor") as HTMLTextAreaElement | null;
}

function planFeedbackEl(): HTMLTextAreaElement | null {
  return document.getElementById(
    "plan-panel-feedback",
  ) as HTMLTextAreaElement | null;
}

function planPanelDirty(): boolean {
  const ed = planEditorEl();
  if (!ed) return false;
  return ed.value !== planPanelSavedContent;
}

function planPreviewEl(): HTMLElement | null {
  return document.getElementById("plan-panel-preview");
}

function syncPlanPanelChrome(): void {
  const status = document.getElementById("plan-panel-status");
  const pathEl = document.getElementById("plan-panel-path");
  const empty = document.getElementById("plan-panel-empty");
  const ed = planEditorEl();
  const prev = planPreviewEl();
  const modeBtn = document.getElementById("btn-plan-view-mode");
  if (pathEl) {
    pathEl.textContent = planPanelPath ?? tr("plan.noPlanMd");
    pathEl.title = planPanelPath ?? "";
  }
  if (status) {
    const bits: string[] = [];
    if (isPlanOn()) {
      bits.push(
        planPhase === "pending"
          ? "Pending"
          : planPhase === "active"
            ? "Active"
            : tr("plan.modeChip"),
      );
    }
    if (planPanelDirty()) bits.push(tr("plan.unsaved"));
    if (pendingPlanApproval) bits.push(tr("plan.awaiting"));
    status.textContent = bits.join(" · ");
  }
  if (modeBtn) {
    const isPreview = planPanelViewMode === "preview";
    modeBtn.textContent = isPreview ? tr("common.source") : tr("common.preview");
    modeBtn.title = tr("side.planToggleView");
    modeBtn.setAttribute("aria-pressed", isPreview ? "true" : "false");
  }
  const text = ed?.value ?? "";
  const hasBody = Boolean(text.trim()) || planPanelDirty();
  empty?.classList.toggle("hidden", hasBody);
  const showSource = planPanelViewMode === "source";
  ed?.classList.toggle("hidden", !showSource || !hasBody);
  prev?.classList.toggle("hidden", showSource || !hasBody);
  // 预览模式下禁用保存焦点在编辑器；保存仍可用（写当前 draft）
  if (ed) ed.readOnly = !showSource;
}

/** 按当前 viewMode 刷新预览 DOM（从 editor 读源码） */
function renderPlanPanelPreview(): void {
  const ed = planEditorEl();
  const prev = planPreviewEl();
  if (!prev || !ed) return;
  const raw = ed.value;
  if (!raw.trim()) {
    prev.innerHTML = "";
    return;
  }
  try {
    paintAssistantHtml(prev, raw, { highlight: true, cwd: activeCwd });
  } catch {
    prev.textContent = raw;
  }
}

function setPlanPanelViewMode(mode: "source" | "preview"): void {
  if (mode === planPanelViewMode) {
    syncPlanPanelChrome();
    return;
  }
  planPanelViewMode = mode;
  if (mode === "preview") renderPlanPanelPreview();
  syncPlanPanelChrome();
}

function bindPlanPanel(): void {
  if (planPanelBound) return;
  planPanelBound = true;
  const ed = planEditorEl();
  ed?.addEventListener("input", () => syncPlanPanelChrome());
  document.getElementById("btn-plan-reload")?.addEventListener("click", () => {
    void openPlanPanel({
      requestId: pendingPlanApproval?.requestId ?? null,
      forceReload: true,
    });
  });
  document.getElementById("btn-plan-save")?.addEventListener("click", () => {
    void savePlanPanel().then((ok) => {
      if (ok) showToast(tr("plan.saved"));
    });
  });
  document.getElementById("btn-plan-view-mode")?.addEventListener("click", () => {
    setPlanPanelViewMode(
      planPanelViewMode === "source" ? "preview" : "source",
    );
  });
  document.getElementById("btn-plan-approve")?.addEventListener("click", () => {
    void respondPlanPanel("approved");
  });
  document.getElementById("btn-plan-revise")?.addEventListener("click", () => {
    void respondPlanPanel("cancelled");
  });
  document.getElementById("btn-plan-abandon")?.addEventListener("click", () => {
    void respondPlanPanel("abandoned");
  });
  // Ctrl+S 在计划编辑器内保存
  ed?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void savePlanPanel().then((ok) => {
        if (ok) showToast(tr("plan.saved"));
      });
    }
  });
}

/**
 * 打开右栏「计划」面板并加载 session plan.md。
 * 真源优先 session；空则镜像工作区 *plan* 产物。
 */
async function openPlanPanel(opts?: {
  requestId?: string | null;
  forceReload?: boolean;
  /** agent 刚写入的正文（exit_plan 参数） */
  seedContent?: string | null;
}): Promise<void> {
  bindPlanPanel();
  if (!activeSessionId) {
    showToast(tr("plan.noSession"), "error");
    return;
  }
  if (opts?.requestId) {
    pendingPlanApproval = {
      requestId: opts.requestId,
      sessionId: activeSessionId,
      planContent: opts.seedContent ?? "",
    };
  }

  sidePane?.openPlanCategory();

  const res = await inv<{
    sessionId: string;
    status: string;
    content: string;
    path?: string | null;
  } | null>("plans.get", { sessionId: activeSessionId });

  let content = (res.ok ? res.data?.content : "") ?? "";
  let path = (res.ok ? res.data?.path : null) ?? null;

  // seed（exit_plan 自带）优先填空文件
  if (!content.trim() && opts?.seedContent?.trim()) {
    content = opts.seedContent;
  }

  // session 空：从工作区计划产物镜像
  if (!content.trim() && lastPlanArtifactPath) {
    const fileRes = await inv<{
      content?: string;
      binary?: boolean;
      isDirectory?: boolean;
      absPath?: string;
    }>("files.read", {
      path: lastPlanArtifactPath,
      cwd: activeCwd ?? undefined,
      maxBytes: 512_000,
    });
    const body =
      fileRes.ok && !fileRes.data?.binary && !fileRes.data?.isDirectory
        ? (fileRes.data?.content ?? "")
        : "";
    if (body.trim()) {
      content = body;
      await inv("plans.write", {
        sessionId: activeSessionId,
        content: body,
      });
      const again = await inv<{ path?: string | null } | null>("plans.get", {
        sessionId: activeSessionId,
      });
      path = again.ok ? again.data?.path ?? path : path;
    }
  }

  const ed = planEditorEl();
  if (ed) {
    // 有未保存修改且非强制重载时不覆盖
    if (!opts?.forceReload && planPanelDirty() && ed.value.trim()) {
      /* keep draft */
    } else {
      ed.value = content;
      planPanelSavedContent = content;
    }
  }
  planPanelPath = path;
  if (planPanelViewMode === "preview") renderPlanPanelPreview();
  syncPlanPanelChrome();
}

async function savePlanPanel(): Promise<boolean> {
  if (!activeSessionId) {
    showToast(tr("plan.noSession"), "error");
    return false;
  }
  const ed = planEditorEl();
  if (!ed) return false;
  const content = ed.value;
  const r = await inv<{ path?: string }>("plans.write", {
    sessionId: activeSessionId,
    content,
  });
  if (!r.ok) {
    showToast(r.error?.message ?? tr("plan.saveFailed"), "error");
    return false;
  }
  planPanelSavedContent = content;
  if (r.data?.path) planPanelPath = r.data.path;
  syncPlanPanelChrome();
  return true;
}

function setPlanPanelBusy(busy: boolean, approveLabel?: string): void {
  planPanelBusy = busy;
  for (const id of [
    "btn-plan-approve",
    "btn-plan-revise",
    "btn-plan-abandon",
    "btn-plan-save",
    "btn-plan-reload",
    "btn-plan-view-mode",
  ]) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = busy;
  }
  const ap = document.getElementById("btn-plan-approve");
  if (ap) {
    ap.textContent = busy && approveLabel ? approveLabel : tr("plan.approveBtn");
  }
}

/**
 * 计划面板底栏：批准 / 要求修改 / 放弃
 * （对齐 CLI/Codex：批准即开始实现；可先改 plan.md 再批）
 */
async function respondPlanPanel(
  outcome: "approved" | "cancelled" | "abandoned",
): Promise<void> {
  if (planPanelBusy) return;
  if (!activeSessionId) {
    showToast(tr("plan.noSession"), "error");
    return;
  }
  setPlanPanelBusy(
    true,
    outcome === "approved"
      ? tr("plan.approving")
      : outcome === "cancelled"
        ? tr("plan.sending")
        : tr("plan.processing"),
  );
  const feedback = (planFeedbackEl()?.value ?? "").trim();
  const requestId = pendingPlanApproval?.requestId ?? null;

  try {
    // 批准 / 要求修改前先落盘编辑器内容
    if (outcome === "approved" || outcome === "cancelled") {
      if (planPanelDirty() || (planEditorEl()?.value ?? "").trim()) {
        const ok = await savePlanPanel();
        if (!ok && outcome === "approved") {
          setPlanPanelBusy(false);
          return;
        }
      }
    }

    if (requestId) {
      const r = await inv("plans.respond", {
        requestId,
        outcome,
        feedback:
          outcome === "cancelled" || outcome === "approved"
            ? feedback || undefined
            : undefined,
        sessionId: activeSessionId,
      });
      if (!r.ok) {
        showToast(r.error?.message ?? tr("plan.respondFail"), "error");
        setPlanPanelBusy(false);
        return;
      }
    } else if (outcome === "approved") {
      const r = await inv("plans.approve", { sessionId: activeSessionId });
      if (!r.ok) {
        showToast(r.error?.message ?? tr("plan.writeStatusFail"), "error");
        setPlanPanelBusy(false);
        return;
      }
    } else if (outcome === "abandoned") {
      await inv("plans.reject", { sessionId: activeSessionId });
    }

    pendingPlanApproval = null;
    if (planFeedbackEl()) planFeedbackEl()!.value = "";

    // 清掉「等待计划审批」占位，避免 UI 假死
    clearPlanApprovalWaitingUi(
      outcome === "abandoned" ? tr("plan.abandoned") : tr("turn.thinking"),
    );

    if (outcome === "approved") {
      // 退出 plan，保留 accessMode（Build：yolo 在 plan 下 armed，批准后继续）
      planPhase = "off";
      syncPermLabels();
      await syncSessionPolicyLive({ plan: false });
      setPlanPanelBusy(false);
      sidePane?.closePlanCategory();
      syncPlanPanelChrome();
      if (requestId) {
        // exit_plan reverse-RPC 已 resolve，agent 在同一回合继续实现
        showToast(tr("plan.approvedToast"));
        appendLine(tr("plan.approvedLine"), "system");
      } else {
        const implPrompt = feedback
          ? `计划已批准（以当前 plan.md 为准）。附加意见：\n${feedback}\n\n请按计划开始实现，不要扩大范围；完成后简要汇报变更。`
          : `计划已批准（以当前 plan.md 为准）。请按计划开始实现，不要扩大范围；完成后简要汇报变更。`;
        showToast(tr("plan.implStartToast"));
        await dispatchAgentPrompt(implPrompt, tr("plan.implUser"), {
          force: true,
        });
      }
    } else if (outcome === "abandoned") {
      // 退出 plan；保留 accessMode
      planPhase = "off";
      syncPermLabels();
      await syncSessionPolicyLive({ plan: false });
      setPlanPanelBusy(false);
      sidePane?.closePlanCategory();
      syncPlanPanelChrome();
      showToast(tr("plan.abandonToast"));
      appendLine(tr("plan.abandonLine"), "system");
    } else {
      // cancelled = 要求修改：保持 plan + accessMode
      planPhase = "active";
      syncPermLabels();
      setPlanPanelBusy(false);

      if (requestId) {
        // reverse-RPC 已把 cancelled+feedback 交回 agent，本回合会 Continue。
        // 切勿再 session/prompt，否则会与进行中回合冲突 → Internal error。
        showToast(feedback ? tr("plan.reviseToastFb") : tr("plan.reviseToast"));
        setTurnStatus(tr("plan.revising"));
      } else {
        const revPrompt = feedback
          ? `请根据以下意见修改计划（仍在计划模式：更新 plan.md，不要改业务代码）。我已直接编辑了 plan.md，请在其基础上修订：\n${feedback}`
          : `请根据我已编辑的 plan.md 继续完善计划（仍在计划模式：只更新 plan.md，不要改业务代码）。补充风险、验收标准与可落地步骤。`;
        showToast(tr("plan.reviseStartToast"));
        await dispatchAgentPrompt(revPrompt, tr("plan.reviseUser"), { force: true });
      }
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : tr("plan.opFail"), "error");
    setPlanPanelBusy(false);
  }
}

/** 审批结束后清掉「等待计划审批」状态条 */
function clearPlanApprovalWaitingUi(nextLabel?: string): void {
  if (turnActive) {
    if (nextLabel) setTurnStatus(nextLabel);
    else removeTurnStatus();
  } else {
    removeTurnStatus();
  }
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  setComposerBusy(turnActive);
}

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
  const hist = await inv<{
    entries: Array<{ role: string; text: string }>;
  }>("history.load", { sessionId: activeSessionId });
  if (!hist.ok || !hist.data?.entries?.length) return;

  const shown = Array.from(
    $("transcript").querySelectorAll(".line.assistant"),
  ).map((n) =>
    normalizeAssistantForDedupe(
      ((n as HTMLElement).dataset.raw ?? n.textContent ?? "").trim(),
    ),
  );

  for (const e of hist.data.entries) {
    if (e.role !== "assistant" && e.role !== "ai") continue;
    const text = (e.text ?? "").trim();
    if (!text || text.length < 8) continue;
    const n = normalizeAssistantForDedupe(text);
    if (!n || n.length < 12) continue;
    const exists = shown.some(
      (s) =>
        s === n ||
        (n.length > 40 && s.includes(n.slice(0, 40))) ||
        (s.length > 40 && n.includes(s.slice(0, 40))),
    );
    if (exists) continue;
    appendLine(text, "assistant");
    shown.push(n);
  }
}

/** 从 write 类 tool raw 识别计划文档路径 */
function notePlanArtifactFromTool(name: string | undefined, raw: unknown): void {
  const meta = extractToolMeta(raw, name);
  if (meta.kind !== "write" && !/write|edit|create/i.test(name ?? "")) return;
  for (const p of meta.paths) {
    const base = p.split(/[/\\]/).pop() ?? p;
    if (
      /^plan\.md$/i.test(base) ||
      (/plan/i.test(base) && /\.(md|markdown|txt)$/i.test(base))
    ) {
      lastPlanArtifactPath = p;
      return;
    }
  }
  // title: Write `...\performance-optimization-plan.zh.md`
  if (raw && typeof raw === "object") {
    const title = String((raw as { title?: string }).title ?? "");
    const m = title.match(/`([^`]+\.(?:md|markdown|txt))`/i);
    if (m) {
      const base = m[1].split(/[/\\]/).pop() ?? m[1];
      if (/plan/i.test(base)) lastPlanArtifactPath = m[1];
    }
  }
}

/**
 * 计划模式回合结束：默认不抢右栏。
 * - 有 exit_plan 待批 → 已由 handlePlanApproval 打开面板
 * - 否则仅 toast，用户 /view-plan 或点 chip 再开
 */
async function maybeSurfacePlanAfterTurn(): Promise<void> {
  if (!isPlanOn()) return;
  if (!activeSessionId) return;
  if (pendingPlanApproval) return;

  // 后台确保 session plan 有内容（镜像工作区产物），不打开侧栏
  const res = await inv<{ content?: string } | null>("plans.get", {
    sessionId: activeSessionId,
  });
  let content = (res.ok ? res.data?.content : "")?.trim() ?? "";
  if (!content && lastPlanArtifactPath) {
    const fileRes = await inv<{
      content?: string;
      binary?: boolean;
      isDirectory?: boolean;
    }>("files.read", {
      path: lastPlanArtifactPath,
      cwd: activeCwd ?? undefined,
      maxBytes: 512_000,
    });
    const body =
      fileRes.ok && !fileRes.data?.binary && !fileRes.data?.isDirectory
        ? (fileRes.data?.content ?? "").trim()
        : "";
    if (body) {
      content = body;
      await inv("plans.write", {
        sessionId: activeSessionId,
        content: body,
      });
    }
  }
  if (content) {
    showToast(tr("chat.planReady"), "info");
  } else if (lastPlanArtifactPath) {
    showToast(
      `计划可能在 ${lastPlanArtifactPath.split(/[/\\]/).pop()} · /view-plan 查看`,
      "info",
    );
  }
}

/**
 * 系统代发一条用户消息并跑一轮（计划批准 / 要求修改）。
 * display 进时间线；content 发给 agent。
 */
/**
 * 系统代发一条用户消息并跑一轮。
 * force：计划批准等场景下若 UI 仍标 turnActive（exit_plan 挂起/事件乱序），先 endTurn 再发。
 */
async function dispatchAgentPrompt(
  content: string,
  display?: string,
  opts?: { force?: boolean },
): Promise<void> {
  const shown = (display ?? content).trim();
  const agentText = content.trim();
  if (!agentText) return;

  if (turnActive) {
    if (opts?.force) {
      // 不 cancel agent（可能已 idle）；只清 UI 锁，允许新 prompt
      // 跳过 drain：本函数紧接着 beginTurn，避免与队列竞态
      endTurn({ skipQueueDrain: true });
    } else {
      showToast(tr("chat.turnBusy"), "error");
      return;
    }
  }

  paintUserMessage(shown);
  showWelcome(false);
  beginTurn();
  setTurnStatus(tr("chat.connecting"));

  const threadId = await ensureLiveThread();
  if (!threadId) {
    endTurn();
    appendLine(tr("chat.connectFail"), "error");
    return;
  }
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  setTurnStatus(tr("turn.thinking"));
  const res = await inv("turns.prompt", {
    threadId,
    content: agentText,
  });
  if (!res.ok) {
    endTurn();
    appendLine(res.error?.message ?? tr("chat.sendFail"), "error");
  } else {
    scheduleTurnSettle(currentTurnId);
  }
  void refreshContextUsage();
  void refreshProjectsAndThreads();
}

function bindSessionModeChips(): void {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const close = t.closest("[data-chip-close]") as HTMLElement | null;
    if (close) {
      e.preventDefault();
      e.stopPropagation();
      const kind = close.dataset.chipClose;
      if (kind === "plan") exitPlanMode();
      if (kind === "goal") {
        // 编写中尚未落目标：只取消 compose
        if (goalComposeActive && !currentGoalTitle()) {
          goalComposeActive = false;
          setComposerPlaceholders(false);
          syncSessionModeChips();
          showToast(tr("chat.goalCancelled"));
        } else {
          void runGoalCommand("clear").then((r) => {
            if (r.message) showToast(r.message, r.ok ? "info" : "error");
          });
        }
      }
      return;
    }
    const planChip = t.closest("#chip-plan, #chip-plan-2");
    if (planChip && !t.closest("[data-chip-close]")) {
      void showViewPlan().then((r) => {
        if (!r.ok && r.message) showToast(r.message, "error");
      });
      return;
    }
    const goalChip = t.closest("#chip-goal, #chip-goal-2");
    if (goalChip && !t.closest("[data-chip-close]")) {
      void runGoalCommand("status");
    }
  });
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
  return new Promise((resolve) => {
    openModal(
      opts.title,
      `
      ${opts.hint ? `<p class="prompt-dlg-hint">${esc(opts.hint)}</p>` : ""}
      <input id="prompt-dlg-input" class="prompt-dlg-input" type="text"
        value="${esc(opts.defaultValue ?? "")}"
        placeholder="${esc(opts.placeholder ?? "")}" autocomplete="off" />
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">取消</button>
        <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(opts.okLabel ?? tr("dlg.ok"))}</button>
      </div>`,
    );
    const input = $("prompt-dlg-input") as HTMLInputElement;
    const finish = (v: string | null) => {
      closeModal();
      resolve(v);
    };
    $("prompt-dlg-cancel").onclick = () => finish(null);
    $("prompt-dlg-ok").onclick = () => finish(input.value);
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(input.value);
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(null);
      }
    };
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

function confirmText(opts: {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(
      opts.title,
      `
      <p class="prompt-dlg-hint" style="white-space:pre-wrap">${esc(opts.message)}</p>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(opts.cancelLabel ?? tr("dlg.cancel"))}</button>
        <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(opts.okLabel ?? tr("dlg.ok"))}</button>
      </div>`,
    );
    const finish = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    $("prompt-dlg-cancel").onclick = () => finish(false);
    $("prompt-dlg-ok").onclick = () => finish(true);
  });
}

function showToast(text: string, kind: "info" | "error" = "info"): void {
  let el = document.getElementById("app-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toast";
    el.className = "app-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("error", kind === "error");
  el.classList.add("show");
  window.clearTimeout((el as HTMLElement & { _t?: number })._t);
  (el as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
    el?.classList.remove("show");
  }, 3200);
}

/**
 * 发送路径：若整行是已知 slash（含 paletteHidden 如 /always-approve），本地执行不交 agent。
 * 返回 true 表示已处理并应中止发送。
 */
async function tryRunComposerSlashLine(raw: string): Promise<boolean> {
  const t = raw.trim();
  if (!t.startsWith("/")) return false;
  // 单 token 或 /cmd args — 先解析主命令
  const m = t.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const name = (m[1] ?? "").toLowerCase();
  if (!name) return false;
  // 仅拦截桌面静态命令（skills/agent 广告仍可当 prompt 或走 palette）
  const cmd = resolveSlashCommand(getStaticSlashCommands(), name);
  if (!cmd) return false;
  const ta = activeComposerInput();
  if (ta) ta.value = "";
  slashPalette?.hide();
  const res = await runSlashCommand(cmd);
  if (res.message) showToast(res.message, res.ok ? "info" : "error");
  return true;
}

/** 仅处理会话斜杠命令（导航类走侧栏 / 顶栏 UI） */
async function runSlashCommand(cmd: SlashCommandDef): Promise<{ ok: boolean; message?: string }> {
  const act = cmd.action;
  switch (act.kind) {
    case "set-perm":
      // always-approve：toggle 访问权限，不退出 plan（Build：yolo armed underneath）
      if (act.mode === "always_approve") {
        const on = accessMode !== "always_approve";
        accessMode = on ? "always_approve" : "normal";
        const sync = await syncSessionPolicyLive({
          alwaysApprove: on,
          plan: isPlanOn(),
        });
        syncPermLabels();
        return {
          ok: sync.ok,
          message: !sync.ok
            ? sync.message
            : on
              ? tr("slash.fullOn")
              : tr("slash.fullOff"),
        };
      }
      if (act.mode === "plan") {
        // /plan 再开一次：若已在 plan 则退出（toggle 感）；否则进入
        if (isPlanOn()) {
          exitPlanMode();
          return { ok: true, message: tr("slash.exitPlan") };
        }
        return enterPlanMode();
      }
      // normal：只切访问权限为默认确认，不强制退 plan
      accessMode = "normal";
      await syncSessionPolicyLive({ alwaysApprove: false, plan: isPlanOn() });
      syncPermLabels();
      return { ok: true, message: tr("slash.permTo", { label: permLabel() }) };
    case "view-plan":
      return showViewPlan();
    case "goal":
      return runGoalCommand(act.sub ?? "set");
    case "set-max-turns":
      return promptSetMaxTurns(act.turns);
    case "agent-command": {
      // agent 广告命令：插入 `/name ` 到输入框，由用户补参后发送（同源 slash）
      const name = act.name.replace(/^\//, "");
      insertComposerText(`/${name} `);
      return { ok: true, message: tr("slash.agentCmdInserted", { name }) };
    }
    case "memory":
      return runMemoryCommand(act.sub ?? "list");
    case "set-model":
      return promptSetModel();
    case "open-model-menu": {
      const welcome = !$("welcome").classList.contains("hidden");
      const anchor = (
        welcome ? $("btn-model") : $("btn-model-2")
      ) as HTMLElement;
      showModelMenu(anchor);
      return { ok: true };
    }
    case "show-context":
      return showContextDetails();
    case "set-effort": {
      if (act.level) {
        return applySessionModelAndEffort({
          effort: act.level,
          focus: "effort",
        });
      }
      return promptSetEffort();
    }
    case "status": {
      const p = selectedProject();
      const projectLine = p
        ? `${p.title} (${p.path})`
        : tr("slash.none");
      // 优先 agent session/info；失败回退本地简表
      const info = await fetchSessionInfoForActive();
      if (info) {
        const lines = formatSessionInfoLines(info, {
          project: projectLine,
          effort: `${effortLabel()}（${effortLevel}）`,
          perm: permLabel(),
        });
        openModal(
          tr("slash.statusTitle"),
          `<pre class="slash-status-pre">${esc(lines.join("\n"))}</pre>`,
        );
        // 顺带刷新 context chip
        const c = info.context;
        if (c.total > 0 || c.used > 0) {
          lastContextUsage = {
            sessionId: info.sessionId,
            used: c.used,
            total: c.total,
            percent:
              c.usagePct ||
              (c.total > 0 ? Math.min(100, (c.used / c.total) * 100) : 0),
            available: true,
            source: "signals",
          };
          syncContextLabels();
        }
        return { ok: true };
      }
      const lines = [
        tr("status.project", { project: projectLine }),
        tr("status.thread", { id: activeThreadId ?? "—" }),
        tr("status.sessionId", { id: activeSessionId ?? "—" }),
        tr("status.cwd", { cwd: activeCwd ?? p?.path ?? "—" }),
        tr("status.perm", { perm: permLabel() }),
        tr("status.model", { model: modelLabel }),
        tr("status.effort", {
          effort: `${effortLabel()}（${effortLevel}）`,
        }),
        tr("status.openTarget", {
          target:
            !defaultOpenTarget || defaultOpenTarget === "explorer"
              ? tr("slash.openExplorer")
              : defaultOpenTarget === "editor"
                ? tr("slash.openEditor")
                : defaultOpenTarget,
        }),
        "",
        tr("status.needAttach"),
      ];
      openModal(
        tr("slash.statusTitle"),
        `<pre class="slash-status-pre">${esc(lines.join("\n"))}</pre>`,
      );
      return { ok: true };
    }
    case "export-session":
      return exportActiveSession({ destination: "clipboard" });
    case "compact-session":
      return compactActiveSession();
    case "fork-session":
      return forkActiveSession();
    case "rewind-session":
      return rewindViaSlash();
    case "show-queue":
      return showPromptQueueModal();
    case "clear-queue": {
      if (!promptQueue.length) {
        return { ok: true, message: tr("queue.empty") };
      }
      clearPromptQueue();
      return { ok: true, message: tr("queue.cleared") };
    }
    case "show-tasks":
      return showTasksPanel();
    case "show-prompt-history":
      return showPromptHistorySearch();
    case "btw":
      return runBtwCommand(act.question);
    case "interject":
      return runInterjectCommand(act.text);
    case "insert-text": {
      const ta = document.activeElement as HTMLTextAreaElement | null;
      const targets = [
        $("composer-input") as HTMLTextAreaElement,
        $("chat-input") as HTMLTextAreaElement,
        $("focus-input") as HTMLTextAreaElement,
      ];
      const input =
        ta && targets.includes(ta)
          ? ta
          : !$("chat").classList.contains("hidden")
            ? targets[1]
            : targets[0];
      const cur = input.selectionStart ?? input.value.length;
      const pad = cur > 0 && !/\s$/.test(input.value.slice(0, cur)) ? " " : "";
      const ins = pad + act.text;
      input.value = input.value.slice(0, cur) + ins + input.value.slice(cur);
      const pos = cur + ins.length;
      input.setSelectionRange(pos, pos);
      input.focus();
      return { ok: true };
    }
    default:
      return { ok: false, message: tr("slash.unknown") };
  }
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
  const next = await promptText({
    title: tr("slash.renameTitle"),
    hint: tr("slash.renameHint"),
    defaultValue: t.title || "",
    placeholder: tr("slash.renamePh"),
  });
  if (next == null) return;
  const title = next.trim();
  if (!title) {
    showToast(tr("slash.renameEmpty"), "error");
    return;
  }
  const res = await inv("threads.rename", { threadId: t.id, title });
  if (!res.ok) {
    showToast(res.error?.message ?? tr("slash.renameFail"), "error");
    return;
  }
  await refreshProjectsAndThreads();
  showToast(`已重命名为「${title}」`);
}

async function exportActiveSession(opts?: {
  destination?: "clipboard" | "file";
  /** 指定线程；默认当前活动会话 */
  threadId?: string;
}): Promise<{ ok: boolean; message?: string }> {
  const tid = opts?.threadId ?? activeThreadRefId();
  if (!tid) return { ok: false, message: tr("slash.needSession") };
  const destination = opts?.destination ?? "clipboard";
  const res = await inv<{
    canceled?: boolean;
    path?: string | null;
    destination?: "clipboard" | "file";
  }>("threads.export", { threadId: tid, destination });
  if (!res.ok) return { ok: false, message: res.error?.message ?? tr("slash.exportFail") };
  if (res.data?.canceled) return { ok: true, message: tr("slash.exportCancel") };
  if (res.data?.destination === "clipboard" || destination === "clipboard") {
    return { ok: true, message: tr("slash.exportClipboardOk") };
  }
  return {
    ok: true,
    message: res.data?.path
      ? tr("slash.exported", { path: res.data.path })
      : tr("slash.exportedOk"),
  };
}

/**
 * 真压缩：ACP `_x.ai/compact_conversation`（对齐 CLI CompactSession）。
 * 可选 userContext 作为 two-pass「保留说明」。
 */
async function compactActiveSession(): Promise<{ ok: boolean; message?: string }> {
  if (!activeThreadId && !activeSessionId) {
    return { ok: false, message: tr("slash.needSession") };
  }
  if (turnActive) return { ok: false, message: tr("slash.waitTurn") };

  const userContext = await promptCompactUserContext();
  if (userContext === null) {
    return { ok: true, message: tr("slash.cancelled") };
  }

  const threadId = await ensureLiveThread();
  if (!threadId) {
    return { ok: false, message: tr("slash.compactAttachFail") };
  }

  appendLine(tr("slash.compactRunning"), "system");
  const pr = await inv<{ sessionId: string; ok: true }>("threads.compact", {
    threadId,
    userContext: userContext || undefined,
  });
  if (!pr.ok) {
    return {
      ok: false,
      message: pr.error?.message ?? tr("slash.compactFail"),
    };
  }
  refreshContextAfterCompact({});
  appendLine(
    userContext ? tr("slash.compactDoneWithCtx") : tr("slash.compactDone"),
    "system",
  );
  return {
    ok: true,
    message: userContext
      ? tr("slash.compactDoneWithCtx")
      : tr("slash.compactDone"),
  };
}

/** compact 确认 + 可选保留说明（对齐 CLI `/compact [user_context]`） */
function promptCompactUserContext(): Promise<string | null> {
  return new Promise((resolve) => {
    openModal(
      tr("slash.compactTitle"),
      `<p class="prompt-dlg-hint">${esc(tr("slash.compactBody"))}</p>
       <label class="prompt-dlg-label" for="compact-ctx">${esc(tr("slash.compactCtxLabel"))}</label>
       <textarea id="compact-ctx" class="prompt-dlg-input" rows="3"
         placeholder="${esc(tr("slash.compactCtxPh"))}"></textarea>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("slash.compactOk"))}</button>
       </div>`,
    );
    const ta = $("compact-ctx") as HTMLTextAreaElement;
    $("prompt-dlg-cancel").onclick = () => {
      closeModal();
      resolve(null);
    };
    $("prompt-dlg-ok").onclick = () => {
      const v = ta.value.trim();
      closeModal();
      resolve(v);
    };
    requestAnimationFrame(() => ta.focus());
  });
}

async function promptSetMaxTurns(
  preset?: number,
): Promise<{ ok: boolean; message?: string }> {
  if (preset != null && Number.isFinite(preset) && preset > 0) {
    maxTurnsLimit = Math.floor(preset);
    return {
      ok: true,
      message: tr("slash.maxTurnsSet", { n: String(maxTurnsLimit) }),
    };
  }
  return new Promise((resolve) => {
    const cur = maxTurnsLimit != null ? String(maxTurnsLimit) : "";
    openModal(
      tr("slash.maxTurns"),
      `<p class="prompt-dlg-hint">${esc(tr("slash.maxTurnsHint"))}</p>
       <input id="max-turns-input" class="prompt-dlg-input" type="number" min="0" step="1"
         value="${esc(cur)}" placeholder="${esc(tr("slash.maxTurnsPh"))}" />
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-ghost" id="max-turns-clear">${esc(tr("slash.maxTurnsClear"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("common.ok"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => {
      closeModal();
      resolve({ ok: true, message: tr("slash.cancelled") });
    };
    $("max-turns-clear").onclick = () => {
      maxTurnsLimit = null;
      closeModal();
      resolve({ ok: true, message: tr("slash.maxTurnsCleared") });
    };
    $("prompt-dlg-ok").onclick = () => {
      const raw = ($("max-turns-input") as HTMLInputElement).value.trim();
      if (!raw) {
        maxTurnsLimit = null;
        closeModal();
        resolve({ ok: true, message: tr("slash.maxTurnsCleared") });
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        showToast(tr("slash.maxTurnsInvalid"), "error");
        return;
      }
      maxTurnsLimit = Math.floor(n);
      closeModal();
      resolve({
        ok: true,
        message: tr("slash.maxTurnsSet", { n: String(maxTurnsLimit) }),
      });
    };
    requestAnimationFrame(() =>
      ($("max-turns-input") as HTMLInputElement).focus(),
    );
  });
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
}

/**
 * CLI 对齐 Memory（A18/E5）：GROK_HOME/memory Global/Workspace/Sessions。
 * /memory 浏览；/remember 写入；/flush /dream 指挥 agent。
 */
async function runMemoryCommand(
  sub: "list" | "add" | "search" | "status" | "flush" | "dream",
): Promise<{ ok: boolean; message?: string }> {
  if (sub === "status") {
    const st = await inv<{
      enabled: boolean;
      fileCount: number;
      storePath: string;
      productNote?: string;
      message?: string;
    }>("memory.status");
    if (!st.ok) return { ok: false, message: st.error?.message };
    const s = st.data!;
    return {
      ok: true,
      message: `${s.enabled ? tr("settings.memoryOn") : tr("settings.memoryOff")} · ${tr("settings.memoryFileCount", { n: s.fileCount })} · ${s.storePath}`,
    };
  }
  if (sub === "add") {
    return promptAddMemory();
  }
  if (sub === "flush") {
    return runMemoryFlush();
  }
  if (sub === "dream") {
    return runMemoryDream();
  }
  return showMemoryBrowser(sub === "search");
}

async function runMemoryFlush(): Promise<{ ok: boolean; message?: string }> {
  const threadId = await ensureLiveThread();
  if (!threadId) return { ok: false, message: tr("memory.needAttach") };
  const st = await inv<{ enabled: boolean }>("memory.status");
  if (st.ok && !st.data?.enabled) {
    return { ok: false, message: tr("memory.needEnable") };
  }
  const res = await inv("threads.memoryFlush", { threadId });
  if (!res.ok) return { ok: false, message: res.error?.message ?? tr("memory.flushFail") };
  return { ok: true, message: tr("memory.flushOk") };
}

async function runMemoryDream(): Promise<{ ok: boolean; message?: string }> {
  const threadId = await ensureLiveThread();
  if (!threadId) return { ok: false, message: tr("memory.needAttach") };
  const st = await inv<{ enabled: boolean }>("memory.status");
  if (st.ok && !st.data?.enabled) {
    return { ok: false, message: tr("memory.needEnable") };
  }
  const res = await inv("threads.memoryDream", { threadId });
  if (!res.ok) return { ok: false, message: res.error?.message ?? tr("memory.dreamFail") };
  return { ok: true, message: tr("memory.dreamOk") };
}

async function promptAddMemory(): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    openModal(
      tr("slash.remember"),
      `<p class="prompt-dlg-hint">${esc(tr("memory.addHint"))}</p>
       <textarea id="mem-add-text" class="prompt-dlg-input" rows="4"
         placeholder="${esc(tr("memory.addPh"))}"></textarea>
       <div class="memory-scope-row">
         <label><input type="radio" name="mem-scope" value="global" checked /> ${esc(tr("memory.scopeGlobal"))}</label>
         <label><input type="radio" name="mem-scope" value="workspace" /> ${esc(tr("memory.scopeWorkspace"))}</label>
       </div>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("memory.addOk"))}</button>
       </div>`,
    );
    const ta = $("mem-add-text") as HTMLTextAreaElement;
    $("prompt-dlg-cancel").onclick = () => {
      closeModal();
      resolve({ ok: true, message: tr("slash.cancelled") });
    };
    $("prompt-dlg-ok").onclick = async () => {
      const text = ta.value.trim();
      if (!text) {
        showToast(tr("memory.addEmpty"), "error");
        return;
      }
      const scopeEl = document.querySelector(
        'input[name="mem-scope"]:checked',
      ) as HTMLInputElement | null;
      const scope = scopeEl?.value === "workspace" ? "workspace" : "global";
      const cwd = getActiveCwd?.() ?? undefined;
      const res = await inv<{ path: string; scope: string }>("memory.remember", {
        text,
        scope,
        cwd,
        threadId: activeThreadId && !activeThreadId.startsWith("disk_")
          ? activeThreadId
          : undefined,
        rewrite: Boolean(activeThreadId && !activeThreadId.startsWith("disk_")),
      });
      closeModal();
      if (!res.ok) {
        resolve({ ok: false, message: res.error?.message ?? tr("memory.addFail") });
        return;
      }
      resolve({
        ok: true,
        message: tr("memory.addedTo", {
          scope:
            res.data?.scope === "workspace"
              ? tr("memory.scopeWorkspace")
              : tr("memory.scopeGlobal"),
          path: res.data?.path ?? "",
        }),
      });
    };
    requestAnimationFrame(() => ta.focus());
  });
}

function getActiveCwd(): string | undefined {
  if (activeCwd) return activeCwd;
  return selectedProject()?.path;
}

async function showMemoryBrowser(
  focusSearch: boolean,
): Promise<{ ok: boolean; message?: string }> {
  const st = await inv<{
    enabled: boolean;
    fileCount: number;
    storePath: string;
    productNote?: string;
    message?: string;
    legacyEntryCount?: number;
  }>("memory.status");
  if (!st.ok) return { ok: false, message: st.error?.message };

  const cwd = getActiveCwd();

  openModal(
    tr("memory.browserTitle"),
    `<p class="prompt-dlg-hint">${esc(st.data?.productNote || tr("memory.productNote"))}</p>
     <p class="prompt-dlg-hint mono-sm">${esc(tr("memory.storePath", { path: st.data?.storePath ?? "—" }))}</p>
     <div class="memory-toolbar">
       <input id="mem-q" class="prompt-dlg-input" type="search"
         placeholder="${esc(tr("memory.searchPh"))}" autocomplete="off" />
       <button type="button" class="btn-dark sm" id="mem-add-btn">${esc(tr("memory.addBtn"))}</button>
     </div>
     <div class="memory-split">
       <div id="mem-list" class="memory-list"></div>
       <pre id="mem-preview" class="memory-preview mono-sm">${esc(tr("memory.previewEmpty"))}</pre>
     </div>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.close"))}</button>
     </div>`,
  );

  let selectedPath = "";

  const renderList = async () => {
    const q = ($("mem-q") as HTMLInputElement).value.trim();
    const browse = await inv<{
      files: Array<{
        id: string;
        source: string;
        label: string;
        path: string;
        deletable: boolean;
        current?: boolean;
        mtimeMs: number;
      }>;
      currentWorkspaceKey?: string;
    }>("memory.browse", { cwd });
    let files = browse.data?.files ?? [];
    if (q) {
      const ql = q.toLowerCase();
      files = files.filter(
        (f) =>
          f.label.toLowerCase().includes(ql) ||
          f.path.toLowerCase().includes(ql) ||
          f.source.toLowerCase().includes(ql),
      );
    }
    const el = $("mem-list");
    if (!files.length) {
      el.innerHTML = `<div class="item-sub">${esc(
        st.data?.enabled === false
          ? tr("memory.disabledHint")
          : tr("memory.empty"),
      )}</div>`;
      return;
    }
    const groups: Record<string, typeof files> = {
      global: [],
      workspace: [],
      session: [],
    };
    for (const f of files) {
      (groups[f.source] ?? groups.session).push(f);
    }
    const parts: string[] = [];
    for (const src of ["global", "workspace", "session"] as const) {
      const list = groups[src];
      if (!list.length) continue;
      parts.push(
        `<div class="memory-group-h">${esc(tr(`memory.group.${src}`))}</div>`,
      );
      for (const f of list.slice(0, 80)) {
        parts.push(`<div class="memory-row${f.path === selectedPath ? " on" : ""}${f.current ? " current" : ""}" data-mem-path="${esc(f.path)}" data-mem-id="${esc(f.id)}">
          <div class="memory-row-text" title="${esc(f.path)}">${esc(f.label)}${f.current ? ` · ${esc(tr("memory.currentWs"))}` : ""}</div>
          <div class="memory-row-meta">
            <span>${esc(formatAge(new Date(f.mtimeMs).toISOString()) || "")}</span>
            ${
              f.deletable
                ? `<button type="button" class="btn-ghost sm" data-mem-del-path="${esc(f.path)}">${esc(tr("common.delete"))}</button>`
                : ""
            }
          </div>
        </div>`);
      }
    }
    el.innerHTML = parts.join("");

    for (const row of Array.from(el.querySelectorAll("[data-mem-path]"))) {
      (row as HTMLElement).onclick = async (ev) => {
        if ((ev.target as HTMLElement).closest("[data-mem-del-path]")) return;
        selectedPath = (row as HTMLElement).dataset.memPath ?? "";
        await showPreview(selectedPath);
        void renderList();
      };
    }
    for (const btn of Array.from(el.querySelectorAll("[data-mem-del-path]"))) {
      (btn as HTMLElement).onclick = async (ev) => {
        ev.stopPropagation();
        const pth = (btn as HTMLElement).dataset.memDelPath ?? "";
        if (!pth) return;
        if (!window.confirm(tr("memory.deleteConfirm"))) return;
        await inv("memory.deletePath", { path: pth });
        if (selectedPath === pth) {
          selectedPath = "";
          $("mem-preview").textContent = tr("memory.previewEmpty");
        }
        await renderList();
        showToast(tr("memory.deleted"));
      };
    }
  };

  const showPreview = async (filePath: string) => {
    if (!filePath) return;
    const res = await inv<{ content: string; truncated: boolean }>(
      "memory.read",
      { path: filePath },
    );
    const pre = $("mem-preview");
    if (!res.ok) {
      pre.textContent = res.error?.message ?? tr("memory.readFail");
      return;
    }
    pre.textContent =
      (res.data?.content ?? "") +
      (res.data?.truncated ? `\n\n… (${tr("memory.truncated")})` : "");
  };

  $("mem-q").oninput = () => void renderList();
  $("mem-add-btn").onclick = async () => {
    closeModal();
    const r = await promptAddMemory();
    if (r.message) showToast(r.message, r.ok ? "info" : "error");
    if (r.ok && r.message !== tr("slash.cancelled")) {
      void showMemoryBrowser(false);
    }
  };
  $("prompt-dlg-cancel").onclick = () => closeModal();
  await renderList();
  if (focusSearch) {
    requestAnimationFrame(() => ($("mem-q") as HTMLInputElement).focus());
  }
  return { ok: true };
}

type SessionInfoRow = {
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
    usageCategories: Array<{ label: string; tokens: number; detail?: string }>;
  };
};

function formatSessionInfoLines(
  info: SessionInfoRow,
  extras?: { project?: string; effort?: string; perm?: string },
): string[] {
  const c = info.context;
  const model =
    info.modelDisplayName || info.model || tr("slash.none");
  const lines = [
    tr("status.sessionId", { id: info.sessionId }),
    extras?.project
      ? tr("status.project", { project: extras.project })
      : null,
    info.cwd ? tr("status.cwd", { cwd: info.cwd }) : null,
    info.agentName
      ? tr("status.agent", { name: info.agentName })
      : null,
    tr("status.model", { model }),
    info.resolvedModelId && info.resolvedModelId !== info.model
      ? tr("status.resolvedModel", { id: info.resolvedModelId })
      : null,
    info.showModelFingerprint && info.modelFingerprint
      ? tr("status.fingerprint", { fp: info.modelFingerprint })
      : null,
    extras?.effort ? tr("status.effort", { effort: extras.effort }) : null,
    extras?.perm ? tr("status.perm", { perm: extras.perm }) : null,
    info.apiBackend
      ? tr("status.backend", { backend: info.apiBackend })
      : null,
    tr("status.turns", {
      turns: info.turns,
      turnIndex: info.turnIndex,
    }),
    "",
    tr("status.contextHeader"),
    tr("status.contextUsed", {
      used: c.used.toLocaleString(),
      total: c.total.toLocaleString(),
      pct: c.usagePct || (c.total > 0 ? Math.round((c.used / c.total) * 100) : 0),
    }),
    tr("status.contextFree", { free: c.freeTokens.toLocaleString() }),
    tr("status.contextSystem", {
      tokens: c.systemPromptTokens.toLocaleString(),
    }),
    tr("status.contextTools", {
      count: c.toolDefinitionsCount,
      tokens: c.toolDefinitionsTokens.toLocaleString(),
    }),
    tr("status.contextMessages", {
      count: c.messageCount,
      tokens: c.messageTokens.toLocaleString(),
    }),
    tr("status.contextTurnsTools", {
      turns: c.turnCount,
      tools: c.toolCallCount,
      compact: c.compactionCount,
    }),
    tr("status.autoCompactAt", {
      pct: c.autoCompactThresholdPercent || 85,
    }),
  ].filter((x): x is string => x != null);

  if (c.usageCategories?.length) {
    lines.push("", tr("status.categoriesHeader"));
    for (const cat of c.usageCategories) {
      const detail = cat.detail ? ` (${cat.detail})` : "";
      lines.push(`  ${cat.label}${detail}: ${cat.tokens.toLocaleString()}`);
    }
  }
  return lines;
}

async function fetchSessionInfoForActive(): Promise<SessionInfoRow | null> {
  if (!activeSessionId && !activeThreadId) return null;
  const threadId = await ensureLiveThread();
  if (!threadId) return null;
  const res = await inv<SessionInfoRow>("threads.sessionInfo", { threadId });
  if (!res.ok || !res.data) return null;
  return res.data;
}


/** /rewind：列出可回退点并确认后执行（对齐 CLI slash 入口） */
async function rewindViaSlash(): Promise<{ ok: boolean; message?: string }> {
  if (turnActive) {
    return { ok: false, message: tr("chat.rewindWait") };
  }
  if (!activeSessionId) {
    return { ok: false, message: tr("chat.rewindNeedSession") };
  }
  const threadId = await ensureLiveThread();
  if (!threadId) {
    return { ok: false, message: tr("chat.rewindAttachFail2") };
  }
  const pts = await inv<{
    rewindPoints: Array<{
      promptIndex: number;
      promptPreview?: string;
      hasFileChanges?: boolean;
      numFileSnapshots?: number;
    }>;
  }>("threads.rewindPoints", { threadId });
  if (!pts.ok) {
    return {
      ok: false,
      message: pts.error?.message ?? tr("chat.rewindPreviewFail"),
    };
  }
  const list = pts.data?.rewindPoints ?? [];
  if (!list.length) {
    // 回退到 transcript 中最近一条用户消息
    const blocks = Array.from(
      document.querySelectorAll(".user-msg-block[data-prompt-index]"),
    ) as HTMLElement[];
    if (!blocks.length) {
      return { ok: false, message: tr("slash.rewindNone") };
    }
    const last = blocks[blocks.length - 1]!;
    const idx = Number(last.dataset.promptIndex);
    const preview =
      last.querySelector(".msg-user-text")?.textContent?.trim() ||
      tr("chat.rewindConfirmBodyEmpty");
    await rewindToUserPrompt(idx, preview);
    return { ok: true, message: tr("slash.rewindStarted") };
  }
  // 展示最近若干点，让用户选编号
  const recent = list.slice(-12).reverse();
  const lines = recent
    .map((p, i) => {
      const prev = (p.promptPreview || "").trim().replace(/\s+/g, " ");
      const short = prev.length > 48 ? prev.slice(0, 48) + "…" : prev || "(empty)";
      const files = p.hasFileChanges || (p.numFileSnapshots ?? 0) > 0 ? " 📎" : "";
      return `${i + 1}. #${p.promptIndex}${files}  ${short}`;
    })
    .join("\n");
  const pick = await promptText({
    title: tr("slash.rewindPickTitle"),
    hint: tr("slash.rewindPickHint"),
    defaultValue: "1",
    placeholder: "1",
  });
  if (pick == null) return { ok: true, message: tr("slash.cancelled") };
  const n = Number(String(pick).trim());
  if (!Number.isFinite(n) || n < 1 || n > recent.length) {
    return { ok: false, message: tr("slash.rewindBadPick") };
  }
  const chosen = recent[n - 1]!;
  const preview = (chosen.promptPreview || "").trim() || tr("chat.rewindConfirmBodyEmpty");
  // 也显示列表摘要在 toast 区（confirm 内已有正文）
  void lines;
  await rewindToUserPrompt(chosen.promptIndex, preview);
  return { ok: true, message: tr("slash.rewindStarted") };
}

/** 解析会话展示标题（列表 / toast） */
function threadDisplayTitle(t: ThreadRow | undefined, fallbackId?: string): string {
  if (t?.title?.trim()) return t.title.trim();
  const id = t?.sessionId || fallbackId || "";
  return id ? id.slice(0, 8) : tr("slash.forkDefaultTitle");
}

/** 父会话标题（用于「来自：xxx」） */
function parentThreadTitle(parentSessionId: string | undefined): string | null {
  if (!parentSessionId) return null;
  const p = threads.find((x) => x.sessionId === parentSessionId);
  return threadDisplayTitle(p, parentSessionId);
}

/**
 * 从指定会话派生（侧栏 ⋯ / slash 共用）。
 * confirm：侧栏入口会确认；slash 可跳过以保持快捷。
 */
async function forkSessionFrom(
  source: ThreadRow,
  opts?: { confirm?: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const cwd = source.cwd || activeCwd || selectedProject()?.path;
  if (!cwd) return { ok: false, message: tr("slash.forkNeedProject") };
  if (!source.sessionId) {
    return { ok: false, message: tr("slash.forkNeedSession") };
  }

  const baseTitle = threadDisplayTitle(source);
  if (opts?.confirm) {
    const ok = await confirmText({
      title: tr("session.forkConfirmTitle"),
      message: tr("session.forkConfirmMsg", { title: baseTitle }),
      okLabel: tr("session.forkConfirmOk"),
    });
    if (!ok) return { ok: false };
  }

  // 若正在该会话上跑 turn，先停
  if (
    turnActive &&
    (source.sessionId === activeSessionId || source.id === activeThreadId)
  ) {
    void cancelTurn();
  }

  const projectId = source.projectId || selectedProject()?.id;
  const forkTitle = tr("slash.forkTitle", { title: baseTitle }).slice(0, 48);
  closePlanPanelOnSessionChange();
  const res = await inv<{
    threadId: string;
    sessionId: string;
    cwd: string;
    historyCopied?: boolean;
    parentSessionId?: string;
  }>("threads.fork", {
    sourceSessionId: source.sessionId,
    cwd,
    projectId,
    title: forkTitle,
    model: source.model || modelLabel,
    effort: source.effort || effortLevel,
  });
  if (!res.ok) {
    return { ok: false, message: res.error?.message ?? tr("slash.forkFail") };
  }

  const row: ThreadRow = {
    id: res.data!.threadId,
    sessionId: res.data!.sessionId,
    title: forkTitle,
    cwd: res.data!.cwd,
    status: "idle",
    updatedAt: new Date().toISOString(),
    projectId,
    sessionKind: "fork",
    parentSessionId: res.data!.parentSessionId || source.sessionId,
    model: source.model || modelLabel,
    effort: source.effort || effortLevel,
  };
  if (!threads.some((t) => t.sessionId === row.sessionId)) {
    threads = [row, ...threads];
  }
  await openThread(row);
  await refreshProjectsAndThreads();
  const copied = res.data?.historyCopied
    ? tr("slash.forkOkCopied")
    : tr("slash.forkOkEmpty");
  return { ok: true, message: copied };
}

/** slash `/fork`：当前活动会话，不弹确认 */
async function forkActiveSession(): Promise<{ ok: boolean; message?: string }> {
  const p = selectedProject();
  const cwd = activeCwd || p?.path;
  if (!cwd) return { ok: false, message: tr("slash.forkNeedProject") };
  if (!activeSessionId) {
    return { ok: false, message: tr("slash.forkNeedSession") };
  }
  const source =
    threads.find((t) => t.sessionId === activeSessionId) ??
    ({
      id: activeThreadId || `disk_${activeSessionId}`,
      sessionId: activeSessionId,
      title: threadDisplayTitle(
        threads.find((t) => t.sessionId === activeSessionId),
        activeSessionId,
      ),
      cwd,
      status: "idle",
      projectId: p?.id,
      model: modelLabel,
      effort: effortLevel,
    } satisfies ThreadRow);
  return forkSessionFrom(source, { confirm: false });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 粘贴图片：
 * - 从资源管理器复制的文件可能带 path → 直接附件
 * - 截图 / 网页复制的图片通常只有内存 Blob、无 path → 落盘到 Desktop 临时目录再附件
 * 原先只认 path，所以「粘贴图片无效」。
 */
function bindImagePaste(): void {
  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items?.length && !e.clipboardData?.files?.length) return;

    const pathSet = new Set<string>();
    const blobs: File[] = [];
    const blobKeys = new Set<string>();

    const considerFile = (f: File | null) => {
      if (!f || !f.type.startsWith("image/")) return;
      const withPath = f as File & { path?: string };
      if (withPath.path) {
        pathSet.add(withPath.path);
        return;
      }
      if (f.size <= 0) return;
      // items + files 常是同一张图的两份 File，按 size|type|name 去重
      const key = `${f.size}|${f.type}|${f.name || "image"}`;
      if (blobKeys.has(key)) return;
      blobKeys.add(key);
      blobs.push(f);
    };

    // 优先 DataTransferItemList；有图时不要再扫 files，避免重复
    let fromItems = 0;
    for (const it of Array.from(items ?? [])) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        considerFile(it.getAsFile());
        fromItems++;
      }
    }
    if (fromItems === 0 && e.clipboardData?.files) {
      for (const f of Array.from(e.clipboardData.files)) {
        considerFile(f);
      }
    }

    if (!pathSet.size && !blobs.length) return;

    // 有图片要处理：阻止默认（避免把乱码/空内容塞进 textarea）
    e.preventDefault();
    e.stopPropagation();

    void (async () => {
      const paths: string[] = [...pathSet];
      const previewMap: Record<string, string> = {};
      for (const blob of blobs) {
        try {
          const buf = await blob.arrayBuffer();
          const base64 = arrayBufferToBase64(buf);
          const mime = blob.type || "image/png";
          const res = await inv<{ path: string; name: string }>(
            "files.writePasteImage",
            { base64, mime },
          );
          if (res.ok && res.data?.path) {
            if (!paths.includes(res.data.path)) {
              paths.push(res.data.path);
            }
            previewMap[res.data.path] = `data:${mime};base64,${base64}`;
          } else {
            showToast(res.error?.message ?? "图片落盘失败", "error");
          }
        } catch (err) {
          showToast(String(err), "error");
        }
      }
      if (!paths.length) {
        showToast("未能添加粘贴的图片", "error");
        return;
      }
      addAttachments(paths, { kind: "image", previewMap });
      showToast(
        paths.length === 1
          ? "已粘贴图片到附件"
          : `已粘贴 ${paths.length} 张图片到附件`,
      );
    })();
  };

  for (const id of ["composer-input", "chat-input", "focus-input"] as const) {
    document
      .getElementById(id)
      ?.addEventListener("paste", onPaste as EventListener, true);
  }
}

function bindSlashPalette(): void {
  slashPalette = new SlashPaletteController({
    getCommands: async () => {
      const path0 = selectedProject()?.path;
      const skills = await inv<
        Array<{ name: string; description?: string; scope?: string }>
      >("skills.list", { projectPath: path0 });
      const staticCmds = getStaticSlashCommands();
      const staticIds = new Set(staticCmds.map((c) => c.id.toLowerCase()));
      // 尝试刷新 live 广告（若已附着）
      await refreshAgentAvailableCommands();
      const acpCmds = agentAdvertisedCommands(agentAvailableCommands, staticIds);
      return [
        ...staticCmds,
        ...acpCmds,
        ...skillCommands(skills.data ?? []),
      ];
    },
    onRun: (cmd) => runSlashCommand(cmd),
    onMessage: (text, kind) => showToast(text, kind ?? "info"),
    onOpen: () => atFilePalette?.hide(),
  });
  for (const id of ["composer-input", "chat-input", "focus-input"] as const) {
    const ta = document.getElementById(id) as HTMLTextAreaElement | null;
    if (ta) slashPalette.attach(ta);
  }
  for (const id of ["btn-slash", "btn-slash-chat"] as const) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      atFilePalette?.hide();
      const welcome = !$("welcome").classList.contains("hidden");
      const ta = (
        welcome ? $("composer-input") : $("chat-input")
      ) as HTMLTextAreaElement;
      void slashPalette?.openFor(ta);
    });
  }
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
  for (const id of ["composer-input", "chat-input", "focus-input"] as const) {
    const ta = document.getElementById(id) as HTMLTextAreaElement | null;
    if (ta) atFilePalette.attach(ta);
  }
}

// ── 附件 / + 菜单 ─────────────────────────────────────────

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

function attachmentKind(filePath: string): "file" | "image" | "folder" {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = base.includes(".")
    ? base.slice(base.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return IMAGE_EXT.has(ext) ? "image" : "file";
}

function attachIcon(kind: ComposerAttachment["kind"]): string {
  if (kind === "image") return "🖼";
  if (kind === "folder") return "📁";
  return "📄";
}

function addAttachments(
  paths: string[],
  opts?: {
    kind?: ComposerAttachment["kind"];
    /** path → data URL，粘贴时直接带预览 */
    previewMap?: Record<string, string>;
  },
): void {
  for (const p of paths) {
    if (!p) continue;
    const abs = p.replace(/[/\\]+$/, "") || p;
    if (composerAttachments.some((a) => a.path === abs || a.path === p)) {
      continue;
    }
    const name = abs.split(/[/\\]/).pop() || abs;
    const kind = opts?.kind ?? attachmentKind(abs);
    const pathKey = kind === "folder" ? abs : p;
    composerAttachments.push({
      path: pathKey,
      name: kind === "folder" ? `${name}/` : name,
      kind,
      previewUrl: opts?.previewMap?.[pathKey] ?? opts?.previewMap?.[p] ?? opts?.previewMap?.[abs],
    });
  }
  renderAttachmentChips();
  void loadMissingImagePreviews();
}

function removeAttachment(path: string): void {
  composerAttachments = composerAttachments.filter((a) => a.path !== path);
  renderAttachmentChips();
}

function clearAttachments(): void {
  composerAttachments = [];
  renderAttachmentChips();
}

/** 无 previewUrl 的图片附件：Host 读成 data URL */
async function loadMissingImagePreviews(): Promise<void> {
  const need = composerAttachments.filter(
    (a) => a.kind === "image" && !a.previewUrl && a.path,
  );
  if (!need.length) return;
  let changed = false;
  await Promise.all(
    need.map(async (a) => {
      const res = await inv<{ dataUrl: string }>("files.readDataUrl", {
        path: a.path,
      });
      if (res.ok && res.data?.dataUrl) {
        a.previewUrl = res.data.dataUrl;
        changed = true;
      }
    }),
  );
  if (changed) renderAttachmentChips();
}

function openComposerImagePreview(a: ComposerAttachment): void {
  const src = a.previewUrl;
  if (!src) {
    void inv("system.openPath", { path: a.path });
    return;
  }
  openModal(
    a.name || "图片预览",
    `<div class="img-lightbox">
      <img class="img-lightbox-img" src="${src.replace(/"/g, "&quot;")}" alt="${esc(a.name)}" />
      <div class="img-lightbox-path mono">${esc(a.path)}</div>
    </div>`,
  );
}

function renderAttachmentChips(): void {
  for (const id of ["composer-attachments", "chat-attachments"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (!composerAttachments.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      continue;
    }
    el.classList.remove("hidden");
    el.innerHTML = composerAttachments
      .map((a) => {
        if (a.kind === "image") {
          const src = a.previewUrl
            ? a.previewUrl.replace(/"/g, "&quot;")
            : "";
          return `<button type="button" class="attach-thumb" data-path="${esc(a.path)}" title="${esc(a.name)} · 点击查看">
            ${
              src
                ? `<img class="attach-thumb-img" src="${src}" alt="${esc(a.name)}" draggable="false" />`
                : `<span class="attach-thumb-ph">${attachIcon("image")}</span>`
            }
            <span class="attach-chip-x" data-path="${esc(a.path)}" aria-label=tr("plug.remove")>×</span>
          </button>`;
        }
        return `<span class="attach-chip" data-path="${esc(a.path)}" title="${esc(a.path)}">
            <span class="attach-chip-ico">${attachIcon(a.kind)}</span>
            <span class="attach-chip-name">${esc(a.name)}</span>
            <button type="button" class="attach-chip-x" data-path="${esc(a.path)}" aria-label=tr("plug.remove")>×</button>
          </span>`;
      })
      .join("");

    for (const btn of Array.from(el.querySelectorAll(".attach-chip-x"))) {
      (btn as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeAttachment((btn as HTMLElement).dataset.path ?? "");
      };
    }
    for (const thumb of Array.from(el.querySelectorAll(".attach-thumb"))) {
      (thumb as HTMLElement).onclick = (e) => {
        if ((e.target as HTMLElement).closest(".attach-chip-x")) return;
        const p = (thumb as HTMLElement).dataset.path ?? "";
        const a = composerAttachments.find((x) => x.path === p);
        if (a) openComposerImagePreview(a);
      };
    }
  }
}

/** 用户可见消息 + 发给 agent 的完整内容（含附件上下文） */
function buildPromptWithAttachments(userText: string): {
  display: string;
  content: string;
} {
  const display = userText.trim();
  if (!composerAttachments.length) {
    return { display, content: display };
  }
  const block = composerAttachments
    .map((a) => {
      const label =
        a.kind === "image" ? "image" : a.kind === "folder" ? "folder" : "file";
      return `- ${label}: ${a.path}`;
    })
    .join("\n");
  const content = display
    ? `${display}\n\n[Attachments — include these paths in context; for folders, consider the directory tree]\n${block}`
    : `[Attachments — include these paths in context; for folders, consider the directory tree]\n${block}`;
  return { display: display || `（${composerAttachments.length} 个附件）`, content };
}

async function pickAndAddAttachments(): Promise<void> {
  const p = selectedProject();
  const res = await inv<{ paths: string[]; canceled?: boolean }>(
    "system.pickFiles",
    {
      title: "添加文件或图片到上下文",
      defaultPath: p?.path,
      multi: true,
    },
  );
  if (!res.ok || res.data?.canceled || !res.data?.paths?.length) return;
  addAttachments(res.data.paths);
  showToast(`已添加 ${res.data.paths.length} 个附件`);
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

/** /goal 或 +目标：不弹窗；立刻显示目标 chip，输入框写目标，发送后落条 */
function beginGoalCompose(prefill?: string): void {
  goalComposeActive = true;
  userOptedInGoal = true;
  setComposerPlaceholders(true);
  syncSessionModeChips();
  const ta = activeComposerInput();
  if (prefill != null) ta.value = prefill;
  requestAnimationFrame(() => {
    ta.focus();
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  });
  showToast(tr("slash.goalDesc"));
}

function formatGoalElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `· ${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `· ${m}m${r ? ` ${r}s` : ""}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `· ${h}h${rm ? ` ${rm}m` : ""}`;
}

function goalElapsedMsNow(): number {
  if (goalPaused) return goalElapsedFrozenMs;
  if (!goalStartedAt) return goalElapsedFrozenMs;
  return goalElapsedFrozenMs + (Date.now() - goalStartedAt);
}

function stopGoalElapsedTimer(): void {
  if (goalElapsedTimer) {
    clearInterval(goalElapsedTimer);
    goalElapsedTimer = null;
  }
}

function startGoalElapsedTimer(): void {
  stopGoalElapsedTimer();
  if (!currentGoalTitle() || goalPaused || goalCompleted) return;
  const tick = () => {
    const el = formatGoalElapsed(goalElapsedMsNow());
    for (const node of Array.from(document.querySelectorAll("[data-goal-elapsed]"))) {
      node.textContent = el;
    }
  };
  tick();
  goalElapsedTimer = setInterval(tick, 1000);
}

function stopGoalSyncTimer(): void {
  if (goalSyncTimer) {
    clearInterval(goalSyncTimer);
    goalSyncTimer = null;
  }
}

function ensureGoalSyncTimer(): void {
  if (goalSyncTimer) return;
  if (!currentGoalTitle() || goalCompleted) return;
  goalSyncTimer = setInterval(() => {
    if (!currentGoalTitle() || goalCompleted) {
      stopGoalSyncTimer();
      return;
    }
    void syncGoalFromAgent();
  }, 1500);
}

/** 从 agent updates.jsonl 回读 goal_updated（仅用户已开启目标模式时） */
async function syncGoalFromAgent(): Promise<void> {
  if (!activeSessionId) return;
  
  const res = await inv<{
    state?: { title?: string; status?: string } | null;
    agent?: {
      objective?: string;
      status?: string;
      lastEvent?: string;
      elapsedMs?: number;
      goalId?: string;
    } | null;
  }>("goals.sync", { sessionId: activeSessionId });
  if (!res.ok) return;
  const agent = res.data?.agent;
  if (agent?.status) {
    applyAgentGoalEvent({
      sessionId: activeSessionId,
      objective: agent.objective,
      status: agent.status,
      lastEvent: agent.lastEvent,
      elapsedMs: agent.elapsedMs,
    });
    return;
  }
  const st = res.data?.state;
  if (st?.status === "completed" && userOptedInGoal) {
    markGoalCompletedUi(st.title || currentGoalTitle() || "目标已完成");
  }
}

/**
 * 清掉目标 UI 内存态（不弹 toast）。
 * 用于：磁盘 cancelled/cleared、换会话、用户 clear。
 */
function resetGoalUiState(): void {
  pendingGoalTitle = null;
  activeGoalTitle = null;
  userOptedInGoal = false;
  goalPaused = false;
  goalStartedAt = null;
  goalElapsedFrozenMs = 0;
  goalCompleted = false;
  goalComposeActive = false;
  if (goalCompleteHideTimer) {
    clearTimeout(goalCompleteHideTimer);
    goalCompleteHideTimer = null;
  }
  stopGoalSyncTimer();
  stopGoalElapsedTimer();
  setComposerPlaceholders(false);
}

function renderGoalBanner(): void {
  const title = currentGoalTitle();
  const on = Boolean(title);
  for (const id of ["goal-banner-welcome", "goal-banner-chat"] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("hidden", !on);
    el.classList.toggle("is-paused", goalPaused && !goalCompleted);
    el.classList.toggle("is-completed", goalCompleted);
    const t = el.querySelector("[data-goal-title]");
    if (t) t.textContent = title ?? "";
    const kicker = el.querySelector(".goal-banner-kicker");
    if (kicker) {
      kicker.textContent = goalCompleted
        ? tr("goal.kickerDone")
        : goalPaused
          ? tr("goal.kickerPaused")
          : tr("goal.kicker");
    }
    const pauseBtn = el.querySelector("[data-goal-pause]") as HTMLElement | null;
    const resumeBtn = el.querySelector("[data-goal-resume]") as HTMLElement | null;
    pauseBtn?.classList.toggle("hidden", goalPaused || goalCompleted);
    resumeBtn?.classList.toggle("hidden", !goalPaused || goalCompleted);
  }
  // 冷加载 active：无 goalStartedAt 时只显示冻结耗时，不假装从 updatedAt 狂跳
  const canTick = on && !goalPaused && !goalCompleted && goalStartedAt != null;
  if (canTick) {
    startGoalElapsedTimer();
    ensureGoalSyncTimer();
  } else {
    stopGoalElapsedTimer();
    if (on && !goalCompleted) ensureGoalSyncTimer();
    else if (!on || goalCompleted) stopGoalSyncTimer();
    const el = formatGoalElapsed(goalElapsedMsNow());
    for (const node of Array.from(document.querySelectorAll("[data-goal-elapsed]"))) {
      // 无起点且冻结为 0：不显示 · 0s，避免「假运行」
      node.textContent =
        on && (goalStartedAt != null || goalElapsedFrozenMs > 0) ? el : "";
    }
  }
  syncSessionModeChips();
}

/** 向 agent 发送 CLI 同源斜杠（激活/暂停/恢复/清除 goal 模式） */
async function sendAgentGoalSlash(slashLine: string): Promise<boolean> {
  const line = slashLine.trim();
  if (!line.startsWith("/goal")) return false;
  try {
    const threadId = await ensureLiveThread();
    if (!threadId) return false;
    const res = await inv("turns.prompt", { threadId, content: line });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 应用 agent 运行时 goal_updated（同源状态机）
 * status: active | user_paused | complete | blocked | …
 *
 * 注意：complete 之后 agent 仍可能短暂推送 active（classifier 前），
 * 不可把已完成状态打回进行中。
 */

/** 父会话 subagent 进度：轻量 toast + 过程区提示（完整树可后续做侧栏） */
function handleSubagentUpdated(ev: {
  sessionId?: string;
  parentSessionId?: string;
  subagentId: string;
  phase: string;
  status: string;
  subagentType?: string;
  description?: string;
  error?: string;
  childSessionId?: string;
}): void {
  const parent = ev.parentSessionId || ev.sessionId;
  if (
    activeSessionId &&
    parent &&
    parent !== activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== activeSessionId
  ) {
    return;
  }
  // 侧栏树增量（与 Host subagents.json 投影对齐）
  sidePane?.applySubagentUpdate(ev);
  const short = (ev.subagentId || "").slice(0, 8);
  const kind = ev.subagentType || "subagent";
  if (ev.phase === "spawned") {
    showToast(
      tr("subagent.spawned", { type: kind, id: short }),
      "info",
    );
    return;
  }
  if (ev.phase === "finished") {
    const st = String(ev.status || "").toLowerCase();
    if (st === "failed" || st === "error") {
      showToast(
        ev.error ||
          tr("subagent.failed", { type: kind, id: short }),
        "error",
      );
    } else if (st === "cancelled" || st === "canceled") {
      showToast(tr("subagent.cancelled", { id: short }));
    } else {
      showToast(tr("subagent.completed", { type: kind, id: short }));
    }
  }
}


/** 后台任务 / monitor：过程区 + toast（对齐 CLI TaskCompleted / TaskBackgrounded） */
function handleTaskUpdated(ev: {
  sessionId?: string;
  taskId: string;
  phase: string;
  command?: string;
  description?: string;
  isMonitor?: boolean;
  success?: boolean;
  willWake?: boolean;
  exitCode?: number | null;
  signal?: string;
  durationMs?: number;
  eventText?: string;
  staleOnLoad?: boolean;
}): void {
  rememberTaskSnap(ev);
  if (
    activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== activeSessionId
  ) {
    return;
  }
  const short = (ev.taskId || "").slice(0, 8);
  const label =
    (ev.description || ev.command || "").trim() ||
    (ev.isMonitor ? "monitor" : "task");
  const kind = ev.isMonitor ? "monitor" : "task";

  if (ev.phase === "backgrounded") {
    const line = ev.isMonitor
      ? tr("task.monitorStarted", { desc: label, id: short })
      : tr("task.started", { cmd: label, id: short });
    appendProcessText(line);
    showToast(line, "info");
    return;
  }

  if (ev.phase === "monitor") {
    const text = (ev.eventText || "").trim();
    if (text) {
      appendProcessText(
        tr("task.monitorEvent", {
          desc: label,
          text: text.length > 200 ? text.slice(0, 200) + "…" : text,
        }),
      );
    }
    return;
  }

  if (ev.phase === "completed") {
    if (ev.staleOnLoad) {
      // 冷加载合成完成：只写过程区，不 toast
      appendProcessText(
        tr("task.staleOnLoad", { desc: label, id: short }),
      );
      return;
    }
    const ok = ev.success !== false;
    let line: string;
    if (ok) {
      line = tr("task.completed", { desc: label, id: short });
      if (ev.willWake) {
        line += " · " + tr("task.willWake");
      }
      appendProcessText(line);
      showToast(line, "info");
    } else {
      const detail =
        ev.signal ||
        (ev.exitCode != null ? `exit ${ev.exitCode}` : "") ||
        "";
      line = tr("task.failed", {
        desc: label,
        id: short,
        detail: detail || "error",
      });
      appendProcessText(line);
      showToast(line, "error");
    }
  }
}

function applyAgentGoalEvent(ev: {
  sessionId?: string;
  objective?: string;
  status: string;
  elapsedMs?: number;
  message?: string;
  lastEvent?: string;
}): void {
  // session 尚未绑定时也接受（刚 create）；仅在「两边都有且不一致」时丢弃
  if (
    activeSessionId &&
    ev.sessionId &&
    ev.sessionId !== activeSessionId
  ) {
    return;
  }
  const st = String(ev.status ?? "").toLowerCase().trim();
  const last = String(ev.lastEvent ?? "").toLowerCase();
  const isComplete =
    st === "complete" ||
    st === "completed" ||
    last === "goal_completed" ||
    last.includes("completed");
  // CLI：cleared / cancelled / canceled 均为无目标终态
  const isCleared =
    st === "cancelled" ||
    st === "canceled" ||
    st === "cleared" ||
    last === "goal_cleared" ||
    last === "goal_cancelled";

  // 终态 cleared：先于 opt-in / title 写入，避免空 objective 被当成 "Goal" 进行中
  if (isCleared) {
    const had = Boolean(currentGoalTitle() || userOptedInGoal);
    resetGoalUiState();
    renderGoalBanner();
    // 磁盘同步清理，防止下次 open 再误显
    if (activeSessionId) {
      void inv("goals.clear", { sessionId: activeSessionId });
    }
    // 仅用户可见的取消才 toast；冷加载 sync 的 cleared 静默
    if (had && (st === "cancelled" || st === "canceled") && last) {
      showToast(tr("goal.cancelledToast"));
    }
    return;
  }

  // agent 首启 goal：自动 opt-in（与 Host goal.json 投影对齐）
  if (!userOptedInGoal) {
    const meaningful =
      Boolean((ev.objective ?? "").trim()) ||
      isComplete ||
      st === "active" ||
      st === "user_paused" ||
      st === "paused" ||
      st === "blocked" ||
      last.startsWith("goal_");
    if (!meaningful && !currentGoalTitle() && !goalComposeActive) {
      return;
    }
    userOptedInGoal = true;
  }

  const title = (ev.objective ?? "").trim() || currentGoalTitle();
  if (title) {
    activeGoalTitle = title;
    pendingGoalTitle = null;
  }
  goalComposeActive = false;
  setComposerPlaceholders(false);

  if (typeof ev.elapsedMs === "number" && ev.elapsedMs >= 0) {
    goalElapsedFrozenMs = ev.elapsedMs;
  }

  if (isComplete) {
    markGoalCompletedUi(ev.message?.trim() || title || tr("goal.completedToast"));
    return;
  }

  // 已展示完成态时，忽略滞后的 active 事件
  if (goalCompleted && (st === "active" || st === "" || last === "goal_created")) {
    return;
  }

  goalCompleted = false;
  if (goalCompleteHideTimer) {
    clearTimeout(goalCompleteHideTimer);
    goalCompleteHideTimer = null;
  }

  if (st === "user_paused" || st === "paused") {
    if (!goalPaused) {
      if (goalStartedAt) {
        goalElapsedFrozenMs = goalElapsedMsNow();
      }
      goalStartedAt = null;
    }
    goalPaused = true;
  } else if (st === "blocked") {
    goalPaused = true;
    goalStartedAt = null;
    showToast(ev.message?.trim() || tr("goal.blocked"), "error");
  } else {
    // active 等 — 仅 live 事件启动 wall-clock；有 elapsed_ms 时先冻结再续跑
    if (goalPaused) {
      goalStartedAt = Date.now();
    } else if (!goalStartedAt) {
      // 有 agent 耗时：从「现在」续跑，冻结部分已记入 goalElapsedFrozenMs
      goalStartedAt = Date.now();
    }
    goalPaused = false;
  }
  renderGoalBanner();
}

function markGoalCompletedUi(message: string): void {
  if (goalCompleted) {
    // 幂等：已展示完成条则只刷新文案
    renderGoalBanner();
    return;
  }
  if (!activeGoalTitle && !pendingGoalTitle) {
    activeGoalTitle = message || tr("composer.goal");
  }
  goalCompleted = true;
  goalPaused = false;
  goalStartedAt = null;
  goalComposeActive = false;
  stopGoalSyncTimer();
  setComposerPlaceholders(false);
  renderGoalBanner();
  showToast(message || tr("goal.completedToast"));
  if (goalCompleteHideTimer) clearTimeout(goalCompleteHideTimer);
  goalCompleteHideTimer = setTimeout(() => {
    resetGoalUiState();
    renderGoalBanner();
  }, 8000);
}

async function pauseGoal(opts?: { fromStop?: boolean }): Promise<void> {
  if (!currentGoalTitle() || goalPaused || goalCompleted) return;
  // Desktop 磁盘态为权威；冷会话 agent tracker 可能为 None
  goalElapsedFrozenMs = goalElapsedMsNow();
  goalStartedAt = null;
  goalPaused = true;
  if (activeSessionId) {
    await inv("goals.setStatus", {
      sessionId: activeSessionId,
      status: "paused",
    });
  }
  renderGoalBanner();
  showToast(
    opts?.fromStop ? tr("goal.pausedStop") : tr("goal.pausedToast"),
  );
  // 已 attach 时尽量通知 agent；失败不回滚 UI（避免 No goal is currently set 误伤）
  if (activeThreadId && !activeThreadId.startsWith("disk_")) {
    void sendAgentGoalSlash("/goal pause");
  }
}

async function resumeGoal(): Promise<void> {
  if (!currentGoalTitle() || !goalPaused) return;
  goalPaused = false;
  goalCompleted = false;
  goalStartedAt = Date.now();
  if (activeSessionId) {
    await inv("goals.setStatus", {
      sessionId: activeSessionId,
      status: "active",
    });
  }
  renderGoalBanner();
  showToast(tr("goal.resumedToast"));
  // resume 需要 agent 真恢复编排：尽量 attach 后发送
  void sendAgentGoalSlash("/goal resume");
}

function bindGoalBanner(): void {
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-goal-act]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.goalAct;
    if (act === "edit") {
      beginGoalCompose(currentGoalTitle() ?? "");
    }
    if (act === "pause") {
      void pauseGoal();
    }
    if (act === "resume") {
      void resumeGoal();
    }
    if (act === "clear") {
      void runGoalCommand("clear").then((r) => {
        if (r.message) showToast(r.message, r.ok ? "info" : "error");
      });
    }
  });
}

/**
 * 解析输入中的 goal：
 * - goalComposeActive 时整段文本为目标
 * - `/goal 内容` 或单独 `/goal`
 */
function parseGoalInput(raw: string): {
  /** 纯 `/goal` 无正文 → 进入 compose，不发送 */
  enterComposeOnly: boolean;
  /** 解析出的目标标题 */
  goalTitle: string | null;
  /** 去掉 /goal 前缀后的发送正文 */
  message: string;
} {
  const text = raw.trim();
  const m = text.match(/^\/goal(?:\s+([\s\S]+))?$/i);
  if (m) {
    const body = (m[1] ?? "").trim();
    if (!body) return { enterComposeOnly: true, goalTitle: null, message: "" };
    const parsed = parseGoalBudget(body);
    if (parsed.budget != null) goalTokenBudget = parsed.budget;
    return {
      enterComposeOnly: false,
      goalTitle: parsed.objective,
      message: parsed.objective,
    };
  }
  if (goalComposeActive && text) {
    const parsed = parseGoalBudget(text);
    if (parsed.budget != null) goalTokenBudget = parsed.budget;
    return {
      enterComposeOnly: false,
      goalTitle: parsed.objective,
      message: parsed.objective,
    };
  }
  return { enterComposeOnly: false, goalTitle: null, message: text };
}

async function applyGoalTitle(title: string): Promise<{ ok: boolean; message?: string }> {
  const parsed = parseGoalBudget(title.trim());
  const t = parsed.objective;
  if (parsed.budget != null) goalTokenBudget = parsed.budget;
  if (!t) return { ok: false, message: tr("goal.emptyTitle") };
  goalComposeActive = false;
  userOptedInGoal = true;
  setComposerPlaceholders(false);
  pendingGoalTitle = t;
  activeGoalTitle = t;
  goalPaused = false;
  goalCompleted = false;
  goalElapsedFrozenMs = 0;
  goalStartedAt = Date.now();
  if (goalCompleteHideTimer) {
    clearTimeout(goalCompleteHideTimer);
    goalCompleteHideTimer = null;
  }
  if (activeSessionId) {
    const r = await inv("goals.set", {
      sessionId: activeSessionId,
      title: t,
      status: "active",
    });
    if (!r.ok) {
      renderGoalBanner();
      return { ok: false, message: r.error?.message ?? tr("goal.writeFail") };
    }
    pendingGoalTitle = null;
  }
  renderGoalBanner();
  return { ok: true };
}

/** 发给 agent 的正文：新建目标用 CLI 同源 `/goal …`，避免仅 prompt 备注导致 Goal is not Active */
function agentContentForSend(
  userContent: string,
  goalJustSet: string | null,
): string {
  if (goalJustSet) {
    const budget =
      goalTokenBudget != null && goalTokenBudget > 0
        ? ` --budget ${goalTokenBudget}`
        : "";
    return `/goal ${goalJustSet}${budget}`;
  }
  return userContent;
}

/**
 * 解析目标正文与 `--budget N`（对齐 CLI parse_goal_budget）
 */
function parseGoalBudget(body: string): {
  objective: string;
  budget: number | null;
} {
  const m = body.match(/^(.*?)\s+--budget\s+(\d+)\s*$/i);
  if (m) {
    const n = Number(m[2]);
    if (Number.isFinite(n) && n > 0) {
      return { objective: m[1].trim(), budget: Math.floor(n) };
    }
  }
  return { objective: body.trim(), budget: null };
}

async function runGoalCommand(
  sub: "set" | "status" | "clear" | "pause" | "resume" | "budget",
): Promise<{ ok: boolean; message?: string }> {
  if (sub === "status") {
    const t = currentGoalTitle();
    if (!t) return { ok: true, message: tr("goal.noneActive") };
    const budget =
      goalTokenBudget != null
        ? tr("goal.budgetLine", { n: String(goalTokenBudget) })
        : "";
    const st = goalPaused
      ? tr("goal.kickerPaused")
      : goalCompleted
        ? tr("goal.kickerDone")
        : tr("goal.kicker");
    return {
      ok: true,
      message: `${st}：${t}${budget ? ` · ${budget}` : ""}`,
    };
  }
  if (sub === "pause") {
    await pauseGoal();
    return { ok: true, message: tr("goal.pausedToast") };
  }
  if (sub === "resume") {
    await resumeGoal();
    return { ok: true, message: tr("goal.resumedToast") };
  }
  if (sub === "budget") {
    return promptGoalBudget();
  }
  if (sub === "clear") {
    goalTokenBudget = null;
    resetGoalUiState();
    if (activeSessionId) {
      await inv("goals.clear", { sessionId: activeSessionId });
    }
    renderGoalBanner();
    // 同源：通知 agent 清除（已 attach 时）
    if (activeThreadId && !activeThreadId.startsWith("disk_")) {
      void sendAgentGoalSlash("/goal clear");
    }
    return { ok: true, message: tr("goal.cleared") };
  }
  // set：不弹窗，聚焦输入框写目标
  beginGoalCompose();
  return { ok: true };
}

async function promptGoalBudget(): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const cur = goalTokenBudget != null ? String(goalTokenBudget) : "";
    openModal(
      tr("slash.goalBudget"),
      `<p class="prompt-dlg-hint">${esc(tr("slash.goalBudgetHint"))}</p>
       <input id="goal-budget-input" class="prompt-dlg-input" type="number" min="1" step="1000"
         value="${esc(cur)}" placeholder="${esc(tr("slash.goalBudgetPh"))}" />
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
         <button type="button" class="btn-ghost" id="goal-budget-clear">${esc(tr("slash.goalBudgetClear"))}</button>
         <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(tr("common.ok"))}</button>
       </div>`,
    );
    $("prompt-dlg-cancel").onclick = () => {
      closeModal();
      resolve({ ok: true, message: tr("slash.cancelled") });
    };
    $("goal-budget-clear").onclick = () => {
      goalTokenBudget = null;
      closeModal();
      resolve({ ok: true, message: tr("slash.goalBudgetCleared") });
    };
    $("prompt-dlg-ok").onclick = () => {
      const raw = ($("goal-budget-input") as HTMLInputElement).value.trim();
      if (!raw) {
        goalTokenBudget = null;
        closeModal();
        resolve({ ok: true, message: tr("slash.goalBudgetCleared") });
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        showToast(tr("slash.goalBudgetInvalid"), "error");
        return;
      }
      goalTokenBudget = Math.floor(n);
      closeModal();
      // 已有进行中目标时，通过 /goal 再设一遍带 budget（agent 侧）
      const t = currentGoalTitle();
      if (t && !goalCompleted) {
        void sendAgentGoalSlash(`/goal ${t} --budget ${goalTokenBudget}`);
      }
      resolve({
        ok: true,
        message: tr("slash.goalBudgetSet", { n: String(goalTokenBudget) }),
      });
    };
    requestAnimationFrame(() =>
      ($("goal-budget-input") as HTMLInputElement).focus(),
    );
  });
}

async function persistPendingGoal(): Promise<void> {
  if (!pendingGoalTitle || !activeSessionId) return;
  const r = await inv("goals.set", {
    sessionId: activeSessionId,
    title: pendingGoalTitle,
  });
  if (r.ok) {
    userOptedInGoal = true;
    activeGoalTitle = pendingGoalTitle;
    pendingGoalTitle = null;
    if (!goalStartedAt) goalStartedAt = Date.now();
    renderGoalBanner();
  }
}

async function refreshGoalChipFromSession(): Promise<void> {
  if (!activeSessionId) {
    if (!pendingGoalTitle && !goalCompleted && !goalComposeActive) {
      resetGoalUiState();
    }
    renderGoalBanner();
    return;
  }
  const g = await inv<{
    title?: string;
    status?: string;
    updatedAt?: string;
  } | null>("goals.get", {
    sessionId: activeSessionId,
  });
  if (g.ok && g.data?.title) {
    const st = String(g.data.status ?? "active").toLowerCase();
    // cancelled / cleared：终态，不展示目标栏（修复旧会话假「进行中」）
    if (st === "cancelled" || st === "canceled" || st === "cleared") {
      resetGoalUiState();
      // 顺带清脏 goal.json，避免反复误显
      void inv("goals.clear", { sessionId: activeSessionId });
      renderGoalBanner();
      // 仍扫一次 agent log，兜底其它状态
      void syncGoalFromAgent();
      return;
    }
    // 磁盘已有目标 = 用户曾主动设置（或历史会话）
    userOptedInGoal = true;
    // 已展示完成态时，不要被滞后的 active 磁盘状态打回
    if (goalCompleted && st !== "completed") {
      renderGoalBanner();
      return;
    }
    activeGoalTitle = g.data.title;
    if (st === "completed") {
      markGoalCompletedUi(g.data.title);
      return;
    }
    goalPaused = st === "paused" || st === "blocked";
    goalCompleted = false;
    if (goalPaused) {
      goalStartedAt = null;
      // 冷加载暂停：不伪造 wall-clock
    } else {
      // 冷加载 active：不要用 updatedAt 当起点（否则显示「已跑 N 天」）
      // 等 live goal_updated / 用户 resume 再启动计时
      goalStartedAt = null;
      goalElapsedFrozenMs = 0;
    }
  } else if (!pendingGoalTitle && !goalCompleted && !goalComposeActive) {
    resetGoalUiState();
  }
  renderGoalBanner();
  // 打开会话后从 updates.jsonl 校准（cleared 会清 UI）
  void syncGoalFromAgent();
}

/** 从 tool.completed raw 兜底识别 update_goal 完成 */
function maybeGoalFromToolRaw(name?: string, raw?: unknown): void {
  // 未开启目标模式时忽略 agent 的 update_goal 工具
  if (!userOptedInGoal && !currentGoalTitle()) return;
  if (!raw || typeof raw !== "object") return;
  const u = raw as Record<string, unknown>;
  const title = String(u.title ?? name ?? "");
  const meta = u._meta as { "x.ai/tool"?: { name?: string } } | undefined;
  const toolName = meta?.["x.ai/tool"]?.name ?? title;
  const rawIn = (u.rawInput ?? {}) as Record<string, unknown>;
  const rawOut = (u.rawOutput ?? {}) as Record<string, unknown>;
  const isGoal =
    toolName === "update_goal" ||
    title === "update_goal" ||
    title.startsWith("Goal:") ||
    rawOut.type === "UpdateGoal";
  if (!isGoal) return;

  // 终态 success 且非 classifier 排队 → 完成；排队则等 goal_updated
  if (rawOut.type === "UpdateGoal" && rawOut.success === true) {
    const summary = String(rawOut.summary ?? "").toLowerCase();
    if (
      summary.includes("queued") ||
      summary.includes("pending") ||
      summary.includes("classifier")
    ) {
      showToast("目标完成确认中…");
      // 加速轮询 classifier 写入的 goal_updated complete
      ensureGoalSyncTimer();
      void syncGoalFromAgent();
      return;
    }
  }
  if (
    (rawIn.completed === true ||
      title.toLowerCase().includes("marking complete")) &&
    u.status === "completed"
  ) {
    // 若仍无 goal_updated complete，先乐观完成；随后 complete 事件幂等
    if (!goalCompleted) {
      markGoalCompletedUi(
        typeof rawIn.message === "string" ? rawIn.message : "目标已完成",
      );
    }
  }
}

function hidePlusMenu(): void {
  document.getElementById("plus-menu")?.classList.add("hidden");
}

function showPlusMenu(anchor: HTMLElement): void {
  const menu = $("plus-menu");
  const r = anchor.getBoundingClientRect();
  menu.classList.remove("hidden");
  const mw = menu.offsetWidth || 220;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  // 优先显示在按钮上方（对齐 Codex 浮层）
  const mh = menu.offsetHeight || 160;
  if (r.top > mh + 12) {
    menu.style.top = `${r.top - mh - 6}px`;
  } else {
    menu.style.top = `${r.bottom + 6}px`;
  }
}

function bindPlusMenu(): void {
  for (const id of ["btn-attach", "btn-attach-chat", "btn-focus-attach"] as const) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $("plus-menu");
      if (!menu.classList.contains("hidden") && menu.dataset.anchor === id) {
        hidePlusMenu();
        return;
      }
      menu.dataset.anchor = id;
      showPlusMenu(btn as HTMLElement);
    });
  }
  $("plus-menu").onclick = (e) => {
    const t = (e.target as HTMLElement).closest("[data-plus]") as HTMLElement | null;
    if (!t) return;
    const act = t.dataset.plus;
    hidePlusMenu();
    if (act === "files") void pickAndAddAttachments();
    if (act === "plan") {
      void runSlashCommand({
        id: "plan",
        title: tr("plan.modeChip"),
        description: "",
        action: { kind: "set-perm", mode: "plan" },
      }).then((r) => {
        if (r.message) showToast(r.message, r.ok ? "info" : "error");
      });
    }
    if (act === "goal") {
      void runGoalCommand("set");
    }
  };
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("#plus-menu, #btn-attach, #btn-attach-chat, #btn-focus-attach")) {
      hidePlusMenu();
    }
  });
}

// ── Sidebar ────────────────────────────────────────────────

function hideThreadMenu(): void {
  document.getElementById("thread-ctx-menu")?.remove();
}

function showThreadMenu(
  anchor: HTMLElement,
  t: ThreadRow,
  mode: "active" | "archived",
): void {
  hideThreadMenu();
  const menu = document.createElement("div");
  menu.id = "thread-ctx-menu";
  menu.className = "thread-ctx-menu";
  menu.setAttribute("role", "menu");

  const addItem = (label: string, danger: boolean, onClick: () => void) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `thread-ctx-item${danger ? " danger" : ""}`;
    item.textContent = label;
    item.onclick = (e) => {
      e.stopPropagation();
      hideThreadMenu();
      onClick();
    };
    menu.appendChild(item);
  };

  addItem(tr("session.menuRename"), false, () => {
    void renameThread(t);
  });
  addItem(tr("session.menuExportClipboard"), false, () => {
    void (async () => {
      const r = await exportActiveSession({
        destination: "clipboard",
        threadId: t.id,
      });
      if (r.message) showToast(r.message, r.ok ? "info" : "error");
    })();
  });
  addItem(tr("session.menuExportFile"), false, () => {
    void (async () => {
      const r = await exportActiveSession({
        destination: "file",
        threadId: t.id,
      });
      if (r.message) showToast(r.message, r.ok ? "info" : "error");
    })();
  });
  if (mode === "active") {
    addItem(tr("session.menuFork"), false, () => {
      void (async () => {
        const r = await forkSessionFrom(t, { confirm: true });
        if (r.message) showToast(r.message, r.ok ? "info" : "error");
      })();
    });
    const parentId = t.parentSessionId;
    if (parentId) {
      addItem(tr("session.menuOpenParent"), false, () => {
        const parent = threads.find((x) => x.sessionId === parentId);
        if (!parent) {
          showToast(tr("session.parentMissing"), "error");
          return;
        }
        selectedProjectId = parent.projectId || projectIdOfThread(parent) || selectedProjectId;
        if (selectedProjectId) expandedProjectIds.add(selectedProjectId);
        void openThread(parent);
      });
    }
    addItem(tr("session.menuArchive"), false, () => {
      void archiveThread(t, true);
    });
    addItem(tr("session.menuDelete"), true, () => {
      void deleteThread(t);
    });
  } else {
    addItem(tr("session.menuRestore"), false, () => {
      void archiveThread(t, false);
    });
    addItem(tr("session.menuDelete"), true, () => {
      void deleteThread(t);
    });
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = 160;
  let left = rect.right - mw;
  let top = rect.bottom + 4;
  if (left < 8) left = 8;
  if (top + 160 > window.innerHeight) top = Math.max(8, rect.top - 160);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.minWidth = `${mw}px`;

  const onDoc = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      hideThreadMenu();
      document.removeEventListener("mousedown", onDoc, true);
    }
  };
  window.setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
  }, 0);
}

/** 当前打开的会话是否就是 t */
function isThreadOpen(t: ThreadRow): boolean {
  return (
    t.id === activeThreadId ||
    (!!activeSessionId && t.sessionId === activeSessionId)
  );
}

/** 若归档/删除的是当前会话，退回欢迎页 */
function leaveThreadIfOpen(t: ThreadRow): void {
  if (!isThreadOpen(t)) return;
  endTurn();
  closePlanPanelOnSessionChange();
  activeThreadId = null;
  activeSessionId = null;
  setActiveCwd(null);
  clearTranscript();
  showWelcome(true);
  setWelcomeTitle();
  applyDefaultToChip();
  stopContextPolling();
  lastContextUsage = null;
  syncContextLabels();
}

async function archiveThread(t: ThreadRow, archived: boolean): Promise<void> {
  const res = await inv<ThreadRow>("threads.archive", {
    threadId: t.id,
    archived,
  });
  if (!res.ok) {
    showToast(res.error?.message ?? (archived ? "归档失败" : "恢复失败"), "error");
    return;
  }
  if (archived) {
    leaveThreadIfOpen(t);
    if (t.projectId) expandedArchiveIds.add(t.projectId);
    showToast("已收进归档");
  } else {
    showToast("已恢复到项目列表");
  }
  await refreshProjectsAndThreads();
}

async function deleteThread(t: ThreadRow): Promise<void> {
  const title = t.title || t.sessionId.slice(0, 8);
  const ok = await confirmText({
    title: tr("session.deleteTitle"),
    message: tr("archive.deleteConfirm", { title }),
    okLabel: tr("common.delete"),
  });
  if (!ok) return;
  const res = await inv<{ deleted: true; sessionId: string }>("threads.delete", {
    threadId: t.id,
  });
  if (!res.ok) {
    showToast(res.error?.message ?? tr("session.deleteFail"), "error");
    return;
  }
  leaveThreadIfOpen(t);
  showToast(tr("archive.deleted"));
  await refreshProjectsAndThreads();
}

function projectIdOfThread(t: ThreadRow): string | undefined {
  return t.projectId;
}

/** 侧栏会话树节点（fork 子会话挂在父会话下） */
type ThreadTreeNode = {
  thread: ThreadRow;
  children: ThreadTreeNode[];
};

function threadUpdatedAt(t: ThreadRow): string {
  return t.updatedAt ?? "";
}

function subtreeMaxUpdated(node: ThreadTreeNode): string {
  let max = threadUpdatedAt(node.thread);
  for (const c of node.children) {
    const m = subtreeMaxUpdated(c);
    if (m > max) max = m;
  }
  return max;
}

/**
 * 将扁平会话列表建成森林：有 parent 且父在同一列表内 → 子节点；否则为根。
 * 父不在列表 / 成环时抬升为根，避免丢会话。
 */
function buildThreadForest(list: ThreadRow[]): ThreadTreeNode[] {
  const byId = new Map(list.map((t) => [t.sessionId, t] as const));
  const childIds = new Set<string>();
  const childrenOf = new Map<string, ThreadRow[]>();

  const wouldCycle = (childId: string, parentId: string): boolean => {
    let cur: string | undefined = parentId;
    const seen = new Set<string>();
    while (cur) {
      if (cur === childId) return true;
      if (seen.has(cur)) return true;
      seen.add(cur);
      const row = byId.get(cur);
      cur = row?.parentSessionId;
      if (cur && !byId.has(cur)) break;
    }
    return false;
  };

  for (const t of list) {
    const p = t.parentSessionId?.trim();
    if (
      p &&
      p !== t.sessionId &&
      byId.has(p) &&
      !wouldCycle(t.sessionId, p)
    ) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(t);
      childrenOf.set(p, arr);
      childIds.add(t.sessionId);
    }
  }

  const sortByUpdated = (a: ThreadRow, b: ThreadRow) =>
    threadUpdatedAt(b).localeCompare(threadUpdatedAt(a));

  const buildNode = (t: ThreadRow): ThreadTreeNode => {
    const kids = (childrenOf.get(t.sessionId) ?? [])
      .slice()
      .sort(sortByUpdated)
      .map(buildNode);
    return { thread: t, children: kids };
  };

  const roots = list
    .filter((t) => !childIds.has(t.sessionId))
    .map(buildNode)
    .sort((a, b) =>
      subtreeMaxUpdated(b).localeCompare(subtreeMaxUpdated(a)),
    );
  return roots;
}

function flattenThreadForest(
  forest: ThreadTreeNode[],
): Array<{ thread: ThreadRow; depth: number }> {
  const out: Array<{ thread: ThreadRow; depth: number }> = [];
  const walk = (node: ThreadTreeNode, depth: number) => {
    out.push({ thread: node.thread, depth });
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const n of forest) walk(n, 0);
  return out;
}

/** 预览：按「根会话」条数截断，子 fork 始终跟在父下 */
function visibleThreadForest(
  list: ThreadRow[],
  showAll: boolean,
  limit: number,
): { flat: Array<{ thread: ThreadRow; depth: number }>; rootCount: number } {
  const forest = buildThreadForest(list);
  const roots = showAll ? forest : forest.slice(0, limit);
  return { flat: flattenThreadForest(roots), rootCount: forest.length };
}

function makeThreadRow(
  t: ThreadRow,
  projectId: string,
  mode: "active" | "archived",
  depth = 0,
): HTMLElement {
  const row = document.createElement("div");
  const isActive = isThreadOpen(t);
  const isWorking =
    t.status === "working" || workingSessions.has(t.sessionId);
  const isFork =
    t.sessionKind === "fork" ||
    (!!t.parentSessionId && t.parentSessionId.length > 0);
  const depthClamped = Math.max(0, Math.min(depth, 6));
  row.className = `thread-item depth-${depthClamped}${isActive ? " active" : ""}${isWorking ? " working" : ""}${mode === "archived" ? " is-archived" : ""}${isFork ? " is-fork" : ""}`;
  row.dataset.sessionId = t.sessionId;
  row.dataset.depth = String(depthClamped);
  // 每层额外缩进 14px；归档夹基础左内边距更大
  if (depthClamped > 0) {
    const base = mode === "archived" ? 36 : 28;
    row.style.paddingLeft = `${base + depthClamped * 14}px`;
  }

  const main = document.createElement("button");
  main.type = "button";
  main.className = "thread-item-main";
  const spin = isWorking ? `<span class="thread-spin"></span>` : "";
  const titleText = esc(t.title || t.sessionId.slice(0, 8));
  // 已缩进挂在父下时不再重复「来自：」行，仅保留小标签
  const badge = isFork
    ? `<span class="thread-fork-badge" title="${esc(tr("session.forkBadgeTitle"))}">${esc(tr("session.forkBadge"))}</span>`
    : "";
  const nested = depthClamped > 0;
  const fromLabel =
    isFork && !nested ? parentThreadTitle(t.parentSessionId) : null;
  const fromHtml = fromLabel
    ? `<span class="thread-fork-from">${esc(tr("session.forkFrom", { title: fromLabel }))}</span>`
    : "";
  const nestMark =
    nested
      ? `<span class="thread-nest-mark" aria-hidden="true">└</span>`
      : "";
  main.innerHTML = `${spin}<span class="thread-item-text"><span class="thread-title-row">${nestMark}${badge}<span class="thread-title">${titleText}</span></span>${fromHtml}</span><span class="thread-age">${esc(formatAge(t.updatedAt))}</span>`;
  if (fromLabel) {
    main.title = tr("session.forkFrom", { title: fromLabel });
  } else if (nested && t.parentSessionId) {
    const pTitle = parentThreadTitle(t.parentSessionId);
    if (pTitle) main.title = tr("session.forkFrom", { title: pTitle });
  }
  main.onclick = (e) => {
    e.stopPropagation();
    hideThreadMenu();
    selectedProjectId = projectId;
    expandedProjectIds.add(projectId);
    void openThread(t);
  };

  const more = document.createElement("button");
  more.type = "button";
  more.className = "thread-act-btn";
  more.title = tr("side.more");
  more.setAttribute("aria-label", tr("side.more"));
  more.textContent = "⋯";
  more.onclick = (e) => {
    e.stopPropagation();
    showThreadMenu(more, t, mode);
  };

  row.appendChild(main);
  row.appendChild(more);
  return row;
}

function makeArchiveFolder(
  projectId: string,
  archivedThreads: ThreadRow[],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "project-archive";
  const open = expandedArchiveIds.has(projectId);

  const head = document.createElement("button");
  head.type = "button";
  head.className = `project-archive-head${open ? " is-open" : ""}`;
  head.setAttribute("aria-expanded", open ? "true" : "false");
  const count = archivedThreads.length;
  head.innerHTML = `<span class="archive-ico" aria-hidden="true">📦</span><span class="archive-label">归档</span>${count ? `<span class="archive-count">${count}</span>` : ""}<span class="proj-chev archive-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>`;
  head.onclick = (e) => {
    e.stopPropagation();
    if (expandedArchiveIds.has(projectId)) expandedArchiveIds.delete(projectId);
    else expandedArchiveIds.add(projectId);
    void refreshProjectsAndThreads();
  };
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "project-archive-body";
  if (!open) {
    body.hidden = true;
  } else if (!archivedThreads.length) {
    const empty = document.createElement("div");
    empty.className = "empty-threads archive-empty";
    empty.textContent = "暂无归档";
    body.appendChild(empty);
  } else {
    const { flat } = visibleThreadForest(archivedThreads, true, archivedThreads.length);
    for (const { thread, depth } of flat) {
      body.appendChild(makeThreadRow(thread, projectId, "archived", depth));
    }
  }
  wrap.appendChild(body);
  return wrap;
}

async function refreshProjectsAndThreads(): Promise<void> {
  const [pRes, tRes] = await Promise.all([
    inv<Project[]>("projects.list"),
    inv<ThreadRow[]>("threads.list"),
  ]);
  projects = pRes.data ?? [];
  threads = tRes.data ?? [];

  if (!projectChoiceTouched && !selectedProjectId && projects.length) {
    selectedProjectId = projects[0].id;
  }

  // Codex：项目可展开/收起；主列表默认 5 条；固定「归档」夹
  const list = $("project-list");
  list.innerHTML = "";
  hideThreadMenu();

  // 清理已删除项目的状态
  for (const id of [...expandedProjectIds]) {
    if (!projects.some((p) => p.id === id)) expandedProjectIds.delete(id);
  }
  for (const id of [...projectShowAllThreads]) {
    if (!projects.some((p) => p.id === id)) projectShowAllThreads.delete(id);
  }
  for (const id of [...expandedArchiveIds]) {
    if (!projects.some((p) => p.id === id)) expandedArchiveIds.delete(id);
  }

  // 仅首次渲染：默认展开当前选中 / 含活动会话 / 第一个有会话的项目
  if (!projectExpandInitialized && projects.length) {
    projectExpandInitialized = true;
    for (const p of projects) {
      const related = threadsForProject(p.id);
      const hasActive = related.some(
        (t) =>
          !t.archived &&
          (t.id === activeThreadId ||
            (!!activeSessionId && t.sessionId === activeSessionId)),
      );
      if (p.id === selectedProjectId || hasActive) {
        expandedProjectIds.add(p.id);
      }
    }
    if (expandedProjectIds.size === 0) {
      const firstWith = projects.find(
        (p) => threadsForProject(p.id).some((t) => !t.archived),
      );
      if (firstWith) expandedProjectIds.add(firstWith.id);
      else expandedProjectIds.add(projects[0].id);
    }
  }

  for (const p of projects) {
    const group = document.createElement("div");
    const isExpanded = expandedProjectIds.has(p.id);
    group.className = `project-group${isExpanded ? " is-expanded" : " is-collapsed"}`;
    group.dataset.projectId = p.id;

    const b = document.createElement("button");
    b.type = "button";
    b.className = `project-item${p.id === selectedProjectId ? " active" : ""}`;
    b.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    b.innerHTML =
      `<span class="proj-chev" aria-hidden="true">${isExpanded ? "▾" : "▸"}</span>` +
      `<span class="folder-ico">📁</span>` +
      `<span class="proj-title">${esc(p.title)}</span>` +
      `<span class="proj-remove" data-remove-project="${esc(p.id)}" title="从列表移除" aria-label="移除项目">×</span>`;
    b.onclick = (e) => {
      const rm = (e.target as HTMLElement).closest("[data-remove-project]") as HTMLElement | null;
      if (rm) {
        e.preventDefault();
        e.stopPropagation();
        void removeProjectFromList(p.id, p.title, p.path);
        return;
      }
      if (expandedProjectIds.has(p.id)) {
        expandedProjectIds.delete(p.id);
      } else {
        expandedProjectIds.add(p.id);
      }
      selectedProjectId = p.id;
      projectChoiceTouched = true;
      if (!activeThreadId && !activeSessionId) {
        setWelcomeTitle();
        showWelcome(true);
      }
      void refreshProjectsAndThreads();
    };
    group.appendChild(b);

    const related = threadsForProject(p.id);
    const activeList = related.filter((t) => !t.archived);
    const archivedList = related.filter((t) => t.archived);
    const threadBox = document.createElement("div");
    threadBox.className = "project-threads";
    if (!isExpanded) {
      threadBox.hidden = true;
    } else {
      // 归档夹置顶
      threadBox.appendChild(makeArchiveFolder(p.id, archivedList));
      if (!activeList.length) {
        const empty = document.createElement("div");
        empty.className = "empty-threads";
        empty.textContent = "暂无聊天";
        threadBox.appendChild(empty);
      } else {
        const showAll = projectShowAllThreads.has(p.id);
        // 按根会话截断预览；fork 子节点始终挂在父会话下
        const { flat, rootCount } = visibleThreadForest(
          activeList,
          showAll,
          THREADS_PREVIEW_LIMIT,
        );
        for (const { thread, depth } of flat) {
          threadBox.appendChild(makeThreadRow(thread, p.id, "active", depth));
        }
        if (rootCount > THREADS_PREVIEW_LIMIT) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "project-threads-more";
          if (showAll) {
            more.textContent = "收起";
            more.onclick = (e) => {
              e.stopPropagation();
              projectShowAllThreads.delete(p.id);
              void refreshProjectsAndThreads();
            };
          } else {
            const rest = rootCount - THREADS_PREVIEW_LIMIT;
            more.textContent = `展开更多（${rest}）`;
            more.onclick = (e) => {
              e.stopPropagation();
              projectShowAllThreads.add(p.id);
              expandedProjectIds.add(p.id);
              void refreshProjectsAndThreads();
            };
          }
          threadBox.appendChild(more);
        }
      }
    }
    group.appendChild(threadBox);
    list.appendChild(group);
  }
  setWelcomeTitle();
}


/** CLI `-c`：打开最近一次用户会话并加载历史（发送时再 attach） */
async function continueRecentSession(): Promise<void> {
  const res = await inv<{
    sessionId: string;
    cwd: string;
    title: string;
    threadId?: string;
  } | null>("threads.continueRecent");
  if (!res.ok) {
    showToast(res.error?.message ?? tr("nav.continueFail"), "error");
    return;
  }
  if (!res.data) {
    showToast(tr("nav.continueNone"));
    return;
  }
  const row = {
    id: res.data.threadId ?? `disk_${res.data.sessionId}`,
    sessionId: res.data.sessionId,
    title: res.data.title,
    cwd: res.data.cwd,
    status: "inactive" as const,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  // 若列表里已有更完整的 ThreadRow，优先用它
  const hit =
    threads.find((t) => t.sessionId === res.data!.sessionId) ??
    (row as ThreadRow);
  if (hit.projectId) {
    selectedProjectId = hit.projectId;
    expandedProjectIds.add(hit.projectId);
  } else {
    const byPath = projects.find((p) => {
      const cwd = hit.cwd.replace(/\\/g, "/").toLowerCase();
      const root = p.path.replace(/\\/g, "/").toLowerCase();
      return cwd === root || cwd.startsWith(root + "/");
    });
    if (byPath) {
      selectedProjectId = byPath.id;
      expandedProjectIds.add(byPath.id);
    }
  }
  await openThread(hit);
  showToast(tr("nav.continueOk", { title: hit.title || hit.sessionId.slice(0, 8) }));
}

async function openThread(t: ThreadRow): Promise<void> {
  // 加载 history 期间挂起直播事件，避免与磁盘回放叠双份
  suspendLiveTranscript = true;
  // 切换会话：丢弃本地 follow-up 队列（按会话语义，不跨会话）
  clearPromptQueue({ silent: true });
  endTurn(); // 切换会话时清理进行中 UI
  hideAgentCrashBanner();
  agentAvailableCommands = [];
  const sameSession =
    (!!activeSessionId && t.sessionId === activeSessionId) ||
    (!!activeThreadId && t.id === activeThreadId);
  if (!sameSession) {
    closePlanPanelOnSessionChange();
    // S17：换会话重置 prompt 历史，稍后从磁盘 seed
    clearPromptHistoryStore();
    goalTokenBudget = null;
    // 换会话先清上一会话 goal UI，再由 refresh 按磁盘恢复
    resetGoalUiState();
  }
  activeThreadId = t.id;
  activeSessionId = t.sessionId;
  setActiveCwd(t.cwd);
  sidePane?.onSessionChanged();
  // chip 跟随会话模型，不用全局默认盖住
  applyThreadToChip(t);
  startContextPolling();
  if (t.projectId) selectedProjectId = t.projectId;
  else {
    const hit = projects.find((p) => {
      const cwd = t.cwd.replace(/\\/g, "/").toLowerCase();
      const root = p.path.replace(/\\/g, "/").toLowerCase();
      return cwd === root || cwd.startsWith(root + "/");
    });
    if (hit) selectedProjectId = hit.id;
  }
  if (selectedProjectId) expandedProjectIds.add(selectedProjectId);
  showWelcome(false);
  clearTranscript();
  void refreshGoalChipFromSession();

  try {
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
    }>("history.load", { sessionId: t.sessionId });
    const userTexts: string[] = [];
    // S15：连贯回放 — user / thought / tool / assistant 同一时间线
    for (const e of hist.data?.entries ?? []) {
      endStreamBubble();
      const role = (e.role || "").toLowerCase();
      if (role === "user" || role === "human") {
        if (!e.text?.trim()) continue;
        const parsed = parseUserHistoryPayload(e.text);
        if (parsed.text || parsed.attachments.length) {
          // 历史条目通常无可靠时间戳，只显示复制按钮
          paintUserMessage(parsed.text, parsed.attachments, null);
          if (parsed.text.trim()) userTexts.push(parsed.text.trim());
        }
      } else if (role === "tool") {
        replayHistoryTool(e);
      } else if (
        role === "thought" ||
        role === "thinking" ||
        role === "reasoning"
      ) {
        if (e.text?.trim()) {
          // 历史思考并入过程块，与直播 thought.delta 一致
          appendProcessText(e.text.trim());
        }
      } else if (role === "system") {
        if (e.text?.trim()) appendLine(e.text, "system");
      } else if (role === "assistant" || role === "ai") {
        if (!e.text?.trim()) continue;
        appendLine(e.text, "assistant");
      }
      endStreamBubble();
    }
    // S17：从磁盘 user 消息 seed（最新在前）
    if (!sameSession || !promptHistory.length) {
      seedPromptHistoryFromUserTexts(userTexts);
    }
    // 与直播回合结束一致：过程块默认折叠（历史无精确耗时，不写 Worked for）
    if (processBlockEl?.isConnected) {
      processBlockEl.classList.add("collapsed");
      const caret = processBlockEl.querySelector(".process-caret");
      if (caret) caret.textContent = "▸";
      updateProcessHeader();
    }
    // P0-A：已加载历史 + 空闲说明（非 Working，非 system 噪声行）
    const n = hist.data?.entries?.length ?? 0;
    paintHistoryReplayDone(n);
    await refreshProjectsAndThreads();
  } finally {
    suspendLiveTranscript = false;
  }
}

/** 历史 tool 条目 → 与直播相同的过程块 + tool card */
function replayHistoryTool(e: {
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  text?: string;
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
  // 与直播路径相同：先 started 再 completed，共用 markTool*
  markToolStarted(name, id, rawIn);
  markToolCompleted(id, name, rawOut);
}

/** Disk session → attach live ACP so turns.prompt works. */
async function ensureLiveThread(): Promise<string | null> {
  if (!activeSessionId || !activeCwd) return null;
  if (activeThreadId && !activeThreadId.startsWith("disk_")) {
    return activeThreadId;
  }
  // R3：attach 期挂起直播，避免与已回放历史叠双份（Mode B 无 load live buffer）
  suspendLiveTranscript = true;
  try {
    const att = await inv<{ threadId: string }>("threads.attach", {
      sessionId: activeSessionId,
      cwd: activeCwd,
    });
    if (!att.ok || !att.data?.threadId) {
      appendLine(att.error?.message ?? tr("crash.attachFail"), "error");
      showAgentCrashBanner(att.error?.message);
      return null;
    }
    activeThreadId = att.data.threadId;
    hideAgentCrashBanner();
    // attach 后刷新 agent 广告命令
    void refreshAgentAvailableCommands().then(() => slashPalette?.invalidate());
    return activeThreadId;
  } finally {
    suspendLiveTranscript = false;
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
  const ok = window.confirm(
    `从列表移除项目「${title}」？\n\n不会删除磁盘上的文件夹：\n${projectPath}`,
  );
  if (!ok) return;
  const res = await inv("projects.remove", { id });
  if (!res.ok) {
    showToast(res.error?.message ?? "移除失败", "error");
    return;
  }
  expandedProjectIds.delete(id);
  projectShowAllThreads.delete(id);
  expandedArchiveIds.delete(id);
  if (selectedProjectId === id) {
    selectedProjectId = null;
    projectChoiceTouched = true;
    // 若当前会话属于该项目，仅清选中；会话仍可继续
  }
  await refreshProjectsAndThreads();
  if (!selectedProjectId && projects.length) {
    selectedProjectId = projects[0].id;
  }
  setWelcomeTitle();
  if (!activeThreadId && !activeSessionId) {
    showWelcome(true);
  }
  showToast(`已移除「${title}」`);
}

async function startNewChat(prompt?: string): Promise<void> {
  let p = selectedProject();
  let cwd: string;
  let projectId: string | undefined;
  if (p) {
    if (p.trust !== "trusted") {
      await inv("projects.update", { id: p.id, patch: { trust: "trusted" } });
    }
    cwd = p.path;
    projectId = p.id;
  } else {
    // 不使用项目：一次性选择工作目录（不写入项目列表）
    const picked = await inv<{ path: string | null; canceled?: boolean }>(
      "system.pickDirectory",
      { title: "选择工作目录（不添加为项目）" },
    );
    if (!picked.ok || picked.data?.canceled || !picked.data?.path) return;
    cwd = picked.data.path;
    projectId = undefined;
  }
  // 选定工作目录后再关计划栏（取消选目录时不关）
  closePlanPanelOnSessionChange();
  const raw =
    prompt ??
    ($("composer-input") as HTMLTextAreaElement).value.trim() ??
    ($("chat-input") as HTMLTextAreaElement).value.trim();
  // 欢迎页手输 /always-approve 等：本地执行，不建空会话
  if (!prompt && (await tryRunComposerSlashLine(raw))) return;
  const goalParse = parseGoalInput(raw);
  if (goalParse.enterComposeOnly) {
    ($("composer-input") as HTMLTextAreaElement).value = "";
    ($("chat-input") as HTMLTextAreaElement).value = "";
    beginGoalCompose();
    return;
  }
  if (goalParse.goalTitle) {
    const gr = await applyGoalTitle(goalParse.goalTitle);
    if (!gr.ok) {
      showToast(gr.message ?? "设置目标失败", "error");
      return;
    }
  }
  const attachSnap = [...composerAttachments];
  const { display, content } = buildPromptWithAttachments(goalParse.message);
  if (!content.trim()) return;
  // 新会话：重置历史后再记本条
  clearPromptHistoryStore();
  recordPromptHistory(display || content);

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
  suspendLiveTranscript = false;
  if (activeSessionId) markSessionWorking(activeSessionId, true);
  startContextPolling();
  const goalHint = pendingGoalTitle;
  await persistPendingGoal();

  const goalJustSet = goalParse.goalTitle || goalHint;
  const agentContent = agentContentForSend(
    content,
    goalJustSet && !goalPaused ? goalJustSet : null,
  );

  // Pending → Active：下一条消息进入计划 Active
  if (planPhase === "pending") {
    planPhase = "active";
  }
  lastPlanArtifactPath = null;
  setTurnStatus(tr("turn.thinking"));
  // 与继续对话相同：直播流式事件，首包即可显示
  const pr = await inv("turns.prompt", {
    threadId: activeThreadId,
    content: agentContent,
  });
  if (!pr.ok) {
    endTurn();
    appendLine(pr.error?.message ?? tr("chat.sendFail"), "error");
  } else {
    // 正常结束靠 turn.completed；invoke 与事件乱序时延迟兜底 + 回补末包
    scheduleTurnSettle(currentTurnId);
  }
  void refreshContextUsage();
  void refreshProjectsAndThreads();
}

/**
 * 从当前可见输入框读取并清空，构建 display/content。
 * 无内容返回 null。turn 进行中用于入队；空闲时用于直接发送。
 */
function takeComposerPrompt(): {
  display: string;
  content: string;
  attachSnap: ComposerAttachment[];
  goalTitle: string | null;
} | null {
  const input = $("chat").classList.contains("hidden")
    ? ($("composer-input") as HTMLTextAreaElement)
    : ($("chat-input") as HTMLTextAreaElement);
  const raw = input.value.trim();
  const goalParse = parseGoalInput(raw);
  if (goalParse.enterComposeOnly) {
    input.value = "";
    beginGoalCompose();
    return null;
  }
  const attachSnap = [...composerAttachments];
  const { display, content } = buildPromptWithAttachments(goalParse.message);
  if (!content.trim()) return null;
  input.value = "";
  clearAttachments();
  goalComposeActive = false;
  setComposerPlaceholders(false);
  // S17：记录用户可见文案（不含附件块噪音时用 display）
  recordPromptHistory(display || content);
  return {
    display,
    content,
    attachSnap,
    goalTitle: goalParse.goalTitle ?? null,
  };
}

/** 解析 composer 内联 `/btw …` / `/interject …`（完整行） */
function parseInlineBtwOrInterject(
  text: string,
): { kind: "btw" | "interject"; body: string } | null {
  const t = text.replace(/^\s+/, "");
  const m = t.match(/^\/(btw|interject)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return {
    kind: m[1]!.toLowerCase() as "btw" | "interject",
    body: (m[2] ?? "").trim(),
  };
}

/** 旁路侧问卡片（不进主对话气泡流语义；仅 UI） */
function paintBtwCard(
  question: string,
  state: "loading" | "done" | "error",
  answerOrError?: string,
): HTMLElement {
  const el = $("transcript");
  let card = document.getElementById("btw-live-card") as HTMLElement | null;
  if (!card) {
    card = document.createElement("div");
    card.id = "btw-live-card";
    card.className = "btw-card";
    el.appendChild(card);
  }
  card.classList.toggle("btw-card--error", state === "error");
  card.classList.toggle("btw-card--done", state === "done");
  const q = esc(question);
  if (state === "loading") {
    card.innerHTML = `
      <div class="btw-card-head"><span class="btw-badge">${esc(tr("btw.badge"))}</span>
        <button type="button" class="btw-dismiss" data-btw-dismiss="1" title="${esc(tr("btw.dismiss"))}">×</button></div>
      <div class="btw-q">${q}</div>
      <div class="btw-body btw-loading">${esc(tr("btw.loading"))}</div>`;
  } else if (state === "error") {
    card.innerHTML = `
      <div class="btw-card-head"><span class="btw-badge">${esc(tr("btw.badge"))}</span>
        <button type="button" class="btw-dismiss" data-btw-dismiss="1" title="${esc(tr("btw.dismiss"))}">×</button></div>
      <div class="btw-q">${q}</div>
      <div class="btw-body btw-err">${esc(answerOrError || tr("btw.fail"))}</div>`;
  } else {
    const body = answerOrError ?? "";
    card.innerHTML = `
      <div class="btw-card-head"><span class="btw-badge">${esc(tr("btw.badge"))}</span>
        <button type="button" class="btw-dismiss" data-btw-dismiss="1" title="${esc(tr("btw.dismiss"))}">×</button></div>
      <div class="btw-q">${q}</div>
      <div class="btw-body">${renderMarkdownToSafeHtml(body)}</div>`;
  }
  el.scrollTop = el.scrollHeight;
  return card;
}

function dismissBtwCard(): void {
  document.getElementById("btw-live-card")?.remove();
}

/** 插话用户块（视觉上区别于普通 user 气泡） */
function paintInterjectionMessage(text: string): void {
  const t = text.trim();
  if (!t) return;
  const el = $("transcript");
  const wrap = document.createElement("div");
  wrap.className = "line user interjection";
  wrap.innerHTML = `
    <div class="bubble interjection-bubble">
      <div class="interjection-tag">${esc(tr("interject.tag"))}</div>
      <div class="bubble-text">${esc(t)}</div>
    </div>`;
  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
}

/** 本端已乐观绘制的 interjection id（回声去重） */
const selfInterjectionIds = new Set<string>();

async function runBtwCommand(
  questionArg?: string,
): Promise<{ ok: boolean; message?: string }> {
  let question = (questionArg ?? "").trim();
  if (!question) {
    const fromComposer = activeComposerInput()?.value.trim() ?? "";
    const inline = parseInlineBtwOrInterject(fromComposer);
    if (inline?.kind === "btw" && inline.body) {
      question = inline.body;
      const ta = activeComposerInput();
      if (ta) ta.value = "";
    } else if (fromComposer && !fromComposer.startsWith("/")) {
      question = fromComposer;
      const ta = activeComposerInput();
      if (ta) ta.value = "";
    }
  }
  if (!question) {
    const typed = await promptText({
      title: tr("btw.promptTitle"),
      hint: tr("btw.promptHint"),
      defaultValue: "",
      placeholder: tr("btw.promptPh"),
    });
    if (typed == null) return { ok: true };
    question = typed.trim();
  }
  if (!question) {
    return { ok: false, message: tr("btw.empty") };
  }

  showWelcome(false);
  paintBtwCard(question, "loading");
  recordPromptHistory(`/btw ${question}`);

  const threadId = await ensureLiveThread();
  if (!threadId) {
    paintBtwCard(question, "error", tr("chat.connectFail"));
    return { ok: false, message: tr("chat.connectFail") };
  }

  const res = await inv<{ sessionId: string; answer: string }>("threads.btw", {
    threadId,
    question,
  });
  if (!res.ok) {
    const msg = res.error?.message ?? tr("btw.fail");
    paintBtwCard(question, "error", msg);
    return { ok: false, message: msg };
  }
  paintBtwCard(question, "done", res.data?.answer ?? "");
  return { ok: true, message: tr("btw.ok") };
}

async function runInterjectCommand(
  textArg?: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!turnActive) {
    return { ok: false, message: tr("interject.needTurn") };
  }
  let text = (textArg ?? "").trim();
  let historyAlreadyRecorded = false;
  if (!text) {
    const taken = takeComposerPrompt();
    if (taken) {
      // interject 文本路径：暂不带附件 wire（CLI 有 content blocks；Desktop v1 仅 text）
      text = taken.content.trim() || taken.display.trim();
      historyAlreadyRecorded = true; // takeComposerPrompt 已写入 prompt history
    }
  }
  if (!text) {
    return { ok: false, message: tr("interject.empty") };
  }

  const threadId =
    activeThreadId && !activeThreadId.startsWith("disk_")
      ? activeThreadId
      : await ensureLiveThread();
  if (!threadId) {
    return { ok: false, message: tr("chat.connectFail") };
  }

  const interjectionId = `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  selfInterjectionIds.add(interjectionId);
  paintInterjectionMessage(text);
  showToast(tr("interject.sent"));
  if (!historyAlreadyRecorded) recordPromptHistory(text);

  const res = await inv<{
    sessionId: string;
    status: string;
    interjectionId: string;
  }>("threads.interject", { threadId, text, interjectionId });

  if (!res.ok) {
    selfInterjectionIds.delete(interjectionId);
    appendLine(res.error?.message ?? tr("interject.fail"), "error");
    return {
      ok: false,
      message: res.error?.message ?? tr("interject.fail"),
    };
  }
  return { ok: true, message: tr("interject.ok") };
}

/** turn 进行中：将当前输入入队（S19 follow-up） */
function tryEnqueueFromComposer(): boolean {
  if (!turnActive) return false;
  const raw = activeComposerInput()?.value.trim() ?? "";
  const inline = parseInlineBtwOrInterject(raw);
  if (inline?.kind === "btw") {
    // 旁路不占 follow-up 队列
    void runBtwCommand(inline.body);
    const ta = activeComposerInput();
    if (ta) ta.value = "";
    return true;
  }
  if (inline?.kind === "interject") {
    void runInterjectCommand(inline.body);
    const ta = activeComposerInput();
    if (ta) ta.value = "";
    return true;
  }
  const taken = takeComposerPrompt();
  if (!taken) return false;
  enqueuePrompt({
    display: taken.display,
    content: taken.content,
    attachments: taken.attachSnap,
  });
  // 时间线提示（不画用户气泡，避免与真实发送重复）
  appendLine(
    tr("queue.queuedLine", {
      preview: taken.display.replace(/\s+/g, " ").slice(0, 60),
    }),
    "system",
  );
  return true;
}

async function sendContinue(): Promise<void> {
  if (!activeThreadId && !activeSessionId) {
    await startNewChat();
    return;
  }
  // 空闲时也可 /btw；/interject 需 turn
  {
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
  // S19：回合进行中有输入 → 入队；无输入则保持由发送钮取消
  if (turnActive) {
    if (tryEnqueueFromComposer()) return;
    await cancelTurn();
    return;
  }
  const taken = takeComposerPrompt();
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
  const agentContent = agentContentForSend(
    taken.content,
    taken.goalTitle && !goalPaused ? taken.goalTitle : null,
  );
  // Pending → Active：下一条消息进入计划 Active
  if (planPhase === "pending") {
    planPhase = "active";
  }
  lastPlanArtifactPath = null;
  setTurnStatus(tr("turn.thinking"));

  const res = await inv("turns.prompt", {
    threadId,
    content: agentContent,
  });
  if (!res.ok) {
    endTurn();
    appendLine(res.error?.message ?? tr("chat.sendFail"), "error");
  } else {
    // 正常结束靠 turn.completed；勿在此立刻 endTurn（会丢末包）
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
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal").classList.remove("hidden");
}

function closeModal(): void {
  $("modal").classList.add("hidden");
}

async function showSearchModal(): Promise<void> {
  await refreshProjectsAndThreads();
  openModal(
    tr("common.search"),
    `<div class="session-search-wrap">
      <p class="prompt-dlg-hint">${esc(tr("search.resumeHint"))}</p>
      <input id="search-q" class="prompt-dlg-input" type="search"
        placeholder="${esc(tr("search.placeholder"))}" autocomplete="off" />
      <div id="search-hits" class="session-search-list"></div>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.close"))}</button>
      </div>
    </div>`,
  );
  const run = async () => {
    const rawQ = ($("search-q") as HTMLInputElement).value.trim();
    const q = rawQ.toLowerCase();
    const parts: string[] = [];
    // 完整 session id 精确命中优先（对齐 CLI -r /resume）
    if (q.length >= 8) {
      const exact = threads.find(
        (t) =>
          t.sessionId.toLowerCase() === q ||
          t.sessionId.toLowerCase().startsWith(q),
      );
      if (exact) {
        parts.push(
          `<button type="button" class="session-search-item is-resume" data-kind="thread" data-sid="${esc(exact.sessionId)}">
            <div class="session-search-title">↩ ${esc(tr("search.resumePrefix"))} ${esc(exact.title || exact.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(exact.sessionId)} · ${esc(formatAge(exact.updatedAt) || "")}</div>
          </button>`,
        );
      }
    }
    for (const p of projects) {
      if (
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q)
      ) {
        parts.push(
          `<button type="button" class="session-search-item" data-kind="project" data-id="${esc(p.id)}">
            <div class="session-search-title">📁 ${esc(p.title)}</div>
            <div class="session-search-sub">${esc(p.path)}</div>
          </button>`,
        );
      }
    }
    for (const t of threads.filter((x) => !x.archived)) {
      if (
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.sessionId.toLowerCase().includes(q) ||
        t.cwd.toLowerCase().includes(q)
      ) {
        // 已作为精确 resume 置顶则跳过重复
        if (
          q.length >= 8 &&
          (t.sessionId.toLowerCase() === q ||
            t.sessionId.toLowerCase().startsWith(q))
        ) {
          continue;
        }
        parts.push(
          `<button type="button" class="session-search-item" data-kind="thread" data-sid="${esc(t.sessionId)}">
            <div class="session-search-title">💬 ${esc(t.title || t.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(formatAge(t.updatedAt) || "")} · ${esc(t.sessionId.slice(0, 8))}${t.archived ? "" : ""}</div>
          </button>`,
        );
      }
    }
    // 归档会话也可按 id / 标题 resume
    for (const t of threads.filter((x) => x.archived)) {
      if (
        q &&
        (t.title.toLowerCase().includes(q) ||
          t.sessionId.toLowerCase().includes(q))
      ) {
        parts.push(
          `<button type="button" class="session-search-item" data-kind="thread" data-sid="${esc(t.sessionId)}">
            <div class="session-search-title">📦 ${esc(t.title || t.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(tr("search.archived"))} · ${esc(t.sessionId.slice(0, 8))}</div>
          </button>`,
        );
      }
    }
    const proj = selectedProject();
    if (proj && q.length >= 2) {
      const g = await inv<
        Array<{ name: string; path: string; line: number; snippet: string }>
      >("graph.search", { projectPath: proj.path, query: q });
      for (const h of g.data ?? []) {
        parts.push(
          `<button type="button" class="session-search-item" data-kind="symbol" data-path="${esc(h.path)}" data-line="${h.line}">
            <div class="session-search-title">◇ ${esc(h.name)}</div>
            <div class="session-search-sub">${esc(h.path)}:${h.line}</div>
          </button>`,
        );
      }
    }
    $("search-hits").innerHTML =
      parts.slice(0, 80).join("") ||
      `<div class="item-sub">${esc(tr("common.noMatch"))}</div>`;
    for (const btn of Array.from(
      $("search-hits").querySelectorAll(".session-search-item"),
    )) {
      (btn as HTMLElement).onclick = () => {
        const el = btn as HTMLElement;
        const kind = el.dataset.kind;
        if (kind === "project") {
          selectedProjectId = el.dataset.id ?? null;
          projectChoiceTouched = true;
          closeModal();
          showWelcome(true);
          void refreshProjectsAndThreads();
          return;
        }
        if (kind === "thread") {
          const hit = threads.find((t) => t.sessionId === el.dataset.sid);
          closeModal();
          if (hit) {
            showToast(
              tr("search.opening", {
                title: hit.title || hit.sessionId.slice(0, 8),
              }),
            );
            void openThread(hit);
          }
          return;
        }
        if (kind === "symbol") {
          const pth = el.dataset.path;
          const line = Number(el.dataset.line);
          closeModal();
          if (pth) void sidePane?.openFile(pth, Number.isFinite(line) ? line : undefined);
        }
      };
    }
  };
  $("search-q").oninput = () => void run();
  $("prompt-dlg-cancel").onclick = () => closeModal();
  void run();
  requestAnimationFrame(() => ($("search-q") as HTMLInputElement).focus());
}

async function showPluginsPage(): Promise<void> {
  if (!pluginsPage) {
    pluginsPage = new PluginsPageController({
      inv,
      esc,
      getSelectedProjectPath: () => selectedProject()?.path,
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
      onOpenPath: (path0) => {
        void inv("system.openPath", { path: path0 });
      },
      onToast: (msg) => showToast(msg),
      onClosed: restoreComposerAfterOverlay,
    });
  }
  await pluginsPage.show();
}

async function showAutomationsModal(): Promise<void> {
  const list = await inv<
    Array<{ id: string; name: string; status: string; prompt: string; projectId: string }>
  >("automations.list");
  openModal(
    tr("nav.automations"),
    `
    <div style="display:grid;gap:8px;margin-bottom:12px">
      <input id="auto-name" placeholder=tr("plug.mcpName") style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)" />
      <select id="auto-project" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)">
        ${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join("")}
      </select>
      <textarea id="auto-prompt" rows="3" placeholder="定时任务指令" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)"></textarea>
      <button type="button" class="btn-dark" id="btn-auto-create">创建</button>
    </div>
    ${(list.data ?? []).map((a) => `<div class="item"><div class="item-title">${esc(a.name)} · ${esc(a.status)}</div><div class="item-sub">${esc(a.prompt)}</div>
      <button type="button" class="btn-ghost" style="margin-top:6px" data-run="${esc(a.id)}">立即运行</button></div>`).join("") || '<div class="item-sub">暂无自动化</div>'}
    `,
  );
  $("modal-body").onclick = async (e) => {
    const t = e.target as HTMLElement;
    if (t.id === "btn-auto-create") {
      const name = ($("auto-name") as HTMLInputElement).value.trim();
      const projectId = ($("auto-project") as HTMLSelectElement).value;
      const prompt = ($("auto-prompt") as HTMLTextAreaElement).value.trim();
      if (!name || !projectId || !prompt) return;
      await inv("automations.create", {
        name,
        projectId,
        schedule: "manual",
        prompt,
        worktreeMode: "project_root",
        alwaysApprove: false,
      });
      await showAutomationsModal();
    }
    if (t.dataset.run) {
      const r = await inv("automations.runNow", { id: t.dataset.run });
      if (!r.ok) alert(r.error?.message);
      else alert(tr("auto.started"));
    }
  };
}

function resolveTheme(pref: SettingsThemePreference): ThemeVariant {
  if (pref === "light" || pref === "dark") return pref;
  try {
    if (typeof matchMedia === "function") {
      return matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
  } catch {
    /* ignore */
  }
  return "light";
}

function appearanceForVariant(v: ThemeVariant): VariantAppearance {
  return v === "light" ? appearanceLight : appearanceDark;
}

function paintResolvedTheme(resolved: ThemeVariant): void {
  const app = appearanceForVariant(resolved);
  const isDefault = app.codeThemeId === "default" || app.codeThemeId === "codex";
  applyChromeTheme(app.chromeTheme, resolved, {
    isDefaultPreset: isDefault,
  });
  // 冷启动缓存（theme-boot 可读）
  try {
    localStorage.setItem("grok-desktop-theme", themePreference);
    localStorage.setItem(
      "grok-desktop-theme-boot",
      JSON.stringify({
        variant: resolved,
        codeThemeId: app.codeThemeId,
        chrome: app.chromeTheme,
        isDefault,
      }),
    );
  } catch {
    /* ignore */
  }
  void inv("ui.setChromeTheme", { theme: resolved }).catch(() => {
    /* older shell */
  });
}

function bindSystemThemeListener(): void {
  if (systemThemeMql && systemThemeListener) {
    try {
      systemThemeMql.removeEventListener("change", systemThemeListener);
    } catch {
      /* ignore */
    }
  }
  systemThemeMql = null;
  systemThemeListener = null;
  if (themePreference !== "system") return;
  try {
    systemThemeMql = matchMedia("(prefers-color-scheme: dark)");
    systemThemeListener = () => {
      if (themePreference === "system") {
        paintResolvedTheme(resolveTheme("system"));
      }
    };
    systemThemeMql.addEventListener("change", systemThemeListener);
  } catch {
    /* ignore */
  }
}

/** 应用 mode（system/light/dark）并刷新 chrome */
function applyThemePreference(pref: SettingsThemePreference): void {
  themePreference = pref;
  try {
    localStorage.setItem("grok-desktop-theme", pref);
  } catch {
    /* ignore */
  }
  paintResolvedTheme(resolveTheme(pref));
  bindSystemThemeListener();
}

/** 写入内存中的某 variant 外观并可选立即绘制 */
function setVariantAppearance(
  variant: ThemeVariant,
  app: VariantAppearance,
  repaint: boolean,
): void {
  if (variant === "light") appearanceLight = app;
  else appearanceDark = app;
  if (repaint && resolveTheme(themePreference) === variant) {
    paintResolvedTheme(variant);
  }
}

/** 导出当前 resolved 变体的 codex-theme-v1 串 */
function exportCurrentThemeString(): string {
  const variant = resolveTheme(themePreference);
  const app = appearanceForVariant(variant);
  return formatCodexThemeV1({
    codeThemeId: app.codeThemeId,
    theme: app.chromeTheme,
    variant,
  });
}

function applyDesktopConfig(cfg: {
  defaultPermMode: SettingsPermMode;
  defaultModel: string;
  defaultOpenTarget: SettingsOpenTarget;
  locale?: LocalePreference;
  theme?: SettingsThemePreference;
  appearanceLight?: VariantAppearance;
  appearanceDark?: VariantAppearance;
}): void {
  // 只更新「新对话默认」；切换供应商等操作不得覆盖当前会话的权限模式 / 模型 chip
  defaultModelLabel = cfg.defaultModel || "grok";
  defaultOpenTarget = cfg.defaultOpenTarget;
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
    appearanceDirty = true;
  }
  if (cfg.appearanceDark) {
    appearanceDark = cfg.appearanceDark;
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
  modelsCache = null;
  modelsFetch = null;
  // 设置仍开着：只校准 chip，禁止 setModel / toast（关页时再补）
  void ensureChipModelAvailable({
    toast: Boolean(activeSessionId) && !isMainShellOverlayOpen(),
    allowSetModel: !isMainShellOverlayOpen(),
  });
}

/**
 * 强制主壳可交互（防 settings-open / inert 粘住导致无法输入）。
 * 插件全页仍可见时只清 settings 态，保留其 inert。
 */
function forceMainShellInteractive(): void {
  const app = document.getElementById("app");
  if (!app) return;
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

/** 设置/插件关闭后恢复主界面可输入 */
function restoreComposerAfterOverlay(): void {
  forceMainShellInteractive();
  hideModelMenu();
  $("perm-menu")?.classList.add("hidden");
  // 设置期间推迟的模型校验：关页后再 setModel
  void ensureChipModelAvailable({
    toast: Boolean(activeSessionId),
    allowSetModel: true,
  });
  // 双 rAF：等 display:none 与 inert 解除后再抢焦点
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        forceMainShellInteractive();
        if (isMainShellOverlayOpen()) return;
        const ta = activeComposerInput();
        if (!ta || ta.disabled || ta.readOnly) return;
        ta.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    });
  });
}

async function showSettingsPage(): Promise<void> {
  if (!settingsPage) {
    settingsPage = new SettingsPageController({
      inv,
      esc,
      getSelectedProjectPath: () => selectedProject()?.path,
      getSelectedProjectId: () => selectedProjectId,
      onConfigApplied: applyDesktopConfig,
      onClosed: restoreComposerAfterOverlay,
      resolveThemeVariant: () => resolveTheme(themePreference),
      getAppearance: (v) => appearanceForVariant(v),
      exportThemeString: () => exportCurrentThemeString(),
    });
  }
  await settingsPage.show();
}

/** 权限菜单关闭动画收尾定时器 */
let permMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
let permMenuOpenRaf = 0;

function isPermMenuVisible(): boolean {
  const menu = document.getElementById("perm-menu");
  return Boolean(menu && !menu.classList.contains("hidden"));
}

/**
 * 关闭权限菜单。
 * @param immediate 窗口 resize 等场景跳过动画，避免残影留在原点
 */
function hidePermMenu(opts?: { immediate?: boolean }): void {
  const menu = document.getElementById("perm-menu");
  if (!menu) return;
  if (permMenuOpenRaf) {
    cancelAnimationFrame(permMenuOpenRaf);
    permMenuOpenRaf = 0;
  }
  if (permMenuCloseTimer != null) {
    clearTimeout(permMenuCloseTimer);
    permMenuCloseTimer = null;
  }

  const finish = () => {
    menu.classList.add("hidden");
    menu.classList.remove("is-open", "open-up", "open-down");
    delete menu.dataset.anchor;
  };

  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (
    opts?.immediate ||
    reduced ||
    menu.classList.contains("hidden") ||
    !menu.classList.contains("is-open")
  ) {
    menu.classList.remove("is-open");
    finish();
    return;
  }

  menu.classList.remove("is-open");
  const onEnd = (e: TransitionEvent) => {
    if (e.target !== menu) return;
    if (e.propertyName !== "opacity" && e.propertyName !== "transform") return;
    menu.removeEventListener("transitionend", onEnd);
    if (permMenuCloseTimer != null) {
      clearTimeout(permMenuCloseTimer);
      permMenuCloseTimer = null;
    }
    finish();
  };
  menu.addEventListener("transitionend", onEnd);
  // transitionend 偶发丢失时兜底
  permMenuCloseTimer = setTimeout(() => {
    menu.removeEventListener("transitionend", onEnd);
    permMenuCloseTimer = null;
    finish();
  }, 240);
}

/** 窗口几何变化时关掉 fixed 浮层，避免锚点失效留在原点 */
function hideEphemeralMenus(): void {
  hidePermMenu({ immediate: true });
  hideModelMenu();
  hidePlusMenu();
}

function syncPermMenuActiveItem(): void {
  const menu = document.getElementById("perm-menu");
  if (!menu) return;
  for (const btn of Array.from(menu.querySelectorAll<HTMLElement>("[data-mode]"))) {
    const mode = btn.dataset.mode;
    // 菜单只反映访问权限，与 plan 无关
    const active =
      mode === "always_approve"
        ? accessMode === "always_approve"
        : mode === "normal"
          ? accessMode === "normal"
          : false;
    btn.classList.toggle("is-active", active);
  }
}

function showPermMenu(anchor: HTMLElement): void {
  hideModelMenu();
  hidePlusMenu();
  const menu = $("perm-menu");

  // 再次点击同一锚点：丝滑收起
  if (
    isPermMenuVisible() &&
    menu.classList.contains("is-open") &&
    menu.dataset.anchor === anchor.id
  ) {
    hidePermMenu();
    return;
  }

  if (permMenuCloseTimer != null) {
    clearTimeout(permMenuCloseTimer);
    permMenuCloseTimer = null;
  }
  if (permMenuOpenRaf) {
    cancelAnimationFrame(permMenuOpenRaf);
    permMenuOpenRaf = 0;
  }

  // 先无 is-open 显示以便测量真实尺寸，再 rAF 触发展开动画
  menu.classList.remove("hidden", "is-open");
  syncPermMenuActiveItem();
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 160;
  const mh = menu.offsetHeight || 88;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (left < 8) left = 8;
  // 输入栏贴底：优先向上弹出，避免「完全访问」等项被窗口底边裁切
  const spaceBelow = window.innerHeight - r.bottom;
  let top: number;
  let openUp = false;
  if (spaceBelow < mh + 12 && r.top > mh + 12) {
    top = Math.max(8, r.top - mh - 6);
    openUp = true;
  } else {
    top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - mh - 8);
    }
    // 最终仍在 chip 上方则用向上动效
    openUp = top + mh / 2 < r.top;
  }
  menu.classList.toggle("open-up", openUp);
  menu.classList.toggle("open-down", !openUp);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.dataset.anchor = anchor.id;

  // 强制 reflow，保证从收起态过渡到 is-open
  void menu.offsetWidth;
  permMenuOpenRaf = requestAnimationFrame(() => {
    permMenuOpenRaf = 0;
    menu.classList.add("is-open");
  });
}

/**
 * Shift+Tab：循环主展示模式（对齐 Grok Build CLI）
 * Normal → Plan → Always-approve → Normal
 * 注：从 Plan 到 Always-approve 会关 plan 并打开 yolo；
 * 从 Normal 进 Plan 不改变 accessMode（yolo 可 armed underneath）。
 */
async function cycleSessionMode(): Promise<void> {
  if (!isPlanOn() && accessMode === "normal") {
    const r = await enterPlanMode();
    if (r.message) showToast(r.message, r.ok ? "info" : "error");
    return;
  }
  if (isPlanOn()) {
    planPhase = "off";
    accessMode = "always_approve";
    syncPermLabels();
    const r = await syncSessionPolicyLive({ plan: false, alwaysApprove: true });
    if (!r.ok) {
      showToast(r.message ?? "切换完全访问失败", "error");
      return;
    }
    showToast("已开启完全访问");
    return;
  }
  // always_approve（非 plan）→ normal
  accessMode = "normal";
  planPhase = "off";
  syncPermLabels();
  void syncSessionPolicyLive({ plan: false, alwaysApprove: false });
  showToast("已恢复默认确认");
}

// ── Events ─────────────────────────────────────────────────

function showPermission(requestId: string, summary: string): void {
  // enter_plan_mode：与计划模式一致时自动允许（对齐 CLI 减少打断）
  const low = summary.toLowerCase();
  if (
    /enter_plan|enter-plan|进入计划|plan mode/i.test(low) &&
    isPlanOn()
  ) {
    void inv("permissions.respond", {
      requestId,
      decision: "allow_once",
    });
    planPhase = "active";
    syncPermLabels();
    return;
  }
  // Host 在 always_approve 时会自动放行；此处仍可能收到事件，直接隐藏条
  if (accessMode === "always_approve") {
    void inv("permissions.respond", {
      requestId,
      decision: "allow_once",
    }).catch(() => undefined);
    return;
  }
  const bar = $("permission-bar");
  bar.classList.remove("hidden");
  bar.innerHTML = `<div>需要批准：${esc(summary)}</div>`;
  for (const [label, decision] of [
    ["允许", "allow_once"],
    ["拒绝", "deny"],
  ] as const) {
    const b = document.createElement("button");
    b.className = decision === "allow_once" ? "btn-dark" : "btn-ghost";
    b.textContent = label;
    b.onclick = async () => {
      await inv("permissions.respond", { requestId, decision });
      bar.classList.add("hidden");
      if (decision === "allow_once" && /enter_plan|enter-plan|进入计划/i.test(low)) {
        planPhase = "active";
        syncPermLabels();
      }
    };
    bar.appendChild(b);
  }
  showWelcome(false);
}

async function handleDeepLinkPayload(payload: string): Promise<void> {
  const parsed = await inv<{ kind: string; id?: string }>(
    "shell.parseDeepLink",
    { raw: payload },
  );
  if (!parsed.ok || !parsed.data) return;
  if (parsed.data.kind === "project" && parsed.data.id) {
    selectedProjectId = parsed.data.id;
    await refreshProjectsAndThreads();
    showWelcome(true);
  }
  if (parsed.data.kind === "inbox") {
    /* could open modal */
  }
}

function handleShellNavigate(view: "command" | "inbox" | string): void {
  if (view === "inbox") {
    void (async () => {
      try {
        const res = await inv<
          Array<{
            id: string;
            title?: string;
            body?: string;
            read?: boolean;
            type?: string;
            createdAt?: string;
            sessionId?: string;
            threadId?: string;
            projectId?: string;
          }>
        >("inbox.list", {});
        const items = res.ok ? (res.data ?? []) : [];
        const rows = items.length
          ? items
              .map((it) => {
                const unread = it.read ? "" : " is-unread";
                const when = it.createdAt
                  ? esc(it.createdAt.replace("T", " ").slice(0, 16))
                  : "";
                return (
                  '<div class="item inbox-item' +
                  unread +
                  '" data-inbox-id="' +
                  esc(it.id) +
                  '">' +
                  '<div class="item-title">' +
                  esc(it.title || it.type || "notice") +
                  "</div>" +
                  '<div class="item-sub">' +
                  esc((it.body || "").slice(0, 200)) +
                  "</div>" +
                  '<div class="item-sub mono">' +
                  esc(it.type || "") +
                  " · " +
                  when +
                  "</div>" +
                  '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
                  '<button type="button" class="btn-dark" data-inbox-act="open" data-id="' +
                  esc(it.id) +
                  '">' +
                  esc(tr("common.open")) +
                  "</button>" +
                  '<button type="button" class="btn-ghost" data-inbox-act="dismiss" data-id="' +
                  esc(it.id) +
                  '">' +
                  esc(tr("common.delete")) +
                  "</button>" +
                  "</div></div>"
                );
              })
              .join("")
          : '<div class="item-sub">' + esc(tr("common.none")) + "</div>";
        openModal(
          tr("nav.inbox"),
          '<div style="display:flex;justify-content:flex-end;margin-bottom:8px">' +
            '<button type="button" class="btn-ghost" id="btn-inbox-mark-all">' +
            esc(tr("common.ok")) +
            "</button></div><div class=\"inbox-list\">" +
            rows +
            "</div>",
        );
        const body = $("modal-body");
        body.onclick = async (e) => {
          const target = e.target;
          if (!(target instanceof HTMLElement)) return;
          if (target.id === "btn-inbox-mark-all") {
            await inv("inbox.markAllRead");
            handleShellNavigate("inbox");
            return;
          }
          const act = target.dataset.inboxAct;
          const id = target.dataset.id;
          if (!act || !id) return;
          const item = items.find((x) => x.id === id);
          if (act === "open") {
            if (item?.id) await inv("inbox.markRead", { id: item.id });
            if (item?.sessionId) {
              const row = threads.find((x) => x.sessionId === item.sessionId);
              if (row) {
                closeModal();
                await openThread(row);
              }
            } else if (item?.projectId) {
              selectedProjectId = item.projectId;
              await refreshProjectsAndThreads();
            }
            return;
          }
          if (act === "dismiss") {
            await inv("inbox.dismiss", { id });
            handleShellNavigate("inbox");
          }
        };
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : tr("common.error"),
          "error",
        );
      }
    })();
    return;
  }
  if (view === "command") {
    try {
      closeModal();
    } catch {
      /* ignore */
    }
    showWelcome(true);
  }
}

function handleShellNotice(code: string, message?: string): void {
  if (code === "agent_missing") {
    showToast(message || tr("agent.missing"), "error");
  } else if (message) {
    showToast(message, "info");
  }
}

function onEvent(raw: unknown): void {
  const ev = raw as NormalizedEvent & { activity?: string };
  // Dedicated shell control bus (preferred over session.status activity)
  if (ev.type === "shell.handoff") {
    void handleDeepLinkPayload((ev as { payload?: string }).payload || "");
    return;
  }
  if (ev.type === "shell.navigate") {
    handleShellNavigate((ev as { view?: string }).view || "command");
    return;
  }
  if (ev.type === "shell.notice") {
    handleShellNotice(
      (ev as { code?: string }).code || "",
      (ev as { message?: string }).message,
    );
    return;
  }
  // goal 与 agent 同源：不因 transcript 挂起而丢状态
  if (ev.type === "goal.updated") {
    applyAgentGoalEvent(ev);
    return;
  }
  if (ev.type === "subagent.updated") {
    handleSubagentUpdated(ev);
    return;
  }
  if (ev.type === "task.updated") {
    handleTaskUpdated(ev);
    return;
  }
  if (ev.type === "session.available_commands") {
    applyAvailableCommandsEvent(ev);
    return;
  }
  // 目录变更：与会话挂起无关，始终刷新文件树
  if (ev.type === "files.changed") {
    sidePane?.scheduleRefreshFileTree();
    return;
  }
  // 计划审批 / 模式变更：与 transcript 挂起无关（exit_plan 可在任意时机弹出）
  if (ev.type === "plan.approval.requested") {
    if (
      "threadId" in ev &&
      ev.threadId &&
      activeThreadId &&
      ev.threadId !== activeThreadId &&
      !activeThreadId.startsWith("disk_")
    ) {
      return;
    }
    void handlePlanApprovalRequested(ev);
    return;
  }
  if (ev.type === "plan.mode.changed") {
    if (
      "threadId" in ev &&
      ev.threadId &&
      activeThreadId &&
      ev.threadId !== activeThreadId &&
      !activeThreadId.startsWith("disk_")
    ) {
      return;
    }
    if (ev.active) {
      // 用户 /plan 已为 pending：保持 Pending 至下一条消息；
      // agent 主动进入时直接 Active。不改 accessMode。
      if (planPhase === "off") planPhase = "active";
    } else if (isPlanOn()) {
      // agent 退出 plan；保留 accessMode（yolo 可重新露出）
      planPhase = "off";
    }
    syncPermLabels();
    return;
  }
  // handoff / 全局状态始终处理
  if (ev.type === "session.status") {
    // Legacy control bus (pre shell.* events) - keep for older host builds
    if (ev.activity === "nav:inbox" || ev.activity === "nav:command") {
      handleShellNavigate(ev.activity === "nav:inbox" ? "inbox" : "command");
      return;
    }
    if (ev.activity === "system:agent_missing") {
      handleShellNotice("agent_missing");
      return;
    }
    if (ev.activity?.startsWith("handoff:")) {
      void handleDeepLinkPayload(ev.activity.slice("handoff:".length));
    }
    if (ev.sessionId) {
      const busy =
        ev.status === "working" ||
        ev.status === "needs_input" ||
        ev.status === "blocked";
      markSessionWorking(ev.sessionId, busy);
    }
    return;
  }
  // Ignore events for other threads when we have an active one
  if (
    "threadId" in ev &&
    ev.threadId &&
    activeThreadId &&
    ev.threadId !== activeThreadId &&
    !activeThreadId.startsWith("disk_")
  ) {
    return;
  }
  // create / openThread 期间丢弃直播，避免与 history 叠双份
  if (suspendLiveTranscript) {
    if (ev.type === "permission.requested") {
      showPermission(ev.requestId, ev.summary);
    }
    return;
  }
  switch (ev.type) {
    case "message.delta":
      showWelcome(false);
      if (ev.role === "user") return;
      appendLine(ev.text, "assistant", { fromStream: true });
      break;
    case "thought.delta":
      showWelcome(false);
      if (!turnActive) beginTurn();
      if (ev.text.trim()) appendThoughtDelta(ev.text);
      break;
    case "tool.started":
      showWelcome(false);
      if (!turnActive) beginTurn();
      markToolStarted(ev.name || "tool", ev.toolCallId, ev.raw);
      break;
    case "tool.completed": {
      markToolCompleted(ev.toolCallId, ev.name, ev.raw);
      // 双保险：从 tool raw 再抽一次 update_goal（normalize 已推 goal.updated 时为幂等）
      maybeGoalFromToolRaw(ev.name, ev.raw);
      // 写文件 / shell 后刷新侧栏文件树（fs.watch 也会兜底）
      const kind = extractToolMeta(ev.raw, ev.name).kind;
      if (kind === "write" || kind === "shell") {
        sidePane?.scheduleRefreshFileTree();
      }
      notePlanArtifactFromTool(ev.name, ev.raw);
      break;
    }
    case "turn.started":
      showWelcome(false);
      if (!turnActive) beginTurn();
      else setTurnStatus(tr("turn.thinking"));
      break;
    case "turn.completed": {
      const stop = String((ev as { stopReason?: string }).stopReason || "");
      const errMsg = (ev as { error?: string }).error
        ? String((ev as { error?: string }).error)
        : "";
      const hadText = Boolean((ev as { hadAssistantText?: boolean }).hadAssistantText);
      const hadTools = Boolean((ev as { hadToolActivity?: boolean }).hadToolActivity);
      endTurn();
      if (stop === "timeout" || /timed out/i.test(errMsg)) {
        appendLine(
          tr("chat.turnTimeout") ||
            "Turn timed out (agent idle too long). Try again or split the task.",
          "error",
        );
      } else if (errMsg && stop === "error") {
        appendLine(errMsg, "error");
      } else if (!hadText && !hadTools) {
        appendLine(
          tr("chat.turnEmpty") ||
            "Turn finished with no assistant reply. Check agent logs or retry.",
          "system",
        );
      } else if (!hadText && hadTools) {
        appendLine(
          tr("chat.turnToolsOnly") ||
            "Turn finished after tools ran, but no final reply text was streamed.",
          "system",
        );
      }
      void syncGoalFromAgent();
      void refreshContextUsage();
      sidePane?.scheduleRefreshFileTree(400);
      void afterTurnSettled();
      break;
    }
    case "context.compacted":
      // auto-compact：系统提示 + 乐观刷新 chip（signals 写回有延迟）
      if (ev.status === "completed" && ev.kind === "auto") {
        const detail =
          ev.tokensBefore != null && ev.tokensAfter != null
            ? `（${formatTokenK(ev.tokensBefore)} → ${formatTokenK(ev.tokensAfter)}）`
            : "";
        appendLine(tr("chat.autoCompacted", { detail }), "system");
        refreshContextAfterCompact(ev);
      } else if (ev.status === "completed") {
        refreshContextAfterCompact(ev);
      } else if (ev.status === "failed") {
        appendLine(
          tr("chat.autoCompactFail", {
            detail: ev.message ? `：${ev.message}` : "",
          }),
          "error",
        );
      } else if (ev.status === "started" && ev.kind === "auto") {
        setTurnStatus(
          ev.percentage != null
            ? tr("chat.autoCompactStartPct", { pct: ev.percentage })
            : tr("chat.autoCompactStart"),
        );
      }
      break;
    case "permission.requested":
      endStreamBubble();
      setTurnStatus("等待批准…");
      showPermission(ev.requestId, ev.summary);
      break;
    case "agent.error":
      endTurn();
      appendLine(ev.message, "error");
      // R4：标记 live 失效，展示重新附着
      if (activeThreadId && !activeThreadId.startsWith("disk_") && activeSessionId) {
        activeThreadId = `disk_${activeSessionId}`;
      }
      showAgentCrashBanner(ev.message);
      break;
    default:
      break;
  }
}

/** agent 发起 x.ai/exit_plan_mode → 打开计划面板审批 */
async function handlePlanApprovalRequested(ev: {
  requestId: string;
  sessionId: string;
  toolCallId?: string;
  planContent?: string | null;
}): Promise<void> {
  endStreamBubble();
  setTurnStatus("等待计划审批…");
  let content = (ev.planContent ?? "").trim();
  if (!content && ev.sessionId) {
    const res = await inv<{
      content?: string;
    } | null>("plans.get", { sessionId: ev.sessionId });
    if (res.ok && res.data?.content) {
      content = res.data.content.trim();
    }
  }
  // 若 agent 带了正文且 session 尚空，先写入真源
  if (content && ev.sessionId) {
    const cur = await inv<{ content?: string } | null>("plans.get", {
      sessionId: ev.sessionId,
    });
    if (cur.ok && !(cur.data?.content ?? "").trim()) {
      await inv("plans.write", { sessionId: ev.sessionId, content });
    }
  }
  planPhase = "active";
  syncPermLabels();
  await openPlanPanel({
    requestId: ev.requestId,
    seedContent: content || null,
    forceReload: true,
  });
  showToast("请在右侧「计划」面板审阅并批准", "info");
}

// ── Boot ───────────────────────────────────────────────────

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
    // 计划不进分类轨；仅 /view-plan · chip · exit_plan 打开
  });
  bindPlanPanel();
  bindCodeCopyDelegate($("transcript"));
  bindFileLinkDelegate($("transcript"), async (filePath, line) => {
    // Codex：点路径 → 侧栏预览（非默认外开）
    await sidePane?.openFile(filePath, line);
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
      if (tryEnqueueFromComposer()) return;
      void cancelTurn();
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
  renderAttachmentChips();
  renderGoalBanner();

  $("btn-model").onclick = (e) => {
    e.stopPropagation();
    const menu = $("model-menu");
    if (!menu.classList.contains("hidden") && menu.dataset.anchor === "btn-model") {
      hideModelMenu();
      return;
    }
    menu.dataset.anchor = "btn-model";
    void showModelMenu($("btn-model"));
  };
  $("btn-model-2").onclick = (e) => {
    e.stopPropagation();
    const menu = $("model-menu");
    if (!menu.classList.contains("hidden") && menu.dataset.anchor === "btn-model-2") {
      hideModelMenu();
      return;
    }
    menu.dataset.anchor = "btn-model-2";
    void showModelMenu($("btn-model-2"));
  };
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
    if (turnActive) void cancelTurn();
    closePlanPanelOnSessionChange();
    activeThreadId = null;
    activeSessionId = null;
    setActiveCwd(null);
    // 新对话：chip 回到默认模型，不沿用上一会话
    applyDefaultToChip();
    stopContextPolling();
    lastContextUsage = null;
    syncContextLabels();
    // 新对话清会话目标条；compose 中的草稿不跨对话保留
    if (!goalComposeActive) {
      pendingGoalTitle = null;
      activeGoalTitle = null;
      userOptedInGoal = false;
      goalStartedAt = null;
      goalElapsedFrozenMs = 0;
      goalPaused = false;
    }
    endTurn();
    showWelcome(true);
    renderGoalBanner();
    ($("composer-input") as HTMLTextAreaElement).focus();
  };

  $("btn-context").onclick = () => {
    void showContextDetails();
  };
  $("btn-search").onclick = () => void showSearchModal();
  $("btn-plugins").onclick = () => void showPluginsPage();
  $("btn-automations").onclick = () => void showAutomationsModal();
  $("btn-settings").onclick = () => void showSettingsPage();
  $("btn-modal-close").onclick = () => closeModal();
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) closeModal();
  };

  // 左侧栏展开 / 收起
  const LS_SIDEBAR = "grok.desktop.sidebarCollapsed";
  const applyLeftSidebar = (collapsed: boolean) => {
    const app = document.getElementById("app");
    const expandBtn = document.getElementById("btn-sidebar-expand");
    app?.classList.toggle("sidebar-collapsed", collapsed);
    expandBtn?.classList.toggle("hidden", !collapsed);
    expandBtn?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    try {
      localStorage.setItem(LS_SIDEBAR, collapsed ? "1" : "0");
    } catch {
      /* ignore */
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

  $("btn-add-project").onclick = () => void pickAndAddProject();

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

  $("btn-open-location").onclick = async () => {
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

  $("btn-sandbox-setup").onclick = () => {
    showPermMenu($("btn-sandbox-setup"));
  };
  $("btn-perm-mode").onclick = () => showPermMenu($("btn-perm-mode"));
  $("btn-perm-mode-2").onclick = () => showPermMenu($("btn-perm-mode-2"));
  document.addEventListener("click", (e) => {
    if (!isPermMenuVisible()) return;
    if (!(e.target as HTMLElement).closest("#perm-menu, #btn-perm-mode, #btn-perm-mode-2, #btn-sandbox-setup")) {
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
    // 欢迎页：busy 时停止；否则新会话
    if (turnActive) void cancelTurn();
    else void startNewChat();
  };
  $("btn-send-chat").onclick = () => {
    // 停止钮：始终取消当前 turn（队列保留，结束后继续发）
    // 若想清空队列：用排队条「清空」
    if (turnActive) {
      const chatIn = ($("chat-input") as HTMLTextAreaElement).value.trim();
      if (chatIn || composerAttachments.length) {
        // 有草稿时优先入队（对齐 Codex：发送=排队，停止需点空输入的 ■）
        if (tryEnqueueFromComposer()) return;
      }
      void cancelTurn();
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
      if (turnActive) {
        // 欢迎页进行中：有输入则入队，否则停止
        if (tryEnqueueFromComposer()) return;
        void cancelTurn();
      } else void startNewChat();
    }
  });
  $("chat-input").addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (handlePromptHistoryKey($("chat-input") as HTMLTextAreaElement, ke)) {
      return;
    }
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      if (turnActive) {
        if (tryEnqueueFromComposer()) return;
        void cancelTurn();
      } else void sendContinue();
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

  // 排队条：移除 / 编辑 / 上下移 / 清空 / 恢复发送
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
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
  });

  await refreshProjectsAndThreads();
  showWelcome(true);
}

void boot();
