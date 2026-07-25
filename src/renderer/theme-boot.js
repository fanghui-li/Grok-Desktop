/**
 * 启动前上色（CSP 下用外链脚本，禁止 inline）。
 * 优先读 localStorage：mode + chrome 快照；system 时跟 OS。
 * 正式 settings 由 renderer boot 后再覆盖。
 * 推导与 derive.ts 对齐的简化版（无 import，boot 独立）。
 */
(function () {
  try {
    var pref = localStorage.getItem("grok-desktop-theme") || "system";
    var dark =
      pref === "dark" ||
      (pref !== "light" &&
        typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    var variant = dark ? "dark" : "light";
    var root = document.documentElement;
    root.dataset.theme = variant;
    root.style.colorScheme = variant;

    var raw = localStorage.getItem("grok-desktop-theme-boot");
    if (!raw) return;
    var snap = JSON.parse(raw);
    if (!snap || snap.variant !== variant) return;
    // 始终应用 chrome 快照（含默认预设），与 applyChromeTheme 一致
    if (!snap.chrome) return;

    var c = snap.chrome;
    if (!c.surface || !c.ink || !c.accent) return;
    root.setAttribute("data-theme-custom", "1");

    var surface = c.surface;
    var ink = c.ink;
    var accent = c.accent;
    var contrast =
      typeof c.contrast === "number" && !isNaN(c.contrast) ? c.contrast : dark ? 56 : 45;
    var baseline = dark ? 60 : 45;
    var linear = contrast / 100 + ((contrast - baseline) / 60) * 0.7;
    var cn;
    if (contrast <= baseline) {
      cn = Math.min(1, Math.max(0, linear));
    } else {
      var base = baseline / 100;
      cn = Math.min(1, Math.max(0, base + (linear - base) * 2));
    }
    // secondary / tertiary：ink 占比 floor（对齐 derive 可读性）
    var text2Pct = Math.round(Math.max(58, Math.min(92, (0.65 + cn * 0.1) * 100)));
    var text3Base = dark ? 0.42 + cn * 0.13 : 0.45 + cn * 0.1;
    var text3Pct = Math.round(Math.max(48, Math.min(80, text3Base * 100)));
    var borderPct = Math.round(Math.max(10, (0.06 + cn * 0.04) * 140));
    var hoverPct = Math.round((dark ? 0.08 : 0.06 + cn * 0.04) * 100);
    var activePct = Math.round((dark ? 0.12 : 0.1 + cn * 0.05) * 100);
    var mutedPct = Math.round((dark ? 0.05 : 0.035 + cn * 0.03) * 100);
    function mix(a, b, p) {
      return "color-mix(in srgb, " + a + " " + p + "%, " + b + ")";
    }

    // chrome shell vs 中间会话卡片（对齐 derive）
    if (dark) {
      var mainPct = Math.round((0.07 + cn * 0.05) * 100);
      root.style.setProperty("--bg", surface);
      root.style.setProperty("--bg-sidebar", surface);
      root.style.setProperty("--bg-main", mix(ink, surface, mainPct));
      root.style.setProperty("--bg-card", mix(ink, surface, mainPct));
      root.style.setProperty("--bg-elevated", mix(ink, surface, mainPct + 4));
    } else {
      // 近白 surface：外壳略灰，主区纯白
      var shellPct = Math.round((0.045 + cn * 0.03) * 100);
      root.style.setProperty("--bg", mix(ink, surface, shellPct));
      root.style.setProperty("--bg-sidebar", mix(ink, surface, shellPct));
      root.style.setProperty("--bg-main", "#ffffff");
      root.style.setProperty("--bg-card", "#ffffff");
      root.style.setProperty("--bg-elevated", "#ffffff");
    }
    root.style.setProperty("--bg-muted", mix(ink, surface, mutedPct));
    root.style.setProperty("--bg-hover", mix(ink, surface, hoverPct));
    root.style.setProperty("--bg-active", mix(ink, surface, activePct));
    root.style.setProperty("--border", mix(ink, surface, borderPct));
    root.style.setProperty("--border-soft", mix(ink, surface, Math.max(8, borderPct - 4)));
    root.style.setProperty("--text", ink);
    root.style.setProperty("--text-2", mix(ink, surface, text2Pct));
    root.style.setProperty("--text-3", mix(ink, surface, text3Pct));
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-contrast", surface);
    root.style.setProperty("--info", accent);
    root.style.setProperty("--file-link", accent);
    if (c.semanticColors) {
      if (c.semanticColors.diffAdded)
        root.style.setProperty("--ok", c.semanticColors.diffAdded);
      if (c.semanticColors.diffRemoved)
        root.style.setProperty("--danger", c.semanticColors.diffRemoved);
      if (c.semanticColors.skill)
        root.style.setProperty("--skill", c.semanticColors.skill);
    }
    if (c.fonts && c.fonts.ui) {
      root.style.setProperty(
        "--font",
        '"' +
          c.fonts.ui +
          '", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      );
    }
    if (c.fonts && c.fonts.code) {
      root.style.setProperty(
        "--font-mono",
        '"' + c.fonts.code + '", ui-monospace, "Cascadia Code", Consolas, monospace',
      );
    }
    if (c.opaqueWindows === false) {
      root.classList.add("theme-translucent-sidebar");
    }
  } catch (e) {
    /* ignore */
  }
})();
