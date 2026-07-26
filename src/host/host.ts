import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HostError, isHostError } from "../shared/errors.js";
import type { NormalizedEvent } from "../shared/events.js";
import type {
  Automation,
  ChangeSummary,
  DiffResult,
  GoalState,
  GrokInfo,
  HistoryPage,
  HunkTimelineEntry,
  InboxItem,
  ModelInfo,
  AccessMode,
  PermissionDecision,
  PlanState,
  Project,
  RosterEntry,
  SessionMode,
  SubagentNode,
  Thread,
  ThreadsCreateParams,
  ThreadsCreateResult,
  WorktreeInfo,
} from "../shared/types.js";
import { spawn } from "node:child_process";
import { AcpClient } from "./acp-client.js";
import { AutomationStore } from "./automations/index.js";
import {
  changesDiff,
  changesSummary,
  changesTimeline,
  openInEditor,
  openPath,
  openExternalUrl,
} from "./changes.js";
import { detectEditors, resolveEditorCommand } from "./editors.js";
import {
  listProjectDir,
  preparePromptImages,
  readFileDataUrl,
  readProjectFile,
  searchProjectFiles,
  sessionImageRoots,
  writePasteImage,
  writeProjectFile,
  type DirEntry,
  type FileReadResult,
  type FileSearchHit,
  type PromptImageAttachment,
} from "./files.js";
import {
  authLogout,
  authStatus,
  getDesktopConfigView,
  readDesktopConfig,
  writeDesktopConfig,
} from "./extensibility.js";
import {
  skillsListCli,
  type GrokCliRunner,
  PluginsFacade,
} from "./plugins/index.js";
import { COMPAT_DISABLED_ENV } from "./compat.js";
import { loadBtwHistory } from "./history/btw-history.js";
import {
  GoalsService,
  mapSubagentStatus,
  upsertSubagentNode,
  writeProjectionCache,
} from "./goals/index.js";
import { applyGoalUpdated } from "./session/goal-store.js";
import { InboxStore } from "./inbox.js";
import { HostLogger } from "./logger.js";
import {
  chatsWorkspaceDir,
  desktopDir,
  encodeCwdForSessionDir,
  ensureDesktopDirs,
  findSessionDir,
  grokHomeDir,
  sessionsRoot,
} from "./paths.js";
import { buildHistoryExportMarkdown } from "./history/export.js";
import {
  listCustomProviders,
  listRemoteModels,
  pingProvider,
  removeCustomProvider,
  setDefaultModelId,
  upsertCustomProvider,
  type UpsertProviderInput,
} from "./providers.js";
import { loadChatHistory } from "./history.js";
import { ProjectRegistry } from "./projects.js";
import { buildGrokInfo, type ResolveGrokOptions } from "./resolve-grok.js";
import {
  buildRoster,
  invalidateDiskRosterCache,
  isGoalInfraSession,
  readSessionMeta,
  sanitizeThreadTitle,
} from "./roster.js";
import { ThreadMetaStore } from "./thread-meta.js";
import { loadSessionContextUsage } from "./session/context.js";
import type { SessionContextUsage } from "../shared/types.js";
import {
  deriveSessionMode,
  legacyModeToPatch,
} from "./session/mode.js";
import { parseGrokModelsCliOutput } from "./models/catalog.js";
import { ModelsListService } from "./models/list-service.js";
import { sideQuestionIsolated } from "./session/btw-isolated.js";
import {
  acquireSingleInstance,
  type SingleInstanceHandle,
} from "./single-instance.js";
import { WorktreeService } from "./worktrees.js";
import {
  graphNeighborhood,
  graphSearch,
  graphStatus,
} from "./graph.js";
import {
  listMemoryFiles,
  memoryAdd,
  memoryAppendNote,
  memoryDelete,
  memoryDeleteFile,
  memoryEnvPatch,
  memoryList,
  memoryReadFile,
  memorySearch,
  memorySetEnabled,
  memoryStatus,
  type RememberScope,
} from "./memory.js";
import {
  buildVersionMatrix,
  computeTrayBadge,
  handoffFilePath,
  parseDeepLink,
  readAndClearHandoff,
  writeHandoff,
} from "./shell-state.js";
import { getPullRequestDiff, listPullRequests } from "./pr.js";
import {
  addRemoteProject,
  listRemoteProjects,
  removeRemoteProject,
} from "./remote.js";
import {
  applyRuntimeCapabilitySignal,
  BASELINE_CAPABILITIES,
} from "./capabilities.js";
import type { AttachState } from "./attach/policy.js";
import {
  DEFAULT_IDLE_DETACH,
  pickLruDetachTargets,
  type LiveAttachSnapshot,
} from "./attach/policy.js";
import { listDesktopHooks } from "./hooks-discover.js";
import {
  grantFolderTrust,
  revokeFolderTrust,
} from "./folder-trust.js";
import { hooksDir } from "./paths.js";
import {
  deleteQueueFile,
  loadQueue,
  type PromptQueueAttachment,
  type PromptQueueFile,
  type PromptQueueItem,
} from "./prompt-queue/queue.js";
import { PromptQueueService } from "./prompt-queue/service.js";
import {
  copySessionHistoryForFork,
  countHistoryLines,
  writeForkSummary,
} from "./fork-session.js";
import { buildTasksList } from "./tasks-list.js";
import {
  respondAskUserAcrossClients,
  respondPermissionAcrossClients,
} from "./permission/respond.js";
import {
  appendCreateSkillDesktopPathOverride,
  SkillRegistry,
  SkillsOps,
  type SkillsResolveResult,
} from "./skills/index.js";

export interface DesktopHostOptions {
  home?: string;
  grokPath?: string | null;
  /** agent-bin / 安装包内置路径 */
  bundledPath?: string | null;
  agentArgs?: string[];
  env?: NodeJS.ProcessEnv;
  logger?: HostLogger;
}

interface LiveThread {
  thread: Thread;
  client: AcpClient | null;
  writable: boolean;
  /** agent 最近广告的 slash 命令（available_commands_update） */
  availableCommands?: import("../shared/events.js").AvailableCommandInfo[];
  availableTools?: string[];
  attachState: AttachState;
  lastAttachError?: string;
  attachedAtMs?: number;
  lastActiveAtMs?: number;
  /** process snaps for tasks.list */
  taskSnaps?: Map<
    string,
    {
      taskId: string;
      sessionId?: string;
      phase: string;
      description?: string;
      command?: string;
      isMonitor?: boolean;
      success?: boolean;
      updatedAt?: number;
    }
  >;
}

type EventListener = (event: NormalizedEvent) => void;

/**
 * Desktop Host — S0–S4 product surface.
 * Vocabulary: Project / Thread / Worktree / Inbox / Automation.
 */
export class DesktopHost {
  private readonly logger: HostLogger;
  private readonly resolveOpts: ResolveGrokOptions;
  private readonly agentArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly home?: string;
  private threads = new Map<string, LiveThread>();
  private sessionIndex = new Map<string, string>();
  /** sessionId → in-flight attach Promise（去重并发 attach，避免双进程） */
  private attachInflight = new Map<string, Promise<{ threadId: string }>>();
  private listeners = new Set<EventListener>();
  private single: SingleInstanceHandle | null = null;
  private disposed = false;
  /** 侧栏文件树目录监听 */
  private fileTreeWatcher: fs.FSWatcher | null = null;
  private fileTreeWatchCwd: string | null = null;
  private fileTreeWatchTimer: ReturnType<typeof setTimeout> | null = null;
  /** handoff.json FS watch + optional consumer (main process) */
  private handoffWatcher: fs.FSWatcher | null = null;
  private handoffWatchTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffConsumer: (() => void) | null = null;
  /** Latest dynamic caps from any live agent initialize */
  private runtimeCaps = { ...BASELINE_CAPABILITIES };
  private idleDetachTimer: ReturnType<typeof setInterval> | null = null;

  readonly projects: ProjectRegistry;
  readonly inbox: InboxStore;
  readonly worktrees: WorktreeService;
  readonly automations: AutomationStore;
  readonly threadMeta: ThreadMetaStore;
  /** list/resolve 同集合（path-first；inspect → FS） */
  private readonly skillRegistry: SkillRegistry;
  private readonly skillsOps: SkillsOps;
  private readonly modelsListService: ModelsListService;
  private readonly promptQueue: PromptQueueService;
  private readonly goalsService: GoalsService;
  private readonly pluginsFacade: PluginsFacade;

  constructor(opts: DesktopHostOptions = {}) {
    this.home = opts.home;
    ensureDesktopDirs(opts.home);
    this.logger = opts.logger ?? new HostLogger(opts.home);
    // Agent / login 一律走 Desktop GROK_HOME，与 CLI ~/.grok 隔离
    const desktopGrokHome = grokHomeDir(opts.home);
    // 强制关闭 Claude/Cursor 兼容（env 优先于 config.toml）
    // GROK_MEMORY：对齐 CLI 实验跨会话 Memory（settings + config.toml 同源）
    this.env = {
      ...(opts.env ?? process.env),
      ...COMPAT_DISABLED_ENV,
      GROK_HOME: desktopGrokHome,
      ...memoryEnvPatch(opts.home),
    };
    this.agentArgs = opts.agentArgs ?? ["agent", "stdio"];
    const desktopCfg = readDesktopConfig(opts.home);
    this.resolveOpts = {
      overridePath: opts.grokPath ?? desktopCfg.grokPathOverride ?? null,
      bundledPath: opts.bundledPath,
      home: opts.home,
      env: this.env,
    };
    this.projects = new ProjectRegistry(opts.home);
    this.inbox = new InboxStore(opts.home);
    this.worktrees = new WorktreeService(opts.home);
    this.automations = new AutomationStore(opts.home);
    this.threadMeta = new ThreadMetaStore(opts.home);
    this.skillRegistry = new SkillRegistry({
      list: (projectPath) => skillsListCli(this.grokCliRunner(), projectPath),
    });
    this.skillsOps = new SkillsOps({
      home: opts.home,
      logger: this.logger,
      skillRegistry: this.skillRegistry,
    });
    this.modelsListService = new ModelsListService({
      home: opts.home,
      isAuthenticated: () => Boolean(authStatus(this.home).authenticated),
      fetchCliModels: () => this.modelsListUncachedAsync(),
    });
    this.promptQueue = new PromptQueueService({
      home: opts.home,
      logger: this.logger,
      threadIdForSession: (sid) => this.sessionIndex.get(sid),
      resolveWritableClient: (sid) => {
        const tid = this.sessionIndex.get(sid);
        if (!tid) return null;
        const live = this.threads.get(tid);
        if (!live?.client || !live.writable) return null;
        return live.client;
      },
      emit: (event) => this.emit(event),
    });
    this.goalsService = new GoalsService({
      home: opts.home,
      logger: this.logger,
      listPlanClients: () =>
        [...this.threads.values()].map((l) => l.client),
    });
    this.pluginsFacade = new PluginsFacade({
      grokCliRunner: () => this.grokCliRunner(),
      requireGrokCli: () => this.requireGrokCli(),
    });
    this.startIdleDetachLoop();
  }

  get logPath(): string {
    return this.logger.path;
  }

  async initSingleInstance(): Promise<{ isPrimary: boolean; port?: number }> {
    this.single = await acquireSingleInstance({
      home: this.home,
      onSecondaryPayload: (payload) => {
        this.logger.info("single_instance.secondary_payload", { payload });
        // FS already written by TCP layer; wake consumer (watch + main deliver)
        this.notifyHandoffConsumer();
      },
    });
    this.logger.info("single_instance", {
      isPrimary: this.single.isPrimary,
      port: this.single.port,
    });
    if (this.single.isPrimary) {
      this.automations.startScheduler((a) => {
        void this.runAutomation(a.id);
      });
    }
    return { isPrimary: this.single.isPrimary, port: this.single.port };
  }

  singleInstanceStatus(): { isPrimary: boolean; port?: number } {
    if (!this.single) return { isPrimary: true };
    return { isPrimary: this.single.isPrimary, port: this.single.port };
  }

