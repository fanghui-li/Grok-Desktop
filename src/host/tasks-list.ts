/**
 * 会话任务聚合列表（process snaps + subagents + automations）。
 */
import { loadSubagentTree } from "./goals.js";
import { aggregateTasksLoose } from "./tasks-aggregate.js";
import type { Automation, SubagentNode } from "../shared/types.js";

export type TasksListProcessSnap = {
  taskId: string;
  sessionId?: string;
  phase: string;
  description?: string;
  command?: string;
  isMonitor?: boolean;
  success?: boolean;
  updatedAt?: number;
};

export type TasksListInput = {
  sessionId: string;
  home?: string;
  processSnaps: TasksListProcessSnap[];
  automations: Automation[];
};

export function buildTasksList(input: TasksListInput): {
  sessionId: string;
  items: ReturnType<typeof aggregateTasksLoose>;
} {
  let subagents: SubagentNode[] = [];
  try {
    subagents = loadSubagentTree(input.sessionId, input.home) ?? [];
  } catch {
    subagents = [];
  }
  const autos = input.automations.filter((a) => {
    const any = a as { sessionId?: string; threadSessionId?: string };
    return (
      any.sessionId === input.sessionId ||
      any.threadSessionId === input.sessionId
    );
  });
  const items = aggregateTasksLoose({
    sessionId: input.sessionId,
    processSnaps: input.processSnaps,
    subagents,
    automationsForSession: autos,
  });
  return { sessionId: input.sessionId, items };
}
