import fs from "node:fs";
import path from "node:path";
import type { InboxItem, RosterEntry, ThreadStatus } from "../shared/types.js";
import { desktopDir, ensureDesktopDirs } from "./paths.js";

export interface TrayBadgeState {
  unreadInbox: number;
  needsInput: number;
  working: number;
  /** Combined badge number for tray / dock */
  badge: number;
  label: string;
}

export interface DeepLink {
  kind: "session" | "project" | "inbox" | "automation" | "unknown";
  id?: string;
  raw: string;
}

export interface VersionMatrix {
  desktopVersion: string;
  grokPath: string | null;
  grokVersion: string | null;
  updateChannel: string;
  notes: string;
}

/**
 * Compute tray/unread indicator from roster + inbox (pure Host logic).
 */
export function computeTrayBadge(
  roster: RosterEntry[],
  inbox: InboxItem[],
  opts?: { locale?: string } | string,
): TrayBadgeState {
  const locale =
    typeof opts === "string" ? opts : opts?.locale || "en";
  const zh = String(locale).toLowerCase().startsWith("zh");
  const unreadInbox = inbox.filter((i) => !i.read).length;
  const needsInput = roster.filter(
    (r) => r.status === "needs_input" || r.status === "blocked",
  ).length;
  const working = roster.filter((r) => r.status === "working").length;
  const badge = unreadInbox + needsInput;
  const parts: string[] = [];
  if (needsInput) {
    parts.push(zh ? `${needsInput} 待输入` : `${needsInput} needs input`);
  }
  if (unreadInbox) {
    parts.push(zh ? `${unreadInbox} 收件箱` : `${unreadInbox} inbox`);
  }
  if (working) {
    parts.push(zh ? `${working} 运行中` : `${working} working`);
  }
  return {
    unreadInbox,
    needsInput,
    working,
    badge,
    label: parts.length ? parts.join(" · ") : zh ? "空闲" : "idle",
  };
}

/** Extract deep-link / focus payload from session.status activity field. */
export function extractHandoffPayload(activity?: string): string | null {
  if (!activity) return null;
  if (activity.startsWith("handoff:")) return activity.slice("handoff:".length);
  return null;
}

/** Extract in-app nav target from activity (`nav:command`). */
export function extractNavView(activity?: string): string | null {
  if (!activity?.startsWith("nav:")) return null;
  return activity.slice("nav:".length) || null;
}

/** Parse grok://session/<id> style deep links. */
export function parseDeepLink(raw: string): DeepLink {
  const s = raw.trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "grok:" && u.protocol !== "grok-desktop:") {
      return { kind: "unknown", raw: s };
    }
    const host = u.hostname || u.pathname.replace(/^\//, "").split("/")[0];
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    // grok://session/xxx  → hostname session, path xxx
    // grok://inbox/yyy
    if (host === "session" || parts[0] === "session") {
      return {
        kind: "session",
        id: host === "session" ? parts[0] ?? u.pathname.slice(1) : parts[1],
        raw: s,
      };
    }
    if (host === "project" || parts[0] === "project") {
      return {
        kind: "project",
        id: host === "project" ? parts[0] : parts[1],
        raw: s,
      };
    }
    if (host === "inbox" || parts[0] === "inbox") {
      return {
        kind: "inbox",
        id: host === "inbox" ? parts[0] : parts[1],
        raw: s,
      };
    }
    if (host === "automation" || parts[0] === "automation") {
      return {
        kind: "automation",
        id: host === "automation" ? parts[0] : parts[1],
        raw: s,
      };
    }
  } catch {
    // bare forms: session:<id>
    const m = /^(session|project|inbox|automation)[/:](.+)$/i.exec(s);
    if (m) {
      return {
        kind: m[1].toLowerCase() as DeepLink["kind"],
        id: m[2],
        raw: s,
      };
    }
  }
  return { kind: "unknown", raw: s };
}

export function readDesktopPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "../../package.json"),
      path.resolve(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    /* ignore */
  }
  return "0.1.0";
}

function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  let p = decodeURIComponent(u.pathname);
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) {
    p = p.slice(1);
  }
  return p;
}

export function buildVersionMatrix(opts: {
  grokPath: string | null;
  grokVersion: string | null;
  updateChannel?: string;
}): VersionMatrix {
  return {
    desktopVersion: readDesktopPackageVersion(),
    grokPath: opts.grokPath,
    grokVersion: opts.grokVersion,
    updateChannel: opts.updateChannel ?? "stable",
    notes:
      "Prefer agent-bin / install resources/agent; falls back to PATH ~/.grok/bin.",
  };
}

export interface PendingHandoff {
  payload: string;
  receivedAt: string;
}

/** Absolute path to handoff.json (FS bus between primary / secondary). */
export function handoffFilePath(home?: string): string {
  return path.join(desktopDir(home), "handoff.json");
}

/** Persist last secondary-instance payload for primary to consume. */
export function writeHandoff(payload: string, home?: string): void {
  ensureDesktopDirs(home);
  const f = handoffFilePath(home);
  fs.writeFileSync(
    f,
    JSON.stringify({ payload, receivedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export function readAndClearHandoff(home?: string): PendingHandoff | null {
  const f = handoffFilePath(home);
  if (!fs.existsSync(f)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(f, "utf8")) as PendingHandoff;
    fs.unlinkSync(f);
    return data;
  } catch {
    return null;
  }
}

export function statusRank(s: ThreadStatus): number {
  switch (s) {
    case "needs_input":
    case "blocked":
      return 0;
    case "working":
      return 1;
    default:
      return 2;
  }
}
