/**
 * R4：agent 崩溃条 — 提示重新附着（自 main 迁出）。
 */
import { tr } from "../../shared/i18n/index.js";

export type CrashBannerUiDeps = {
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  getActiveCwd: () => string | null;
  getActiveThreadId: () => string | null;
  setActiveThreadId: (id: string) => void;
  appendLine: (text: string, kind: "system" | "assistant" | "user") => void;
  ensureLiveThread: () => Promise<string | null>;
  refreshAgentAvailableCommands: () => void | Promise<void>;
};

export class CrashBannerUi {
  private pending = false;

  constructor(private readonly deps: CrashBannerUiDeps) {}

  get isPending(): boolean {
    return this.pending;
  }

  show(message?: string): void {
    this.pending = true;
    let bar = document.getElementById("agent-crash-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "agent-crash-bar";
      bar.className = "agent-crash-bar";
      const host =
        document.querySelector(".chat-composer-wrap") ||
        document.getElementById("chat-view") ||
        document.body;
      host.insertBefore(bar, host.firstChild);
    }
    bar.innerHTML = `<span class="agent-crash-msg">${this.deps.esc(
      message?.trim() || tr("crash.default"),
    )}</span>
    <button type="button" class="btn-dark sm" id="btn-agent-reattach">${this.deps.esc(
      tr("crash.reattach"),
    )}</button>
    <button type="button" class="btn-ghost sm" id="btn-agent-crash-dismiss">${this.deps.esc(
      tr("common.close"),
    )}</button>`;
    bar.classList.remove("hidden");
    const re = document.getElementById("btn-agent-reattach");
    if (re) {
      re.onclick = () => void this.reattach();
    }
    const dis = document.getElementById("btn-agent-crash-dismiss");
    if (dis) {
      dis.onclick = () => this.hide();
    }
  }

  hide(): void {
    this.pending = false;
    const bar = document.getElementById("agent-crash-bar");
    if (bar) bar.classList.add("hidden");
  }

  async reattach(): Promise<void> {
    if (!this.deps.getActiveSessionId() || !this.deps.getActiveCwd()) {
      this.deps.showToast(tr("crash.needSession"), "error");
      return;
    }
    const tid = this.deps.getActiveThreadId();
    if (tid && !tid.startsWith("disk_")) {
      const sid = this.deps.getActiveSessionId()!;
      this.deps.setActiveThreadId(`disk_${sid}`);
    }
    this.deps.appendLine(tr("crash.reattaching"), "system");
    const live = await this.deps.ensureLiveThread();
    if (live) {
      this.hide();
      this.deps.showToast(tr("crash.reattachOk"));
      void this.deps.refreshAgentAvailableCommands();
    } else {
      this.deps.showToast(tr("crash.reattachFail"), "error");
    }
  }
}
