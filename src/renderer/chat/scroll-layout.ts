/**
 * 会话区 sticky-bottom + 底栏高度预留（自 main 迁出）。
 *
 * chatStick === true  → 内容变更时程序贴底
 * chatStick === false → **绝不写 scrollTop**
 *
 * 状态更新规则（无 pin / 无 ignore / 无 resize 旁路）：
 *   - scrollTop 变小（上滑/拖条上移）→ 立刻 unstick
 *   - 距底 ≤ NEAR 且未因上滑离开 → stick
 * 上滚轮额外立刻 unstick（赶在流式 rAF 之前）
 */
const CHAT_NEAR_BOTTOM_PX = 80;
const CHAT_FAB_HIDE_PX = 64;

export type ChatScrollLayoutDeps = {
  /** 关闭 model/perm 等浮层（window resize） */
  hideEphemeralMenus: () => void;
  getTranscriptEl: () => HTMLElement | null;
};

export class ChatScrollLayout {
  private stick = true;
  private lastScrollTop = 0;
  private streamScrollRaf = 0;

  constructor(private readonly deps: ChatScrollLayoutDeps) {}

  get isStick(): boolean {
    return this.stick;
  }

  /** 强制 stick（进会话 / clear transcript 等） */
  forceStick(): void {
    this.stick = true;
  }

  cancelStreamRaf(): void {
    if (this.streamScrollRaf) {
      cancelAnimationFrame(this.streamScrollRaf);
      this.streamScrollRaf = 0;
    }
  }

  private scroller(): HTMLElement {
    return (
      (document.getElementById("chat-scroll") as HTMLElement | null) ??
      this.deps.getTranscriptEl() ??
      document.body
    );
  }

  private scrollGap(scroller?: HTMLElement): number {
    const s = scroller ?? this.scroller();
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }

  private updateFab(): void {
    const fab = document.getElementById("btn-scroll-down");
    const scroller = document.getElementById("chat-scroll");
    if (!fab || !scroller) return;
    const show = !this.stick || this.scrollGap(scroller) >= CHAT_FAB_HIDE_PX;
    fab.classList.toggle("hidden", !show);
  }

  private applyScrollToBottom(): void {
    if (!this.stick) {
      this.updateFab();
      return;
    }
    const scroller = this.scroller();
    scroller.scrollTop = scroller.scrollHeight;
    this.lastScrollTop = scroller.scrollTop;
    this.updateFab();
  }

  /** 发消息 / FAB / 进会话：强制 stick 并滚到底 */
  scrollToBottom(): void {
    this.stick = true;
    this.cancelStreamRaf();
    this.applyScrollToBottom();
  }

  /** 流式 / 工具 / DOM 变更：仅 stick 时贴底，否则零写入 */
  scrollIfSticky(): void {
    if (!this.stick) {
      this.updateFab();
      return;
    }
    this.applyScrollToBottom();
  }

  /**
   * 流式 delta：合并到下一帧再贴底（避免每 token 强制 layout）。
   * 已有 rAF 则跳过。
   */
  scheduleStreamScroll(): void {
    if (this.streamScrollRaf) return;
    this.streamScrollRaf = requestAnimationFrame(() => {
      this.streamScrollRaf = 0;
      this.scrollIfSticky();
    });
  }

  /** 流式结束：取消待贴底 rAF，立刻 sticky 贴底 */
  flushStreamScroll(): void {
    this.cancelStreamRaf();
    this.scrollIfSticky();
  }

