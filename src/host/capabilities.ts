import type { GrokCapabilities } from "../shared/types.js";

export const BASELINE_CAPABILITIES: GrokCapabilities = {
  acp: true,
  goalEvents: true,
  subagentTree: true,
  hunkTimeline: true,
  leaderRoster: false,
  worktreeApi: true,
  availableCommands: true,
  hooks: false,
  fsNotify: false,
  loadSession: true,
  queueWire: false,
  agentVersion: null,
};

/**
 * Merge ACP initialize result into GrokCapabilities (plan P2-C).
 * Host degraded features (worktree/hunk) stay true when Desktop implements them.
 */
export function parseInitializeCapabilities(
  result: unknown,
  baseline: GrokCapabilities = BASELINE_CAPABILITIES,
): GrokCapabilities {
  const out: GrokCapabilities = { ...baseline };
  if (!result || typeof result !== "object") return out;

  const root = result as Record<string, unknown>;
  const caps =
    (root.agentCapabilities as Record<string, unknown> | undefined) ??
    (root.capabilities as Record<string, unknown> | undefined) ??
    {};

  if (typeof caps.loadSession === "boolean") {
    out.loadSession = caps.loadSession;
  } else if (typeof caps.load_session === "boolean") {
    out.loadSession = caps.load_session as boolean;
  }

  const meta =
    (root._meta as Record<string, unknown> | undefined) ??
    (root.meta as Record<string, unknown> | undefined) ??
    (caps.meta as Record<string, unknown> | undefined) ??
    {};

  const agentVersion =
    pickStr(meta.agentVersion) ??
    pickStr(meta.agent_version) ??
    pickStr((root.serverInfo as Record<string, unknown> | undefined)?.version);
  if (agentVersion) out.agentVersion = agentVersion;

  // x.ai/hooks in meta (initialize response shape from shell)
  const hooksMeta = meta["x.ai/hooks"] ?? meta.hooks ?? caps["x.ai/hooks"];
  if (hooksMeta != null && hooksMeta !== false) {
    out.hooks = true;
  }

  const fsNotify = meta["x.ai/fs_notify"] ?? meta.fs_notify ?? caps["x.ai/fs_notify"];
  if (fsNotify === true) out.fsNotify = true;

  if (meta.availableCommands === true || caps.availableCommands === true) {
    out.availableCommands = true;
  }
  if (meta.queueWire === true || meta["x.ai/queue"] === true) {
    out.queueWire = true;
  }

  // Desktop Host always provides these when binary works
  out.acp = true;
  out.worktreeApi = true;
  out.hunkTimeline = true;
  out.goalEvents = true;
  out.subagentTree = true;

  return out;
}

function pickStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Merge runtime signals (e.g. saw available_commands_update). */
export function applyRuntimeCapabilitySignal(
  caps: GrokCapabilities,
  signal: "available_commands" | "queue_changed" | "goal_updated" | "subagent_updated",
): GrokCapabilities {
  const next = { ...caps };
  switch (signal) {
    case "available_commands":
      next.availableCommands = true;
      break;
    case "queue_changed":
      next.queueWire = true;
      break;
    case "goal_updated":
      next.goalEvents = true;
      break;
    case "subagent_updated":
      next.subagentTree = true;
      break;
  }
  return next;
}
