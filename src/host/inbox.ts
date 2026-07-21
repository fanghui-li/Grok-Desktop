import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxItem, InboxItemType } from "../shared/types.js";
import { desktopDir, ensureDesktopDirs } from "./paths.js";

interface InboxFile {
  version: number;
  items: InboxItem[];
}

export class InboxStore {
  constructor(private readonly home?: string) {
    ensureDesktopDirs(home);
  }

  private file(): string {
    return path.join(desktopDir(this.home), "inbox", "items.json");
  }

  private read(): InboxFile {
    const f = this.file();
    if (!fs.existsSync(f)) return { version: 1, items: [] };
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as InboxFile;
    } catch {
      return { version: 1, items: [] };
    }
  }

  private write(data: InboxFile): void {
    ensureDesktopDirs(this.home);
    const dir = path.dirname(this.file());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file());
  }

  list(filter?: { unreadOnly?: boolean; type?: InboxItemType }): InboxItem[] {
    let items = this.read().items;
    if (filter?.unreadOnly) items = items.filter((i) => !i.read);
    if (filter?.type) items = items.filter((i) => i.type === filter.type);
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  add(
    partial: Omit<InboxItem, "id" | "createdAt" | "read"> & { read?: boolean },
  ): InboxItem {
    const item: InboxItem = {
      ...partial,
      id: `inbox_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      read: partial.read ?? false,
    };
    const data = this.read();
    data.items.unshift(item);
    // cap
    if (data.items.length > 500) data.items = data.items.slice(0, 500);
    this.write(data);
    return item;
  }

  markRead(id: string): void {
    const data = this.read();
    const item = data.items.find((i) => i.id === id);
    if (item) item.read = true;
    this.write(data);
  }

  /** 仅标记匹配 requestId 的权限项已读（避免权限响应扫光全部 Inbox） */
  markReadByRequestId(requestId: string): number {
    const rid = requestId.trim();
    if (!rid) return 0;
    const data = this.read();
    let n = 0;
    for (const i of data.items) {
      if (i.requestId === rid && !i.read) {
        i.read = true;
        n += 1;
      }
    }
    if (n) this.write(data);
    return n;
  }

  markAllRead(): void {
    const data = this.read();
    for (const i of data.items) i.read = true;
    this.write(data);
  }

  dismiss(id: string): void {
    const data = this.read();
    data.items = data.items.filter((i) => i.id !== id);
    this.write(data);
  }

  unreadCount(): number {
    return this.read().items.filter((i) => !i.read).length;
  }
}
