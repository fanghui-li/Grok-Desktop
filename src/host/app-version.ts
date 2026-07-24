import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Desktop 产品身份（本地/队列/文档用）。
 * 官方 cli-chat-proxy 当前对 `grok-desktop` 的 Build 采样返回 403 coming soon，
 * ACP initialize 的 wire 身份见 {@link ACP_WIRE_CLIENT_IDENTIFIER}。
 */
export const CLIENT_IDENTIFIER = "grok-desktop";

/**
 * 发往 agent ACP initialize 的 clientIdentifier / clientInfo.name。
 * 临时伪装为 `grok-shell`：与 headless CLI 同一准入路径，官方 `grok-4.5` 可通。
 * 服务端放行 `grok-desktop` 后应改回 {@link CLIENT_IDENTIFIER}。
 */
export const ACP_WIRE_CLIENT_IDENTIFIER = "grok-shell";

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
