import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HostError } from "../src/shared/errors.js";
import {
  HOST_EVENT_CHANNEL,
  HOST_IPC_CHANNEL,
} from "../src/shared/host-api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("contract audit", () => {
  it("renderer does not spawn grok; uses Host bridge", () => {
    const main = read("src/renderer/main.ts");
    const html = read("src/renderer/index.html");
    expect(main).not.toMatch(/from\s+["']node:child_process["']/);
    expect(main).not.toMatch(/\bspawn\s*\(/);
    expect(main).toMatch(/grokDesktop\.invoke/);
    expect(main).toMatch(/handleDeepLinkPayload/);
  });

  it("UI matches Codex desktop shell structure", () => {
    const html = read("src/renderer/index.html");
    const css = read("src/renderer/styles.css");
    const main = read("src/renderer/main.ts");
    // Three-column codex shell
    expect(html).toMatch(/codex-app/);
    expect(html).toMatch(/新对话/);
    expect(html).toMatch(/项目/);
    expect(html).toMatch(/对话/);
    expect(html).toMatch(/自动化/);
    expect(html).toMatch(/插件/);
    expect(html).toMatch(/设置/);
    expect(html).toMatch(/随心输入/);
    expect(html).toMatch(/完全访问/);
    // 权限 chip 下拉 caret 须独立节点，避免被裁切/丢失
    expect(html).toMatch(/mode-chip-caret/);
    expect(css).toMatch(/\.mode-chip\s*\{[^}]*line-height/s);
    expect(html).toMatch(/打开位置/);
    expect(html).toMatch(/文件/);
    expect(html).toMatch(/浏览器/);
    expect(html).toMatch(/终端/);
    // Light theme
    expect(css).toMatch(/#ffffff|#fff|f5f5f5/i);
    // Project → thread interactions
    expect(main).toMatch(/startNewChat/);
    expect(main).toMatch(/refreshProjectsAndThreads/);
    // Project path from native folder picker, not free-text only
    expect(main).toMatch(/system\.pickDirectory/);
    expect(main).toMatch(/pickAndAddProject/);
  });

  it("preload is CJS for Electron bridge", () => {
    const preload = read("src/main/preload.cjs");
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld/);
    expect(preload).toMatch(/require\(["']electron["']\)/);
    const main = read("src/main/index.ts");
    expect(main).toMatch(/preload\.cjs/);
  });

  it("main shell tray lifecycle helpers exist", () => {
    const main = read("src/main/index.ts");
    expect(main).toMatch(/e\.preventDefault\(\)/);
    expect(main).toMatch(/showMainWindow/);
    expect(main).toMatch(/isQuitting/);
  });

  it("Host API product vocabulary and errors", () => {
    const host = read("src/host/host.ts");
    expect(host).toMatch(/threadsCreate/);
    expect(host).toMatch(/projectsList/);
    expect(host).not.toMatch(/mvpSession/i);
    const err = new HostError("SESSION_BUSY", "busy");
    expect(err.toJSON().code).toBe("SESSION_BUSY");
  });

  it("IPC channel constants are stable", () => {
    expect(HOST_IPC_CHANNEL).toBe("grok-desktop-host");
    expect(HOST_EVENT_CHANNEL).toBe("grok-desktop-host-event");
  });
});
