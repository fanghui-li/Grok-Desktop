/**
 * 会话 / 项目 / 符号搜索列表纯逻辑（无 DOM 事件绑定）。
 */
import { tr } from "../../shared/i18n/index.js";
import { formatAge } from "../lib/format-utils.js";
import type { Project, ThreadRow } from "../thread/model.js";

export type SessionSearchHit =
  | { kind: "thread"; sessionId: string; html: string; resumeTop?: boolean }
  | { kind: "project"; id: string; html: string }
  | { kind: "symbol"; path: string; line: number; html: string };

export function buildSessionSearchHits(opts: {
  query: string;
  projects: readonly Project[];
  threads: readonly ThreadRow[];
  esc: (s: string) => string;
  graphHits?: Array<{
    name: string;
    path: string;
    line: number;
    snippet: string;
  }>;
}): SessionSearchHit[] {
  const { esc } = opts;
  const q = opts.query.trim().toLowerCase();
  const out: SessionSearchHit[] = [];

  if (q.length >= 8) {
    const exact = opts.threads.find(
      (t) =>
        t.sessionId.toLowerCase() === q ||
        t.sessionId.toLowerCase().startsWith(q),
    );
    if (exact) {
      out.push({
        kind: "thread",
        sessionId: exact.sessionId,
        resumeTop: true,
        html: `<button type="button" class="session-search-item is-resume" data-kind="thread" data-sid="${esc(exact.sessionId)}">
            <div class="session-search-title">↩ ${esc(tr("search.resumePrefix"))} ${esc(exact.title || exact.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(exact.sessionId)} · ${esc(formatAge(exact.updatedAt) || "")}</div>
          </button>`,
      });
    }
  }

  for (const p of opts.projects) {
    if (
      !q ||
      p.title.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q)
    ) {
      out.push({
        kind: "project",
        id: p.id,
        html: `<button type="button" class="session-search-item" data-kind="project" data-id="${esc(p.id)}">
            <div class="session-search-title">📁 ${esc(p.title)}</div>
            <div class="session-search-sub">${esc(p.path)}</div>
          </button>`,
      });
    }
  }

  for (const t of opts.threads.filter((x) => !x.archived)) {
    if (
      !q ||
      t.title.toLowerCase().includes(q) ||
      t.sessionId.toLowerCase().includes(q) ||
      t.cwd.toLowerCase().includes(q)
    ) {
      if (
        q.length >= 8 &&
        (t.sessionId.toLowerCase() === q ||
          t.sessionId.toLowerCase().startsWith(q))
      ) {
        continue;
      }
      out.push({
        kind: "thread",
        sessionId: t.sessionId,
        html: `<button type="button" class="session-search-item" data-kind="thread" data-sid="${esc(t.sessionId)}">
            <div class="session-search-title">💬 ${esc(t.title || t.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(formatAge(t.updatedAt) || "")} · ${esc(t.sessionId.slice(0, 8))}</div>
          </button>`,
      });
    }
  }

  for (const t of opts.threads.filter((x) => x.archived)) {
    if (
      q &&
      (t.title.toLowerCase().includes(q) ||
        t.sessionId.toLowerCase().includes(q))
    ) {
      out.push({
        kind: "thread",
        sessionId: t.sessionId,
        html: `<button type="button" class="session-search-item" data-kind="thread" data-sid="${esc(t.sessionId)}">
            <div class="session-search-title">📦 ${esc(t.title || t.sessionId.slice(0, 8))}</div>
            <div class="session-search-sub">${esc(tr("search.archived"))} · ${esc(t.sessionId.slice(0, 8))}</div>
          </button>`,
      });
    }
  }

  for (const h of opts.graphHits ?? []) {
    out.push({
      kind: "symbol",
      path: h.path,
      line: h.line,
      html: `<button type="button" class="session-search-item" data-kind="symbol" data-path="${esc(h.path)}" data-line="${h.line}">
            <div class="session-search-title">◇ ${esc(h.name)}</div>
            <div class="session-search-sub">${esc(h.path)}:${h.line}</div>
          </button>`,
    });
  }

  return out.slice(0, 80);
}

export function sessionSearchHitsHtml(
  hits: readonly SessionSearchHit[],
  esc: (s: string) => string,
): string {
  if (!hits.length) {
    return `<div class="item-sub">${esc(tr("common.noMatch"))}</div>`;
  }
  return hits.map((h) => h.html).join("");
}
