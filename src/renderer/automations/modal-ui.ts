/**
 * 自动化（定时任务）弹层（自 main 迁出）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type AutomationProject = { id: string; title: string };

export type AutomationsModalUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  openModal: (title: string, bodyHtml: string) => void;
  getProjects: () => AutomationProject[];
};

export class AutomationsModalUi {
  constructor(private readonly deps: AutomationsModalUiDeps) {}

  async show(): Promise<void> {
    const list = await this.deps.inv<
      Array<{
        id: string;
        name: string;
        status: string;
        prompt: string;
        projectId: string;
      }>
    >("automations.list");
    const esc = this.deps.esc;
    const projects = this.deps.getProjects();
    this.deps.openModal(
      tr("nav.automations"),
      `
    <div style="display:grid;gap:8px;margin-bottom:12px">
      <input id="auto-name" placeholder="${esc(tr("plug.mcpName"))}" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)" />
      <select id="auto-project" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)">
        ${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join("")}
      </select>
      <textarea id="auto-prompt" rows="3" placeholder="定时任务指令" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text)"></textarea>
      <button type="button" class="btn-dark" id="btn-auto-create">创建</button>
    </div>
    ${(list.data ?? [])
      .map(
        (a) => `<div class="item"><div class="item-title">${esc(a.name)} · ${esc(a.status)}</div><div class="item-sub">${esc(a.prompt)}</div>
      <button type="button" class="btn-ghost" style="margin-top:6px" data-run="${esc(a.id)}">立即运行</button></div>`,
      )
      .join("") || '<div class="item-sub">暂无自动化</div>'}
    `,
    );
    const body = document.getElementById("modal-body");
    if (!body) return;
    body.onclick = async (e) => {
      const t = e.target as HTMLElement;
      if (t.id === "btn-auto-create") {
        const name = (
          document.getElementById("auto-name") as HTMLInputElement
        ).value.trim();
        const projectId = (
          document.getElementById("auto-project") as HTMLSelectElement
        ).value;
        const prompt = (
          document.getElementById("auto-prompt") as HTMLTextAreaElement
        ).value.trim();
        if (!name || !projectId || !prompt) return;
        await this.deps.inv("automations.create", {
          name,
          projectId,
          schedule: "manual",
          prompt,
          worktreeMode: "project_root",
          alwaysApprove: false,
        });
        await this.show();
      }
      if (t.dataset.run) {
        const r = await this.deps.inv("automations.runNow", {
          id: t.dataset.run,
        });
        if (!r.ok) alert(r.error?.message);
        else alert(tr("auto.started"));
      }
    };
  }
}
