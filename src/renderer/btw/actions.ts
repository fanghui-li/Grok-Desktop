/**
 * 旁路侧问 /btw + 中途插话 /interject（自 main 迁出）。
 * 投影真源：session-btw-store；侧栏 DOM：BtwSideUi；主 transcript 插话乐观绘制在此。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { parseInlineBtwOrInterject } from "../composer/inline.js";
import { formatTurnErrorMessage } from "../lib/turn-error-format.js";
import {
  beginBtwFlight,
  getOrCreateSessionBtw,
  isBtwFlightCurrent,
  isBtwInFlight,
  replaceSessionBtwFromDisk,
  upsertBtwExchange,
  type BtwExchange,
  type BtwExchangeState,
} from "../session/btw-store.js";
import type { TurnUiPhase } from "../../shared/turn-ui-state.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string; details?: unknown };
}>;

export type BtwActionsDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  showWelcome: (show: boolean) => void;
  appendLine: (text: string, kind: "system" | "assistant" | "user" | "error") => void;
  getActiveSessionId: () => string | null;
  getActiveThreadId: () => string | null;
  getSessionViewGen: () => number;
  getTurnActive: () => boolean;
  getTurnUiPhase: () => TurnUiPhase;
  ensureLiveThread: (opts?: {
    syncModel?: boolean;
  }) => Promise<string | null>;
  /** 打开旁路侧问栏；force 时侧栏不可用则 false */
  openBtwCategory: (focusInput: boolean) => boolean;
  syncBtwAvailability: () => void;
  paintExchangeUi: (
    sessionId: string,
    ex: BtwExchange,
    opts?: { openSide?: boolean },
  ) => void;
  rebindForSession: (sessionId: string | null) => void;
  syncComposer: (sessionId?: string | null) => void;
  stopQuestion: () => void;
  clearThread: () => void;
  activeComposerInput: () => HTMLTextAreaElement | null;
  takeComposerPrompt: () => {
    display: string;
    content: string;
  } | null;
  recordPromptHistory: (text: string) => void;
  scrollTranscriptIfSticky: () => void;
  getTranscriptEl: () => HTMLElement | null;
};

export class BtwActions {
  /** 本端已乐观绘制的 interjection id（回声去重） */
  readonly selfInterjectionIds = new Set<string>();
  private interjectInFlight = false;

  constructor(private readonly deps: BtwActionsDeps) {}

  /**
   * 打开会话时从磁盘 btw_history.jsonl 合并进 store（可与内存 in-flight 并存）。
   */
  async loadHistoryForSession(
    sessionId: string,
    viewGen: number,
  ): Promise<void> {
    const sid = sessionId.trim();
    if (!sid) return;
    const res = await this.deps.inv<{
      sessionId: string;
      entries: Array<{
        btwSessionId: string;
        question: string;
        answer: string;
        success: boolean;
        error?: string;
        askedAt?: string;
      }>;
    }>("history.btwLoad", { sessionId: sid });
    if (viewGen !== this.deps.getSessionViewGen()) return;
    if (this.deps.getActiveSessionId() !== sid) return;
    if (!res.ok || !res.data?.entries?.length) {
      this.deps.rebindForSession(sid);
      return;
    }
    const fromDisk: BtwExchange[] = res.data.entries.map((e) => ({
      id: `btw_disk_${e.btwSessionId}`,
      question: e.question,
      state: (e.success ? "done" : "error") as BtwExchangeState,
      body: e.success ? e.answer : e.error || e.answer || tr("btw.fail"),
      updatedAtMs: e.askedAt ? Date.parse(e.askedAt) || Date.now() : Date.now(),
    }));
    replaceSessionBtwFromDisk(sid, fromDisk);
    this.deps.rebindForSession(sid);
  }

