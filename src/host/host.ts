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
import { spawn, spawnSync } from "node:child_process";
import { AcpClient } from "./acp-client.js";
import { AutomationStore } from "./automations.js";
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
  readFileDataUrl,
  readProjectFile,
  searchProjectFiles,
  writePasteImage,
  writeProjectFile,
  type DirEntry,
  type FileReadResult,
  type FileSearchHit,
} from "./files.js";
import {
  authLogout,
  authStatus,
  getDesktopConfigView,
  readDesktopConfig,
  writeDesktopConfig,
} from "./extensibility.js";
import {
  marketplaceAdd as cliMarketplaceAdd,
  marketplaceListCli,
  marketplaceRemove as cliMarketplaceRemove,
  marketplaceUpdate as cliMarketplaceUpdate,
  mcpAddCli,
  mcpDoctorCli,
  mcpListCli,
  mcpRemoveCli,
  pluginsDetails as cliPluginsDetails,
  pluginsDisable as cliPluginsDisable,
  pluginsEnable as cliPluginsEnable,
  pluginsInstall as cliPluginsInstall,
  pluginsListCli,
  pluginsUninstall as cliPluginsUninstall,
  pluginsUpdate as cliPluginsUpdate,
  skillsListCli,
  type GrokCliRunner,
} from "./cli-plugins.js";
import { COMPAT_DISABLED_ENV } from "./compat.js";
import {
  applyAgentGoalProjection,
  clearGoal,
  loadGoal,
  loadPlan,
  loadSubagentTree,
  mapSubagentStatus,
  setGoalStatus,
  setPlanStatus,
  syncGoalFromAgentLog,
  upsertSubagentNode,
  writeGoal,
  writePlan,
} from "./goals.js";
import { InboxStore } from "./inbox.js";
import { HostLogger } from "./logger.js";
import {
  encodeCwdForSessionDir,
  ensureDesktopDirs,
  findSessionDir,
  grokHomeDir,
  sessionsRoot,
} from "./paths.js";
import {
  listCustomProviders,
  listRemoteModels,
  modelDisplayNamesFromConfig,
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
  isGoalInfraSession,
  readSessionMeta,
  sanitizeThreadTitle,
} from "./roster.js";
import { ThreadMetaStore } from "./thread-meta.js";
import { loadSessionContextUsage } from "./session-context.js";
import type { SessionContextUsage } from "../shared/types.js";

function isGoalInfraSessionTitle(title: string): boolean {
  return isGoalInfraSession(title);
}

