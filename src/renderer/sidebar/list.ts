/**
 * 左侧项目 / 会话列表 DOM（整段自 main 迁出）。
 * 会话打开、归档、fork 等业务经 deps 回调回 main。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { formatAge } from "../lib/format-utils.js";
import { sidebarIcon } from "./icons.js";
import { visibleThreadForest } from "../thread/forest.js";
import {
  CHATS_GROUP_ID,
  THREADS_PREVIEW_LIMIT,
  isThreadOpen,
  parentThreadTitle,
  threadsForChatsGroup,
  threadsForProject,
  type Project,
  type ThreadRow,
} from "../thread/model.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}>;

export type SidebarListDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  getProjects: () => Project[];
  setProjects: (p: Project[]) => void;
  getThreads: () => ThreadRow[];
  setThreads: (t: ThreadRow[]) => void;
  getSelectedProjectId: () => string | null;
  setSelectedProjectId: (id: string | null) => void;
  getProjectChoiceTouched: () => boolean;
  setProjectChoiceTouched: (v: boolean) => void;
  getActiveThreadId: () => string | null;
  getActiveSessionId: () => string | null;
  isSessionWorking: (sessionId: string) => boolean;
  onListRefreshed: () => void;
  onOpenThread: (t: ThreadRow) => void;
  onProjectSelected: (projectId: string) => void;
  onRemoveProject: (
    id: string,
    title: string,
    projectPath: string,
  ) => void | Promise<void>;
  onRenameThread: (t: ThreadRow) => void | Promise<void>;
  onExportThread: (
    t: ThreadRow,
    destination: "clipboard" | "file",
  ) => void | Promise<void>;
  onForkThread: (t: ThreadRow) => void | Promise<void>;
  onArchiveThread: (t: ThreadRow, archived: boolean) => void | Promise<void>;
  onDeleteThread: (t: ThreadRow) => void | Promise<void>;
  onOpenParentThread: (parent: ThreadRow) => void;
};

export class SidebarListController {
  readonly expandedProjectIds = new Set<string>();
  readonly projectShowAllThreads = new Set<string>();
  readonly expandedArchiveIds = new Set<string>();
  private projectExpandInitialized = false;

  constructor(private readonly deps: SidebarListDeps) {}

  hideThreadMenu(): void {
    document.getElementById("thread-ctx-menu")?.remove();
  }

  showThreadMenu(
    anchor: HTMLElement,
    t: ThreadRow,
    mode: "active" | "archived",
  ): void {
    const { deps } = this;
    this.hideThreadMenu();
    const menu = document.createElement("div");
    menu.id = "thread-ctx-menu";
    menu.className = "thread-ctx-menu";
    menu.setAttribute("role", "menu");

    const addItem = (label: string, danger: boolean, onClick: () => void) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `thread-ctx-item${danger ? " danger" : ""}`;
      item.textContent = label;
      item.onclick = (e) => {
        e.stopPropagation();
        this.hideThreadMenu();
        onClick();
      };
      menu.appendChild(item);
    };

    addItem(tr("session.menuRename"), false, () => {
      void deps.onRenameThread(t);
    });
    addItem(tr("session.menuExportClipboard"), false, () => {
      void deps.onExportThread(t, "clipboard");
    });
    addItem(tr("session.menuExportFile"), false, () => {
      void deps.onExportThread(t, "file");
    });
    if (mode === "active") {
      addItem(tr("session.menuFork"), false, () => {
        void deps.onForkThread(t);
      });
      const parentId = t.parentSessionId;
      if (parentId) {
        addItem(tr("session.menuOpenParent"), false, () => {
          const parent = deps.getThreads().find((x) => x.sessionId === parentId);
          if (!parent) {
            deps.showToast(tr("session.parentMissing"), "error");
            return;
          }
          deps.onOpenParentThread(parent);
        });
      }
      addItem(tr("session.menuArchive"), false, () => {
        void deps.onArchiveThread(t, true);
      });
      addItem(tr("session.menuDelete"), true, () => {
        void deps.onDeleteThread(t);
      });
    } else {
      addItem(tr("session.menuRestore"), false, () => {
        void deps.onArchiveThread(t, false);
      });
      addItem(tr("session.menuDelete"), true, () => {
        void deps.onDeleteThread(t);
      });
    }

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const mw = 160;
    let left = rect.right - mw;
    let top = rect.bottom + 4;
    if (left < 8) left = 8;
    if (top + 160 > window.innerHeight) top = Math.max(8, rect.top - 160);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.minWidth = `${mw}px`;

    const onDoc = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this.hideThreadMenu();
        document.removeEventListener("mousedown", onDoc, true);
      }
    };
    window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc, true);
    }, 0);
  }

  makeThreadRow(
    t: ThreadRow,
    projectId: string,
    mode: "active" | "archived",
    depth = 0,
  ): HTMLElement {
    const { deps } = this;
    const row = document.createElement("div");
    const isActive = isThreadOpen(
      t,
      deps.getActiveThreadId(),
      deps.getActiveSessionId(),
    );
    const isWorking =
      t.status === "working" || deps.isSessionWorking(t.sessionId);
    const isFork =
      t.sessionKind === "fork" ||
      (!!t.parentSessionId && t.parentSessionId.length > 0);
    const depthClamped = Math.max(0, Math.min(depth, 6));
    row.className = `thread-item depth-${depthClamped}${isActive ? " active" : ""}${isWorking ? " working" : ""}${mode === "archived" ? " is-archived" : ""}${isFork ? " is-fork" : ""}`;
    row.dataset.sessionId = t.sessionId;
    row.dataset.depth = String(depthClamped);
    if (depthClamped > 0) {
      const base = mode === "archived" ? 36 : 28;
      row.style.paddingLeft = `${base + depthClamped * 14}px`;
    }

    const main = document.createElement("button");
    main.type = "button";
    main.className = "thread-item-main";
    const spin = isWorking ? `<span class="thread-spin"></span>` : "";
    const titleText = deps.esc(t.title || t.sessionId.slice(0, 8));
    const badge = isFork
      ? `<span class="thread-fork-badge" title="${deps.esc(tr("session.forkBadgeTitle"))}">${deps.esc(tr("session.forkBadge"))}</span>`
      : "";
    const nested = depthClamped > 0;
    const fromLabel =
      isFork && !nested
        ? parentThreadTitle(
            deps.getThreads(),
            t.parentSessionId,
            tr("slash.forkDefaultTitle"),
          )
        : null;
    const fromHtml = fromLabel
      ? `<span class="thread-fork-from">${deps.esc(tr("session.forkFrom", { title: fromLabel }))}</span>`
      : "";
    const nestMark = nested
      ? `<span class="thread-nest-mark" aria-hidden="true">└</span>`
      : "";
    main.innerHTML = `${spin}<span class="thread-item-text"><span class="thread-title-row">${nestMark}${badge}<span class="thread-title">${titleText}</span></span>${fromHtml}</span><span class="thread-age">${deps.esc(formatAge(t.updatedAt))}</span>`;
    if (fromLabel) {
      main.title = tr("session.forkFrom", { title: fromLabel });
    } else if (nested && t.parentSessionId) {
      const pTitle = parentThreadTitle(
        deps.getThreads(),
        t.parentSessionId,
        tr("slash.forkDefaultTitle"),
      );
      if (pTitle) main.title = tr("session.forkFrom", { title: pTitle });
    }
    main.onclick = (e) => {
      e.stopPropagation();
      this.hideThreadMenu();
      if (projectId === CHATS_GROUP_ID) {
        deps.setSelectedProjectId(null);
        deps.setProjectChoiceTouched(true);
        this.expandedProjectIds.add(CHATS_GROUP_ID);
      } else {
        deps.setSelectedProjectId(projectId);
        this.expandedProjectIds.add(projectId);
      }
      deps.onOpenThread(t);
    };

    const more = document.createElement("button");
    more.type = "button";
    more.className = "thread-act-btn";
    more.title = tr("side.more");
    more.setAttribute("aria-label", tr("side.more"));
    more.textContent = "⋯";
    more.onclick = (e) => {
      e.stopPropagation();
      this.showThreadMenu(more, t, mode);
    };

    row.appendChild(main);
    row.appendChild(more);
    return row;
  }

  makeArchiveFolder(
    projectId: string,
    archivedThreads: ThreadRow[],
  ): HTMLElement {
    const wrap = document.createElement("div");
    const open = this.expandedArchiveIds.has(projectId);
    wrap.className = `project-archive${open ? " is-open" : ""}`;

    const head = document.createElement("button");
    head.type = "button";
    head.className = `project-archive-head${open ? " is-open" : ""}`;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    const count = archivedThreads.length;
    head.innerHTML =
      `${sidebarIcon("folder", "archive-ico")}<span class="archive-label">归档</span>${count ? `<span class="archive-count">${count}</span>` : ""}` +
      `${sidebarIcon("chevronRight", "proj-chev archive-chev")}`;
    head.onclick = (e) => {
      e.stopPropagation();
      const next = !this.expandedArchiveIds.has(projectId);
      if (next) this.expandedArchiveIds.add(projectId);
      else this.expandedArchiveIds.delete(projectId);
      wrap.classList.toggle("is-open", next);
      head.classList.toggle("is-open", next);
      head.setAttribute("aria-expanded", next ? "true" : "false");
    };
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "project-archive-body";
    const inner = document.createElement("div");
    inner.className = "project-archive-body-inner";
    if (!archivedThreads.length) {
      const empty = document.createElement("div");
      empty.className = "empty-threads archive-empty";
      empty.textContent = "暂无归档";
      inner.appendChild(empty);
    } else {
      const { flat } = visibleThreadForest(
        archivedThreads,
        true,
        archivedThreads.length,
      );
      for (const { thread, depth } of flat) {
        inner.appendChild(
          this.makeThreadRow(thread, projectId, "archived", depth),
        );
      }
    }
    body.appendChild(inner);
    wrap.appendChild(body);
    return wrap;
  }

  /**
   * 轻量刷新侧栏 working 样式（不全量 rebuild）。
   */
  syncWorkingStyles(workingSessions: ReadonlySet<string>): void {
    const list = document.getElementById("project-list");
    if (!list) return;
    Array.from(list.querySelectorAll<HTMLElement>(".thread-item")).forEach(
      (row) => {
        const sid = row.dataset.sessionId;
        if (!sid) return;
        const on = workingSessions.has(sid);
        row.classList.toggle("working", on);
        const main =
          row.querySelector<HTMLElement>(".thread-item-main") ?? row;
        let spin = main.querySelector(".thread-spin");
        if (on && !spin) {
          spin = document.createElement("span");
          spin.className = "thread-spin";
          main.insertBefore(spin, main.firstChild);
        } else if (!on && spin) {
          spin.remove();
        }
      },
    );
    const chats = document.getElementById("chats-list");
    if (!chats) return;
    Array.from(chats.querySelectorAll<HTMLElement>(".thread-item")).forEach(
      (row) => {
        const sid = row.dataset.sessionId;
        if (!sid) return;
        const on = workingSessions.has(sid);
        row.classList.toggle("working", on);
        const main =
          row.querySelector<HTMLElement>(".thread-item-main") ?? row;
        let spin = main.querySelector(".thread-spin");
        if (on && !spin) {
          spin = document.createElement("span");
          spin.className = "thread-spin";
          main.insertBefore(spin, main.firstChild);
        } else if (!on && spin) {
          spin.remove();
        }
      },
    );
  }

  async refreshProjectsAndThreads(): Promise<void> {
    const { deps } = this;
    const [pRes, tRes] = await Promise.all([
      deps.inv<Project[]>("projects.list"),
      deps.inv<ThreadRow[]>("threads.list"),
    ]);
    const projects = pRes.data ?? [];
    const threads = tRes.data ?? [];
    deps.setProjects(projects);
    deps.setThreads(threads);
    deps.onListRefreshed();

    if (
      !deps.getProjectChoiceTouched() &&
      !deps.getSelectedProjectId() &&
      projects.length
    ) {
      deps.setSelectedProjectId(projects[0]!.id);
    }

    const chatsList = document.getElementById("chats-list");
    const list = document.getElementById("project-list");
    if (!chatsList || !list) return;
    chatsList.innerHTML = "";
    list.innerHTML = "";
    this.hideThreadMenu();

    for (const id of [...this.expandedProjectIds]) {
      if (id !== CHATS_GROUP_ID && !projects.some((p) => p.id === id)) {
        this.expandedProjectIds.delete(id);
      }
    }
    for (const id of [...this.projectShowAllThreads]) {
      if (id !== CHATS_GROUP_ID && !projects.some((p) => p.id === id)) {
        this.projectShowAllThreads.delete(id);
      }
    }
    for (const id of [...this.expandedArchiveIds]) {
      if (id !== CHATS_GROUP_ID && !projects.some((p) => p.id === id)) {
        this.expandedArchiveIds.delete(id);
      }
    }

    if (!this.projectExpandInitialized) {
      this.projectExpandInitialized = true;
      const activeThreadId = deps.getActiveThreadId();
      const activeSessionId = deps.getActiveSessionId();
      for (const p of projects) {
        const related = threadsForProject(projects, threads, p.id);
        const hasActive = related.some(
          (t) =>
            !t.archived &&
            (t.id === activeThreadId ||
              (!!activeSessionId && t.sessionId === activeSessionId)),
        );
        if (p.id === deps.getSelectedProjectId() || hasActive) {
          this.expandedProjectIds.add(p.id);
        }
      }
      if (this.expandedProjectIds.size === 0 && projects.length) {
        const firstWith = projects.find((p) =>
          threadsForProject(projects, threads, p.id).some((t) => !t.archived),
        );
        if (firstWith) this.expandedProjectIds.add(firstWith.id);
        else this.expandedProjectIds.add(projects[0]!.id);
      }
    }

    {
      const chatsRelated = threadsForChatsGroup(projects, threads);
      const activeList = chatsRelated.filter((t) => !t.archived);
      const archivedList = chatsRelated.filter((t) => t.archived);

      chatsList.appendChild(this.makeArchiveFolder(CHATS_GROUP_ID, archivedList));
      if (!activeList.length) {
        const empty = document.createElement("div");
        empty.className = "empty-threads";
        empty.textContent = tr("chats.empty");
        chatsList.appendChild(empty);
      } else {
        const showAll = this.projectShowAllThreads.has(CHATS_GROUP_ID);
        const { flat, rootCount } = visibleThreadForest(
          activeList,
          showAll,
          THREADS_PREVIEW_LIMIT,
        );
        for (const { thread, depth } of flat) {
          chatsList.appendChild(
            this.makeThreadRow(thread, CHATS_GROUP_ID, "active", depth),
          );
        }
        if (rootCount > THREADS_PREVIEW_LIMIT) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "project-threads-more";
          if (showAll) {
            more.textContent = "收起";
            more.onclick = (e) => {
              e.stopPropagation();
              this.projectShowAllThreads.delete(CHATS_GROUP_ID);
              void this.refreshProjectsAndThreads();
            };
          } else {
            const rest = rootCount - THREADS_PREVIEW_LIMIT;
            more.textContent = `展开更多（${rest}）`;
            more.onclick = (e) => {
              e.stopPropagation();
              this.projectShowAllThreads.add(CHATS_GROUP_ID);
              void this.refreshProjectsAndThreads();
            };
          }
          chatsList.appendChild(more);
        }
      }
    }

    for (const p of projects) {
      const group = document.createElement("div");
      const isExpanded = this.expandedProjectIds.has(p.id);
      group.className = `project-group${isExpanded ? " is-expanded" : " is-collapsed"}`;
      group.dataset.projectId = p.id;

      const b = document.createElement("button");
      b.type = "button";
      b.className = `project-item${p.id === deps.getSelectedProjectId() ? " active" : ""}`;
      b.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      b.innerHTML =
        `${sidebarIcon("chevronRight", "proj-chev")}` +
        `${sidebarIcon(isExpanded ? "folderOpen" : "folder", "folder-ico")}` +
        `<span class="proj-title">${deps.esc(p.title)}</span>` +
        `<span class="proj-remove" data-remove-project="${deps.esc(p.id)}" title="从列表移除" aria-label="移除项目">${sidebarIcon("x", "proj-remove-x")}</span>`;
      b.onclick = (e) => {
        const rm = (e.target as HTMLElement).closest(
          "[data-remove-project]",
        ) as HTMLElement | null;
        if (rm) {
          e.preventDefault();
          e.stopPropagation();
          void deps.onRemoveProject(p.id, p.title, p.path);
          return;
        }
        const next = !this.expandedProjectIds.has(p.id);
        if (next) this.expandedProjectIds.add(p.id);
        else this.expandedProjectIds.delete(p.id);

        group.classList.toggle("is-expanded", next);
        group.classList.toggle("is-collapsed", !next);
        b.setAttribute("aria-expanded", next ? "true" : "false");
        const folderEl = b.querySelector(".folder-ico");
        if (folderEl) {
          folderEl.outerHTML = sidebarIcon(
            next ? "folderOpen" : "folder",
            "folder-ico",
          );
        }

        const needSelectPaint = deps.getSelectedProjectId() !== p.id;
        deps.setSelectedProjectId(p.id);
        deps.setProjectChoiceTouched(true);
        deps.onProjectSelected(p.id);
        if (needSelectPaint) {
          list.querySelectorAll(".project-item").forEach((item) => {
            const row = item as HTMLElement;
            const gid = row
              .closest(".project-group")
              ?.getAttribute("data-project-id");
            row.classList.toggle("active", gid === p.id);
          });
        }
      };
      group.appendChild(b);

      const related = threadsForProject(projects, threads, p.id);
      const activeList = related.filter((t) => !t.archived);
      const archivedList = related.filter((t) => t.archived);
      const threadBox = document.createElement("div");
      threadBox.className = "project-threads";
      const threadInner = document.createElement("div");
      threadInner.className = "project-threads-inner";
      threadInner.appendChild(this.makeArchiveFolder(p.id, archivedList));
      if (!activeList.length) {
        const empty = document.createElement("div");
        empty.className = "empty-threads";
        empty.textContent = "暂无聊天";
        threadInner.appendChild(empty);
      } else {
        const showAll = this.projectShowAllThreads.has(p.id);
        const { flat, rootCount } = visibleThreadForest(
          activeList,
          showAll,
          THREADS_PREVIEW_LIMIT,
        );
        for (const { thread, depth } of flat) {
          threadInner.appendChild(
            this.makeThreadRow(thread, p.id, "active", depth),
          );
        }
        if (rootCount > THREADS_PREVIEW_LIMIT) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "project-threads-more";
          if (showAll) {
            more.textContent = "收起";
            more.onclick = (e) => {
              e.stopPropagation();
              this.projectShowAllThreads.delete(p.id);
              void this.refreshProjectsAndThreads();
            };
          } else {
            const rest = rootCount - THREADS_PREVIEW_LIMIT;
            more.textContent = `展开更多（${rest}）`;
            more.onclick = (e) => {
              e.stopPropagation();
              this.projectShowAllThreads.add(p.id);
              this.expandedProjectIds.add(p.id);
              void this.refreshProjectsAndThreads();
            };
          }
          threadInner.appendChild(more);
        }
      }
      threadBox.appendChild(threadInner);
      group.appendChild(threadBox);
      list.appendChild(group);
    }
    deps.onListRefreshed();
  }
}