  /**
   * 旁路侧问：打开右侧「旁路侧问」栏。
   * 协议仍是 Grok `_x.ai/btw`；无问题正文时只展开面板。
   */
  async runBtwCommand(
    questionArg?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!this.deps.getActiveSessionId()) {
      this.deps.syncBtwAvailability();
      return { ok: false, message: tr("btw.needSession") };
    }
    let question = (questionArg ?? "").trim();
    if (!question) {
      const fromComposer = this.deps.activeComposerInput()?.value.trim() ?? "";
      const inline = parseInlineBtwOrInterject(fromComposer);
      if (inline?.kind === "btw" && inline.body) {
        question = inline.body;
        const ta = this.deps.activeComposerInput();
        if (ta) ta.value = "";
      } else if (
        fromComposer &&
        !fromComposer.startsWith("/") &&
        questionArg === undefined
      ) {
        // 仅 palette 无参时：优先打开侧栏，不吞主输入
      }
    }
    if (!question) {
      const opened = this.deps.openBtwCategory(true);
      if (!opened) {
        return { ok: false, message: tr("btw.needSession") };
      }
      return { ok: true, message: tr("btw.sideOpened") };
    }
    return this.sendBtwQuestion(question);
  }

  /** 从侧栏输入框发送侧问；进行中时点击 = 停止 */
  async sendBtwFromSidePanel(): Promise<void> {
    const sid = this.deps.getActiveSessionId();
    if (sid && isBtwInFlight(sid)) {
      this.deps.stopQuestion();
      return;
    }
    const ta = document.getElementById(
      "btw-side-input",
    ) as HTMLTextAreaElement | null;
    if (!ta) return;
    const question = ta.value.trim();
    if (!question) {
      this.deps.showToast(tr("btw.empty"), "error");
      return;
    }
    ta.value = "";
    ta.style.height = "auto";
    const res = await this.sendBtwQuestion(question);
    if (res.message && !res.ok) this.deps.showToast(res.message, "error");
  }

  async sendBtwQuestion(
    question: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const q = question.trim();
    if (!q) return { ok: false, message: tr("btw.empty") };
    const activeSid = this.deps.getActiveSessionId();
    if (!activeSid) {
      this.deps.syncBtwAvailability();
      return { ok: false, message: tr("btw.needSession") };
    }
    const sessionId = activeSid;
    if (isBtwInFlight(sessionId)) {
      return { ok: false, message: tr("btw.inFlight") };
    }

    this.deps.showWelcome(false);
    if (!this.deps.openBtwCategory(false)) {
      return { ok: false, message: tr("btw.needSession") };
    }

    const exId = `btw_ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const loading: BtwExchange = {
      id: exId,
      question: q,
      state: "loading",
      updatedAtMs: Date.now(),
    };
    upsertBtwExchange(sessionId, loading);
    const flightGen = beginBtwFlight(sessionId, exId);
    this.deps.paintExchangeUi(sessionId, loading, { openSide: true });
    this.deps.recordPromptHistory(`/btw ${q}`);

    try {
      // 对齐 CLI：/btw 只发扩展 RPC，不在侧问前 setModel
      const threadId = await this.deps.ensureLiveThread({ syncModel: false });
      if (!isBtwFlightCurrent(sessionId, flightGen, exId)) {
        return { ok: false, message: tr("btw.stopped") };
      }
      if (!threadId) {
        const msg = tr("btw.connectFail");
        const errEx: BtwExchange = {
          id: exId,
          question: q,
          state: "error",
          body: msg,
          updatedAtMs: Date.now(),
        };
        if (isBtwFlightCurrent(sessionId, flightGen, exId)) {
          upsertBtwExchange(sessionId, errEx);
          this.deps.paintExchangeUi(sessionId, errEx);
        }
        return { ok: false, message: msg };
      }

      const res = await this.deps.inv<{ sessionId: string; answer: string }>(
        "threads.btw",
        {
          threadId,
          question: q,
        },
      );
      if (!isBtwFlightCurrent(sessionId, flightGen, exId)) {
        return { ok: false, message: tr("btw.stopped") };
      }
      if (!res.ok) {
        const msg = formatTurnErrorMessage(
          res.error?.message ?? tr("btw.fail"),
          res.error?.details,
        );
        const errEx: BtwExchange = {
          id: exId,
          question: q,
          state: "error",
          body: msg,
          updatedAtMs: Date.now(),
        };
        upsertBtwExchange(sessionId, errEx);
        this.deps.paintExchangeUi(sessionId, errEx);
        return { ok: false, message: msg };
      }
      const doneEx: BtwExchange = {
        id: exId,
        question: q,
        state: "done",
        body: res.data?.answer ?? "",
        updatedAtMs: Date.now(),
      };
      upsertBtwExchange(sessionId, doneEx);
      this.deps.paintExchangeUi(sessionId, doneEx);
      return { ok: true, message: tr("btw.ok") };
    } finally {
      const p = getOrCreateSessionBtw(sessionId);
      if (p.inFlightId === exId && p.flightGen === flightGen) {
        const cur = p.exchanges.find((e) => e.id === exId);
        if (cur?.state === "loading") {
          const errEx: BtwExchange = {
            id: exId,
            question: q,
            state: "error",
            body: tr("btw.fail"),
            updatedAtMs: Date.now(),
          };
          upsertBtwExchange(sessionId, errEx);
          this.deps.paintExchangeUi(sessionId, errEx);
        } else if (p.inFlightId === exId) {
          p.inFlightId = null;
        }
      }
      if (this.deps.getActiveSessionId() === sessionId) {
        this.deps.syncComposer(sessionId);
      }
    }
  }

  bindSidePanel(): void {
    const ta = document.getElementById(
      "btw-side-input",
    ) as HTMLTextAreaElement | null;
    const sendBtn = document.getElementById("btn-btw-send");
    const clearBtn = document.getElementById("btn-btw-clear");
    sendBtn?.addEventListener("click", () => void this.sendBtwFromSidePanel());
    clearBtn?.addEventListener("click", () => {
      this.deps.clearThread();
      this.deps.showToast(tr("btw.cleared"));
    });
    ta?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const sid = this.deps.getActiveSessionId();
        if (sid && isBtwInFlight(sid)) {
          this.deps.showToast(tr("btw.inFlight"), "info");
          return;
        }
        void this.sendBtwFromSidePanel();
      }
    });
    ta?.addEventListener("input", () => {
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
    });
  }

  /** 插话用户块；失败时可 rollback */
  paintInterjectionMessage(
    text: string,
    interjectionId?: string,
  ): HTMLElement | null {
    const t = text.trim();
    if (!t) return null;
    const el = this.deps.getTranscriptEl();
    if (!el) return null;
    const wrap = document.createElement("div");
    wrap.className = "user-msg-block interjection";
    wrap.dataset.messageAuthorRole = "user";
    if (interjectionId) wrap.dataset.interjectionId = interjectionId;
    wrap.dataset.rawText = t;

    const bubble = document.createElement("div");
    bubble.className = "line user interjection-bubble";

    const tag = document.createElement("div");
    tag.className = "interjection-tag";
    tag.textContent = tr("interject.tag");

    const body = document.createElement("div");
    body.className = "msg-user-text";
    body.textContent = t;

    bubble.appendChild(tag);
    bubble.appendChild(body);
    wrap.appendChild(bubble);
    el.appendChild(wrap);
    this.deps.scrollTranscriptIfSticky();
    return wrap;
  }

  private rollbackInterjection(
    interjectionId: string,
    el: HTMLElement | null,
  ): void {
    this.selfInterjectionIds.delete(interjectionId);
    el?.remove();
  }

  async runInterjectCommand(
    textArg?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.getTurnUiPhase() === "cancelling") {
      return { ok: false, message: tr("interject.cancelling") };
    }
    if (!this.deps.getTurnActive() || this.deps.getTurnUiPhase() !== "working") {
      return { ok: false, message: tr("interject.needTurn") };
    }
    if (this.interjectInFlight) {
      return { ok: false, message: tr("interject.inFlight") };
    }
    let text = (textArg ?? "").trim();
    let historyAlreadyRecorded = false;
    if (!text) {
      const taken = this.deps.takeComposerPrompt();
      if (taken) {
        text = taken.content.trim() || taken.display.trim();
        historyAlreadyRecorded = true;
      }
    }
    if (!text) {
      return { ok: false, message: tr("interject.empty") };
    }

    this.interjectInFlight = true;
    const interjectionId = `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    this.selfInterjectionIds.add(interjectionId);
    const painted = this.paintInterjectionMessage(text, interjectionId);
    if (!historyAlreadyRecorded) this.deps.recordPromptHistory(text);

    try {
      const activeTid = this.deps.getActiveThreadId();
      const threadId =
        activeTid && !activeTid.startsWith("disk_")
          ? activeTid
          : await this.deps.ensureLiveThread({ syncModel: false });
      if (!threadId) {
        this.rollbackInterjection(interjectionId, painted);
        return { ok: false, message: tr("chat.connectFail") };
      }

      const phaseAfter = this.deps.getTurnUiPhase() as TurnUiPhase;
      if (!this.deps.getTurnActive() || phaseAfter !== "working") {
        this.rollbackInterjection(interjectionId, painted);
        return {
          ok: false,
          message:
            phaseAfter === "cancelling"
              ? tr("interject.cancelling")
              : tr("interject.needTurn"),
        };
      }

      const res = await this.deps.inv<{
        sessionId: string;
        status: string;
        interjectionId: string;
      }>("threads.interject", { threadId, text, interjectionId });

      if (!res.ok) {
        this.rollbackInterjection(interjectionId, painted);
        const msg = formatTurnErrorMessage(
          res.error?.message ?? tr("interject.fail"),
          res.error?.details,
        );
        this.deps.appendLine(msg, "error");
        return { ok: false, message: msg };
      }
      this.deps.showToast(tr("interject.ok"));
      return { ok: true, message: tr("interject.ok") };
    } finally {
      this.interjectInFlight = false;
    }
  }
}
