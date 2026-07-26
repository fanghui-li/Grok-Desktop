/**
 * 助手气泡去重 / 跨 turn 粘连检测（纯文本启发式）。
 */

export function normalizeAssistantForDedupe(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[`*_>#\-]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 流式文案与 history 落盘文案常有细微差别（标点/少字/末句改写）。
 * 用于去重：相同、互相包含、或共同前缀足够长则视为同一条。
 */
export function assistantTextsRoughlyEqual(a: string, b: string): boolean {
  const na = normalizeAssistantForDedupe(a);
  const nb = normalizeAssistantForDedupe(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length < 12) return false;
  if (longer.includes(shorter)) return true;
  let i = 0;
  const lim = Math.min(shorter.length, longer.length);
  while (i < lim && shorter[i] === longer[i]) i += 1;
  // 至少 40 字相同，或覆盖较短文案 70%
  return i >= 40 || i >= Math.floor(shorter.length * 0.7);
}

/**
 * 流式拼接时：prev 已是一段像完整回复的文字，chunk 又像另一段回复开头
 * → 禁止 `prev + chunk`（跨 turn 串流典型形态）。
 */
export function looksLikeGluedNewAssistantReply(
  prev: string,
  chunk: string,
): boolean {
  const p = prev.trim();
  const c = chunk.trim();
  if (!p || !c) return false;
  if (c.startsWith(p) || p.startsWith(c)) return false;
  // 正常 token 续写：短增量
  if (c.length <= 32) return false;
  // 大块新全文（非 prev 前缀）：几乎一定是另一轮的完整/半完整回复
  if (c.length >= 24 && p.length >= 30 && !c.startsWith(p.slice(0, 20))) {
    const restarts =
      /^(你好|您好|嗨|哈喽|Hi\b|Hello\b|我是|针对|关于|好的|收到|发了[「""])/i.test(
        c,
      );
    const prevLooksFinished =
      p.length >= 50 ||
      /[。！？.!?]\s*$/.test(p) ||
      /\n\s*[-*•]/.test(p) ||
      /例如[：:]/.test(p);
    if (restarts && prevLooksFinished) return true;
    // 两段都像「独立段落开头」且无共享前缀
    if (prevLooksFinished && c.length >= 40) return true;
  }
  return false;
}
