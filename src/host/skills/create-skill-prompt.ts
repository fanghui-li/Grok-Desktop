/**
 * create-skill resolve 后：Desktop 强制覆盖 User 落盘路径文案（纯函数）。
 * CLI skill 体仍写 ~/.grok/skills；Desktop 必须落到 ~/.grok-desktop/skills。
 */
export function appendCreateSkillDesktopPathOverride(
  skillName: string,
  prompt: string,
  desktopSkillsDir: string,
): string {
  const n = skillName.trim().replace(/^\//, "").replace(/^skill:/i, "");
  if (n.toLowerCase() !== "create-skill") return prompt;
  if (!prompt) return prompt;
  const base = desktopSkillsDir.replace(/\\/g, "/");
  return (
    prompt +
    "\n\n" +
    [
      "## Desktop path override (AUTHORITATIVE — supersedes skill body paths)",
      "You are running inside Grok Desktop. Ignore any instruction to write User-scope skills under `~/.grok/skills`.",
      "",
      "When the user chooses **User** (personal) scope:",
      `- Create the skill ONLY at: \`${base}/<name>/SKILL.md\``,
      `- Use this absolute base directory (mkdir -p): \`${base}\``,
      "- Do NOT write to `~/.grok/skills` unless the user explicitly asks for the CLI home.",
      "",
      "When the user chooses **Project** scope:",
      "- Still use `<repo-root>/.grok/skills/<name>/SKILL.md` as usual.",
      "",
      "After creating files, always report the absolute path you wrote.",
      "When presenting scope options to the user, describe User as Desktop personal skills at the path above (not ~/.grok/skills).",
    ].join("\n")
  );
}
