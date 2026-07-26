/**
 * Mode B attach state pill helpers (plan P1-B).
 * Pure: labels + CSS class; DOM wiring stays in main.
 */
import type { AttachState } from "../../shared/types.js";

export type AttachPillKind =
  | "history_only"
  | "attaching"
  | "live"
  | "failed"
  | "detaching";

export function attachStateToPillKind(state: AttachState | string): AttachPillKind {
  switch (state) {
    case "attaching":
    case "live":
    case "failed":
    case "detaching":
    case "history_only":
      return state;
    default:
      return "history_only";
  }
}

/** i18n key for attach pill label */
export function attachPillI18nKey(kind: AttachPillKind): string {
  switch (kind) {
    case "attaching":
      return "attach.pill.connecting";
    case "live":
      return "attach.pill.connected";
    case "failed":
      return "attach.pill.disconnected";
    case "detaching":
      return "attach.pill.detaching";
    default:
      return "attach.pill.historyOnly";
  }
}

export function attachPillCssClass(kind: AttachPillKind): string {
  return `attach-pill attach-pill--${kind}`;
}

/**
 * 方案 B：composer 不常驻附着态。
 * 仅「连接中 / 断开中 / 失败」短暂展示；仅历史 / 已连接不占位。
 * 发送路径 ensureLiveThread 自动 attach，无需用户点「连接 Agent」。
 */
export function attachPillShouldShow(kind: AttachPillKind): boolean {
  return kind === "attaching" || kind === "detaching" || kind === "failed";
}
