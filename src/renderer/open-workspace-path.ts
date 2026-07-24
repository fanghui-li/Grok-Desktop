/**
 * 工作区内路径打开的统一路由（P1）。
 *
 * 产品语义（对齐 Codex Desktop 点击心智）：
 * - 图片 → 应用内 lightbox（有预览时），否则再试 dataUrl，仍失败则系统打开
 * - 目录 → 系统资源管理器 / Finder（system.openPath）
 * - 文本 / 源码 → 右侧栏预览（sidePane.openFile）
 * - 侧栏不可用 → system.openPath 兜底
 *
 * 入口（transcript file-link、附件 chip、搜索符号、工具路径等）应只调此函数，
 * 勿各自再拆 sidePane.openFile / system.openPath。
 */

import type { HostIpcMethod } from "../shared/host-api.js";

type HostRes<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

type Inv = <T>(method: HostIpcMethod, params?: unknown) => Promise<HostRes<T>>;

/** 与 CLI IMAGE_EXTENSIONS / Host 对齐（无 SVG；含 tiff/tif） */
const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
]);

export type WorkspacePathKind = "file" | "image" | "folder";

export type OpenWorkspacePathOpts = {
  path: string;
  line?: number;
  /** 已知 kind 时优先（附件 chip）；否则按扩展名 / 尾斜杠推断 */
  kind?: WorkspacePathKind;
  /** 图片已有 data URL 时直出 lightbox，避免再读盘 */
  previewUrl?: string;
  /** lightbox 标题 */
  name?: string;
  /** 会话图（history thumb）读 dataUrl 时需要 */
  sessionId?: string | null;
};

export type OpenWorkspacePathDeps = {
  inv: Inv;
  getSidePane: () => {
    openFile: (path: string, line?: number) => Promise<void>;
  } | null;
  /** 打开图片 lightbox（由 main 注入，内部用 openModal） */
  openImageLightbox: (args: {
    path: string;
    name?: string;
    previewUrl: string;
  }) => void;
  getCwd?: () => string | null | undefined;
};

export function isImageWorkspacePath(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = base.includes(".")
    ? base.slice(base.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return IMAGE_EXT.has(ext);
}

function looksLikeFolder(path: string, kind?: WorkspacePathKind): boolean {
  if (kind === "folder") return true;
  // 尾斜杠 / 反斜杠视为目录
  return /[/\\]$/.test(path.trim());
}

/**
 * 统一打开工作区路径。
 * @returns 实际采取的动作（便于测试 / 日志）
 */
export async function openWorkspacePath(
  deps: OpenWorkspacePathDeps,
  opts: OpenWorkspacePathOpts,
): Promise<"lightbox" | "side-pane" | "system" | "noop"> {
  const raw = (opts.path || "").trim();
  if (!raw) return "noop";

  // 目录：系统打开
  if (looksLikeFolder(raw, opts.kind)) {
    await deps.inv("system.openPath", { path: raw.replace(/[/\\]+$/, "") || raw });
    return "system";
  }

  const asImage =
    opts.kind === "image" ||
    (opts.kind !== "file" && isImageWorkspacePath(raw));

  if (asImage) {
    let src = opts.previewUrl?.trim() || "";
    if (!src) {
      const res = await deps.inv<{ dataUrl: string }>("files.readDataUrl", {
        path: raw,
        sessionId: opts.sessionId || undefined,
        cwd: deps.getCwd?.() || undefined,
      });
      if (res.ok && res.data?.dataUrl) src = res.data.dataUrl;
    }
    if (src) {
      deps.openImageLightbox({
        path: raw,
        name: opts.name,
        previewUrl: src,
      });
      return "lightbox";
    }
    // 读不出预览（权限/缺失）→ 系统打开
    await deps.inv("system.openPath", { path: raw });
    return "system";
  }

  // 文本 / 其它文件 → 侧栏
  const pane = deps.getSidePane();
  if (pane) {
    await pane.openFile(raw, opts.line);
    return "side-pane";
  }
  await deps.inv("system.openPath", { path: raw });
  return "system";
}
