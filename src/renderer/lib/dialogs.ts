/**
 * 应用内 modal / toast（Electron 沙箱无 window.prompt / confirm）。
 * 自 main 迁出。
 */
import { tr } from "../../shared/i18n/index.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`#${id} missing`);
  return n;
}

export function openModal(title: string, html: string): void {
  el("modal-title").textContent = title;
  el("modal-body").innerHTML = html;
  el("modal").classList.remove("hidden");
}

export function closeModal(): void {
  el("modal").classList.add("hidden");
}

export function promptText(opts: {
  title: string;
  hint?: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    openModal(
      opts.title,
      `
      ${opts.hint ? `<p class="prompt-dlg-hint">${esc(opts.hint)}</p>` : ""}
      <input id="prompt-dlg-input" class="prompt-dlg-input" type="text"
        value="${esc(opts.defaultValue ?? "")}"
        placeholder="${esc(opts.placeholder ?? "")}" autocomplete="off" />
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">取消</button>
        <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(opts.okLabel ?? tr("dlg.ok"))}</button>
      </div>`,
    );
    const input = el("prompt-dlg-input") as HTMLInputElement;
    const finish = (v: string | null) => {
      closeModal();
      resolve(v);
    };
    el("prompt-dlg-cancel").onclick = () => finish(null);
    el("prompt-dlg-ok").onclick = () => finish(input.value);
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(input.value);
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(null);
      }
    };
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

export function confirmText(opts: {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    openModal(
      opts.title,
      `
      <p class="prompt-dlg-hint" style="white-space:pre-wrap">${esc(opts.message)}</p>
      <div class="prompt-dlg-actions">
        <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(opts.cancelLabel ?? tr("dlg.cancel"))}</button>
        <button type="button" class="btn-dark" id="prompt-dlg-ok">${esc(opts.okLabel ?? tr("dlg.ok"))}</button>
      </div>`,
    );
    const finish = (v: boolean) => {
      closeModal();
      resolve(v);
    };
    el("prompt-dlg-cancel").onclick = () => finish(false);
    el("prompt-dlg-ok").onclick = () => finish(true);
  });
}

export function showToast(
  text: string,
  kind: "info" | "error" = "info",
): void {
  let node = document.getElementById("app-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "app-toast";
    node.className = "app-toast";
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.toggle("error", kind === "error");
  node.classList.add("show");
  window.clearTimeout((node as HTMLElement & { _t?: number })._t);
  (node as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
    node?.classList.remove("show");
  }, 3200);
}
