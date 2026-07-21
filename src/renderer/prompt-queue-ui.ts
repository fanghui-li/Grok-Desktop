/**
 * Composer prompt-queue bar / modal HTML (P1-C · P3-D extract from main).
 * DOM mutations stay caller-owned; this module only builds markup + pure helpers.
 */
import { tr } from "../shared/i18n/index.js";

export type QueueBarItem = {
  id: string;
  display: string;
  content: string;
  status?: string;
  lastError?: string | null;
};

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderQueueItemRowHtml(
  q: QueueBarItem,
  index: number,
  total: number,
): string {
  const preview = (q.display || q.content || "").slice(0, 80);
  const upDis = index <= 0 ? " disabled" : "";
  const downDis = index >= total - 1 ? " disabled" : "";
  const st =
    q.status === "failed"
      ? `<span class="prompt-queue-st fail" title="${escHtml(q.lastError || "")}">!</span>`
      : q.status === "sending"
        ? `<span class="prompt-queue-st sending">…</span>`
        : "";
  return `<li class="prompt-queue-item" data-qid="${escHtml(q.id)}">
    <span class="prompt-queue-idx">${index + 1}</span>
    ${st}
    <span class="prompt-queue-text" title="${escHtml(q.content || q.display)}">${escHtml(preview)}</span>
    <span class="prompt-queue-actions">
      <button type="button" class="prompt-queue-act" data-queue-up="${escHtml(q.id)}" title="${escHtml(tr("queue.moveUp"))}"${upDis}>↑</button>
      <button type="button" class="prompt-queue-act" data-queue-down="${escHtml(q.id)}" title="${escHtml(tr("queue.moveDown"))}"${downDis}>↓</button>
      <button type="button" class="prompt-queue-act" data-queue-edit="${escHtml(q.id)}" title="${escHtml(tr("queue.edit"))}">✎</button>
      <button type="button" class="prompt-queue-x" data-queue-rm="${escHtml(q.id)}" title="${escHtml(tr("queue.remove"))}">×</button>
    </span>
  </li>`;
}

export function buildPromptQueueBarHtml(
  items: QueueBarItem[],
  pausedByInterrupt: boolean,
): string {
  const n = items.length;
  const list = items
    .map((q, i) => renderQueueItemRowHtml(q, i, n))
    .join("");
  const pauseBanner = pausedByInterrupt
    ? `<div class="prompt-queue-pause">
         <span>${escHtml(tr("queue.pausedHint"))}</span>
         <button type="button" class="prompt-queue-resume" data-queue-resume="1">${escHtml(tr("queue.resume"))}</button>
       </div>`
    : "";
  return `
      <div class="prompt-queue-head">
        <span class="prompt-queue-title">${escHtml(tr("queue.title", { n }))}</span>
        <span class="prompt-queue-head-actions">
          ${
            pausedByInterrupt
              ? `<button type="button" class="prompt-queue-resume" data-queue-resume="1">${escHtml(tr("queue.resume"))}</button>`
              : ""
          }
          <button type="button" class="prompt-queue-clear" data-queue-clear="1">${escHtml(tr("queue.clear"))}</button>
        </span>
      </div>
      ${pauseBanner}
      <ul class="prompt-queue-list">${list}</ul>`;
}

export function buildPromptQueueEmptyModalHtml(): string {
  return `<p class="prompt-dlg-hint">${escHtml(tr("queue.empty"))}</p>
       <p class="prompt-dlg-hint">${escHtml(tr("queue.hint"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${escHtml(tr("context.close"))}</button>
       </div>`;
}

export function buildPromptQueueModalBodyHtml(
  items: QueueBarItem[],
  pausedByInterrupt: boolean,
): string {
  const n = items.length;
  const list = items
    .map((q, i) => renderQueueItemRowHtml(q, i, n))
    .join("");
  const pauseNote = pausedByInterrupt
    ? `<p class="prompt-dlg-hint prompt-queue-pause-note">${escHtml(tr("queue.pausedHint"))}</p>`
    : "";
  return `${pauseNote}
     <ul class="prompt-queue-list prompt-queue-list--modal">${list}</ul>
     <div class="prompt-dlg-actions">
       ${
         pausedByInterrupt
           ? `<button type="button" class="btn-dark" id="queue-modal-resume">${escHtml(tr("queue.resume"))}</button>`
           : ""
       }
       <button type="button" class="btn-ghost" id="queue-modal-clear">${escHtml(tr("queue.clear"))}</button>
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${escHtml(tr("context.close"))}</button>
     </div>`;
}
