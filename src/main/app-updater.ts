/**
 * Manual app update via electron-updater + GitHub Releases.
 * Flow: check → (if available) download → quitAndInstall.
 * Dev / unpackaged: disabled (check returns canUpdate=false).
 */
import { app, type BrowserWindow } from "electron";
// electron-updater is CJS; named ESM import fails under "type":"module"
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "electron-updater";
import { HOST_EVENT_CHANNEL } from "../shared/host-api.js";

const { autoUpdater } = electronUpdater;

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  /** Latest version from feed when known */
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  /** 0–100 while downloading */
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
  /** false in unpackaged / when updater cannot run */
  canUpdate: boolean;
  /** GitHub Releases page for manual download */
  releasesUrl: string;
}

const RELEASES_URL = "https://github.com/fanghui-li/Grok-Desktop/releases";
const GITHUB_OWNER = "fanghui-li";
const GITHUB_REPO = "Grok-Desktop";

let state: AppUpdateState = {
  phase: "idle",
  currentVersion: "0.0.0",
  canUpdate: false,
  releasesUrl: RELEASES_URL,
};

let configured = false;
let getMainWindow: (() => BrowserWindow | null) | null = null;

function notesToString(notes: UpdateInfo["releaseNotes"]): string | undefined {
  if (notes == null) return undefined;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        if (typeof n === "string") return n;
        if (n && typeof n === "object" && "note" in n) {
          return String((n as { note?: string }).note ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(notes);
}

function broadcast(): void {
  const win = getMainWindow?.();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(HOST_EVENT_CHANNEL, {
      type: "app.update",
      ...state,
      at: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
}

function setState(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch };
  broadcast();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err ?? "unknown error");
}

/**
 * Call once after app ready. No auto-check / auto-download.
 */
export function initAppUpdater(opts: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  if (configured) return;
  configured = true;
  getMainWindow = opts.getMainWindow;

  const packaged = app.isPackaged;
  state = {
    phase: "idle",
    currentVersion: app.getVersion(),
    canUpdate: packaged,
    releasesUrl: RELEASES_URL,
  };

  if (!packaged) {
    return;
  }

  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Public repo — no token needed for latest.yml
    autoUpdater.setFeedURL({
      provider: "github",
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
    });
  } catch (err) {
    setState({
      phase: "error",
      canUpdate: false,
      error: errorMessage(err),
    });
    return;
  }

  autoUpdater.on("checking-for-update", () => {
    setState({
      phase: "checking",
      error: undefined,
      percent: undefined,
    });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    setState({
      phase: "available",
      latestVersion: info.version,
      releaseName: info.releaseName || info.version,
      releaseNotes: notesToString(info.releaseNotes),
      error: undefined,
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    setState({
      phase: "not-available",
      latestVersion: info?.version ?? state.currentVersion,
      error: undefined,
    });
  });

  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    setState({
      phase: "downloading",
      percent: Math.round(p.percent * 10) / 10,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
      error: undefined,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setState({
      phase: "downloaded",
      latestVersion: info.version,
      releaseName: info.releaseName || info.version,
      releaseNotes: notesToString(info.releaseNotes),
      percent: 100,
      error: undefined,
    });
  });

  autoUpdater.on("error", (err: Error) => {
    setState({
      phase: "error",
      error: errorMessage(err),
    });
  });

  // 启动后静默检查（顶栏绿点）；失败不打扰，用户仍可点顶栏/关于页
  setTimeout(() => {
    void checkForAppUpdate().catch(() => undefined);
  }, 5_000);
}

export function getAppUpdateState(): AppUpdateState {
  return { ...state };
}

/** Manual check against GitHub latest release. */
export async function checkForAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) {
    setState({
      phase: "error",
      canUpdate: false,
      error: "dev-only",
      currentVersion: app.getVersion(),
    });
    return getAppUpdateState();
  }
  if (state.phase === "checking" || state.phase === "downloading") {
    return getAppUpdateState();
  }
  try {
    setState({ phase: "checking", error: undefined });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({ phase: "error", error: errorMessage(err) });
  }
  return getAppUpdateState();
}

/** Download after update-available (or retry after error if version known). */
export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!app.isPackaged) {
    setState({ phase: "error", canUpdate: false, error: "dev-only" });
    return getAppUpdateState();
  }
  if (state.phase === "downloading" || state.phase === "downloaded") {
    return getAppUpdateState();
  }
  const canStart =
    state.phase === "available" ||
    (state.phase === "error" && Boolean(state.latestVersion));
  if (!canStart) {
    return getAppUpdateState();
  }
  try {
    setState({ phase: "downloading", percent: 0, error: undefined });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({ phase: "error", error: errorMessage(err) });
  }
  return getAppUpdateState();
}

/** Install downloaded update and restart. */
export function installAppUpdate(): AppUpdateState {
  if (!app.isPackaged) {
    setState({ phase: "error", canUpdate: false, error: "dev-only" });
    return getAppUpdateState();
  }
  if (state.phase !== "downloaded") {
    return getAppUpdateState();
  }
  try {
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    setState({ phase: "error", error: errorMessage(err) });
  }
  return getAppUpdateState();
}
