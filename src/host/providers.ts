/**
 * Desktop 自定义提供商（中转站）— 读写 GROK_HOME/config.toml 的 [model.*]
 * 与 OAuth auth.json 分离；有 base_url 的模型应自带 api_key，不回落 OAuth。
 */
import fs from "node:fs";
import path from "node:path";
import { HostError } from "../shared/errors.js";
import { grokHomeDir } from "./paths.js";
import { writeDesktopConfig } from "./extensibility.js";

export type ApiBackend = "chat_completions" | "responses" | "messages";

export type CustomProvider = {
  /** config 段名 model.<id> */
  id: string;
  /** 发给 API 的 model 字段 */
  model: string;
  baseUrl: string;
  name: string;
  /** 是否已配置 api_key（不回传明文） */
  hasApiKey: boolean;
  apiBackend: ApiBackend;
  isDefault: boolean;
};

export type UpsertProviderInput = {
  id: string;
  model: string;
  baseUrl: string;
  name?: string;
  /** 空字符串表示保留原 key */
  apiKey?: string;
  apiBackend?: ApiBackend;
  setAsDefault?: boolean;
  /**
   * 新建模式：若配置段 id 已存在则拒绝，避免「添加第二个」静默覆盖第一个。
   * 编辑保存不传或 false。
   */
  createOnly?: boolean;
};

function configPath(home?: string): string {
  return path.join(grokHomeDir(home), "config.toml");
}

function readText(home?: string): string {
  const p = configPath(home);
  if (!fs.existsSync(p)) return "";
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function writeText(text: string, home?: string): void {
  const p = configPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

function unquote(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function quote(v: string): string {
  return JSON.stringify(v);
}

function getModelsDefault(text: string): string | null {
  // 简单扫描 [models] 段内的 default =
  const lines = text.split(/\r?\n/);
  let inModels = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inModels = /^\[models\]\s*$/.test(trimmed);
      continue;
    }
    if (!inModels || trimmed.startsWith("#") || !trimmed) continue;
    const m = trimmed.match(/^default\s*=\s*(.+)$/);
    if (m) return unquote(m[1]);
  }
  return null;
}

function setModelsDefault(text: string, modelId: string): string {
  const lines = text.split(/\r?\n/);
  let inModels = false;
  let modelsStart = -1;
  let defaultLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[")) {
      if (/^\[models\]\s*$/.test(trimmed)) {
        inModels = true;
        modelsStart = i;
        defaultLine = -1;
      } else {
        if (inModels && defaultLine < 0) {
          // 离开 [models] 且未找到 default → 在段首插入
          lines.splice(modelsStart + 1, 0, `default = ${quote(modelId)}`);
          return lines.join("\n");
        }
        inModels = false;
      }
      continue;
    }
    if (inModels) {
      if (/^default\s*=/.test(trimmed)) {
        defaultLine = i;
        lines[i] = `default = ${quote(modelId)}`;
        return lines.join("\n");
      }
    }
  }
  if (inModels && modelsStart >= 0) {
    if (defaultLine >= 0) {
      lines[defaultLine] = `default = ${quote(modelId)}`;
    } else {
      lines.splice(modelsStart + 1, 0, `default = ${quote(modelId)}`);
    }
    return lines.join("\n");
  }
  // 无 [models] 段
  const block = `\n[models]\ndefault = ${quote(modelId)}\n`;
  return (text.trimEnd() + block + "\n").replace(/^\n+/, "");
}

type Section = {
  id: string;
  start: number; // line index of [model.id]
  end: number; // exclusive line index
  fields: Record<string, string>;
};

