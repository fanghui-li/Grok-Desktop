/**
 * 检查当前 git 树是否误跟踪了不应入库的路径。
 *
 * 用法：
 *   node scripts/check-main-clean.mjs
 *   node scripts/check-main-clean.mjs --paths-only
 *   node scripts/check-main-clean.mjs --ref origin/main
 *
 * 退出码：0 通过；1 发现禁止路径或 git 失败。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_PREFIXES = ["docs/private/", "docs/dev/", "tmp/"];
const FORBIDDEN_EXACT = ["docs/private", "docs/dev"];

function parseArgs(argv) {
  let ref = null;
  let pathsOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--paths-only") pathsOnly = true;
    else if (a === "--ref") ref = argv[++i];
    else if (a.startsWith("--ref=")) ref = a.slice("--ref=".length);
  }
  return { ref, pathsOnly };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isForbidden(filePath) {
  const p = filePath.replace(/\\/g, "/");
  if (FORBIDDEN_EXACT.includes(p)) return true;
  return FORBIDDEN_PREFIXES.some(
    (prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix),
  );
}

function listTracked(ref) {
  if (ref) {
    return git(["ls-tree", "-r", "--name-only", ref])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return git(["ls-files", "-z"])
    .split("\0")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const { ref, pathsOnly } = parseArgs(process.argv.slice(2));

  if (pathsOnly) {
    console.log("禁止跟踪的路径规则：");
    for (const p of [...FORBIDDEN_EXACT, ...FORBIDDEN_PREFIXES]) {
      console.log(`  - ${p}`);
    }
    process.exit(0);
  }

  let files;
  try {
    files = listTracked(ref);
  } catch (e) {
    console.error("git 列举文件失败：", e?.message || e);
    process.exit(1);
  }

  const bad = files.filter(isForbidden);
  if (bad.length) {
    const label = ref || "当前已跟踪文件";
    console.error(`check-main-clean：${label} 含禁止路径：\n`);
    for (const f of bad) console.error(`  - ${f}`);
    console.error("\n见 docs/BRANCHING.md。内部笔记请放 docs/private/（gitignore）。");
    process.exit(1);
  }

  console.log(
    ref
      ? `check-main-clean：${ref} 通过（无禁止路径）`
      : "check-main-clean：通过（无禁止路径）",
  );
}

main();
