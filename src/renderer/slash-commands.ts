/**
 * 斜杠命令中心 —— 仅当前会话相关命令。
 * 导航类（新对话 / 设置 / 项目 / 搜索等）走侧栏与顶栏 UI，不进本列表。
 *
 * 选中语义（对齐 Codex Desktop「补全/插入 vs 发送执行」）：
 * - run：选中即执行（status / export / compact …）
 * - insert：写入 `/name `（+ 可选 argumentHint），用户补参后再发送
 * - compose：进入编写态（如 /goal set）
 */
import { tr } from "../shared/i18n/index.js";

export type SlashPermMode = "always_approve" | "normal" | "plan";

/** Palette 选中时的接受模式 */
export type SlashAcceptMode = "run" | "insert" | "compose";

export interface SlashCommand {
  /** 触发 id，如 plan、status；skill 为 skill:名称 */
  id: string;
  /** 列表主标题（skill 显示技能名，不显示 /id） */
  title: string;
  /** 说明 */
  description: string;
  /** 搜索关键词 */
  keywords?: string;
  icon?: string;
  /** skill 动态项 */
  dynamic?: boolean;
  /** skill 来源角标：个人 / 项目 / 系统 */
  badge?: string;
  /**
   * 不在 `/` 默认列表展示（主入口在别处，如权限 chip）。
   * 手输 id/关键词仍可匹配执行。
   */
  paletteHidden?: boolean;
  /**
   * 选中行为：默认 run。
   * skill / agent 广告 / 需正文命令用 insert；goal set 用 compose。
   */
  acceptMode?: SlashAcceptMode;
  /**
   * 插入 `/name ` 后可选的参数占位（CLI argument-hint / agent input.hint）。
   * 仅 insert 模式使用；写入输入框供用户改写。
   */
  argumentHint?: string;
}

export type SlashEffortLevel = "low" | "medium" | "high" | "xhigh";

export type SlashAction =
  | { kind: "set-perm"; mode: SlashPermMode }
  | { kind: "view-plan" }
  | { kind: "set-model"; prompt?: boolean }
  | { kind: "set-effort"; level?: SlashEffortLevel }
  | { kind: "open-model-menu" }
  | { kind: "show-context" }
  | { kind: "goal"; sub?: "set" | "status" | "clear" | "pause" | "resume" | "budget" }
  | { kind: "status" }
  | { kind: "insert-text"; text: string }
  | { kind: "export-session" }
  | { kind: "compact-session" }
  | { kind: "fork-session" }
  | { kind: "rewind-session" }
  | { kind: "show-queue" }
  | { kind: "clear-queue" }
  | { kind: "show-tasks" }
  | { kind: "show-prompt-history" }
  /** /btw 旁路侧问；args 为问题正文，可空（无正文则打开右侧旁路侧问栏） */
  | { kind: "btw"; question?: string }
  /** 中途插话；args 为正文，可空（从输入框取） */
  | { kind: "interject"; text?: string }
  /** 本会话 / 新会话最大回合数（写入偏好；新会话 _meta 透传） */
  | { kind: "set-max-turns"; turns?: number }
  /** agent 广告的 slash：作为 insert-text 或透传 */
  | { kind: "agent-command"; name: string }
  /** CLI 对齐 Memory：浏览 / 记住 / flush / dream / status */
  | {
      kind: "memory";
      sub?: "list" | "add" | "search" | "status" | "flush" | "dream";
    };

export interface SlashCommandDef extends SlashCommand {
  action: SlashAction;
}

/** 解析有效 acceptMode（缺省 run） */
export function resolveAcceptMode(cmd: SlashCommandDef): SlashAcceptMode {
  if (cmd.acceptMode) return cmd.acceptMode;
  // 动态 skill / agent 广告：默认 insert（P0）
  if (cmd.dynamic || cmd.action.kind === "agent-command") return "insert";
  return "run";
}

