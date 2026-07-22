/**
 * 用 Electron 将 assets/icon.svg 栅格化为 icon.png / icon-32.png（窗口与托盘）。
 * 用法：npx electron scripts/gen-app-icon.mjs
 *
 * SVG 自带白底圆角；捕获使用不透明白底，避免透明 PNG 在深色任务栏/托盘上「看不见」。
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svgPath = path.join(root, "assets", "icon.svg");
const outPng = path.join(root, "assets", "icon.png");
const outPng32 = path.join(root, "assets", "icon-32.png");

// macOS electron-builder 要求 icon 至少 512x512；Win/托盘另用 32。
const sizes = [
  { size: 512, out: outPng },
  { size: 32, out: outPng32 },
];

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, "utf8");
  for (const { size, out } of sizes) {
    const win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      frame: false,
      // 不透明：保证输出无 alpha 黑洞
      transparent: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
      },
    });
    const html = `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden}
      svg{width:${size}px;height:${size}px;display:block}
    </style></head><body>${svg}</body></html>`;
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    await new Promise((r) => setTimeout(r, 150));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(out, image.toPNG());
    win.destroy();
    console.log("wrote", out);
  }
  app.quit();
});

app.on("window-all-closed", (e) => e.preventDefault());