  /** 底栏贴底：消息区优先让位；坞 max-height 保证完整在 chat 内 */
  syncComposerReserve(): void {
    const chat = document.getElementById("chat");
    const dock = document.getElementById("chat-composer-dock");
    if (!chat || !dock) return;
    if (chat.classList.contains("hidden")) return;

    const chatH = chat.clientHeight || 0;
    if (chatH <= 0) return;

    const minScroll = Math.max(72, Math.floor(chatH * 0.4));
    const byScroll = Math.max(96, chatH - minScroll);
    const byRatio = Math.floor(
      chatH * (chatH < 420 ? 0.52 : chatH < 600 ? 0.48 : 0.45),
    );
    const maxDock = Math.min(byScroll, byRatio, 300);
    dock.style.maxHeight = `${maxDock}px`;

    const ta = document.getElementById(
      "chat-input",
    ) as HTMLTextAreaElement | null;
    const goal = document.getElementById("goal-banner-chat");
    const perm = document.getElementById("permission-bar");
    const toolbar = dock.querySelector(
      ".composer-toolbar",
    ) as HTMLElement | null;
    const goalH =
      goal && !goal.classList.contains("hidden")
        ? goal.getBoundingClientRect().height + 6
        : 0;
    const permH =
      perm && !perm.classList.contains("hidden")
        ? perm.getBoundingClientRect().height + 8
        : 0;
    const toolbarH = toolbar?.getBoundingClientRect().height ?? 36;
    const chrome = 28;
    const maxTa = Math.max(
      22,
      Math.min(120, Math.floor(maxDock - goalH - permH - toolbarH - chrome)),
    );
    if (ta) {
      ta.style.maxHeight = `${maxTa}px`;
      this.fitChatInputHeight(ta, maxTa);
    }

    const h = Math.ceil(dock.getBoundingClientRect().height);
    chat.style.setProperty("--chat-composer-h", `${Math.max(h, 72)}px`);
    this.scrollIfSticky();
  }

  fitChatInputHeight(ta: HTMLTextAreaElement, maxPx: number): void {
    if (!ta.value) {
      ta.style.height = "";
      return;
    }
    ta.style.height = "0px";
    const next = Math.min(Math.max(ta.scrollHeight, 28), maxPx);
    ta.style.height = `${next}px`;
  }

  bind(): void {
    const scroller = document.getElementById("chat-scroll");
    const dock = document.getElementById("chat-composer-dock");
    const fab = document.getElementById("btn-scroll-down");
    if (!scroller) return;

    this.lastScrollTop = scroller.scrollTop;

    const unstickNow = () => {
      this.stick = false;
      this.cancelStreamRaf();
      this.updateFab();
    };

    scroller.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0 && scroller.scrollHeight > scroller.clientHeight) {
          unstickNow();
        }
      },
      { passive: true },
    );

    window.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        const rect = scroller.getBoundingClientRect();
        if (
          e.clientY < rect.top ||
          e.clientY > rect.bottom ||
          e.clientX < rect.left ||
          e.clientX > rect.right
        ) {
          return;
        }
        const barLeft = Math.min(
          rect.left + scroller.clientWidth,
          rect.right - 16,
        );
        if (e.clientX >= barLeft) unstickNow();
      },
      { capture: true },
    );

    scroller.addEventListener(
      "scroll",
      () => {
        const top = scroller.scrollTop;
        const gap = this.scrollGap(scroller);
        if (top < this.lastScrollTop - 0.5) {
          this.stick = false;
        } else if (gap <= CHAT_NEAR_BOTTOM_PX) {
          this.stick = true;
        }
        this.lastScrollTop = top;
        this.updateFab();
      },
      { passive: true },
    );

    fab?.addEventListener("click", () => this.scrollToBottom());
    const chat = document.getElementById("chat");
    const chatInput = document.getElementById(
      "chat-input",
    ) as HTMLTextAreaElement | null;
    chatInput?.addEventListener("input", () => {
      const maxRaw = chatInput.style.maxHeight;
      const maxPx = maxRaw ? parseInt(maxRaw, 10) : 120;
      this.fitChatInputHeight(
        chatInput,
        Number.isFinite(maxPx) ? maxPx : 120,
      );
      this.syncComposerReserve();
    });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.syncComposerReserve());
      if (dock) ro.observe(dock);
      if (chat) ro.observe(chat);
    }
    window.addEventListener("resize", () => {
      this.syncComposerReserve();
      this.deps.hideEphemeralMenus();
    });
    if (chat && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => {
        if (!chat.classList.contains("hidden")) {
          requestAnimationFrame(() => this.syncComposerReserve());
        }
      }).observe(chat, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
    requestAnimationFrame(() => this.syncComposerReserve());
  }
}
