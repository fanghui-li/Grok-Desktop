/**
 * 权限 chip 菜单 DOM（自 main 迁出）。
 * accessMode 真源仍在 main；菜单只反映访问策略，与 plan 无关。
 */
export type AccessModeUi = "normal" | "always_approve";

export type PermMenuUiDeps = {
  getAccessMode: () => AccessModeUi;
  hideModelMenu: () => void;
  hidePlusMenu: () => void;
  /** 取 #perm-menu；main 可用 $() */
  getMenuEl: () => HTMLElement | null;
};

export class PermMenuUi {
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private openRaf = 0;

  constructor(private readonly deps: PermMenuUiDeps) {}

  isVisible(): boolean {
    const menu = this.deps.getMenuEl();
    return Boolean(menu && !menu.classList.contains("hidden"));
  }

  /**
   * 关闭权限菜单。
   * @param immediate 窗口 resize 等场景跳过动画，避免残影留在原点
   */
  hide(opts?: { immediate?: boolean }): void {
    const menu = this.deps.getMenuEl();
    if (!menu) return;
    if (this.openRaf) {
      cancelAnimationFrame(this.openRaf);
      this.openRaf = 0;
    }
    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    const finish = () => {
      menu.classList.add("hidden");
      menu.classList.remove("is-open", "open-up", "open-down");
      delete menu.dataset.anchor;
    };

    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (
      opts?.immediate ||
      reduced ||
      menu.classList.contains("hidden") ||
      !menu.classList.contains("is-open")
    ) {
      menu.classList.remove("is-open");
      finish();
      return;
    }

    menu.classList.remove("is-open");
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== menu) return;
      if (e.propertyName !== "opacity" && e.propertyName !== "transform")
        return;
      menu.removeEventListener("transitionend", onEnd);
      if (this.closeTimer != null) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      finish();
    };
    menu.addEventListener("transitionend", onEnd);
    this.closeTimer = setTimeout(() => {
      menu.removeEventListener("transitionend", onEnd);
      this.closeTimer = null;
      finish();
    }, 240);
  }

  syncActiveItem(): void {
    const menu = this.deps.getMenuEl();
    if (!menu) return;
    const accessMode = this.deps.getAccessMode();
    for (const btn of Array.from(
      menu.querySelectorAll<HTMLElement>("[data-mode]"),
    )) {
      const mode = btn.dataset.mode;
      const active =
        mode === "always_approve"
          ? accessMode === "always_approve"
          : mode === "normal"
            ? accessMode === "normal"
            : false;
      btn.classList.toggle("is-active", active);
    }
  }

  show(anchor: HTMLElement): void {
    this.deps.hideModelMenu();
    this.deps.hidePlusMenu();
    const menu = this.deps.getMenuEl();
    if (!menu) return;

    if (
      this.isVisible() &&
      menu.classList.contains("is-open") &&
      menu.dataset.anchor === anchor.id
    ) {
      this.hide();
      return;
    }

    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.openRaf) {
      cancelAnimationFrame(this.openRaf);
      this.openRaf = 0;
    }

    menu.classList.remove("hidden", "is-open");
    this.syncActiveItem();
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 160;
    const mh = menu.offsetHeight || 88;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (left < 8) left = 8;
    const spaceBelow = window.innerHeight - r.bottom;
    let top: number;
    let openUp = false;
    if (spaceBelow < mh + 12 && r.top > mh + 12) {
      top = Math.max(8, r.top - mh - 6);
      openUp = true;
    } else {
      top = r.bottom + 4;
      if (top + mh > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - mh - 8);
      }
      openUp = top + mh / 2 < r.top;
    }
    menu.classList.toggle("open-up", openUp);
    menu.classList.toggle("open-down", !openUp);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.dataset.anchor = anchor.id;

    void menu.offsetWidth;
    this.openRaf = requestAnimationFrame(() => {
      this.openRaf = 0;
      menu.classList.add("is-open");
    });
  }
}