/**
 * 写入 composer 的 slash 补全文本：`/token ` 或 `/token <hint>`。
 * token 不含前导 `/`。
 */
export function buildSlashInsertText(
  token: string,
  argumentHint?: string,
): string {
  const name = token.replace(/^\//, "").trim();
  if (!name) return "/";
  const hint = argumentHint?.trim();
  if (hint) return `/${name} ${hint}`;
  return `/${name} `;
}

/** 从命令定义得到插入用 token（skill:foo → foo，acp:bar → bar） */
export function slashInsertToken(cmd: SlashCommandDef): string {
  if (cmd.action.kind === "agent-command") {
    return cmd.action.name.replace(/^\//, "").replace(/^skill:/i, "");
  }
  if (cmd.id.startsWith("skill:")) return cmd.id.slice(6);
  if (cmd.id.startsWith("acp:")) return cmd.id.slice(4);
  return cmd.id;
}

/** 输入框 slash 着色类型 */
export type SlashTokenKind = "skill" | "agent" | "builtin" | "unknown";

/** 命令 → 着色类型（供 composer 高亮） */
export function slashCommandKind(cmd: SlashCommandDef): SlashTokenKind {
  if (cmd.id.startsWith("skill:")) return "skill";
  if (cmd.id.startsWith("acp:")) return "agent";
  // 动态项兜底：无 acp: 前缀的 agent-command 视为 skill 名
  if (cmd.dynamic) {
    return cmd.id.startsWith("acp:") ? "agent" : "skill";
  }
  return "builtin";
}

/** kind 优先级：skill > agent > builtin > unknown */
const KIND_RANK: Record<SlashTokenKind, number> = {
  unknown: 0,
  builtin: 1,
  agent: 2,
  skill: 3,
};

/** 构建 token→kind 目录（小写 name） */
export function buildSlashKindCatalog(
  commands: SlashCommandDef[],
): Map<string, SlashTokenKind> {
  const map = new Map<string, SlashTokenKind>();
  for (const c of commands) {
    const token = slashInsertToken(c).toLowerCase();
    if (!token) continue;
    const kind = slashCommandKind(c);
    const prev = map.get(token);
    if (!prev || KIND_RANK[kind] >= KIND_RANK[prev]) {
      map.set(token, kind);
    }
  }
  return map;
}

/** 仅会话命令（对话框 `/` 全部内容）— rebuilt each call so locale applies */
export function getStaticSlashCommands(): SlashCommandDef[] {
  return [
    {
      id: "always-approve",
      title: tr("slash.alwaysApprove"),
      description: tr("slash.alwaysApproveDesc"),
      keywords: "always-approve always approve yolo auto-approve 完全访问",
      icon: "⚡",
      // 主入口：输入栏权限 chip；slash 仍可用但不占默认列表
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "set-perm", mode: "always_approve" },
    },
    {
      id: "plan",
      title: tr("slash.plan"),
      description: tr("slash.planDesc"),
      keywords: "plan 计划",
      icon: "≡",
      // 主入口：权限 chip「计划模式」
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "set-perm", mode: "plan" },
    },
    {
      id: "view-plan",
      title: tr("slash.viewPlan"),
      description: tr("slash.viewPlanDesc"),
      keywords: "view-plan show-plan plan-view",
      icon: "☰",
      // 主入口：侧栏计划面板
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "view-plan" },
    },
    {
      id: "goal",
      title: tr("slash.goal"),
      description: tr("slash.goalDesc"),
      keywords: "goal objective 目标",
      icon: "◎",
      // 选中即执行（beginGoalCompose / 发送路径）
      acceptMode: "run",
      action: { kind: "goal", sub: "set" },
    },
    {
      id: "goal-status",
      title: tr("slash.goalStatus"),
      description: tr("slash.goalStatusDesc"),
      keywords: "goal status",
      icon: "ⓘ",
      // 主入口：goal banner
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "goal", sub: "status" },
    },
    {
      id: "goal-clear",
      title: tr("slash.goalClear"),
      description: tr("slash.goalClearDesc"),
      keywords: "goal clear",
      icon: "✕",
      // 主入口：goal banner / chip ×
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "goal", sub: "clear" },
    },
    {
      id: "goal-pause",
      title: tr("slash.goalPause"),
      description: tr("slash.goalPauseDesc"),
      keywords: "goal pause 暂停",
      icon: "⏸",
      // 主入口：goal banner
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "goal", sub: "pause" },
    },
    {
      id: "goal-resume",
      title: tr("slash.goalResume"),
      description: tr("slash.goalResumeDesc"),
      keywords: "goal resume 恢复",
      icon: "▶",
      // 主入口：goal banner
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "goal", sub: "resume" },
    },
    {
      id: "goal-budget",
      title: tr("slash.goalBudget"),
      description: tr("slash.goalBudgetDesc"),
      keywords: "goal budget token 预算",
      icon: "◎",
      acceptMode: "run",
      action: { kind: "goal", sub: "budget" },
    },
    {
      id: "model",
      title: tr("slash.model"),
      description: tr("slash.modelDesc"),
      keywords: "model 模型",
      icon: "◇",
      // 主入口：输入栏模型菜单
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "open-model-menu" },
    },
    {
      id: "effort",
      title: tr("slash.effort"),
      description: tr("slash.effortDesc"),
      keywords: "effort reasoning low medium high xhigh",
      icon: "◎",
      // 主入口：输入栏模型菜单内推理档
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "set-effort" },
    },
    {
      id: "max-turns",
      title: tr("slash.maxTurns"),
      description: tr("slash.maxTurnsDesc"),
      keywords: "max-turns max turns 回合 上限",
      icon: "⟳",
      // 主入口：设置；不占默认命令中心列表
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "set-max-turns" },
    },
    {
      id: "context",
      title: tr("slash.context"),
      description: tr("slash.contextDesc"),
      keywords: "context tokens window compact",
      icon: "▣",
      // 主入口：角上 context chip
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "show-context" },
    },
    {
      id: "compact",
      title: tr("slash.compact"),
      description: tr("slash.compactDesc"),
      keywords: "compact",
      icon: "▤",
      acceptMode: "run",
      action: { kind: "compact-session" },
    },
    {
      id: "export",
      title: tr("slash.export"),
      description: tr("slash.exportDesc"),
      keywords: "export markdown md",
      icon: "⇩",
      // 主入口：会话菜单；不占默认命令中心列表
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "export-session" },
    },
    {
      id: "fork",
      title: tr("slash.fork"),
      description: tr("slash.forkDesc"),
      keywords: "fork",
      icon: "⑂",
      // 可选标题参数：先插入再发送（或空参直接 fork）
      acceptMode: "insert",
      argumentHint: tr("slash.forkArgHint"),
      action: { kind: "fork-session" },
    },
    {
      id: "rewind",
      title: tr("slash.rewind"),
      description: tr("slash.rewindDesc"),
      keywords: "rewind undo 回退 撤销",
      icon: "↩",
      // 主入口：消息气泡回退；不占默认命令中心列表
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "rewind-session" },
    },
    {
      id: "queue",
      title: tr("slash.queue"),
      description: tr("slash.queueDesc"),
      keywords: "queue follow-up 排队 队列",
      icon: "☰",
      // 主入口：输入框上方排队条
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "show-queue" },
    },
    {
      id: "queue-clear",
      title: tr("slash.queueClear"),
      description: tr("slash.queueClearDesc"),
      keywords: "queue clear 清空队列",
      icon: "✕",
      // 主入口：排队条操作
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "clear-queue" },
    },
    {
      id: "btw",
      title: tr("slash.btw"),
      description: tr("slash.btwDesc"),
      keywords: "btw side question 旁路 侧问 顺便问 侧边",
      icon: "💬",
      // 需要问题正文：插入后用户可写；空参发送仍可开侧栏
      acceptMode: "insert",
      argumentHint: tr("slash.btwArgHint"),
      action: { kind: "btw" },
    },
    {
      id: "interject",
      title: tr("slash.interject"),
      description: tr("slash.interjectDesc"),
      keywords: "interject steer 插话 中途 打断",
      icon: "⚡",
      // 主入口：排队条「插话」/ 行内 /interject；不占默认命令中心列表
      paletteHidden: true,
      acceptMode: "insert",
      argumentHint: tr("slash.interjectArgHint"),
      action: { kind: "interject" },
    },
    {
      id: "tasks",
      title: tr("slash.tasks"),
      description: tr("slash.tasksDesc"),
      keywords: "tasks background monitor 后台 任务",
      icon: "⚒",
      acceptMode: "run",
      action: { kind: "show-tasks" },
    },
    {
      id: "history",
      title: tr("slash.history"),
      description: tr("slash.historyDesc"),
      keywords: "history prompt 历史 输入 召回",
      icon: "◷",
      // 主入口：↑ 召回；手输 /history 仍可；不占默认命令中心列表
      paletteHidden: true,
      acceptMode: "run",
      action: { kind: "show-prompt-history" },
    },
    {
      id: "status",
      title: tr("slash.status"),
      description: tr("slash.statusDesc"),
      keywords: "status session",
      icon: "ⓘ",
      acceptMode: "run",
      action: { kind: "status" },
    },
    {
      id: "memory",
      title: tr("slash.memory"),
      description: tr("slash.memoryDesc"),
      keywords: "memory remember 记忆 global workspace",
      icon: "◈",
      acceptMode: "run",
      action: { kind: "memory", sub: "list" },
    },
    {
      id: "remember",
      title: tr("slash.remember"),
      description: tr("slash.rememberDesc"),
      keywords: "remember memory add 记住",
      icon: "◈",
      acceptMode: "insert",
      argumentHint: tr("slash.rememberArgHint"),
      action: { kind: "memory", sub: "add" },
    },
    {
      id: "flush",
      title: tr("slash.flush"),
      description: tr("slash.flushDesc"),
      keywords: "flush memory 刷写 摘要",
      icon: "↓",
      acceptMode: "run",
      action: { kind: "memory", sub: "flush" },
    },
    {
      id: "dream",
      title: tr("slash.dream"),
      description: tr("slash.dreamDesc"),
      keywords: "dream consolidate 整理 记忆",
      icon: "☾",
      acceptMode: "run",
      action: { kind: "memory", sub: "dream" },
    },
  ];
}

