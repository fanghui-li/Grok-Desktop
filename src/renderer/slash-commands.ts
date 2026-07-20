/**
 * 斜杠命令中心 —— 仅当前会话相关命令。
 * 导航类（新对话 / 设置 / 项目 / 搜索等）走侧栏与顶栏 UI，不进本列表。
 */
import { tr } from "../shared/i18n/index.js";

export type SlashPermMode = "always_approve" | "normal" | "plan";

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
  /** /btw 旁路侧问；args 为问题正文，可空（从输入框取或弹窗） */
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
      action: { kind: "set-perm", mode: "always_approve" },
    },
    {
      id: "plan",
      title: tr("slash.plan"),
      description: tr("slash.planDesc"),
      keywords: "plan 计划",
      icon: "≡",
      action: { kind: "set-perm", mode: "plan" },
    },
    {
      id: "view-plan",
      title: tr("slash.viewPlan"),
      description: tr("slash.viewPlanDesc"),
      keywords: "view-plan show-plan plan-view",
      icon: "☰",
      action: { kind: "view-plan" },
    },
    {
      id: "goal",
      title: tr("slash.goal"),
      description: tr("slash.goalDesc"),
      keywords: "goal objective 目标",
      icon: "◎",
      action: { kind: "goal", sub: "set" },
    },
    {
      id: "goal-status",
      title: tr("slash.goalStatus"),
      description: tr("slash.goalStatusDesc"),
      keywords: "goal status",
      icon: "ⓘ",
      action: { kind: "goal", sub: "status" },
    },
    {
      id: "goal-clear",
      title: tr("slash.goalClear"),
      description: tr("slash.goalClearDesc"),
      keywords: "goal clear",
      icon: "✕",
      action: { kind: "goal", sub: "clear" },
    },
    {
      id: "goal-pause",
      title: tr("slash.goalPause"),
      description: tr("slash.goalPauseDesc"),
      keywords: "goal pause 暂停",
      icon: "⏸",
      action: { kind: "goal", sub: "pause" },
    },
    {
      id: "goal-resume",
      title: tr("slash.goalResume"),
      description: tr("slash.goalResumeDesc"),
      keywords: "goal resume 恢复",
      icon: "▶",
      action: { kind: "goal", sub: "resume" },
    },
    {
      id: "goal-budget",
      title: tr("slash.goalBudget"),
      description: tr("slash.goalBudgetDesc"),
      keywords: "goal budget token 预算",
      icon: "◎",
      action: { kind: "goal", sub: "budget" },
    },
    {
      id: "model",
      title: tr("slash.model"),
      description: tr("slash.modelDesc"),
      keywords: "model 模型",
      icon: "◇",
      action: { kind: "open-model-menu" },
    },
    {
      id: "effort",
      title: tr("slash.effort"),
      description: tr("slash.effortDesc"),
      keywords: "effort reasoning low medium high xhigh",
      icon: "◎",
      action: { kind: "set-effort" },
    },
    {
      id: "max-turns",
      title: tr("slash.maxTurns"),
      description: tr("slash.maxTurnsDesc"),
      keywords: "max-turns max turns 回合 上限",
      icon: "⟳",
      action: { kind: "set-max-turns" },
    },
    {
      id: "context",
      title: tr("slash.context"),
      description: tr("slash.contextDesc"),
      keywords: "context tokens window compact",
      icon: "▣",
      action: { kind: "show-context" },
    },
    {
      id: "compact",
      title: tr("slash.compact"),
      description: tr("slash.compactDesc"),
      keywords: "compact",
      icon: "▤",
      action: { kind: "compact-session" },
    },
    {
      id: "export",
      title: tr("slash.export"),
      description: tr("slash.exportDesc"),
      keywords: "export markdown md",
      icon: "⇩",
      action: { kind: "export-session" },
    },
    {
      id: "fork",
      title: tr("slash.fork"),
      description: tr("slash.forkDesc"),
      keywords: "fork",
      icon: "⑂",
      action: { kind: "fork-session" },
    },
    {
      id: "rewind",
      title: tr("slash.rewind"),
      description: tr("slash.rewindDesc"),
      keywords: "rewind undo 回退 撤销",
      icon: "↩",
      action: { kind: "rewind-session" },
    },
    {
      id: "queue",
      title: tr("slash.queue"),
      description: tr("slash.queueDesc"),
      keywords: "queue follow-up 排队 队列",
      icon: "☰",
      action: { kind: "show-queue" },
    },
    {
      id: "queue-clear",
      title: tr("slash.queueClear"),
      description: tr("slash.queueClearDesc"),
      keywords: "queue clear 清空队列",
      icon: "✕",
      action: { kind: "clear-queue" },
    },
    {
      id: "btw",
      title: tr("slash.btw"),
      description: tr("slash.btwDesc"),
      keywords: "btw side question 旁路 侧问 顺便问",
      icon: "💬",
      action: { kind: "btw" },
    },
    {
      id: "interject",
      title: tr("slash.interject"),
      description: tr("slash.interjectDesc"),
      keywords: "interject steer 插话 中途 打断",
      icon: "⚡",
      action: { kind: "interject" },
    },
    {
      id: "tasks",
      title: tr("slash.tasks"),
      description: tr("slash.tasksDesc"),
      keywords: "tasks background monitor 后台 任务",
      icon: "⚒",
      action: { kind: "show-tasks" },
    },
    {
      id: "history",
      title: tr("slash.history"),
      description: tr("slash.historyDesc"),
      keywords: "history prompt 历史 输入 召回",
      icon: "◷",
      action: { kind: "show-prompt-history" },
    },
    {
      id: "status",
      title: tr("slash.status"),
      description: tr("slash.statusDesc"),
      keywords: "status session",
      icon: "ⓘ",
      action: { kind: "status" },
    },
    {
      id: "memory",
      title: tr("slash.memory"),
      description: tr("slash.memoryDesc"),
      keywords: "memory remember 记忆 global workspace",
      icon: "◈",
      action: { kind: "memory", sub: "list" },
    },
    {
      id: "remember",
      title: tr("slash.remember"),
      description: tr("slash.rememberDesc"),
      keywords: "remember memory add 记住",
      icon: "◈",
      action: { kind: "memory", sub: "add" },
    },
    {
      id: "flush",
      title: tr("slash.flush"),
      description: tr("slash.flushDesc"),
      keywords: "flush memory 刷写 摘要",
      icon: "↓",
      action: { kind: "memory", sub: "flush" },
    },
    {
      id: "dream",
      title: tr("slash.dream"),
      description: tr("slash.dreamDesc"),
      keywords: "dream consolidate 整理 记忆",
      icon: "☾",
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
    // 默认列表：隐藏 paletteHidden（如 /always-approve，主入口是权限 chip）
    return commands.filter((c) => !c.paletteHidden);
  }
  return commands.filter((c) => {
    const hay =
      `${c.id} ${c.title} ${c.description} ${c.keywords ?? ""}`.toLowerCase();
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
    const id = c.id.startsWith("skill:") ? c.id.slice(6) : c.id;
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

function skillScopeBadge(scope?: string): string {
  if (scope === "project") return tr("slash.badge.project");
  if (scope === "user") return tr("slash.badge.user");
  return tr("slash.badge.system");
}

export function skillCommands(
  skills: Array<{ name: string; description?: string; scope?: string }>,
): SlashCommandDef[] {
  return skills.map((s) => ({
    id: `skill:${s.name}`,
    title: s.name,
    description: s.description?.trim() || tr("slash.skillDefaultDesc"),
    keywords: `skill 技能 ${s.name}`,
    icon: "⬡",
    dynamic: true,
    badge: skillScopeBadge(s.scope),
    action: {
      kind: "insert-text" as const,
      text: tr("slash.skillInsert", { name: s.name }),
    },
  }));
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
      action: {
        kind: "agent-command",
        name: id,
      },
    });
  }
  return out;
}
