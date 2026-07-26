/**
 * permission / ask_user / plan approval 响应路由（自 DesktopHost 迁出）。
 * 在 live client 集合上精确匹配 requestId，再兼容扫一遍。
 */
import { HostError, isHostError } from "../../shared/errors.js";
import type { PermissionDecision } from "../../shared/types.js";

export type PermissionClient = {
  hasPermission: (requestId: string) => boolean;
  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
  ) => void;
};

export type AskUserClient = {
  hasAskUser: (requestId: string) => boolean;
  respondAskUser: (
    requestId: string,
    resp: {
      outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
      answers?: Record<string, string[]>;
      partialAnswers?: Record<string, string>;
    },
  ) => void;
};

export type PlanApprovalClient = {
  hasPlanApproval: (requestId?: string) => boolean;
  respondPlanApproval: (
    requestId: string,
    outcome: "approved" | "cancelled" | "abandoned",
    feedback?: string,
  ) => void;
};

/**
 * 精确命中 hasX(rid) 的 client 响应；否则兼容扫一遍（仍只处理该 requestId）。
 */
export function respondPermissionAcrossClients(
  clients: Iterable<PermissionClient | null | undefined>,
  requestId: string,
  decision: PermissionDecision,
  opts: { markReadByRequestId: (rid: string) => void },
): void {
  const rid = requestId?.trim();
  if (!rid) {
    throw new HostError("INVALID_ARGUMENT", "requestId required");
  }
  for (const client of clients) {
    if (!client?.hasPermission(rid)) continue;
    client.respondPermission(rid, decision);
    opts.markReadByRequestId(rid);
    return;
  }
  for (const client of clients) {
    if (!client) continue;
    try {
      client.respondPermission(rid, decision);
      opts.markReadByRequestId(rid);
      return;
    } catch (err) {
      if (isHostError(err) && err.code === "INVALID_ARGUMENT") continue;
      throw err;
    }
  }
  throw new HostError(
    "INVALID_ARGUMENT",
    `No pending permission request: ${rid}`,
  );
}

export function respondAskUserAcrossClients(
  clients: Iterable<AskUserClient | null | undefined>,
  requestId: string,
  resp: {
    outcome: "accepted" | "cancelled" | "chat_about_this" | "skip_interview";
    answers?: Record<string, string[]>;
    partialAnswers?: Record<string, string>;
  },
): void {
  const rid = requestId?.trim();
  if (!rid) {
    throw new HostError("INVALID_ARGUMENT", "requestId required");
  }
  for (const client of clients) {
    if (!client?.hasAskUser(rid)) continue;
    client.respondAskUser(rid, resp);
    return;
  }
  for (const client of clients) {
    if (!client) continue;
    try {
      client.respondAskUser(rid, resp);
      return;
    } catch (err) {
      if (isHostError(err) && err.code === "INVALID_ARGUMENT") continue;
      throw err;
    }
  }
  throw new HostError(
    "INVALID_ARGUMENT",
    `No pending ask_user request: ${rid}`,
  );
}

export type PlanRespondResult = { ok: true };

/**
 * exit_plan_mode 审批：精确 requestId → 仅一个 waiter → 扫全部。
 * 磁盘 plan 状态由调用方按 sessionId + outcome 更新。
 */
export function respondPlanApprovalAcrossClients(
  clients: Iterable<PlanApprovalClient | null | undefined>,
  requestId: string,
  outcome: "approved" | "cancelled" | "abandoned",
  feedback?: string,
): PlanRespondResult {
  const list = [...clients].filter((c): c is PlanApprovalClient => Boolean(c));
  let found = false;
  let lastErr: unknown;

  const tryRespond = (client: PlanApprovalClient): boolean => {
    try {
      client.respondPlanApproval(requestId, outcome, feedback);
      return true;
    } catch (err) {
      lastErr = err;
      return false;
    }
  };

  for (const client of list) {
    if (client.hasPlanApproval(requestId) && tryRespond(client)) {
      found = true;
      break;
    }
  }
  if (!found) {
    const withWaiter = list.filter((c) => c.hasPlanApproval());
    if (withWaiter.length === 1 && tryRespond(withWaiter[0]!)) {
      found = true;
    }
  }
  if (!found) {
    for (const client of list) {
      if (tryRespond(client)) {
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
  return { ok: true };
}

/** plan 审批 outcome → 本地 plan status */
export function planStatusAfterRespond(
  outcome: "approved" | "cancelled" | "abandoned",
): "approved" | "drafting" | "rejected" {
  if (outcome === "approved") return "approved";
  if (outcome === "cancelled") return "drafting";
  return "rejected";
}