function sanitizeListTitle(title: string): string {
  return sanitizeThreadTitle(title) || title;
}
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
  private listeners = new Set<EventListener>();
  private single: SingleInstanceHandle | null = null;
  private disposed = false;
  /** 侧栏文件树目录监听 */
  private fileTreeWatcher: fs.FSWatcher | null = null;
  private fileTreeWatchCwd: string | null = null;
  private fileTreeWatchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly projects: ProjectRegistry;
  readonly inbox: InboxStore;
  readonly worktrees: WorktreeService;
  readonly automations: AutomationStore;
  readonly threadMeta: ThreadMetaStore;

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
  }

  get logPath(): string {
    return this.logger.path;
  }

  async initSingleInstance(): Promise<{ isPrimary: boolean; port?: number }> {
    this.single = await acquireSingleInstance({
      home: this.home,
      onSecondaryPayload: (payload) => {
        this.logger.info("single_instance.secondary_payload", { payload });
        // FS handoff already written by TCP server; emit for in-process listeners
        this.emit({
          type: "session.status",
          threadId: "",
          sessionId: "",
          status: "idle",
          activity: `handoff:${payload}`,
        } as never);
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
    return buildGrokInfo(this.resolveOpts);
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

  authLogout() {
    const res = authLogout(this.home);
    this.logger.info("auth.logout", res);
    return res;
  }

  providersList() {
    return listCustomProviders(this.home);
  }

  providersUpsert(input: UpsertProviderInput) {
    const res = upsertCustomProvider(input, this.home);
    this.modelsListCache = null;
    this.logger.info("providers.upsert", { id: input.id });
    return res;
  }

  providersRemove(id: string) {
    const res = removeCustomProvider(id, this.home);
    // 模型目录已变，作废缓存
    this.modelsListCache = null;
    const sid = (id ?? "").trim().toLowerCase();
    const fallback = (res.defaultModel ?? "grok").trim() || "grok";
    // 磁盘 meta：会话仍记着已删 provider id → 改回默认（对齐 CLI reselect）
    const remapped = this.threadMeta.remapModels(
      (m) => m.trim().toLowerCase() === sid,
      fallback,
    );
    // 内存 live 线程同步
    for (const live of this.threads.values()) {
      const m = live.thread.model?.trim();
      if (m && m.toLowerCase() === sid) {
        live.thread.model = fallback;
      }
    }
    this.logger.info("providers.remove", {
      id,
      fallback,
      remappedSessions: remapped.updated,
    });
    return { ...res, remappedSessions: remapped.updated };
  }

  providersSetDefault(modelId: string) {
    this.modelsListCache = null;
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
  }) {
    const view = writeDesktopConfig(patch, this.home);
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
    return this.projects.add(input);
  }

  projectsUpdate(
    id: string,
    patch: Partial<Pick<Project, "title" | "pinned" | "archived" | "trust">>,
  ): Project {
    return this.projects.update(id, patch);
  }

  projectsRemove(id: string): void {
    this.projects.remove(id);
  }

  // ── Threads ──────────────────────────────────────────────

  /**
   * Live ACP threads + disk sessions under ~/.grok/sessions.
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
      const projectId =
        r.projectId ?? this.projects.findByPath(r.cwd)?.id ?? undefined;
      // Prefix match: session cwd under project root
      let resolvedProjectId = projectId;
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
      // 再滤一层：live 标题若像 goal 基建会话也隐藏
      if (isGoalInfraSessionTitle(r.title)) continue;
      const archived = this.threadMeta.isArchived(r.sessionId);
      const customTitle = this.threadMeta.getTitle(r.sessionId);
      const smeta = this.threadMeta.get(r.sessionId);
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
        title: sanitizeListTitle(customTitle || r.title),
        cwd: r.cwd,
        status: r.status,
        // 展示/回填用「仍可用」的模型；幽灵 id 回退默认（不改写历史消息）
        model: this.resolveAvailableModel(rawModel),
        effort: liveHit?.effort ?? smeta.effort,
        pinned: r.pinned,
        archived,
        sessionKind,
        parentSessionId,
        createdAt: r.updatedAt,
        updatedAt: r.updatedAt,
      });
    }

    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    let cwd = path.resolve(params.cwd);
    if (!fs.existsSync(cwd)) {
      throw new HostError("IO_ERROR", `cwd does not exist: ${cwd}`);
    }

    // Project trust gate
    let projectId = params.projectId;
    if (!projectId) {
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
        cwd = path.resolve(params.cwd.startsWith(proj.path) ? params.cwd : proj.path);
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

    this.threads.set(threadId, { thread, client, writable: true });

    try {
      await client.start();
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
      if (worktreeId) this.worktrees.bindSession(worktreeId, sessionId);

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

      this.logger.info("threads.create", { threadId, sessionId, cwd });
      return { threadId, sessionId, cwd, worktreeId };
    } catch (err) {
      await client.close().catch(() => undefined);
      this.threads.delete(threadId);
      throw this.wrap(err);
    }
  }

  async threadsAttach(
    sessionId: string,
    cwd: string,
  ): Promise<{ threadId: string }> {
    this.assertNotDisposed();
    const existingThreadId = this.sessionIndex.get(sessionId);
    if (existingThreadId) {
      const live = this.threads.get(existingThreadId);
      if (live?.writable && live.client) {
        throw new HostError(
          "SESSION_BUSY",
          `Thread already has a writable attach: ${existingThreadId}`,
        );
      }
    }
    for (const [tid, live] of this.threads) {
      if (live.thread.sessionId === sessionId && live.writable && live.client) {
        throw new HostError(
          "SESSION_BUSY",
          `Session already attached by thread ${tid}`,
        );
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

    this.threads.set(threadId, { thread, client, writable: true });
    this.sessionIndex.set(sessionId, threadId);

    try {
      await client.start();
      await client.loadSession({ sessionId, cwd: resolvedCwd });
      thread.sessionId = sessionId;
      thread.updatedAt = new Date().toISOString();
      thread.status = "idle";
      this.logger.info("threads.attach", { threadId, sessionId });
      return { threadId };
    } catch (err) {
      await client.close().catch(() => undefined);
      this.threads.set(threadId, {
        thread: { ...thread, status: "failed" },
        client: null,
        writable: false,
      });
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
    if (live.client) await live.client.close();
    live.client = null;
    live.writable = false;
    live.thread.status = "inactive";
    live.thread.updatedAt = new Date().toISOString();
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
    const lines: string[] = [
      `# ${snap.title || ref.sessionId.slice(0, 8)}`,
      "",
      `- session: \`${ref.sessionId}\``,
      `- cwd: \`${snap.cwd || "—"}\``,
      `- exported: ${new Date().toISOString()}`,
      "",
      "---",
      "",
    ];
    for (const e of hist.entries) {
      if (e.role === "user") {
        lines.push("## User", "", e.text || "_(empty)_", "");
      } else if (e.role === "assistant") {
        lines.push("## Assistant", "", e.text || "_(empty)_", "");
      } else if (e.role === "tool") {
        const name = e.toolName || "tool";
        lines.push(
          `### Tool · ${name}`,
          "",
          e.text ? "```\n" + e.text.slice(0, 4000) + "\n```" : "_(no output)_",
          "",
        );
      }
    }
    return {
      title: snap.title || ref.sessionId.slice(0, 8),
      sessionId: ref.sessionId,
      markdown: lines.join("\n"),
    };
  }

  threadsPin(threadId: string, pinned: boolean): Thread {
    const live = this.threads.get(threadId);
    if (!live) throw new HostError("SESSION_NOT_FOUND", `Unknown Thread: ${threadId}`);
    live.thread.pinned = pinned;
    live.thread.updatedAt = new Date().toISOString();
    return { ...live.thread };
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
   * Fork：复制源会话磁盘历史到新 session 目录，再 attach 打开。
   * 对齐 CLI fork 的「复制 chat_history / updates / plan / goal」语义（同 cwd）。
   */
  async threadsFork(params: {
    sourceSessionId: string;
    cwd: string;
    projectId?: string;
    title?: string;
    model?: string;
    effort?: string;
  }): Promise<ThreadsCreateResult & { parentSessionId: string; historyCopied: boolean }> {
    this.assertNotDisposed();
    const sourceId = params.sourceSessionId?.trim();
    if (!sourceId) {
      throw new HostError("INVALID_ARGUMENT", "sourceSessionId required");
    }
    const srcDir = findSessionDir(sourceId, this.home);
    if (!srcDir) {
      throw new HostError("SESSION_NOT_FOUND", `Source session not found: ${sourceId}`);
    }

    // 先创建空会话（agent session/new）
    const created = await this.threadsCreate({
      cwd: params.cwd,
      projectId: params.projectId,
      title: params.title,
      model: params.model,
      effort: params.effort,
    });

    // 真实 agent 会在 sessions 下落盘；fake/慢落盘时主动建目标目录以便复制历史
    let destDir = findSessionDir(created.sessionId, this.home);
    if (!destDir) {
      destDir = path.join(
        sessionsRoot(this.home),
        encodeCwdForSessionDir(params.cwd),
        created.sessionId,
      );
      fs.mkdirSync(destDir, { recursive: true });
    }
    let historyCopied = false;
    if (destDir) {
      const copyNames = [
        "chat_history.jsonl",
        "updates.jsonl",
        "plan.md",
        "plan_status.json",
        "goal.json",
        "subagents.json",
      ];
      for (const name of copyNames) {
        const from = path.join(srcDir, name);
        if (!fs.existsSync(from)) continue;
        try {
          fs.copyFileSync(from, path.join(destDir, name));
          historyCopied = true;
        } catch (err) {
          this.logger.warn("threads.fork_copy_failed", {
            name,
            err: String(err),
          });
        }
      }
      // summary：保留新 session id，标注 fork 来源
      try {
        const sumPath = path.join(destDir, "summary.json");
        let summary: Record<string, unknown> = {};
        if (fs.existsSync(sumPath)) {
          summary = JSON.parse(fs.readFileSync(sumPath, "utf8")) as Record<
            string,
            unknown
          >;
        }
        const srcSumPath = path.join(srcDir, "summary.json");
        if (fs.existsSync(srcSumPath)) {
          const srcSum = JSON.parse(
            fs.readFileSync(srcSumPath, "utf8"),
          ) as Record<string, unknown>;
          if (srcSum.title && !params.title) {
            summary.title = `分支 · ${String(srcSum.title)}`.slice(0, 80);
          }
        }
        if (params.title) summary.title = params.title;
        summary.session_kind = "fork";
        summary.parent_session_id = sourceId;
        summary.updated_at = new Date().toISOString();
        const info = (summary.info as Record<string, unknown>) || {};
        info.id = created.sessionId;
        info.cwd = path.resolve(params.cwd);
        summary.info = info;
        fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), "utf8");
      } catch (err) {
        this.logger.warn("threads.fork_summary_failed", { err: String(err) });
      }
    }

    this.logger.info("threads.fork", {
      sourceSessionId: sourceId,
      sessionId: created.sessionId,
      historyCopied,
    });

    return {
      ...created,
      parentSessionId: sourceId,
      historyCopied,
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
   * 执行完整回退（对话+文件，mode=all，force=true 才真正落盘）。
   * targetPromptIndex：恢复到该 user prompt 执行前。
   */
  async threadsRewind(
    threadId: string,
    params: { targetPromptIndex: number; force?: boolean },
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
    const res = await live.client!.rewindExecute(params.targetPromptIndex, {
      force,
    });
    this.logger.info("threads.rewind", {
      threadId,
      sessionId: live.thread.sessionId,
      targetPromptIndex: params.targetPromptIndex,
      force,
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
   */
  async threadsBtw(
    threadId: string,
    question: string,
  ): Promise<{ sessionId: string; answer: string }> {
    const live = this.requireWritable(threadId);
    const answer = await live.client!.sideQuestion(question);
    live.thread.updatedAt = new Date().toISOString();
    this.logger.info("threads.btw", {
      threadId,
      sessionId: live.thread.sessionId,
      qLen: question.trim().length,
      aLen: answer.length,
    });
    return { sessionId: live.thread.sessionId, answer };
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

  async turnsPrompt(threadId: string, content: string): Promise<void> {
    const live = this.requireWritable(threadId);
    live.thread.updatedAt = new Date().toISOString();
    await live.client!.prompt(content);
  }

  async turnsCancel(threadId: string): Promise<void> {
    const live = this.requireWritable(threadId);
    await live.client!.cancel();
  }

  permissionsRespond(requestId: string, decision: PermissionDecision): void {
    for (const live of this.threads.values()) {
      if (!live.client) continue;
      try {
        live.client.respondPermission(requestId, decision);
        this.inbox.markAllRead(); // crude: mark permission items
        return;
      } catch (err) {
        if (isHostError(err) && err.code === "INVALID_ARGUMENT") continue;
        throw err;
      }
    }
    throw new HostError(
      "INVALID_ARGUMENT",
      `No pending permission request: ${requestId}`,
    );
  }

  historyLoad(sessionId: string): HistoryPage {
    return loadChatHistory(sessionId, this.home);
  }

  findSessionDir(sessionId: string): string | null {
    return findSessionDir(sessionId, this.home);
  }

  /** 会话上下文占用（读 ~/.grok/sessions/.../signals.json） */
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

  async systemOpenPath(targetPath: string): Promise<void> {
    await openPath(targetPath);
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
  }): {
    dataUrl: string;
    mime: string;
    bytes: number;
  } {
    const roots = this.projects
      .list({ includeArchived: true })
      .map((p) => p.path);
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

  goalsGet(sessionId: string): GoalState | null {
    return loadGoal(sessionId, this.home);
  }

  goalsSet(sessionId: string, title: string, status?: GoalState["status"]): GoalState {
    return writeGoal(sessionId, title, this.home, status ?? "active");
  }

  goalsSetStatus(sessionId: string, status: GoalState["status"]): GoalState | null {
    return setGoalStatus(sessionId, status, this.home);
  }

  goalsClear(sessionId: string): { cleared: boolean } {
    return { cleared: clearGoal(sessionId, this.home) };
  }

  /** 从 agent updates.jsonl 回读最新 goal_updated 并投影（完成态兜底） */
  goalsSync(sessionId: string) {
    return syncGoalFromAgentLog(sessionId, this.home);
  }

  plansGet(sessionId: string): PlanState | null {
    return loadPlan(sessionId, this.home);
  }

  plansWrite(sessionId: string, content: string): PlanState {
    return writePlan(sessionId, content, this.home);
  }

  plansApprove(sessionId: string): PlanState {
    return setPlanStatus(sessionId, "approved", this.home);
  }

  plansReject(sessionId: string): PlanState {
    return setPlanStatus(sessionId, "rejected", this.home);
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
    // 优先：精确 requestId；再试仅有一个 waiter 的 client；最后扫全部
    let found = false;
    let lastErr: unknown;
    const clients = [...this.threads.values()].filter((l) => l.client);

    const tryRespond = (live: (typeof clients)[0]): boolean => {
      try {
        live.client!.respondPlanApproval(requestId, outcome, feedback);
        return true;
      } catch (err) {
        lastErr = err;
        return false;
      }
    };

    // 1) 精确命中
    for (const live of clients) {
      if (live.client!.hasPlanApproval(requestId) && tryRespond(live)) {
        found = true;
        break;
      }
    }
    // 2) 仅一个 client 有任意 plan 审批
    if (!found) {
      const withWaiter = clients.filter((l) => l.client!.hasPlanApproval());
      if (withWaiter.length === 1 && tryRespond(withWaiter[0])) {
        found = true;
      }
    }
    // 3) 扫全部
    if (!found) {
      for (const live of clients) {
        if (tryRespond(live)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      throw new HostError(
        "INVALID_ARGUMENT",
        `No pending plan approval: ${requestId}${
          lastErr instanceof Error ? ` (${lastErr.message})` : ""
        }`,
      );
    }
    if (sessionId) {
      if (outcome === "approved") {
        setPlanStatus(sessionId, "approved", this.home);
      } else if (outcome === "cancelled") {
        setPlanStatus(sessionId, "drafting", this.home);
      } else {
        setPlanStatus(sessionId, "rejected", this.home);
      }
    }
    this.logger.info("plans.respond", { requestId, outcome, feedback: Boolean(feedback) });
    return { ok: true };
  }

  subagentsTree(sessionId: string): SubagentNode[] {
    return loadSubagentTree(sessionId, this.home);
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

  skillsList(projectPath?: string) {
    return skillsListCli(this.grokCliRunner(), projectPath);
  }

  /** 在 Desktop GROK_HOME（或项目 .grok/skills）创建 skill 草稿目录 */
  skillsCreateDraft(params: {
    name: string;
    description?: string;
    scope?: "user" | "project";
    projectPath?: string;
  }): { name: string; path: string } {
    const raw = (params.name || "").trim();
    if (!raw) throw new HostError("INVALID_ARGUMENT", "skill name required");
    // 安全名：字母数字 _ -
    const name = raw
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!name) throw new HostError("INVALID_ARGUMENT", "invalid skill name");
    const scope = params.scope === "project" ? "project" : "user";
    let base: string;
    if (scope === "project") {
      const proj = (params.projectPath || "").trim();
      if (!proj) {
        throw new HostError(
          "INVALID_ARGUMENT",
          "projectPath required for project skill",
        );
      }
      base = path.join(proj, ".grok", "skills", name);
    } else {
      base = path.join(grokHomeDir(this.home), "skills", name);
    }
    fs.mkdirSync(base, { recursive: true });
    const skillMd = path.join(base, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      const desc = (params.description || "").trim() || name;
      const body =
        `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n` +
        `（在此编写 skill 说明与步骤。保存后可在 / 菜单或插件页使用。）\n`;
      fs.writeFileSync(skillMd, body, "utf8");
    }
    this.logger.info("skills.createDraft", { name, path: base, scope });
    return { name, path: base };
  }

  skillsOpenPath(skillPath: string): { opened: boolean; path: string } {
    const pth = (skillPath || "").trim();
    if (!pth || !fs.existsSync(pth)) {
      throw new HostError("IO_ERROR", `Skill path not found: ${skillPath}`);
    }
    // 优先打开 SKILL.md（目录则拼接）
    const target = fs.statSync(pth).isDirectory()
      ? path.join(pth, "SKILL.md")
      : pth;
    const openTarget = fs.existsSync(target) ? target : pth;
    try {
      openInEditor(openTarget);
    } catch {
      // 编辑器不可用时退回系统文件管理器
      try {
        if (process.platform === "win32") {
          spawn("explorer", ["/select,", openTarget], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", ["-R", openTarget], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else {
          spawn("xdg-open", [path.dirname(openTarget)], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      } catch (err) {
        this.logger.warn("skills.openPath_fallback_failed", {
          path: openTarget,
          err: String(err),
        });
      }
    }
    return { opened: true, path: openTarget };
  }


  pluginsList(projectPath?: string, opts?: { available?: boolean }) {
    return pluginsListCli(this.grokCliRunner(), {
      projectPath,
      available: opts?.available,
    });
  }

  pluginsInstall(source: string, opts?: { trust?: boolean }) {
    return cliPluginsInstall(this.requireGrokCli(), source, opts);
  }

  pluginsUninstall(name: string, opts?: { confirm?: boolean; keepData?: boolean }) {
    return cliPluginsUninstall(this.requireGrokCli(), name, opts);
  }

  pluginsEnable(name: string) {
    return cliPluginsEnable(this.requireGrokCli(), name);
  }

  pluginsDisable(name: string) {
    return cliPluginsDisable(this.requireGrokCli(), name);
  }

  pluginsUpdate(name?: string) {
    return cliPluginsUpdate(this.requireGrokCli(), name);
  }

  pluginsDetails(name: string) {
    return cliPluginsDetails(this.requireGrokCli(), name);
  }

  pluginsMarketplaceList() {
    return marketplaceListCli(this.requireGrokCli());
  }

  pluginsMarketplaceAdd(url: string) {
    return cliMarketplaceAdd(this.requireGrokCli(), url);
  }

  pluginsMarketplaceRemove(url: string) {
    return cliMarketplaceRemove(this.requireGrokCli(), url);
  }

  pluginsMarketplaceUpdate(name?: string) {
    return cliMarketplaceUpdate(this.requireGrokCli(), name);
  }

  mcpList() {
    return mcpListCli(this.grokCliRunner());
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
    return mcpAddCli(this.requireGrokCli(), input);
  }

  mcpRemove(name: string, opts?: { scope?: "user" | "project"; cwd?: string }) {
    return mcpRemoveCli(this.requireGrokCli(), name, opts);
  }

  mcpDoctor(name?: string) {
    return mcpDoctorCli(this.requireGrokCli(), name);
  }

  /** `grok models` 结果缓存，避免每次点 chip 都 spawn */
  private modelsListCache: { at: number; list: ModelInfo[] } | null = null;

  /** 当前全局默认模型 id（config / grok models / 内置） */
  defaultModelId(): string {
    const fromToml = listCustomProviders(this.home).defaultModel?.trim();
    if (fromToml) return fromToml;
    const list = this.modelsList();
    const hit = list.find((m) => m.isDefault)?.id?.trim();
    if (hit) return hit;
    return list[0]?.id?.trim() || "grok";
  }

  /** 模型 id 是否仍在 catalog / 自定义提供商配置中 */
  isModelAvailable(modelId: string | undefined | null): boolean {
    const id = (modelId ?? "").trim();
    if (!id) return false;
    const list = this.modelsList();
    if (list.some((m) => m.id === id)) return true;
    // grok models 偶发漏列时：config 里仍有该 [model.id] 也算可用
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

  /** 列出可用模型（`grok models`；失败时回退内置表；默认缓存 5 分钟） */
  modelsList(opts?: { force?: boolean }): ModelInfo[] {
    const ttlMs = 5 * 60_000;
    if (
      !opts?.force &&
      this.modelsListCache &&
      Date.now() - this.modelsListCache.at < ttlMs
    ) {
      return this.modelsListCache.list;
    }
    const list = this.modelsListUncached();
    // 合并自定义提供商 + 用 config 覆盖展示名（对齐 CLI：name ?? model ?? id）
    try {
      const { providers, defaultModel } = listCustomProviders(this.home);
      const names = modelDisplayNamesFromConfig(this.home);
      for (const p of providers) {
        const display =
          (p.name || p.model || p.id).trim() || p.id;
        const hit = list.find((m) => m.id === p.id);
        if (hit) {
          hit.name = display;
          if (defaultModel === p.id) hit.isDefault = true;
        } else {
          list.push({
            id: p.id,
            name: display,
            isDefault: defaultModel === p.id,
          });
        }
      }
      // 非 base_url 的 [model.*] 段也写 name（若有）
      for (const [id, display] of names) {
        const hit = list.find((m) => m.id === id);
        if (hit) {
          // 自定义提供商已用 p.name 写过；此处补全仅 name/model 的段
          if (!hit.name || hit.name === hit.id) hit.name = display;
        }
      }
    } catch {
      /* ignore */
    }
    this.modelsListCache = { at: Date.now(), list };
    return list;
  }

  private modelsListUncached(): ModelInfo[] {
    const fallback: ModelInfo[] = [
      { id: "grok-4.5", name: "grok-4.5", isDefault: true },
      { id: "grok-composer-2.5-fast", name: "grok-composer-2.5-fast" },
      { id: "grok-build", name: "grok-build" },
    ];
    const info = this.grokInfo();
    if (!info.path) return fallback;
    try {
      const r = spawnSync(info.path, ["models"], {
        encoding: "utf8",
        timeout: 12_000,
        env: this.env as NodeJS.ProcessEnv,
        windowsHide: true,
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      const models: ModelInfo[] = [];
      let defaultId: string | undefined;
      for (const line of out.split(/\r?\n/)) {
        const def = /^\s*Default model:\s*(\S+)/i.exec(line);
        if (def) defaultId = def[1];
        // "  * grok-4.5 (default)" or "  - grok-composer-2.5-fast"
        const m = /^\s*[*•-]\s+(\S+)/.exec(line);
        if (m) {
          const id = m[1].replace(/\(.*\)\s*$/, "").trim();
          if (!id || models.some((x) => x.id === id)) continue;
          models.push({
            id,
            name: id,
            isDefault:
              Boolean(defaultId && id === defaultId) ||
              /\(default\)/i.test(line),
          });
        }
      }
      if (defaultId && !models.some((x) => x.id === defaultId)) {
        models.unshift({ id: defaultId, name: defaultId, isDefault: true });
      }
      return models.length ? models : fallback;
    } catch {
      return fallback;
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

  shellTrayBadge() {
    return computeTrayBadge(this.rosterList(), this.inboxList());
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
  }

  /** Secondary instance: notify primary with deep link / focus payload. */
  async shellNotifyPrimary(payload: string): Promise<boolean> {
    if (!this.single) await this.initSingleInstance();
    if (this.single?.isPrimary) {
      writeHandoff(payload, this.home);
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
    this.filesWatchStop();
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
    return live;
  }

  private onClientEvent(threadId: string, ev: NormalizedEvent): void {
    const live = this.threads.get(threadId);
    if (live && ev.type === "session.status") {
      live.thread.status = ev.status;
      live.thread.updatedAt = new Date().toISOString();
    }
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
          // 仍下发事件供 UI 可选展示，但不进 Inbox 打扰
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
      live.thread.status = "failed";
      live.thread.updatedAt = new Date().toISOString();
      void crashed?.close().catch(() => undefined);
      this.inbox.add({
        type: "agent_failed",
        title: "Agent error",
        body: ev.message,
        sessionId: live.thread.sessionId,
        threadId,
        projectId: live.thread.projectId,
      });
    }
    // agent 运行时 goal 同源：首启也落盘 goal.json（不要求用户先 /goal）
    if (ev.type === "goal.updated") {
      try {
        applyAgentGoalProjection(
          ev.sessionId,
          ev.objective || "Goal",
          ev.status,
          this.home,
        );
      } catch (err) {
        this.logger.warn("goal.project_failed", { err: String(err) });
      }
      const st = ev.status.toLowerCase();
      if (st === "blocked" && live) {
        this.inbox.add({
          type: "goal_blocked",
          title: "Goal blocked",
          body: ev.message || ev.objective || "Goal is blocked",
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
    this.emit(ev);
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

/** plan 优先展示；否则为 access（对齐 Build 状态条） */
function deriveSessionMode(access: AccessMode, planActive: boolean): SessionMode {
  if (planActive) return "plan";
  return access;
}

/** 旧三态 mode → 两维 patch（会同时设定两维） */
function legacyModeToPatch(mode: SessionMode): {
  alwaysApprove: boolean;
  plan: boolean;
} {
  if (mode === "plan") return { alwaysApprove: false, plan: true };
  if (mode === "always_approve") return { alwaysApprove: true, plan: false };
  return { alwaysApprove: false, plan: false };
}
