/**
 * Electron preload — 唯一 preload 源文件（勿再维护 preload.ts）。
 * package.json 为 "type": "module" 时必须使用 CommonJS；
 * ESM preload 会静默失败 → renderer 显示 "Host bridge 不可用"。
 * 构建：scripts/copy-static.mjs 复制到 dist/main/preload.cjs。
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const HOST_IPC_CHANNEL = "grok-desktop-host";
const HOST_EVENT_CHANNEL = "grok-desktop-host-event";

contextBridge.exposeInMainWorld("grokDesktop", {
  invoke(method, params) {
    return ipcRenderer.invoke(HOST_IPC_CHANNEL, { method, params });
  },
  onEvent(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(HOST_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(HOST_EVENT_CHANNEL, listener);
  },
  /**
   * Electron 32+：渲染进程 File 不再暴露 .path；拖放/粘贴取本地绝对路径必须走这里。
   * @param {File} file
   * @returns {string}
   */
  getPathForFile(file) {
    try {
      if (!file) return "";
      const p = webUtils.getPathForFile(file);
      return typeof p === "string" ? p : "";
    } catch {
      return "";
    }
  },
});
