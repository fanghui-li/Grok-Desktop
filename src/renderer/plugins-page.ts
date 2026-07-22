/**
 * Codex / CLI 对齐的扩展中心：插件 · 市场 · 技能 · MCP
 * Host 经 grok plugin|mcp|inspect 同源操作。
 */
import type { HostIpcMethod } from "../shared/host-api.js";
import { tr } from "../shared/i18n/index.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export interface PluginsPageCallbacks {
  inv: Inv;
  esc: (s: string) => string;
  getSelectedProjectPath?: () => string | undefined;
  onUseSkill: (name: string) => void;
  onOpenPath: (path: string) => void;
  onToast?: (msg: string) => void;
  /** 关闭插件页后恢复主界面焦点 */
  onClosed?: () => void;
}

type TabId = "plugins" | "market" | "skills" | "mcp";
/** user | project | 或市场源 name */
type ScopeFilter = string;

type SkillRow = {
  name: string;
  path: string;
  description?: string;
  scope: string;
  category?: string;
  sourceType?: string;
};

type PluginRow = {
  name: string;
  path: string;
  description?: string;
  scope?: string;
  enabled?: boolean;
  status?: string;
  marketplace?: string;
  version?: string;
  components?: {
    skills: number;
    agents: number;
    hooks: boolean;
    mcpServers: number;
    commands?: number;
  };
};

type McpRow = {
  name: string;
  status: string;
  transport?: string;
  command?: string;
  url?: string;
};

type MarketSrc = {
  name: string;
  kind?: string;
  url: string;
  branch?: string;
};

const ICON_PALETTE = [
  { bg: "#e8f0fe", fg: "#1a73e8" },
  { bg: "#fce8e6", fg: "#d93025" },
  { bg: "#e6f4ea", fg: "#137333" },
  { bg: "#fef7e0", fg: "#b06000" },
  { bg: "#f3e8fd", fg: "#7b1fa2" },
  { bg: "#e0f7fa", fg: "#00838f" },
  { bg: "#fff3e0", fg: "#ef6c00" },
  { bg: "#fce4ec", fg: "#c2185b" },
];

/**
 * 市场 JSON 无 icon 字段；用 Simple Icons 按插件名猜品牌图。
 * 键：插件 name 小写；值：simpleicons slug（或 null 表示强制首字母）。
 */
const PLUGIN_ICON_SLUGS: Record<string, string> = {
  vercel: "vercel",
  sentry: "sentry",
  cloudflare: "cloudflare",
  mongodb: "mongodb",
  github: "github",
  gitlab: "gitlab",
  linear: "linear",
  notion: "notion",
  slack: "slack",
  discord: "discord",
  telegram: "telegram",
  firebase: "firebase",
  playwright: "playwright",
  terraform: "terraform",
  docker: "docker",
  kubernetes: "kubernetes",
  aws: "amazonaws",
  azure: "microsoftazure",
  gcp: "googlecloud",
  stripe: "stripe",
  supabase: "supabase",
  prisma: "prisma",
  redis: "redis",
  postgresql: "postgresql",
  mysql: "mysql",
  elasticsearch: "elasticsearch",
  datadog: "datadog",
  grafana: "grafana",
  prometheus: "prometheus",
  openai: "openai",
  anthropic: "anthropic",
  huggingface: "huggingface",
  figma: "figma",
  jira: "jira",
  asana: "asana",
  "chrome-devtools": "googlechrome",
  superpowers: "lightning",
};

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function simpleIconSlug(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (PLUGIN_ICON_SLUGS[key]) return PLUGIN_ICON_SLUGS[key];
  // 启发式：去掉常见后缀后尝试
  const base = key
    .replace(/-plugin$/i, "")
    .replace(/-mcp$/i, "")
    .replace(/_plugin$/i, "");
  if (PLUGIN_ICON_SLUGS[base]) return PLUGIN_ICON_SLUGS[base];
  // 纯字母数字短名直接试 simpleicons
  if (/^[a-z][a-z0-9-]{1,32}$/.test(base) && !base.includes("--")) {
    return base;
  }
  return null;
}

function avatarHtml(
  name: string,
  esc: (s: string) => string,
  opts?: { forceLetter?: boolean },
): string {
  const pal = ICON_PALETTE[hashHue(name) % ICON_PALETTE.length];
  const letter = (name[0] || "?").toUpperCase();
  const slug = opts?.forceLetter ? null : simpleIconSlug(name);
  if (!slug) {
    return `<div class="plugins-card-icon" style="background:${pal.bg};color:${pal.fg}" aria-hidden="true">${esc(letter)}</div>`;
  }
  // 字母垫底；图加载成功后盖住；失败则保留字母（由 bindIconFallbacks 隐藏 img）
  const src = `https://cdn.simpleicons.org/${encodeURIComponent(slug)}`;
  return `<div class="plugins-card-icon plugins-card-icon-brand" style="background:${pal.bg};color:${pal.fg}" aria-hidden="true">
    <span class="plugins-card-icon-letter">${esc(letter)}</span>
    <img class="plugins-card-icon-img" src="${esc(src)}" alt="" draggable="false" data-icon-slug="${esc(slug)}" />
  </div>`;
}

