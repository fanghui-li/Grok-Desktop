/**
 * 附件策略：扩展名 / 上限 / 去重添加计划（纯逻辑）。
 * DOM chips 与 Host 写盘仍由 main 接线。
 */

/** 与 CLI IMAGE_EXTENSIONS 对齐（无 SVG；含 tiff/tif） */
export const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
]);

/** 与 Host MAX_COMPOSER_ATTACHMENTS 对齐 */
export const MAX_COMPOSER_ATTACHMENTS = 20;
/** 与 Host MAX_COMPOSER_IMAGES / CLI IMAGE_CAP 对齐 */
export const MAX_COMPOSER_IMAGES = 10;
/** 粘贴单图客户端预检（Host 再验 20MB） */
export const MAX_PASTE_IMAGE_BYTES_UI = 20 * 1024 * 1024;

export type ComposerAttachment = {
  path: string;
  name: string;
  kind: "file" | "image" | "folder";
  /** 缩略图 / 灯箱用 data URL */
  previewUrl?: string;
};

export function attachmentKind(filePath: string): "file" | "image" | "folder" {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const ext = base.includes(".")
    ? base.slice(base.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return IMAGE_EXT.has(ext) ? "image" : "file";
}

export function attachIcon(kind: ComposerAttachment["kind"]): string {
  if (kind === "image") return "🖼";
  if (kind === "folder") return "📁";
  return "📄";
}

export type AddAttachmentsPlan = {
  toAdd: ComposerAttachment[];
  skippedDup: number;
  skippedCap: number;
  skippedImageCap: number;
};

/**
 * 计算要新增的附件列表（不修改入参 existing）。
 */
export function planAddAttachments(
  existing: readonly ComposerAttachment[],
  paths: string[],
  opts?: {
    kind?: ComposerAttachment["kind"];
    previewMap?: Record<string, string>;
  },
): AddAttachmentsPlan {
  const toAdd: ComposerAttachment[] = [];
  let skippedDup = 0;
  let skippedCap = 0;
  let skippedImageCap = 0;
  let imageCount = existing.filter((a) => a.kind === "image").length;
  let totalCount = existing.length;

  for (const p of paths) {
    if (!p) continue;
    const abs = p.replace(/[/\\]+$/, "") || p;
    if (
      existing.some((a) => a.path === abs || a.path === p) ||
      toAdd.some((a) => a.path === abs || a.path === p)
    ) {
      skippedDup++;
      continue;
    }
    if (totalCount >= MAX_COMPOSER_ATTACHMENTS) {
      skippedCap++;
      continue;
    }
    const name = abs.split(/[/\\]/).pop() || abs;
    const kind = opts?.kind ?? attachmentKind(abs);
    if (kind === "image") {
      if (imageCount >= MAX_COMPOSER_IMAGES) {
        skippedImageCap++;
        continue;
      }
    }
    const pathKey = kind === "folder" ? abs : p;
    toAdd.push({
      path: pathKey,
      name: kind === "folder" ? `${name}/` : name,
      kind,
      previewUrl:
        opts?.previewMap?.[pathKey] ??
        opts?.previewMap?.[p] ??
        opts?.previewMap?.[abs],
    });
    totalCount++;
    if (kind === "image") imageCount++;
  }
  return { toAdd, skippedDup, skippedCap, skippedImageCap };
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 解析拖放/剪贴板 File 的本地绝对路径。
 * Electron 35 渲染进程不再可靠暴露 File.path，须走 preload webUtils.getPathForFile。
 */
export function resolveLocalFilePath(
  file: File,
  getPathForFile?: (file: File) => string,
): string {
  try {
    const viaBridge = getPathForFile?.(file);
    if (typeof viaBridge === "string" && viaBridge.trim()) {
      return viaBridge.trim();
    }
  } catch {
    /* ignore */
  }
  const legacy = (file as File & { path?: string }).path;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return "";
}

/** Marker written into agent content; history parse must recognize both forms. */
export const ATTACHMENTS_BLOCK_MARKERS = [
  "[Attachments — include these paths in context; for folders, consider the directory tree]",
  "[Attachments — include these paths in context]",
] as const;

/**
 * User-visible display + agent content with attachment path block.
 * Symmetric with {@link parseUserHistoryPayload}.
 */
export function buildPromptWithAttachments(
  userText: string,
  attachments: readonly ComposerAttachment[],
): { display: string; content: string } {
  const display = userText.trim();
  if (!attachments.length) {
    return { display, content: display };
  }
  const block = attachments
    .map((a) => {
      const label =
        a.kind === "image" ? "image" : a.kind === "folder" ? "folder" : "file";
      return `- ${label}: ${a.path}`;
    })
    .join("\n");
  const marker = ATTACHMENTS_BLOCK_MARKERS[0];
  const content = display
    ? `${display}\n\n${marker}\n${block}`
    : `${marker}\n${block}`;
  return {
    display: display || `（${attachments.length} 个附件）`,
    content,
  };
}

/** Split history body into user text + attachment rows (send path inverse). */
export function parseUserHistoryPayload(raw: string): {
  text: string;
  attachments: ComposerAttachment[];
} {
  let idx = -1;
  let marker = "";
  for (const m of ATTACHMENTS_BLOCK_MARKERS) {
    const i = raw.indexOf(m);
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      marker = m;
    }
  }
  if (idx < 0) {
    return { text: raw.trim(), attachments: [] };
  }
  const text = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + marker.length);
  const attachments: ComposerAttachment[] = [];
  for (const line of rest.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*(file|image|folder)\s*:\s*(.+)\s*$/i);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as ComposerAttachment["kind"];
    const pathStr = m[2]!.trim();
    if (!pathStr) continue;
    const base = pathStr.split(/[/\\]/).pop() || pathStr;
    attachments.push({
      path: pathStr,
      name: kind === "folder" ? `${base.replace(/\/$/, "")}/` : base,
      kind,
    });
  }
  return { text, attachments };
}