/** 解析 model 段 id：`[model.foo]` / `[model."a.b"]` / `[model.'a.b']` */
function parseModelHeaderId(trimmed: string): string | null {
  const m = trimmed.match(/^\[model\.(.+)\]\s*$/);
  if (!m) return null;
  let raw = m[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw.trim() || null;
}

/**
 * 段头写入：id 含 `.` 时必须用引号，否则 TOML 会把
 * `[model.my-grok-4.5]` 解析成 model.my-grok-4.5 嵌套表，agent 找不到配置。
 */
function modelSectionHeader(id: string): string {
  if (/[^a-zA-Z0-9_-]/.test(id)) {
    return `[model.${JSON.stringify(id)}]`;
  }
  return `[model.${id}]`;
}

function parseModelSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const hid = parseModelHeaderId(trimmed);
    if (hid != null && trimmed.startsWith("[model.")) {
      if (cur) {
        cur.end = i;
        sections.push(cur);
      }
      cur = { id: hid, start: i, end: lines.length, fields: {} };
      continue;
    }
    if (trimmed.startsWith("[") && cur) {
      cur.end = i;
      sections.push(cur);
      cur = null;
      continue;
    }
    if (cur && trimmed && !trimmed.startsWith("#")) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = unquote(trimmed.slice(eq + 1));
        cur.fields[key] = val;
      }
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function removeSection(text: string, id: string): string {
  const lines = text.split(/\r?\n/);
  const sections = parseModelSections(text);
  const hit = sections.find((s) => s.id === id);
  if (!hit) return text;
  lines.splice(hit.start, hit.end - hit.start);
  // 去掉多余空行
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function appendModelSection(
  text: string,
  id: string,
  fields: Record<string, string>,
): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k} = ${quote(v)}`)
    .join("\n");
  const block = `\n${modelSectionHeader(id)}\n${body}\n`;
  const base = text.trimEnd();
  return (base ? base + "\n" : "") + block;
}

function isCustomProvider(fields: Record<string, string>): boolean {
  return Boolean(fields.base_url?.trim());
}

function normalizeBackend(v?: string): ApiBackend {
  if (v === "responses" || v === "messages") return v;
  return "chat_completions";
}

function sanitizeId(raw: string): string {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || !/^[a-z0-9]/.test(id)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "提供商 id 需以字母或数字开头（可用 a-z 0-9 . _ -）",
    );
  }
  return id;
}

export function listCustomProviders(home?: string): {
  providers: CustomProvider[];
  defaultModel: string | null;
  configPath: string;
} {
  const text = readText(home);
  const def = getModelsDefault(text);
  const sections = parseModelSections(text);
  const providers: CustomProvider[] = [];
  for (const s of sections) {
    if (!isCustomProvider(s.fields)) continue;
    providers.push({
      id: s.id,
      model: s.fields.model || s.id,
      baseUrl: s.fields.base_url || "",
      name: s.fields.name || s.id,
      hasApiKey: Boolean(s.fields.api_key?.trim()),
      apiBackend: normalizeBackend(s.fields.api_backend),
      isDefault: def === s.id,
    });
  }
  return {
    providers,
    defaultModel: def,
    configPath: configPath(home),
  };
}

export function upsertCustomProvider(
  input: UpsertProviderInput,
  home?: string,
): { providers: CustomProvider[]; defaultModel: string | null } {
  const id = sanitizeId(input.id);
  const model = (input.model || id).trim();
  const baseUrl = (input.baseUrl || "").trim();
  if (!baseUrl) {
    throw new HostError("INVALID_ARGUMENT", "base_url 不能为空");
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "base_url 需以 http:// 或 https:// 开头",
    );
  }

  let text = readText(home);
  const existing = parseModelSections(text).find((s) => s.id === id);
  if (input.createOnly && existing) {
    throw new HostError(
      "INVALID_ARGUMENT",
      `配置段 id「${id}」已存在，请更换「显示名称（配置段）」后再添加`,
    );
  }
  const prevKey = existing?.fields.api_key ?? "";
  const nextKey =
    input.apiKey === undefined || input.apiKey === ""
      ? prevKey
      : input.apiKey.trim();

  if (!nextKey) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "自定义提供商必须配置 api_key（不使用 OAuth 回落）",
    );
  }

  const fields: Record<string, string> = {
    model,
    base_url: baseUrl,
    name: (input.name || id).trim(),
    api_key: nextKey,
    api_backend: normalizeBackend(input.apiBackend),
  };

  text = removeSection(text, id);
  text = appendModelSection(text, id, fields);

  if (input.setAsDefault) {
    text = setModelsDefault(text, id);
    // 同步 Desktop settings 默认模型，供新对话 chip
    writeDesktopConfig({ defaultModel: id }, home);
  }

  writeText(text, home);
  return {
    providers: listCustomProviders(home).providers,
    defaultModel: getModelsDefault(readText(home)),
  };
}

export function removeCustomProvider(
  id: string,
  home?: string,
): { providers: CustomProvider[]; defaultModel: string | null } {
  const sid = sanitizeId(id);
  let text = readText(home);
  text = removeSection(text, sid);
  const def = getModelsDefault(text);
  if (def === sid) {
    // 清掉 default 指向
    text = setModelsDefault(text, "grok");
    writeDesktopConfig({ defaultModel: "grok" }, home);
  }
  writeText(text, home);
  return {
    providers: listCustomProviders(home).providers,
    defaultModel: getModelsDefault(readText(home)),
  };
}

export function setDefaultModelId(
  modelId: string,
  home?: string,
): { defaultModel: string } {
  const id = modelId.trim();
  if (!id) throw new HostError("INVALID_ARGUMENT", "modelId 不能为空");
  let text = readText(home);
  text = setModelsDefault(text, id);
  writeText(text, home);
  writeDesktopConfig({ defaultModel: id }, home);
  return { defaultModel: id };
}

function resolveStoredApiKey(providerId: string | undefined, home?: string): string {
  if (!providerId) return "";
  try {
    const sid = sanitizeId(providerId);
    const hit = parseModelSections(readText(home)).find((s) => s.id === sid);
    return hit?.fields.api_key?.trim() ?? "";
  } catch {
    return "";
  }
}

/** OpenAI 兼容：base_url 通常已含 /v1，列表为 GET {base}/models */
export function modelsListEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new HostError("INVALID_ARGUMENT", "base_url 不能为空");
  if (/\/models$/i.test(base)) return base;
  return `${base}/models`;
}

export type ProviderPingResult = {
  ok: boolean;
  /** 往返耗时（ms） */
  latencyMs: number;
  endpoint: string;
  /** HTTP 状态；网络失败时为 undefined */
  status?: number;
  error?: string;
};

/**
 * 连通性探测：请求 GET {base}/models，统计 RTT。
 * 401/403 也算「可达」（端点活着，只是鉴权失败）。
 * 有 providerId 时从配置读 key；无 key 仍发请求。
 */
export async function pingProvider(
  opts: {
    baseUrl?: string;
    apiKey?: string;
    providerId?: string;
  },
  home?: string,
): Promise<ProviderPingResult> {
  let baseUrl = (opts.baseUrl || "").trim();
  if (!baseUrl && opts.providerId) {
    try {
      const sid = sanitizeId(opts.providerId);
      const hit = parseModelSections(readText(home)).find((s) => s.id === sid);
      baseUrl = hit?.fields.base_url?.trim() ?? "";
    } catch {
      baseUrl = "";
    }
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "base_url 需以 http:// 或 https:// 开头",
    );
  }

  let apiKey = (opts.apiKey || "").trim();
  if (!apiKey) {
    apiKey = resolveStoredApiKey(opts.providerId, home);
  }

  const endpoint = modelsListEndpoint(baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    // 读一点 body，避免连接被提前掐断影响计时；不解析
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore body errors */
    }
    const latencyMs = Math.max(0, Date.now() - t0);
    // 任意 HTTP 响应都视为网络可达
    return {
      ok: true,
      latencyMs,
      endpoint,
      status: res.status,
    };
  } catch (e) {
    const latencyMs = Math.max(0, Date.now() - t0);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      latencyMs,
      endpoint,
      error: msg,
    };
  }
}

/**
 * 拉取提供商模型列表（OpenAI GET /v1/models）。
 * apiKey 为空时可传 providerId，从已保存配置读 key。
 */
export async function listRemoteModels(
  opts: {
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
  },
  home?: string,
): Promise<{
  endpoint: string;
  models: Array<{ id: string; ownedBy?: string }>;
}> {
  const baseUrl = (opts.baseUrl || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "base_url 需以 http:// 或 https:// 开头",
    );
  }
  let apiKey = (opts.apiKey || "").trim();
  if (!apiKey) {
    apiKey = resolveStoredApiKey(opts.providerId, home);
  }
  if (!apiKey) {
    throw new HostError(
      "INVALID_ARGUMENT",
      "请先填写 API Key（或编辑已保存的提供商）后再拉取模型列表",
    );
  }

  const endpoint = modelsListEndpoint(baseUrl);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new HostError(
      "IO_ERROR",
      `请求模型列表失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new HostError(
      "IO_ERROR",
      `模型列表 HTTP ${res.status}: ${text.slice(0, 240)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new HostError("IO_ERROR", "模型列表返回非 JSON");
  }

  const models: Array<{ id: string; ownedBy?: string }> = [];
  const arr = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: unknown[] }).data as unknown[])
      : [];

  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as { id?: unknown; owned_by?: unknown };
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    models.push({
      id,
      ownedBy: typeof o.owned_by === "string" ? o.owned_by : undefined,
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { endpoint, models };
}
