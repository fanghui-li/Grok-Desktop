/**
 * 欢迎页项目选择器（自 main 迁出）。
 */
import { tr } from "../../shared/i18n/index.js";
import type { Project } from "../thread/model.js";

export type ProjectPickerUiDeps = {
  esc: (s: string) => string;
  getProjects: () => Project[];
  getSelectedProjectId: () => string | null;
  setSelectedProjectId: (id: string) => void;
  markChoiceTouched: () => void;
  setWelcomeTitle: () => void;
  showWelcome: (show: boolean) => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
};

export class ProjectPickerUi {
  constructor(private readonly deps: ProjectPickerUiDeps) {}

  close(): void {
    const picker = document.getElementById("project-picker");
    const chip = document.getElementById("btn-project-chip");
    picker?.classList.add("hidden");
    chip?.classList.remove("open");
    chip?.setAttribute("aria-expanded", "false");
  }

  renderList(filter = ""): void {
    const box = document.getElementById("project-picker-list");
    if (!box) return;
    box.innerHTML = "";
    const projects = this.deps.getProjects();
    const selectedId = this.deps.getSelectedProjectId();
    const q = filter.trim().toLowerCase();
    const filtered = projects.filter(
      (p) =>
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q),
    );
    if (!filtered.length) {
      box.innerHTML = `<div class="picker-empty">${projects.length ? tr("picker.noMatch") : tr("picker.noProjects")}</div>`;
      return;
    }
    for (const p of filtered) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `picker-project${p.id === selectedId ? " selected" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute(
        "aria-selected",
        p.id === selectedId ? "true" : "false",
      );
      const check =
        p.id === selectedId
          ? `<span class="picker-check">✓</span>`
          : `<span class="picker-check" style="visibility:hidden">✓</span>`;
      row.innerHTML = `<span class="picker-folder">📁</span><span class="picker-name">${this.deps.esc(p.title)}</span>${check}`;
      row.onclick = () => {
        this.deps.setSelectedProjectId(p.id);
        this.deps.markChoiceTouched();
        this.close();
        this.deps.setWelcomeTitle();
        this.deps.showWelcome(true);
        void this.deps.refreshProjectsAndThreads();
      };
      box.appendChild(row);
    }
  }

  open(opts?: { hideOtherMenus?: () => void }): void {
    const picker = document.getElementById("project-picker");
    const chip = document.getElementById("btn-project-chip");
    if (!picker || !chip) return;
    const wasOpen = !picker.classList.contains("hidden");
    if (wasOpen) {
      this.close();
      return;
    }
    opts?.hideOtherMenus?.();
    this.renderList("");
    const q = document.getElementById(
      "project-picker-q",
    ) as HTMLInputElement | null;
    if (q) q.value = "";
    picker.classList.remove("hidden");
    chip.classList.add("open");
    chip.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => q?.focus());
  }
}
