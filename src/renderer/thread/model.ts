/**
 * 侧栏 / 会话列表共用模型与纯查询。
 * 列表 DOM 在 sidebar/list；openThread / turn 仍在 main。
 */

export type Project = {
  id: string;
  path: string;
  title: string;
  trust: string;
};

export type ThreadRow = {
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

/** 侧栏虚拟组：不使用项目的会话 */
export const CHATS_GROUP_ID = "__chats__";

/** 项目下会话预览条数（按根会话计） */
export const THREADS_PREVIEW_LIMIT = 5;

export function threadsForProject(
  projects: readonly Project[],
  threads: readonly ThreadRow[],
  projectId: string,
): ThreadRow[] {
  const proj = projects.find((p) => p.id === projectId);
  return threads
    .filter((t) => {
      if (t.projectId === projectId) return true;
      if (!proj) return false;
      // 无 projectId 的「不使用项目」会话不归入项目（即使 cwd 碰巧在项目下）
      if (!t.projectId) return false;
      const cwd = t.cwd.replace(/\\/g, "/").toLowerCase();
      const root = proj.path.replace(/\\/g, "/").toLowerCase();
      return cwd === root || cwd.startsWith(root + "/");
    })
    .sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}

/** 未挂任何项目的会话（侧栏「对话」组） */
export function threadsForChatsGroup(
  projects: readonly Project[],
  threads: readonly ThreadRow[],
): ThreadRow[] {
  const claimed = new Set<string>();
  for (const p of projects) {
    for (const t of threadsForProject(projects, threads, p.id)) {
      claimed.add(t.sessionId);
    }
  }
  return threads
    .filter((t) => !claimed.has(t.sessionId))
    .sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
}

/** 解析会话展示标题（列表 / toast） */
export function threadDisplayTitle(
  t: ThreadRow | undefined,
  fallbackId?: string,
  emptyFallback = "Chat",
): string {
  if (t?.title?.trim()) return t.title.trim();
  const id = t?.sessionId || fallbackId || "";
  return id ? id.slice(0, 8) : emptyFallback;
}

export function parentThreadTitle(
  threads: readonly ThreadRow[],
  parentSessionId: string | undefined,
  emptyFallback = "Chat",
): string | null {
  if (!parentSessionId) return null;
  const p = threads.find((x) => x.sessionId === parentSessionId);
  return threadDisplayTitle(p, parentSessionId, emptyFallback);
}

/** 当前打开的会话是否就是 t */
export function isThreadOpen(
  t: ThreadRow,
  activeThreadId: string | null,
  activeSessionId: string | null,
): boolean {
  return (
    t.id === activeThreadId ||
    (!!activeSessionId && t.sessionId === activeSessionId)
  );
}

export function isLiveThreadId(id: string | null | undefined): id is string {
  return Boolean(id && !id.startsWith("disk_"));
}

export function projectIdOfThread(t: ThreadRow): string | undefined {
  return t.projectId;
}
