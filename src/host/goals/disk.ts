import fs from "node:fs";
import path from "node:path";
import type {
  GoalState,
  PlanState,
  SessionGoalProjection,
  SubagentNode,
} from "../../shared/types.js";
import { findSessionDir } from "../paths.js";
import {
  applyGoalUpdated,
  getSessionGoal,
  markGoalClearedLocal,
  parseGoalWireStatus,
  shouldDropGoalStatusDowngrade,
  wireStatusToLegacy,
  type GoalUpdatedInput,
} from "../session/goal-store.js";

/** 可选磁盘缓存：非权威，仅加速冷启动；权威在 session-goal-store */
function goalCachePath(sessionId: string, home?: string): string | null {
  const dir = findSessionDir(sessionId, home);
  if (!dir) return null;
  return path.join(dir, "goal-projection.json");
}

/** @deprecated 旧 goal.json 路径，仅迁移读取 */
function legacyGoalPath(sessionId: string, home?: string): string | null {
  const dir = findSessionDir(sessionId, home);
  if (!dir) return null;
  return path.join(dir, "goal.json");
}

export function writeProjectionCache(
  sessionId: string,
  projection: SessionGoalProjection | null,
  home?: string,
): void {
  const p = goalCachePath(sessionId, home);
  if (!p) return;
  try {
    if (!projection) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      // 顺带清旧 goal.json，避免假「进行中」
      const legacy = legacyGoalPath(sessionId, home);
      if (legacy && fs.existsSync(legacy)) fs.unlinkSync(legacy);
      return;
    }
    fs.writeFileSync(p, JSON.stringify(projection, null, 2), "utf8");
    // 兼容旧读取：写瘦身 goal.json
    const legacy = legacyGoalPath(sessionId, home);
    if (legacy) {
      const state = projectionToLegacyState(projection);
      fs.writeFileSync(legacy, JSON.stringify(state, null, 2), "utf8");
    }
  } catch {
    /* best-effort */
  }
}

export function projectionToLegacyState(
  p: SessionGoalProjection,
): GoalState {
  const status = wireStatusToLegacy(p.status);
  return {
    sessionId: p.sessionId,
    title: p.objective,
    status,
    tree: [
      {
        id: p.goalId || "root",
        title: p.objective,
        status,
      },
    ],
    updatedAt: p.updatedAt,
    projection: p,
  };
}

