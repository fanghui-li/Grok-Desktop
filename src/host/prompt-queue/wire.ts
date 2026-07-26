/**
 * Agent queue writeback（Best-effort；永不抛到 UI）。
 * DesktopHost 经 deps 注入 live client 查找。
 */
import type { HostLogger } from "../logger.js";
import { setQueueFlags } from "./queue.js";

export type QueueWireClient = {
  extMethod: (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<unknown>;
};

export type TryQueueWireDeps = {
  home?: string;
  logger: HostLogger;
  /** sessionId → 可写 client；无则 skip */
  resolveWritableClient: (sessionId: string) => QueueWireClient | null;
};

export async function tryQueueWire(
  deps: TryQueueWireDeps,
  sessionId: string,
  op: string,
  params: Record<string, unknown>,
): Promise<void> {
  const client = deps.resolveWritableClient(sessionId);
  if (!client) return;
  try {
    await client.extMethod(
      `_x.ai/queue/${op}`,
      { sessionId, ...params },
      15_000,
    );
    setQueueFlags(sessionId, { syncError: null }, deps.home);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/method not found/i.test(msg)) return;
    setQueueFlags(sessionId, { syncError: msg }, deps.home);
    deps.logger.warn("queue.wire_failed", { op, msg });
  }
}
