/**
 * History → Markdown export body (pure; no FS / LiveThread).
 */

export type HistoryExportEntry = {
  role: string;
  text?: string | null;
  toolName?: string | null;
};

export type HistoryExportMeta = {
  title: string;
  sessionId: string;
  cwd?: string | null;
  exportedAt?: string;
};

/**
 * Build markdown document for session export (save dialog).
 */
export function buildHistoryExportMarkdown(
  meta: HistoryExportMeta,
  entries: readonly HistoryExportEntry[],
): string {
  const title = meta.title || meta.sessionId.slice(0, 8);
  const lines: string[] = [
    `# ${title}`,
    "",
    `- session: \`${meta.sessionId}\``,
    `- cwd: \`${meta.cwd || "—"}\``,
    `- exported: ${meta.exportedAt ?? new Date().toISOString()}`,
    "",
    "---",
    "",
  ];
  for (const e of entries) {
    if (e.role === "user") {
      lines.push("## User", "", e.text || "_(empty)_", "");
    } else if (e.role === "assistant") {
      lines.push("## Assistant", "", e.text || "_(empty)_", "");
    } else if (e.role === "tool") {
      const name = e.toolName || "tool";
      lines.push(
        `### Tool · ${name}`,
        "",
        e.text ? "```\n" + e.text.slice(0, 4000) + "\n```" : "_(no output)_",
        "",
      );
    }
  }
  return lines.join("\n");
}
