/**
 * 模型目录合并 / CLI 输出解析（纯逻辑，无 spawn）。
 * Host 负责登录态、缓存与 grok CLI 调用。
 */
import type { ModelInfo } from "../../shared/types.js";

export type CustomProviderRow = {
  id: string;
  name?: string;
  model?: string;
};

/**
 * 合并 CLI 官方表 + config 自定义提供商；按登录态过滤 official。
 */
export function mergeModelsCatalog(
  cliModels: ModelInfo[],
  authenticated: boolean,
  opts: {
    providers: CustomProviderRow[];
    defaultModel?: string | null;
    /** config 中的展示名（非 base_url 的 [model.*] 等） */
    displayNames?: Map<string, string> | ReadonlyMap<string, string>;
  },
): ModelInfo[] {
  const list: ModelInfo[] = cliModels.map((m) => ({ ...m }));
  const providers = opts.providers ?? [];
  const defaultModel = opts.defaultModel?.trim() || undefined;
  const names = opts.displayNames ?? new Map<string, string>();
  const customIds = new Set(providers.map((p) => p.id));

  for (const p of providers) {
    const display = (p.name || p.model || p.id).trim() || p.id;
    const hit = list.find((m) => m.id === p.id);
    if (hit) {
      hit.name = display;
      hit.source = "custom";
    } else {
      list.push({
        id: p.id,
        name: display,
        source: "custom",
      });
    }
  }
  // 非 base_url 的 [model.*] 段也写 name（若有）
  for (const [id, display] of names) {
    const hit = list.find((m) => m.id === id);
    if (hit) {
      if (!hit.name || hit.name === hit.id) hit.name = display;
    }
  }
  for (const m of list) {
    m.source = customIds.has(m.id) ? "custom" : "official";
  }

  // 未官方登录：不展示官方模型
  if (!authenticated) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].source !== "custom") list.splice(i, 1);
    }
  }

  // config `[models].default` 统一 isDefault
  if (defaultModel && list.some((m) => m.id === defaultModel)) {
    for (const m of list) m.isDefault = m.id === defaultModel;
  } else if (list.length) {
    for (const m of list) m.isDefault = false;
    list[0].isDefault = true;
  }

  // 仅当 default 仍「可见」时补行：自定义始终可补；官方仅登录后可补
  if (defaultModel && !list.some((m) => m.id === defaultModel)) {
    const isCustom = customIds.has(defaultModel);
    if (isCustom || authenticated) {
      list.unshift({
        id: defaultModel,
        name: names.get(defaultModel) || defaultModel,
        isDefault: true,
        source: isCustom ? "custom" : "official",
      });
      for (let i = 1; i < list.length; i++) list[i].isDefault = false;
    }
  }
  return list;
}

/**
 * 解析 `grok models` stdout/stderr 文本。
 * 失败或空输出 → 空表（再由 merge 并入自定义提供商）。
 */
export function parseGrokModelsCliOutput(out: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  let defaultId: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    const def = /^\s*Default model:\s*(\S+)/i.exec(line);
    if (def) defaultId = def[1];
    // "  * grok-4.5 (default)" or "  - grok-composer-2.5-fast"
    const m = /^\s*[*•-]\s+(\S+)/.exec(line);
    if (m) {
      const id = m[1].replace(/\(.*\)\s*$/, "").trim();
      if (!id || models.some((x) => x.id === id)) continue;
      models.push({
        id,
        name: id,
        // 初标 official；mergeModelsCatalog 会按 base_url 提供商改写为 custom
        source: "official",
        isDefault:
          Boolean(defaultId && id === defaultId) ||
          /\(default\)/i.test(line),
      });
    }
  }
  return models;
}
