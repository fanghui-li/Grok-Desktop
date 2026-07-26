/**
 * 模型目录缓存 / 单飞 / 登录态过滤（自 DesktopHost 迁出）。
 * 真源：CLI `grok models` + config 自定义；无硬编码幽灵官方表。
 */
import {
  listCustomProviders,
  modelDisplayNamesFromConfig,
} from "../providers.js";
import type { ModelInfo } from "../../shared/types.js";
import { mergeModelsCatalog } from "./catalog.js";

export type ModelsListServiceDeps = {
  home?: string;
  isAuthenticated: () => boolean;
  /** 异步拉 CLI 官方表；失败应返回 [] */
  fetchCliModels: () => Promise<ModelInfo[]>;
};

export class ModelsListService {
  private cache: {
    at: number;
    list: ModelInfo[];
    authenticated: boolean;
  } | null = null;
  private inFlight: {
    gen: number;
    promise: Promise<ModelInfo[]>;
  } | null = null;
  private generation = 0;
  private readonly ttlMs = 5 * 60_000;

  constructor(private readonly deps: ModelsListServiceDeps) {}

  invalidate(): void {
    this.cache = null;
    this.generation += 1;
  }

  /**
   * 同步读：仅缓存 + 自定义，**绝不** spawn。
   * 缓存失效时立刻返回自定义并触发 async refresh（由调用方 void list）。
   * @returns list + shouldBackgroundRefresh
   */
  listSync(): { list: ModelInfo[]; shouldBackgroundRefresh: boolean } {
    const authenticated = this.deps.isAuthenticated();
    if (
      this.cache &&
      this.cache.authenticated === authenticated &&
      Date.now() - this.cache.at < this.ttlMs
    ) {
      return { list: this.cache.list, shouldBackgroundRefresh: false };
    }
    const list = this.mergeWithConfig([], authenticated);
    const shouldBackgroundRefresh =
      !this.inFlight || this.inFlight.gen !== this.generation;
    return { list, shouldBackgroundRefresh };
  }

  /**
   * 异步列出可用模型。force 跳过 TTL。
   * 未登录：仅自定义，不 await 旧 flight / spawn CLI。
   */
  async list(opts?: { force?: boolean }): Promise<ModelInfo[]> {
    const authenticated = this.deps.isAuthenticated();

    if (!authenticated) {
      if (
        !opts?.force &&
        this.cache &&
        this.cache.authenticated === false &&
        Date.now() - this.cache.at < this.ttlMs
      ) {
        return this.cache.list;
      }
      const list = this.mergeWithConfig([], false);
      this.cache = {
        at: Date.now(),
        list,
        authenticated: false,
      };
      return list;
    }

    if (
      !opts?.force &&
      this.cache &&
      this.cache.authenticated === true &&
      Date.now() - this.cache.at < this.ttlMs
    ) {
      return this.cache.list;
    }

    const flight = this.inFlight;
    if (flight && flight.gen === this.generation) {
      return flight.promise;
    }

    const gen = this.generation;
    const promise = (async () => {
      const cliModels = await this.deps.fetchCliModels();
      const authNow = this.deps.isAuthenticated();
      const list = this.mergeWithConfig(authNow ? cliModels : [], authNow);
      if (gen === this.generation) {
        this.cache = {
          at: Date.now(),
          list,
          authenticated: authNow,
        };
      }
      return list;
    })().finally(() => {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null;
      }
    });
    this.inFlight = { gen, promise };
    return promise;
  }

  private mergeWithConfig(
    cliModels: ModelInfo[],
    authenticated: boolean,
  ): ModelInfo[] {
    try {
      const { providers, defaultModel } = listCustomProviders(this.deps.home);
      const names = modelDisplayNamesFromConfig(this.deps.home);
      return mergeModelsCatalog(cliModels, authenticated, {
        providers,
        defaultModel,
        displayNames: names,
      });
    } catch {
      return mergeModelsCatalog(cliModels, authenticated, {
        providers: [],
        defaultModel: null,
        displayNames: new Map(),
      });
    }
  }
}
