/**
 * Mode B attach state pill helpers (plan P1-B).
 * Pure: labels + CSS class; DOM wiring stays in main.
 */
import type { AttachState } from "../shared/types.js";

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
