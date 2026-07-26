/**
 * 模型 chip 标签 + 模型/推理菜单 DOM（整段自 main 迁出）。
 * catalog 缓存与菜单状态机在此；热切换仍经 deps 回 main。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import { effortOptions, type EffortLevel } from "./effort.js";
import {
  FALLBACK_MODELS,
  computeModelMenuPosition,
  modelDisplayName,
  modelMenuHtml as modelMenuHtmlPure,
  modelsForMenu,
  shortModelName,
  type ModelRow,
} from "./display.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ModelMenuUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  getModelLabel: () => string;
  setModelLabel: (id: string) => void;
  getDefaultModelLabel: () => string;
  setDefaultModelLabel: (id: string) => void;
  getEffortLevel: () => EffortLevel;
  setEffortLevel: (level: EffortLevel) => void;
  effortLabel: (level?: EffortLevel) => string;
  isMainShellOverlayOpen: () => boolean;
  getActiveThreadId: () => string | null;
  getActiveSessionId: () => string | null;
  applySessionModelAndEffort: (opts?: {
    modelId?: string;
    effort?: EffortLevel;
    focus?: "model" | "effort";
  }) => Promise<{ ok: boolean; message?: string }>;
  promptSetModel: () => Promise<{ ok: boolean; message?: string }>;
};

export class ModelMenuController {
  private modelsCache: ModelRow[] | null = null;
  private modelsFetch: Promise<ModelRow[]> | null = null;
  private modelMenuSeq = 0;

  constructor(private readonly deps: ModelMenuUiDeps) {}

  cache(): ModelRow[] | null {
    return this.modelsCache;
  }

  /** 兼容 main 直接赋值 modelsCache = null */
  setCache(list: ModelRow[] | null): void {
    this.modelsCache = list;
  }

  /** 登录/登出后丢弃缓存，强制重新拉可见 catalog */
  invalidateCache(): void {
    this.modelsCache = null;
    this.modelsFetch = null;
  }

  modelChipText(): string {
    const id = (this.deps.getModelLabel() || "grok").trim();
    let short = modelDisplayName(id, this.modelsCache);
    if (short === id && /^grok-/i.test(short)) {
      short = short.replace(/^grok-/i, "");
    }
    if (short.length > 18) short = short.slice(0, 16) + "…";
    return `${short} ${this.deps.effortLabel()}`;
  }

  syncLabels(): void {
    const v = this.modelChipText();
    for (const id of ["model-label", "model-label-2"] as const) {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    }
    const modelLabel = this.deps.getModelLabel();
    const effortLevel = this.deps.getEffortLevel();
    const display = modelDisplayName(modelLabel || "grok", this.modelsCache);
    const modelForTitle =
      display !== (modelLabel || "").trim()
        ? `${display} (${modelLabel})`
        : display;
    for (const id of ["btn-model", "btn-model-2"] as const) {
      const btn = document.getElementById(id);
      if (btn) {
        btn.title = tr("chat.modelTitle", {
          model: modelForTitle,
          effort: this.deps.effortLabel(),
          level: effortLevel,
        });
      }
    }
    // 侧问栏：只读展示主会话模型（无切换）
    const btwRo = document.getElementById("btw-model-readonly");
    if (btwRo) {
      btwRo.textContent = v;
      btwRo.title =
        tr("btw.modelReadonlyTitle", { model: modelForTitle }) ||
        `与主会话相同：${modelForTitle}`;
    }
  }

  hideMenu(): void {
    this.modelMenuSeq += 1;
    const menu = document.getElementById("model-menu");
    if (!menu) return;
    menu.classList.add("hidden");
    menu.innerHTML = "";
    menu.classList.remove("flyout-left");
  }

  /**
   * chip 模型须在可选目录内；否则回退默认（对齐 CLI reselect）。
   * @returns true = 未改动；false = 已回退
   */
  async ensureChipAvailable(opts?: {
    toast?: boolean;
    /** 全页设置打开时禁止 setModel（延后到 onClosed） */
    allowSetModel?: boolean;
    /** 登录/登出后强制重新拉 list */
    force?: boolean;
  }): Promise<boolean> {
    const want = (this.deps.getModelLabel() || "").trim();
    const list = await this.fetchList(
      opts?.force ? { force: true } : undefined,
    );
    if (want && list.some((m) => m.id === want)) return true;
    const prev = want || "(empty)";
    const preferred =
      (this.deps.getDefaultModelLabel() || "").trim() ||
      list.find((m) => m.isDefault)?.id?.trim() ||
      list[0]?.id?.trim() ||
      "";
    // 默认本身也可能已从目录消失时，再落到列表首项；禁止幽灵 "grok"
    const resolved = list.some((m) => m.id === preferred)
      ? preferred
      : list[0]?.id?.trim() || "";
    if (resolved === want) return true;
    this.deps.setModelLabel(resolved);
    if (resolved) this.deps.setDefaultModelLabel(resolved);
    this.syncLabels();
    // 设置/插件盖住主壳时只改 chip，不打 setModel（避免与 inert 恢复竞态）
    const canSetModel =
      opts?.allowSetModel !== false && !this.deps.isMainShellOverlayOpen();
    const activeThreadId = this.deps.getActiveThreadId();
    const activeSessionId = this.deps.getActiveSessionId();
    if (
      canSetModel &&
      resolved &&
      activeThreadId &&
      !activeThreadId.startsWith("disk_") &&
      activeSessionId
    ) {
      void this.deps
        .inv("threads.setModel", {
          threadId: activeThreadId,
          modelId: resolved,
          effort: this.deps.getEffortLevel(),
        })
        .catch(() => undefined);
    }
    if (
      opts?.toast &&
      want &&
      want !== resolved &&
      resolved &&
      !this.deps.isMainShellOverlayOpen()
    ) {
      this.deps.showToast(
        tr("model.unavailableFallback", { prev, next: resolved }),
      );
    }
    return false;
  }

  fetchList(opts?: { force?: boolean }): Promise<ModelRow[]> {
    if (opts?.force) {
      this.modelsCache = null;
      this.modelsFetch = null;
    }
    if (this.modelsFetch) return this.modelsFetch;
    this.modelsFetch = this.deps
      .inv<ModelRow[]>("models.list")
      .then((r) => {
        // 空列表合法（未登录且无自定义）；勿回落幽灵官方表
        const list = Array.isArray(r.data) ? r.data : [];
        this.modelsCache = list;
        // 列表带上 display name 后刷新 chip（否则仍显示 id）
        this.syncLabels();
        return list;
      })
      .catch(() => this.modelsCache ?? FALLBACK_MODELS)
      .finally(() => {
        this.modelsFetch = null;
      });
    return this.modelsFetch;
  }

  /** 启动后预取，首点 chip 也尽量命中缓存 */
  prefetch(): void {
    void this.fetchList();
  }

  private menuHtml(models: ModelRow[], flyoutOpen: boolean): string {
    return modelMenuHtmlPure({
      models,
      flyoutOpen,
      selectedModelId: this.deps.getModelLabel(),
      effortLevel: this.deps.getEffortLevel(),
    });
  }

  private isFlyoutOpen(menu: HTMLElement): boolean {
    const flyout = menu.querySelector(".model-menu-flyout");
    return Boolean(flyout && !flyout.classList.contains("hidden"));
  }

  private setFlyoutOpen(menu: HTMLElement, open: boolean): void {
    const flyout = menu.querySelector(
      ".model-menu-flyout",
    ) as HTMLElement | null;
    const trigger = menu.querySelector(
      "[data-open-models]",
    ) as HTMLElement | null;
    if (flyout) flyout.classList.toggle("hidden", !open);
    if (trigger) {
      trigger.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  private positionMenu(anchor: HTMLElement, menu: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const primary = menu.querySelector(
      ".model-menu-primary",
    ) as HTMLElement | null;
    const flyout = menu.querySelector(
      ".model-menu-flyout",
    ) as HTMLElement | null;
    const flyoutOpen = Boolean(
      flyout && !flyout.classList.contains("hidden"),
    );
    const pw = primary?.offsetWidth || 160;
    const ph = primary?.offsetHeight || 200;
    const fw = flyoutOpen ? flyout?.offsetWidth || 180 : 0;
    const layout = computeModelMenuPosition({
      anchor: { top: r.top, bottom: r.bottom, right: r.right },
      primaryW: pw,
      primaryH: ph,
      flyoutW: fw,
      flyoutOpen,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    });
    menu.classList.toggle("flyout-left", layout.openLeft);
    menu.style.left = `${layout.left}px`;
    menu.style.top = `${layout.top}px`;
  }

  private bindClicks(
    menu: HTMLElement,
    anchor: HTMLElement,
    seq: number,
  ): void {
    menu.onclick = (e) => {
      const t = (e.target as HTMLElement).closest(
        "[data-effort], [data-model], [data-open-models]",
      ) as HTMLElement | null;
      if (!t) return;
      if (t.hasAttribute("data-open-models")) {
        const next = !this.isFlyoutOpen(menu);
        this.setFlyoutOpen(menu, next);
        this.positionMenu(anchor, menu);
        return;
      }
      if (t.dataset.effort) {
        const id = t.dataset.effort as EffortLevel;
        this.deps.setEffortLevel(id);
        if (seq === this.modelMenuSeq) {
          const open = this.isFlyoutOpen(menu);
          menu.innerHTML = this.menuHtml(
            modelsForMenu(this.modelsCache ?? FALLBACK_MODELS),
            open,
          );
          this.positionMenu(anchor, menu);
          this.bindClicks(menu, anchor, seq);
        }
        void this.deps
          .applySessionModelAndEffort({ effort: id, focus: "effort" })
          .then((res) => {
            if (res.message)
              this.deps.showToast(res.message, res.ok ? "info" : "error");
          });
        return;
      }
      if (t.dataset.model) {
        const mid = t.dataset.model;
        this.hideMenu();
        void this.deps
          .applySessionModelAndEffort({ modelId: mid, focus: "model" })
          .then((res) => {
            if (res.message)
              this.deps.showToast(res.message, res.ok ? "info" : "error");
          });
      }
    };
  }

  /** 同步立刻弹出（用缓存/回退）；模型列表后台刷新 */
  showMenu(anchor: HTMLElement): void {
    document.getElementById("perm-menu")?.classList.add("hidden");
    const menu = document.getElementById("model-menu");
    if (!menu) return;
    const seq = ++this.modelMenuSeq;

    const paint = (list: ModelRow[], keepFlyout?: boolean) => {
      if (seq !== this.modelMenuSeq) return;
      const open = keepFlyout ? this.isFlyoutOpen(menu) : false;
      menu.innerHTML = this.menuHtml(modelsForMenu(list), open);
      menu.classList.remove("hidden");
      this.positionMenu(anchor, menu);
      this.bindClicks(menu, anchor, seq);
    };

    // 首帧：仅主菜单（侧栏收起）
    paint(this.modelsCache ?? FALLBACK_MODELS, false);

    // 后台刷新模型列表；若用户已展开侧栏则保持
    void this.fetchList().then((list) => {
      if (seq !== this.modelMenuSeq) return;
      if (menu.classList.contains("hidden")) return;
      paint(list, true);
    });
  }
}
