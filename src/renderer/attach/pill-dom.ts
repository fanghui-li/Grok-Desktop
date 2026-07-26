/**
 * Attach status pill DOM (P1-B · P3-D extract).
 */
import type { AttachState } from "../../shared/types.js";
import { tr } from "../../shared/i18n/index.js";
import {
  attachPillCssClass,
  attachPillI18nKey,
  attachPillShouldShow,
  attachStateToPillKind,
} from "./status.js";

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
 * Ensure pill elements exist under the correct composer-left.
 * Chat vs welcome 必须用独立选择器（勿 querySelector(".composer-left") 误挂欢迎页）。
 *
 * 方案 B：仅 attaching / detaching / failed 显示；history_only / live 隐藏。
 * @param forceHide 无活动会话等场景强制隐藏。
 */
export function syncAttachPillDom(
  state: AttachState,
  lastError: string | undefined,
  handlers: AttachPillHandlers,
  forceHide = false,
): void {
  const kind = attachStateToPillKind(state);
  const show = !forceHide && attachPillShouldShow(kind);
  const label = tr(attachPillI18nKey(kind));
  const mounts: Array<{ id: string; hostSel: string }> = [
    { id: "attach-status-pill", hostSel: "#chat .composer-left" },
    { id: "attach-status-pill-welcome", hostSel: "#welcome .composer-left" },
  ];
  for (const { id, hostSel } of mounts) {
    let el = document.getElementById(id);
    if (!show) {
      if (el) {
        el.classList.add("hidden");
        el.onclick = null;
      }
      continue;
    }
    // 欢迎页不展示附着瞬态（新对话入口应干净）；只在 #chat 显示
    if (id === "attach-status-pill-welcome") {
      if (el) el.classList.add("hidden");
      continue;
    }
    if (!el) {
      document.querySelectorAll(`#${id}`).forEach((n) => n.remove());
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = id;
      btn.setAttribute("aria-live", "polite");
      el = btn;
      const host = document.querySelector(hostSel);
      if (host) host.insertBefore(el, host.firstChild);
      else continue;
    } else {
      const host = document.querySelector(hostSel);
      if (host && el.parentElement !== host) {
        host.insertBefore(el, host.firstChild);
      }
    }
    el.classList.remove("hidden");
    el.className = attachPillCssClass(kind);
    el.title =
      kind === "failed"
        ? lastError || tr("attach.pill.reconnectTitle")
        : tr("attach.pill.title");
    // failed：可点重连；attaching/detaching：只读状态
    if (kind === "failed") {
      el.innerHTML = `<span class="attach-pill-dot"></span><span class="attach-pill-label">${esc(label)}</span><span class="attach-pill-act">${esc(tr("attach.reconnect"))}</span>`;
      el.onclick = () => handlers.onConnectClick();
    } else {
      el.innerHTML = `<span class="attach-pill-dot"></span><span class="attach-pill-label">${esc(label)}</span>`;
      el.onclick = null;
    }
  }
}
