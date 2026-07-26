/**
 * Composer inline slash lines: /btw and /interject (pure parse).
 */

export type InlineBtwOrInterject = {
  kind: "btw" | "interject";
  body: string;
};

/** Parse a full composer line that is only `/btw …` or `/interject …`. */
export function parseInlineBtwOrInterject(
  text: string,
): InlineBtwOrInterject | null {
  const t = text.replace(/^\s+/, "");
  const m = t.match(/^\/(btw|interject)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return {
    kind: m[1]!.toLowerCase() as "btw" | "interject",
    body: (m[2] ?? "").trim(),
  };
}
