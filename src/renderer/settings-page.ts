/**
 * Codex 式全页设置：左导航 + 右内容，基于现有 Host 能力。
 */
import type { HostIpcMethod } from "../shared/host-api.js";
import { tr, type LocalePreference } from "../shared/i18n/index.js";

type Inv = <T>(method: HostIpcMethod, params?: unknown) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

/** 默认访问权限；plan 不再作为「权限」默认项（对齐 Grok Build 两维模型） */
export type SettingsPermMode = "always_approve" | "normal";
/** explorer | code | cursor | codium | windsurf | editor(遗留) */
export type SettingsOpenTarget = string;

export interface DesktopConfigData {
  defaultModel?: string;
  grokPathOverride?: string;
  alwaysApproveDefault?: boolean;
  defaultPermMode?: SettingsPermMode;
  defaultOpenTarget?: SettingsOpenTarget;
  /** UI language preference */
  locale?: LocalePreference;
  paths?: {
    settings: string;
    configToml: string;
    grokHome: string;
  };
}

export interface SettingsPageCallbacks {
  inv: Inv;
  getSelectedProjectPath?: () => string | undefined;
  getSelectedProjectId?: () => string | null;
  onConfigApplied: (cfg: {
    defaultPermMode: SettingsPermMode;
    defaultModel: string;
    defaultOpenTarget: SettingsOpenTarget;
    locale?: LocalePreference;
  }) => void;
  /** 关闭设置页后（恢复主界面交互 / 焦点） */
  onClosed?: () => void;
  esc: (s: string) => string;
}

type SectionId =
  | "general"
  | "account"
  | "memory"
  | "shortcuts"
  | "about";

type AccountTab = "official" | "custom";

type CustomProviderRow = {
  id: string;
  model: string;
  baseUrl: string;
  name: string;
  hasApiKey: boolean;
  apiBackend: string;
  isDefault: boolean;
};

function settingsSections(): Array<{
  id: SectionId;
  group: string;
  label: string;
  icon: string;
  keywords: string;
}> {
  return [
    {
      id: "general",
      group: tr("settings.group.personal"),
      label: tr("settings.section.general"),
      icon: "⚙",
      keywords: tr("settings.kw.general"),
    },
    {
      id: "account",
      group: tr("settings.group.personal"),
      label: tr("settings.section.account"),
      icon: "👤",
      keywords: tr("settings.kw.account"),
    },
    {
      id: "about",
      group: tr("settings.group.personal"),
      label: tr("settings.section.about"),
      icon: "ℹ",
      keywords: tr("settings.kw.about"),
    },
    {
      id: "memory",
      group: tr("settings.group.integrations"),
      label: tr("settings.section.memory"),
      icon: "◎",
      keywords: tr("settings.kw.memory"),
    },
    {
      id: "shortcuts",
      group: tr("settings.group.personal"),
      label: tr("settings.section.shortcuts"),
      icon: "⌨",
      keywords: tr("settings.kw.shortcuts"),
    },
  ];
}

export class SettingsPageController {
  private open = false;
  private section: SectionId = "general";
  private filter = "";
  private cfg: DesktopConfigData = {};
  private accountTab: AccountTab = "official";
  private editingProviderId: string | null = null;
  /** 提供商添加/编辑表单是否以弹窗打开 */
  private providerFormOpen = false;
  /** 当前表单已拉取的远程模型 id 列表 */
  private remoteModelIds: string[] = [];
  private modelMenuOpen = false;
  private modelMenuDocClose: ((ev: MouseEvent) => void) | null = null;
  /** 各提供商最近一次 ping 结果（render 后保留） */
  private providerPing: Record<
    string,
    { ok: boolean; latencyMs: number; error?: string } | "loading"
  > = {};

  constructor(private readonly cb: SettingsPageCallbacks) {
    this.bindShell();
  }

  isOpen(): boolean {
    return this.open;
  }

  async show(section?: SectionId): Promise<void> {
    this.open = true;
    if (section) this.section = section;
    const page = document.getElementById("settings-page");
    page?.classList.remove("hidden");
    const app = document.getElementById("app");
    app?.classList.add("settings-open");
    app?.setAttribute("aria-hidden", "true");
    // inert：禁止主界面在设置打开时获得焦点 / 接收输入（比 pointer-events 更可靠）
    if (app && "inert" in app) {
      (app as HTMLElement & { inert: boolean }).inert = true;
    }
    await this.reloadConfig();
    this.renderNav();
    await this.renderContent();
    const q = document.getElementById("settings-search") as HTMLInputElement | null;
    requestAnimationFrame(() => q?.focus());
  }

  hide(): void {
    this.open = false;
    this.closeProviderForm(false);
    this.teardownModelMenu();
    // 避免焦点停在即将 display:none 的设置控件上，导致主界面按键失效
    const ae = document.activeElement as HTMLElement | null;
    if (ae && document.getElementById("settings-page")?.contains(ae)) {
      ae.blur();
    }
    document.getElementById("settings-page")?.classList.add("hidden");
    const app = document.getElementById("app");
    app?.classList.remove("settings-open");
    app?.removeAttribute("aria-hidden");
    if (app && "inert" in app) {
      (app as HTMLElement & { inert: boolean }).inert = false;
    }
    this.cb.onClosed?.();
  }

  /** 关闭提供商弹窗；rerender=false 时仅清状态（hide/切 tab 前用） */
  private closeProviderForm(rerender = true): void {
    this.providerFormOpen = false;
    this.editingProviderId = null;
    this.remoteModelIds = [];
    this.modelMenuOpen = false;
    this.teardownModelMenu();
    if (rerender && this.open && this.section === "account") {
      void this.renderContent();
    }
  }

  private openProviderForm(editId: string | null = null): void {
    this.editingProviderId = editId;
    this.providerFormOpen = true;
    this.remoteModelIds = [];
    this.modelMenuOpen = false;
    void this.renderContent().then(() => {
      const name = document.getElementById(
        "prov-name",
      ) as HTMLInputElement | null;
      name?.focus();
      if (editId) {
        const root = document.getElementById("settings-content");
        if (root) void this.fetchRemoteModels(root, true);
      }
    });
  }

  /** 关闭模型下拉并卸掉 document 捕获监听（防止泄漏影响主界面） */
  private teardownModelMenu(): void {
    this.modelMenuOpen = false;
    if (this.modelMenuDocClose) {
      document.removeEventListener("click", this.modelMenuDocClose, true);
      this.modelMenuDocClose = null;
    }
  }

