/**
 * 计划文档路径识别（tool write 元数据 / 标题）。
 * 纯启发式；DOM / lastPlanArtifactPath 由调用方持有。
 */
import { extractToolMeta } from "../agent-blocks.js";

/** 文件名是否像 session / 工作区计划产物 */
export function isPlanDocumentBaseName(base: string): boolean {
  if (/^plan\.md$/i.test(base)) return true;
  return /plan/i.test(base) && /\.(md|markdown|txt)$/i.test(base);
}

/**
 * 从 write 类 tool raw 识别计划文档路径。
 * @returns 命中路径，否则 null
 */
export function extractPlanArtifactPath(
  name: string | undefined,
  raw: unknown,
): string | null {
  const meta = extractToolMeta(raw, name);
  if (meta.kind !== "write" && !/write|edit|create/i.test(name ?? "")) {
    // 仍允许从 title 扫路径
  } else {
    for (const p of meta.paths) {
      const base = p.split(/[/\\]/).pop() ?? p;
      if (isPlanDocumentBaseName(base)) return p;
    }
  }
  // title: Write `...\performance-optimization-plan.zh.md`
  if (raw && typeof raw === "object") {
    const title = String((raw as { title?: string }).title ?? "");
    const m = title.match(/`([^`]+\.(?:md|markdown|txt))`/i);
    if (m) {
      const base = m[1].split(/[/\\]/).pop() ?? m[1];
      if (/plan/i.test(base)) return m[1];
    }
  }
  return null;
}

export type PlanRailActivity = "pending" | "revising" | "soft" | "none";

/**
 * 右侧轨「计划」活动点：待批准 > 修订中 > 计划模式/有内容。
 */
export function resolvePlanRailActivity(opts: {
  approvalArmed: boolean;
  planOn: boolean;
  hasBody: boolean;
  turnStatusText: string;
  revisingLabel: string;
}): PlanRailActivity {
  if (opts.approvalArmed) return "pending";
  const turn = opts.turnStatusText;
  if (
    opts.planOn &&
    (turn.includes(opts.revisingLabel) || /修订|revis/i.test(turn))
  ) {
    return "revising";
  }
  if (opts.planOn || opts.hasBody) return "soft";
  return "none";
}

/** 状态条文案片段（Pending / Active / 未保存 / 等待审批） */
export function planPanelStatusBits(opts: {
  planOn: boolean;
  planPhase: "off" | "pending" | "active";
  dirty: boolean;
  armed: boolean;
  modeChipLabel: string;
  unsavedLabel: string;
  awaitingLabel: string;
}): string[] {
  const bits: string[] = [];
  if (opts.planOn) {
    bits.push(
      opts.planPhase === "pending"
        ? "Pending"
        : opts.planPhase === "active"
          ? "Active"
          : opts.modeChipLabel,
    );
  }
  if (opts.dirty) bits.push(opts.unsavedLabel);
  if (opts.armed) bits.push(opts.awaitingLabel);
  return bits;
}

/**
 * 打开面板时是否保留编辑器草稿。
 * 有未保存修改且非强制重载时不覆盖。
 */
export function shouldKeepPlanDraft(opts: {
  forceReload?: boolean;
  dirty: boolean;
  editorHasText: boolean;
}): boolean {
  return !opts.forceReload && opts.dirty && opts.editorHasText;
}

/**
 * 合并 plans.get / seed / 产物镜像后的正文优先级：
 * session content > seed > （调用方再填 artifact）
 */
export function preferPlanContent(
  sessionContent: string,
  seedContent?: string | null,
): string {
  const c = (sessionContent ?? "").trim() ? sessionContent : "";
  if (c.trim()) return sessionContent;
  if (seedContent?.trim()) return seedContent;
  return sessionContent || "";
}
