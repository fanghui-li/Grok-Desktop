/**
 * `/status` · context 详情：SessionInfo 行格式化（纯文案）。
 */
import { tr } from "../../shared/i18n/index.js";

export type SessionInfoRow = {
  sessionId: string;
  cwd?: string;
  agentName?: string;
  model?: string;
  modelDisplayName?: string;
  resolvedModelId?: string;
  modelFingerprint?: string;
  showModelFingerprint?: boolean;
  apiBackend?: string;
  conversationId?: string;
  turns: number;
  turnIndex: number;
  context: {
    used: number;
    total: number;
    systemPromptTokens: number;
    toolDefinitionsCount: number;
    toolDefinitionsTokens: number;
    compactionCount: number;
    turnCount: number;
    toolCallCount: number;
    messageCount: number;
    messageTokens: number;
    freeTokens: number;
    usagePct: number;
    autoCompactThresholdPercent: number;
    usageCategories: Array<{ label: string; tokens: number; detail?: string }>;
  };
};

export function formatSessionInfoLines(
  info: SessionInfoRow,
  extras?: { project?: string; effort?: string; perm?: string },
): string[] {
  const c = info.context;
  const model = info.modelDisplayName || info.model || tr("slash.none");
  const lines = [
    tr("status.sessionId", { id: info.sessionId }),
    extras?.project
      ? tr("status.project", { project: extras.project })
      : null,
    info.cwd ? tr("status.cwd", { cwd: info.cwd }) : null,
    info.agentName ? tr("status.agent", { name: info.agentName }) : null,
    tr("status.model", { model }),
    info.resolvedModelId && info.resolvedModelId !== info.model
      ? tr("status.resolvedModel", { id: info.resolvedModelId })
      : null,
    info.showModelFingerprint && info.modelFingerprint
      ? tr("status.fingerprint", { fp: info.modelFingerprint })
      : null,
    extras?.effort ? tr("status.effort", { effort: extras.effort }) : null,
    extras?.perm ? tr("status.perm", { perm: extras.perm }) : null,
    info.apiBackend
      ? tr("status.backend", { backend: info.apiBackend })
      : null,
    tr("status.turns", {
      turns: info.turns,
      turnIndex: info.turnIndex,
    }),
    "",
    tr("status.contextHeader"),
    tr("status.contextUsed", {
      used: c.used.toLocaleString(),
      total: c.total.toLocaleString(),
      pct:
        c.usagePct ||
        (c.total > 0 ? Math.round((c.used / c.total) * 100) : 0),
    }),
    tr("status.contextFree", { free: c.freeTokens.toLocaleString() }),
    tr("status.contextSystem", {
      tokens: c.systemPromptTokens.toLocaleString(),
    }),
    tr("status.contextTools", {
      count: c.toolDefinitionsCount,
      tokens: c.toolDefinitionsTokens.toLocaleString(),
    }),
    tr("status.contextMessages", {
      count: c.messageCount,
      tokens: c.messageTokens.toLocaleString(),
    }),
    tr("status.contextTurnsTools", {
      turns: c.turnCount,
      tools: c.toolCallCount,
      compact: c.compactionCount,
    }),
    tr("status.autoCompactAt", {
      pct: c.autoCompactThresholdPercent || 85,
    }),
  ].filter((x): x is string => x != null);

  if (c.usageCategories?.length) {
    lines.push("", tr("status.categoriesHeader"));
    for (const cat of c.usageCategories) {
      const detail = cat.detail ? ` (${cat.detail})` : "";
      lines.push(`  ${cat.label}${detail}: ${cat.tokens.toLocaleString()}`);
    }
  }
  return lines;
}