  private bindShell(): void {
    document.getElementById("btn-settings-back")?.addEventListener("click", () => {
      this.hide();
    });
    const search = document.getElementById("settings-search") as HTMLInputElement | null;
    search?.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderNav();
    });
    document.addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.providerFormOpen) {
          this.closeProviderForm(true);
          return;
        }
        this.hide();
      }
    });
  }

  private async reloadConfig(): Promise<void> {
    const res = await this.cb.inv<DesktopConfigData>("config.get");
    this.cfg = res.data ?? {};
  }

  private async patch(partial: Partial<DesktopConfigData>): Promise<void> {
    const res = await this.cb.inv<DesktopConfigData>("config.patch", partial);
    if (res.ok && res.data) this.cfg = res.data;
    else await this.reloadConfig();
    this.applyToApp();
  }

  private applyToApp(): void {
    const mode = this.cfg.defaultPermMode ?? "normal";
    const model = (this.cfg.defaultModel ?? "").trim() || "grok";
    const openTarget = this.cfg.defaultOpenTarget ?? "explorer";
    const locale = this.cfg.locale ?? "system";
    this.cb.onConfigApplied({
      defaultPermMode: mode,
      defaultModel: model,
      defaultOpenTarget: openTarget,
      locale,
    });
  }

  private renderNav(): void {
    const nav = document.getElementById("settings-nav-list");
    if (!nav) return;
    const f = this.filter;
    const sections = settingsSections();
    const items = sections.filter((s) => {
      if (!f) return true;
      const hay = `${s.label} ${s.group} ${s.keywords}`.toLowerCase();
      return hay.includes(f);
    });
    const groups = new Map<string, typeof items>();
    for (const s of items) {
      const arr = groups.get(s.group) ?? [];
      arr.push(s);
      groups.set(s.group, arr);
    }
    // 保持定义顺序的分组
    const order = [
      tr("settings.group.personal"),
      tr("settings.group.integrations"),
    ];
    let html = "";
    for (const g of order) {
      const list = groups.get(g);
      if (!list?.length) continue;
      html += `<div class="settings-nav-group">${this.cb.esc(g)}</div>`;
      for (const s of list) {
        html += `<button type="button" class="settings-nav-item${s.id === this.section ? " active" : ""}" data-section="${s.id}">
          <span class="settings-nav-ico">${s.icon}</span>
          <span>${this.cb.esc(s.label)}</span>
        </button>`;
      }
    }
    if (!html) {
      html = `<div class="settings-nav-empty">${this.cb.esc(tr("settings.navEmpty"))}</div>`;
    }
    nav.innerHTML = html;
    for (const btn of Array.from(nav.querySelectorAll("[data-section]"))) {
      (btn as HTMLElement).onclick = () => {
        this.section = (btn as HTMLElement).dataset.section as SectionId;
        this.renderNav();
        void this.renderContent();
      };
    }
  }

  private async renderContent(): Promise<void> {
    const root = document.getElementById("settings-content");
    if (!root) return;
    // 重绘前卸掉旧 DOM 上的捕获监听，避免 combo 节点失效后监听仍挂着
    this.teardownModelMenu();
    root.innerHTML = `<div class="settings-loading">${this.cb.esc(tr("settings.loading"))}</div>`;
    try {
      switch (this.section) {
        case "general":
          root.innerHTML = await this.htmlGeneral();
          this.bindGeneral(root);
          break;
        case "account":
          root.innerHTML = await this.htmlAccount();
          this.bindAccount(root);
          break;
        case "about":
          root.innerHTML = await this.htmlAbout();
          this.bindAbout(root);
          break;
        case "memory":
          root.innerHTML = await this.htmlMemory();
          this.bindMemory(root);
          break;
        case "shortcuts":
          root.innerHTML = this.htmlShortcuts();
          break;
        default:
          root.innerHTML = `<p class="settings-muted">${this.cb.esc(tr("settings.unknownSection"))}</p>`;
      }
    } catch (err) {
      root.innerHTML = `<p class="settings-error">${this.cb.esc(String(err))}</p>`;
    }
  }

  // ── 常规 ───────────────────────────────────────────────

  private async htmlGeneral(): Promise<string> {
    const mode = this.cfg.defaultPermMode ?? "normal";
    const openTarget = this.cfg.defaultOpenTarget ?? "explorer";
    const locale = (this.cfg.locale ?? "system") as LocalePreference;
    const edRes = await this.cb.inv<{
      editors: Array<{ id: string; label: string; command: string }>;
    }>("system.listEditors");
    const editors = edRes.data?.editors ?? [];
    const editorOpts = editors
      .map(
        (e) =>
          `<option value="${this.cb.esc(e.id)}" ${openTarget === e.id ? "selected" : ""}>${this.cb.esc(e.label)}</option>`,
      )
      .join("");
    // 遗留 editor 或已选但未探测到的 id：仍显示在下拉中
    let legacyOpt = "";
    if (
      openTarget &&
      openTarget !== "explorer" &&
      !editors.some((e) => e.id === openTarget)
    ) {
      const label =
        openTarget === "editor"
          ? tr("settings.editorMissing")
          : tr("settings.editorMissingNamed", { id: openTarget });
      legacyOpt = `<option value="${this.cb.esc(openTarget)}" selected>${this.cb.esc(label)}</option>`;
    }
    const emptyHint =
      editors.length === 0
        ? `<div class="settings-row-sub" style="margin-top:8px">${this.cb.esc(tr("settings.noEditors"))}</div>`
        : "";
    return `
      <h1 class="settings-title">${this.cb.esc(tr("settings.section.general"))}</h1>

      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.language"))}</h2>
        <p class="settings-desc">${this.cb.esc(tr("settings.languageSub"))}</p>
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">${this.cb.esc(tr("settings.language"))}</div>
              <div class="settings-row-sub">${this.cb.esc(tr("settings.languageSub"))}</div>
            </div>
            <select id="cfg-locale" class="settings-select">
              <option value="system" ${locale === "system" ? "selected" : ""}>${this.cb.esc(tr("settings.language.system"))}</option>
              <option value="zh-CN" ${locale === "zh-CN" ? "selected" : ""}>${this.cb.esc(tr("settings.language.zh"))}</option>
              <option value="en-US" ${locale === "en-US" ? "selected" : ""}>${this.cb.esc(tr("settings.language.en"))}</option>
            </select>
          </div>
        </div>
      </section>

      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.defaultPerm"))}</h2>
        <p class="settings-desc">${this.cb.esc(tr("settings.defaultPermDesc"))}</p>
        <div class="settings-choice-row">
          ${this.choiceCard("perm", "normal", mode === "normal", tr("settings.perm.normal"), tr("settings.perm.normalSub"))}
          ${this.choiceCard("perm", "always_approve", mode === "always_approve", tr("settings.perm.full"), tr("settings.perm.fullSub"))}
        </div>
      </section>

      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.generalBlock"))}</h2>
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">${this.cb.esc(tr("settings.openTarget"))}</div>
              <div class="settings-row-sub">${this.cb.esc(tr("settings.openTargetSub"))}</div>
            </div>
            <select id="cfg-open-target" class="settings-select">
              <option value="explorer" ${openTarget === "explorer" ? "selected" : ""}>${this.cb.esc(tr("settings.explorer"))}</option>
              ${editorOpts}
              ${legacyOpt}
            </select>
          </div>
          ${emptyHint}
        </div>
      </section>
    `;
  }

  private choiceCard(
    group: string,
    value: string,
    active: boolean,
    title: string,
    sub: string,
  ): string {
    return `<button type="button" class="settings-choice${active ? " active" : ""}" data-group="${group}" data-value="${value}">
      <div class="settings-choice-title">${this.cb.esc(title)}</div>
      <div class="settings-choice-sub">${this.cb.esc(sub)}</div>
      <span class="settings-choice-dot" aria-hidden="true"></span>
    </button>`;
  }

  private bindGeneral(root: HTMLElement): void {
    for (const el of Array.from(root.querySelectorAll(".settings-choice[data-group=perm]"))) {
      (el as HTMLElement).onclick = () => {
        const v = (el as HTMLElement).dataset.value as SettingsPermMode;
        void this.patch({ defaultPermMode: v }).then(() => this.renderContent());
      };
    }
    const sel = root.querySelector("#cfg-open-target") as HTMLSelectElement | null;
    sel?.addEventListener("change", () => {
      void this.patch({
        defaultOpenTarget: sel.value as SettingsOpenTarget,
      });
    });
    const loc = root.querySelector("#cfg-locale") as HTMLSelectElement | null;
    loc?.addEventListener("change", () => {
      const value = loc.value as LocalePreference;
      void this.patch({ locale: value }).then(() => {
        // Re-render settings shell strings after locale applies
        this.renderNav();
        void this.renderContent();
      });
    });
  }

  // ── 账户与提供商（官方 OAuth / 自定义中转）────────────────

  private async htmlAccount(): Promise<string> {
    const tab = this.accountTab;
    const tabs = `
      <div class="settings-tabs" role="tablist">
        <button type="button" class="settings-tab${tab === "official" ? " active" : ""}" data-account-tab="official" role="tab" aria-selected="${tab === "official"}">${this.cb.esc(tr("settings.tabOfficial"))}</button>
        <button type="button" class="settings-tab${tab === "custom" ? " active" : ""}" data-account-tab="custom" role="tab" aria-selected="${tab === "custom"}">${this.cb.esc(tr("settings.tabCustom"))}</button>
      </div>`;
    const body =
      tab === "official"
        ? await this.htmlAccountOfficial()
        : await this.htmlAccountCustom();
    return `
      <h1 class="settings-title">${this.cb.esc(tr("settings.accountTitle"))}</h1>
      ${tabs}
      <div class="settings-tab-panel">${body}</div>
    `;
  }

  private async htmlAccountOfficial(): Promise<string> {
    const auth = await this.cb.inv<{
      authenticated: boolean;
      label?: string;
      authPath?: string;
      grokHome?: string;
      cliGrokHome?: string;
    }>("system.auth.status");
    const a = auth.data;
    const statusLine = a?.authenticated
      ? `${tr("settings.loggedIn")}${a.label ? ` · ${this.cb.esc(a.label)}` : ""}`
      : tr("settings.loggedOut");
    return `
      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.officialH2"))}</h2>
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-row-text">
              <div class="settings-row-title">${this.cb.esc(tr("settings.loginStatus"))}</div>
              <div class="settings-row-sub">${statusLine}</div>
            </div>
            <div class="settings-inline-actions settings-row-actions">
              ${
                a?.authenticated
                  ? `<button type="button" class="btn-ghost settings-mini-btn" id="btn-auth-logout">${this.cb.esc(tr("settings.logout"))}</button>`
                  : `<button type="button" class="btn-dark settings-mini-btn" id="btn-auth-login">${this.cb.esc(tr("settings.oauthLogin"))}</button>
                     <button type="button" class="btn-ghost settings-mini-btn" id="btn-auth-login-device">${this.cb.esc(tr("settings.deviceLogin"))}</button>`
              }
            </div>
          </div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.desktopHome"))}</span><span class="mono">${this.cb.esc(a?.grokHome ?? this.cfg.paths?.grokHome ?? "—")}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.cliHome"))}</span><span class="mono">${this.cb.esc(a?.cliGrokHome ?? "—")}</span></div>
        </div>
      </section>
    `;
  }

  private async htmlAccountCustom(): Promise<string> {
    const res = await this.cb.inv<{
      providers: CustomProviderRow[];
      defaultModel: string | null;
      configPath: string;
    }>("providers.list");
    const list = res.data?.providers ?? [];
    const configPath = res.data?.configPath ?? this.cfg.paths?.configToml ?? "";
    const editing = this.editingProviderId
      ? list.find((p) => p.id === this.editingProviderId)
      : null;
    const isEdit = Boolean(editing);
    // 编辑 id 已不存在时关掉弹窗状态
    if (this.providerFormOpen && this.editingProviderId && !editing) {
      this.providerFormOpen = false;
      this.editingProviderId = null;
    }

    const rows =
      list
        .map((p) => {
          const title = p.name || p.id || tr("settings.providerUnnamed");
          const initial = this.providerInitial(title);
          const active = p.isDefault ? " is-active" : "";
          const warn = p.hasApiKey ? "" : " is-warn";
          const pingState = this.providerPing[p.id];
          let pingHtml = "";
          if (pingState === "loading") {
            pingHtml = `<span class="provider-card-ping is-loading">${this.cb.esc(tr("prov.pinging"))}</span>`;
          } else if (pingState) {
            const ms = Math.round(pingState.latencyMs);
            if (pingState.ok) {
              pingHtml = `<span class="provider-card-ping is-ok" title="${this.cb.esc(tr("prov.ping"))}">${this.cb.esc(tr("prov.pingOk", { ms: String(ms) }))}</span>`;
            } else {
              const err = pingState.error ? ` · ${pingState.error}` : "";
              pingHtml = `<span class="provider-card-ping is-fail" title="${this.cb.esc((pingState.error ?? tr("prov.pingError")) + err)}">${this.cb.esc(tr("prov.pingFail", { ms: String(ms) }))}</span>`;
            }
          }
          return `
        <div class="provider-card${active}${warn}" data-provider-id="${this.cb.esc(p.id)}">
          <div class="provider-card-main">
            <span class="provider-card-avatar" aria-hidden="true">${this.cb.esc(initial)}</span>
            <div class="provider-card-text">
              <div class="provider-card-title">${this.cb.esc(title)}${
                p.hasApiKey
                  ? ""
                  : `<span class="provider-card-tag warn">${this.cb.esc(tr("settings.providerNoKey"))}</span>`
              }${pingHtml}</div>
              <div class="provider-card-sub" title="${this.cb.esc(p.baseUrl)}">${this.cb.esc(p.baseUrl || "—")}</div>
              <div class="provider-card-meta mono">${this.cb.esc(p.model || p.id)}</div>
            </div>
          </div>
          <div class="provider-card-actions">
            ${
              p.isDefault
                ? `<button type="button" class="provider-card-enable is-current" disabled aria-disabled="true" title="${this.cb.esc(tr("prov.enabled"))}">
                     ${this.cb.esc(tr("prov.enabled"))}
                   </button>`
                : `<button type="button" class="provider-card-enable" data-prov-act="default" data-id="${this.cb.esc(p.id)}" title="${this.cb.esc(tr("prov.enable"))}">
                     ${this.cb.esc(tr("prov.enable"))}
                   </button>`
            }
            <button type="button" class="provider-card-icon-btn" data-prov-act="ping" data-id="${this.cb.esc(p.id)}" title="${this.cb.esc(tr("prov.ping"))}" aria-label="${this.cb.esc(tr("prov.ping"))}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h4"/><path d="M18 12h4"/><path d="M6.5 6.5 4 4"/><path d="M17.5 6.5 20 4"/><path d="M6.5 17.5 4 20"/><path d="M17.5 17.5 20 20"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/></svg>
            </button>
            <button type="button" class="provider-card-icon-btn" data-prov-act="edit" data-id="${this.cb.esc(p.id)}" title="${this.cb.esc(tr("settings.edit"))}" aria-label="${this.cb.esc(tr("settings.edit"))}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button type="button" class="provider-card-icon-btn danger" data-prov-act="remove" data-id="${this.cb.esc(p.id)}" title="${this.cb.esc(tr("common.delete"))}" aria-label="${this.cb.esc(tr("common.delete"))}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
        </div>`;
        })
        .join("") ||
      `<div class="settings-empty">${this.cb.esc(tr("prov.empty"))}</div>`;

    const listSection = `
      <section class="settings-block">
        <div class="settings-block-head">
          <h2 class="settings-h2">${this.cb.esc(tr("prov.configuredTitle"))}</h2>
          <button type="button" class="btn-dark settings-mini-btn" id="btn-prov-new">${this.cb.esc(tr("prov.new"))}</button>
        </div>
        <div class="provider-card-list">${rows}</div>
        <div class="settings-inline-actions">
          <button type="button" class="btn-ghost settings-mini-btn" data-open-path="${this.cb.esc(configPath)}">${this.cb.esc(tr("prov.openConfig"))}</button>
        </div>
      </section>`;

    if (!this.providerFormOpen) return listSection;

    const formBody = this.htmlProviderForm(editing, isEdit);
    return `${listSection}
      <div class="settings-modal-backdrop" id="prov-form-backdrop" role="presentation">
        <div class="settings-modal" id="prov-form-section" role="dialog" aria-modal="true" aria-labelledby="prov-form-title">
          <div class="settings-modal-head">
            <h2 class="settings-modal-title" id="prov-form-title">${this.cb.esc(isEdit ? tr("prov.editTitle") : tr("prov.addTitle"))}</h2>
            <button type="button" class="settings-modal-close" id="btn-prov-cancel" aria-label="${this.cb.esc(tr("common.close"))}">×</button>
          </div>
          <div class="settings-modal-body settings-form-card">
            ${formBody}
          </div>
        </div>
      </div>`;
  }

  /** 提供商卡片头像缩写（1–2 字） */
  private providerInitial(name: string): string {
    const s = name.trim();
    if (!s) return "?";
    // 优先取字母/数字/汉字前两字符
    const chars = Array.from(s.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2);
    if (chars.length) return chars.join("").toUpperCase();
    return Array.from(s).slice(0, 2).join("").toUpperCase();
  }

  private htmlProviderForm(
    editing: CustomProviderRow | null | undefined,
    isEdit: boolean,
  ): string {
    return `
          <label class="settings-field">
            <span class="settings-field-label">${this.cb.esc(tr("prov.name"))}</span>
            <input class="settings-input" id="prov-name" value="${this.cb.esc(editing?.name ?? "")}" placeholder="${this.cb.esc(tr("prov.namePh"))}" autocomplete="off" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label">${this.cb.esc(tr("prov.baseUrl"))}</span>
            <input class="settings-input" id="prov-base" value="${this.cb.esc(editing?.baseUrl ?? "")}" placeholder="https://your-relay.example.com/v1" autocomplete="off" />
            <span class="settings-field-hint">${this.cb.esc(tr("prov.baseHint"))}</span>
          </label>
          <div class="settings-field-row">
            <label class="settings-field">
              <span class="settings-field-label">${this.cb.esc(tr("prov.apiKey"))}</span>
              <input class="settings-input" id="prov-key" type="password" value="" placeholder="${this.cb.esc(editing?.hasApiKey ? tr("prov.keyKeep") : "sk-…")}" autocomplete="new-password" />
            </label>
            <label class="settings-field">
              <span class="settings-field-label">${this.cb.esc(tr("prov.protocol"))}</span>
              <select class="settings-select" id="prov-backend">
                <option value="chat_completions" ${!editing || editing.apiBackend === "chat_completions" ? "selected" : ""}>OpenAI Chat Completions</option>
                <option value="responses" ${editing?.apiBackend === "responses" ? "selected" : ""}>OpenAI Responses</option>
                <option value="messages" ${editing?.apiBackend === "messages" ? "selected" : ""}>Anthropic Messages</option>
              </select>
            </label>
          </div>
          <div class="settings-form-actions settings-form-actions-tight">
            <button type="button" class="btn-ghost settings-mini-btn" id="btn-prov-fetch-models">${this.cb.esc(tr("prov.fetchModels"))}</button>
            <span class="settings-save-hint" id="prov-fetch-hint">GET {"{base_url}"}/models</span>
          </div>
          <div class="settings-field-row settings-field-row-models">
            <label class="settings-field">
              <span class="settings-field-label">${this.cb.esc(tr("prov.displayName"))}</span>
              <input class="settings-input" id="prov-id" ${isEdit ? "readonly" : ""} value="${this.cb.esc(editing?.id ?? "")}" placeholder="${this.cb.esc(tr("prov.idPh"))}" autocomplete="off" />
            </label>
            <div class="settings-field">
              <span class="settings-field-label">${this.cb.esc(tr("prov.requestModel"))}</span>
              <div class="settings-model-combo" id="prov-model-combo">
                <input class="settings-input" id="prov-model" value="${this.cb.esc(editing?.model ?? "")}" placeholder="${this.cb.esc(tr("prov.modelPh"))}" autocomplete="off" />
                <button type="button" class="settings-model-combo-btn" id="btn-prov-model-menu" title="${this.cb.esc(tr("prov.pickModel"))}" aria-label="${this.cb.esc(tr("prov.pickModel"))}" aria-haspopup="listbox" aria-expanded="false">▾</button>
                <div class="settings-model-menu hidden" id="prov-model-menu" role="listbox"></div>
              </div>
            </div>
          </div>
          <label class="settings-field settings-field-check">
            <input type="checkbox" id="prov-default" ${editing?.isDefault ? "checked" : ""} />
            <span>${this.cb.esc(tr("prov.setDefault"))}</span>
          </label>
          <div class="settings-form-actions settings-modal-footer">
            <button type="button" class="btn-ghost" id="btn-prov-cancel-footer">${this.cb.esc(tr("common.cancel"))}</button>
            <button type="button" class="btn-dark" id="btn-prov-save">${this.cb.esc(isEdit ? tr("prov.save") : tr("prov.add"))}</button>
            <span class="settings-save-hint" id="prov-save-hint"></span>
          </div>`;
  }

  private bindAccount(root: HTMLElement): void {
    for (const btn of Array.from(root.querySelectorAll("[data-account-tab]"))) {
      (btn as HTMLElement).onclick = () => {
        const t = (btn as HTMLElement).dataset.accountTab as AccountTab;
        if (t === "official" || t === "custom") {
          this.accountTab = t;
          if (t === "official") this.closeProviderForm(false);
          void this.renderContent();
        }
      };
    }
    for (const btn of Array.from(root.querySelectorAll("[data-open-path]"))) {
      (btn as HTMLElement).onclick = () => {
        const p = (btn as HTMLElement).dataset.openPath;
        if (p) void this.cb.inv("system.openPath", { path: p });
      };
    }
    if (this.accountTab === "official") {
      const login = root.querySelector("#btn-auth-login") as HTMLElement | null;
      if (login) login.onclick = () => void this.runAuthLogin("oauth");
      const device = root.querySelector(
        "#btn-auth-login-device",
      ) as HTMLElement | null;
      if (device) device.onclick = () => void this.runAuthLogin("device-auth");
      const logout = root.querySelector("#btn-auth-logout") as HTMLElement | null;
      if (logout) logout.onclick = () => void this.runAuthLogout();
      return;
    }
    // custom tab — 列表
    root.querySelector("#btn-prov-new")?.addEventListener("click", () => {
      this.openProviderForm(null);
    });
    for (const btn of Array.from(root.querySelectorAll("[data-prov-act]"))) {
      (btn as HTMLElement).onclick = () => {
        const act = (btn as HTMLElement).dataset.provAct;
        const id = (btn as HTMLElement).dataset.id ?? "";
        if (!id) return;
        if (act === "edit") {
          this.openProviderForm(id);
        } else if (act === "remove") {
          void this.removeProvider(id);
        } else if (act === "default") {
          void this.setProviderDefault(id);
        } else if (act === "ping") {
          void this.pingProvider(id);
        }
      };
    }
    if (!this.providerFormOpen) return;

    // 弹窗表单
    const closeForm = () => this.closeProviderForm(true);
    root.querySelector("#btn-prov-cancel")?.addEventListener("click", closeForm);
    root
      .querySelector("#btn-prov-cancel-footer")
      ?.addEventListener("click", closeForm);
    root.querySelector("#prov-form-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeForm();
    });
    // 阻止点击弹窗内容时冒泡到 backdrop
    root.querySelector("#prov-form-section")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    root.querySelector("#btn-prov-save")?.addEventListener("click", () => {
      void this.saveProviderForm(root);
    });
    root.querySelector("#btn-prov-fetch-models")?.addEventListener("click", () => {
      void this.fetchRemoteModels(root);
    });
    this.bindModelCombo(root);
    const nameInput = root.querySelector("#prov-name") as HTMLInputElement | null;
    if (nameInput) {
      nameInput.addEventListener("input", () => {
        nameInput.dataset.userEdited = "1";
      });
    }
    const idInput = root.querySelector("#prov-id") as HTMLInputElement | null;
    if (idInput && !this.editingProviderId) {
      idInput.addEventListener("input", () => {
        idInput.dataset.userEdited = "1";
      });
    }
    const modelInput = root.querySelector(
      "#prov-model",
    ) as HTMLInputElement | null;
    if (modelInput) {
      modelInput.addEventListener("input", () => {
        this.syncDisplayNameFromModel(root, modelInput.value.trim(), false);
      });
      modelInput.addEventListener("change", () => {
        this.syncDisplayNameFromModel(root, modelInput.value.trim(), false);
      });
    }
  }

  private bindModelCombo(root: HTMLElement): void {
    const combo = root.querySelector("#prov-model-combo") as HTMLElement | null;
    const menuBtn = root.querySelector(
      "#btn-prov-model-menu",
    ) as HTMLButtonElement | null;
    const menu = root.querySelector("#prov-model-menu") as HTMLElement | null;
    // 即使没有 combo 也要卸掉旧监听（render 后 DOM 已换）
    this.teardownModelMenu();
    if (!combo || !menuBtn || !menu) return;

    const closeMenu = () => {
      this.modelMenuOpen = false;
      menu.classList.add("hidden");
      menuBtn.setAttribute("aria-expanded", "false");
    };

    const openMenu = async () => {
      if (!this.remoteModelIds.length) {
        await this.fetchRemoteModels(root, false);
      }
      this.renderModelMenu(root);
      if (!this.remoteModelIds.length) {
        menu.innerHTML =
          `<div class="settings-model-menu-empty">${this.cb.esc(tr("prov.noModelsHint"))}</div>`;
      }
      this.modelMenuOpen = true;
      menu.classList.remove("hidden");
      menuBtn.setAttribute("aria-expanded", "true");
    };

    menuBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.modelMenuOpen) closeMenu();
      else void openMenu();
    };

    this.modelMenuDocClose = (ev: MouseEvent) => {
      if (!this.modelMenuOpen) return;
      const t = ev.target as Node | null;
      if (t && combo.contains(t)) return;
      closeMenu();
    };
    document.addEventListener("click", this.modelMenuDocClose, true);
  }

  private renderModelMenu(root: HTMLElement): void {
    const menu = root.querySelector("#prov-model-menu") as HTMLElement | null;
    if (!menu) return;
    const cur = (
      root.querySelector("#prov-model") as HTMLInputElement | null
    )?.value.trim();
    if (!this.remoteModelIds.length) {
      menu.innerHTML = `<div class="settings-model-menu-empty">${this.cb.esc(tr("prov.noModels"))}</div>`;
      return;
    }
    menu.innerHTML = this.remoteModelIds
      .map((id) => {
        const active = id === cur ? " active" : "";
        return `<button type="button" class="settings-model-menu-item${active}" role="option" data-model-id="${this.cb.esc(id)}">${this.cb.esc(id)}</button>`;
      })
      .join("");
    for (const btn of Array.from(menu.querySelectorAll("[data-model-id]"))) {
      (btn as HTMLElement).onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.modelId ?? "";
        if (!id) return;
        this.applyModelSelection(root, id);
        menu.classList.add("hidden");
        this.modelMenuOpen = false;
        const menuBtn = root.querySelector("#btn-prov-model-menu");
        menuBtn?.setAttribute("aria-expanded", "false");
      };
    }
  }

  /** 选择远程模型：写入请求模型；显示名称默认跟随（未手改时） */
  private applyModelSelection(root: HTMLElement, modelId: string): void {
    const modelInput = root.querySelector(
      "#prov-model",
    ) as HTMLInputElement | null;
    if (modelInput) modelInput.value = modelId;
    this.syncDisplayNameFromModel(root, modelId, true);
  }

  /**
   * 显示名称（#prov-id / 配置段名）默认 = 实际请求模型；用户手改过则不覆盖。
   * 提供商名称（#prov-name）不在此同步。
   */
  private syncDisplayNameFromModel(
    root: HTMLElement,
    modelId: string,
    fromMenu: boolean,
  ): void {
    if (!modelId) return;
    if (this.editingProviderId) return; // 编辑时段名只读，不改
    const idInput = root.querySelector("#prov-id") as HTMLInputElement | null;
    if (!idInput) return;
    if (idInput.dataset.userEdited === "1" && !fromMenu) return;
    if (fromMenu) {
      if (idInput.dataset.userEdited === "1") {
        const modelBefore = idInput.dataset.lastAutoName ?? "";
        if (
          idInput.value.trim() &&
          idInput.value.trim() !== modelBefore &&
          idInput.value.trim() !== modelId
        ) {
          return;
        }
        idInput.dataset.userEdited = "0";
      }
      idInput.value = modelId;
      idInput.dataset.lastAutoName = modelId;
      return;
    }
    if (idInput.dataset.userEdited === "1") return;
    idInput.value = modelId;
    idInput.dataset.lastAutoName = modelId;
  }

  private fillModelMenuData(models: Array<{ id: string }>): void {
    this.remoteModelIds = models.map((m) => m.id);
  }

  private async fetchRemoteModels(
    root: HTMLElement,
    silent = false,
  ): Promise<void> {
    const hint = root.querySelector("#prov-fetch-hint");
    const baseUrl = (
      root.querySelector("#prov-base") as HTMLInputElement | null
    )?.value.trim();
    const apiKey = (
      root.querySelector("#prov-key") as HTMLInputElement | null
    )?.value;
    if (!baseUrl) {
      if (!silent && hint) hint.textContent = tr("prov.needBase");
      return;
    }
    if (hint) {
      hint.textContent = silent ? tr("prov.fetching") : tr("prov.fetchingApi");
    }
    const res = await this.cb.inv<{
      endpoint: string;
      models: Array<{ id: string }>;
    }>("providers.listRemoteModels", {
      baseUrl,
      apiKey: apiKey || undefined,
      providerId: this.editingProviderId ?? undefined,
    });
    if (!res.ok) {
      if (!silent && hint) {
        hint.textContent = res.error?.message ?? tr("prov.fetchFail");
      } else if (hint && silent) {
        hint.textContent = tr("prov.fetchFailAuto");
      }
      return;
    }
    const models = res.data?.models ?? [];
    this.fillModelMenuData(models);
    if (this.modelMenuOpen) this.renderModelMenu(root);
    if (hint) {
      hint.textContent =
        models.length > 0
          ? tr("prov.loaded", {
              n: models.length,
              endpoint: res.data?.endpoint ?? "",
            })
          : tr("prov.emptyList", { endpoint: res.data?.endpoint ?? "" });
    }
  }

  private async saveProviderForm(root: HTMLElement): Promise<void> {
    const id = (
      root.querySelector("#prov-id") as HTMLInputElement | null
    )?.value.trim();
    const name = (
      root.querySelector("#prov-name") as HTMLInputElement | null
    )?.value.trim();
    const model = (
      root.querySelector("#prov-model") as HTMLInputElement | null
    )?.value.trim();
    const baseUrl = (
      root.querySelector("#prov-base") as HTMLInputElement | null
    )?.value.trim();
    const apiKey = (
      root.querySelector("#prov-key") as HTMLInputElement | null
    )?.value;
    const apiBackend = (
      root.querySelector("#prov-backend") as HTMLSelectElement | null
    )?.value as "chat_completions" | "responses" | "messages";
    const setAsDefault = Boolean(
      (root.querySelector("#prov-default") as HTMLInputElement | null)?.checked,
    );
    const hint = root.querySelector("#prov-save-hint");
    if (!id || !baseUrl || !model) {
      if (hint) hint.textContent = tr("prov.needFields");
      return;
    }
    const res = await this.cb.inv("providers.upsert", {
      id,
      name: name || id,
      model,
      baseUrl,
      apiKey: apiKey || undefined,
      apiBackend,
      setAsDefault,
    });
    if (!res.ok) {
      if (hint) hint.textContent = res.error?.message ?? tr("prov.saveFail");
      else window.alert(res.error?.message ?? tr("prov.saveFail"));
      return;
    }
    if (setAsDefault) {
      await this.patch({ defaultModel: id });
    }
    this.providerFormOpen = false;
    this.editingProviderId = null;
    this.remoteModelIds = [];
    this.modelMenuOpen = false;
    this.teardownModelMenu();
    if (hint) hint.textContent = tr("prov.saved");
    await this.reloadConfig();
    this.applyToApp();
    await this.renderContent();
  }

  private async removeProvider(id: string): Promise<void> {
    if (!window.confirm(tr("prov.confirmDelete", { id }))) {
      return;
    }
    const res = await this.cb.inv("providers.remove", { id });
    if (!res.ok) {
      window.alert(res.error?.message ?? tr("prov.deleteFail"));
      return;
    }
    if (this.editingProviderId === id) {
      this.providerFormOpen = false;
      this.editingProviderId = null;
    }
    await this.reloadConfig();
    this.applyToApp();
    await this.renderContent();
  }

  private async setProviderDefault(id: string): Promise<void> {
    const res = await this.cb.inv("providers.setDefault", { modelId: id });
    if (!res.ok) {
      window.alert(res.error?.message ?? tr("prov.setFail"));
      return;
    }
    await this.patch({ defaultModel: id });
    await this.renderContent();
  }

  private async pingProvider(id: string): Promise<void> {
    this.providerPing[id] = "loading";
    // 只更新该卡片上的 ping 展示，避免整页闪烁
    this.patchProviderPingUi(id);
    const res = await this.cb.inv<{
      ok: boolean;
      latencyMs: number;
      endpoint: string;
      status?: number;
      error?: string;
    }>("providers.ping", { providerId: id });
    if (!res.ok || !res.data) {
      this.providerPing[id] = {
        ok: false,
        latencyMs: 0,
        error: res.error?.message ?? tr("prov.pingError"),
      };
    } else {
      this.providerPing[id] = {
        ok: res.data.ok,
        latencyMs: res.data.latencyMs,
        error: res.data.error,
      };
    }
    this.patchProviderPingUi(id);
  }

  /** 就地刷新卡片上的 ping 毫秒标签（不 re-render 整页） */
  private patchProviderPingUi(id: string): void {
    const card = document.querySelector(
      `.provider-card[data-provider-id="${CSS.escape(id)}"]`,
    );
    if (!card) return;
    const title = card.querySelector(".provider-card-title");
    if (!title) return;
    title.querySelectorAll(".provider-card-ping").forEach((n) => n.remove());
    const state = this.providerPing[id];
    if (!state) return;
    const span = document.createElement("span");
    span.className = "provider-card-ping";
    if (state === "loading") {
      span.classList.add("is-loading");
      span.textContent = tr("prov.pinging");
    } else if (state.ok) {
      span.classList.add("is-ok");
      span.title = tr("prov.ping");
      span.textContent = tr("prov.pingOk", {
        ms: String(Math.round(state.latencyMs)),
      });
    } else {
      span.classList.add("is-fail");
      span.title = state.error ?? tr("prov.pingError");
      span.textContent = tr("prov.pingFail", {
        ms: String(Math.round(state.latencyMs)),
      });
    }
    title.appendChild(span);
  }

  private async runAuthLogin(method: "oauth" | "device-auth"): Promise<void> {
    const res = await this.cb.inv<{ message?: string }>("system.auth.login", {
      method,
    });
    if (!res.ok) {
      window.alert(res.error?.message ?? tr("prov.loginFail"));
      return;
    }
    window.alert(res.data?.message ?? tr("prov.loginStarted"));
    await this.renderContent();
  }

  private async runAuthLogout(): Promise<void> {
    if (!window.confirm(tr("prov.confirmLogout"))) {
      return;
    }
    const res = await this.cb.inv("system.auth.logout", {});
    if (!res.ok) {
      window.alert(res.error?.message ?? tr("prov.logoutFail"));
      return;
    }
    await this.renderContent();
  }

  // ── 关于 ───────────────────────────────────────────────

  private async htmlAbout(): Promise<string> {
    const [ver, auth, info] = await Promise.all([
      this.cb.inv<Record<string, unknown>>("shell.versionMatrix"),
      this.cb.inv<{
        authenticated: boolean;
        label?: string;
        grokHome?: string;
      }>("system.auth.status"),
      this.cb.inv<{
        path: string | null;
        version: string | null;
        source?: string;
        agentBinMeta?: {
          version: string | null;
          source: string | null;
          syncedAt: string | null;
          sha256: string | null;
          binary: string | null;
        } | null;
      }>("system.grokInfo"),
    ]);
    const a = auth.data;
    const g = info.data;
    const v = ver.data ?? {};
    const meta = g?.agentBinMeta;
    const authLine = a?.authenticated
      ? `${tr("settings.loggedIn")}${a.label ? ` · ${this.cb.esc(a.label)}` : ""}`
      : tr("settings.loggedOut");
    const sourceLabel =
      g?.source === "bundled"
        ? tr("settings.source.bundled")
        : g?.source === "override"
          ? tr("settings.source.override")
          : g?.source === "path"
            ? tr("settings.source.path")
            : g?.source === "missing"
              ? tr("settings.source.missing")
              : (g?.source ?? "—");
    const metaRows = meta
      ? `
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.agentBinVer"))}</span><span class="mono">${this.cb.esc(meta.version ?? "—")}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.syncedAt"))}</span><span class="mono">${this.cb.esc(meta.syncedAt ?? "—")}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.sha256"))}</span><span class="mono" title="${this.cb.esc(meta.sha256 ?? "")}">${this.cb.esc(
            meta.sha256 ? `${meta.sha256.slice(0, 16)}…` : "—",
          )}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.syncSource"))}</span><span class="mono">${this.cb.esc(meta.source ?? "—")}</span></div>`
      : `
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.agentBinMeta"))}</span><span>${this.cb.esc(tr("settings.agentBinMetaMissing"))}</span></div>`;
    return `
      <h1 class="settings-title">${this.cb.esc(tr("settings.aboutTitle"))}</h1>
      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.accountSummary"))}</h2>
        <div class="settings-card">
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.officialAccount"))}</span><span>${authLine}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.desktopHome"))}</span><span class="mono">${this.cb.esc(a?.grokHome ?? this.cfg.paths?.grokHome ?? "—")}</span></div>
        </div>
        <div class="settings-inline-actions">
          <button type="button" class="btn-dark settings-mini-btn" id="btn-goto-account">${this.cb.esc(tr("settings.manageAccount"))}</button>
        </div>
      </section>
      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.runtime"))}</h2>
        <div class="settings-card">
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.grokPath"))}</span><span class="mono">${this.cb.esc(g?.path ?? "—")}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.version"))}</span><span class="mono">${this.cb.esc(g?.version ?? "—")}</span></div>
          <div class="settings-kv"><span>${this.cb.esc(tr("settings.source"))}</span><span>${this.cb.esc(sourceLabel)}</span></div>
          ${metaRows}
        </div>
      </section>
      <section class="settings-block">
        <h2 class="settings-h2">${this.cb.esc(tr("settings.diagnostics"))}</h2>
        <pre class="settings-pre">${this.cb.esc(JSON.stringify(v, null, 2))}</pre>
      </section>
    `;
  }

  private bindAbout(root: HTMLElement): void {
    const go = root.querySelector("#btn-goto-account") as HTMLElement | null;
    if (go) {
      go.onclick = () => {
        this.section = "account";
        this.renderNav();
        void this.renderContent();
      };
    }
  }

  // ── 记忆 ───────────────────────────────────────────────

  private async htmlMemory(): Promise<string> {
    const st = await this.cb.inv<{
      enabled: boolean;
      fileCount: number;
      storePath: string;
      configTomlPath?: string;
      globalExists?: boolean;
      workspaceCount?: number;
      sessionFileCount?: number;
      legacyEntryCount?: number;
      productNote?: string;
      message?: string;
    }>("memory.status");
    const s = st.data;
    const on = Boolean(s?.enabled);
    const status =
      s?.message ?? (on ? tr("settings.memoryOn") : tr("settings.memoryOff"));
    const cwd = this.cb.getSelectedProjectPath?.();
    const browse = await this.cb.inv<{
      files: Array<{
        id: string;
        source: string;
        label: string;
        path: string;
        deletable: boolean;
        current?: boolean;
      }>;
    }>("memory.browse", { cwd });
    const files = browse.data?.files ?? [];
    const rows =
      files.length === 0
        ? `<div class="settings-row-sub">${this.cb.esc(
            on ? tr("memory.empty") : tr("memory.disabledHint"),
          )}</div>`
        : files
            .slice(0, 24)
            .map(
              (e) =>
                `<div class="settings-memory-row">
                  <div class="settings-memory-text" title="${this.cb.esc(e.path)}">
                    <span class="mono-sm">[${this.cb.esc(e.source)}]</span>
                    ${this.cb.esc(e.label)}${e.current ? ` · ${this.cb.esc(tr("memory.currentWs"))}` : ""}
                  </div>
                  ${
                    e.deletable
                      ? `<button type="button" class="btn-ghost sm" data-mem-del-path="${this.cb.esc(e.path)}">${this.cb.esc(tr("common.delete"))}</button>`
                      : ""
                  }
                </div>`,
            )
            .join("");
    return `
      <h1 class="settings-title">${this.cb.esc(tr("settings.memoryTitle"))}</h1>
      <p class="settings-desc">${this.cb.esc(tr("settings.memoryDesc"))}</p>
      <div class="settings-callout">${this.cb.esc(s?.productNote || tr("memory.productNote"))}</div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-text">
            <div class="settings-row-title">${this.cb.esc(tr("settings.memoryEnable"))}</div>
            <div class="settings-row-sub">${this.cb.esc(status)} · ${this.cb.esc(tr("settings.memoryFileCount", { n: s?.fileCount ?? 0 }))}</div>
          </div>
          <button type="button" class="settings-toggle${on ? " on" : ""}" id="cfg-memory-toggle" role="switch" aria-checked="${on}" title="${this.cb.esc(tr("settings.memoryToggle"))}"></button>
        </div>
        <div class="settings-kv"><span>${this.cb.esc(tr("settings.storePath"))}</span><span class="mono">${this.cb.esc(s?.storePath ?? "—")}</span></div>
        <div class="settings-kv"><span>${this.cb.esc(tr("settings.memoryToml"))}</span><span class="mono">${this.cb.esc(s?.configTomlPath ?? "—")}</span></div>
        <div class="settings-kv"><span>${this.cb.esc(tr("settings.memoryStats"))}</span><span>${this.cb.esc(
          tr("settings.memoryStatsVal", {
            g: s?.globalExists ? 1 : 0,
            w: s?.workspaceCount ?? 0,
            s: s?.sessionFileCount ?? 0,
          }),
        )}</span></div>
        ${
          (s?.legacyEntryCount ?? 0) > 0
            ? `<div class="settings-row-sub">${this.cb.esc(tr("settings.memoryLegacy", { n: s?.legacyEntryCount ?? 0 }))}</div>`
            : ""
        }
        <div class="settings-row-sub">${this.cb.esc(tr("settings.memoryRelaunchHint"))}</div>
      </div>
      <h2 class="settings-h2">${this.cb.esc(tr("memory.filesTitle"))}</h2>
      <div class="settings-card" id="settings-memory-list">
        ${rows}
        ${
          files.length > 24
            ? `<div class="settings-row-sub">${this.cb.esc(tr("memory.moreInSlash"))}</div>`
            : ""
        }
      </div>
      <p class="settings-desc">${this.cb.esc(tr("memory.slashHint"))}</p>
    `;
  }

  private bindMemory(root: HTMLElement): void {
    const btn = root.querySelector("#cfg-memory-toggle") as HTMLElement | null;
    btn?.addEventListener("click", async () => {
      const on = btn.classList.contains("on");
      await this.cb.inv("memory.setEnabled", { enabled: !on });
      await this.renderContent();
    });
    for (const del of Array.from(root.querySelectorAll("[data-mem-del-path]"))) {
      (del as HTMLElement).addEventListener("click", async () => {
        const pth = (del as HTMLElement).dataset.memDelPath ?? "";
        if (!pth) return;
        if (!window.confirm(tr("memory.deleteConfirm"))) return;
        await this.cb.inv("memory.deletePath", { path: pth });
        await this.renderContent();
      });
    }
  }

  // ── 快捷键 ─────────────────────────────────────────────

  private htmlShortcuts(): string {
    const rows: Array<[string, string]> = [
      ["Ctrl + P", tr("settings.sc.files")],
      ["Ctrl + T", tr("settings.sc.browser")],
      ["Ctrl + \\", tr("settings.sc.side")],
      ["Enter", tr("settings.sc.send")],
      ["Esc", tr("settings.sc.esc")],
    ];
    return `
      <h1 class="settings-title">${this.cb.esc(tr("settings.shortcutsTitle"))}</h1>
      <p class="settings-desc">${this.cb.esc(tr("settings.shortcutsDesc"))}</p>
      <div class="settings-card">
        ${rows
          .map(
            ([k, v]) =>
              `<div class="settings-kv"><span>${this.cb.esc(v)}</span><kbd class="settings-kbd">${this.cb.esc(k)}</kbd></div>`,
          )
          .join("")}
      </div>
    `;
  }
}