function scopeLabel(scope?: string): string {
  if (scope === "project") return tr("plug.scope.project");
  if (scope === "user") return tr("plug.scope.user");
  return tr("plug.scope.local");
}

function statusLabel(p: PluginRow): string {
  const s = (p.status || "").toLowerCase();
  if (s === "available") return tr("plug.status.available");
  if (s === "disabled" || p.enabled === false) return tr("plug.status.disabled");
  if (s === "discovered") return tr("plug.status.discovered");
  if (s === "installed" || p.enabled) return tr("plug.status.installed");
  return s || tr("plug.status.installed");
}

export class PluginsPageController {
  private open = false;
  private tab: TabId = "plugins";
  private scope: ScopeFilter = "user";
  private query = "";
  private skills: SkillRow[] = [];
  private plugins: PluginRow[] = [];
  private available: PluginRow[] = [];
  private mcp: McpRow[] = [];
  private markets: MarketSrc[] = [];
  private bound = false;
  private busy = false;
  private detailText = "";
  private detailName = "";

  constructor(private readonly cb: PluginsPageCallbacks) {}

  isOpen(): boolean {
    return this.open;
  }

  /** 语言切换后刷新标题/占位/列表文案（须在插件页打开时） */
  refreshLocale(): void {
    if (!this.open) return;
    this.syncChrome();
    this.renderBody();
  }

