/**
 * 项目列表移除等（自 main 迁出；不删磁盘文件夹）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import type { Project } from "../thread/model.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ProjectActionsDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  getSelectedProjectId: () => string | null;
  setSelectedProjectId: (id: string | null) => void;
  setProjectChoiceTouched: (v: boolean) => void;
  getProjects: () => Project[];
  /** 侧栏展开/「显示全部」态清理 */
  onProjectRemovedFromSidebar: (id: string) => void;
  refreshProjectsAndThreads: () => void | Promise<void>;
  setWelcomeTitle: () => void;
  showWelcome: (show: boolean) => void;
  getActiveThreadId: () => string | null;
  getActiveSessionId: () => string | null;
};

export class ProjectActions {
  constructor(private readonly deps: ProjectActionsDeps) {}

  /** 从 Desktop 项目列表移除（不删除磁盘上的文件夹） */
  async removeFromList(
    id: string,
    title: string,
    projectPath: string,
  ): Promise<void> {
    const ok = window.confirm(
      `从列表移除项目「${title}」？\n\n不会删除磁盘上的文件夹：\n${projectPath}`,
    );
    if (!ok) return;
    const res = await this.deps.inv("projects.remove", { id });
    if (!res.ok) {
      this.deps.showToast(res.error?.message ?? "移除失败", "error");
      return;
    }
    this.deps.onProjectRemovedFromSidebar(id);
    if (this.deps.getSelectedProjectId() === id) {
      this.deps.setSelectedProjectId(null);
      this.deps.setProjectChoiceTouched(true);
    }
    await this.deps.refreshProjectsAndThreads();
    if (!this.deps.getSelectedProjectId() && this.deps.getProjects().length) {
      this.deps.setSelectedProjectId(this.deps.getProjects()[0].id);
    }
    this.deps.setWelcomeTitle();
    if (!this.deps.getActiveThreadId() && !this.deps.getActiveSessionId()) {
      this.deps.showWelcome(true);
    }
    this.deps.showToast(`已移除「${title}」`);
  }
}
