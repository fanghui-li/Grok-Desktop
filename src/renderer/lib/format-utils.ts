/**
 * 展示用纯格式化（时间 / token / 耗时）。
 * 从 main.ts 抽出，避免巨石内夹杂可复用工具。
 */
import { tr } from "../../shared/i18n/index.js";

/** Codex-style relative age (e.g. 1 周 / 3 天). */
export function formatAge(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return tr("time.justNow");
  if (sec < 3600) return tr("time.minutes", { n: Math.floor(sec / 60) });
  if (sec < 86400) return tr("time.hours", { n: Math.floor(sec / 3600) });
  if (sec < 86400 * 7) return tr("time.days", { n: Math.floor(sec / 86400) });
  if (sec < 86400 * 30)
    return tr("time.weeks", { n: Math.floor(sec / (86400 * 7)) });
  if (sec < 86400 * 365)
    return tr("time.months", { n: Math.floor(sec / (86400 * 30)) });
  return tr("time.years", { n: Math.floor(sec / (86400 * 365)) });
}

/** 短耗时：23s / 800ms / 1分5s */
export function formatElapsedCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return tr("turn.timeMs", { n: Math.max(ms, 0) });
  const sec = Math.round(ms / 1000);
  if (sec < 60) return tr("turn.timeSec", { n: sec });
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0
    ? tr("turn.timeMinSec", { m, s })
    : tr("turn.timeMin", { m });
}

/** 兼容旧 key：已处理 → 现统一走「已完成 ·」 */
export function formatTurnElapsed(ms: number): string {
  return tr("turn.workedFor", { time: formatElapsedCompact(ms) });
}

export function formatTurnStopped(ms: number): string {
  return tr("turn.stoppedAfter", { time: formatElapsedCompact(ms) });
}

/** 273k / 500k 风格 */
export function formatTokenK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    if (k >= 100) return `${Math.round(k)}k`;
    return `${k.toFixed(k % 1 === 0 ? 0 : 1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

export type ContextUsageDisplay = {
  used: number;
  total: number;
  percent: number;
  available: boolean;
};

export function formatContextChipText(u: ContextUsageDisplay | null): string {
  if (!u || !u.available || u.total <= 0) return "—";
  const pct = u.percent.toFixed(2);
  return `${formatTokenK(u.used)} / ${formatTokenK(u.total)} (${pct}%)`;
}

/**
 * User bubble timestamp: `6月21日 18:49` (same year) or with year.
 * `now` injectable for tests.
 */
export function formatUserMsgTime(d: Date, now = new Date()): string {
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) {
    return `${mo}月${day}日 ${hh}:${mm}`;
  }
  return `${d.getFullYear()}年${mo}月${day}日 ${hh}:${mm}`;
}
