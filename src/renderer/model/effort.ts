/**
 * 推理力度（对齐 CLI /effort：low|medium|high|xhigh）。
 */
import { tr } from "../../shared/i18n/index.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

export function effortOptions(): Array<{ id: EffortLevel; label: string }> {
  return [
    { id: "low", label: tr("effort.low") },
    { id: "medium", label: tr("effort.medium") },
    { id: "high", label: tr("effort.high") },
    { id: "xhigh", label: tr("effort.xhigh") },
  ];
}

export function parseEffort(v?: string | null): EffortLevel | null {
  const e = (v ?? "").trim().toLowerCase();
  if (e === "low" || e === "medium" || e === "high" || e === "xhigh") return e;
  return null;
}
