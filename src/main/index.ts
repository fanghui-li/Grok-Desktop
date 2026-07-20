/**
 * Electron shell — Codex-style command center window.
 * All agent work goes through DesktopHost; renderer never spawns grok.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
  clipboard,
  nativeTheme,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopHost } from "../host/host.js";
import { resolveAgentBinPath } from "../host/agent-bin.js";
import { readDesktopConfig } from "../host/extensibility.js";
import { HOST_EVENT_CHANNEL, HOST_IPC_CHANNEL } from "../shared/host-api.js";
import type { HostIpcMethod } from "../shared/host-api.js";
import { HostError, isHostError } from "../shared/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 应用根（dist/main → ../.. = 项目根） */
const APP_ROOT = path.resolve(__dirname, "../..");

type ChromeTheme = "light" | "dark";

const CHROME = {
  light: { bg: "#f5f5f5", symbol: "#1a1a1a" },
  dark: { bg: "#121212", symbol: "#e8e8e8" },
} as const;

/** 启动时解析窗口 chrome（settings.theme + OS） */
function resolveStartupChromeTheme(): ChromeTheme {
  try {
    const pref = readDesktopConfig().theme ?? "system";
    if (pref === "light" || pref === "dark") return pref;
  } catch {
    /* ignore */
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function applyNativeThemeSource(pref: "system" | "light" | "dark"): void {
  try {
    nativeTheme.themeSource = pref;
  } catch {
    /* ignore */
  }
}

function applyWindowChrome(win: BrowserWindow, theme: ChromeTheme): void {
  const c = CHROME[theme];
  try {
    win.setBackgroundColor(c.bg);
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") {
    try {
      win.setTitleBarOverlay({
        color: c.bg,
        symbolColor: c.symbol,
        height: 36,
      });
    } catch {
      /* older Electron */
    }
  }
}

function resolveDesktopAgentPaths(): {
  bundledPath: string | null;
  grokPath: string | null;
} {
  const envAgent = process.env.GROK_DESKTOP_AGENT?.trim() || null;
  const envBundled = process.env.GROK_DESKTOP_BUNDLED_AGENT?.trim() || null;
  const bundledPath = resolveAgentBinPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: APP_ROOT,
    envBundled,
  });
  return {
    bundledPath,
    grokPath: envAgent,
  };
}

let host: DesktopHost | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayTimer: ReturnType<typeof setInterval> | null = null;
let isQuitting = false;

function resultOk<T>(data: T) {
  return { ok: true as const, data };
}

