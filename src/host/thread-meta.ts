/**
 * 会话元数据（归档等）持久化到 ~/.grok-desktop/desktop/thread-meta.json
 * 按 sessionId 索引，与 live ACP 线程解耦，磁盘会话同样可用。
 */
import fs from "node:fs";
import path from "node:path";
import { desktopDir, ensureDesktopDirs } from "./paths.js";

export interface SessionMetaEntry {
  archived?: boolean;
  archivedAt?: string;
  /** Desktop 侧自定义标题（覆盖 summary 默认标题） */
  title?: string;
  /** 该会话使用的模型（create / setModel 写入，openThread 回填 chip） */
  model?: string;
  /** 该会话推理力度 low|medium|high|xhigh */
  effort?: string;
  /** 侧栏置顶（按 sessionId 持久化，disk/live 通用） */
  pinned?: boolean;
}

function isEmptyMeta(entry: SessionMetaEntry): boolean {
  return (
    !entry.archived &&
    !entry.title &&
    !entry.model &&
    !entry.effort &&
    !entry.pinned
  );
}

interface ThreadMetaFile {
  version: number;
  sessions: Record<string, SessionMetaEntry>;
}

function metaPath(home?: string): string {
  return path.join(desktopDir(home), "thread-meta.json");
}

export class ThreadMetaStore {
  constructor(private readonly home?: string) {
    ensureDesktopDirs(home);
  }

  private read(): ThreadMetaFile {
    const file = metaPath(this.home);
    if (!fs.existsSync(file)) {
      return { version: 1, sessions: {} };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ThreadMetaFile;
      return {
        version: raw.version ?? 1,
        sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
      };
    } catch {
      return { version: 1, sessions: {} };
    }
  }

  private write(data: ThreadMetaFile): void {
    ensureDesktopDirs(this.home);
    const file = metaPath(this.home);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  get(sessionId: string): SessionMetaEntry {
    if (!sessionId) return {};
    return this.read().sessions[sessionId] ?? {};
  }

  isArchived(sessionId: string): boolean {
    return this.get(sessionId).archived === true;
  }

  setArchived(sessionId: string, archived: boolean): SessionMetaEntry {
    if (!sessionId) return {};
    const data = this.read();
    const prev = data.sessions[sessionId] ?? {};
    if (archived) {
      data.sessions[sessionId] = {
        ...prev,
        archived: true,
        archivedAt: new Date().toISOString(),
      };
    } else if (data.sessions[sessionId]) {
      const next = { ...prev, archived: false };
      delete next.archivedAt;
      if (isEmptyMeta(next)) {
        delete data.sessions[sessionId];
      } else {
        data.sessions[sessionId] = next;
      }
    }
    this.write(data);
    return data.sessions[sessionId] ?? { archived: false };
  }

  isPinned(sessionId: string): boolean {
    return this.get(sessionId).pinned === true;
  }

  setPinned(sessionId: string, pinned: boolean): SessionMetaEntry {
    if (!sessionId) return {};
    const data = this.read();
    const prev = data.sessions[sessionId] ?? {};
    if (pinned) {
      data.sessions[sessionId] = { ...prev, pinned: true };
    } else if (data.sessions[sessionId]) {
      const next = { ...prev };
      delete next.pinned;
      if (isEmptyMeta(next)) delete data.sessions[sessionId];
      else data.sessions[sessionId] = next;
    }
    this.write(data);
    return data.sessions[sessionId] ?? {};
  }

  setTitle(sessionId: string, title: string): SessionMetaEntry {
    if (!sessionId) return {};
    const t = title.trim();
    const data = this.read();
    const prev = data.sessions[sessionId] ?? {};
    if (!t) {
      const next = { ...prev };
      delete next.title;
      if (isEmptyMeta(next)) delete data.sessions[sessionId];
      else data.sessions[sessionId] = next;
    } else {
      data.sessions[sessionId] = { ...prev, title: t };
    }
    this.write(data);
    return data.sessions[sessionId] ?? {};
  }

  getTitle(sessionId: string): string | undefined {
    const t = this.get(sessionId).title?.trim();
    return t || undefined;
  }

  /** 写入会话模型 / 推理（热切换与 create 后调用） */
  setSessionModel(
    sessionId: string,
    prefs: { model?: string; effort?: string },
  ): SessionMetaEntry {
    if (!sessionId) return {};
    const data = this.read();
    const prev = data.sessions[sessionId] ?? {};
    const next: SessionMetaEntry = { ...prev };
    if (prefs.model !== undefined) {
      const m = prefs.model.trim();
      if (m) next.model = m;
      else delete next.model;
    }
    if (prefs.effort !== undefined) {
      const e = prefs.effort.trim().toLowerCase();
      if (e && ["low", "medium", "high", "xhigh"].includes(e)) next.effort = e;
      else delete next.effort;
    }
    // 空条目清理
    if (isEmptyMeta(next)) {
      delete data.sessions[sessionId];
    } else {
      data.sessions[sessionId] = next;
    }
    this.write(data);
    return data.sessions[sessionId] ?? {};
  }

  /** 删除会话元数据（物理删目录后调用） */
  remove(sessionId: string): void {
    if (!sessionId) return;
    const data = this.read();
    if (!data.sessions[sessionId]) return;
    delete data.sessions[sessionId];
    this.write(data);
  }

  /**
   * 将匹配的会话 model 改写为 fallback（或清除）。
   * 用于删除提供商后对齐 CLI reselect：幽灵 model id 不得继续展示/发送。
   */
  remapModels(
    match: (model: string) => boolean,
    fallbackModel: string | null,
  ): { updated: number; sessionIds: string[] } {
    const data = this.read();
    const sessionIds: string[] = [];
    let dirty = false;
    const fb = fallbackModel?.trim() || null;
    for (const [sid, entry] of Object.entries(data.sessions)) {
      const m = entry.model?.trim();
      if (!m || !match(m)) continue;
      const next: SessionMetaEntry = { ...entry };
      if (fb) next.model = fb;
      else delete next.model;
      if (isEmptyMeta(next)) {
        delete data.sessions[sid];
      } else {
        data.sessions[sid] = next;
      }
      sessionIds.push(sid);
      dirty = true;
    }
    if (dirty) this.write(data);
    return { updated: sessionIds.length, sessionIds };
  }
}
