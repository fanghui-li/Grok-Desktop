import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Stable ACP / queue owner id (plan M2). */
export const CLIENT_IDENTIFIER = "grok-desktop";

/**
 * Resolve Desktop app version for ACP clientInfo (not hard-coded 0.1.0).
 * Prefer package.json next to repo root / app root.
 */
export function readAppVersion(opts?: { appRoot?: string }): string {
  const candidates: string[] = [];
  if (opts?.appRoot) {
    candidates.push(path.join(opts.appRoot, "package.json"));
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/host or src/host → repo root
    candidates.push(path.resolve(here, "../../package.json"));
    candidates.push(path.resolve(here, "../../../package.json"));
  } catch {
    /* ignore */
  }
  if (typeof process !== "undefined" && process.cwd) {
    candidates.push(path.join(process.cwd(), "package.json"));
  }

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
      const v = (raw.version ?? "").trim();
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return "0.0.0-dev";
}