  async show(tab?: TabId): Promise<void> {
    this.open = true;
    if (tab) this.tab = tab;
    document.getElementById("plugins-page")?.classList.remove("hidden");
    const app = document.getElementById("app");
    app?.classList.add("plugins-open");
    app?.setAttribute("aria-hidden", "true");
    if (app && "inert" in app) {
      (app as HTMLElement & { inert: boolean }).inert = true;
    }
    this.bindShell();
    this.syncChrome();
    this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(tr("plug.loading"))}</div>`);
    await this.reload();
    this.renderBody();
    requestAnimationFrame(() => {
      (document.getElementById("plugins-search") as HTMLInputElement | null)?.focus();
    });
  }

  hide(): void {
    this.open = false;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && document.getElementById("plugins-page")?.contains(ae)) {
      ae.blur();
    }
    document.getElementById("plugins-page")?.classList.add("hidden");
    const app = document.getElementById("app");
    app?.classList.remove("plugins-open");
    app?.removeAttribute("aria-hidden");
    if (app && "inert" in app) {
      (app as HTMLElement & { inert: boolean }).inert = false;
    }
    this.cb.onClosed?.();
  }

  private async createSkillDraft(): Promise<void> {
    const nameEl = document.getElementById("skill-create-name") as HTMLInputElement | null;
    let name = nameEl?.value.trim() || "";
    if (!name) {
      // footer 快捷入口：无输入框时用 prompt
      name = window.prompt(tr("plug.createSkillHint"), "")?.trim() || "";
    }
    if (!name) {
      this.toast(tr("plug.createSkillEmpty"));
      return;
    }
    const scope = this.scope === "project" ? "project" : "user";
    const projectPath =
      scope === "project" ? this.cb.getSelectedProjectPath?.() : undefined;
    if (scope === "project" && !projectPath) {
      this.toast(tr("at.needProject"));
      return;
    }
    this.busy = true;
    const res = await this.cb.inv<{ name: string; path: string }>("skills.createDraft", {
      name,
      scope,
      projectPath,
    });
    this.busy = false;
    if (!res.ok || !res.data) {
      this.toast(res.error?.message || tr("plug.createSkillFail"));
      return;
    }
    this.toast(tr("plug.createSkillOk", { name: res.data.name }));
    if (nameEl) nameEl.value = "";
    // 打开草稿编辑
    await this.cb.inv("skills.openPath", { path: res.data.path });
    await this.reload();
    this.renderBody();
  }

  private toast(msg: string): void {
    this.cb.onToast?.(msg);
  }

  private bindShell(): void {
    if (this.bound) return;
    this.bound = true;

    document.getElementById("btn-plugins-back")?.addEventListener("click", () => {
      this.hide();
    });

    document.addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.detailName) {
          this.detailName = "";
          this.detailText = "";
          this.renderBody();
          return;
        }
        this.hide();
      }
    });

    const page = document.getElementById("plugins-page");
    page?.addEventListener("click", (e) => {
      if (!this.open) return;
      const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
      if (!t) return;
      void this.onAction(t);
    });

    document.getElementById("plugins-search")?.addEventListener("input", (e) => {
      this.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderBody();
    });
  }

  private async onAction(t: HTMLElement): Promise<void> {
    const action = t.dataset.action;
    if (!action) return;

    if (action === "tab") {
      const id = t.dataset.tab as TabId;
      if (id === "plugins" || id === "market" || id === "skills" || id === "mcp") {
        this.tab = id;
        this.detailName = "";
        if (id === "market") {
          this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(tr("plug.loadingMarket"))}</div>`);
          if (!this.markets.length || !this.available.length) {
            await this.reload(true);
          }
          // 默认第一个市场源
          this.scope = this.markets[0]?.name || "user";
        } else {
          this.scope = "user";
        }
        this.syncChrome();
        this.renderBody();
      }
      return;
    }

    if (action === "scope") {
      const next = t.dataset.scope || "all";
      if (next === this.scope) return;
      this.scope = next;
      // 只刷新 chip 高亮与列表，避免整页 chrome 重绘导致“点不动/不切换”的错觉
      this.syncChipActive();
      this.renderBody();
      return;
    }

    if (action === "install-custom") {
      const src = (
        document.getElementById("plugin-install-source") as HTMLInputElement | null
      )?.value.trim();
      if (!src) {
        this.toast(tr("plug.needSource"));
        return;
      }
      await this.runMut(
        "plugins.install",
        { source: src, trust: true },
        tr("plug.installing", { src }),
      );
      return;
    }

    if (action === "use-skill" && t.dataset.name) {
      this.cb.onUseSkill(t.dataset.name);
      this.hide();
      return;
    }

    if (action === "open-path" && t.dataset.path) {
      this.cb.onOpenPath(t.dataset.path);
      return;
    }

    if (action === "close-detail") {
      this.detailName = "";
      this.detailText = "";
      this.renderBody();
      return;
    }

    if (this.busy) return;

    if (action === "install" && t.dataset.name) {
      await this.runMut("plugins.install", {
        source: t.dataset.source || t.dataset.name,
        trust: true,
      }, tr("plug.installingName", { name: t.dataset.name ?? "" }));
      return;
    }
    if (action === "uninstall" && t.dataset.name) {
      if (!confirm(tr("plug.confirmUninstall", { name: t.dataset.name ?? "" }))) return;
      await this.runMut("plugins.uninstall", { name: t.dataset.name, confirm: true }, tr("plug.uninstalling"));
      return;
    }
    if (action === "enable" && t.dataset.name) {
      await this.runMut("plugins.enable", { name: t.dataset.name }, tr("plug.enabling"));
      return;
    }
    if (action === "disable" && t.dataset.name) {
      await this.runMut("plugins.disable", { name: t.dataset.name }, tr("plug.disabling"));
      return;
    }
    if (action === "update-plugin" && t.dataset.name) {
      await this.runMut("plugins.update", { name: t.dataset.name }, tr("plug.updating"));
      return;
    }
    if (action === "details" && t.dataset.name) {
      this.busy = true;
      this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(tr("plug.loadingDetail"))}</div>`);
      const res = await this.cb.inv<{ name: string; text: string }>("plugins.details", {
        name: t.dataset.name,
      });
      this.busy = false;
      if (!res.ok) {
        this.toast(res.error?.message || tr("plug.detailFail"));
        this.renderBody();
        return;
      }
      this.detailName = t.dataset.name;
      this.detailText = res.data?.text || tr("plug.noDetail");
      this.renderBody();
      return;
    }

    if (action === "mcp-remove" && t.dataset.name) {
      if (!confirm(tr("plug.confirmMcpRemove", { name: t.dataset.name ?? "" }))) return;
      await this.runMut(
        "mcp.remove",
        {
          name: t.dataset.name,
          cwd: this.cb.getSelectedProjectPath?.(),
        },
        tr("plug.removingMcp"),
      );
      return;
    }
    if (action === "mcp-doctor") {
      this.busy = true;
      this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(tr("plug.loadingDoctor"))}</div>`);
      const res = await this.cb.inv<{ text: string; json?: unknown }>("mcp.doctor", {
        name: t.dataset.name || undefined,
      });
      this.busy = false;
      if (!res.ok) {
        this.toast(res.error?.message || tr("plug.doctorFail"));
        this.renderBody();
        return;
      }
      this.detailName = t.dataset.name ? `MCP · ${t.dataset.name}` : "MCP doctor";
      this.detailText =
        res.data?.text ||
        (res.data?.json ? JSON.stringify(res.data.json, null, 2) : tr("plug.noOutput"));
      this.renderBody();
      return;
    }
    if (action === "mcp-add-submit") {
      await this.submitMcpAdd();
      return;
    }

    if (action === "market-add-submit") {
      await this.submitMarketAdd();
      return;
    }
    if (action === "market-remove" && t.dataset.url) {
      if (
        !confirm(
          tr("plug.confirmMarketRemove", { url: t.dataset.url }),
        )
      ) {
        return;
      }
      await this.runMut(
        "plugins.marketplace.remove",
        { url: t.dataset.url },
        tr("plug.removingMarket"),
      );
      return;
    }
    if (action === "market-refresh") {
      await this.runMut(
        "plugins.marketplace.update",
        { name: t.dataset.name || undefined },
        tr("plug.refreshingMarket"),
      );
      return;
    }

    if (action === "open-mcp-config") {
      const cfg = await this.cb.inv<{ paths?: { configToml?: string } }>("config.get");
      const p = cfg.data?.paths?.configToml;
      if (p) this.cb.onOpenPath(p);
      return;
    }
    if (action === "create-skill" || action === "create-skill-submit") {
      await this.createSkillDraft();
      return;
    }
    if (action === "open-skill" && t.dataset.path) {
      const res = await this.cb.inv<{ opened: boolean; path: string }>("skills.openPath", {
        path: t.dataset.path,
      });
      if (!res.ok) {
        this.toast(res.error?.message || tr("plug.createSkillFail"));
        return;
      }
      this.toast(res.data?.path || t.dataset.path);
      return;
    }
    if (action === "open-skills-dir" || action === "open-plugins-dir") {
      const cfg = await this.cb.inv<{ paths?: { grokHome?: string } }>("config.get");
      const home = cfg.data?.paths?.grokHome;
      if (!home) return;
      const sep = home.includes("\\") ? "\\" : "/";
      const sub = action === "open-skills-dir" ? "skills" : "plugins";
      this.cb.onOpenPath(`${home}${sep}${sub}`);
      return;
    }
    if (action === "reload") {
      this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(tr("plug.loadingRefresh"))}</div>`);
      await this.reload(true);
      this.renderBody();
      return;
    }
  }

  private async runMut(
    method: HostIpcMethod,
    params: unknown,
    loading: string,
  ): Promise<void> {
    this.busy = true;
    this.setSectionsHtml(`<div class="plugins-loading">${this.cb.esc(loading)}</div>`);
    const res = await this.cb.inv<{ message?: string }>(method, params);
    this.busy = false;
    if (!res.ok) {
      this.toast(res.error?.message || tr("plug.opFail"));
      this.renderBody();
      return;
    }
    this.toast(res.data?.message || tr("plug.done"));
    await this.reload(true);
    this.renderBody();
  }

  private async submitMcpAdd(): Promise<void> {
    const name = (document.getElementById("mcp-add-name") as HTMLInputElement | null)?.value.trim();
    const transport =
      (document.getElementById("mcp-add-transport") as HTMLSelectElement | null)?.value ||
      "stdio";
    const cmd = (
      document.getElementById("mcp-add-cmd") as HTMLInputElement | null
    )?.value.trim();
    if (!name || !cmd) {
      this.toast(tr("plug.needMcpFields"));
      return;
    }
    const args =
      transport === "stdio"
        ? (
            (document.getElementById("mcp-add-args") as HTMLInputElement | null)?.value || ""
          )
            .trim()
            .split(/\s+/)
            .filter(Boolean)
        : undefined;
    await this.runMut(
      "mcp.add",
      {
        name,
        commandOrUrl: cmd,
        args,
        transport: transport as "stdio" | "http" | "sse",
        scope: "user",
        cwd: this.cb.getSelectedProjectPath?.(),
      },
      tr("plug.addingMcp"),
    );
  }

  private async submitMarketAdd(): Promise<void> {
    const url = (
      document.getElementById("market-add-url") as HTMLInputElement | null
    )?.value.trim();
    if (!url) {
      this.toast(tr("plug.needMarketUrl"));
      return;
    }
    await this.runMut("plugins.marketplace.add", { url }, tr("plug.addingMarket"));
  }

  private async reload(forceAvailable = false): Promise<void> {
    const path0 = this.cb.getSelectedProjectPath?.();
    const [skills, plugins, mcp, markets] = await Promise.all([
      this.cb.inv<SkillRow[]>("skills.list", { projectPath: path0 }),
      this.cb.inv<PluginRow[]>("plugins.list", { projectPath: path0 }),
      this.cb.inv<McpRow[]>("mcp.list"),
      this.cb.inv<MarketSrc[]>("plugins.marketplace.list").catch(() => ({
        ok: false as const,
        data: [] as MarketSrc[],
      })),
    ]);
    this.skills = skills.data ?? [];
    this.plugins = plugins.data ?? [];
    this.mcp = mcp.data ?? [];
    this.markets = markets.ok ? (markets.data ?? []) : [];
    if (forceAvailable || this.tab === "market") {
      await this.reloadAvailable();
    }
    // 市场 Tab：scope 必须落在某个源上，默认第一个
    if (this.tab === "market" && this.markets.length) {
      if (!this.markets.some((m) => m.name === this.scope)) {
        this.scope = this.markets[0].name;
      }
    }
  }

  private async reloadAvailable(): Promise<void> {
    const path0 = this.cb.getSelectedProjectPath?.();
    const res = await this.cb.inv<PluginRow[]>("plugins.list", {
      projectPath: path0,
      available: true,
    });
    if (res.ok) {
      this.available = (res.data ?? []).filter(
        (p) => (p.status || "").toLowerCase() === "available",
      );
    }
  }

  private syncChrome(): void {
    for (const btn of Array.from(
      document.querySelectorAll<HTMLElement>("#plugins-page [data-action=tab]"),
    )) {
      const on = btn.dataset.tab === this.tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }

    const title = document.getElementById("plugins-title");
    const search = document.getElementById("plugins-search") as HTMLInputElement | null;
    const chips =
      document.getElementById("plugins-chips") ||
      document.querySelector<HTMLElement>("#plugins-page .plugins-chips");
    const footer = document.getElementById("plugins-footer");

    if (this.tab === "plugins") {
      if (title) title.textContent = tr("plug.titlePlugins");
      if (search) search.placeholder = tr("plug.searchPlugins");
      if (chips) {
        chips.classList.remove("hidden");
        chips.innerHTML = `
          ${this.chip("user", tr("plug.scope.user"))}
          ${this.chip("project", tr("plug.scope.project"))}`;
      }
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="plugins-link-btn" data-action="reload">${this.cb.esc(tr("plug.refresh"))}</button>
          <button type="button" class="plugins-link-btn" data-action="open-plugins-dir">${this.cb.esc(tr("plug.openPluginsDir"))}</button>`;
      }
    } else if (this.tab === "market") {
      if (title) title.textContent = tr("plug.titleMarket");
      // 默认 / 校正为第一个市场源
      if (this.markets.length && !this.markets.some((m) => m.name === this.scope)) {
        this.scope = this.markets[0].name;
      }
      if (search) search.placeholder = tr("plug.searchMarket");
      if (chips) {
        chips.classList.remove("hidden");
        chips.innerHTML = this.markets
          .map(
            (m) =>
              `<button type="button" class="plugins-chip${this.scope === m.name ? " active" : ""}" data-action="scope" data-scope="${this.cb.esc(m.name)}" role="tab" aria-selected="${this.scope === m.name ? "true" : "false"}">${this.cb.esc(m.name)}</button>`,
          )
          .join("");
      }
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="plugins-link-btn" data-action="reload">${this.cb.esc(tr("plug.refreshCatalog"))}</button>
          <button type="button" class="plugins-link-btn" data-action="market-refresh">${this.cb.esc(tr("plug.updateAllSources"))}</button>`;
      }
    } else if (this.tab === "mcp") {
      if (title) title.textContent = tr("plug.titleMcp");
      if (search) search.placeholder = tr("plug.searchMcp");
      if (chips) {
        chips.classList.add("hidden");
        chips.innerHTML = "";
      }
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="plugins-link-btn" data-action="reload">${this.cb.esc(tr("plug.refresh"))}</button>
          <button type="button" class="plugins-link-btn" data-action="open-mcp-config">${this.cb.esc(tr("plug.editMcpConfig"))}</button>
          <button type="button" class="plugins-link-btn" data-action="mcp-doctor">${this.cb.esc(tr("plug.mcpDoctor"))}</button>`;
      }
    } else {
      if (title) title.textContent = tr("plug.titleSkills");
      if (search) search.placeholder = tr("plug.searchSkills");
      if (chips) {
        chips.classList.remove("hidden");
        chips.innerHTML = `
          ${this.chip("user", tr("plug.scope.user"))}
          ${this.chip("project", tr("plug.scope.project"))}`;
      }
      if (footer) {
        footer.innerHTML = `
          <button type="button" class="plugins-link-btn" data-action="create-skill">${this.cb.esc(tr("plug.createSkill"))}</button>
          <button type="button" class="plugins-link-btn" data-action="reload">${this.cb.esc(tr("plug.refresh"))}</button>
          <button type="button" class="plugins-link-btn" data-action="open-skills-dir">${this.cb.esc(tr("plug.openSkillsDir"))}</button>`;
      }
    }

    this.syncChipActive();
  }

  /** 高亮当前 scope chip（兼容 id 或 class 选择器） */
  private syncChipActive(): void {
    const root =
      document.getElementById("plugins-chips") ||
      document.querySelector<HTMLElement>("#plugins-page .plugins-chips");
    if (!root) return;
    for (const btn of Array.from(
      root.querySelectorAll<HTMLElement>("[data-action=scope]"),
    )) {
      const on = btn.dataset.scope === this.scope;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  private chip(id: string, label: string): string {
    return `<button type="button" class="plugins-chip${this.scope === id ? " active" : ""}" data-action="scope" data-scope="${this.cb.esc(id)}" role="tab" aria-selected="${this.scope === id ? "true" : "false"}">${this.cb.esc(label)}</button>`;
  }

  private setSectionsHtml(html: string): void {
    const root = document.getElementById("plugins-sections");
    if (root) {
      root.innerHTML = html;
      this.bindIconFallbacks(root);
    }
  }

  /** Simple Icons 404 时隐藏 img，露出首字母垫底 */
  private bindIconFallbacks(root: HTMLElement): void {
    for (const img of Array.from(
      root.querySelectorAll<HTMLImageElement>("img.plugins-card-icon-img"),
    )) {
      const applyFail = () => {
        img.classList.add("is-failed");
        img.parentElement?.classList.add("icon-fallback");
      };
      img.addEventListener("error", applyFail, { once: true });
      img.addEventListener(
        "load",
        () => {
          img.classList.add("is-loaded");
          img.parentElement?.classList.add("icon-loaded");
        },
        { once: true },
      );
      // 已缓存失败/完成
      if (img.complete && img.naturalWidth === 0) applyFail();
      else if (img.complete && img.naturalWidth > 0) {
        img.classList.add("is-loaded");
        img.parentElement?.classList.add("icon-loaded");
      }
    }
  }

  private renderBody(): void {
    if (this.detailName) {
      this.setSectionsHtml(`
        <div class="plugins-detail">
          <div class="plugins-detail-bar">
            <strong>${this.cb.esc(this.detailName)}</strong>
            <button type="button" class="plugins-card-btn" data-action="close-detail">${this.cb.esc(tr("plug.close"))}</button>
          </div>
          <pre class="plugins-detail-pre">${this.cb.esc(this.detailText)}</pre>
        </div>`);
      return;
    }
    if (this.tab === "skills") this.setSectionsHtml(this.skillsSections());
    else if (this.tab === "market") this.setSectionsHtml(this.marketSections());
    else if (this.tab === "mcp") this.setSectionsHtml(this.mcpSections());
    else this.setSectionsHtml(this.pluginsSections());
  }

  private matchQuery(hay: string): boolean {
    if (!this.query) return true;
    return hay.toLowerCase().includes(this.query);
  }

  private scopeOkPlugin(p: PluginRow): boolean {
    // 无 scope / unknown 归为个人
    if (this.scope === "user") {
      return p.scope !== "project";
    }
    if (this.scope === "project") return p.scope === "project";
    // marketplace name chip on market tab handled separately
    return true;
  }

  private skillsSections(): string {
    const list = this.skills.filter(
      (s) =>
        this.scopeOkSkill(s) &&
        this.matchQuery(
          `${s.name} ${s.description ?? ""} ${s.category ?? ""} ${s.sourceType ?? ""}`,
        ),
    );
    const createForm = `<section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.createSkillTitle"))}</h2>
      <div class="plugins-form-row">
        <input id="skill-create-name" class="plugins-input" placeholder="${this.cb.esc(tr("plug.createSkillPh"))}" />
        <button type="button" class="plugins-card-btn primary" data-action="create-skill-submit">${this.cb.esc(tr("plug.createSkill"))}</button>
      </div>
      <p class="plugins-form-hint">${this.cb.esc(tr("plug.createSkillHint"))} · scope=${this.cb.esc(this.scope === "project" ? "project" : "user")}</p>
    </section>`;
    if (!list.length) {
      return createForm + `<div class="plugins-empty">${this.cb.esc(tr("plug.noSkills"))}</div>`;
    }
    const groups = new Map<string, SkillRow[]>();
    for (const s of list) {
      const g =
        s.category?.trim() ||
        s.sourceType ||
        (s.scope === "project" ? tr("plug.skillsProject") : tr("plug.skillsUser"));
      const arr = groups.get(g) ?? [];
      arr.push(s);
      groups.set(g, arr);
    }
    let html = createForm;
    for (const [g, items] of groups) {
      html += `<section class="plugins-section">
        <h2 class="plugins-section-title">${this.cb.esc(g)} · ${items.length}</h2>
        <div class="plugins-grid">
          ${items.map((s) => this.skillCard(s)).join("")}
        </div>
      </section>`;
    }
    return html;
  }

  private scopeOkSkill(s: SkillRow): boolean {
    if (this.scope === "all") return true;
    if (this.scope === "user") return s.scope !== "project";
    if (this.scope === "project") return s.scope === "project";
    return true;
  }

  private pluginsSections(): string {
    const plugs = this.plugins.filter(
      (p) =>
        this.scopeOkPlugin(p) &&
        this.matchQuery(
          `${p.name} ${p.description ?? ""} ${p.path} ${p.marketplace ?? ""}`,
        ),
    );

    let html = "";
    html += `<section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.installSection"))}</h2>
      <div class="plugins-form-row">
        <input id="plugin-install-source" class="plugins-input" placeholder="${this.cb.esc(tr("plug.installPh"))}" />
        <button type="button" class="plugins-card-btn primary" data-action="install-custom" id="btn-plugin-install">${this.cb.esc(tr("plug.install"))}</button>
      </div>
      <p class="plugins-form-hint">${this.cb.esc(tr("plug.installHint"))}</p>
    </section>`;

    if (plugs.length) {
      html += `<section class="plugins-section">
        <h2 class="plugins-section-title">${this.cb.esc(tr("plug.listTitle", { n: plugs.length }))}</h2>
        <div class="plugins-grid">
          ${plugs.map((p) => this.pluginCard(p, false)).join("")}
        </div>
      </section>`;
    } else {
      html += `<div class="plugins-empty">${this.cb.esc(tr("plug.noPlugins"))}</div>`;
    }

    return html;
  }

  private mcpSections(): string {
    const mcps = this.mcp.filter((m) =>
      this.matchQuery(
        `${m.name} ${m.status} ${m.transport ?? ""} ${m.command ?? ""} ${m.url ?? ""}`,
      ),
    );
    return `<section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.addMcp"))}</h2>
      <div class="plugins-form-card">
        <div class="plugins-form-grid">
          <input id="mcp-add-name" class="plugins-input" placeholder="${this.cb.esc(tr("plug.mcpName"))}" />
          <select id="mcp-add-transport" class="plugins-input">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
          <input id="mcp-add-cmd" class="plugins-input" placeholder="${this.cb.esc(tr("plug.mcpCmd"))}" />
          <input id="mcp-add-args" class="plugins-input" placeholder="${this.cb.esc(tr("plug.mcpArgs"))}" />
        </div>
        <button type="button" class="plugins-card-btn primary" data-action="mcp-add-submit">${this.cb.esc(tr("plug.mcpAddBtn"))}</button>
      </div>
      <p class="plugins-form-hint">${this.cb.esc(tr("plug.mcpHint"))}</p>
    </section>
    <section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.mcpConfigured", { n: mcps.length }))}</h2>
      ${
        mcps.length
          ? `<div class="plugins-grid">${mcps.map((m) => this.mcpCard(m)).join("")}</div>`
          : `<div class="plugins-empty">${this.cb.esc(tr("plug.noMcp"))}</div>`
      }
    </section>`;
  }

  private marketSections(): string {
    let html = `<section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.marketSources", { n: this.markets.length }))}</h2>
      <div class="plugins-form-row">
        <input id="market-add-url" class="plugins-input" placeholder="${this.cb.esc(tr("plug.marketUrlPh"))}" />
        <button type="button" class="plugins-card-btn primary" data-action="market-add-submit">${this.cb.esc(tr("plug.addSource"))}</button>
      </div>
      <div class="plugins-grid" style="margin-top:12px">
        ${
          this.markets.length
            ? this.markets.map((m) => this.marketSrcCard(m)).join("")
            : `<div class="plugins-empty">${this.cb.esc(tr("plug.noMarketSrc"))}</div>`
        }
      </div>
    </section>`;

    // 始终按当前市场源筛选（默认第一个，不再显示「全部」）
    const marketName =
      this.markets.find((m) => m.name === this.scope)?.name ||
      this.markets[0]?.name ||
      "";
    let list = this.available.filter((p) =>
      marketName ? p.marketplace === marketName : false,
    );
    list = list.filter((p) =>
      this.matchQuery(
        `${p.name} ${p.description ?? ""} ${p.marketplace ?? ""}`,
      ),
    );

    // cap display for performance
    const CAP = 80;
    const shown = list.slice(0, CAP);
    html += `<section class="plugins-section">
      <h2 class="plugins-section-title">${this.cb.esc(tr("plug.availableTitle", { n: list.length }) + (list.length > CAP ? tr("plug.availableCap", { cap: CAP }) : ""))}</h2>
      ${
        shown.length
          ? `<div class="plugins-grid">${shown.map((p) => this.pluginCard(p, true)).join("")}</div>`
          : `<div class="plugins-empty">${this.cb.esc(tr("plug.noMarketPlugins"))}</div>`
      }
    </section>`;
    return html;
  }

  private skillCard(s: SkillRow): string {
    return `
      <article class="plugins-card">
        <div class="plugins-card-main">
          ${avatarHtml(s.name, this.cb.esc, { forceLetter: true })}
          <div class="plugins-card-text">
            <div class="plugins-card-title-row">
              <span class="plugins-card-name">${this.cb.esc(s.name)}</span>
              <span class="plugins-card-badge">${this.cb.esc(scopeLabel(s.scope))}</span>
            </div>
            <div class="plugins-card-desc">${this.cb.esc(s.description || "Skill")}</div>
          </div>
        </div>
        <div class="plugins-card-actions">
          <button type="button" class="plugins-card-btn primary" data-action="use-skill" data-name="${this.cb.esc(s.name)}">${this.cb.esc(tr("plug.use"))}</button>
          ${
            s.path
              ? `<button type="button" class="plugins-card-btn" data-action="open-skill" data-path="${this.cb.esc(s.path)}">${this.cb.esc(tr("plug.openSkill"))}</button>`
              : ""
          }
        </div>
      </article>`;
  }

  private pluginCard(p: PluginRow, fromMarket: boolean): string {
    const c = p.components;
    const meta = [
      statusLabel(p),
      p.marketplace,
      c
        ? `s${c.skills}/a${c.agents}${c.hooks ? "/h" : ""}${c.mcpServers ? `/m${c.mcpServers}` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const isAvail =
      fromMarket || (p.status || "").toLowerCase() === "available";
    const disabled =
      (p.status || "").toLowerCase() === "disabled" || p.enabled === false;

    let actions = "";
    if (isAvail) {
      actions = `<button type="button" class="plugins-card-btn primary" data-action="install" data-name="${this.cb.esc(p.name)}" data-source="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.install"))}</button>
        <button type="button" class="plugins-card-btn" data-action="details" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.details"))}</button>`;
    } else {
      actions = `
        <button type="button" class="plugins-card-btn" data-action="details" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.details"))}</button>
        ${
          disabled
            ? `<button type="button" class="plugins-card-btn primary" data-action="enable" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.enable"))}</button>`
            : `<button type="button" class="plugins-card-btn" data-action="disable" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.disable"))}</button>`
        }
        <button type="button" class="plugins-card-btn" data-action="update-plugin" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.update"))}</button>
        <button type="button" class="plugins-card-btn" data-action="uninstall" data-name="${this.cb.esc(p.name)}">${this.cb.esc(tr("plug.uninstall"))}</button>
        ${
          p.path
            ? `<button type="button" class="plugins-card-btn" data-action="open-path" data-path="${this.cb.esc(p.path)}">${this.cb.esc(tr("plug.folder"))}</button>`
            : ""
        }`;
    }

    return `
      <article class="plugins-card plugins-card-tall">
        <div class="plugins-card-main">
          ${avatarHtml(p.name, this.cb.esc)}
          <div class="plugins-card-text">
            <div class="plugins-card-title-row">
              <span class="plugins-card-name">${this.cb.esc(p.name)}</span>
              <span class="plugins-card-badge">${this.cb.esc(meta)}</span>
            </div>
            <div class="plugins-card-desc">${this.cb.esc(p.description || p.path || "Plugin")}</div>
          </div>
        </div>
        <div class="plugins-card-actions">${actions}</div>
      </article>`;
  }

  private mcpCard(m: McpRow): string {
    const sub = [m.transport, m.status, m.command || m.url].filter(Boolean).join(" · ");
    return `
      <article class="plugins-card">
        <div class="plugins-card-main">
          ${avatarHtml(m.name, this.cb.esc, { forceLetter: true })}
          <div class="plugins-card-text">
            <div class="plugins-card-title-row">
              <span class="plugins-card-name">${this.cb.esc(m.name)}</span>
              <span class="plugins-card-badge muted">${this.cb.esc(m.status || "configured")}</span>
            </div>
            <div class="plugins-card-desc">${this.cb.esc(sub || "MCP")}</div>
          </div>
        </div>
        <div class="plugins-card-actions">
          <button type="button" class="plugins-card-btn" data-action="mcp-doctor" data-name="${this.cb.esc(m.name)}">${this.cb.esc(tr("plug.diagnose"))}</button>
          <button type="button" class="plugins-card-btn" data-action="mcp-remove" data-name="${this.cb.esc(m.name)}">${this.cb.esc(tr("plug.remove"))}</button>
        </div>
      </article>`;
  }

  private marketSrcCard(m: MarketSrc): string {
    return `
      <article class="plugins-card">
        <div class="plugins-card-main">
          ${avatarHtml(m.name, this.cb.esc, { forceLetter: true })}
          <div class="plugins-card-text">
            <div class="plugins-card-title-row">
              <span class="plugins-card-name">${this.cb.esc(m.name)}</span>
              <span class="plugins-card-badge">${this.cb.esc(m.kind || "git")}</span>
            </div>
            <div class="plugins-card-desc mono">${this.cb.esc(m.url)}</div>
          </div>
        </div>
        <div class="plugins-card-actions">
          <button type="button" class="plugins-card-btn" data-action="market-refresh" data-name="${this.cb.esc(m.name)}">${this.cb.esc(tr("plug.update"))}</button>
          <button type="button" class="plugins-card-btn" data-action="market-remove" data-url="${this.cb.esc(m.url)}">${this.cb.esc(tr("plug.remove"))}</button>
        </div>
      </article>`;
  }
}
