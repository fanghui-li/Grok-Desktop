import type { SubagentNode } from "../shared/types.js";
import type { Automation } from "../shared/types.js";

export type TaskKind = "process" | "monitor" | "subagent" | "scheduled";

export interface AggregatedTaskItem {
  id: string;
  kind: TaskKind;
  title: string;
  status: string;
  sessionId: string;
  childSessionId?: string;
  canKill: boolean;
  canOpen: boolean;
  automationId?: string;
  raw?: unknown;
}

export interface TaskSnapLike {
  taskId: string;
  sessionId?: string;
  phase: string;
  description?: string;
  command?: string;
  isMonitor?: boolean;
  success?: boolean;
  updatedAt?: number;
}

/**
 * Unify process/monitor snaps + subagents + session-bound automations (P2-B).
 */
export function aggregateTasks(opts: {
  sessionId: string;
  processSnaps?: TaskSnapLike[];
  subagents?: SubagentNode[];
  automations?: Automation[];
}): AggregatedTaskItem[] {
  const sid = opts.sessionId;
  const items: AggregatedTaskItem[] = [];

  for (const t of opts.processSnaps ?? []) {
    if (t.sessionId && t.sessionId !== sid) continue;
    const running =
      t.phase === "backgrounded" ||
      t.phase === "monitor" ||
      t.phase === "running";
    items.push({
      id: t.taskId,
      kind: t.isMonitor || t.phase === "monitor" ? "monitor" : "process",
      title: (t.description || t.command || t.taskId).trim(),
      status:
        t.phase === "completed"
          ? t.success === false
            ? "failed"
            : "ok"
          : t.phase,
      sessionId: t.sessionId || sid,
      canKill: running,
      canOpen: false,
      raw: t,
    });
  }

  for (const s of opts.subagents ?? []) {
    items.push({
      id: s.id,
      kind: "subagent",
      title: s.summary || s.type || s.id,
      status: s.status || "unknown",
      sessionId: sid,
      childSessionId: s.childSessionId,
      canKill: false,
      canOpen: Boolean(s.childSessionId),
      raw: s,
    });
  }

  for (const a of opts.automations ?? []) {
    // session-bound: matching cwd/session meta if present
    const bound =
      (a as { sessionId?: string }).sessionId === sid ||
      (a as { threadSessionId?: string }).threadSessionId === sid ||
      // list all paused/active as scheduled when no session field (caller filters)
      (!(a as { sessionId?: string }).sessionId &&
        !(a as { threadSessionId?: string }).threadSessionId);
    if (!bound && (a as { sessionId?: string }).sessionId) continue;
    // Only include if explicitly bound OR caller already filtered
    const explicit =
      (a as { sessionId?: string }).sessionId === sid ||
      (a as { threadSessionId?: string }).threadSessionId === sid;
    if (!explicit) {
      // still allow automations that mention session in name/prompt — skip loose match
      continue;
    }
    items.push({
      id: a.id,
      kind: "scheduled",
      title: a.name || a.id,
      status: a.status === "paused" ? "paused" : "scheduled",
      sessionId: sid,
      canKill: false,
      canOpen: true,
      automationId: a.id,
      raw: a,
    });
  }

  return items;
}

/** Include automations that are session-bound OR global list for "open in Automations". */
export function aggregateTasksLoose(opts: {
  sessionId: string;
  processSnaps?: TaskSnapLike[];
  subagents?: SubagentNode[];
  /** When set, all automations appear as scheduled with canOpen (deep link). */
  automationsForSession?: Automation[];
}): AggregatedTaskItem[] {
  const base = aggregateTasks({
    sessionId: opts.sessionId,
    processSnaps: opts.processSnaps,
    subagents: opts.subagents,
    automations: [],
  });
  for (const a of opts.automationsForSession ?? []) {
    base.push({
      id: a.id,
      kind: "scheduled",
      title: a.name || a.id,
      status: a.status === "paused" ? "paused" : "active",
      sessionId: opts.sessionId,
      canKill: false,
      canOpen: true,
      automationId: a.id,
      raw: a,
    });
  }
  return base;
}
