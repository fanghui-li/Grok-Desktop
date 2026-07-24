/**
 * 从 agent Internal error 包装里抽出可读原因。
 * CLI 常把真因放在 JSON-RPC `error.data`：可能是纯字符串
 *（如 btw：`side question model call failed: API error (status 429…)`），
 * 也可能是内嵌 JSON。勿只留下 "Internal error"。
 */
export function enrichAcpErrorMessage(
  message: string | undefined,
  data: unknown,
): string {
  const raw = (message ?? "").trim() || "ACP error";
  const isGenericShell = (s: string) =>
    !s ||
    /^internal error\.?$/i.test(s) ||
    s === "ACP error" ||
    /^method not found\.?$/i.test(s);

  const tryParseObject = (s: string): Record<string, unknown> | null => {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pickMessage = (obj: Record<string, unknown> | null): string | null => {
    if (!obj) return null;
    const m = obj.message ?? obj.error_message ?? obj.error;
    if (typeof m === "string" && m.trim()) return m.trim();
    if (m && typeof m === "object" && "message" in (m as object)) {
      const inner = (m as { message?: unknown }).message;
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
    return null;
  };
  /** 纯字符串 data：优先原样；若是 JSON 外壳再抽 message */
  const pickFromString = (s: string): string | null => {
    const t = s.trim();
    if (!t || isGenericShell(t)) return null;
    const fromJson = pickMessage(tryParseObject(t));
    if (fromJson && !isGenericShell(fromJson)) return fromJson;
    return t;
  };

  let detail = pickMessage(tryParseObject(raw));
  if (detail && isGenericShell(detail)) detail = null;
  if (!detail && data != null) {
    if (typeof data === "string") {
      detail = pickFromString(data);
    } else if (typeof data === "object") {
      const o = data as Record<string, unknown>;
      // 先看嵌套 data（Host 有时把整个 error 对象塞进 details）
      if ("data" in o) {
        const nested = o.data;
        if (typeof nested === "string") detail = pickFromString(nested);
        else if (nested && typeof nested === "object") {
          detail = pickMessage(nested as Record<string, unknown>);
        }
      }
      if (!detail) {
        const fromObj = pickMessage(o);
        if (fromObj && !isGenericShell(fromObj)) detail = fromObj;
      }
    }
  }

  if (detail && detail !== raw) {
    // 已是完整句子则直接用；否则挂在 Internal error 后
    if (isGenericShell(raw) || /^internal error/i.test(raw)) return detail;
    if (!raw.includes(detail.slice(0, Math.min(40, detail.length)))) {
      return `${raw}: ${detail}`;
    }
  }
  return raw;
}
