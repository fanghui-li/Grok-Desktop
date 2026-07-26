/**
 * Per-session 旁路侧问投影（对齐 CLI btw_history 归属 parent session）。
 * - 不持有 DOM；切会话时由 main 按 activeSessionId 重绘 #btw-side-thread
 * - flightGen：取消 / 切走丢弃 in-flight 时递增，RPC 返回后不得覆盖 UI
 */

export type BtwExchangeState = "loading" | "done" | "error" | "stopped";

export type BtwExchange = {
  id: string;
  question: string;
  state: BtwExchangeState;
  /** done: answer；error/stopped: 说明文案 */
  body?: string;
  updatedAtMs: number;
};

export type SessionBtwProjection = {
  exchanges: BtwExchange[];
  /** 进行中的侧问代数；与 in-flight RPC 闭包比对 */
  flightGen: number;
  /** 当前 in-flight exchange id（若有） */
  inFlightId: string | null;
  updatedAtMs: number;
};

const store = new Map<string, SessionBtwProjection>();

function emptyProj(): SessionBtwProjection {
  return {
    exchanges: [],
    flightGen: 0,
    inFlightId: null,
    updatedAtMs: Date.now(),
  };
}

export function getSessionBtw(sessionId: string): SessionBtwProjection | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return store.get(sid) ?? null;
}

export function getOrCreateSessionBtw(sessionId: string): SessionBtwProjection {
  const sid = sessionId.trim();
  let p = store.get(sid);
  if (!p) {
    p = emptyProj();
    store.set(sid, p);
  }
  return p;
}

export function listSessionBtw(sessionId: string): BtwExchange[] {
  return getSessionBtw(sessionId)?.exchanges.slice() ?? [];
}

export function isBtwInFlight(sessionId: string | null | undefined): boolean {
  const sid = sessionId?.trim();
  if (!sid) return false;
  const p = store.get(sid);
  return Boolean(p?.inFlightId);
}

/** 追加或更新一条侧问；返回该会话投影 */
export function upsertBtwExchange(
  sessionId: string,
  exchange: BtwExchange,
): SessionBtwProjection {
  const p = getOrCreateSessionBtw(sessionId);
  const idx = p.exchanges.findIndex((e) => e.id === exchange.id);
  const next = { ...exchange, updatedAtMs: Date.now() };
  if (idx >= 0) p.exchanges[idx] = next;
  else p.exchanges.push(next);
  if (next.state === "loading") {
    p.inFlightId = next.id;
  } else if (p.inFlightId === next.id) {
    p.inFlightId = null;
  }
  p.updatedAtMs = Date.now();
  return p;
}

/**
 * 取消本会话 in-flight：递增 flightGen，loading → stopped。
 * @returns 被取消的 exchange id + 新 gen；无则 null
 */
export function cancelSessionBtwFlight(
  sessionId: string,
  stoppedBody: string,
): { exchangeId: string; flightGen: number } | null {
  const p = getOrCreateSessionBtw(sessionId);
  const id = p.inFlightId;
  p.flightGen += 1;
  p.inFlightId = null;
  p.updatedAtMs = Date.now();
  if (!id) return { exchangeId: "", flightGen: p.flightGen };
  const ex = p.exchanges.find((e) => e.id === id);
  if (ex && ex.state === "loading") {
    ex.state = "stopped";
    ex.body = stoppedBody;
    ex.updatedAtMs = Date.now();
  }
  return { exchangeId: id, flightGen: p.flightGen };
}

/** 开始一次 RPC：记下 gen + exchangeId */
export function beginBtwFlight(
  sessionId: string,
  exchangeId: string,
): number {
  const p = getOrCreateSessionBtw(sessionId);
  p.flightGen += 1;
  p.inFlightId = exchangeId;
  p.updatedAtMs = Date.now();
  return p.flightGen;
}

/** RPC 返回时是否仍是当前 flight（未被取消） */
export function isBtwFlightCurrent(
  sessionId: string,
  flightGen: number,
  exchangeId: string,
): boolean {
  const p = getSessionBtw(sessionId);
  if (!p) return false;
  return p.flightGen === flightGen && p.inFlightId === exchangeId;
}

/** 清空本会话侧问记录（UI 清空；不删磁盘 btw_history） */
export function clearSessionBtw(sessionId: string): void {
  const sid = sessionId?.trim();
  if (!sid) return;
  store.set(sid, emptyProj());
}

/**
 * 打开会话时合并磁盘 btw_history：
 * - 磁盘条目为底（id 通常 btw_disk_*）
 * - 保留本会话内存侧问（btw_ex_* / loading），避免刚完成尚未落盘被冲掉
 */
export function replaceSessionBtwFromDisk(
  sessionId: string,
  exchanges: BtwExchange[],
): SessionBtwProjection {
  const p = getOrCreateSessionBtw(sessionId);
  const memKeep = p.exchanges.filter(
    (e) => e.state === "loading" || !e.id.startsWith("btw_disk_"),
  );
  p.exchanges = exchanges.slice();
  for (const m of memKeep) {
    if (!p.exchanges.some((e) => e.id === m.id)) {
      p.exchanges.push(m);
    }
  }
  if (p.inFlightId) {
    const still = p.exchanges.find((e) => e.id === p.inFlightId);
    if (!still || still.state !== "loading") {
      p.inFlightId = null;
    }
  }
  p.updatedAtMs = Date.now();
  return p;
}
