# Desktop Hooks 运行时（L0–L2）· 计划

> 分支：`feat/desktop-hooks-runtime`  
> 日期：2026-07-26  
> 目标：**运行时能力正确**；**不做** Hooks 全量管理台。

---

## 1. 背景与问题

| 现状 | 问题 |
|------|------|
| Agent 以 `GROK_HOME=~/.grok-desktop` 启动 | 全局 `hooks/*.json` **可能**已由 agent 执行，但未产品化保证 |
| 设置 → Hooks | `config.toml` 字符串扫描 + `desktop/hooks-trust.json` **假信任**，**不驱动** agent |
| Desktop 项目 `trust` | 与 CLI **folder-trust**（`trusted_folders.toml`）**未同步** → 项目 hooks 闸门错误 |
| 能力矩阵 X7 | 🟡 非 shell 全量；文档写「磁盘 hooks」与实现不符 |

产品选择（已确认）：

- Hooks **主要是后端 / agent 运行时**。
- Desktop **不需要**完整 Hooks 管理页。
- 需要：**全局/项目/插件 hooks 在会话中真生效**；项目闸门与「信任项目」一致；UI **诚实**。

---

## 2. 范围

### 做（L0–L2）

| 层 | 内容 |
|----|------|
| **L0** | 明确验收标准与手测剧本；保证 `hooks/` 目录存在；文档写清真源路径 |
| **L1** | **folder-trust 桥**：Desktop 信任/取消信任项目 → 写/撤 `~/.grok-desktop/trusted_folders.toml`（与 CLI 同格式、同路径约定，home=Desktop profile） |
| **L1** | 发现列表真源改为扫 `hooks/*.json`（全局 + 可选项目），**不再** config.toml 启发式 |
| **L2** | 设置页改为说明 + 打开目录 + 只读发现列表；**删除** 按 hook id 的假 trust/untrust |
| **文档** | 更新 `架构与协议.md`、能力矩阵 X7 备注 |

### 明确不做（本分支）

- Host 内重写 hook runner / PreToolUse 执行器  
- `x.ai/hooks/list|action` ACP 管理面（可后续）  
- ClientHooks  
- 单 hook enable/disable UI（`disabled-hooks` 文件留给用户/CLI）  
- Claude/Cursor 兼容 hooks 扫描（保持 `compat.*.hooks = false`）  
- 过程条 hook 注解（L3）

---

## 3. 真源对齐

```text
发现：
  全局  ~/.grok-desktop/hooks/*.json     → 始终可加载（agent 侧 always trusted）
  项目  <repo>/.grok/hooks/*.json        → 需 folder-trust 允许 project scope
  插件  已安装插件 hooks                 → agent 插件系统（Desktop 不二次实现）

闸门：
  Desktop 项目 trust=trusted
    → 同步 grant 到 GROK_HOME/trusted_folders.toml
  trust=untrusted
    → 同步 revoke（仅当 store 中曾 trusted 时写 deny，对齐 CLI 防 cascade 毒化）

假真源（废除运行时语义）：
  desktop/hooks-trust.json
  config.toml includes("PreToolUse")
```

Agent 读 store 路径：`$GROK_HOME/trusted_folders.toml`（Desktop 已设 `GROK_HOME`）。

---

## 4. 架构

```text
用户信任项目
    → ProjectRegistry.trust
    → Host.syncFolderTrust(path, trusted)
    → 写 ~/.grok-desktop/trusted_folders.toml

用户发消息 / 新会话
    → Agent(GROK_HOME=desktop, cwd=项目)
    → xai-grok-hooks 发现 + folder_trust.project_scope_allowed
    → 执行 hooks（运行时，非 Desktop 代码）

设置 → Hooks
    → 只读说明 + 打开 hooks 目录 + 可选磁盘扫描列表
    → 无「信任此 hook」按钮
```

---

## 5. API 变更

| 方法 | 变更 |
|------|------|
| `hooks.list` | 返回磁盘发现的 hook 文件摘要（scope/path/name）；可选 `projectPath` |
| `hooks.openDir` | **新增**：打开/创建 `GROK_HOME/hooks` |
| `hooks.trust` / `hooks.untrust` | **移除**（或保留但废弃并 no-op 并打日志——优先移除） |
| `hooks.reload` | 重扫磁盘列表（非 agent reload） |
| `projects.add` / `projects.update` | 信任变更时调用 folder-trust 同步 |

---

## 6. 验收标准

### L0（运行时存在性）

1. `ensureDesktopDirs` 后存在 `~/.grok-desktop/hooks/`（可空）。  
2. 手测剧本：在该目录放 `SessionStart` 示例 JSON，Desktop 新会话后副作用可见（或 Host 日志/文件证明 agent 已加载——见任务文档手测节）。  
3. 文档写明路径与「无需设置页即可生效」。

### L1（闸门正确）

1. 信任项目后，`trusted_folders.toml` 出现对应 key 且 `trusted = true`。  
2. 取消信任后，对应记录为 untrusted 或符合 CLI revoke 语义。  
3. 单测：folder-trust 读写 roundtrip；项目 update trust 触发同步。  
4. 列表 API 能列出 `hooks/*.json`，不再依赖 config.toml 事件名字符串。

### L2（诚实 UI）

1. 设置 Hooks 页无「信任/取消信任」单 hook 按钮。  
2. 有打开目录 + 说明文案（中英）。  
3. 旧 `hooks-trust.json` 不再被 Host 读写驱动 UI。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| workspace_key 与 CLI git 根不一致 | Desktop 用「向上找 `.git` 目录」近似；文档注明与 CLI 极少数路径别名差异；后续可再对齐 worktree registry |
| 已开会话不感知 mid-session trust 变更 | 文案：信任变更后建议新开对话；不假装热更新 |
| 本地/dev agent `folder_trust_inert` | 手测用正式 agent-bin；单测只验 Desktop 写 store |
| 破坏旧 hooks-trust 测试 | 改写为新列表/folder-trust 测试 |

---

## 8. 参考

- CLI：`xai-grok-hooks`、`xai-grok-workspace` `trusted_folders.toml`  
- 用户指南：`tmp/grok-build-main/.../user-guide/10-hooks.md`  
- 矩阵：`docs/cli-desktop-capability-matrix.md` X7  
- 前序讨论：运行时优先、页面不做管理台  
