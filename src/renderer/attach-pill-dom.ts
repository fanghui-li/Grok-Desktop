/**
 * Attach status pill DOM (P1-B · P3-D extract).
 */
import type { AttachState } from "../shared/types.js";
import { tr } from "../shared/i18n/index.js";
import {
  attachPillCssClass,
  attachPillI18nKey,
  attachStateToPillKind,
} from "./attach-status.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type AttachPillHandlers = {
  onConnectClick: () => void;
};

/**
 * Ensure pill elements exist under composer-left and update labels/classes.
 */
export function syncAttachPillDom(
  state: AttachState,
  lastError: string | undefined,
  handlers: AttachPillHandlers,
): void {
  const kind = attachStateToPillKind(state);
  const label = tr(attachPillI18nKey(kind));
  for (const id of ["attach-status-pill", "attach-status-pill-welcome"]) {
    let el = document.getElementById(id);
    if (!el) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = id;
      btn.setAttribute("aria-live", "polite");
      el = btn;
      const host =
        id === "attach-status-pill"
          ? document.querySelector(".composer-left") ||
            document.getElementById("chat-composer-dock")
          : document.querySelector("#welcome .composer-left") ||
            document.getElementById("welcome");
      if (host) host.insertBefore(el, host.firstChild);
      else continue;
    }
    el.className = attachPillCssClass(kind);
    el.title =
      kind === "failed"
        ? lastError || tr("attach.pill.reconnectTitle")
        : tr("attach.pill.title");
    el.innerHTML =
      kind === "failed" || kind === "history_only"
        ? `<span class="attach-pill-dot"></span><span class="attach-pill-label">${esc(label)}</span><span class="attach-pill-act">${esc(tr("attach.connect"))}</span>`
        : `<span class="attach-pill-dot"></span><span class="attach-pill-label">${esc(label)}</span>`;
    el.onclick = () => {
      if (kind === "failed" || kind === "history_only") {
        handlers.onConnectClick();
      }
    };
  }
}
