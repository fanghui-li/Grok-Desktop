import type { HostErrorCode } from "./errors.js";
import type { NormalizedEvent, ThreadStatus } from "./events.js";

/** 推理力度（对齐 CLI /effort） */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/**
 * 会话「主展示」模式（roster / 兼容字段）。
 * Grok Build 实际为两维：`AccessMode`（权限）× plan 开关；
 * `mode` 仅表示 UI 优先展示：plan 激活时为 plan，否则为 access。
 */
export type SessionMode = "normal" | "plan" | "always_approve";

/** 访问权限（对齐 Build always-approve / default），与 plan 正交 */
export type AccessMode = "normal" | "always_approve";

/** Product vocabulary: Project (specs). */
export interface Project {
  id: string;
  path: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  trust: "trusted" | "untrusted";
  createdAt: string;
  lastOpenedAt: string;
}

/** Product vocabulary: Thread = top-level agent session. */
export interface Thread {
  id: string;
  sessionId: string;
  projectId?: string;
  title: string;
  cwd: string;
  status: ThreadStatus;
  model?: string;
  /** 会话推理力度（与 model 一并按会话记忆） */
  effort?: ReasoningEffort | string;
  /** 派生展示：plan 优先，否则 access */
  mode?: SessionMode;
  /** 访问权限：完全访问 / 默认确认（与 plan 独立，对齐 Build yolo） */
  accessMode?: AccessMode;
  /** 计划模式是否激活（含 pending/active；Host 侧布尔） */
  planActive?: boolean;
  pinned?: boolean;
  archived?: boolean;
  worktreeId?: string;
  /** 磁盘 summary：fork 等 */
  sessionKind?: string;
  /** fork 来源会话 id（summary.parent_session_id） */
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrokCapabilities {
  acp: boolean;
  goalEvents: boolean;
  subagentTree: boolean;
  hunkTimeline: boolean;
  leaderRoster: boolean;
  worktreeApi: boolean;
  /** 是否会消费 agent available_commands_update（A20） */
  availableCommands?: boolean;
}

/** agent-bin/VERSION.txt（sync:agent 写入；安装包随 extraResources 带入） */
export interface AgentBinMeta {
  version: string | null;
  source: string | null;
  syncedAt: string | null;
  sha256: string | null;
  binary: string | null;
}

export interface GrokInfo {
  path: string | null;
  version: string | null;
  source: "bundled" | "override" | "path" | "missing";
  capabilities: GrokCapabilities;
  /** 与二进制同目录的 VERSION.txt；无则 null */
  agentBinMeta: AgentBinMeta | null;
}

export type WorktreeMode = "use_main" | "create_new" | "attach_existing";

export interface ThreadsCreateParams {
  cwd: string;
  title?: string;
  prompt?: string;
  projectId?: string;
  model?: string;
  /** 推理力度；写入 session _meta.reasoningEffort */
  effort?: ReasoningEffort | string;
  /** 最大回合数；写入 session _meta.maxTurns（agent 可忽略） */
  maxTurns?: number;
  alwaysApprove?: boolean;
  /** @deprecated 优先 alwaysApprove + plan；保留兼容旧调用 */
  mode?: SessionMode;
  /** 创建时是否进入 plan（可与 alwaysApprove 同时为 true） */
  plan?: boolean;
  worktree?: {
    mode: WorktreeMode;
    name?: string;
    path?: string;
  };
  mcpServers?: unknown[];
}

export interface ModelInfo {
  id: string;
  /** 展示名，缺省用 id */
  name?: string;
  isDefault?: boolean;
}

/** 会话上下文占用（signals.json / CLI /context 同源字段） */
export interface SessionContextUsage {
  sessionId: string;
  used: number;
  total: number;
  percent: number;
  available: boolean;
  source: "signals" | "none";
  path?: string;
}

export interface ThreadsCreateResult {
  threadId: string;
  sessionId: string;
  cwd: string;
  worktreeId?: string;
}

export type PermissionDecision =
  | "allow_once"
  | "allow_session"
  | "deny"
  | "allow_always";

export interface HistoryEntry {
  role: string;
  text: string;
  at?: string;
  /** role=tool 时：与直播过程块对齐 */
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "done" | "failed" | "running";
  /** 调用参数（供 tool card 摘要） */
  toolInput?: unknown;
  /** 工具输出摘要/原文 */
  toolOutput?: unknown;
}

export interface HistoryPage {
  sessionId: string;
  entries: HistoryEntry[];
  cursor?: string;
  sessionDir?: string | null;
}

/** Roster row for Command Center (top-level agents only). */
export interface RosterEntry {
  threadId?: string;
  sessionId: string;
  projectId?: string;
  title: string;
  cwd: string;
  status: ThreadStatus;
  activity?: string;
  source: "live" | "disk";
  updatedAt: string;
  pinned?: boolean;
  sessionKind?: string;
  parentSessionId?: string;
}

export type InboxItemType =
  | "permission"
  | "user_question"
  | "plan_approval"
  | "goal_blocked"
  | "automation_result"
  | "monitor_alert"
  | "agent_failed";

export interface InboxItem {
  id: string;
  type: InboxItemType;
  title: string;
  body: string;
  sessionId?: string;
  threadId?: string;
  projectId?: string;
  automationRunId?: string;
  requestId?: string;
  createdAt: string;
  read: boolean;
  deepLink?: string;
}

export interface WorktreeInfo {
  id: string;
  projectId: string;
  path: string;
  name: string;
  branch?: string;
  createdAt: string;
  boundSessionIds: string[];
}

export interface ChangeFileSummary {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
}

export interface ChangeSummary {
  scope: "thread" | "project" | "worktree";
  cwd: string;
  files: ChangeFileSummary[];
  rawStat?: string;
}

export interface DiffResult {
  path: string;
  patch: string;
}

export interface HunkTimelineEntry {
  path: string;
  summary: string;
  at?: string;
  turnHint?: string;
}

export type AutomationStatus = "active" | "paused" | "disabled";

export interface Automation {
  id: string;
  name: string;
  description?: string;
  status: AutomationStatus;
  projectId: string;
  /** cron-like or human schedule label */
  schedule: string;
  prompt: string;
  skillRef?: string;
  worktreeMode: "project_root" | "new_worktree_each_run";
  model?: string;
  alwaysApprove: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunHint?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface SkillInfo {
  name: string;
  path: string;
  description?: string;
  scope: "user" | "project" | "unknown";
  /** frontmatter category，缺省时 UI 按 scope 分组 */
  category?: string;
  /** inspect source.type：bundled / user / project / plugin … */
  sourceType?: string;
}

export interface PluginComponentSummary {
  skills: number;
  agents: number;
  hooks: boolean;
  mcpServers: number;
  commands?: number;
}

export interface PluginInfo {
  name: string;
  path: string;
  enabled: boolean;
  trusted: boolean;
  /** 个人 home 或项目 .grok/plugins */
  scope?: "user" | "project" | "unknown";
  description?: string;
  version?: string;
  /** installed | available | disabled | discovered */
  status?: "installed" | "available" | "disabled" | "discovered" | string;
  marketplace?: string;
  components?: PluginComponentSummary;
}

export interface PluginMarketplaceSource {
  name: string;
  kind?: string;
  url: string;
  branch?: string;
}

export interface McpServerInfo {
  name: string;
  status: "configured" | "unknown" | "disabled" | string;
  transport?: string;
  command?: string;
  url?: string;
  enabled?: boolean;
}

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export interface GoalNode {
  id: string;
  title: string;
  status: GoalStatus;
  children?: GoalNode[];
  note?: string;
}

export interface GoalState {
  sessionId: string;
  title: string;
  status: GoalStatus;
  tree: GoalNode[];
  updatedAt: string;
}

export interface PlanState {
  sessionId: string;
  status: "drafting" | "ready_for_approval" | "approved" | "rejected" | "executing";
  content: string;
  path?: string | null;
}

export interface SubagentNode {
  id: string;
  type: string;
  status: ThreadStatus | "unknown";
  summary?: string;
  childSessionId?: string;
  updatedAt?: string;
  children?: SubagentNode[];
}

export interface AuthStatus {
  authenticated: boolean;
  label?: string;
  authPath?: string;
  /** Desktop 专用 GROK_HOME（默认 ~/.grok-desktop） */
  grokHome?: string;
  /** CLI 默认 home（~/.grok，仅对照，Desktop 不写入） */
  cliGrokHome?: string;
}

export interface DesktopConfigView {
  defaultModel?: string;
  grokPathOverride?: string;
  permissionMode?: string;
  alwaysApproveDefault?: boolean;
  /** UI language: zh-CN | en-US | system */
  locale?: "zh-CN" | "en-US" | "system";
}

export interface HostResultOk<T> {
  ok: true;
  data: T;
}

export interface HostResultErr {
  ok: false;
  error: { code: HostErrorCode; message: string; details?: unknown };
}

export type HostResult<T> = HostResultOk<T> | HostResultErr;

export type { NormalizedEvent, ThreadStatus, HostErrorCode };
