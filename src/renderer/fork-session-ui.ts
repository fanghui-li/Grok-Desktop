/**
 * Fork confirmation dialog HTML + slash arg parse (P1-D · P3-D extract).
 */
import { tr } from "../shared/i18n/index.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ForkWorktreeMode = "use_main" | "create_new";

export function parseForkSlashArgs(rawArg: string): {
  directive: string;
  worktreeMode: ForkWorktreeMode;
} {
  let arg = (rawArg ?? "").trim();
  let worktreeMode: ForkWorktreeMode = "use_main";
  if (/\s--worktree\b/.test(" " + arg) || arg.startsWith("--worktree")) {
    worktreeMode = "create_new";
    arg = arg.replace(/--worktree\b/, "").trim();
  }
  if (/\s--no-worktree\b/.test(" " + arg) || arg.startsWith("--no-worktree")) {
    worktreeMode = "use_main";
    arg = arg.replace(/--no-worktree\b/, "").trim();
  }
  return { directive: arg, worktreeMode };
}

/** UI 确认框：仅工作区选项（首条 directive 走 /fork 参数，不占对话框） */
export function buildForkDialogHtml(_baseTitle?: string): string {
  return `<fieldset class="fork-wt-fieldset">
         <legend>${esc(tr("session.forkWorktreeLegend"))}</legend>
         <label class="fork-wt-opt"><input type="radio" name="fork-wt" value="use_main" checked /> ${esc(tr("session.forkWorktreeMain"))}</label>
         <label class="fork-wt-opt"><input type="radio" name="fork-wt" value="create_new" /> ${esc(tr("session.forkWorktreeNew"))}</label>
       </fieldset>
       <div class="prompt-dlg-actions">
         <button type="button" class="btn-dark" id="fork-dlg-ok">${esc(tr("session.forkConfirmOk"))}</button>
         <button type="button" class="btn-ghost" id="prompt-dlg-cancel">${esc(tr("common.cancel"))}</button>
       </div>`;
}

export function readForkDialogResult(): {
  worktreeMode: ForkWorktreeMode;
} {
  const wt =
    (
      document.querySelector(
        'input[name="fork-wt"]:checked',
      ) as HTMLInputElement | null
    )?.value === "create_new"
      ? "create_new"
      : "use_main";
  return { worktreeMode: wt };
}
