# Desktop Hooks 运行时 · 任务拆分

> 对应计划：`docs/hooks-runtime-plan.md`  
> 分支：`feat/desktop-hooks-runtime`

---

## 任务总览

| ID | 层 | 任务 | 验证 |
|----|----|------|------|
| T1 | L0 | `ensureDesktopDirs` 创建 `GROK_HOME/hooks` | 目录存在 |
| T2 | L1 | 新增 `folder-trust.ts`（读写 `trusted_folders.toml`） | 单测 roundtrip |
| T3 | L1 | `projectsAdd` / `projectsUpdate` 同步 folder-trust | 单测 |
| T4 | L1 | 重写 hooks 发现列表（扫 `hooks/*.json`） | 单测 |
| T5 | L1/L2 | Host API：`hooks.list` / `openDir` / `reload`；移除 trust/untrust | IPC + 类型 |
| T6 | L2 | 设置页诚实 UI + i18n | 文案无假信任 |
| T7 | 文档 | 架构与协议、能力矩阵、L0 手测清单 | 文档一致 |
| T8 | 测试 | 改写/删除旧 hooks-trust 测试；加新测 | vitest 绿 |
| T9 | L0 | 手测剧本写入计划附录（本文件 §手测） | 维护者点验 |

---

## T1 · hooks 目录（L0）

- 文件：`src/host/paths.ts`
- `ensureDesktopDirs` 增加 `mkdir hooks`
- 导出 `hooksDir(home?)`

## T2 · folder-trust 模块（L1）

- 新文件：`src/host/folder-trust.ts`
- 路径：`path.join(grokHomeDir(home), "trusted_folders.toml")`
- 格式（对齐 CLI）：

```toml
[folders."D:\\abs\\repo"]
trusted = true
decided_at = 1780000000
```

- API：
  - `folderTrustStorePath(home?)`
  - `isFolderTrusted(cwd, home?)` — 最长前缀匹配
  - `grantFolderTrust(cwd, home?)` — 写 trusted=true
  - `revokeFolderTrust(cwd, home?)` — 仅当已 trusted 时写 trusted=false
  - `workspaceKeyForCwd(cwd)` — resolve + 向上找 `.git` 父目录，否则 cwd；拒绝 home/根
- 不用新依赖：手写最小 TOML 读写（仅本 schema）

## T3 · 项目信任桥（L1）

- `DesktopHost.projectsAdd` / `projectsUpdate`：
  - trust → trusted 时 `grantFolderTrust(project.path)`
  - untrusted 时 `revokeFolderTrust(project.path)`
- `projectsAdd({ trust: true })` 同步 grant

## T4 · hooks 发现（L1）

- 重写 `src/host/hooks-trust.ts` → 可改名为逻辑仍放该文件或拆 `hooks-discover.ts`
- 删除：`scanConfigHookEvents`、`hooks-trust.json` 读写、`setHookTrusted` 运行时语义
- 新增：`listDesktopHooks(home?, opts?: { projectPath? })`：
  - 扫 `hooksDir` 下 `*.json`
  - 若 `projectPath`，扫 `<project>/.grok/hooks/*.json`（标记 scope=project，trusted=isFolderTrusted）
  - 每项：`{ id, name, path, scope: "user"|"project", trusted: boolean, source }`
  - 全局 scope trusted 恒 true（对齐 CLI 文档）
  - 项目 scope trusted = folder-trust

## T5 · Host / IPC

- `host.hooksList` / `hooksReload` / `hooksOpenDir`
- 移除 `hooksTrust` / `hooksUntrust`（main + host-api）
- `hooksOpenDir` 复用 `system.openPath` 语义或内部 createDir

## T6 · 设置 UI

- `settings-page.ts` `htmlHooks` / `bindHooks`：
  - 描述运行时真源
  - 列表只读（文件名 + scope）
  - 按钮：打开 hooks 目录、重新扫描
  - 无 trust/untrust 按钮
- i18n zh/en 更新

## T7 · 文档

- `docs/架构与协议.md` §hooks
- `docs/cli-desktop-capability-matrix.md` X7
- 本计划/任务已入库

## T8 · 测试

- 改 `test/session-agent-p1-p3.test.ts` hooks 用例
- 新测 `test/folder-trust-hooks.test.ts`（或并入现有）

## T9 · L0 手测（维护者）

见下方。

---

## 手测清单（L0 / L1）

### L0 全局 hook

1. 退出 Desktop。  
2. 创建 `%USERPROFILE%\.grok-desktop\hooks\session-log.json`（可用 CLI examples 简化版 SessionStart 写文件）。  
3. 启动 Desktop，打开任意会话发一条消息。  
4. 检查 hook 副作用文件或 agent 日志是否出现 SessionStart / 相关执行痕迹。  
5. **期望**：有运行时则副作用出现；若 agent 版本 inert/无 hooks 能力，记录版本并标 ⚠️。

### L1 项目 hook 闸门

1. 在测试仓库建 `.grok/hooks/pre.json`（PreToolUse 可 deny 或写 log）。  
2. Desktop 添加该项目且 **不信任** → 新会话跑工具 → 期望项目 hook **不**作为 project scope 生效（或 agent 跳过）。  
3. 在 UI **信任项目** → 检查 `~\.grok-desktop\trusted_folders.toml` 有条目。  
4. **新开**会话再跑 → 期望项目 hook 生效。  
5. 取消信任 → store 更新；新会话恢复跳过。

### L2 UI

1. 设置 → Hooks：无「信任/取消信任」单条按钮。  
2. 「打开 hooks 目录」打开资源管理器。  
3. 放入 json 后点重新扫描，列表出现文件名。

---

## 实现顺序（执行时）

```text
T1 → T2 → T3 → T4 → T5 → T6 → T8 → T7
（T9 手测由维护者；实现后可先跑 vitest）
```
