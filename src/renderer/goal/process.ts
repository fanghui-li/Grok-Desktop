/**
 * goal 流水线 / 验证器英文过程识别（不当作主对话气泡）。
 * 纯启发式；与 turn 状态机解耦。
 */
export function looksLikeGoalProcessText(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const patterns = [
    /\bNot Refuted\b/i,
    /\bRefuted\b/i,
    /\bObjective met\b/i,
    /\bFINAL_RESPONSE\b/,
    /\bAuditing against\b/i,
    /\bAcceptance criteria\b/i,
    /\bWriting the verdict\b/i,
    /\bWriting verdict\b/i,
    /\bWriting a minimal plan\b/i,
    /\bconversational objective\b/i,
    /\badversarial verifier\b/i,
    /\bimplementer evidence\b/i,
    /\bgating check\b/i,
    /\bI'?ll verify\b/i,
    /\bChecking the plan\b/i,
    /\bGoal Plan Writer\b/i,
    /\bYou are an \*\*adversarial\b/i,
    /\bYou are the Goal\b/i,
    /\bverdict files?\b/i,
    /\bclassifier verification\b/i,
    /\bpending_depth\b/i,
    /^Done\.?\s*$/im,
  ];
  if (patterns.some((p) => p.test(t))) return true;
  // 大段英文 + 验证口吻
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const ratio = latin / Math.max(t.length, 1);
  if (
    ratio > 0.55 &&
    t.length > 80 &&
    /\b(objective|plan|evidence|verify|verifier|acceptance|refute)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}
