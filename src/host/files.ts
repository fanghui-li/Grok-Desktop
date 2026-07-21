/**
 * 项目内文件读写（侧栏预览用）— 限制在允许的 root 下。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HostError } from "../shared/errors.js";
import { desktopDir } from "./paths.js";

const MAX_READ_BYTES = 1_500_000; // ~1.5MB

export type FileReadResult = {
  path: string;
  absPath: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  language: string;
  mtimeMs: number;
  isDirectory: boolean;
};

function normalizeRoots(roots: string[]): string[] {
  return roots
    .filter(Boolean)
    .map((r) => path.resolve(r).toLowerCase().replace(/\\/g, "/"));
}

/** 解析路径并校验落在任一 root 下（或 root 自身） */
export function resolveUnderRoots(
  filePath: string,
  cwd?: string | null,
  extraRoots: string[] = [],
): string {
  let raw = filePath.trim();
  if (raw.startsWith("file://")) {
    raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/, ""));
  }
  const abs = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd || process.cwd(), raw);

  const roots = normalizeRoots([
    ...(cwd ? [cwd] : []),
    ...extraRoots,
  ]);
  if (!roots.length) {
    // No project roots: deny by default (callers must pass paste-images / cwd).
    throw new HostError(
      "INVALID_ARGUMENT",
      `Path outside project roots: ${abs}`,
    );
  }
  const absN = abs.toLowerCase().replace(/\\/g, "/");
  const ok = roots.some(
    (root) => absN === root || absN.startsWith(root.endsWith("/") ? root : root + "/"),
  );
  if (!ok) {
    throw new HostError(
      "INVALID_ARGUMENT",
      `Path outside project roots: ${abs}`,
    );
  }
  return abs;
}

function guessLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    css: "css",
    scss: "css",
    html: "xml",
    htm: "xml",
    xml: "xml",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    diff: "diff",
  };
  return map[ext] || "plaintext";
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readProjectFile(opts: {
  path: string;
  cwd?: string | null;
  roots?: string[];
  maxBytes?: number;
}): FileReadResult {
  const abs = resolveUnderRoots(opts.path, opts.cwd, opts.roots ?? []);
  if (!fs.existsSync(abs)) {
    throw new HostError("IO_ERROR", `File not found: ${abs}`);
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    return {
      path: opts.path,
      absPath: abs,
      content: "",
      size: st.size,
      truncated: false,
      binary: false,
      language: "plaintext",
      mtimeMs: st.mtimeMs,
      isDirectory: true,
    };
  }
  const max = opts.maxBytes ?? MAX_READ_BYTES;
  const buf = fs.readFileSync(abs);
  const binary = looksBinary(buf);
  if (binary) {
    return {
      path: opts.path,
      absPath: abs,
      content: "",
      size: buf.length,
      truncated: false,
      binary: true,
      language: "plaintext",
      mtimeMs: st.mtimeMs,
      isDirectory: false,
    };
  }
  const truncated = buf.length > max;
  const slice = truncated ? buf.subarray(0, max) : buf;
  const content = slice.toString("utf8");
  return {
    path: opts.path,
    absPath: abs,
    content,
    size: buf.length,
    truncated,
    binary: false,
    language: guessLanguage(abs),
    mtimeMs: st.mtimeMs,
    isDirectory: false,
  };
}

export function writeProjectFile(opts: {
  path: string;
  content: string;
  cwd?: string | null;
  roots?: string[];
}): { absPath: string; bytes: number } {
  const abs = resolveUnderRoots(opts.path, opts.cwd, opts.roots ?? []);
  // 禁止写目录
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new HostError("IO_ERROR", `Cannot write directory: ${abs}`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, opts.content, "utf8");
  return { absPath: abs, bytes: Buffer.byteLength(opts.content, "utf8") };
}

/**
 * 读取本地图片为 data URL（输入框缩略图预览；限制大小）。
 */
