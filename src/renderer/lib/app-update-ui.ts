/**
 * 顶栏更新按钮绿点 / 文案（自 main 迁出）。
 */
import { tr } from "../../shared/i18n/index.js";

export type AppUpdateUiSnap = {
  phase?: string;
  latestVersion?: string;
  canUpdate?: boolean;
  error?: string;
  currentVersion?: string;
  releasesUrl?: string;
};

export function syncAppUpdateTopButton(
  snap: AppUpdateUiSnap | null | undefined,
  lastSnap: AppUpdateUiSnap | null,
): AppUpdateUiSnap | null {
  const u = snap ?? lastSnap;
  const btn = document.getElementById(
    "btn-app-update",
  ) as HTMLButtonElement | null;
  const dot = document.getElementById("btn-app-update-dot");
  if (!btn) return u;
  const phase = (u?.phase || "").toLowerCase();
  const hasUpdate =
    Boolean(u?.canUpdate) &&
    (phase === "available" ||
      phase === "downloaded" ||
      phase === "downloading" ||
      (phase === "error" && Boolean(u?.latestVersion)));
  btn.classList.toggle("has-update", hasUpdate);
  if (dot) {
    if (hasUpdate) dot.removeAttribute("hidden");
    else dot.setAttribute("hidden", "");
  }
  const ver = (u?.latestVersion || "").trim();
  if (hasUpdate && ver) {
    btn.title = tr("nav.updateAvailableTitle", { version: ver });
    btn.setAttribute("aria-label", btn.title);
  } else {
    btn.title = tr("nav.updateTitle");
    btn.setAttribute("aria-label", tr("nav.updateTitle"));
  }
  return u;
}