/** 读取缓存投影（不写 store） */
export function loadProjectionCache(
  sessionId: string,
  home?: string,
): SessionGoalProjection | null {
  const p = goalCachePath(sessionId, home);
  if (p && fs.existsSync(p)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as SessionGoalProjection;
      if (j && j.objective && j.status && j.status !== "cleared") return j;
    } catch {
      /* fall through */
    }
  }
  // 旧 goal.json：仅当 status 有效时作弱缓存（不自动 opt-in 权威）
  const legacy = legacyGoalPath(sessionId, home);
  if (legacy && fs.existsSync(legacy)) {
    try {
      const g = JSON.parse(fs.readFileSync(legacy, "utf8")) as GoalState;
      if (!g?.title) return null;
      const st = String(g.status ?? "").toLowerCase();
      if (
        st === "cancelled" ||
        st === "canceled" ||
        st === "cleared" ||
        st === "completed"
      ) {
        return null;
      }
      // 无 goal_id 的旧缓存：不当权威 active，返回 null 等 jsonl bootstrap
      // （避免未 /goal 会话仅因脏 goal.json 显示目标）
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @deprecated 旧 API：读磁盘 goal.json。
 * 新代码用 getSessionGoal / goalsGetProjection。
 */
export function loadGoal(sessionId: string, home?: string): GoalState | null {
  const proj = getSessionGoal(sessionId) ?? loadProjectionCache(sessionId, home);
  if (!proj) return null;
  return projectionToLegacyState(proj);
}

/**
 * @deprecated 禁止作为权威写路径；仅兼容旧 IPC。
 * 新控制面：renderer 发 /goal slash，等 goal_updated。
 */
export function writeGoal(
  sessionId: string,
  title: string,
  home?: string,
  status: GoalState["status"] = "active",
): GoalState {
  // 不再伪造 active harness；仅写弱缓存草稿（status 强制不抬 harness）
  const state: GoalState = {
    sessionId,
    title: title.trim() || "Goal",
    status,
    tree: [
      {
        id: "root",
        title: title.trim() || "Goal",
        status,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  const dir = findSessionDir(sessionId, home);
  if (dir) {
    try {
      fs.writeFileSync(
        path.join(dir, "goal.json"),
        JSON.stringify(state, null, 2),
        "utf8",
      );
    } catch {
      /* ignore */
    }
  }
  return state;
}

/** @deprecated 本地 setStatus 非权威 */
export function setGoalStatus(
  sessionId: string,
  status: GoalState["status"],
  home?: string,
): GoalState | null {
  const prev = loadGoal(sessionId, home);
  if (!prev) return null;
  return writeGoal(sessionId, prev.title, home, status);
}

/** @deprecated 用 parseGoalWireStatus + wireStatusToLegacy */
export function mapAgentGoalStatus(agentStatus: string): GoalState["status"] {
  return wireStatusToLegacy(parseGoalWireStatus(agentStatus));
}

/** @deprecated 用 applyGoalUpdated + writeProjectionCache */
export function applyAgentGoalProjection(
  sessionId: string,
  objective: string,
  agentStatus: string,
  home?: string,
): GoalState {
  const result = applyGoalUpdated({
    sessionId,
    objective,
    status: agentStatus,
  });
  if (result.projection) {
    writeProjectionCache(sessionId, result.projection, home);
    return projectionToLegacyState(result.projection);
  }
  writeProjectionCache(sessionId, null, home);
  return {
    sessionId,
    title: objective || "Goal",
    status: "cancelled",
    tree: [],
    updatedAt: new Date().toISOString(),
  };
}

export interface AgentGoalSnapshot {
  objective: string;
  status: string;
  lastEvent?: string;
  lastEventDetail?: string;
  elapsedMs?: number;
  goalId?: string;
  phase?: string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  message?: string;
  verifyingCompletion?: boolean;
  planning?: boolean;
  classifierRunsAttempted?: number;
  classifierMaxRuns?: number;
  lastClassifierVerdict?: string;
  lastClassifierDetailsPath?: string;
  tokenBaseline?: number;
  finishedSubagentTokens?: number;
  liveSubagentTokens?: number;
}

function parseGoalUpdatedLine(line: string): AgentGoalSnapshot | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const j = JSON.parse(line) as {
      params?: { update?: Record<string, unknown> };
    };
    const u = j.params?.update;
    if (!u || u.sessionUpdate !== "goal_updated") return null;
    return snapshotFromUpdateRecord(u);
  } catch {
    return null;
  }
}

export function snapshotFromUpdateRecord(
  u: Record<string, unknown>,
): AgentGoalSnapshot {
  return {
    objective: String(u.objective ?? ""),
    status: String(u.status ?? "active"),
    lastEvent:
      typeof u.last_event === "string"
        ? u.last_event
        : typeof u.lastEvent === "string"
          ? u.lastEvent
          : undefined,
    lastEventDetail:
      typeof u.last_event_detail === "string"
        ? u.last_event_detail
        : typeof u.lastEventDetail === "string"
          ? u.lastEventDetail
          : undefined,
    elapsedMs:
      typeof u.elapsed_ms === "number"
        ? u.elapsed_ms
        : typeof u.elapsedMs === "number"
          ? u.elapsedMs
          : undefined,
    goalId:
      typeof u.goal_id === "string"
        ? u.goal_id
        : typeof u.goalId === "string"
          ? u.goalId
          : undefined,
    phase: typeof u.phase === "string" ? u.phase : undefined,
    tokenBudget:
      typeof u.token_budget === "number"
        ? u.token_budget
        : typeof u.tokenBudget === "number"
          ? u.tokenBudget
          : u.token_budget === null || u.tokenBudget === null
            ? null
            : undefined,
    tokensUsed:
      typeof u.tokens_used === "number"
        ? u.tokens_used
        : typeof u.tokensUsed === "number"
          ? u.tokensUsed
          : undefined,
    message:
      typeof u.pause_message === "string"
        ? u.pause_message
        : typeof u.message === "string"
          ? u.message
          : typeof u.pauseMessage === "string"
            ? u.pauseMessage
            : undefined,
    verifyingCompletion: Boolean(
      u.verifying_completion ?? u.verifyingCompletion,
    ),
    planning: Boolean(u.planning),
    classifierRunsAttempted:
      typeof u.classifier_runs_attempted === "number"
        ? u.classifier_runs_attempted
        : typeof u.classifierRunsAttempted === "number"
          ? u.classifierRunsAttempted
          : undefined,
    classifierMaxRuns:
      typeof u.classifier_max_runs === "number"
        ? u.classifier_max_runs
        : typeof u.classifierMaxRuns === "number"
          ? u.classifierMaxRuns
          : undefined,
    lastClassifierVerdict:
      typeof u.last_classifier_verdict === "string"
        ? u.last_classifier_verdict
        : typeof u.lastClassifierVerdict === "string"
          ? u.lastClassifierVerdict
          : undefined,
    lastClassifierDetailsPath:
      typeof u.last_classifier_details_path === "string"
        ? u.last_classifier_details_path
        : typeof u.lastClassifierDetailsPath === "string"
          ? u.lastClassifierDetailsPath
          : undefined,
    tokenBaseline:
      typeof u.token_baseline === "number"
        ? u.token_baseline
        : typeof u.tokenBaseline === "number"
          ? u.tokenBaseline
          : undefined,
    finishedSubagentTokens:
      typeof u.finished_subagent_tokens === "number"
        ? u.finished_subagent_tokens
        : typeof u.finishedSubagentTokens === "number"
          ? u.finishedSubagentTokens
          : undefined,
    liveSubagentTokens:
      typeof u.live_subagent_tokens === "number"
        ? u.live_subagent_tokens
        : typeof u.liveSubagentTokens === "number"
          ? u.liveSubagentTokens
          : undefined,
  };
}

/**
 * 从会话 updates.jsonl 尾部读取最新 goal_updated。
 */
export function readLastGoalUpdatedFromSession(
  sessionId: string,
  home?: string,
): AgentGoalSnapshot | null {
  const dir = findSessionDir(sessionId, home);
  if (!dir) return null;
  const updatesPath = path.join(dir, "updates.jsonl");
  if (!fs.existsSync(updatesPath)) return null;

  let text: string;
  try {
    const st = fs.statSync(updatesPath);
    const size = st.size;
    if (size <= 0) return null;
    const chunk = Math.min(size, 512 * 1024);
    const fd = fs.openSync(updatesPath, "r");
    try {
      const buf = Buffer.alloc(chunk);
      fs.readSync(fd, buf, 0, chunk, size - chunk);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.includes("goal_updated"));
  let last: AgentGoalSnapshot | null = null;
  for (const line of lines) {
    const snap = parseGoalUpdatedLine(line);
    if (!snap) continue;
    // 同 goal：complete / budget_limited 粘性（对齐 GoalTracker no-op pause）
    if (last) {
      const same =
        (last.goalId &&
          snap.goalId &&
          last.goalId === snap.goalId) ||
        (!snap.goalId && Boolean(last.goalId));
      if (same) {
        const prevSt = parseGoalWireStatus(last.status);
        const nextSt = parseGoalWireStatus(snap.status);
        if (
          shouldDropGoalStatusDowngrade(prevSt, nextSt, true)
        ) {
          continue;
        }
      }
    }
    last = snap;
  }
  return last;
}

/**
 * 冷启动 bootstrap：jsonl 最新 goal_updated → session-goal-store。
 * 仅当 agent 日志声明有 goal 时建立投影（不对脏 goal.json opt-in）。
 */
export function syncGoalFromAgentLog(
  sessionId: string,
  home?: string,
): {
  state: GoalState | null;
  agent: AgentGoalSnapshot | null;
  projection: SessionGoalProjection | null;
} {
  const agent = readLastGoalUpdatedFromSession(sessionId, home);
  if (!agent) {
    const existing = getSessionGoal(sessionId);
    return {
      state: existing ? projectionToLegacyState(existing) : null,
      agent: null,
      projection: existing,
    };
  }

  const input: GoalUpdatedInput = {
    sessionId,
    goalId: agent.goalId,
    objective: agent.objective,
    status: agent.status,
    phase: agent.phase,
    tokenBudget: agent.tokenBudget,
    tokensUsed: agent.tokensUsed,
    elapsedMs: agent.elapsedMs,
    lastEvent: agent.lastEvent,
    lastEventDetail: agent.lastEventDetail,
    message: agent.message,
    verifyingCompletion: agent.verifyingCompletion,
    planning: agent.planning,
    classifierRunsAttempted: agent.classifierRunsAttempted,
    classifierMaxRuns: agent.classifierMaxRuns,
    lastClassifierVerdict: agent.lastClassifierVerdict,
    lastClassifierDetailsPath: agent.lastClassifierDetailsPath,
    tokenBaseline: agent.tokenBaseline,
    finishedSubagentTokens: agent.finishedSubagentTokens,
    liveSubagentTokens: agent.liveSubagentTokens,
  };

  const result = applyGoalUpdated(input);
  writeProjectionCache(sessionId, result.projection, home);
  return {
    state: result.projection
      ? projectionToLegacyState(result.projection)
      : null,
    agent,
    projection: result.projection,
  };
}

export function clearGoal(sessionId: string, home?: string): boolean {
  markGoalClearedLocal(sessionId);
  writeProjectionCache(sessionId, null, home);
  const dir = findSessionDir(sessionId, home);
  if (!dir) return true;
  let cleared = false;
  for (const name of ["goal.json", "goal-projection.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        cleared = true;
      } catch {
        /* ignore */
      }
    }
  }
  return cleared;
}

// ── Plan / Subagent（原 goals.ts 职责保留，行为不变）────────────────

export function loadPlan(sessionId: string, home?: string): PlanState | null {
  const dir = findSessionDir(sessionId, home);
  if (!dir) return null;
  const planPath = path.join(dir, "plan.md");
  if (!fs.existsSync(planPath)) {
    return {
      sessionId,
      status: "drafting",
      content: "",
      path: planPath,
    };
  }
  const content = fs.readFileSync(planPath, "utf8");
  return {
    sessionId,
    status: content.trim() ? "ready_for_approval" : "drafting",
    content,
    path: planPath,
  };
}

export function writePlan(
  sessionId: string,
  content: string,
  home?: string,
): PlanState {
  const dir = findSessionDir(sessionId, home);
  if (!dir) {
    throw new Error(`Session dir not found for ${sessionId}`);
  }
  const planPath = path.join(dir, "plan.md");
  fs.writeFileSync(planPath, content, "utf8");
  return {
    sessionId,
    status: "ready_for_approval",
    content,
    path: planPath,
  };
}

export function setPlanStatus(
  sessionId: string,
  status: PlanState["status"],
  home?: string,
): PlanState {
  const plan = loadPlan(sessionId, home) ?? {
    sessionId,
    status: "drafting",
    content: "",
  };
  const metaPath = findSessionDir(sessionId, home);
  if (metaPath) {
    fs.writeFileSync(
      path.join(metaPath, "plan_status.json"),
      JSON.stringify({ status }, null, 2),
      "utf8",
    );
  }
  return { ...plan, status };
}

export function loadSubagentTree(
  sessionId: string,
  home?: string,
): SubagentNode[] {
  const dir = findSessionDir(sessionId, home);
  if (!dir) return [];
  const treePath = path.join(dir, "subagents.json");
  if (fs.existsSync(treePath)) {
    try {
      return JSON.parse(fs.readFileSync(treePath, "utf8")) as SubagentNode[];
    } catch {
      return [];
    }
  }
  return [];
}

/** 将 agent subagent 状态映射为 ThreadStatus 兼容值 */
export function mapSubagentStatus(status: string): SubagentNode["status"] {
  const s = status.toLowerCase();
  if (s === "completed" || s === "complete" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "inactive";
  if (s === "blocked") return "blocked";
  if (s === "working" || s === "running" || s === "active" || s === "spawned")
    return "working";
  if (s === "idle") return "idle";
  return "unknown";
}

export function writeSubagentTree(
  sessionId: string,
  tree: SubagentNode[],
  home?: string,
): SubagentNode[] {
  const dir = findSessionDir(sessionId, home);
  if (!dir) {
    throw new Error(`Session dir not found for ${sessionId}`);
  }
  const pathTree = path.join(dir, "subagents.json");
  fs.writeFileSync(pathTree, JSON.stringify(tree, null, 2), "utf8");
  return tree;
}

/**
 * 按 id 插入或更新子 agent 节点，并落盘 subagents.json。
 * 供 ACP SubagentSpawned / Progress / Finished 事件投影使用。
 */
export function upsertSubagentNode(
  sessionId: string,
  node: SubagentNode,
  home?: string,
): SubagentNode[] {
  const prev = loadSubagentTree(sessionId, home);
  const idx = prev.findIndex((n) => n.id === node.id);
  const next: SubagentNode[] =
    idx >= 0
      ? prev.map((n, i) =>
          i === idx
            ? {
                ...n,
                ...node,
                summary: node.summary ?? n.summary,
                type: node.type || n.type,
              }
            : n,
        )
      : [...prev, node];
  return writeSubagentTree(sessionId, next, home);
}
