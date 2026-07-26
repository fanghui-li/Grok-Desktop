/**
 * Context chip 同步 / 轮询 / compact 乐观更新（自 main 迁出）。
 * 详情弹窗正文组装在此；openModal 经 deps。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  mergeOptimisticContextFromCompact,
  type ContextUsageRow,
} from "./usage.js";
import { formatContextChipText, formatTokenK } from "../lib/format-utils.js";

export type { ContextUsageRow };

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type SessionInfoForContext = {
  sessionId: string;
  context: {
    used: number;
    total: number;
    freeTokens: number;
    systemPromptTokens: number;
    toolDefinitionsCount: number;
    toolDefinitionsTokens: number;
    messageCount: number;
    messageTokens: number;
    turnCount: number;
    toolCallCount: number;
    compactionCount: number;
    autoCompactThresholdPercent?: number;
    usagePct?: number;
    usageCategories?: Array<{
      label: string;
      tokens: number;
      detail?: string;
    }>;
  };
};

export type ContextUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  getActiveSessionId: () => string | null;
  openModal: (title: string, bodyHtml: string) => void;
  closeModal: () => void;
  fetchSessionInfoForActive: () => Promise<SessionInfoForContext | null>;
  /** modal 内 cancel 按钮 id 绑定 */
  bindModalCancel: (onCancel: () => void) => void;
};

export class ContextUi {
  private last: ContextUsageRow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ContextUiDeps) {}

  getLast(): ContextUsageRow | null {
    return this.last;
  }

  setLast(row: ContextUsageRow | null): void {
    this.last = row;
  }

  syncLabels(): void {
    const text = formatContextChipText(this.last);
    const pct = this.last?.percent ?? 0;
    const el = document.getElementById("context-label");
    if (el) el.textContent = text;
    const btn = document.getElementById("btn-context");
    if (!btn) return;
    btn.classList.toggle("is-warn", pct >= 70 && pct < 90);
    btn.classList.toggle("is-high", pct >= 90);
    btn.title = this.last?.available
      ? tr("chat.contextChip", { text })
      : tr("context.needSession");
  }

  async refresh(): Promise<ContextUsageRow | null> {
    const sid = this.deps.getActiveSessionId();
    if (!sid) {
      this.last = null;
      this.syncLabels();
      return null;
    }
    const res = await this.deps.inv<ContextUsageRow>("session.context", {
      sessionId: sid,
    });
    if (!res.ok || !res.data) {
      this.last = null;
      this.syncLabels();
      return null;
    }
    this.last = res.data;
    this.syncLabels();
    return this.last;
  }

  applyOptimisticFromCompact(ev: {
    tokensBefore?: number;
    tokensAfter?: number;
  }): void {
    const next = mergeOptimisticContextFromCompact(
      this.last,
      ev,
      this.deps.getActiveSessionId() ?? "",
    );
    if (!next) return;
    this.last = next;
    this.syncLabels();
  }

  /** compact 完成后：乐观 chip + 多次回读 signals（写盘有延迟） */
  refreshAfterCompact(ev: {
    tokensBefore?: number;
    tokensAfter?: number;
  }): void {
    this.applyOptimisticFromCompact(ev);
    void this.refresh();
    window.setTimeout(() => void this.refresh(), 600);
    window.setTimeout(() => void this.refresh(), 2000);
    window.setTimeout(() => void this.refresh(), 5000);
  }

  startPolling(): void {
    this.stopPolling();
    void this.refresh();
    this.pollTimer = setInterval(() => {
      if (this.deps.getActiveSessionId()) void this.refresh();
    }, 4000);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async showDetails(): Promise<{ ok: boolean; message?: string }> {
    const { esc, openModal, closeModal, bindModalCancel } = this.deps;
    const sid = this.deps.getActiveSessionId();
    if (!sid) {
      openModal(
        tr("context.title"),
        `<p class="prompt-dlg-hint">${esc(tr("context.needOpen"))}</p>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
      );
      bindModalCancel(() => closeModal());
      return { ok: true };
    }

    const info = await this.deps.fetchSessionInfoForActive();
    if (info) {
      const c = info.context;
      if (c.total > 0 || c.used > 0) {
        this.last = {
          sessionId: info.sessionId,
          used: c.used,
          total: c.total,
          percent:
            c.usagePct ||
            (c.total > 0 ? Math.min(100, (c.used / c.total) * 100) : 0),
          available: true,
          source: "signals",
        };
        this.syncLabels();
      }
      const bodyLines = [
        tr("status.contextUsed", {
          used: c.used.toLocaleString(),
          total: c.total.toLocaleString(),
          pct:
            c.usagePct ||
            (c.total > 0 ? Math.round((c.used / c.total) * 100) : 0),
        }),
        tr("status.contextFree", { free: c.freeTokens.toLocaleString() }),
        tr("status.contextSystem", {
          tokens: c.systemPromptTokens.toLocaleString(),
        }),
        tr("status.contextTools", {
          count: c.toolDefinitionsCount,
          tokens: c.toolDefinitionsTokens.toLocaleString(),
        }),
        tr("status.contextMessages", {
          count: c.messageCount,
          tokens: c.messageTokens.toLocaleString(),
        }),
        tr("status.contextTurnsTools", {
          turns: c.turnCount,
          tools: c.toolCallCount,
          compact: c.compactionCount,
        }),
        tr("status.autoCompactAt", {
          pct: c.autoCompactThresholdPercent || 85,
        }),
      ];
      if (c.usageCategories?.length) {
        bodyLines.push("", tr("status.categoriesHeader"));
        for (const cat of c.usageCategories) {
          const detail = cat.detail ? ` (${cat.detail})` : "";
          bodyLines.push(
            `  ${cat.label}${detail}: ${cat.tokens.toLocaleString()}`,
          );
        }
      }
      bodyLines.push("", tr("context.tipCompact"));
      openModal(
        tr("context.title"),
        `<pre class="slash-status-pre">${esc(bodyLines.join("\n"))}</pre>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
      );
      bindModalCancel(() => closeModal());
      return { ok: true };
    }

    await this.refresh();
    const u = this.last;
    if (!u || !u.available) {
      openModal(
        tr("context.title"),
        `<p class="prompt-dlg-hint">${esc(tr("context.noData"))}</p>
       <pre class="slash-status-pre">${esc(tr("context.sessionLine", { id: sid }))}</pre>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
       </div>`,
      );
      bindModalCancel(() => closeModal());
      return { ok: true };
    }
    const pathLine = u.path ? tr("chat.contextPathLine", { path: u.path }) : "";
    const body = tr("chat.contextDetail", {
      usedK: formatTokenK(u.used),
      used: u.used.toLocaleString(),
      totalK: formatTokenK(u.total),
      total: u.total.toLocaleString(),
      percent: u.percent.toFixed(2),
      source: u.source,
      pathLine,
    });
    openModal(
      tr("context.title"),
      `<pre class="slash-status-pre">${esc(body)}</pre>
     <div class="prompt-dlg-actions">
       <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("context.close"))}</button>
     </div>`,
    );
    bindModalCancel(() => closeModal());
    return { ok: true };
  }
}