function resultErr(err: unknown) {
  if (isHostError(err)) {
    return { ok: false as const, error: err.toJSON() };
  }
  return {
    ok: false as const,
    error: {
      code: "INTERNAL" as const,
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

async function handleHostIpc(
  method: HostIpcMethod,
  params: unknown,
): Promise<unknown> {
  if (!host) throw new HostError("INTERNAL", "Host not initialized");
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "system.grokInfo":
      return resultOk(host.grokInfo());
    case "system.auth.status":
      return resultOk(host.authStatus());
    case "system.auth.login":
      return resultOk(
        host.authLogin({
          method: p.method as "oauth" | "device-auth" | undefined,
        }),
      );
    case "system.auth.logout":
      return resultOk(host.authLogout());
    case "providers.list":
      return resultOk(host.providersList());
    case "providers.upsert":
      return resultOk(
        host.providersUpsert({
          id: p.id as string,
          model: p.model as string,
          baseUrl: p.baseUrl as string,
          name: p.name as string | undefined,
          apiKey: p.apiKey as string | undefined,
          apiBackend: p.apiBackend as
            | "chat_completions"
            | "responses"
            | "messages"
            | undefined,
          setAsDefault: p.setAsDefault as boolean | undefined,
          createOnly: p.createOnly as boolean | undefined,
        }),
      );
    case "providers.remove":
      return resultOk(host.providersRemove(p.id as string));
    case "providers.setDefault":
      return resultOk(host.providersSetDefault(p.modelId as string));
    case "providers.listRemoteModels":
      return resultOk(
        await host.providersListRemoteModels({
          baseUrl: p.baseUrl as string,
          apiKey: p.apiKey as string | undefined,
          providerId: p.providerId as string | undefined,
        }),
      );
    case "providers.ping":
      return resultOk(
        await host.providersPing({
          baseUrl: p.baseUrl as string | undefined,
          apiKey: p.apiKey as string | undefined,
          providerId: p.providerId as string | undefined,
        }),
      );
    case "system.openInEditor":
      host.systemOpenInEditor(
        p.path as string,
        p.line as number | undefined,
        p.editor as string | undefined,
      );
      return resultOk({ opened: true });
    case "system.openPath":
      await host.systemOpenPath(p.path as string);
      return resultOk({ opened: true });
    case "system.listEditors":
      return resultOk(host.systemListEditors());
    case "system.openExternal":
      await host.systemOpenExternal(p.url as string);
      return resultOk({ opened: true });
    case "files.read":
      return resultOk(
        host.filesRead({
          path: p.path as string,
          cwd: p.cwd as string | undefined,
          maxBytes: p.maxBytes as number | undefined,
        }),
      );
    case "files.write":
      return resultOk(
        host.filesWrite({
          path: p.path as string,
          content: p.content as string,
          cwd: p.cwd as string | undefined,
        }),
      );
    case "files.writePasteImage":
      return resultOk(
        host.filesWritePasteImage({
          base64: p.base64 as string,
          mime: p.mime as string | undefined,
        }),
      );
    case "files.readDataUrl":
      return resultOk(
        host.filesReadDataUrl({
          path: p.path as string,
          maxBytes: p.maxBytes as number | undefined,
        }),
      );
    case "files.list":
      return resultOk(
        host.filesList({
          path: p.path as string | undefined,
          cwd: p.cwd as string | undefined,
        }),
      );
    case "files.search":
      return resultOk(
        host.filesSearch({
          cwd: p.cwd as string,
          query: p.query as string | undefined,
          limit: p.limit as number | undefined,
          dirsOnly: p.dirsOnly as boolean | undefined,
          includeHidden: p.includeHidden as boolean | undefined,
        }),
      );
    case "files.watchStart":
      return resultOk(host.filesWatchStart(p.cwd as string));
    case "files.watchStop":
      return resultOk(host.filesWatchStop());
    case "system.pickDirectory": {
      const win = windowAlive()
        ? mainWindow!
        : BrowserWindow.getFocusedWindow() ?? undefined;
      const opts = {
        title: (p.title as string) || "选择项目文件夹",
        defaultPath: (p.defaultPath as string) || undefined,
        properties: ["openDirectory" as const, "createDirectory" as const],
      };
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || !result.filePaths?.[0]) {
        return resultOk({ path: null, canceled: true });
      }
      return resultOk({ path: result.filePaths[0], canceled: false });
    }
    case "system.pickFiles": {
      const win = windowAlive()
        ? mainWindow!
        : BrowserWindow.getFocusedWindow() ?? undefined;
      const multi = p.multi !== false;
      const opts = {
        title: (p.title as string) || "添加文件或图片",
        defaultPath: (p.defaultPath as string) || undefined,
        properties: [
          "openFile" as const,
          ...(multi ? (["multiSelections"] as const) : []),
        ],
        filters: (p.filters as Array<{ name: string; extensions: string[] }>) ?? [
          { name: "全部支持", extensions: ["*"] },
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
          },
          {
            name: "代码与文本",
            extensions: [
              "ts",
              "tsx",
              "js",
              "jsx",
              "json",
              "md",
              "txt",
              "py",
              "rs",
              "go",
              "css",
              "html",
            ],
          },
        ],
      };
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || !result.filePaths?.length) {
        return resultOk({ paths: [] as string[], canceled: true });
      }
      return resultOk({ paths: result.filePaths, canceled: false });
    }
    case "singleInstance.status":
      return resultOk(host.singleInstanceStatus());
    case "config.get":
      return resultOk(host.configGet());
    case "config.patch": {
      const view = host.configPatch(p);
      if (p.theme !== undefined) {
        const pref =
          p.theme === "light" || p.theme === "dark" || p.theme === "system"
            ? p.theme
            : "system";
        applyNativeThemeSource(pref);
        const chrome: ChromeTheme =
          pref === "system"
            ? nativeTheme.shouldUseDarkColors
              ? "dark"
              : "light"
            : pref;
        const win = windowAlive()
          ? mainWindow!
          : BrowserWindow.getFocusedWindow();
        if (win && !win.isDestroyed()) applyWindowChrome(win, chrome);
      }
      return resultOk(view);
    }
    case "ui.setChromeTheme": {
      const theme = p.theme === "dark" ? "dark" : "light";
      const win = windowAlive()
        ? mainWindow!
        : BrowserWindow.getFocusedWindow();
      if (win && !win.isDestroyed()) applyWindowChrome(win, theme);
      return resultOk({ theme });
    }
    case "projects.list":
      return resultOk(host.projectsList(Boolean(p.includeArchived)));
    case "projects.add":
      return resultOk(
        host.projectsAdd({
          path: p.path as string,
          title: p.title as string | undefined,
          trust: p.trust as boolean | undefined,
        }),
      );
    case "projects.update":
      return resultOk(host.projectsUpdate(p.id as string, p.patch as object));
    case "projects.remove":
      host.projectsRemove(p.id as string);
      return resultOk({ removed: true });
    case "threads.list":
      return resultOk(host.listThreads());
    case "threads.create":
      return resultOk(await host.threadsCreate(p as never));
    case "threads.attach":
      return resultOk(
        await host.threadsAttach(p.sessionId as string, p.cwd as string),
      );
    case "threads.continueRecent":
      return resultOk(host.threadsContinueRecent());
    case "threads.fork":
      return resultOk(
        await host.threadsFork({
          sourceSessionId: p.sourceSessionId as string,
          cwd: p.cwd as string,
          projectId: p.projectId as string | undefined,
          title: p.title as string | undefined,
          model: p.model as string | undefined,
          effort: p.effort as string | undefined,
        }),
      );
    case "threads.detach":
      await host.threadsDetach(p.threadId as string);
      return resultOk({ detached: true });
    case "threads.stop":
      await host.threadsStop(p.threadId as string);
      return resultOk({ stopped: true });
    case "threads.rename":
      return resultOk(
        host.threadsRename(p.threadId as string, p.title as string),
      );
    case "threads.export": {
      const data = host.threadsExportMarkdown(p.threadId as string);
      // destination: clipboard（默认，对齐 Codex/CLI 空参）| file（保存对话框）
      const dest =
        (p.destination as string | undefined)?.toLowerCase() === "file"
          ? "file"
          : "clipboard";
      if (dest === "clipboard") {
        clipboard.writeText(data.markdown);
        return resultOk({
          canceled: false,
          destination: "clipboard" as const,
          path: null,
          sessionId: data.sessionId,
          bytes: Buffer.byteLength(data.markdown, "utf8"),
        });
      }
      const win = windowAlive()
        ? mainWindow!
        : BrowserWindow.getFocusedWindow() ?? undefined;
      const safeName = (data.title || "session")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .slice(0, 80);
      const save = win
        ? await dialog.showSaveDialog(win, {
            title: "导出会话",
            defaultPath: `${safeName}.md`,
            filters: [
              { name: "Markdown", extensions: ["md"] },
              { name: "全部", extensions: ["*"] },
            ],
          })
        : await dialog.showSaveDialog({
            title: "导出会话",
            defaultPath: `${safeName}.md`,
            filters: [
              { name: "Markdown", extensions: ["md"] },
              { name: "全部", extensions: ["*"] },
            ],
          });
      if (save.canceled || !save.filePath) {
        return resultOk({
          canceled: true,
          destination: "file" as const,
          path: null,
        });
      }
      const fs = await import("node:fs");
      fs.writeFileSync(save.filePath, data.markdown, "utf8");
      return resultOk({
        canceled: false,
        destination: "file" as const,
        path: save.filePath,
        sessionId: data.sessionId,
      });
    }
    case "threads.compact":
      return resultOk(
        await host.threadsCompact(p.threadId as string, {
          userContext: p.userContext as string | undefined,
        }),
      );
    case "threads.sessionInfo":
      return resultOk(await host.threadsSessionInfo(p.threadId as string));
    case "threads.btw":
      return resultOk(
        await host.threadsBtw(p.threadId as string, String(p.question ?? "")),
      );
    case "threads.interject":
      return resultOk(
        await host.threadsInterject(p.threadId as string, String(p.text ?? ""), {
          interjectionId:
            typeof p.interjectionId === "string" ? p.interjectionId : undefined,
        }),
      );
    case "threads.availableCommands":
      return resultOk(host.threadsAvailableCommands(p.threadId as string));
    case "threads.killTask":
      return resultOk(
        await host.threadsKillTask(
          p.threadId as string,
          String(p.taskId ?? ""),
        ),
      );
    case "threads.pin":
      return resultOk(
        host.threadsPin(p.threadId as string, Boolean(p.pinned)),
      );
    case "threads.archive":
      return resultOk(
        host.threadsArchive(p.threadId as string, Boolean(p.archived)),
      );
    case "threads.delete":
      return resultOk(await host.threadsDelete(p.threadId as string));
    case "threads.setMode":
      return resultOk(
        await host.threadsSetMode(
          p.threadId as string,
          // 新：{ alwaysApprove, plan }；旧：{ mode }
          p.mode !== undefined &&
            p.alwaysApprove === undefined &&
            p.plan === undefined
            ? (p.mode as never)
            : {
                mode: p.mode as never,
                alwaysApprove: p.alwaysApprove as boolean | undefined,
                plan: p.plan as boolean | undefined,
              },
        ),
      );
    case "threads.setModel":
      return resultOk(
        await host.threadsSetModel(p.threadId as string, {
          modelId: p.modelId as string,
          effort: p.effort as string | undefined,
        }),
      );
    case "threads.rewindPoints":
      return resultOk(await host.threadsRewindPoints(p.threadId as string));
    case "threads.rewindPreview":
      return resultOk(
        await host.threadsRewindPreview(p.threadId as string, {
          targetPromptIndex: Number(p.targetPromptIndex),
        }),
      );
    case "threads.rewind":
      return resultOk(
        await host.threadsRewind(p.threadId as string, {
          targetPromptIndex: Number(p.targetPromptIndex),
          // 默认 true：确认后真正执行（agent force=false 只预览）
          force: p.force !== false,
        }),
      );
    case "turns.prompt":
      await host.turnsPrompt(p.threadId as string, p.content as string);
      return resultOk({ sent: true });
    case "turns.cancel":
      await host.turnsCancel(p.threadId as string);
      return resultOk({ cancelled: true });
    case "permissions.respond":
      host.permissionsRespond(p.requestId as string, p.decision as never);
      return resultOk({ responded: true });
    case "history.load":
      return resultOk(host.historyLoad(p.sessionId as string));
    case "session.context":
      return resultOk(host.sessionContext(p.sessionId as string));
    case "roster.list":
      return resultOk(host.rosterList());
    case "inbox.list":
      return resultOk(host.inboxList(p as never));
    case "inbox.markRead":
      host.inboxMarkRead(p.id as string);
      return resultOk({ ok: true });
    case "inbox.markAllRead":
      host.inboxMarkAllRead();
      return resultOk({ ok: true });
    case "inbox.dismiss":
      host.inboxDismiss(p.id as string);
      return resultOk({ ok: true });
    case "worktrees.list":
      return resultOk(host.worktreesList(p.projectId as string | undefined));
    case "worktrees.create":
      return resultOk(
        host.worktreesCreate(
          p.projectId as string,
          p.name as string | undefined,
        ),
      );
    case "worktrees.cleanup":
      host.worktreesCleanup(p.worktreeId as string, Boolean(p.force));
      return resultOk({ cleaned: true });
    case "changes.summary":
      return resultOk(host.changesSummary(p.cwd as string));
    case "changes.diff":
      return resultOk(host.changesDiff(p.cwd as string, p.path as string));
    case "changes.timeline":
      return resultOk(host.changesTimeline(p.cwd as string));
    case "goals.get":
      return resultOk(host.goalsGet(p.sessionId as string));
    case "goals.set":
      return resultOk(
        host.goalsSet(
          p.sessionId as string,
          p.title as string,
          p.status as "active" | "paused" | "blocked" | "completed" | "cancelled" | undefined,
        ),
      );
    case "goals.setStatus":
      return resultOk(
        host.goalsSetStatus(
          p.sessionId as string,
          p.status as "active" | "paused" | "blocked" | "completed" | "cancelled",
        ),
      );
    case "goals.sync":
      return resultOk(host.goalsSync(p.sessionId as string));
    case "goals.clear":
      return resultOk(host.goalsClear(p.sessionId as string));
    case "plans.get":
      return resultOk(host.plansGet(p.sessionId as string));
    case "plans.write":
      return resultOk(
        host.plansWrite(p.sessionId as string, p.content as string),
      );
    case "plans.approve":
      return resultOk(host.plansApprove(p.sessionId as string));
    case "plans.reject":
      return resultOk(host.plansReject(p.sessionId as string));
    case "plans.respond":
      return resultOk(
        host.plansRespond(
          p.requestId as string,
          p.outcome as "approved" | "cancelled" | "abandoned",
          p.feedback as string | undefined,
          p.sessionId as string | undefined,
        ),
      );
    case "subagents.tree":
      return resultOk(host.subagentsTree(p.sessionId as string));
    case "automations.list":
      return resultOk(host.automationsList());
    case "automations.create":
      return resultOk(host.automationsCreate(p as never));
    case "automations.update":
      return resultOk(
        host.automationsUpdate(p.id as string, p.patch as never),
      );
    case "automations.delete":
      host.automationsDelete(p.id as string);
      return resultOk({ deleted: true });
    case "automations.pause":
      return resultOk(host.automationsPause(p.id as string));
    case "automations.runNow":
      return resultOk(await host.automationsRunNow(p.id as string));
    case "automations.listRuns":
      return resultOk(
        host.automationsListRuns(p.automationId as string | undefined),
      );
    case "skills.list":
      return resultOk(host.skillsList(p.projectPath as string | undefined));
    case "skills.createDraft":
      return resultOk(
        host.skillsCreateDraft({
          name: p.name as string,
          description: p.description as string | undefined,
          scope: p.scope as "user" | "project" | undefined,
          projectPath: p.projectPath as string | undefined,
        }),
      );
    case "skills.openPath":
      return resultOk(host.skillsOpenPath(p.path as string));
    case "plugins.list":
      return resultOk(
        host.pluginsList(p.projectPath as string | undefined, {
          available: Boolean(p.available),
        }),
      );
    case "plugins.install":
      return resultOk(
        host.pluginsInstall(p.source as string, {
          trust: p.trust as boolean | undefined,
        }),
      );
    case "plugins.uninstall":
      return resultOk(
        host.pluginsUninstall(p.name as string, {
          confirm: p.confirm as boolean | undefined,
          keepData: p.keepData as boolean | undefined,
        }),
      );
    case "plugins.enable":
      return resultOk(host.pluginsEnable(p.name as string));
    case "plugins.disable":
      return resultOk(host.pluginsDisable(p.name as string));
    case "plugins.update":
      return resultOk(host.pluginsUpdate(p.name as string | undefined));
    case "plugins.details":
      return resultOk(host.pluginsDetails(p.name as string));
    case "plugins.marketplace.list":
      return resultOk(host.pluginsMarketplaceList());
    case "plugins.marketplace.add":
      return resultOk(host.pluginsMarketplaceAdd(p.url as string));
    case "plugins.marketplace.remove":
      return resultOk(host.pluginsMarketplaceRemove(p.url as string));
    case "plugins.marketplace.update":
      return resultOk(
        host.pluginsMarketplaceUpdate(p.name as string | undefined),
      );
    case "mcp.list":
      return resultOk(host.mcpList());
    case "mcp.add":
      return resultOk(
        host.mcpAdd({
          name: p.name as string,
          commandOrUrl: p.commandOrUrl as string | undefined,
          args: p.args as string[] | undefined,
          transport: p.transport as "stdio" | "http" | "sse" | undefined,
          scope: p.scope as "user" | "project" | undefined,
          env: p.env as string[] | undefined,
          headers: p.headers as string[] | undefined,
          cwd: p.cwd as string | undefined,
        }),
      );
    case "mcp.remove":
      return resultOk(
        host.mcpRemove(p.name as string, {
          scope: p.scope as "user" | "project" | undefined,
          cwd: p.cwd as string | undefined,
        }),
      );
    case "mcp.doctor":
      return resultOk(host.mcpDoctor(p.name as string | undefined));
    case "models.list":
      return resultOk(host.modelsList());
    case "graph.status":
      return resultOk(host.graphStatus(p.projectPath as string));
    case "graph.search":
      return resultOk(
        host.graphSearch(
          p.projectPath as string,
          p.query as string,
          p.limit as number | undefined,
        ),
      );
    case "graph.neighborhood":
      return resultOk(
        host.graphNeighborhood(
          p.projectPath as string,
          p.file as string,
          p.limit as number | undefined,
        ),
      );
    case "memory.status":
      return resultOk(host.memoryStatus());
    case "memory.list":
      return resultOk(
        host.memoryList(typeof p.cwd === "string" ? p.cwd : undefined),
      );
    case "memory.search":
      return resultOk(
        host.memorySearch(
          (p.query as string) ?? "",
          typeof p.cwd === "string" ? p.cwd : undefined,
        ),
      );
    case "memory.browse":
      return resultOk(
        host.memoryBrowse(typeof p.cwd === "string" ? p.cwd : undefined),
      );
    case "memory.read":
      return resultOk(host.memoryRead(String(p.path ?? "")));
    case "memory.add":
      return resultOk(host.memoryAdd(p as never));
    case "memory.remember":
      return resultOk(
        await host.memoryRemember({
          text: String(p.text ?? ""),
          scope: p.scope === "workspace" ? "workspace" : "global",
          cwd: typeof p.cwd === "string" ? p.cwd : undefined,
          threadId: typeof p.threadId === "string" ? p.threadId : undefined,
          rewrite: Boolean(p.rewrite),
        }),
      );
    case "memory.delete":
      host.memoryDelete(p.id as string);
      return resultOk({ deleted: true });
    case "memory.deletePath":
      host.memoryDeletePath(String(p.path ?? ""));
      return resultOk({ deleted: true });
    case "memory.setEnabled":
      return resultOk(host.memorySetEnabled(Boolean(p.enabled)));
    case "threads.memoryFlush":
      return resultOk(await host.threadsMemoryFlush(p.threadId as string));
    case "threads.memoryDream":
      return resultOk(await host.threadsMemoryDream(p.threadId as string));
    case "shell.trayBadge":
      return resultOk(host.shellTrayBadge());
    case "shell.parseDeepLink":
      return resultOk(host.shellParseDeepLink(p.raw as string));
    case "shell.versionMatrix":
      return resultOk(host.shellVersionMatrix());
    case "shell.readHandoff":
      return resultOk(host.shellReadHandoff());
    case "pr.list":
      return resultOk(
        host.prList(p.cwd as string, p.limit as number | undefined),
      );
    case "pr.diff":
      return resultOk(
        host.prDiff(
          p.cwd as string,
          Number(p.number),
          p.headRef as string | undefined,
        ),
      );
    case "remote.list":
      return resultOk(host.remoteList());
    case "remote.add":
      return resultOk(host.remoteAdd(p as never));
    case "remote.remove":
      host.remoteRemove(p.id as string);
      return resultOk({ removed: true });
    default:
      throw new HostError("INVALID_ARGUMENT", `Unknown method: ${method}`);
  }
}