export function readFileDataUrl(opts: {
  path: string;
  maxBytes?: number;
  cwd?: string | null;
  roots?: string[];
  home?: string;
}): { dataUrl: string; mime: string; bytes: number } {
  // Must stay under project roots (or paste-images temp) — never arbitrary FS.
  const extra = [...(opts.roots ?? [])];
  if (opts.home) {
    extra.push(path.join(desktopDir(opts.home), "paste-images"));
  }
  const abs = resolveUnderRoots(opts.path, opts.cwd, extra);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new HostError("IO_ERROR", `Not a file: ${abs}`);
  }
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  const st = fs.statSync(abs);
  if (st.size > max) {
    throw new HostError("IO_ERROR", `file too large for preview (${st.size} bytes)`);
  }
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : ext === "bmp"
            ? "image/bmp"
            : ext === "svg"
              ? "image/svg+xml"
              : "image/png";
  return {
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    mime,
    bytes: buf.length,
  };
}

/**
 * 剪贴板粘贴的图片通常无磁盘 path，落盘到 Desktop 临时目录后再作附件。
 */
export function writePasteImage(opts: {
  base64: string;
  mime?: string;
  home?: string;
}): { path: string; name: string; bytes: number } {
  const raw = (opts.base64 || "").replace(/^data:image\/\w+;base64,/, "").trim();
  if (!raw) {
    throw new HostError("INVALID_ARGUMENT", "empty image data");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new HostError("INVALID_ARGUMENT", "invalid base64 image");
  }
  if (!buf.length) {
    throw new HostError("INVALID_ARGUMENT", "empty image buffer");
  }
  // 限制约 20MB，避免误粘巨图撑爆内存
  if (buf.length > 20 * 1024 * 1024) {
    throw new HostError("IO_ERROR", "image too large (max 20MB)");
  }
  const mime = (opts.mime || "image/png").toLowerCase();
  const ext =
    mime.includes("jpeg") || mime.includes("jpg")
      ? "jpg"
      : mime.includes("webp")
        ? "webp"
        : mime.includes("gif")
          ? "gif"
          : mime.includes("bmp")
            ? "bmp"
            : "png";
  const dir = path.join(desktopDir(opts.home), "paste-images");
  fs.mkdirSync(dir, { recursive: true });
  const name = `paste-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  return { path: abs, name, bytes: buf.length };
}

export type DirEntry = {
  name: string;
  path: string;
  absPath: string;
  isDirectory: boolean;
  ext: string;
};

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".next",
  "dist",
  "out",
  "build",
  "coverage",
  "__pycache__",
  ".cache",
  "target",
  "vendor",
  ".venv",
  "venv",
]);

export type FileSearchHit = {
  /** 相对 cwd 的展示路径（正斜杠） */
  path: string;
  absPath: string;
  name: string;
  isDirectory: boolean;
  score: number;
};

const MAX_WALK_FILES = 8000;
const DEFAULT_SEARCH_LIMIT = 40;

function toPosixRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join("/");
}

function scoreFileHit(rel: string, name: string, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase().replace(/\\/g, "/");
  const r = rel.toLowerCase().replace(/\\/g, "/");
  const n = name.toLowerCase();
  if (n === q || r === q) return 1000;
  if (n.startsWith(q)) return 900;
  if (r.startsWith(q)) return 850;
  if (n.includes(q)) return 700;
  if (r.includes(q)) return 600;
  // 路径段匹配
  const parts = q.split(/[/\\]+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => r.includes(p))) return 550;
  // 简单子序列
  let i = 0;
  for (const ch of r) {
    if (ch === q[i]) i += 1;
    if (i >= q.length) return 300;
  }
  return 0;
}

/**
 * 在项目 cwd 下模糊搜索文件/目录（供 @ 引用）
 * dirsOnly：query 以 / 结尾时只返回目录
 */
export function searchProjectFiles(opts: {
  cwd: string;
  query?: string;
  limit?: number;
  dirsOnly?: boolean;
  /** 显示点文件/点目录（对齐 CLI @! 隐藏模式）；仍跳过 SKIP_DIR_NAMES */
  includeHidden?: boolean;
  roots?: string[];
}): { cwd: string; hits: FileSearchHit[] } {
  const cwdRaw = opts.cwd?.trim();
  if (!cwdRaw) {
    throw new HostError("INVALID_ARGUMENT", "cwd is required for file search");
  }
  const root = resolveUnderRoots(cwdRaw, cwdRaw, opts.roots ?? [cwdRaw]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new HostError("IO_ERROR", `Directory not found: ${root}`);
  }

  let query = (opts.query ?? "").trim().replace(/\\/g, "/");
  // 隐藏模式：@!query（对齐 CLI）；显式 includeHidden 或 query 前缀 !
  let includeHidden = opts.includeHidden === true;
  if (query.startsWith("!")) {
    includeHidden = true;
    query = query.slice(1);
  }
  const dirsOnly =
    opts.dirsOnly === true || query.endsWith("/") || query.endsWith("\\");
  if (dirsOnly) {
    query = query.replace(/[/\\]+$/, "");
  }

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
  const hits: FileSearchHit[] = [];
  let walked = 0;

  const visit = (dir: string, depth: number) => {
    if (walked >= MAX_WALK_FILES || hits.length >= limit * 8) return;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      if (SKIP_DIR_NAMES.has(name)) continue;
      // 默认跳过点文件/点目录；includeHidden 时展示
      if (!includeHidden && name.startsWith(".") && name !== ".") continue;

      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      walked += 1;
      if (walked >= MAX_WALK_FILES) return;

      if (dirsOnly && !isDir) {
        continue;
      }

      const rel = toPosixRel(root, full);
      if (!rel || rel.startsWith("..")) continue;
      const score = scoreFileHit(rel, name, query);
      if (score > 0 || !query) {
        hits.push({
          path: rel + (isDir ? "/" : ""),
          absPath: full,
          name,
          isDirectory: isDir,
          score: query ? score : isDir ? 2 : 1,
        });
      }
      // 空 query 只浅扫，避免大仓卡顿；有 query 再加深
      const maxDepth = query ? 10 : 2;
      if (isDir && depth < maxDepth) {
        visit(full, depth + 1);
      }
    }
  };

  visit(root, 0);

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 文件略优先于目录（同名时）
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  return { cwd: root, hits: hits.slice(0, limit) };
}

/** 列出目录（一层）；用于文件树 */
export function listProjectDir(opts: {
  path?: string;
  cwd?: string | null;
  roots?: string[];
}): { absPath: string; path: string; entries: DirEntry[] } {
  const target = opts.path?.trim() || opts.cwd || "";
  if (!target && !(opts.roots && opts.roots[0])) {
    throw new HostError("INVALID_ARGUMENT", "No directory to list");
  }
  const abs = resolveUnderRoots(
    target || (opts.roots![0] as string),
    opts.cwd,
    opts.roots ?? [],
  );
  if (!fs.existsSync(abs)) {
    throw new HostError("IO_ERROR", `Directory not found: ${abs}`);
  }
  const st = fs.statSync(abs);
  if (!st.isDirectory()) {
    throw new HostError("IO_ERROR", `Not a directory: ${abs}`);
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(abs);
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `Cannot read directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const root = opts.cwd ? path.resolve(opts.cwd) : abs;
  const entries: DirEntry[] = [];
  for (const name of names) {
    if (name === "." || name === "..") continue;
    // 隐藏部分噪音目录（仍可通过直接路径打开）
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = path.join(abs, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir && name.startsWith(".") && name !== ".github") continue;
    const rel = path.relative(root, full) || name;
    entries.push({
      name,
      path: rel.replace(/\\/g, "/"),
      absPath: full,
      isDirectory: isDir,
      ext: isDir ? "" : path.extname(name).slice(1).toLowerCase(),
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const relDir = path.relative(root, abs) || ".";
  return {
    absPath: abs,
    path: relDir.replace(/\\/g, "/"),
    entries,
  };
}
