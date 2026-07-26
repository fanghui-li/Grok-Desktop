/**
 * S19 follow-up 队列：本地镜像 + Host L1 + bar/modal/drain（自 main 迁出）。
 * turn / dispatch / interject 经 deps；本模块持有 items 与 pause 标志。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import type { ComposerAttachment } from "../composer/attachments.js";
import {
  canScheduleQueueDrain,
  enqueueToastKey,
  newQueueItemId,
  normalizeQueueEditPatch,
} from "./logic.js";
import {
  hostClearQueue,
  hostCompleteSending,
  hostEnqueue,
  hostRemoveItem,
  hostReorder,
  hostSetQueueFlags,
  hostTakeNext,
  hostUpdateItem,
  loadSessionQueue,
  mirrorQueueToLocal,
  type HostQueueFile,
} from "./store.js";
import {
  buildPromptQueueBarHtml,
  buildPromptQueueEmptyModalHtml,
  buildPromptQueueModalBodyHtml,
} from "./ui.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type QueuedPrompt = {
  id: string;
  display: string;
  content: string;
  attachments: ComposerAttachment[];
  status?: "pending" | "sending" | "failed";
  lastError?: string | null;
};

export type PromptQueueControllerDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  getActiveSessionId: () => string | null;
  getTurnActive: () => boolean;
  getTurnUiPhase: () => string;
  dispatchAgentPrompt: (
    content: string,
    display?: string,
    opts?: {
      force?: boolean;
      interrupt?: "queue" | "send_now";
      attachments?: ComposerAttachment[];
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  runInterjectCommand: (
    text: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  syncChatComposerReserve: () => void;
  scrollTranscriptIfSticky: () => void;
};

export class PromptQueueController {
  private readonly items: QueuedPrompt[] = [];
  private drainScheduled = false;
  private pausedByInterrupt = false;
  private queueingEnabled = true;
  private syncError: string | null = null;

  constructor(private readonly deps: PromptQueueControllerDeps) {}

  get length(): number {
    return this.items.length;
  }

  get isPaused(): boolean {
    return this.pausedByInterrupt;
  }

  get isQueueingEnabled(): boolean {
    return this.queueingEnabled;
  }

  /** 供 stop 路径直接设 pause（无 Host 时） */
  setPaused(paused: boolean): void {
    this.pausedByInterrupt = paused;
    this.syncBar();
  }

  /**
   * stop / send_now：本地 pause + 有会话时写 Host flags。
   * 对齐 cancel 路径：interrupt 暂停 drain；send_now 解除 pause。
   */
  setPausedSyncHost(paused: boolean): void {
    this.pausedByInterrupt = paused;
    this.syncBar();
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostSetQueueFlags(this.deps.inv, sid, {
        pausedByInterrupt: paused,
      });
    }
  }

  /** 无 Host 时硬清本地镜像（leave session 等） */
  clearLocal(): void {
    this.items.length = 0;
    this.pausedByInterrupt = false;
    this.syncBar();
  }

  list(): readonly QueuedPrompt[] {
    return this.items;
  }

  /** 同步输入区上方的排队条 */
  syncBar(): void {
    const bars = ["prompt-queue-bar", "prompt-queue-bar-welcome"]
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    for (const bar of bars) {
      if (!this.items.length) {
        bar.classList.add("hidden");
        bar.innerHTML = "";
        this.pausedByInterrupt = false;
        continue;
      }
      bar.classList.remove("hidden");
      bar.innerHTML = buildPromptQueueBarHtml(
        this.items.map((q) => ({
          id: q.id,
          display: q.display,
          content: q.content,
          status: q.status,
          lastError: q.lastError,
        })),
        this.pausedByInterrupt,
      );
    }
    requestAnimationFrame(() => {
      try {
        this.deps.syncChatComposerReserve();
      } catch {
        /* init 前可能未定义 */
      }
    });
  }

  applyHostMirror(file: HostQueueFile | null): void {
    const m = mirrorQueueToLocal(file);
    this.items.length = 0;
    for (const it of m.items) {
      this.items.push({
        id: it.id,
        display: it.display,
        content: it.content,
        attachments: (it.attachments as ComposerAttachment[]) ?? [],
        status: it.status,
        lastError: it.lastError,
      });
    }
    this.pausedByInterrupt = m.pausedByInterrupt;
    this.queueingEnabled = m.queueingEnabled;
    this.syncError = m.syncError;
    this.syncBar();
  }

  async reloadFromHost(): Promise<void> {
    const sid = this.deps.getActiveSessionId();
    if (!sid) {
      this.items.length = 0;
      this.pausedByInterrupt = false;
      this.syncBar();
      return;
    }
    const file = await loadSessionQueue(this.deps.inv, sid);
    this.applyHostMirror(file);
  }

  clear(opts?: { silent?: boolean }): void {
    if (!this.items.length && !this.pausedByInterrupt) return;
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostClearQueue(this.deps.inv, sid).then((f) => {
        this.applyHostMirror(f);
        this.removeAllQueuedSystemLines();
        if (!opts?.silent) this.deps.showToast(tr("queue.cleared"));
      });
      return;
    }
    this.items.length = 0;
    this.pausedByInterrupt = false;
    this.syncBar();
    this.removeAllQueuedSystemLines();
    if (!opts?.silent) this.deps.showToast(tr("queue.cleared"));
  }

  private refreshModalIfOpen(): void {
    const modal = document.getElementById("modal");
    if (!modal || modal.classList.contains("hidden")) return;
    if (!modal.querySelector(".prompt-queue-list--modal")) return;
    this.showModal();
  }

  remove(id: string): void {
    void this.removeAsync(id);
  }

  removeQueuedSystemLine(queueItemId: string): void {
    if (!queueItemId) return;
    const root = document.getElementById("transcript");
    if (!root) return;
    for (const n of Array.from(
      root.querySelectorAll(".line.system[data-queue-id]"),
    )) {
      if ((n as HTMLElement).dataset.queueId === queueItemId) n.remove();
    }
  }

  removeAllQueuedSystemLines(): void {
    const root = document.getElementById("transcript");
    if (!root) return;
    root
      .querySelectorAll(".line.system[data-queue-id]")
      .forEach((n) => n.remove());
  }

  appendQueuedSystemLine(queueItemId: string, preview: string): void {
    const el = document.getElementById("transcript");
    if (!el) return;
    const div = document.createElement("div");
    div.className = "line system";
    div.dataset.messageAuthorRole = "system";
    div.dataset.queueId = queueItemId;
    div.textContent = tr("queue.queuedLine", {
      preview: preview.replace(/\s+/g, " ").slice(0, 60),
    });
    el.appendChild(div);
    this.deps.scrollTranscriptIfSticky();
  }

  async removeAsync(id: string): Promise<boolean> {
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      const f = await hostRemoveItem(this.deps.inv, sid, id);
      this.applyHostMirror(f);
      this.refreshModalIfOpen();
      this.removeQueuedSystemLine(id);
      return Boolean(f);
    }
    const i = this.items.findIndex((q) => q.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    if (!this.items.length) this.pausedByInterrupt = false;
    this.syncBar();
    this.refreshModalIfOpen();
    this.removeQueuedSystemLine(id);
    return true;
  }

  async interject(id: string): Promise<void> {
    const q = this.items.find((x) => x.id === id);
    if (!q || q.status === "sending") return;
    if (this.deps.getTurnUiPhase() === "cancelling") {
      this.deps.showToast(tr("interject.cancelling"), "error");
      return;
    }
    if (
      !this.deps.getTurnActive() ||
      this.deps.getTurnUiPhase() !== "working"
    ) {
      this.deps.showToast(tr("interject.needTurn"), "error");
      return;
    }
    const text = (q.content || q.display).trim();
    if (!text) {
      this.deps.showToast(tr("interject.empty"), "error");
      return;
    }
    const result = await this.deps.runInterjectCommand(text);
    if (result.ok) {
      await this.removeAsync(id);
    } else if (result.message) {
      this.deps.showToast(result.message, "error");
    }
  }

  async sendNow(id: string): Promise<void> {
    const q = this.items.find((x) => x.id === id);
    if (!q || q.status === "sending") return;
    if (this.deps.getTurnUiPhase() === "cancelling") {
      this.deps.showToast(tr("interject.cancelling"), "error");
      return;
    }
    const content = q.content;
    const display = q.display;
    const wasBusy = this.deps.getTurnActive();
    await this.removeAsync(id);
    const result = await this.deps.dispatchAgentPrompt(content, display, {
      force: false,
      interrupt: wasBusy ? "send_now" : undefined,
    });
    if (result.ok) {
      if (wasBusy) this.deps.showToast(tr("chat.sendNow"));
    } else if (result.error) {
      this.deps.showToast(result.error, "error");
    }
  }

  move(id: string, dir: -1 | 1): void {
    const i = this.items.findIndex((q) => q.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= this.items.length) return;
    const ordered = this.items.map((q) => q.id);
    const tmp = ordered[i]!;
    ordered[i] = ordered[j]!;
    ordered[j] = tmp;
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostReorder(this.deps.inv, sid, ordered).then((f) => {
        this.applyHostMirror(f);
        this.refreshModalIfOpen();
      });
      return;
    }
    const t = this.items[i]!;
    this.items[i] = this.items[j]!;
    this.items[j] = t;
    this.syncBar();
    this.refreshModalIfOpen();
  }

  update(
    id: string,
    patch: { display: string; content: string },
  ): boolean {
    const q = this.items.find((x) => x.id === id);
    if (!q) return false;
    const normalized = normalizeQueueEditPatch(patch.display, patch.content);
    if (!normalized) return false;
    const { display, content } = normalized;
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostUpdateItem(this.deps.inv, sid, id, { display, content }).then(
        (f) => {
          this.applyHostMirror(f);
          this.refreshModalIfOpen();
        },
      );
      return true;
    }
    q.display = display;
    q.content = content;
    this.syncBar();
    this.refreshModalIfOpen();
    return true;
  }

  openEdit(id: string): void {
    const q = this.items.find((x) => x.id === id);
    if (!q) return;
    const initial = q.content || q.display;
    const esc = this.deps.esc;
    this.deps.openModal(
      tr("queue.editTitle"),
      `<p class="prompt-dlg-hint">${esc(tr("queue.editHint"))}</p>
     <textarea id="queue-edit-ta" class="queue-edit-ta" rows="6" spellcheck="true"></textarea>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-dark" id="queue-edit-save">${esc(tr("queue.editSave"))}</button>
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
    );
    const ta = document.getElementById(
      "queue-edit-ta",
    ) as HTMLTextAreaElement;
    ta.value = initial;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const save = document.getElementById("queue-edit-save");
    if (save) {
      save.onclick = () => {
        const text = ta.value.replace(/\r\n/g, "\n").trim();
        if (!text) {
          this.deps.showToast(tr("queue.editEmpty"), "error");
          return;
        }
        if (this.update(id, { display: text, content: text })) {
          this.deps.showToast(tr("queue.edited"));
          this.deps.closeModal();
        }
      };
    }
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
  }

  resume(): void {
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostSetQueueFlags(this.deps.inv, sid, {
        pausedByInterrupt: false,
      }).then((f) => {
        this.applyHostMirror(f);
        this.deps.showToast(tr("queue.resumed"));
        if (!this.deps.getTurnActive()) this.scheduleDrain();
      });
      return;
    }
    if (!this.items.length) {
      this.pausedByInterrupt = false;
      this.syncBar();
      return;
    }
    this.pausedByInterrupt = false;
    this.syncBar();
    this.deps.showToast(tr("queue.resumed"));
    if (!this.deps.getTurnActive()) this.scheduleDrain();
  }

  enqueue(item: Omit<QueuedPrompt, "id">): string {
    const id = newQueueItemId();
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      void hostEnqueue(this.deps.inv, sid, {
        id,
        content: item.content,
        display: item.display,
        attachments: item.attachments as unknown[],
      }).then((f) => {
        this.applyHostMirror(f);
        const toastKey = enqueueToastKey(this.pausedByInterrupt);
        this.deps.showToast(tr(toastKey, { n: this.items.length }));
        if (this.syncError) {
          this.deps.showToast(
            tr("queue.localOnly", { err: this.syncError }),
            "error",
          );
        }
      });
      return id;
    }
    this.items.push({ ...item, id });
    this.syncBar();
    const toastKey = enqueueToastKey(this.pausedByInterrupt);
    this.deps.showToast(tr(toastKey, { n: this.items.length }));
    return id;
  }

  scheduleDrain(): void {
    if (
      !canScheduleQueueDrain({
        pausedByInterrupt: this.pausedByInterrupt,
        queueLength: this.items.length,
        alreadyScheduled: this.drainScheduled,
      })
    ) {
      return;
    }
    this.drainScheduled = true;
    window.setTimeout(() => {
      this.drainScheduled = false;
      void this.drain();
    }, 80);
  }

  async drain(): Promise<void> {
    if (this.deps.getTurnActive()) return;
    if (this.pausedByInterrupt) return;
    const sid = this.deps.getActiveSessionId();
    if (!sid) {
      const next = this.items.shift();
      if (!next) {
        this.syncBar();
        return;
      }
      this.removeQueuedSystemLine(next.id);
      this.syncBar();
      await this.deps.dispatchAgentPrompt(next.content, next.display, {
        force: false,
        attachments: next.attachments as ComposerAttachment[] | undefined,
      });
      return;
    }
    const taken = await hostTakeNext(this.deps.inv, sid);
    if (!taken?.item) {
      if (taken?.queue) this.applyHostMirror(taken.queue);
      else this.syncBar();
      return;
    }
    if (this.deps.getActiveSessionId() !== sid) {
      await hostCompleteSending(
        this.deps.inv,
        sid,
        taken.item.id,
        false,
        "session switched during queue drain",
      );
      return;
    }
    this.applyHostMirror(taken.queue);
    const item = taken.item;
    this.removeQueuedSystemLine(item.id);
    const result = await this.deps.dispatchAgentPrompt(
      item.content,
      item.display,
      {
        force: false,
        attachments: (item.attachments as ComposerAttachment[]) ?? undefined,
      },
    );
    await hostCompleteSending(
      this.deps.inv,
      sid,
      item.id,
      result.ok,
      result.ok ? undefined : result.error,
    );
    if (this.deps.getActiveSessionId() === sid) {
      const file = await loadSessionQueue(this.deps.inv, sid);
      this.applyHostMirror(file);
    }
  }

  showModal(): { ok: boolean; message?: string } {
    if (!this.items.length) {
      this.deps.openModal(
        tr("queue.modalTitle"),
        buildPromptQueueEmptyModalHtml(),
      );
      const cancel = document.getElementById("prompt-dlg-cancel");
      if (cancel) cancel.onclick = () => this.deps.closeModal();
      return { ok: true, message: tr("queue.empty") };
    }
    this.deps.openModal(
      tr("queue.modalTitle"),
      buildPromptQueueModalBodyHtml(
        this.items.map((q) => ({
          id: q.id,
          display: q.display,
          content: q.content,
          status: q.status,
          lastError: q.lastError,
        })),
        this.pausedByInterrupt,
      ),
    );
    const resumeBtn = document.getElementById("queue-modal-resume");
    if (resumeBtn) {
      resumeBtn.onclick = () => {
        this.resume();
        this.deps.closeModal();
      };
    }
    const clearBtn = document.getElementById("queue-modal-clear");
    if (clearBtn) {
      clearBtn.onclick = () => {
        this.clear();
        this.deps.closeModal();
      };
    }
    const cancel = document.getElementById("prompt-dlg-cancel");
    if (cancel) cancel.onclick = () => this.deps.closeModal();
    return { ok: true };
  }
}