/** @deprecated use getStaticSlashCommands() — kept for import compatibility */
export const STATIC_SLASH_COMMANDS: SlashCommandDef[] = getStaticSlashCommands();

/** 光标前是否处于 `/query` 片段 */
export function getSlashTrigger(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = before.match(/(?:^|[\s\n])\/([^\s]*)$/);
  if (!m) return null;
  const query = m[1] ?? "";
  const start = before.length - query.length - 1;
  if (start < 0 || text[start] !== "/") return null;
  return { start, query };
}

export function filterSlashCommands(
  commands: SlashCommandDef[],
  query: string,
): SlashCommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // 默认列表：隐藏 paletteHidden（主入口在 chip / 侧栏 / banner 的会话命令）
    return commands.filter((c) => !c.paletteHidden);
  }
  return commands.filter((c) => {
    const hay =
      `${c.id} ${c.title} ${c.description} ${c.keywords ?? ""} ${c.argumentHint ?? ""}`.toLowerCase();
    const id = c.id.startsWith("skill:") ? c.id.slice(6) : c.id;
    const hit =
      hay.includes(q) || c.id.startsWith(q) || id.startsWith(q);
    if (!hit) return false;
    // 隐藏项仅在明确匹配 id 前缀时出现，避免关键词「完全」误刷进列表
    if (c.paletteHidden) {
      return c.id.startsWith(q) || id.startsWith(q);
    }
    return true;
  });
}

