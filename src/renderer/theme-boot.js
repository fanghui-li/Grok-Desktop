/**
 * 启动前上色（CSP 下用外链脚本，禁止 inline）。
 * 优先读 localStorage：mode + chrome 快照；system 时跟 OS。
 * 正式 settings 由 renderer boot 后再覆盖。
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
    if (snap.isDefault || !snap.chrome) return;

    var c = snap.chrome;
    if (!c.surface || !c.ink || !c.accent) return;
    root.setAttribute("data-theme-custom", "1");
    var ink = c.ink;
    var surface = c.surface;
    var accent = c.accent;
    function mix(a, b, p) {
      return "color-mix(in srgb, " + a + " " + p + "%, " + b + ")";
    }
    root.style.setProperty("--bg", surface);
    root.style.setProperty("--bg-main", surface);
    root.style.setProperty("--bg-card", surface);
    root.style.setProperty("--bg-sidebar", mix(ink, surface, 5));
    root.style.setProperty("--bg-elevated", mix(ink, surface, 6));
    root.style.setProperty("--bg-muted", mix(ink, surface, 8));
    root.style.setProperty("--bg-hover", mix(ink, surface, 10));
    root.style.setProperty("--bg-active", mix(ink, surface, 12));
    root.style.setProperty("--border", mix(ink, surface, 14));
    root.style.setProperty("--border-soft", mix(ink, surface, 10));
    root.style.setProperty("--text", ink);
    root.style.setProperty("--text-2", mix(ink, surface, 38));
    root.style.setProperty("--text-3", mix(ink, surface, 22));
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-contrast", surface);
    if (c.semanticColors) {
      if (c.semanticColors.diffAdded)
        root.style.setProperty("--ok", c.semanticColors.diffAdded);
      if (c.semanticColors.diffRemoved)
        root.style.setProperty("--danger", c.semanticColors.diffRemoved);
    }
    if (c.fonts && c.fonts.ui) {
      root.style.setProperty(
        "--font",
        '"' +
          c.fonts.ui +
          '", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      );
    }
    if (c.opaqueWindows === false) {
      root.classList.add("theme-translucent-sidebar");
    }
  } catch (e) {
    /* ignore */
  }
})();
