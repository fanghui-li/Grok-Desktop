/**
 * plugins / marketplace / mcp 门面：Host 注入 CLI runner 后转发 cli.ts。
 */
import type { GrokCliRunner } from "./cli.js";
import {
  marketplaceAdd,
  marketplaceListCli,
  marketplaceRemove,
  marketplaceUpdate,
  mcpAddCli,
  mcpDoctorCli,
  mcpListCli,
  mcpRemoveCli,
  pluginsDetails,
  pluginsDisable,
  pluginsEnable,
  pluginsInstall,
  pluginsListCli,
  pluginsUninstall,
  pluginsUpdate,
} from "./cli.js";

export type PluginsFacadeDeps = {
  /** 可选 runner（list 可降级 FS） */
  grokCliRunner: () => GrokCliRunner | null;
  /** 写操作必须有 binary */
  requireGrokCli: () => GrokCliRunner;
};

export class PluginsFacade {
  constructor(private readonly deps: PluginsFacadeDeps) {}

  list(projectPath?: string, opts?: { available?: boolean }) {
    return pluginsListCli(this.deps.grokCliRunner(), {
      projectPath,
      available: opts?.available,
    });
  }

  install(source: string, opts?: { trust?: boolean }) {
    return pluginsInstall(this.deps.requireGrokCli(), source, opts);
  }

  uninstall(
    name: string,
    opts?: { confirm?: boolean; keepData?: boolean },
  ) {
    return pluginsUninstall(this.deps.requireGrokCli(), name, opts);
  }

  enable(name: string) {
    return pluginsEnable(this.deps.requireGrokCli(), name);
  }

  disable(name: string) {
    return pluginsDisable(this.deps.requireGrokCli(), name);
  }

  update(name?: string) {
    return pluginsUpdate(this.deps.requireGrokCli(), name);
  }

  details(name: string) {
    return pluginsDetails(this.deps.requireGrokCli(), name);
  }

  marketplaceList() {
    return marketplaceListCli(this.deps.requireGrokCli());
  }

  marketplaceAdd(url: string) {
    return marketplaceAdd(this.deps.requireGrokCli(), url);
  }

  marketplaceRemove(url: string) {
    return marketplaceRemove(this.deps.requireGrokCli(), url);
  }

  marketplaceUpdate(name?: string) {
    return marketplaceUpdate(this.deps.requireGrokCli(), name);
  }

  mcpList() {
    return mcpListCli(this.deps.grokCliRunner());
  }

  mcpAdd(input: {
    name: string;
    commandOrUrl?: string;
    args?: string[];
    transport?: "stdio" | "http" | "sse";
    scope?: "user" | "project";
    env?: string[];
    headers?: string[];
    cwd?: string;
  }) {
    return mcpAddCli(this.deps.requireGrokCli(), input);
  }

  mcpRemove(
    name: string,
    opts?: { scope?: "user" | "project"; cwd?: string },
  ) {
    return mcpRemoveCli(this.deps.requireGrokCli(), name, opts);
  }

  mcpDoctor(name?: string) {
    return mcpDoctorCli(this.deps.requireGrokCli(), name);
  }
}