/** 按完整 token 解析 slash（发送路径 / 手输兼容） */
export function resolveSlashCommand(
  commands: SlashCommandDef[],
  token: string,
): SlashCommandDef | undefined {
  const raw = token.trim().replace(/^\//, "").toLowerCase();
  if (!raw) return undefined;
  const name = raw.split(/\s+/)[0] ?? "";
  if (!name) return undefined;
  return commands.find((c) => {
    const id = c.id.startsWith("skill:")
      ? c.id.slice(6)
      : c.id.startsWith("acp:")
        ? c.id.slice(4)
        : c.id;
    return c.id.toLowerCase() === name || id.toLowerCase() === name;
  });
}

/** 去掉输入中的 `/query` 片段 */
export function stripSlashToken(
  text: string,
  start: number,
  cursor: number,
): { text: string; cursor: number } {
  const end = cursor;
  const next = text.slice(0, start) + text.slice(end);
  return { text: next, cursor: start };
}

/**
 * 将 `/query` 替换为完整 `/token `（+ 可选 hint）。
 * 用于 insert / Tab 补全。
 */
export function replaceSlashToken(
  text: string,
  start: number,
  cursor: number,
  replacement: string,
): { text: string; cursor: number } {
  const next = text.slice(0, start) + replacement + text.slice(cursor);
  const pos = start + replacement.length;
  return { text: next, cursor: pos };
}

function skillScopeBadge(scope?: string): string {
  if (scope === "project") return tr("slash.badge.project");
  if (scope === "user") return tr("slash.badge.user");
  return tr("slash.badge.system");
}

export function skillCommands(
  skills: Array<{
    name: string;
    description?: string;
    scope?: string;
    argumentHint?: string;
  }>,
): SlashCommandDef[] {
  return skills.map((s) => {
    const hint = s.argumentHint?.trim() || undefined;
    return {
      id: `skill:${s.name}`,
      title: s.name,
      description: s.description?.trim() || tr("slash.skillDefaultDesc"),
      keywords: `skill 技能 ${s.name}`,
      icon: "⬡",
      dynamic: true,
      badge: skillScopeBadge(s.scope),
      acceptMode: "insert" as const,
      argumentHint: hint,
      // Host skills.resolve 在发送路径执行；palette 只插入
      action: {
        kind: "agent-command" as const,
        name: s.name,
      },
    };
  });
}

/**
 * agent available_commands_update → 动态 slash。
 * 与静态 builtin 同名时跳过（Desktop 本地实现优先）。
 */
export function agentAdvertisedCommands(
  commands: Array<{ name: string; description?: string; input?: { hint?: string } }>,
  staticIds: Set<string>,
): SlashCommandDef[] {
  const out: SlashCommandDef[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    const name = (c.name || "").trim();
    if (!name) continue;
    const id = name.replace(/^\//, "").toLowerCase();
    if (!id || seen.has(id) || staticIds.has(id)) continue;
    // 跳过 pager 会屏蔽的 hooks 子命令（无 Desktop 管理 UI）
    if (
      id.startsWith("hooks-") ||
      id === "help" ||
      id === "reload-plugins"
    ) {
      continue;
    }
    seen.add(id);
    const hint = c.input?.hint?.trim();
    out.push({
      id: `acp:${id}`,
      title: `/${id}`,
      description:
        c.description?.trim() ||
        (hint ? tr("slash.agentCmdHint", { hint }) : tr("slash.agentCmdDesc")),
      keywords: `agent acp ${id} ${c.description ?? ""}`,
      icon: "✦",
      dynamic: true,
      badge: tr("slash.badge.agent"),
      acceptMode: "insert",
      argumentHint: hint || undefined,
      action: {
        kind: "agent-command",
        name: id,
      },
    });
  }
  return out;
}