  grokInfo(): GrokInfo {
    const base = buildGrokInfo(this.resolveOpts);
    // Prefer runtime caps from last initialize when agent is/was live
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        ...this.runtimeCaps,
        // Host-provided degraded features always on when binary present
        worktreeApi: Boolean(base.path) && true,
        hunkTimeline: Boolean(base.path) && true,
      },
    };
  }

  authStatus() {
    return authStatus(this.home);
  }

  /**
   * 启动 Desktop profile 登录：`GROK_HOME=~/.grok-desktop grok login …`
   * 不写入 CLI 的 ~/.grok/auth.json。
   */
  authLogin(opts?: { method?: "oauth" | "device-auth" }): {
    started: boolean;
    method: string;
    grokHome: string;
    message: string;
  } {
    const info = this.grokInfo();
    if (!info.path) {
      throw new HostError(
        "BINARY_NOT_FOUND",
        "grok binary not found — 请先安装 CLI 或配置路径",
      );
    }
    const method = opts?.method === "device-auth" ? "device-auth" : "oauth";
    const flag = method === "device-auth" ? "--device-auth" : "--oauth";
    const grokHome = grokHomeDir(this.home);
    fs.mkdirSync(grokHome, { recursive: true });
    const child = spawn(info.path, ["login", flag], {
      env: this.env,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    this.invalidateModelsListCache();
    this.logger.info("auth.login_started", { method, grokHome, pid: child.pid });
    return {
      started: true,
      method,
      grokHome,
      message:
        method === "device-auth"
          ? "已启动设备码登录（请查看新开终端/浏览器提示）"
          : "已启动 OAuth 登录（请在浏览器完成授权；完成后回到设置页刷新）",
    };
  }

  /**
   * 对齐 CLI `grok logout`：`GROK_HOME=~/.grok-desktop grok logout`
   * - 不碰 CLI `~/.grok/auth.json`
   * - 成功后 detach 所有 live agent，避免内存中仍握 OAuth token
   * - CLI 失败或 binary 缺失时回落为删除 Desktop auth.json
   * - CLI 用异步 spawn（禁止 spawnSync 堵主进程，否则设置关页后输入框无法聚焦）
   */
  async authLogout(): Promise<{
    cleared: boolean;
    wasLoggedIn: boolean;
    authPath: string;
    method: "cli" | "file" | "none";
    detachedThreadIds: string[];
    message: string;
    cliOutput?: string;
  }> {
    const before = authStatus(this.home);
    const wasLoggedIn = Boolean(before.authenticated);
    const authPath =
      before.authPath ?? path.join(grokHomeDir(this.home), "auth.json");
    const info = this.grokInfo();
    let method: "cli" | "file" | "none" = "none";
    let cliOutput = "";

    if (info.path) {
      try {
        const r = await this.runGrokCliAsync(info.path, ["logout"], 20_000);
        cliOutput = `${r.stdout}\n${r.stderr}`.trim();
        const cliOk = r.error == null && r.status === 0;
        if (cliOk) method = "cli";
        this.logger.info("auth.logout_cli", {
          status: r.status,
          signal: r.signal,
          error: r.error,
          output: cliOutput.slice(0, 500),
        });
      } catch (err) {
        this.logger.warn("auth.logout_cli_failed", { err: String(err) });
      }
    } else {
      this.logger.warn("auth.logout_no_binary", {});
    }

    // CLI 应已清盘；若 auth.json / lock 仍在则 Host 兜底删除（degraded）
    const stillOnDisk =
      fs.existsSync(authPath) || fs.existsSync(`${authPath}.lock`);
    let fileCleared = false;
    if (stillOnDisk) {
      const fb = authLogout(this.home);
      fileCleared = fb.cleared;
      if (fileCleared && method !== "cli") method = "file";
      if (fileCleared) {
        this.logger.info("auth.logout_file_fallback", {
          authPath,
          afterCli: method === "cli",
        });
      }
    }

    const after = authStatus(this.home);
    const cleared = wasLoggedIn && !after.authenticated;

    // 有过 Desktop 登录态（或刚清掉文件）则 detach live，避免旧 token 继续推理
    const detachedThreadIds: string[] = [];
    if (wasLoggedIn || fileCleared || method === "cli") {
      for (const tid of [...this.threads.keys()]) {
        const live = this.threads.get(tid);
        if (!live?.client) continue;
        try {
          await this.threadsDetach(tid);
          detachedThreadIds.push(tid);
        } catch (err) {
          this.logger.warn("auth.logout_detach_failed", {
            threadId: tid,
            err: String(err),
          });
        }
      }
    }

    this.invalidateModelsListCache();

    let message: string;
    if (!wasLoggedIn && !fileCleared && method === "none") {
      message = "当前未登录官方账户（Desktop profile 无 session）";
    } else if (!wasLoggedIn && method === "cli" && !fileCleared) {
      message = "无缓存 session 可退出（与 grok logout 一致）";
    } else if (detachedThreadIds.length > 0) {
      message = `已退出 Desktop 官方登录，并断开 ${detachedThreadIds.length} 个会话连接（历史仍保留）`;
    } else {
      message =
        method === "file"
          ? "已退出 Desktop 官方登录（文件兜底；未走完整 CLI 副作用）"
          : "已退出 Desktop 官方登录";
    }

    const res = {
      cleared: cleared || fileCleared,
      wasLoggedIn,
      authPath,
      method,
      detachedThreadIds,
      message,
      cliOutput: cliOutput || undefined,
    };
    this.logger.info("auth.logout", {
      cleared: res.cleared,
      wasLoggedIn,
      method,
      detached: detachedThreadIds.length,
    });
    return res;
  }

  providersList() {
    return listCustomProviders(this.home);
  }

  providersUpsert(input: UpsertProviderInput) {
    const res = upsertCustomProvider(input, this.home);
    this.invalidateModelsListCache();
    this.logger.info("providers.upsert", { id: input.id });
    return res;
  }

  providersRemove(id: string) {
    const res = removeCustomProvider(id, this.home);
    // 模型目录已变，作废缓存
    this.invalidateModelsListCache();
    const sid = (id ?? "").trim().toLowerCase();
    // 回退须在当前可见 catalog 内（未登录时不会落到官方幽灵 id）
    const fallback =
      this.resolveAvailableModel(res.defaultModel) || this.defaultModelId();
    // 磁盘 meta：会话仍记着已删 provider id → 改回默认（对齐 CLI reselect）
    let remappedSessions = 0;
    if (fallback) {
      const remapped = this.threadMeta.remapModels(
        (m) => m.trim().toLowerCase() === sid,
        fallback,
      );
      remappedSessions = remapped.updated;
      // 内存 live 线程同步
      for (const live of this.threads.values()) {
        const m = live.thread.model?.trim();
        if (m && m.toLowerCase() === sid) {
          live.thread.model = fallback;
        }
      }
    }
    this.logger.info("providers.remove", {
      id,
      fallback: fallback || null,
      remappedSessions,
    });
    return { ...res, remappedSessions };
  }

  providersSetDefault(modelId: string) {
    this.invalidateModelsListCache();
    return setDefaultModelId(modelId, this.home);
  }

  providersListRemoteModels(opts: {
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
  }) {
    return listRemoteModels(opts, this.home);
  }

  providersPing(opts: {
    baseUrl?: string;
    apiKey?: string;
    providerId?: string;
  }) {
    return pingProvider(opts, this.home);
  }

  configGet() {
    return getDesktopConfigView(this.home);
  }

  configPatch(patch: {
    defaultModel?: string;
    grokPathOverride?: string;
    alwaysApproveDefault?: boolean;
    defaultPermMode?: "always_approve" | "normal";
    defaultOpenTarget?: string;
    locale?: "zh-CN" | "en-US" | "system";
    theme?: "system" | "light" | "dark";
    idleDetachMs?: number;
    maxLiveAttaches?: number;
    busySendMode?: "queue" | "send_now";
    appearanceLight?: unknown;
    appearanceDark?: unknown;
    experimentalMemory?: boolean;
  }) {
    const view = writeDesktopConfig(patch as Parameters<typeof writeDesktopConfig>[0], this.home);
    if (patch.grokPathOverride !== undefined) {
      this.resolveOpts.overridePath = patch.grokPathOverride || null;
    }
    return view;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: NormalizedEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger.error("listener_error", { err: String(err) });
      }
    }
  }

  // ── Projects ─────────────────────────────────────────────

  projectsList(includeArchived = false): Project[] {
    return this.projects.list({ includeArchived });
  }

  projectsAdd(input: { path: string; title?: string; trust?: boolean }): Project {
    const p = this.projects.add(input);
    // L1：Desktop 项目信任 → agent folder-trust（项目 hooks / 项目 MCP 闸门）
    if (p.trust === "trusted") {
      grantFolderTrust(p.path, this.home);
    }
    return p;
  }

  projectsUpdate(
    id: string,
    patch: Partial<Pick<Project, "title" | "pinned" | "archived" | "trust">>,
  ): Project {
    const p = this.projects.update(id, patch);
    if (patch.trust !== undefined) {
      if (p.trust === "trusted") {
        grantFolderTrust(p.path, this.home);
      } else if (p.trust === "untrusted") {
        revokeFolderTrust(p.path, this.home);
      }
    }
    return p;
  }

  projectsRemove(id: string): void {
    this.projects.remove(id);
  }

  // ── Threads ──────────────────────────────────────────────

  /**
   * Live ACP threads + disk sessions under ~/.grok-desktop/sessions.
   * Disk rows use id `disk_<sessionId>` until attach creates a live thread.
   */
  listThreads(): Thread[] {
    const live = [...this.threads.values()].map((t) => ({ ...t.thread }));
    const roster = buildRoster({ home: this.home, liveThreads: live });
    const out: Thread[] = [];
    const seen = new Set<string>();

    for (const r of roster) {
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
      // 再滤一层：live 标题若像 goal 基建会话也隐藏
      if (isGoalInfraSession(r.title)) continue;
      const archived = this.threadMeta.isArchived(r.sessionId);
      const customTitle = this.threadMeta.getTitle(r.sessionId);
      const smeta = this.threadMeta.get(r.sessionId);
      // 「不使用项目」：不按 cwd 自动挂项目，侧栏归「对话」组
      let resolvedProjectId: string | undefined;
      if (smeta.noProject) {
        resolvedProjectId = undefined;
      } else {
        const projectId =
          r.projectId ?? this.projects.findByPath(r.cwd)?.id ?? undefined;
        resolvedProjectId = projectId;
        if (!resolvedProjectId) {
          const nCwd = path.resolve(r.cwd).toLowerCase().replace(/\\/g, "/");
          for (const p of this.projects.list({ includeArchived: true })) {
            const nP = path.resolve(p.path).toLowerCase().replace(/\\/g, "/");
            if (nCwd === nP || nCwd.startsWith(nP + "/")) {
              resolvedProjectId = p.id;
              break;
            }
          }
        }
      }
      const liveHit = live.find((t) => t.sessionId === r.sessionId);
      // fork 元数据：roster 磁盘行已带；live 行从 summary 补读
      let sessionKind = r.sessionKind ?? liveHit?.sessionKind;
      let parentSessionId = r.parentSessionId ?? liveHit?.parentSessionId;
      if (!sessionKind || !parentSessionId) {
        const sdir = findSessionDir(r.sessionId, this.home);
        if (sdir) {
          const diskMeta = readSessionMeta(sdir, r.sessionId, r.cwd);
          sessionKind = sessionKind ?? diskMeta.sessionKind;
          parentSessionId = parentSessionId ?? diskMeta.parentSessionId;
        }
      }
      const rawModel = liveHit?.model ?? smeta.model;
      out.push({
        id: r.threadId ?? `disk_${r.sessionId}`,
        sessionId: r.sessionId,
        projectId: resolvedProjectId,
        title: sanitizeThreadTitle(customTitle || r.title) || customTitle || r.title,
        cwd: r.cwd,
        status: r.status,
        // 展示/回填用「仍可用」的模型；幽灵 id 回退默认（不改写历史消息）
        model: this.resolveAvailableModel(rawModel),
        effort: liveHit?.effort ?? smeta.effort,
        // pin 以 thread-meta 为准（disk 会话也可置顶）
        pinned: smeta.pinned === true || r.pinned === true || liveHit?.pinned === true,
        archived,
        sessionKind,
        parentSessionId,
        createdAt:
          r.createdAt ||
          liveHit?.createdAt ||
          r.updatedAt,
        updatedAt: r.updatedAt,
      });
    }

    return out.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  /** 解析 threadId（live 或 disk_<sessionId>）→ sessionId + 可选 live */
  private resolveThreadRef(threadId: string): {
    threadId: string;
    sessionId: string;
    live: LiveThread | null;
  } {
    const live = this.threads.get(threadId);
    if (live) {
      return {
        threadId,
        sessionId: live.thread.sessionId,
        live,
      };
    }
    if (threadId.startsWith("disk_")) {
      const sessionId = threadId.slice("disk_".length);
      // 是否已有 live 附着同一 session
      const bySession = this.sessionIndex.get(sessionId);
      if (bySession) {
        const l = this.threads.get(bySession) ?? null;
        if (l) {
          return { threadId: bySession, sessionId, live: l };
        }
      }
      for (const [tid, l] of this.threads) {
        if (l.thread.sessionId === sessionId) {
          return { threadId: tid, sessionId, live: l };
        }
      }
      return { threadId, sessionId, live: null };
    }
    // 允许直接传 sessionId
    const bySession = this.sessionIndex.get(threadId);
    if (bySession) {
      const l = this.threads.get(bySession) ?? null;
      if (l) return { threadId: bySession, sessionId: threadId, live: l };
    }
    throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
  }

  private snapshotThread(
    ref: { threadId: string; sessionId: string; live: LiveThread | null },
    patch?: Partial<Thread>,
  ): Thread {
    if (ref.live) {
      return { ...ref.live.thread, ...patch };
    }
    const fromList = this.listThreads().find((t) => t.sessionId === ref.sessionId);
    if (fromList) return { ...fromList, ...patch };
    const now = new Date().toISOString();
    return {
      id: ref.threadId.startsWith("disk_") ? ref.threadId : `disk_${ref.sessionId}`,
      sessionId: ref.sessionId,
      title: ref.sessionId.slice(0, 8),
      cwd: "",
      status: "inactive",
      archived: this.threadMeta.isArchived(ref.sessionId),
      createdAt: now,
      updatedAt: now,
      ...patch,
    };
  }

  async threadsCreate(
    params: ThreadsCreateParams,
  ): Promise<ThreadsCreateResult> {
    this.assertNotDisposed();
    const noProject = params.noProject === true;
    let cwdInput = (params.cwd ?? "").toString().trim();
    if (noProject && !cwdInput) {
      const dir = chatsWorkspaceDir(this.home);
      fs.mkdirSync(dir, { recursive: true });
      cwdInput = dir;
    }
    if (!cwdInput) {
      throw new HostError("INVALID_ARGUMENT", "cwd required");
    }
    let cwd = path.resolve(cwdInput);
    if (!fs.existsSync(cwd)) {
      throw new HostError("IO_ERROR", `cwd does not exist: ${cwd}`);
    }

    // Project trust gate（noProject 强制不挂项目）
    let projectId = noProject ? undefined : params.projectId;
    if (!noProject && !projectId) {
      const found = this.projects.findByPath(cwd);
      if (found) projectId = found.id;
    }
    if (projectId) {
      const proj = this.projects.get(projectId);
      if (proj && proj.trust === "untrusted") {
        throw new HostError(
          "NOT_TRUSTED",
          `Project not trusted: ${proj.title}. Trust it in Projects first.`,
        );
      }
      if (proj) {
        cwd = path.resolve(
          cwdInput.startsWith(proj.path) ? cwdInput : proj.path,
        );
        this.projects.touch(projectId);
      }
    }

    let worktreeId: string | undefined;
    if (params.worktree?.mode === "create_new") {
      if (!projectId) {
        const added = this.projects.add({ path: cwd, trust: true });
        projectId = added.id;
      }
      const proj = this.projects.get(projectId)!;
      const wt = this.worktrees.create({
        projectId,
        projectPath: proj.path,
        name: params.worktree.name,
      });
      cwd = wt.path;
      worktreeId = wt.id;
    } else if (params.worktree?.mode === "attach_existing" && params.worktree.path) {
      cwd = path.resolve(params.worktree.path);
      worktreeId = params.worktree.name;
    }

    const info = this.grokInfo();
    if (!info.path) {
      throw new HostError(
        "BINARY_NOT_FOUND",
        "grok binary not found (agent-bin / override / PATH)",
      );
    }

    const cfg = this.configGet();
    // Explicit session mode/alwaysApprove always wins over desktop defaults.
    // (Previously alwaysApproveDefault could force YOLO even when mode=normal.)
    // Keep two dimensions: access mode × plan (align Grok Build; may both be true).
    let alwaysApprove: boolean;
    if (params.mode === "always_approve") {
      alwaysApprove = true;
    } else if (params.mode === "normal" || params.mode === "plan") {
      // mode=plan only arms plan; access still defaults unless alwaysApprove true.
      alwaysApprove = params.alwaysApprove === true;
    } else if (params.alwaysApprove === true) {
      alwaysApprove = true;
    } else if (params.alwaysApprove === false) {
      alwaysApprove = false;
    } else if (
      cfg.defaultPermMode === "always_approve" ||
      cfg.alwaysApproveDefault === true
    ) {
      alwaysApprove = true;
    } else {
      alwaysApprove = false;
    }
    const planActive =
      params.plan === true || params.mode === "plan";
    const accessMode: AccessMode = alwaysApprove ? "always_approve" : "normal";

    const threadId = `thread_${randomUUID()}`;
    const title = params.title ?? params.prompt?.slice(0, 80) ?? "New Thread";
    const now = new Date().toISOString();

    const thread: Thread = {
      id: threadId,
      sessionId: "",
      projectId,
      title,
      cwd,
      status: "idle",
      model: params.model ?? cfg.defaultModel,
      accessMode,
      planActive,
      mode: deriveSessionMode(accessMode, planActive),
      worktreeId,
      createdAt: now,
      updatedAt: now,
    };

    const client = new AcpClient({
      command: info.path,
      args: this.agentArgs,
      cwd,
      env: this.env,
      logger: this.logger,
      threadId,
      allowFs: true,
      onEvent: (ev) => this.onClientEvent(threadId, ev),
    });

    const nowMs = Date.now();
    this.threads.set(threadId, {
      thread,
      client,
      writable: true,
      attachState: "attaching",
      attachedAtMs: nowMs,
      lastActiveAtMs: nowMs,
      taskSnaps: new Map(),
    });
    this.emitAttachState(threadId, "", "attaching");

    try {
      await client.start();
      this.runtimeCaps = { ...this.runtimeCaps, ...client.capabilities };
      const meta: Record<string, unknown> = {};
      // Build：yolo 可在 plan 底下保持 armed
      if (alwaysApprove) meta.yoloMode = true;
      if (thread.model) meta.modelId = thread.model;
      if (planActive) meta.planMode = true;
      // 对齐 agent wire：meta.reasoningEffort（low|medium|high|xhigh）
      const effort = (params.effort ?? "").toString().trim().toLowerCase();
      if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
        meta.reasoningEffort = effort;
        thread.effort = effort;
      }
      // A8：max-turns（headless 同源语义；stdio 经 _meta 透传，agent 可忽略）
      const maxTurns = Number(params.maxTurns);
      if (Number.isFinite(maxTurns) && maxTurns >= 1) {
        meta.maxTurns = Math.floor(maxTurns);
      }

      const sessionId = await client.createSession({
        cwd,
        mcpServers: params.mcpServers,
        meta: Object.keys(meta).length ? meta : undefined,
      });

      thread.sessionId = sessionId;
      thread.updatedAt = new Date().toISOString();
      this.sessionIndex.set(sessionId, threadId);
      // 按会话持久化模型，供 openThread 回填 chip
      this.threadMeta.setSessionModel(sessionId, {
        model: thread.model,
        effort: thread.effort,
      });
      if (noProject) {
        this.threadMeta.setNoProject(sessionId, true);
      }
      if (worktreeId) this.worktrees.bindSession(worktreeId, sessionId);

      const live = this.threads.get(threadId);
      if (live) {
        live.attachState = "live";
        live.attachedAtMs = Date.now();
        live.lastActiveAtMs = Date.now();
      }
      this.emitAttachState(threadId, sessionId, "live");

      // planMode meta alone 不够：显式 session/set_mode，对齐 CLI /plan 激活
      if (planActive) {
        try {
          await client.setSessionMode("plan");
        } catch (err) {
          this.logger.warn("threads.create_plan_mode_failed", {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (params.prompt) {
        await client.prompt(params.prompt);
      }

      await this.enforceLiveAttachBudget();
      invalidateDiskRosterCache();
      this.logger.info("threads.create", { threadId, sessionId, cwd });
      return { threadId, sessionId, cwd, worktreeId };
    } catch (err) {
      await client.close().catch(() => undefined);
      // session/new 成功后失败：清索引，避免幽灵 sessionIndex → 死 threadId
      const sid = thread.sessionId;
      if (sid && this.sessionIndex.get(sid) === threadId) {
        this.sessionIndex.delete(sid);
      }
      this.threads.delete(threadId);
      throw this.wrap(err);
    }
  }

  async threadsAttach(
    sessionId: string,
    cwd: string,
  ): Promise<{ threadId: string }> {
    this.assertNotDisposed();
    const sid = sessionId.trim();
    if (!sid) {
      throw new HostError("INVALID_ARGUMENT", "sessionId required");
    }
    // 并发 attach 去重：同一 session 共用 in-flight Promise
    const inflight = this.attachInflight.get(sid);
    if (inflight) return inflight;

    const run = this.threadsAttachImpl(sid, cwd).finally(() => {
      if (this.attachInflight.get(sid) === run) {
        this.attachInflight.delete(sid);
      }
    });
    this.attachInflight.set(sid, run);
    return run;
  }

  private async threadsAttachImpl(
    sessionId: string,
    cwd: string,
  ): Promise<{ threadId: string }> {
    const existingThreadId = this.sessionIndex.get(sessionId);
    if (existingThreadId) {
      const live = this.threads.get(existingThreadId);
      if (live?.writable && live.client?.isAlive()) {
        return { threadId: existingThreadId };
      }
    }
    for (const [tid, live] of this.threads) {
      if (
        live.thread.sessionId === sessionId &&
        live.writable &&
        live.client?.isAlive()
      ) {
        this.sessionIndex.set(sessionId, tid);
        return { threadId: tid };
      }
    }

    const info = this.grokInfo();
    if (!info.path) {
      throw new HostError("BINARY_NOT_FOUND", "grok binary not found");
    }

    const threadId = existingThreadId ?? `thread_${randomUUID()}`;
    const resolvedCwd = path.resolve(cwd);
    const now = new Date().toISOString();

    const client = new AcpClient({
      command: info.path,
      args: this.agentArgs,
      cwd: resolvedCwd,
      env: this.env,
      logger: this.logger,
      threadId,
      allowFs: true,
      onEvent: (ev) => this.onClientEvent(threadId, ev),
    });

    const smeta = this.threadMeta.get(sessionId);
    const resolvedModel = this.resolveAvailableModel(smeta.model);
    // 幽灵 model 写回 meta，避免下次仍读到已删 id
    if (smeta.model && smeta.model !== resolvedModel) {
      this.threadMeta.setSessionModel(sessionId, { model: resolvedModel });
    }
    const thread: Thread =
      this.threads.get(threadId)?.thread ??
      ({
        id: threadId,
        sessionId,
        title: `Resume ${sessionId.slice(0, 8)}`,
        cwd: resolvedCwd,
        status: "idle",
        model: resolvedModel,
        effort: smeta.effort,
        createdAt: now,
        updatedAt: now,
      } satisfies Thread);
    thread.model = resolvedModel;
    if (smeta.effort) thread.effort = smeta.effort;

    // 覆盖旧 client 前先关掉，避免双进程孤儿
    const prev = this.threads.get(threadId);
    if (prev?.client && prev.client !== client) {
      await prev.client.close().catch(() => undefined);
    }

    this.threads.set(threadId, {
      thread,
      client,
      writable: true,
      attachState: "attaching",
      attachedAtMs: Date.now(),
      lastActiveAtMs: Date.now(),
      taskSnaps: new Map(),
    });
    this.sessionIndex.set(sessionId, threadId);
    this.emitAttachState(threadId, sessionId, "attaching");

    try {
      await client.start();
      this.runtimeCaps = { ...this.runtimeCaps, ...client.capabilities };
      await client.loadSession({ sessionId, cwd: resolvedCwd });
      // loadSession 会恢复磁盘上的 current_model_id；必须再 setModel，
      // 否则 UI/thread-meta 与 agent 实际采样模型不一致（如 meta=g2-grok-4.5
      // 而 session 仍是 grok-4.5 → 打到错误提供商 → 间歇性 INVALID_API_KEY）。
      if (resolvedModel) {
        try {
          await client.setModel(resolvedModel, {
            effort: smeta.effort,
          });
          thread.model = resolvedModel;
        } catch (err) {
          this.logger.warn("threads.attach_set_model_failed", {
            sessionId,
            modelId: resolvedModel,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      thread.sessionId = sessionId;
      thread.updatedAt = new Date().toISOString();
      thread.status = "idle";
      const liveOk = this.threads.get(threadId);
      if (liveOk) {
        liveOk.attachState = "live";
        liveOk.attachedAtMs = Date.now();
        liveOk.lastActiveAtMs = Date.now();
        liveOk.lastAttachError = undefined;
      }
      this.emitAttachState(threadId, sessionId, "live");
      await this.enforceLiveAttachBudget();
      this.logger.info("threads.attach", {
        threadId,
        sessionId,
        modelId: resolvedModel,
      });
      return { threadId };
    } catch (err) {
      await client.close().catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      this.threads.set(threadId, {
        thread: { ...thread, status: "failed" },
        client: null,
        writable: false,
        attachState: "failed",
        lastAttachError: msg,
        taskSnaps: new Map(),
      });
      this.emitAttachState(threadId, sessionId, "failed", msg);
      throw this.wrap(err);
    }
  }

  /**
   * 当前 live thread 的 agent 广告 slash（available_commands_update）。
   * 未附着或尚未收到广告时返回空列表。
   */
  threadsAvailableCommands(threadId: string): {
    sessionId: string;
    commands: import("../shared/events.js").AvailableCommandInfo[];
    tools?: string[];
  } {
    const live = this.threads.get(threadId);
    if (!live?.thread.sessionId) {
      throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    }
    return {
      sessionId: live.thread.sessionId,
      commands: live.availableCommands ?? [],
      tools: live.availableTools,
    };
  }

  async threadsDetach(threadId: string): Promise<void> {
    const live = this.threads.get(threadId);
    if (!live) {
      throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    }
    live.attachState = "detaching";
    this.emitAttachState(
      threadId,
      live.thread.sessionId,
      "detaching",
    );
    if (live.client) await live.client.close();
    live.client = null;
    live.writable = false;
    live.attachState = "history_only";
    live.thread.status = "inactive";
    live.thread.updatedAt = new Date().toISOString();
    // 释放队列 drain 锁，避免 take 后未 complete 时永久卡死
    if (live.thread.sessionId) {
      this.releaseQueueDrainLock(live.thread.sessionId);
    }
    this.emitAttachState(
      threadId,
      live.thread.sessionId,
      "history_only",
    );
  }

  /**
   * Ping live attach: process alive + writable. On failure mark failed.
   */
  threadsPing(threadId: string): {
    ok: boolean;
    state: AttachState;
    sessionId: string;
    alive: boolean;
    /** session/prompt 是否仍在飞（切回 rehydrate 真源） */
    promptInFlight?: boolean;
    threadStatus?: string;
  } {
    const live = this.threads.get(threadId);
    if (!live) {
      throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    }
    const sessionId = live.thread.sessionId;
    if (!live.client || !live.writable) {
      return {
        ok: false,
        state: live.attachState,
        sessionId,
        alive: false,
        promptInFlight: false,
        threadStatus: live.thread.status,
      };
    }
    const alive = live.client.isAlive();
    if (!alive) {
      live.writable = false;
      live.client = null;
      live.attachState = "failed";
      live.lastAttachError = "Agent process not alive";
      live.thread.status = "failed";
      this.emitAttachState(threadId, sessionId, "failed", live.lastAttachError);
      return {
        ok: false,
        state: "failed",
        sessionId,
        alive: false,
        promptInFlight: false,
        threadStatus: "failed",
      };
    }
    live.lastActiveAtMs = Date.now();
    live.attachState = "live";
    return {
      ok: true,
      state: "live",
      sessionId,
      alive: true,
      promptInFlight: live.client.isPromptInFlight(),
      threadStatus: live.thread.status,
    };
  }

  threadsAttachState(
    threadIdOrSession: { threadId?: string; sessionId?: string },
  ): {
    threadId?: string;
    sessionId: string;
    state: AttachState;
    lastError?: string;
    attachedAt?: string;
    lastActiveAt?: string;
    /** 是否仍有 in-flight session/prompt */
    promptInFlight?: boolean;
    threadStatus?: string;
  } {
    let live: LiveThread | undefined;
    if (threadIdOrSession.threadId) {
      live = this.threads.get(threadIdOrSession.threadId);
    } else if (threadIdOrSession.sessionId) {
      const tid = this.sessionIndex.get(threadIdOrSession.sessionId);
      if (tid) live = this.threads.get(tid);
    }
    if (!live) {
      return {
        sessionId: threadIdOrSession.sessionId ?? "",
        state: "history_only",
        promptInFlight: false,
        threadStatus: "idle",
      };
    }
    // refresh failed if process died
    if (live.writable && live.client && !live.client.isAlive()) {
      this.threadsPing(live.thread.id);
      live = this.threads.get(live.thread.id) ?? live;
    }
    return {
      threadId: live.thread.id,
      sessionId: live.thread.sessionId,
      state: live.attachState,
      lastError: live.lastAttachError,
      attachedAt: live.attachedAtMs
        ? new Date(live.attachedAtMs).toISOString()
        : undefined,
      lastActiveAt: live.lastActiveAtMs
        ? new Date(live.lastActiveAtMs).toISOString()
        : undefined,
      promptInFlight: live.client?.isPromptInFlight() ?? false,
      threadStatus: live.thread.status,
    };
  }

  async threadsStop(threadId: string): Promise<void> {
    const live = this.threads.get(threadId);
    if (!live) throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    try {
      if (live.client) await live.client.cancel();
    } catch {
      /* ignore */
    }
    await this.threadsDetach(threadId);
  }

  threadsRename(threadId: string, title: string): Thread {
    const ref = this.resolveThreadRef(threadId);
    if (!ref.sessionId) {
      throw new HostError("SESSION_NOT_FOUND", `Thread has no sessionId: ${threadId}`);
    }
    const t = title.trim();
    if (!t) throw new HostError("INVALID_ARGUMENT", "Title is empty");
    this.threadMeta.setTitle(ref.sessionId, t);
    // 尽量写入 summary.json，便于 CLI 侧也能看到
    try {
      const dir = findSessionDir(ref.sessionId, this.home);
      if (dir) {
        const summaryPath = path.join(dir, "summary.json");
        let summary: Record<string, unknown> = {};
        if (fs.existsSync(summaryPath)) {
          try {
            summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<
              string,
              unknown
            >;
          } catch {
            summary = {};
          }
        }
        summary.title = t;
        summary.generated_title = t;
        summary.updated_at = new Date().toISOString();
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
      }
    } catch {
      /* ignore disk title write */
    }
    const now = new Date().toISOString();
    if (ref.live) {
      ref.live.thread.title = t;
      ref.live.thread.updatedAt = now;
    }
    invalidateDiskRosterCache();
    this.logger.info("threads.rename", {
      threadId: ref.threadId,
      sessionId: ref.sessionId,
      title: t,
    });
    return this.snapshotThread(ref, { title: t, updatedAt: now });
  }

  /** 将会话历史导出为 Markdown 文本（供保存对话框） */
  threadsExportMarkdown(threadId: string): {
    title: string;
    sessionId: string;
    markdown: string;
  } {
    const ref = this.resolveThreadRef(threadId);
    if (!ref.sessionId) {
      throw new HostError("SESSION_NOT_FOUND", `Thread has no sessionId: ${threadId}`);
    }
    const snap = this.snapshotThread(ref);
    const hist = this.historyLoad(ref.sessionId);
    const title = snap.title || ref.sessionId.slice(0, 8);
    return {
      title,
      sessionId: ref.sessionId,
      markdown: buildHistoryExportMarkdown(
        {
          title,
          sessionId: ref.sessionId,
          cwd: snap.cwd,
        },
        hist.entries,
      ),
    };
  }

  threadsPin(threadId: string, pinned: boolean): Thread {
    const ref = this.resolveThreadRef(threadId);
    if (!ref.sessionId) {
      throw new HostError(
        "SESSION_NOT_FOUND",
        `Thread has no sessionId: ${threadId}`,
      );
    }
    this.threadMeta.setPinned(ref.sessionId, pinned);
    const now = new Date().toISOString();
    if (ref.live) {
      ref.live.thread.pinned = pinned;
      ref.live.thread.updatedAt = now;
    }
    this.logger.info("threads.pin", {
      threadId: ref.threadId,
      sessionId: ref.sessionId,
      pinned,
    });
    return this.snapshotThread(ref, { pinned, updatedAt: now });
  }

  threadsArchive(threadId: string, archived: boolean): Thread {
    const ref = this.resolveThreadRef(threadId);
    if (!ref.sessionId) {
      throw new HostError("SESSION_NOT_FOUND", `Thread has no sessionId: ${threadId}`);
    }
    this.threadMeta.setArchived(ref.sessionId, archived);
    const now = new Date().toISOString();
    if (ref.live) {
      ref.live.thread.archived = archived;
      ref.live.thread.updatedAt = now;
    }
    this.logger.info("threads.archive", {
      threadId: ref.threadId,
      sessionId: ref.sessionId,
      archived,
    });
    return this.snapshotThread(ref, { archived, updatedAt: now });
  }

  /**
   * 永久删除会话：停止 live 附着、删除本机 session 目录、清理元数据。
   * 不影响项目设置与其它会话。
   */
  async threadsDelete(threadId: string): Promise<{ deleted: true; sessionId: string }> {
    const ref = this.resolveThreadRef(threadId);
    if (!ref.sessionId) {
      throw new HostError("SESSION_NOT_FOUND", `Thread has no sessionId: ${threadId}`);
    }

    // 停掉可写附着
    if (ref.live?.client) {
      try {
        await ref.live.client.cancel().catch(() => undefined);
      } catch {
        /* ignore */
      }
      await ref.live.client.close().catch(() => undefined);
    }
    if (ref.live) {
      this.threads.delete(ref.live.thread.id);
    }
    // 清理所有指向该 session 的索引 / live 残留
    for (const [tid, live] of [...this.threads.entries()]) {
      if (live.thread.sessionId === ref.sessionId) {
        if (live.client) await live.client.close().catch(() => undefined);
        this.threads.delete(tid);
      }
    }
    this.sessionIndex.delete(ref.sessionId);
    this.attachInflight.delete(ref.sessionId);
    this.releaseQueueDrainLock(ref.sessionId);
    deleteQueueFile(ref.sessionId, this.home);

    const sessionDir = findSessionDir(ref.sessionId, this.home);
    if (sessionDir) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (err) {
        throw new HostError(
          "INTERNAL",
          `Failed to delete session dir: ${sessionDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.threadMeta.remove(ref.sessionId);
    invalidateDiskRosterCache();
    this.logger.info("threads.delete", {
      threadId: ref.threadId,
      sessionId: ref.sessionId,
      sessionDir: sessionDir ?? null,
    });
    return { deleted: true, sessionId: ref.sessionId };
  }

  /**
   * 更新会话策略（对齐 Grok Build 两维模型）。
   * - `plan`：ACP session/set_mode plan|default
   * - `alwaysApprove`：本地 armed 标志；Host 对 permission.requested 自动放行
   * - 二者正交，可同时为 true（yolo armed underneath plan）
   *
   * 兼容旧调用：`mode: SessionMode` 仍可传，会映射到两维（会清掉未表达的维）。
   */
  async threadsSetMode(
    threadId: string,
    modeOrPatch:
      | SessionMode
      | {
          mode?: SessionMode;
          alwaysApprove?: boolean;
          plan?: boolean;
        },
  ): Promise<Thread> {
    const live = this.threads.get(threadId);
    if (!live) throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);

    const patch =
      typeof modeOrPatch === "string"
        ? legacyModeToPatch(modeOrPatch)
        : modeOrPatch.mode !== undefined &&
            modeOrPatch.alwaysApprove === undefined &&
            modeOrPatch.plan === undefined
          ? legacyModeToPatch(modeOrPatch.mode)
          : modeOrPatch;

    let access: AccessMode =
      live.thread.accessMode ??
      (live.thread.mode === "always_approve" ? "always_approve" : "normal");
    let planActive = live.thread.planActive ?? live.thread.mode === "plan";

    if (patch.alwaysApprove !== undefined) {
      access = patch.alwaysApprove ? "always_approve" : "normal";
    }
    if (patch.plan !== undefined) {
      planActive = patch.plan;
    }

    live.thread.accessMode = access;
    live.thread.planActive = planActive;
    live.thread.mode = deriveSessionMode(access, planActive);
    live.thread.updatedAt = new Date().toISOString();

    if (live.client && live.writable && patch.plan !== undefined) {
      try {
        await live.client.setSessionMode(planActive ? "plan" : "default");
      } catch (err) {
        this.logger.warn("threads.setMode_acp_failed", {
          threadId,
          planActive,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.logger.info("threads.setMode", {
      threadId,
      accessMode: access,
      planActive,
      mode: live.thread.mode,
    });
    return { ...live.thread };
  }

  /**
   * Fork（P1-D F2）：session/new → detach → copy history → re-attach load → optional directive.
   * Avoids race where a live empty session overwrites copied history.
   */
  async threadsFork(params: {
    sourceSessionId: string;
    cwd: string;
    projectId?: string;
    title?: string;
    model?: string;
    effort?: string;
    /** First user prompt on the child session */
    directive?: string;
    worktree?: ThreadsCreateParams["worktree"];
  }): Promise<
    ThreadsCreateResult & {
      parentSessionId: string;
      historyCopied: boolean;
      directiveSent?: boolean;
      /** 源会话有历史但复制失败/未复制时的说明 */
      historyCopyError?: string;
      /** 指定了 directive 但发送失败 */
      directiveError?: string;
      sourceHistoryLines?: number;
    }
  > {
    this.assertNotDisposed();
    const sourceId = params.sourceSessionId?.trim();
    if (!sourceId) {
      throw new HostError("INVALID_ARGUMENT", "sourceSessionId required");
    }
    const srcDir = findSessionDir(sourceId, this.home);
    if (!srcDir) {
      throw new HostError("SESSION_NOT_FOUND", `Source session not found: ${sourceId}`);
    }

    const sourceHistoryLines = countHistoryLines(srcDir);

    // 1) Create empty session (may create worktree via threadsCreate)
    const created = await this.threadsCreate({
      cwd: params.cwd,
      projectId: params.projectId,
      title: params.title,
      model: params.model,
      effort: params.effort,
      worktree: params.worktree,
    });

    // 2) Detach / close agent so disk copy is not racing a live empty session
    try {
      await this.threadsDetach(created.threadId);
    } catch (err) {
      this.logger.warn("threads.fork_detach_failed", { err: String(err) });
    }

    // 3) Ensure dest dir and copy history
    let destDir = findSessionDir(created.sessionId, this.home);
    if (!destDir) {
      destDir = path.join(
        sessionsRoot(this.home),
        encodeCwdForSessionDir(created.cwd || params.cwd),
        created.sessionId,
      );
      fs.mkdirSync(destDir, { recursive: true });
    }
    let historyCopied = false;
    let historyCopyError: string | undefined;
    try {
      const copy = copySessionHistoryForFork(srcDir, destDir);
      historyCopied = copy.historyCopied;
      writeForkSummary({
        destDir,
        sessionId: created.sessionId,
        parentSessionId: sourceId,
        cwd: created.cwd || params.cwd,
        title: params.title,
        sourceSummaryPath: path.join(srcDir, "summary.json"),
      });
      if (sourceHistoryLines > 0 && !historyCopied) {
        historyCopyError =
          copy.missing.length > 0
            ? `missing: ${copy.missing.join(", ")}`
            : "history not copied";
        this.logger.warn("threads.fork_history_missing", {
          sourceId,
          sourceHistoryLines,
          missing: copy.missing,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      historyCopyError = msg;
      this.logger.warn("threads.fork_copy_failed", { err: msg });
      // 源有历史却复制异常：仍继续建分支，但向上返回错误说明
      if (sourceHistoryLines > 0 && !historyCopyError) {
        historyCopyError = msg;
      }
    }

    // 4) Re-attach via session/load
    let liveThreadId = created.threadId;
    try {
      const att = await this.threadsAttach(
        created.sessionId,
        created.cwd || params.cwd,
      );
      liveThreadId = att.threadId;
    } catch (err) {
      this.logger.warn("threads.fork_reattach_failed", { err: String(err) });
      throw this.wrap(err);
    }

    // 5) Optional first directive prompt
    let directiveSent = false;
    let directiveError: string | undefined;
    const directive = params.directive?.trim();
    if (directive) {
      try {
        await this.turnsPrompt(liveThreadId, directive);
        directiveSent = true;
      } catch (err) {
        directiveError = err instanceof Error ? err.message : String(err);
        this.logger.warn("threads.fork_directive_failed", {
          err: directiveError,
        });
      }
    }

    invalidateDiskRosterCache();
    this.logger.info("threads.fork", {
      sourceSessionId: sourceId,
      sessionId: created.sessionId,
      historyCopied,
      directiveSent,
      historyCopyError,
      directiveError,
      sourceHistoryLines,
    });

    return {
      threadId: liveThreadId,
      sessionId: created.sessionId,
      cwd: created.cwd,
      worktreeId: created.worktreeId,
      parentSessionId: sourceId,
      historyCopied,
      directiveSent,
      historyCopyError,
      directiveError,
      sourceHistoryLines,
    };
  }

  async threadsRewindPoints(threadId: string): Promise<{
    sessionId: string;
    rewindPoints: Array<{
      promptIndex: number;
      createdAt?: string;
      numFileSnapshots?: number;
      hasFileChanges?: boolean;
      promptPreview?: string;
    }>;
  }> {
    const live = this.requireWritable(threadId);
    const res = await live.client!.rewindPoints();
    return {
      sessionId: live.thread.sessionId,
      rewindPoints: res.rewind_points.map((p) => ({
        promptIndex: p.prompt_index,
        createdAt: p.created_at,
        numFileSnapshots: p.num_file_snapshots,
        hasFileChanges: p.has_file_changes,
        promptPreview: p.prompt_preview,
      })),
    };
  }

  /**
   * 预览回退（force=false）：agent dry-run，success 恒为 false，返回 conflicts/clean。
   */
  async threadsRewindPreview(
    threadId: string,
    params: { targetPromptIndex: number },
  ): Promise<{
    success: boolean;
    targetPromptIndex: number;
    mode?: string;
    revertedFiles: string[];
    cleanFiles: string[];
    conflicts: Array<{ path?: string; conflictType?: string }>;
    promptText?: string;
    error?: string;
    sessionId: string;
  }> {
    const live = this.requireWritable(threadId);
    const res = await live.client!.rewindExecute(params.targetPromptIndex, {
      force: false,
    });
    return {
      success: res.success,
      targetPromptIndex: res.target_prompt_index,
      mode: res.mode,
      revertedFiles: res.reverted_files ?? [],
      cleanFiles: (res as { clean_files?: string[] }).clean_files ?? [],
      conflicts: (res.conflicts ?? []).map((c) => ({
        path: c.path,
        conflictType: c.conflict_type,
      })),
      promptText: res.prompt_text,
      error: res.error,
      sessionId: live.thread.sessionId,
    };
  }

  /**
   * 执行回退。默认 mode=all（对话+文件）；
   * conversation_only：只砍 agent 上下文（Stop 后隔离用，不改文件）。
   * force=true 才真正执行。
   */
  async threadsRewind(
    threadId: string,
    params: {
      targetPromptIndex: number;
      force?: boolean;
      mode?: "all" | "conversation_only" | "files_only";
    },
  ): Promise<{
    success: boolean;
    targetPromptIndex: number;
    mode?: string;
    revertedFiles: string[];
    conflicts: Array<{ path?: string; conflictType?: string }>;
    promptText?: string;
    error?: string;
    sessionId: string;
  }> {
    const live = this.requireWritable(threadId);
    // agent：force=false 只预览；真正执行必须 force=true
    const force = params.force !== false;
    const mode = params.mode ?? "all";
    const res = await live.client!.rewindExecute(params.targetPromptIndex, {
      force,
      mode,
    });
    this.logger.info("threads.rewind", {
      threadId,
      sessionId: live.thread.sessionId,
      targetPromptIndex: params.targetPromptIndex,
      force,
      mode,
      success: res.success,
      reverted: res.reverted_files?.length ?? 0,
      error: res.error,
    });
    if (!res.success) {
      throw new HostError(
        "INTERNAL",
        res.error ||
          (res.conflicts?.length
            ? `回退存在冲突（${res.conflicts.length} 个文件）`
            : "回退失败"),
        res,
      );
    }
    live.thread.updatedAt = new Date().toISOString();
    return {
      success: true,
      targetPromptIndex: res.target_prompt_index,
      mode: res.mode,
      revertedFiles: res.reverted_files ?? [],
      conflicts: (res.conflicts ?? []).map((c) => ({
        path: c.path,
        conflictType: c.conflict_type,
      })),
      promptText: res.prompt_text,
      sessionId: live.thread.sessionId,
    };
  }

  async threadsSetModel(
    threadId: string,
    params: { modelId: string; effort?: string },
  ): Promise<{ modelId: string; effort?: string; sessionId: string }> {
    const live = this.requireWritable(threadId);
    const modelId = (params.modelId ?? "").trim();
    if (!modelId) {
      throw new HostError("INVALID_ARGUMENT", "modelId is required");
    }
    const effort = params.effort?.toString().trim().toLowerCase();
    await live.client!.setModel(modelId, {
      effort:
        effort && ["low", "medium", "high", "xhigh"].includes(effort)
          ? effort
          : undefined,
    });
    live.thread.model = modelId;
    if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
      live.thread.effort = effort;
    }
    live.thread.updatedAt = new Date().toISOString();
    if (live.thread.sessionId) {
      this.threadMeta.setSessionModel(live.thread.sessionId, {
        model: modelId,
        effort: live.thread.effort,
      });
    }
    this.logger.info("threads.setModel", {
      threadId,
      sessionId: live.thread.sessionId,
      modelId,
      effort: effort || undefined,
    });
    return {
      modelId,
      effort: effort || undefined,
      sessionId: live.thread.sessionId,
    };
  }

  /**
   * 杀后台任务：ACP `_x.ai/task/kill`（对齐 CLI pager KillBgTask）。
   */
  async threadsKillTask(
    threadId: string,
    taskId: string,
  ): Promise<{ sessionId: string; taskId: string; outcome: string }> {
    const live = this.requireWritable(threadId);
    const result = await live.client!.killTask(taskId);
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.killTask", {
      threadId,
      sessionId: live.thread.sessionId,
      taskId: result.taskId,
      outcome: result.outcome,
    });
    return {
      sessionId: live.thread.sessionId,
      taskId: result.taskId,
      outcome: result.outcome,
    };
  }

  /**
   * 真压缩：ACP `_x.ai/compact_conversation`（非 turns.prompt 伪请求）。
   */
  async threadsCompact(
    threadId: string,
    params?: { userContext?: string },
  ): Promise<{ sessionId: string; ok: true }> {
    const live = this.requireWritable(threadId);
    const userContext = params?.userContext?.trim() || undefined;
    await live.client!.compactConversation(userContext);
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.compact", {
      threadId,
      sessionId: live.thread.sessionId,
      hasUserContext: Boolean(userContext),
    });
    return { sessionId: live.thread.sessionId, ok: true };
  }

  /**
   * 会话信息（model / turns / ContextInfo）：ACP `_x.ai/session/info`。
   * 需 live 附着；未附着时抛 NOT_ATTACHED。
   */
  async threadsSessionInfo(threadId: string): Promise<{
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
    const live = this.requireWritable(threadId);
    const info = await live.client!.sessionInfo();
    return info;
  }

  /**
   * `/btw` 旁路侧问（`_x.ai/btw`）：不打断 turn、不进主对话。
   *
   * Desktop 注意：agent 的 btw 会快照**父会话**全文再采样。主 turn 正在讲
   * 「解释操作系统」时，短问「今天日期」常被上下文带偏（落盘 btw_history 已是
   * 错答，非 UI 串线）。CLI 同场景正常时，Desktop 在 busy 下改走**独立短会话**
   * 侧问（不改 agent 源码），idle 仍走父会话以保留上下文侧问能力。
   */
  async threadsBtw(
    threadId: string,
    question: string,
  ): Promise<{ sessionId: string; answer: string }> {
    const live = this.requireWritable(threadId);
    const q = question.trim();
    if (!q) {
      throw new HostError("INVALID_ARGUMENT", "btw question is empty");
    }
    const parentSessionId = live.thread.sessionId;
    // 主 turn 进行中：父会话 btw 快照含未完成 OS 长文等，短问易被带偏；
    // 且与主采样并发时 Desktop 上复现率高。独立进程侧问避开两者。
    const busy =
      live.client!.isPromptInFlight() || live.thread.status === "working";
    const answer = busy
      ? await this.sideQuestionIsolated(live, q)
      : await live.client!.sideQuestion(q);
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.btw", {
      threadId,
      sessionId: parentSessionId,
      qLen: q.length,
      aLen: answer.length,
      isolated: busy,
      qPreview: q.slice(0, 48),
      aPreview: answer.replace(/\s+/g, " ").slice(0, 96),
    });
    return { sessionId: parentSessionId, answer };
  }

  /**
   * 主 turn busy 时：另起一个 agent stdio + session/new，只发侧问，避免父会话
   * 对话快照劫持答案。用完即关，不写主会话 chat_history。
   */
  private async sideQuestionIsolated(
    live: LiveThread,
    question: string,
  ): Promise<string> {
    const info = this.grokInfo();
    if (!info.path) {
      throw new HostError("BINARY_NOT_FOUND", "grok binary not found");
    }
    return sideQuestionIsolated({
      command: info.path,
      agentArgs: this.agentArgs,
      cwd: live.thread.cwd || process.cwd(),
      env: this.env,
      logger: this.logger,
      modelId: live.thread.model,
      effort: live.thread.effort,
      parentSessionId: live.thread.sessionId,
      question,
    });
  }

  /**
   * 中途插话（`_x.ai/interject`）：插入当前 turn，不取消。
   */
  async threadsInterject(
    threadId: string,
    text: string,
    opts?: { interjectionId?: string },
  ): Promise<{ sessionId: string; status: string; interjectionId: string }> {
    const live = this.requireWritable(threadId);
    const r = await live.client!.interject(text, opts);
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.interject", {
      threadId,
      sessionId: live.thread.sessionId,
      status: r.status,
      interjectionId: r.interjectionId,
    });
    return {
      sessionId: live.thread.sessionId,
      status: r.status,
      interjectionId: r.interjectionId,
    };
  }

  /**
   * 发送一轮 prompt。
   * - content：用户文本（含 [Attachments] path 块 → agent 落盘 / 历史缩略图）
   * - attachments：图片 path 列表 → 复制到 session/images + ACP Image blocks
   */
  async turnsPrompt(
    threadId: string,
    content: string,
    opts?: { attachments?: PromptImageAttachment[] },
  ): Promise<{
    sent: true;
    imageCount: number;
    skippedImages?: Array<{ path: string; reason: string }>;
    resolvedImages?: Array<{ originalPath: string; sessionPath: string }>;
  }> {
    const live = this.requireWritable(threadId);
    live.thread.updatedAt = new Date().toISOString();
    const text = content ?? "";
    const atts = opts?.attachments ?? [];
    const imageAtts = atts.filter(
      (a) => !a.kind || a.kind === "image" || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(a.path || ""),
    );

    if (!imageAtts.length) {
      await live.client!.prompt(text);
      return { sent: true, imageCount: 0 };
    }

    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    if (live.thread.cwd) roots.push(live.thread.cwd);

    let prepared;
    try {
      prepared = preparePromptImages({
        attachments: imageAtts,
        sessionId: live.thread.sessionId,
        cwd: live.thread.cwd,
        roots,
        home: this.home,
      });
    } catch (err) {
      this.logger.warn("turns.prompt_images_prepare_failed", {
        threadId,
        sessionId: live.thread.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      // 落盘失败时降级为纯文本（仍带 path 块），避免整轮发送失败
      await live.client!.prompt(text);
      return {
        sent: true,
        imageCount: 0,
        skippedImages: imageAtts.map((a) => ({
          path: a.path,
          reason: err instanceof Error ? err.message : "prepare failed",
        })),
      };
    }

    // 历史缩略图：把正文里的 original path 换成 session path（parseUserHistoryPayload 仍认 - image:）
    let historyText = text;
    for (const r of prepared.resolved) {
      if (r.originalPath && r.sessionPath && r.originalPath !== r.sessionPath) {
        historyText = historyText.split(r.originalPath).join(r.sessionPath);
      }
    }

    const blocks: Array<Record<string, unknown>> = [
      { type: "text", text: historyText },
      ...prepared.imageBlocks,
    ];
    await live.client!.prompt(blocks);

    if (prepared.skipped.length) {
      this.logger.warn("turns.prompt_images_skipped", {
        threadId,
        sessionId: live.thread.sessionId,
        skipped: prepared.skipped,
      });
    }
    this.logger.info("turns.prompt_images", {
      threadId,
      sessionId: live.thread.sessionId,
      imageCount: prepared.imageBlocks.length,
      skipped: prepared.skipped.length,
    });

    return {
      sent: true,
      imageCount: prepared.imageBlocks.length,
      skippedImages: prepared.skipped.length ? prepared.skipped : undefined,
      resolvedImages: prepared.resolved.map((r) => ({
        originalPath: r.originalPath,
        sessionPath: r.sessionPath,
      })),
    };
  }

  async turnsCancel(
    threadId: string,
    opts?: { trigger?: string; cancelPromptId?: string },
  ): Promise<void> {
    const live = this.requireWritable(threadId);
    await live.client!.cancel({
      trigger: opts?.trigger,
      cancelPromptId: opts?.cancelPromptId,
    });
  }

  permissionsRespond(requestId: string, decision: PermissionDecision): void {
    respondPermissionAcrossClients(
      [...this.threads.values()].map((l) => l.client),
      requestId,
      decision,
      { markReadByRequestId: (rid) => this.inbox.markReadByRequestId(rid) },
    );
  }

  /**
   * 回答 ask_user_question（UI 选择题）。
   */
  askUserRespond(
    requestId: string,
    resp: {
      outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
      answers?: Record<string, string[]>;
      partialAnswers?: Record<string, string>;
    },
  ): void {
    respondAskUserAcrossClients(
      [...this.threads.values()].map((l) => l.client),
      requestId,
      resp,
    );
  }

  historyLoad(
    sessionId: string,
    opts?: import("../shared/types.js").HistoryLoadOptions,
  ): HistoryPage {
    return loadChatHistory(sessionId, this.home, opts);
  }

  /** 会话目录 btw_history.jsonl（旁路侧问落盘；与 chat_history 分离） */
  historyBtwLoad(
    sessionId: string,
    opts?: { maxEntries?: number },
  ): ReturnType<typeof loadBtwHistory> {
    return loadBtwHistory(sessionId, this.home, opts);
  }

  findSessionDir(sessionId: string): string | null {
    return findSessionDir(sessionId, this.home);
  }

  /** 会话上下文占用（读 ~/.grok-desktop/sessions/.../signals.json） */
  sessionContext(sessionId: string): SessionContextUsage {
    return loadSessionContextUsage(sessionId, this.home);
  }

  // ── Roster / Inbox ───────────────────────────────────────

  
  /**
   * 继续最近一次用户会话（CLI `-c` 语义）。
   * 跳过 subagent / goal 基建会话（roster 已过滤）；优先 live，否则取 disk 最近。
   */
  threadsContinueRecent(): {
    sessionId: string;
    cwd: string;
    title: string;
    threadId?: string;
  } | null {
    const list = this.listThreads().filter((t) => !t.archived);
    if (!list.length) return null;
    // listThreads 已按 updatedAt 降序
    const top = list[0]!;
    return {
      sessionId: top.sessionId,
      cwd: top.cwd,
      title: top.title,
      threadId: top.id.startsWith("disk_") ? undefined : top.id,
    };
  }

  rosterList(): RosterEntry[] {
    return buildRoster({
      home: this.home,
      liveThreads: this.listThreads(),
    });
  }

  inboxList(filter?: { unreadOnly?: boolean }): InboxItem[] {
    return this.inbox.list(filter);
  }

  inboxMarkRead(id: string): void {
    this.inbox.markRead(id);
  }

  inboxMarkAllRead(): void {
    this.inbox.markAllRead();
  }

  inboxDismiss(id: string): void {
    this.inbox.dismiss(id);
  }

  // ── Worktrees / Changes ──────────────────────────────────

  worktreesList(projectId?: string): WorktreeInfo[] {
    return this.worktrees.list(projectId);
  }

  worktreesCreate(projectId: string, name?: string): WorktreeInfo {
    const proj = this.projects.get(projectId);
    if (!proj) throw new HostError("INVALID_ARGUMENT", `Unknown project: ${projectId}`);
    return this.worktrees.create({
      projectId,
      projectPath: proj.path,
      name,
    });
  }

  worktreesCleanup(worktreeId: string, force?: boolean): void {
    const active = this.listThreads()
      .filter(
        (t) =>
          t.status === "working" ||
          t.status === "needs_input" ||
          t.status === "blocked",
      )
      .map((t) => t.sessionId);
    this.worktrees.cleanup(worktreeId, { force, activeSessionIds: active });
  }

  changesSummary(cwd: string): ChangeSummary {
    return changesSummary(cwd);
  }

  changesDiff(cwd: string, filePath: string): DiffResult {
    return changesDiff(cwd, filePath);
  }

  changesTimeline(cwd: string): HunkTimelineEntry[] {
    return changesTimeline(cwd);
  }

  systemOpenInEditor(filePath: string, line?: number, editor?: string): void {
    // editor 可为 id（code/cursor）或绝对路径；未传则用设置 defaultOpenTarget
    const target =
      editor?.trim() ||
      (this.configGet().defaultOpenTarget !== "explorer"
        ? this.configGet().defaultOpenTarget
        : undefined);
    const cmd =
      resolveEditorCommand(target) ||
      process.env.GROK_DESKTOP_EDITOR?.trim() ||
      null;
    if (!cmd) {
      throw new HostError(
        "IO_ERROR",
        "未检测到可用编辑器（VS Code / Cursor 等）。请安装并确保 code/cursor 在 PATH 中，或在设置中选择「文件资源管理器」。",
      );
    }
    openInEditor(filePath, line, cmd);
  }

  async systemOpenPath(
    targetPath: string,
    opts?: { createDir?: boolean },
  ): Promise<void> {
    await openPath(targetPath, opts);
  }

  /** 探测本机编辑器，供设置「打开位置」下拉 */
  systemListEditors() {
    return {
      editors: detectEditors(),
      openTarget: this.configGet().defaultOpenTarget ?? "explorer",
    };
  }

  async systemOpenExternal(url: string): Promise<void> {
    await openExternalUrl(url);
  }

  /** 侧栏预览：读项目内文件 */
  filesRead(opts: {
    path: string;
    cwd?: string;
    maxBytes?: number;
  }): FileReadResult {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    return readProjectFile({
      path: opts.path,
      cwd: opts.cwd,
      roots,
      maxBytes: opts.maxBytes,
    });
  }

  /** 侧栏编辑保存 */
  filesWrite(opts: {
    path: string;
    content: string;
    cwd?: string;
  }): { absPath: string; bytes: number } {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    return writeProjectFile({
      path: opts.path,
      content: opts.content,
      cwd: opts.cwd,
      roots,
    });
  }

  /** 剪贴板粘贴图片落盘（无 path 的 Blob） */
  filesWritePasteImage(opts: { base64: string; mime?: string }): {
    path: string;
    name: string;
    bytes: number;
  } {
    return writePasteImage({
      base64: opts.base64,
      mime: opts.mime,
      home: this.home,
    });
  }

  /** 本地图片 → data URL（输入框缩略图 / 大图预览） */
  filesReadDataUrl(opts: {
    path: string;
    maxBytes?: number;
    cwd?: string;
    /** 当前会话 id：允许读 session/images 下的历史图 */
    sessionId?: string;
  }): {
    dataUrl: string;
    mime: string;
    bytes: number;
  } {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    roots.push(...sessionImageRoots(opts.sessionId, this.home));
    return readFileDataUrl({
      path: opts.path,
      cwd: opts.cwd,
      maxBytes: opts.maxBytes,
      roots,
      home: this.home,
    });
  }

  /** 文件树：列一层目录 */
  filesList(opts: {
    path?: string;
    cwd?: string;
  }): { absPath: string; path: string; entries: DirEntry[] } {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    return listProjectDir({
      path: opts.path,
      cwd: opts.cwd,
      roots,
    });
  }

  /** @ 引用：项目内模糊搜文件 */
  filesSearch(opts: {
    cwd: string;
    query?: string;
    limit?: number;
    dirsOnly?: boolean;
    includeHidden?: boolean;
  }): { cwd: string; hits: FileSearchHit[] } {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
    return searchProjectFiles({
      cwd: opts.cwd,
      query: opts.query,
      limit: opts.limit,
      dirsOnly: opts.dirsOnly,
      includeHidden: opts.includeHidden,
      roots: roots.length ? roots : [opts.cwd],
    });
  }

  /**
   * 侧栏文件树：监听项目 cwd（recursive，失败则退回非递归）。
   * 变更经防抖后推送 files.changed。
   */
  filesWatchStart(cwd: string): { watching: boolean; cwd: string } {
    const abs = path.resolve(cwd);
    if (this.fileTreeWatchCwd === abs && this.fileTreeWatcher) {
      return { watching: true, cwd: abs };
    }
    this.filesWatchStop();
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new HostError("IO_ERROR", `Directory not found: ${abs}`);
    }
    const onChange = () => this.scheduleFileTreeChanged(abs);
    try {
      this.fileTreeWatcher = fs.watch(abs, { recursive: true }, onChange);
    } catch {
      try {
        this.fileTreeWatcher = fs.watch(abs, onChange);
      } catch {
        return { watching: false, cwd: abs };
      }
    }
    this.fileTreeWatcher.on("error", () => {
      this.filesWatchStop();
    });
    this.fileTreeWatchCwd = abs;
    return { watching: true, cwd: abs };
  }

  filesWatchStop(): { stopped: boolean } {
    if (this.fileTreeWatchTimer) {
      clearTimeout(this.fileTreeWatchTimer);
      this.fileTreeWatchTimer = null;
    }
    if (this.fileTreeWatcher) {
      try {
        this.fileTreeWatcher.close();
      } catch {
        /* ignore */
      }
      this.fileTreeWatcher = null;
    }
    this.fileTreeWatchCwd = null;
    return { stopped: true };
  }

  private scheduleFileTreeChanged(cwd: string): void {
    if (this.fileTreeWatchTimer) clearTimeout(this.fileTreeWatchTimer);
    this.fileTreeWatchTimer = setTimeout(() => {
      this.fileTreeWatchTimer = null;
      if (this.disposed || this.fileTreeWatchCwd !== cwd) return;
      this.emit({ type: "files.changed", cwd });
    }, 350);
  }

  // ── Goals / Plans / Subagents ────────────────────────────

  /**
   * 返回当前 session goal 投影（优先内存 store，否则 null）。
   * 兼容旧 GoalState 形状；完整字段在 projection。
   */
  goalsGet(sessionId: string): GoalState | null {
    return this.goalsService.get(sessionId);
  }

  /**
   * @deprecated 本地写非权威。控制面应发 `/goal` slash。
   * 保留 IPC 兼容：仅写草稿缓存，不抬 harness 投影。
   */
  goalsSet(sessionId: string, title: string, status?: GoalState["status"]): GoalState {
    return this.goalsService.set(sessionId, title, status);
  }

  /**
   * @deprecated 本地 setStatus 非权威；pause/resume 应 `/goal pause|resume`。
   */
  goalsSetStatus(sessionId: string, status: GoalState["status"]): GoalState | null {
    return this.goalsService.setStatus(sessionId, status);
  }

  goalsClear(sessionId: string): { cleared: boolean } {
    return this.goalsService.clear(sessionId);
  }

  /**
   * 从 agent updates.jsonl bootstrap 投影（冷启动 / ACP 丢事件兜底）。
   * 仅当 jsonl 有 goal_updated 时建立投影。
   */
  goalsSync(sessionId: string) {
    return this.goalsService.sync(sessionId);
  }

  plansGet(sessionId: string): PlanState | null {
    return this.goalsService.plansGet(sessionId);
  }

  plansWrite(sessionId: string, content: string): PlanState {
    return this.goalsService.plansWrite(sessionId, content);
  }

  plansApprove(sessionId: string): PlanState {
    return this.goalsService.plansApprove(sessionId);
  }

  plansReject(sessionId: string): PlanState {
    return this.goalsService.plansReject(sessionId);
  }

  /**
   * 响应用户对 exit_plan_mode 审批：
   * approved | cancelled（带反馈）| abandoned
   */
  plansRespond(
    requestId: string,
    outcome: "approved" | "cancelled" | "abandoned",
    feedback?: string,
    sessionId?: string,
  ): { ok: true } {
    return this.goalsService.plansRespond(
      requestId,
      outcome,
      feedback,
      sessionId,
    );
  }

  subagentsTree(sessionId: string): SubagentNode[] {
    return this.goalsService.subagentsTree(sessionId);
  }

  // ── Automations ──────────────────────────────────────────

  automationsList(): Automation[] {
    return this.automations.list();
  }

  automationsCreate(
    input: Parameters<AutomationStore["create"]>[0],
  ): Automation {
    // Host-enforced: interval schedules cannot enable alwaysApprove.
    const schedule = String(input.schedule ?? "").trim();
    const isScheduled = /^every_\d+_minutes?$/i.test(schedule);
    return this.automations.create({
      ...input,
      schedule,
      alwaysApprove: isScheduled ? false : input.alwaysApprove === true,
    });
  }

  automationsUpdate(
    id: string,
    patch: Parameters<AutomationStore["update"]>[1],
  ): Automation {
    const next = { ...patch };
    const existing = this.automations.list().find((x) => x.id === id);
    const schedule = String(next.schedule ?? existing?.schedule ?? "").trim();
    const isScheduled = /^every_\d+_minutes?$/i.test(schedule);
    if (isScheduled) {
      next.alwaysApprove = false;
    } else if (next.alwaysApprove !== undefined) {
      next.alwaysApprove = next.alwaysApprove === true;
    }
    return this.automations.update(id, next);
  }

  automationsDelete(id: string): void {
    this.automations.delete(id);
  }

  automationsPause(id: string): Automation {
    return this.automations.pause(id);
  }

  automationsListRuns(automationId?: string) {
    return this.automations.listRuns(automationId);
  }

  async automationsRunNow(id: string): Promise<{ runId: string; sessionId?: string }> {
    return this.runAutomation(id);
  }

  private async runAutomation(
    id: string,
  ): Promise<{ runId: string; sessionId?: string }> {
    const a = this.automations.list().find((x) => x.id === id);
    if (!a) throw new HostError("INVALID_ARGUMENT", `Unknown automation: ${id}`);
    const proj = this.projects.get(a.projectId);
    if (!proj) throw new HostError("INVALID_ARGUMENT", "Automation project missing");

    const run = this.automations.recordRun({
      automationId: id,
      startedAt: new Date().toISOString(),
      status: "running",
    });

    try {
      let cwd = proj.path;
      if (a.worktreeMode === "new_worktree_each_run") {
        const wt = this.worktrees.create({
          projectId: proj.id,
          projectPath: proj.path,
        });
        cwd = wt.path;
      }
      // Scheduled (interval) runs never auto-approve — unattended YOLO is too risky.
      const isScheduled = /^every_\d+_minutes?$/i.test(String(a.schedule || "").trim());
      const alwaysApprove = isScheduled ? false : a.alwaysApprove === true;
      const created = await this.threadsCreate({
        cwd,
        projectId: proj.id,
        title: `Automation: ${a.name}`,
        prompt: a.prompt,
        alwaysApprove,
        model: a.model,
      });
      this.automations.finishRun(run.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        sessionId: created.sessionId,
        summary: "Run completed",
      });
      this.automations.update(id, { lastRunAt: new Date().toISOString() });
      this.inbox.add({
        type: "automation_result",
        title: `Automation finished: ${a.name}`,
        body: a.prompt.slice(0, 200),
        sessionId: created.sessionId,
        threadId: created.threadId,
        projectId: proj.id,
        automationRunId: run.id,
      });
      return { runId: run.id, sessionId: created.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.automations.finishRun(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: message,
      });
      this.inbox.add({
        type: "automation_result",
        title: `Automation failed: ${a.name}`,
        body: message,
        projectId: a.projectId,
        automationRunId: run.id,
      });
      throw this.wrap(err);
    }
  }

  // ── Extensibility（CLI 同源）──────────────────────────────

  private grokCliRunner(): GrokCliRunner | null {
    const info = this.grokInfo();
    if (!info.path) return null;
    return { binary: info.path, env: this.env as NodeJS.ProcessEnv, home: this.home };
  }

  private requireGrokCli(): GrokCliRunner {
    const r = this.grokCliRunner();
    if (!r) {
      throw new HostError(
        "BINARY_NOT_FOUND",
        "grok binary not found — 请先安装 CLI 或配置路径",
      );
    }
    return r;
  }

  /**
   * 列出 skills（单源 registry；与 resolve 同集合）。
   * force：绕过 TTL（插件页 Refresh / 创建后）。
   */
  skillsList(projectPath?: string, opts?: { force?: boolean }) {
    return this.skillRegistry.list(projectPath, Boolean(opts?.force));
  }

  skillsOpenPath(skillPath: string): { opened: boolean; path: string } {
    return this.skillsOps.openPath(skillPath);
  }

  /**
   * 删除磁盘上的 skill 目录（个人 / 项目）。
   * 系统内置（bundled）与插件 skill 拒绝删除。
   */
  skillsDelete(params: {
    path: string;
    name?: string;
    projectPath?: string;
  }): { deleted: boolean; path: string; name: string } {
    return this.skillsOps.delete(params);
  }

  /**
   * 从本地目录导入 skill → ~/.grok-desktop/skills/<name>/（复制，不移动）。
   * source 可为 skill 根目录（含 SKILL.md）或 SKILL.md 文件路径。
   */
  skillsImportFromDir(params: {
    sourcePath: string;
    force?: boolean;
  }): { name: string; path: string; overwritten: boolean } {
    return this.skillsOps.importFromDir(params);
  }

  pluginsList(projectPath?: string, opts?: { available?: boolean }) {
    return this.pluginsFacade.list(projectPath, opts);
  }

  pluginsInstall(source: string, opts?: { trust?: boolean }) {
    return this.pluginsFacade.install(source, opts);
  }

  pluginsUninstall(name: string, opts?: { confirm?: boolean; keepData?: boolean }) {
    return this.pluginsFacade.uninstall(name, opts);
  }

  pluginsEnable(name: string) {
    return this.pluginsFacade.enable(name);
  }

  pluginsDisable(name: string) {
    return this.pluginsFacade.disable(name);
  }

  pluginsUpdate(name?: string) {
    return this.pluginsFacade.update(name);
  }

  pluginsDetails(name: string) {
    return this.pluginsFacade.details(name);
  }

  pluginsMarketplaceList() {
    return this.pluginsFacade.marketplaceList();
  }

  pluginsMarketplaceAdd(url: string) {
    return this.pluginsFacade.marketplaceAdd(url);
  }

  pluginsMarketplaceRemove(url: string) {
    return this.pluginsFacade.marketplaceRemove(url);
  }

  pluginsMarketplaceUpdate(name?: string) {
    return this.pluginsFacade.marketplaceUpdate(name);
  }

  mcpList() {
    return this.pluginsFacade.mcpList();
  }

  mcpAdd(input: {
    name: string;
    commandOrUrl?: string;
    args?: string[];
    transport?: "stdio" | "http" | "sse";
    scope?: "user" | "project";
    env?: string[];
    headers?: string[];
    cwd?: string;
  }) {
    return this.pluginsFacade.mcpAdd(input);
  }

  mcpRemove(name: string, opts?: { scope?: "user" | "project"; cwd?: string }) {
    return this.pluginsFacade.mcpRemove(name, opts);
  }

  mcpDoctor(name?: string) {
    return this.pluginsFacade.mcpDoctor(name);
  }

  /** 作废模型目录缓存（登录/登出/提供商变更） */
  private invalidateModelsListCache(): void {
    this.modelsListService.invalidate();
  }

  /**
   * 异步跑 grok CLI 子进程（stdout/stderr 文本）。
   * 禁止在 ipcMain 路径用 spawnSync，否则会堵 Electron 主进程 → 输入框无法聚焦。
   */
  private runGrokCliAsync(
    binary: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: string;
  }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(binary, args, {
        env: this.env as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        settled = true;
        resolve({
          status: null,
          signal: "SIGTERM",
          stdout,
          stderr,
          error: `timeout after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: String(err),
        });
      });
      child.on("close", (status, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
  }

  /** 当前全局默认模型 id（必须在当前可见 catalog 内） */
  defaultModelId(): string {
    const list = this.modelsListSync();
    const fromToml = listCustomProviders(this.home).defaultModel?.trim();
    // config 默认仅当仍在可见列表中才采用（未登录时官方 default 不可用）
    if (fromToml && list.some((m) => m.id === fromToml)) return fromToml;
    const hit = list.find((m) => m.isDefault)?.id?.trim();
    if (hit) return hit;
    // 无可用模型时返回空串（勿回落幽灵官方 id）
    return list[0]?.id?.trim() || "";
  }

  /** 模型 id 是否仍在当前可见 catalog（含自定义提供商） */
  isModelAvailable(modelId: string | undefined | null): boolean {
    const id = (modelId ?? "").trim();
    if (!id) return false;
    const list = this.modelsListSync();
    if (list.some((m) => m.id === id)) return true;
    // 自定义提供商：未登录时仍可用（与 list 合并逻辑一致）
    try {
      const { providers } = listCustomProviders(this.home);
      if (providers.some((p) => p.id === id)) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * 对齐 CLI reselect_current_model_if_missing：
   * 已存 model 不在目录 → 回退默认（展示/发送用）。
   */
  resolveAvailableModel(modelId: string | undefined | null): string {
    const id = (modelId ?? "").trim();
    if (id && this.isModelAvailable(id)) return id;
    return this.defaultModelId();
  }

  /**
   * 同步读模型目录：仅用缓存 + 自定义提供商，**绝不** spawnSync。
   * 供 roster / attach 等热路径；官方表以最近一次异步 modelsList 为准。
   */
  modelsListSync(): ModelInfo[] {
    const { list, shouldBackgroundRefresh } = this.modelsListService.listSync();
    if (shouldBackgroundRefresh) {
      void this.modelsList({ force: true }).catch(() => undefined);
    }
    return list;
  }

  /**
   * 列出可用模型（`grok models` + config 自定义；默认缓存 5 分钟）。
   * - 真源：CLI 输出 + `[model.*]` base_url 提供商；**无硬编码幽灵官方表**
   * - 未官方登录：隐藏 `source=official`，只保留自定义中转；**不 spawn CLI**
   * - 已登录：CLI 异步 spawn；同世代并发单飞；invalidate 后不 join 旧 flight
   */
  async modelsList(opts?: { force?: boolean }): Promise<ModelInfo[]> {
    return this.modelsListService.list(opts);
  }

  /**
   * 异步解析 `grok models`。失败时返回空表（再由 merge 并入自定义提供商），
   * **禁止**硬编码官方模型表冒充 catalog。
   */
  private async modelsListUncachedAsync(): Promise<ModelInfo[]> {
    const info = this.grokInfo();
    if (!info.path) return [];
    try {
      const r = await this.runGrokCliAsync(info.path, ["models"], 12_000);
      if (r.error) {
        this.logger.warn("models.list_cli_failed", { error: r.error });
        return [];
      }
      return parseGrokModelsCliOutput(`${r.stdout}\n${r.stderr}`);
    } catch (err) {
      this.logger.warn("models.list_cli_exception", { err: String(err) });
      return [];
    }
  }

  // ── S5 Graph / Memory ────────────────────────────────────

  graphStatus(projectPath: string) {
    return graphStatus(projectPath);
  }

  graphSearch(projectPath: string, query: string, limit?: number) {
    return graphSearch(projectPath, query, limit);
  }

  graphNeighborhood(projectPath: string, fileRel: string, limit?: number) {
    return graphNeighborhood(projectPath, fileRel, limit);
  }

  memoryStatus() {
    return memoryStatus(this.home);
  }

  memoryList(cwd?: string) {
    return memoryList(this.home, cwd);
  }

  memorySearch(query: string, cwd?: string) {
    return memorySearch(query, this.home, cwd);
  }

  memoryBrowse(cwd?: string) {
    return listMemoryFiles(this.home, cwd);
  }

  memoryRead(filePath: string) {
    return memoryReadFile(filePath, this.home);
  }

  memoryAdd(input: {
    text: string;
    source?: string;
    sessionId?: string;
    tags?: string[];
  }) {
    return memoryAdd(input, this.home);
  }

  /**
   * 追加笔记到 Global/Workspace MEMORY.md。
   * 若 thread 可写且提供 rewrite，先走 ACP `x.ai/memory/rewrite`。
   */
  async memoryRemember(input: {
    text: string;
    scope?: RememberScope;
    cwd?: string;
    threadId?: string;
    rewrite?: boolean;
  }): Promise<{ path: string; scope: RememberScope; rewritten?: string }> {
    let note = input.text.trim();
    if (!note) throw new HostError("INVALID_ARGUMENT", "text is required");
    const scope: RememberScope = input.scope === "workspace" ? "workspace" : "global";
    let rewritten: string | undefined;
    if (input.rewrite && input.threadId) {
      const live = this.threads.get(input.threadId);
      if (live?.writable && live.client) {
        try {
          const r = await live.client.memoryRewrite(note);
          if (r.rewritten?.trim()) {
            rewritten = r.rewritten.trim();
            note = rewritten;
          }
        } catch (err) {
          this.logger.warn("memory.rewrite_failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const result = memoryAppendNote(note, scope, this.home, input.cwd);
    this.logger.info("memory.remember", {
      scope: result.scope,
      path: result.path,
      rewritten: Boolean(rewritten),
    });
    return { ...result, rewritten };
  }

  memoryDelete(id: string) {
    memoryDelete(id, this.home);
  }

  memoryDeletePath(filePath: string) {
    memoryDeleteFile(filePath, this.home);
  }

  memorySetEnabled(enabled: boolean) {
    const st = memorySetEnabled(enabled, this.home);
    // 刷新本进程后续 spawn 的 env（已活 agent 需 reattach）
    Object.assign(this.env, memoryEnvPatch(this.home));
    this.logger.info("memory.setEnabled", { enabled, grokMemory: this.env.GROK_MEMORY });
    return st;
  }

  /** ACP `x.ai/memory/flush` */
  async threadsMemoryFlush(threadId: string): Promise<{ sessionId: string; ok: true }> {
    const live = this.requireWritable(threadId);
    await live.client!.memoryFlush();
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.memoryFlush", {
      threadId,
      sessionId: live.thread.sessionId,
    });
    return { sessionId: live.thread.sessionId, ok: true };
  }

  /**
   * `/dream`：stdio agent 无独立 ext 时，经 prompt 触发 shell builtin 同源语义。
   * memory 未启用时 agent 会 no-op。
   */
  async threadsMemoryDream(threadId: string): Promise<{ sessionId: string; ok: true }> {
    const live = this.requireWritable(threadId);
    await live.client!.prompt("/dream");
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.memoryDream", {
      threadId,
      sessionId: live.thread.sessionId,
    });
    return { sessionId: live.thread.sessionId, ok: true };
  }

  // ── S6 shell ─────────────────────────────────────────────

  shellTrayBadge(opts?: { locale?: string } | string) {
    return computeTrayBadge(this.rosterList(), this.inboxList(), opts);
  }

  shellParseDeepLink(raw: string) {
    return parseDeepLink(raw);
  }

  shellVersionMatrix() {
    const info = this.grokInfo();
    return buildVersionMatrix({
      grokPath: info.path,
      grokVersion: info.version,
    });
  }

  shellReadHandoff() {
    return readAndClearHandoff(this.home);
  }

  shellWriteHandoff(payload: string) {
    writeHandoff(payload, this.home);
    this.notifyHandoffConsumer();
  }

  shellHandoffPath() {
    return handoffFilePath(this.home);
  }

  /**
   * Main registers a single consumer that read+deliver handoff (shows window).
   * FS watch and TCP secondary both call notifyHandoffConsumer → debounced.
   */
  shellSetHandoffConsumer(fn: (() => void) | null): void {
    this.handoffConsumer = typeof fn === "function" ? fn : null;
  }

  private notifyHandoffConsumer(): void {
    if (!this.handoffConsumer || this.disposed) return;
    if (this.handoffWatchTimer) clearTimeout(this.handoffWatchTimer);
    this.handoffWatchTimer = setTimeout(() => {
      this.handoffWatchTimer = null;
      if (this.disposed || !this.handoffConsumer) return;
      try {
        this.handoffConsumer();
      } catch (err) {
        this.logger.warn("handoff.consumer_error", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }, 50);
  }

  /**
   * Watch desktop dir for handoff.json. Returns { watching, path, mode }.
   * Falls back to polling if fs.watch fails.
   */
  shellStartHandoffWatch(): {
    watching: boolean;
    path: string;
    mode: "fs.watch" | "poll";
  } {
    this.shellStopHandoffWatch();
    const file = handoffFilePath(this.home);
    const dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      const base = path.basename(file);
      this.handoffWatcher = fs.watch(dir, (eventType, filename) => {
        const name =
          typeof filename === "string"
            ? filename
            : filename
              ? String(filename)
              : "";
        // On some platforms filename may be empty; still notify.
        if (name && name.toLowerCase() !== base.toLowerCase()) return;
        if (eventType === "rename" || eventType === "change" || !name) {
          this.notifyHandoffConsumer();
        }
      });
      this.handoffWatcher.on("error", (err) => {
        this.logger.warn("handoff.watch_error", {
          err: err instanceof Error ? err.message : String(err),
        });
        this.shellStopHandoffWatch();
      });
      this.logger.info("handoff.watch_start", { path: file, mode: "fs.watch" });
      // Drain any pending file from before watch attached
      this.notifyHandoffConsumer();
      return { watching: true, path: file, mode: "fs.watch" };
    } catch (err) {
      this.logger.warn("handoff.watch_unavailable", {
        err: err instanceof Error ? err.message : String(err),
      });
      return { watching: false, path: file, mode: "poll" };
    }
  }

  shellStopHandoffWatch(): void {
    if (this.handoffWatchTimer) {
      clearTimeout(this.handoffWatchTimer);
      this.handoffWatchTimer = null;
    }
    if (this.handoffWatcher) {
      try {
        this.handoffWatcher.close();
      } catch {
        /* ignore */
      }
      this.handoffWatcher = null;
    }
  }

  /** Secondary instance: notify primary with deep link / focus payload. */
  async shellNotifyPrimary(payload: string): Promise<boolean> {
    if (!this.single) await this.initSingleInstance();
    if (this.single?.isPrimary) {
      writeHandoff(payload, this.home);
      this.notifyHandoffConsumer();
      return true;
    }
    writeHandoff(payload, this.home);
    return (await this.single?.notifyPrimary(payload)) ?? false;
  }

  // ── S7 PR / Remote ───────────────────────────────────────

  prList(cwd: string, limit?: number) {
    return listPullRequests(cwd, limit);
  }

  prDiff(cwd: string, number: number, headRef?: string) {
    return getPullRequestDiff(cwd, number, headRef);
  }

  remoteList() {
    return listRemoteProjects(this.home);
  }

  remoteAdd(input: {
    title?: string;
    host: string;
    remotePath: string;
    localCwd: string;
  }) {
    return addRemoteProject(input, this.home);
  }

  remoteRemove(id: string) {
    removeRemoteProject(id, this.home);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleDetachTimer) {
      clearInterval(this.idleDetachTimer);
      this.idleDetachTimer = null;
    }
    this.filesWatchStop();
    this.shellStopHandoffWatch();
    this.handoffConsumer = null;
    this.automations.stopAllTimers();
    for (const [tid, live] of this.threads) {
      if (live.client) await live.client.close().catch(() => undefined);
      this.threads.delete(tid);
    }
    this.single?.release();
    this.single = null;
    this.logger.close();
  }

  private requireWritable(threadId: string): LiveThread {
    const live = this.threads.get(threadId);
    if (!live) {
      throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    }
    if (!live.writable || !live.client) {
      throw new HostError("NOT_ATTACHED", `Thread not writable: ${threadId}`);
    }
    if (!live.client.isAlive()) {
      live.writable = false;
      live.client = null;
      live.attachState = "failed";
      live.lastAttachError = "Agent process not alive";
      live.thread.status = "failed";
      this.emitAttachState(
        threadId,
        live.thread.sessionId,
        "failed",
        live.lastAttachError,
      );
      throw new HostError("NOT_ATTACHED", `Thread not writable: ${threadId}`);
    }
    live.lastActiveAtMs = Date.now();
    return live;
  }

  private emitAttachState(
    threadId: string,
    sessionId: string,
    state: AttachState,
    lastError?: string,
  ): void {
    this.emit({
      type: "session.attach_state",
      threadId,
      sessionId,
      state,
      lastError,
    });
  }

  private idleDetachConfig(): {
    idleDetachMs: number;
    maxLiveAttaches: number;
  } {
    const cfg = readDesktopConfig(this.home);
    return {
      idleDetachMs:
        typeof cfg.idleDetachMs === "number"
          ? cfg.idleDetachMs
          : DEFAULT_IDLE_DETACH.idleDetachMs,
      maxLiveAttaches:
        typeof cfg.maxLiveAttaches === "number"
          ? cfg.maxLiveAttaches
          : DEFAULT_IDLE_DETACH.maxLiveAttaches,
    };
  }

  private startIdleDetachLoop(): void {
    if (this.idleDetachTimer) return;
    this.idleDetachTimer = setInterval(() => {
      void this.enforceLiveAttachBudget().catch((err) =>
        this.logger.warn("idle_detach.tick_failed", { err: String(err) }),
      );
    }, 60_000);
    // unref if available (Node)
    try {
      (this.idleDetachTimer as NodeJS.Timeout).unref?.();
    } catch {
      /* ignore */
    }
  }

  private liveSnapshots(): LiveAttachSnapshot[] {
    const out: LiveAttachSnapshot[] = [];
    for (const [threadId, live] of this.threads) {
      if (!live.writable || !live.client) continue;
      out.push({
        threadId,
        sessionId: live.thread.sessionId,
        state: live.attachState === "live" ? "live" : live.attachState,
        attachedAt: live.attachedAtMs,
        lastActiveAt: live.lastActiveAtMs,
        working: live.thread.status === "working",
        hasPendingPermission: live.thread.status === "needs_input",
        hasRunningTask: Boolean(
          [...(live.taskSnaps?.values() ?? [])].some(
            (t) =>
              t.phase === "backgrounded" ||
              t.phase === "monitor" ||
              t.phase === "running",
          ),
        ),
        hasSendingQueueItem: loadQueue(live.thread.sessionId, this.home, {
          recoverOrphanSending: false,
        }).items.some((i) => i.status === "sending"),
      });
    }
    return out;
  }

  async enforceLiveAttachBudget(): Promise<string[]> {
    const cfg = this.idleDetachConfig();
    const targets = pickLruDetachTargets(this.liveSnapshots(), cfg, Date.now());
    for (const tid of targets) {
      try {
        await this.threadsDetach(tid);
        this.logger.info("idle_detach", { threadId: tid });
      } catch (err) {
        this.logger.warn("idle_detach_failed", {
          threadId: tid,
          err: String(err),
        });
      }
    }
    return targets;
  }

  // ── Prompt queue (L1 durable) → PromptQueueService ───────

  queueGet(sessionId: string): PromptQueueFile {
    return this.promptQueue.get(sessionId);
  }

  queueSet(sessionId: string, file: PromptQueueFile): PromptQueueFile {
    return this.promptQueue.set(sessionId, file);
  }

  queueEnqueue(
    sessionId: string,
    item: {
      display?: string;
      content: string;
      attachments?: PromptQueueAttachment[];
      id?: string;
    },
  ): PromptQueueFile {
    return this.promptQueue.enqueue(sessionId, item);
  }

  queueRemove(sessionId: string, itemId: string): PromptQueueFile {
    return this.promptQueue.remove(sessionId, itemId);
  }

  queueReorder(sessionId: string, orderedIds: string[]): PromptQueueFile {
    return this.promptQueue.reorder(sessionId, orderedIds);
  }

  queueUpdate(
    sessionId: string,
    itemId: string,
    patch: Partial<
      Pick<PromptQueueItem, "display" | "content" | "attachments" | "status" | "lastError">
    >,
  ): PromptQueueFile {
    return this.promptQueue.update(sessionId, itemId, patch);
  }

  queueClear(sessionId: string): PromptQueueFile {
    return this.promptQueue.clear(sessionId);
  }

  queueSetFlags(
    sessionId: string,
    flags: {
      queueingEnabled?: boolean;
      pausedByInterrupt?: boolean;
      syncError?: string | null;
    },
  ): PromptQueueFile {
    return this.promptQueue.setFlags(sessionId, flags);
  }

  /** 释放队列 drain 互斥（detach/delete/complete 共用） */
  private releaseQueueDrainLock(sessionId: string): void {
    this.promptQueue.releaseDrainLock(sessionId);
  }

  queueTakeNext(sessionId: string): {
    queue: PromptQueueFile;
    item: PromptQueueItem | null;
  } {
    return this.promptQueue.takeNext(sessionId);
  }

  queueCompleteSending(
    sessionId: string,
    itemId: string,
    ok: boolean,
    error?: string,
  ): PromptQueueFile {
    return this.promptQueue.completeSending(sessionId, itemId, ok, error);
  }

  // ── Tasks aggregate (P2-B) ────────────────────────────────

  tasksList(sessionId: string): ReturnType<typeof buildTasksList> {
    const tid = this.sessionIndex.get(sessionId);
    const live = tid ? this.threads.get(tid) : undefined;
    const snaps = live?.taskSnaps ? [...live.taskSnaps.values()] : [];
    return buildTasksList({
      sessionId,
      home: this.home,
      processSnaps: snaps,
      automations: this.automations.list(),
    });
  }

  // ── Hooks（运行时归 agent；Host 只做发现列表 + 目录入口 + folder-trust 桥）──

  hooksList(opts?: { projectPath?: string }): {
    hooks: Array<{
      id: string;
      name: string;
      path: string;
      scope: "user" | "project";
      trusted: boolean;
      source: string;
    }>;
    hooksDir: string;
    note?: string;
  } {
    return listDesktopHooks(this.home, {
      projectPath: opts?.projectPath,
    });
  }

  hooksReload(opts?: { projectPath?: string }): {
    ok: true;
    hooks: ReturnType<DesktopHost["hooksList"]>["hooks"];
    hooksDir: string;
  } {
    const list = this.hooksList(opts);
    return { ok: true, hooks: list.hooks, hooksDir: list.hooksDir };
  }

  /** 打开/创建 Desktop GROK_HOME/hooks */
  async hooksOpenDir(): Promise<{ ok: boolean; path: string }> {
    const dir = hooksDir(this.home);
    fs.mkdirSync(dir, { recursive: true });
    try {
      await openPath(dir, { createDir: true });
      return { ok: true, path: dir };
    } catch {
      return { ok: false, path: dir };
    }
  }

  // ── Skills resolve（path-first · 与 list 同 registry）──

  skillsResolve(
    name: string,
    cwd?: string,
    opts?: { args?: string; path?: string },
  ): SkillsResolveResult {
    const n = name.trim().replace(/^\//, "").replace(/^skill:/i, "");
    if (!n) {
      throw new HostError("INVALID_ARGUMENT", "skill name required");
    }
    const result = this.skillRegistry.resolve(n, cwd, {
      args: opts?.args,
      path: opts?.path,
    });
    // create-skill 官方文案写死 ~/.grok/skills；Desktop 强制覆盖 User 落盘路径
    if (result.mode === "resolved" && result.prompt) {
      result.prompt = appendCreateSkillDesktopPathOverride(
        n,
        result.prompt,
        path.join(grokHomeDir(this.home), "skills"),
      );
    }
    return result;
  }

  private onClientEvent(threadId: string, ev: NormalizedEvent): void {
    const live = this.threads.get(threadId);
    /** YOLO 自动批准成功时不向 UI 再弹 permission */
    let suppressEmit = false;
    if (live) {
      live.lastActiveAtMs = Date.now();
    }
    if (live && ev.type === "session.status") {
      live.thread.status = ev.status;
      live.thread.updatedAt = new Date().toISOString();
    }
    if (live && ev.type === "task.updated") {
      if (!live.taskSnaps) live.taskSnaps = new Map();
      live.taskSnaps.set(ev.taskId, {
        taskId: ev.taskId,
        sessionId: ev.sessionId,
        phase: ev.phase,
        description: ev.description,
        command: ev.command,
        isMonitor: ev.isMonitor || ev.phase === "monitor",
        success: ev.success,
        updatedAt: Date.now(),
      });
    }
    if (ev.type === "queue.changed") {
      this.runtimeCaps = applyRuntimeCapabilitySignal(
        this.runtimeCaps,
        "queue_changed",
      );
    }
    if (ev.type === "session.available_commands") {
      this.runtimeCaps = applyRuntimeCapabilitySignal(
        this.runtimeCaps,
        "available_commands",
      );
    }
    // YOLO 自动批准成功：不向 UI 再弹 permission 对话框
    if (ev.type === "permission.requested" && live) {
      // Build：always-approve 可在 plan 底下 armed；非 edit 类由 agent/yolo 或此处代批
      const yolo =
        live.thread.accessMode === "always_approve" ||
        live.thread.mode === "always_approve";
      if (yolo && live.client) {
        try {
          live.client.respondPermission(ev.requestId, "allow_once");
          this.logger.info("permission.auto_approved", {
            threadId,
            requestId: ev.requestId,
            planActive: live.thread.planActive,
          });
          suppressEmit = true;
        } catch (err) {
          this.logger.warn("permission.auto_approve_failed", {
            threadId,
            err: err instanceof Error ? err.message : String(err),
          });
          this.inbox.add({
            type: "permission",
            title: "Permission required",
            body: ev.summary,
            sessionId: ev.sessionId,
            threadId,
            requestId: ev.requestId,
            projectId: live.thread.projectId,
          });
        }
      } else {
        this.inbox.add({
          type: "permission",
          title: "Permission required",
          body: ev.summary,
          sessionId: ev.sessionId,
          threadId,
          requestId: ev.requestId,
          projectId: live.thread.projectId,
        });
      }
    }
    if (ev.type === "session.available_commands" && live) {
      live.availableCommands = ev.commands;
      if (ev.tools) live.availableTools = ev.tools;
      this.logger.debug("session.available_commands", {
        threadId,
        count: ev.commands.length,
        tools: ev.tools?.length,
      });
    }
    if (ev.type === "agent.error" && live) {
      // 崩溃：标记 failed 并释放 writable，便于用户再 attach（R4）
      const crashed = live.client;
      live.writable = false;
      live.client = null;
      live.attachState = "failed";
      live.lastAttachError = ev.message;
      live.thread.status = "failed";
      live.thread.updatedAt = new Date().toISOString();
      void crashed?.close().catch(() => undefined);
      this.emitAttachState(
        threadId,
        live.thread.sessionId,
        "failed",
        ev.message,
      );
      this.inbox.add({
        type: "agent_failed",
        title: "Agent error",
        body: ev.message,
        sessionId: live.thread.sessionId,
        threadId,
        projectId: live.thread.projectId,
      });
    }
    // agent goal_updated → session-goal-store（唯一投影真源；不对 tool 合成）
    if (ev.type === "goal.updated") {
      try {
        const result = applyGoalUpdated({
          sessionId: ev.sessionId,
          goalId: ev.goalId,
          objective: ev.objective,
          status: ev.status,
          phase: ev.phase,
          tokenBudget: ev.tokenBudget,
          tokensUsed: ev.tokensUsed,
          elapsedMs: ev.elapsedMs,
          lastEvent: ev.lastEvent,
          lastEventDetail: ev.lastEventDetail,
          message: ev.message,
          verifyingCompletion: ev.verifyingCompletion,
          planning: ev.planning,
          classifierRunsAttempted: ev.classifierRunsAttempted,
          classifierMaxRuns: ev.classifierMaxRuns,
          lastClassifierVerdict: ev.lastClassifierVerdict,
          lastClassifierDetailsPath: ev.lastClassifierDetailsPath,
          tokenBaseline: ev.tokenBaseline,
          finishedSubagentTokens: ev.finishedSubagentTokens,
          liveSubagentTokens: ev.liveSubagentTokens,
        });
        if (!result.dropped) {
          writeProjectionCache(ev.sessionId, result.projection, this.home);
          this.logger.debug("goal.apply", {
            sessionId: ev.sessionId,
            goalId: ev.goalId,
            status: ev.status,
            cleared: result.cleared,
          });
        } else {
          this.logger.debug("goal.drop_stale", {
            sessionId: ev.sessionId,
            goalId: ev.goalId,
            status: ev.status,
          });
        }
      } catch (err) {
        this.logger.warn("goal.project_failed", { err: String(err) });
      }
      const st = String(ev.status ?? "").toLowerCase();
      if (
        (st === "blocked" || st === "budget_limited" || st === "infra_paused") &&
        live
      ) {
        this.inbox.add({
          type: "goal_blocked",
          title:
            st === "budget_limited"
              ? "Goal budget limited"
              : st === "infra_paused"
                ? "Goal paused (rate limit / service)"
                : "Goal blocked",
          body:
            ev.message ||
            (st === "infra_paused"
              ? "Not marked complete — resume when ready"
              : ev.objective || "Goal needs attention"),
          sessionId: ev.sessionId,
          threadId,
          projectId: live.thread.projectId,
        });
      }
    }
    // subagent 生命周期 → subagents.json + 可选 Inbox
    if (ev.type === "subagent.updated") {
      try {
        const status = mapSubagentStatus(ev.status);
        const summaryParts: string[] = [];
        if (ev.description) summaryParts.push(ev.description);
        if (ev.phase === "progress") {
          if (ev.turnCount != null) summaryParts.push(`${ev.turnCount} turns`);
          if (ev.toolCallCount != null)
            summaryParts.push(`${ev.toolCallCount} tools`);
        }
        if (ev.error) summaryParts.push(ev.error);
        upsertSubagentNode(
          ev.parentSessionId || ev.sessionId,
          {
            id: ev.subagentId,
            type: ev.subagentType || "general-purpose",
            status,
            summary: summaryParts.filter(Boolean).join(" · ") || undefined,
            childSessionId: ev.childSessionId,
            updatedAt: new Date().toISOString(),
          },
          this.home,
        );
      } catch (err) {
        this.logger.warn("subagent.project_failed", { err: String(err) });
      }
      if (ev.phase === "finished" && live) {
        const st = ev.status.toLowerCase();
        if (st === "failed" || st === "error") {
          this.inbox.add({
            type: "agent_failed",
            title: "Subagent failed",
            body:
              ev.error ||
              ev.description ||
              `Subagent ${ev.subagentId.slice(0, 8)} failed`,
            sessionId: ev.sessionId,
            threadId,
            projectId: live.thread.projectId,
          });
        }
      }
    }
    // 后台任务 / monitor 完成 → Inbox（失败或可唤醒提示）
    if (ev.type === "task.updated") {
      try {
        if (
          ev.phase === "completed" &&
          live &&
          !ev.staleOnLoad &&
          ev.success === false
        ) {
          const label =
            ev.description ||
            ev.command ||
            `task ${ev.taskId.slice(0, 8)}`;
          this.inbox.add({
            type: ev.isMonitor ? "monitor_alert" : "agent_failed",
            title: ev.isMonitor ? "Monitor failed" : "Background task failed",
            body:
              (ev.signal ? `${label} (${ev.signal})` : label) +
              (ev.exitCode != null ? ` exit ${ev.exitCode}` : ""),
            sessionId: ev.sessionId,
            threadId,
            projectId: live.thread.projectId,
          });
        }
      } catch (err) {
        this.logger.warn("task.project_failed", { err: String(err) });
      }
    }
    if (!suppressEmit) this.emit(ev);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new HostError("INTERNAL", "Host is disposed");
  }

  private wrap(err: unknown): HostError {
    if (isHostError(err)) return err;
    if (err instanceof Error) return new HostError("INTERNAL", err.message);
    return new HostError("INTERNAL", String(err));
  }
}


