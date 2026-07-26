/**
 * Agent available_commands 缓存（自 main 迁出）。
 * 仅前台会话事件写入；slash 浮层 invalidate 经回调。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type AvailableCommand = {
  name: string;
  description?: string;
  input?: { hint?: string };
};

export type AvailableCommandsDeps = {
  inv: Inv;
  getActiveThreadId: () => string | null;
  getActiveSessionId: () => string | null;
  onChanged: () => void;
};

export class AvailableCommandsCache {
  private commands: AvailableCommand[] = [];

  constructor(private readonly deps: AvailableCommandsDeps) {}

  list(): readonly AvailableCommand[] {
    return this.commands;
  }

  async refresh(): Promise<void> {
    const tid = this.deps.getActiveThreadId();
    if (!tid || tid.startsWith("disk_")) return;
    const res = await this.deps.inv<{
      commands: AvailableCommand[];
      tools?: string[];
    }>("threads.availableCommands", { threadId: tid });
    if (res.ok && res.data?.commands) {
      this.commands = res.data.commands;
      this.deps.onChanged();
    }
  }

  applyEvent(ev: {
    sessionId?: string;
    threadId?: string;
    commands: AvailableCommand[];
  }): void {
    const activeSessionId = this.deps.getActiveSessionId();
    const activeThreadId = this.deps.getActiveThreadId();
    if (
      activeSessionId &&
      ev.sessionId &&
      ev.sessionId !== activeSessionId
    ) {
      return;
    }
    if (
      activeThreadId &&
      ev.threadId &&
      ev.threadId !== activeThreadId &&
      !activeThreadId.startsWith("disk_")
    ) {
      return;
    }
    this.commands = ev.commands ?? [];
    this.deps.onChanged();
  }

  clear(): void {
    this.commands = [];
  }
}
