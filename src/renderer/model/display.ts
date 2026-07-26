/**
 * 模型 chip / 菜单展示纯逻辑（无 DOM 状态机）。
 */
import { tr } from "../../shared/i18n/index.js";
import { effortOptions, type EffortLevel } from "./effort.js";

export type ModelRow = {
  id: string;
  name?: string;
  isDefault?: boolean;
  source?: "official" | "custom";
};

/**
 * 渲染侧**禁止**硬编码官方模型表。
 * 无缓存 / 请求失败时用空表，等 Host `models.list`。
 */
export const FALLBACK_MODELS: ModelRow[] = [];

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * CLI 对齐：展示名 = catalog name（config `name` ?? `model` ?? id）。
 * 内部切换仍用 model id。
 */
export function modelDisplayName(
  modelId: string,
  catalog: readonly ModelRow[] | null | undefined,
): string {
  const id = (modelId || "grok").trim();
  const hit = catalog?.find((m) => m.id === id);
  const n = hit?.name?.trim();
  if (n) return n;
  return id;
}

/** 短展示名：剥 grok- 前缀并截断 */
export function shortModelName(
  modelId: string,
  catalog: readonly ModelRow[] | null | undefined,
): string {
  const mid = (modelId || "grok").trim();
  let short = modelDisplayName(mid, catalog);
  if (short === mid && /^grok-/i.test(short)) {
    short = short.replace(/^grok-/i, "");
  }
  if (short.length > 18) short = short.slice(0, 16) + "…";
  return short;
}

/** chip 短标：展示名 + 推理档 */
export function modelChipText(
  modelId: string,
  effortLevel: EffortLevel,
  effortLabel: string,
  catalog: readonly ModelRow[] | null | undefined,
): string {
  const short = shortModelName(modelId, catalog);
  return `${short} ${effortLabel}`;
}

export function modelsForMenu(list: ModelRow[]): ModelRow[] {
  return list.map((m) => ({ ...m }));
}

/** 模型菜单行（对齐 CLI catalog：官方 / 自定义分组） */
export function modelMenuItemHtml(
  m: ModelRow,
  selectedModelId: string,
): string {
  const on = m.id === selectedModelId;
  const name = m.name || m.id;
  return `<button type="button" class="menu-item${on ? " is-checked" : ""}" data-model="${escHtml(m.id)}" role="menuitem">
        <span>${escHtml(name)}</span>
        <span class="menu-check" aria-hidden="true">✓</span>
      </button>`;
}

/**
 * Codex 式：主面板 = 推理 + 当前模型行(>)；
 * 模型侧栏默认收起，点击模型行才展开。
 */
export function modelMenuHtml(opts: {
  models: ModelRow[];
  flyoutOpen: boolean;
  selectedModelId: string;
  effortLevel: EffortLevel;
}): string {
  const { models, flyoutOpen, selectedModelId, effortLevel } = opts;
  const effortHtml = effortOptions()
    .map((e) => {
      const on = e.id === effortLevel;
      return `<button type="button" class="menu-item${on ? " is-checked" : ""}" data-effort="${e.id}" role="menuitem">
      <span>${escHtml(e.label)}</span>
      <span class="menu-check" aria-hidden="true">✓</span>
    </button>`;
    })
    .join("");

  const official = models.filter((m) => m.source !== "custom");
  const custom = models.filter((m) => m.source === "custom");
  let modelHtml = "";
  if (official.length && custom.length) {
    modelHtml += `<div class="menu-section-label">${escHtml(tr("model.groupOfficial"))}</div>`;
    modelHtml += official
      .map((m) => modelMenuItemHtml(m, selectedModelId))
      .join("");
    modelHtml += `<div class="menu-section-label">${escHtml(tr("model.groupCustom"))}</div>`;
    modelHtml += custom
      .map((m) => modelMenuItemHtml(m, selectedModelId))
      .join("");
  } else {
    modelHtml = models.map((m) => modelMenuItemHtml(m, selectedModelId)).join("");
  }

  return `
    <div class="model-menu-primary">
      <div class="menu-section-label">推理</div>
      ${effortHtml}
      <button type="button" class="menu-item model-menu-trigger${flyoutOpen ? " is-open" : ""}" data-open-models role="menuitem" aria-haspopup="true" aria-expanded="${flyoutOpen ? "true" : "false"}">
        <span class="model-trigger-name">${escHtml(shortModelName(selectedModelId, models))}</span>
        <span class="menu-chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <div class="model-menu-flyout${flyoutOpen ? "" : " hidden"}" role="menu" aria-label="${tr("model.pick")}">
      ${official.length && custom.length ? "" : `<div class="menu-section-label">模型</div>`}
      ${modelHtml}
    </div>`;
}

export type ModelMenuLayout = {
  left: number;
  top: number;
  openLeft: boolean;
};

/** 计算模型菜单位置（主面板 + 可选侧栏） */
export function computeModelMenuPosition(opts: {
  anchor: { top: number; bottom: number; right: number };
  primaryW: number;
  primaryH: number;
  flyoutW: number;
  flyoutOpen: boolean;
  viewportW: number;
  viewportH: number;
}): ModelMenuLayout {
  const {
    anchor: r,
    primaryW: pw,
    primaryH: ph,
    flyoutW: fw,
    flyoutOpen,
    viewportW,
    viewportH,
  } = opts;

  let left = r.right - pw;
  if (left < 8) left = 8;
  const spaceBelow = viewportH - r.bottom;
  let top: number;
  if (spaceBelow < ph + 12 && r.top > ph + 12) {
    top = Math.max(8, r.top - ph - 6);
  } else {
    top = r.bottom + 6;
  }

  const openLeft =
    flyoutOpen &&
    left + pw + 8 + fw > viewportW - 8 &&
    left - 8 - fw >= 8;
  if (openLeft) {
    const total = pw + 8 + fw;
    left = Math.max(8, r.right - total);
  }
  return { left, top, openLeft };
}

/**
 * chip 模型须在可选目录内；否则解析回退 id（不写副作用）。
 * @returns null = 当前 id 仍有效；否则为应回退到的 id
 */
export function resolveChipModelFallback(
  want: string,
  list: readonly ModelRow[],
  defaultModelLabel: string,
): string | null {
  const w = (want || "").trim();
  if (w && list.some((m) => m.id === w)) return null;
  const preferred =
    (defaultModelLabel || "").trim() ||
    list.find((m) => m.isDefault)?.id?.trim() ||
    list[0]?.id?.trim() ||
    "";
  const resolved = list.some((m) => m.id === preferred)
    ? preferred
    : list[0]?.id?.trim() || "";
  if (resolved === w) return null;
  return resolved;
}
