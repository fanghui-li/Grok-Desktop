/**
 * Composer + 菜单（附件 / plan / goal 入口，自 main 迁出）。
 */
export type PlusMenuUiDeps = {
  onPickFiles: () => unknown;
  onPlan: () => unknown;
  onGoal: () => unknown;
};

export class PlusMenuUi {
  constructor(private readonly deps: PlusMenuUiDeps) {}

  hide(): void {
    document.getElementById("plus-menu")?.classList.add("hidden");
  }

  show(anchor: HTMLElement): void {
    const menu = document.getElementById("plus-menu");
    if (!menu) return;
    const r = anchor.getBoundingClientRect();
    menu.classList.remove("hidden");
    const mw = menu.offsetWidth || 220;
    let left = r.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    menu.style.left = `${Math.max(8, left)}px`;
    const mh = menu.offsetHeight || 160;
    if (r.top > mh + 12) {
      menu.style.top = `${r.top - mh - 6}px`;
    } else {
      menu.style.top = `${r.bottom + 6}px`;
    }
  }

  bind(): void {
    for (const id of [
      "btn-attach",
      "btn-attach-chat",
      "btn-focus-attach",
    ] as const) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = document.getElementById("plus-menu");
        if (!menu) return;
        if (!menu.classList.contains("hidden") && menu.dataset.anchor === id) {
          this.hide();
          return;
        }
        menu.dataset.anchor = id;
        this.show(btn as HTMLElement);
      });
    }
    const plus = document.getElementById("plus-menu");
    if (plus) {
      plus.onclick = (e) => {
        const t = (e.target as HTMLElement).closest(
          "[data-plus]",
        ) as HTMLElement | null;
        if (!t) return;
        const act = t.dataset.plus;
        this.hide();
        if (act === "files") void this.deps.onPickFiles();
        if (act === "plan") void this.deps.onPlan();
        if (act === "goal") void this.deps.onGoal();
      };
    }
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (
        !t.closest(
          "#plus-menu, #btn-attach, #btn-attach-chat, #btn-focus-attach",
        )
      ) {
        this.hide();
      }
    });
  }
}
