/**
 * 会话 mode 两维模型辅助（plan × access）。
 * 从 host.ts 抽出，便于单测与复用。
 */
import type { AccessMode, SessionMode } from "../../shared/types.js";

/** plan 优先展示；否则为 access（对齐 Build 状态条） */
export function deriveSessionMode(
  access: AccessMode,
  planActive: boolean,
): SessionMode {
  if (planActive) return "plan";
  return access;
}

/** 旧三态 mode → 两维 patch（会同时设定两维） */
export function legacyModeToPatch(mode: SessionMode): {
  alwaysApprove: boolean;
  plan: boolean;
} {
  if (mode === "plan") return { alwaysApprove: false, plan: true };
  if (mode === "always_approve") return { alwaysApprove: true, plan: false };
  return { alwaysApprove: false, plan: false };
}
