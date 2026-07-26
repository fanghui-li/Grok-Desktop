/**
 * 旁路侧问（btw）侧栏线程 DOM（整段自 main 迁出）。
 * 投影真源仍在 session-btw-store；RPC 发送路径由 main 经 deps 完成。
 */
import { tr } from "../../shared/i18n/index.js";
import { sendButtonIconHtml } from "../sidebar/icons.js";
import {
  cancelSessionBtwFlight,
  clearSessionBtw,
  isBtwInFlight,
  listSessionBtw,
  type BtwExchange,
} from "../session/btw-store.js";

export type BtwSideUiDeps = {
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  getActiveSessionId: () => string | null;
  ensureBtwSideOpen: () => boolean;
  renderMarkdownToSafeHtml: (md: string) => string;
};

export class BtwSideUi {
  constructor(private readonly deps: BtwSideUiDeps) {}

  private threadEl(): HTMLElement | null {
    return document.getElementById("btw-side-thread");
  }

  private hideEmpty(): void {
    document.getElementById("btw-side-empty")?.classList.add("hidden");
  }

  private showEmpty(): void {
    const thread = this.threadEl();
    const empty = document.getElementById("btw-side-empty");
    if (!thread || !empty) return;
    empty.classList.remove("hidden");
    if (!thread.contains(empty)) thread.appendChild(empty);
  }

  /** 将 store 中的一条 exchange 画到 #btw-side-thread（仅前台会话应调用） */
  paintExchange(ex: BtwExchange): void {
    const thread = this.threadEl();
    if (!thread) return;
    this.hideEmpty();
    let block = document.getElementById(ex.id) as HTMLElement | null;
    if (!block) {
      block = document.createElement("div");
      block.id = ex.id;
      block.className = "btw-ex";
      thread.appendChild(block);
    }
    const state = ex.state;
    block.classList.toggle("btw-ex--error", state === "error");
    block.classList.toggle("btw-ex--done", state === "done");
    block.classList.toggle("btw-ex--loading", state === "loading");
    block.classList.toggle("btw-ex--stopped", state === "stopped");
    const qHtml = `<div class="btw-ex-q"><div class="btw-ex-bubble btw-ex-bubble-user">${this.deps.esc(ex.question)}</div></div>`;
    let aHtml: string;
    if (state === "loading") {
      aHtml = `<div class="btw-ex-a"><div class="btw-ex-bubble btw-ex-bubble-ai btw-loading">${this.deps.esc(tr("btw.loading"))}</div></div>`;
    } else if (state === "error") {
      aHtml = `<div class="btw-ex-a"><div class="btw-ex-bubble btw-ex-bubble-ai btw-err">${this.deps.esc(ex.body || tr("btw.fail"))}</div></div>`;
    } else if (state === "stopped") {
      aHtml = `<div class="btw-ex-a"><div class="btw-ex-bubble btw-ex-bubble-ai">${this.deps.esc(ex.body || tr("btw.stopped"))}</div></div>`;
    } else {
      aHtml = `<div class="btw-ex-a"><div class="btw-ex-bubble btw-ex-bubble-ai">${this.deps.renderMarkdownToSafeHtml(ex.body ?? "")}</div></div>`;
    }
    block.innerHTML = qHtml + aHtml;
    thread.scrollTop = thread.scrollHeight;
  }

  /**
   * 按 sessionId 重绘侧问线程（切会话 / 清空 / 离开）。
   * DOM 是全局单例，投影按会话存在 session-btw-store。
   */
  rebindForSession(sessionId: string | null): void {
    const thread = this.threadEl();
    if (!thread) return;
    thread.querySelectorAll(".btw-ex").forEach((n) => n.remove());
    const list = sessionId ? listSessionBtw(sessionId) : [];
    if (!list.length) {
      this.showEmpty();
    } else {
      for (const ex of list) this.paintExchange(ex);
    }
    this.syncComposer(sessionId);
  }

  /** 侧栏发送钮：空闲=发送，本会话侧问 in-flight=停止（不禁用输入） */
  syncComposer(sessionId?: string | null): void {
    const sid =
      sessionId === undefined ? this.deps.getActiveSessionId() : sessionId;
    const busy = Boolean(sid && isBtwInFlight(sid));
    const sendBtn = document.getElementById(
      "btn-btw-send",
    ) as HTMLButtonElement | null;
    if (sendBtn) {
      sendBtn.disabled = false;
      if (busy) {
        sendBtn.classList.add("stop");
        sendBtn.innerHTML = sendButtonIconHtml(true);
        sendBtn.title = tr("btw.stop");
        sendBtn.setAttribute("aria-label", tr("btw.stop"));
      } else {
        sendBtn.classList.remove("stop");
        sendBtn.innerHTML = sendButtonIconHtml(false);
        sendBtn.title = tr("btw.send");
        sendBtn.setAttribute("aria-label", tr("btw.send"));
      }
    }
    // 侧问进行中仍可编辑草稿；仅发送钮变 stop
    const ta = document.getElementById(
      "btw-side-input",
    ) as HTMLTextAreaElement | null;
    if (ta) ta.readOnly = false;
  }

  /** store 更新后：仅当前前台会话刷新对应 DOM 块 */
  applyExchangeUi(
    sessionId: string,
    ex: BtwExchange,
    opts?: { openSide?: boolean },
  ): void {
    if (sessionId !== this.deps.getActiveSessionId()) {
      this.syncComposer(this.deps.getActiveSessionId());
      return;
    }
    if (opts?.openSide) this.deps.ensureBtwSideOpen();
    this.paintExchange(ex);
    this.syncComposer(sessionId);
  }

  clearThread(): void {
    const sid = this.deps.getActiveSessionId();
    if (sid) {
      // 清空 UI 投影；进行中的 RPC 也丢弃
      cancelSessionBtwFlight(sid, tr("btw.stopped"));
      clearSessionBtw(sid);
    }
    this.rebindForSession(sid);
  }

  /** 丢弃本会话 in-flight 侧问结果（无 agent cancel API；仅 UI + flightGen） */
  stopQuestion(): void {
    const sid = this.deps.getActiveSessionId();
    if (!sid || !isBtwInFlight(sid)) return;
    const r = cancelSessionBtwFlight(sid, tr("btw.stopped"));
    if (r?.exchangeId) {
      const ex = listSessionBtw(sid).find((e) => e.id === r.exchangeId);
      if (ex) this.applyExchangeUi(sid, ex);
      else this.rebindForSession(sid);
    } else {
      this.syncComposer(sid);
    }
    this.deps.showToast(tr("btw.stopped"), "info");
  }
}