function windowAlive(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
}

function loadAppIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined {
  const candidates = [
    path.join(__dirname, "../assets/icon.png"),
    path.join(__dirname, "../assets/icon-32.png"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function createWindow(): Promise<void> {
  if (windowAlive()) return;

  // Preload must be absolute path + CommonJS (.cjs). ESM preload fails under
  // package.json "type":"module" and leaves window.grokDesktop undefined.
  const preloadPath = path.join(__dirname, "preload.cjs");
  const appIcon = loadAppIcon();
  // 启动 chrome：读 settings.theme + OS（对齐 Codex resolved theme）
  let themePref: "system" | "light" | "dark" = "system";
  try {
    const t = readDesktopConfig().theme;
    if (t === "light" || t === "dark" || t === "system") themePref = t;
  } catch {
    /* ignore */
  }
  applyNativeThemeSource(themePref);
  const chromeTheme = resolveStartupChromeTheme();
  const chrome = CHROME[chromeTheme];
  // Windows：隐藏标题栏图标+文字，保留顶部占位与系统按钮（布局不挤进客户区）
  const winTitleBar =
    process.platform === "win32"
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: chrome.bg,
            symbolColor: chrome.symbol,
            height: 36,
          },
        }
      : {};
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "Grok Desktop",
    backgroundColor: chrome.bg,
    ...(appIcon ? { icon: appIcon } : {}),
    ...winTitleBar,
    // 对齐 Codex：无原生 File/Edit/View 菜单栏
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox true is fine with CJS preload; keep isolation
      sandbox: true,
    },
  });

  // Windows 彻底去掉菜单栏；macOS 仍可保留空应用菜单由系统接管时再扩展
  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  // 外链：禁止应用内开窗/导航（避免 MD 链接 target=_blank 黑屏），改系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      void shell.openExternal(url).catch((err) => {
        console.error("openExternal failed", url, err);
      });
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    // 允许本应用 file:// 页面（含 file://.../index.html#...）
    if (url.startsWith("file:")) {
      try {
        const u = new URL(url);
        const base = path
          .normalize(path.join(__dirname, "../renderer/index.html"))
          .toLowerCase();
        const target = path.normalize(decodeURIComponent(u.pathname)).toLowerCase();
        // Windows: pathname 可能是 /D:/...
        const targetNorm = target.replace(/^\/([a-z]:)/, "$1");
        if (
          targetNorm === base ||
          targetNorm.replace(/\\/g, "/") === base.replace(/\\/g, "/") ||
          target.endsWith(`${path.sep}index.html`.toLowerCase()) ||
          target.endsWith("/index.html")
        ) {
          return;
        }
      } catch {
        /* fall through to block */
      }
      event.preventDefault();
      return;
    }
    if (/^(https?:|mailto:)/i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url).catch((err) => {
        console.error("openExternal failed", url, err);
      });
      return;
    }
    // 其它协议一律挡住，避免壳被导航走
    event.preventDefault();
  });

  mainWindow.webContents.on("preload-error", (_event, preload, err) => {
    console.error("preload-error", preload, err);
  });

  // Close → hide while tray is active (do not destroy)
  mainWindow.on("close", (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

/** Show main window, recreating if destroyed (tray Show / handoff). */
async function showMainWindow(): Promise<BrowserWindow | null> {
  if (!windowAlive()) {
    await createWindow();
  }
  if (!windowAlive()) return null;
  mainWindow!.show();
  mainWindow!.focus();
  return mainWindow;
}

function sendToRenderer(payload: unknown): void {
  void showMainWindow().then((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(HOST_EVENT_CHANNEL, payload);
    }
  });
}

function deliverHandoffPayload(payload: string): void {
  sendToRenderer({
    type: "session.status",
    threadId: "",
    sessionId: "",
    status: "idle",
    activity: `handoff:${payload}`,
  });
}

function updateTray(): void {
  if (!host || !tray) return;
  try {
    const badge = host.shellTrayBadge();
    tray.setToolTip(`Grok Desktop — ${badge.label}`);
    if (process.platform === "darwin") {
      tray.setTitle(badge.badge > 0 ? String(badge.badge) : "");
    }
  } catch {
    /* ignore */
  }
}

function createTray(): void {
  try {
    const appIcon = loadAppIcon();
    const img =
      appIcon && !appIcon.isEmpty()
        ? appIcon.resize({ width: 16, height: 16 })
        : nativeImage.createFromDataURL(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          );
    tray = new Tray(img);
    const menu = Menu.buildFromTemplate([
      {
        label: "Show Grok Desktop",
        click: () => {
          void showMainWindow();
        },
      },
      {
        label: "Command Center",
        click: () => {
          sendToRenderer({
            type: "session.status",
            threadId: "",
            sessionId: "",
            status: "idle",
            activity: "nav:command",
          });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => {
      void showMainWindow();
    });
    updateTray();
    trayTimer = setInterval(updateTray, 5000);
  } catch (err) {
    console.warn("Tray unavailable:", err);
  }
}

app.whenReady().then(async () => {
  const agentPaths = resolveDesktopAgentPaths();
  host = new DesktopHost({
    bundledPath: agentPaths.bundledPath,
    grokPath: agentPaths.grokPath,
  });
  const info = host.grokInfo();
  console.log(
    `[grok-desktop] agent source=${info.source} path=${info.path ?? "(missing)"} version=${info.version ?? "?"}`,
  );
  if (!info.path) {
    console.warn(
      "[grok-desktop] grok binary not found. Place agent-bin/grok.exe or: npm run sync:agent",
    );
  }
  const si = await host.initSingleInstance();
  if (!si.isPrimary) {
    const deep =
      process.argv.find(
        (a) => a.startsWith("grok://") || a.startsWith("grok-desktop://"),
      ) ?? "grok://focus";
    await host.shellNotifyPrimary(deep);
    console.log(
      "Grok Desktop already running; handoff sent, exiting secondary",
    );
    app.quit();
    return;
  }

  // Wire TCP secondary payloads → focus + renderer handoff (FS also written in single-instance)
  // Re-init is not needed; host already has single. We patch via shellNotifyPrimary path.
  // Primary receives FS handoff via poll below; TCP also writes FS in single-instance.ts.

  try {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("grok", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient("grok");
    }
  } catch {
    /* ignore */
  }

  host.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(HOST_EVENT_CHANNEL, event);
      }
    }
    if (
      event.type === "permission.requested" ||
      event.type === "session.status"
    ) {
      updateTray();
    }
  });

  ipcMain.handle(HOST_IPC_CHANNEL, async (_evt, payload: unknown) => {
    try {
      const { method, params } = payload as {
        method: HostIpcMethod;
        params?: unknown;
      };
      return await handleHostIpc(method, params);
    } catch (err) {
      return resultErr(err);
    }
  });

  await createWindow();
  createTray();

  // Consume handoff (FS + TCP-written) periodically
  setInterval(() => {
    if (!host) return;
    const h = host.shellReadHandoff();
    if (h) {
      deliverHandoffPayload(h.payload);
    }
  }, 1000);
});

app.on("window-all-closed", () => {
  // With close-prevent+hide, this rarely fires while tray is active.
  // If it does and tray exists, do not quit — recreate on next Show.
  if (tray && !isQuitting) {
    return;
  }
  void host?.dispose().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (trayTimer) clearInterval(trayTimer);
  tray?.destroy();
  tray = null;
  void host?.dispose();
});

app.on("activate", () => {
  void showMainWindow();
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  void host?.shellNotifyPrimary(url);
  deliverHandoffPayload(url);
});
