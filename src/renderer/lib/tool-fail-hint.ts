/**
 * 从 tool raw 抽失败摘要（过程块 / 系统行）。
 */
export function extractToolFailHint(
  raw: unknown,
  name?: string,
): string | null {
  if (!raw || typeof raw !== "object") {
    return name ? `${name}: failed` : null;
  }
  const r = raw as Record<string, unknown>;
  const content = r.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const inner = (c as { content?: { text?: string }; text?: string })
        .content;
      const t =
        (typeof inner === "object" && inner && "text" in inner
          ? String((inner as { text?: string }).text ?? "")
          : "") || String((c as { text?: string }).text ?? "");
      if (t.trim()) {
        const short = t.trim().slice(0, 200);
        return name ? `${name}: ${short}` : short;
      }
    }
  }
  const out = r.rawOutput ?? r.raw_output;
  if (out && typeof out === "object") {
    const m =
      (out as { message?: string }).message ??
      (out as { error?: string }).error;
    if (typeof m === "string" && m.trim()) {
      const short = m.trim().slice(0, 200);
      return name ? `${name}: ${short}` : short;
    }
  }
  return name ? `${name}: failed` : null;
}
