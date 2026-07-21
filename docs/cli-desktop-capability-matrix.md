# CLI vs Desktop 能力对照表

> **原则**：对齐 CLI 的**能力与语义**；交互可 Desktop 化。  
> **入口原则**：**不要求**每个 CLI slash 在 Desktop 都有同名 `/`；能力可在 **侧栏 / chip / 气泡 / 设置页** 体现，会话 slash 只是子集加速器。  
> **状态**：✅ 已对齐 · 🟡 部分 / 入口弱 · ❌ 未做 · — CLI 无或 Desktop 专属 · D+ Desktop 更强  
> **日期**：2026-07-21 · **源码审计**：`tmp/grok-build-main` · **session-agent P1–P3** 已落地  
> **数据目录**：Desktop 默认 `~/.grok-desktop`，与 CLI `~/.grok` **隔离**（session 格式兼容）

**图例**

| 标记 | 含义 |
|------|------|
| ✅ | Desktop 可用，语义与 CLI 基本一致（入口可为 UI 或 slash） |
| 🟡 | 有入口或 Host 能力，但语义/完整度弱于 CLI |
| ❌ | CLI 有、Desktop 基本没有（且仍值得做） |
| D+ | Desktop 更强或独有 |
| — | 不适用 / 故意不同 / 纯 TUI 不跟 |

**CLI 命令双源（审计依据）：**

| 源 | 路径 | 角色 |
|----|------|------|
| **Pager builtins** | `xai-grok-pager/src/slash/commands/mod.rs` → `builtin_commands()` | TUI 本地：会话导航、UI、fork/rewind/export/copy/queue/btw/tasks… |
| **Shell / ACP builtins** | `xai-grok-shell/src/session/slash_commands.rs` → `BUILTIN_COMMANDS` + `PROMPT_COMMANDS` | Agent 侧：compact、context、goal、memory、hooks-*、plugins、`/loop`… |
| **Shell 实现** | `session/compaction.rs`、`acp_types.rs`（`ContextInfo`/`SessionInfoData`） | compact 真管道、session-info 数据结构 |
| **Tools** | `xai-grok-tools/src/implementations/grok_build/*` | task/monitor/scheduler/update_goal/…（随 agent 二进制，两端同源） |
| **Skills** | SKILL.md `user-invocable` | 两端菜单都会出现；**解析路径不同**（见 E1） |

**欢迎共建：** 发现状态过时或漏项，请直接改本文件并发 PR，或在 [Issue](https://github.com/fanghui-li/Grok-Desktop/issues) 注明「矩阵 §编号」。见 [CONTRIBUTING](../CONTRIBUTING.md)。

**相关文档：** [架构与协议](./架构与协议.md) · Desktop `src/host/*` · `src/renderer/slash-commands.ts`

---

## 1. 输入与上下文（高频）

| # | 能力 | CLI (TUI) | Desktop | 状态 | 备注 |
|---|------|-----------|---------|------|------|
| I1 | `@` 文件/路径引用 + 补全 | 完整 file_search、chip、隐藏/`dir` | `@` 浮层 + `files.search`（含 `@!` 隐藏）+ 附件 | ✅ | 原子 chip 仍可增强 |
| I2 | `+` / 附件选文件 | 粘贴、附件探测 | `+` 菜单 + `pickFiles` + chips | 🟡 | 有显式附件 |
| I3 | `/` 斜杠命令 | Shell + Pager 双源 + skills | 仅会话命令 + skills（导航走 UI） | 🟡 | 见 §10；故意不塞导航 alias |
| I4 | 图片粘贴 / 多模态 | clipboard 探测等 | 粘贴进附件 + image 类型 | 🟡 | 链路可用；体验可再贴 CLI |
| I5 | 多行输入 / 发送 | Enter 策略完善 | Enter 发送、Shift+Enter 换行 | ✅ | |
| I6 | 停止当前 turn | 有 | 发送钮变停止 + cancel | ✅ | |
| I7 | 权限模式 | `/`、flag、运行时 | 权限 chip + `/always-approve` + `/plan` | ✅ | `/auto` 暂不做 |
| I8 | Plan 模式 | 一等公民 | chip + slash + 计划面板 | 🟡 | 有入口；工作流深度仍可加强 |
| I9 | Goal 模式 | agent 同源 | banner / chip / slash | ✅ | 可视化更好（D+）；投影条件见 A12 |
| I10 | 模型 / 推理切换 | `-m` / slash / 热切换 | chip + `/model` `/effort` + `set_model` | ✅ | 不兼容 harness 时提示新会话 |

---

## 2. 会话生命周期

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| S1 | 新会话 | `/new` 等 | 侧栏「新对话」 | ✅ | 不进 `/` |
| S2 | 继续最近 | `-c` | 侧栏「继续上次」+ `threads.continueRecent` | ✅ | 打开最近用户会话历史；发送时 attach |
| S3 | 按 ID / 搜索 resume | `-r` / `/resume` | 全局搜索：session id 精确/前缀置顶 + 归档可搜 + 打开 toast | ✅ | 不在 `/`；对齐 CLI `-r` 语义 |
| S4 | fork | `/fork`：`--worktree`/`--no-worktree`、可选首条 directive；`--at` 暂拒 | `/fork` + 侧栏 ⋯ 派生 + F2 时序 + directive + worktree 对话框 | ✅ | F2：new→detach→copy→load→directive |
| S5 | rewind | `/rewind` | 用户气泡 ↩ + `/rewind` | ✅ | ACP `_x.ai/rewind/*`；slash 与气泡双入口 |
| S6 | compact | **Shell** `BuiltinAction::Compact { user_context }`：pager 入队 `/compact [说明]` → SessionActor 真压缩（two-pass、Pre/PostCompact hooks、auto-continue）；自动约 85% | `/compact` → 确认对话框 + **可选保留说明** → `threads.compact` → ACP `_x.ai/compact_conversation` | ✅ | 与 CLI 同源管道；userContext UI 已暴露 |
| S7 | 重命名 | `/rename` `/title` | 侧栏 ⋯ | ✅ | 入口 UI；写 `summary.json` |
| S8 | 导出 | `/export [file]`，**空参=剪贴板**；路径补全 | `/export` + ⋯「复制为 Markdown」默认剪贴板；⋯「导出为文件」保存对话框 | ✅ | 默认 clipboard 对齐 CLI/Codex；无路径补全（桌面用对话框） |
| S9 | 列表/搜索 | `/resume` 选择器 + sessions | 项目树 + 全局搜索（id/标题/路径/归档） | ✅ | 仅扫 Desktop `GROK_HOME`（故意隔离） |
| S10 | 归档 | CLI 弱 | 项目下归档夹 | D+ | |
| S11 | 删除 | 手动/工具 | 活动/归档 ⋯ 均可删 | ✅/D+ | 活动会话也可删 |
| S12 | 会话目录 | `~/.grok/sessions` | `~/.grok-desktop/sessions` | — | **目录隔离**；格式兼容 |
| S13 | 会话磁盘格式 | `summary.json` / `chat_history.jsonl` / updates 等 | 同 schema（agent 落盘） | ✅ | Host 不另起 schema；历史回放读 jsonl |
| S14 | 跨端会话互通 | 同 `~/.grok` 内 CLI/TUI 互通 | 默认**看不到** CLI 会话 | — | 故意隔离；共享 home 才互通 |
| S15 | 历史回放路径 | load 时 ACP 回放 + TUI live | 磁盘 jsonl：user/tool/thought/assistant/system 连贯回放；attach 期挂起直播 | ✅ | Mode B 无 load live buffer；避免叠双份 |
| S16 | 复制最近回复 | `/copy [n]` | 用户/助手气泡复制按钮 | ✅ | 能力在 UI；无 `/copy` slash（不必强求） |
| S17 | 本会话 prompt 历史检索 | `/history` → `OpenHistorySearch` 浮层 + ↑ 召回 | `/history` 搜索插入 + 空输入 ↑/↓ 召回；打开会话从 user 消息 seed | ✅ | 本地列表（非 agent `prompt_history` wire）；跨会话不共享 |
| S18 | 会话信息 | Shell `/session-info`（alias status/info）→ `SessionInfoData`：model、turns、`ContextInfo` 分类明细 | `/status` → `threads.sessionInfo`（`_x.ai/session/info`）；未附着时本地简表 | ✅ | 附着后含 turns / fingerprint / ContextInfo；未附着回退本地 |
| S19 | 中途插话 / 队列 | `/btw`（`x.ai/btw` 旁路队列）、`/queue` 列队、`xai-prompt-queue`、mid-turn interjection | **Host L1 持久队列**（`desktop/queues/{sid}.json` + IPC）+ composer 列表 + `/btw`/`/interject` + `queue.changed` | ✅ | L2 agent wire 可选；旧 agent 仅本地 |
| S20 | 后台任务面板 | `/tasks` → 列 bg tasks + subagents + scheduled | `threads.tasksList` 四类聚合 + kill + Automations 深链 | ✅ | scheduled 绑 session；全局定时走侧栏自动化 |
| S21 | 分享会话 | `/share` → 公开 URL | 无 | ❌ | |
| S22 | recap | `/recap` → ACP `x.ai/recap`（不进对话） | 无 | ❌ | 依赖 agent 扩展事件 |
| S23 | context 明细 | Shell `/context` → 完整 `ContextInfo`（system/tools/messages/categories/auto-compact 阈值） | `/context` + chip：优先 session/info；失败回退 `signals.json` | ✅ | 含 system/tools/messages、categories、auto-compact 阈值 |

---

## 3. 项目 / Worktree / 工作区

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| P1 | 绑定 cwd / 项目 | `--cwd` | 项目列表 + chip | ✅ | trust 门禁 |
| P2 | 多项目切换 | 换目录 | 侧栏多项目 | D+ | |
| P3 | Worktree | `-w` / agent 池 / fork 询问 | Host git worktree + fork 对话框 + `worktreeApi: true` | 🟡 | 旁路 git；非 agent 池 |
| P4 | inspect | `grok inspect` | 无对等页 | ❌ | |
| P5 | AGENTS.md | 自动 | 随 agent cwd | ✅ | |
| P6 | 无项目模式 | 任意 cwd | 支持 | ✅ | |

---

## 4. Agent 运行时与工具

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| A1 | ACP / stdio agent | 原生 | Host spawn + ACP | ✅ | agent-bin / 安装包 / PATH；同源 `grok agent stdio` |
| A2 | 工具调用展示 | 可折叠步骤 | 直播 + 历史回放过程块 | ✅ | 默认折叠 |
| A3 | 权限审批 | 交互 | permission-bar + Inbox | ✅ | |
| A4 | Sandbox | flags / 配置 | 设置入口弱 | 🟡 | |
| A5 | 细粒度禁用联网等 | flags | 无 UI | ❌ | |
| A6 | Subagent 树 / 进度 | `SubagentSpawned/Progress/Finished` + TUI | 归一化 + `subagents.json` 投影 + 侧栏树 + toast | ✅ | Host 投影 + 侧栏「子代理」分类实时树 |
| A7 | best-of-n 等 | headless | 无 | ❌ | |
| A8 | effort / max-turns | flags / `/effort` | chip + `/effort` + `_meta.reasoningEffort`；`/max-turns` → 新会话 `_meta.maxTurns` | ✅ | stdio agent 可忽略 maxTurns meta |
| A9 | Leader / 多端 | leader 默认（Pager） | **每 Thread 一 stdio 子进程**；无 leader | — | **产品决策 Mode B**（见 §11）；非回归 |
| A10 | 后台 / monitor | 有 + auto-wake + `/tasks` | `task.updated` + 过程区/toast + 失败 Inbox | ✅ | 事件齐；任务面板见 S20 |
| A11 | Plan 退出审批 | `x.ai/exit_plan_mode` | 同 reverse request + 面板 | ✅ | |
| A12 | Goal 运行时事件 | shell `/goal`：set / status / pause / resume / clear + **`--budget`** | slash + banner + 首启写 `goal.json`；set/status/clear/**pause/resume/budget** | ✅ | UI 更强；`--budget` 解析 + 弹窗 |
| A13 | YOLO / always-approve | `/always-approve` toggle | chip + slash + `_meta.yoloMode` | ✅ | |
| A14 | 模型切换 wire | `session/set_model` 等 | set_model + camel 回退 | ✅ | |
| A15 | 能力探测 | leader / 工具 meta / initialize | `parseInitializeCapabilities` + runtime 信号 + `worktreeApi`/`hunkTimeline` true | ✅ | 动态合并 agent initialize |
| A16 | 打包内置 agent | CLI 安装 | agent-bin / resources/agent | D+ | 见 Y8 |
| A17 | 定时 `/loop` | shell `PROMPT_COMMANDS` + `scheduler_create` 工具；pager 亦注册 | 无同名语义（Automations 部分替代） | 🟡 | Desktop Automations ≠ CLI `/loop` 入队调度语义 |
| A18 | Memory 运行时 | shell `/memory` `/flush` `/dream`；pager `/remember`；tools `memory/*` | **对齐 CLI**：`GROK_HOME/memory` + `GROK_MEMORY`；设置开关；`/memory` 分栏浏览；`/remember`；`/flush` ACP；`/dream` prompt | ✅ | 旧 JSON 仅遗留提示；需 reattach 生效 |
| A19 | Hooks | shell hooks-trust/list/add/remove/untrust + pager `/hooks` 模态 | 设置 Hooks 页 + 本地 trust 文件；config 扫描 | 🟡 | 见 E4 |
| A20 | availableCommands | Shell 向客户端广告 builtins+skills（按 `BuiltinGate` 过滤） | 归一化 `session.available_commands` + Host 缓存 + slash 合并 agent 广告（跳过与 builtin 碰撞） | ✅ | 插入 `/name` 由用户补参发送 |
| A21 | session-info wire | `SessionInfoResponse` / GetSessionInfo 路径 | **未调** agent session-info RPC；status/context 本地拼 | 🟡 | 与 S18/S23 同源缺口 |
| A22 | Agent 内置工具面 | task/monitor/scheduler/update_goal/bash/… 同源二进制 | 同 agent 二进制即同工具集 | ✅ | 缺口在 **指挥面与事件 UI**，不在工具缺装 |

### 4.1 进程与附着模型（差异摘要）

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| R1 | 进程拓扑 | Leader 共享 agent 进程池（主） | Mode B：每 Thread 一 `grok agent stdio` | — | 隔离强、内存高；非 bug |
| R2 | 同一 session 可写者 | leader driver + 只读 subscriber | Host 内 `writable` 互斥 | 🟡 | 无跨 Host↔CLI 统一锁 |
| R3 | Attach / resume | leader `session/load` + live buffer | 懒附着 + pill 状态机 + ping + idle detach | ✅ | Mode B；打开=history_only |
| R4 | 崩溃恢复 | leader 可重连 / resume | failed 状态 + ping + 崩溃条 reattach | ✅ | 磁盘 session 不丢 |
| R5 | 多窗口同 Host | TUI 多附着策略 | 单实例 Host + 多窗口 IPC | 🟡 | 二次启动 handoff deep link |

### 4.2 ACP Client 能力与 `_meta`（差异摘要）

| # | 字段 / 能力 | CLI（常经 leader 注入） | Desktop Host | 状态 |
|---|-------------|-------------------------|--------------|------|
| M1 | `initialize.clientInfo` | TUI / leader 标识 | `grok-desktop` + `package.json` version | ✅ |
| M2 | `_meta.clientIdentifier` | 注入（如 `grok-tui`） | `grok-desktop`（`CLIENT_IDENTIFIER`） | ✅ |
| M3 | `_meta.yoloMode` | 有 | 有（`host.ts`） | ✅ |
| M4 | `_meta.modelId` | 有 | 有 | ✅ |
| M5 | `_meta.planMode` / set_mode | 有 | 有 + 显式 `session/set_mode` | ✅ |
| M6 | `_meta.reasoningEffort` | 有 | 有 | ✅ |
| M7 | `_meta.autoMode` | leader 可注入 | **未写** | ❌ |
| M8 | `_meta.codeNavEnabled` | leader 注入 | **未写** | ❌ |
| M9 | `_meta.clientTerminal` | 可 true → 终端回 TUI | **未写** | ❌ |
| M10 | `clientCapabilities.fs` | 视客户端 | `readTextFile: true, writeTextFile: false` | 🟡 |
| M11 | `clientCapabilities.terminal` | 可 true | **false**（`acp-client.ts`） | ❌ |
| M12 | `GROK_CLIENT_VERSION` 等诊断 env | 部分路径有 | spawn 时注入 app version | ✅ |
| M13 | `GROK_HOME` | 默认 `~/.grok` | 强制 `~/.grok-desktop` | — 故意 |

### 4.3 事件归一化覆盖

Host 将 ACP / x.ai 通知归一为 `NormalizedEvent`（`src/host/normalize.ts` + `acp-client.ts`）。

| # | 事件族 | CLI 产出 | Desktop 消费 | 状态 |
|---|--------|----------|--------------|------|
| N1 | message / thought / tool chunks | ✅ | `message.delta` / `thought.delta` / `tool.*` | ✅ |
| N2 | permission | ✅ | `permission.requested` + Inbox | ✅ |
| N3 | plan 审批 | ✅ | `plan.approval.requested` | ✅ |
| N4 | goal_updated | ✅ | `goal.updated` | 🟡 投影条件见 A12 |
| N5 | auto_compact_* | ✅ | `context.compacted` | ✅ |
| N6 | SubagentSpawned / Progress / Finished | ✅ | `subagent.updated` + 落盘 + 侧栏树 | ✅ | toast + subagents.json + 侧栏 Agents |
| N7 | TaskCompleted / monitor 唤醒 | ✅ | `task.updated` + toast/过程区 + willWake 提示 | ✅ | 专用 method 与 session_notification 双路径 |
| N8 | Hooks / plugins / memory dream / recap / btw 等 | ✅ 多种 | **未映射**（plugins 走 CLI 包装非事件） | ❌ | |
| N9 | agent 进程退出 | — | `agent.error` / failed | ✅ Desktop 侧 |
| N10 | prompt-queue 变更 | `QueueChanged` wire | `queue.changed` 归一 + L1 落盘 + 可选 `x.ai/queue/*` 写回 | 🟡 | 旧 agent Method not found 时仅 L1 |

---

## 5. 扩展生态

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| E1 | Skills | Shell `resolve()` 真解析 skill 为 slash（与 builtin 碰撞时 qualify） | `skills.resolve` 读 SKILL.md 真执行 prompt；失败降级插提示 | 🟡 | Desktop 路径读盘 resolve，非 shell 子进程同源 |
| E2 | Plugins / 市场 | `/plugins` 模态 + shell 子命令 | 插件页 install/enable/市场 | ✅ | CLI 同源包装 |
| E3 | MCP | `/mcps` 等 | list + add/doctor/配置入口 | ✅ | session/new 可透传 mcpServers |
| E4 | Hooks | `/hooks` + shell hooks-\* | 设置 → Hooks：扫描 + 本地 trust | 🟡 | 非 shell hooks-* 全量；信任侧文件 |
| E5 | Memory | `/memory` `/flush` `/dream` `/remember` | 设置 + 分栏浏览 + remember/flush/dream | ✅ | 真后端 `~/.grok-desktop/memory`；session 日志可删 |
| E6 | 模型列表 | `grok models` + `/model` | chip + 设置提供商 | 🟡 | 自定义供应商见 Y1 |

---

## 6. 代码审阅 / 产物

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| C1 | Diff | TUI | side-pane / diff-view | 🟡 | |
| C2 | 打开编辑器 | 有 | openInEditor / 文件链 | ✅ | |
| C3 | Hunk 时间线 | 有 | Host `changes.timeline` + `hunkTimeline: true` | 🟡 | UI 仍可加强；能力位已开 |
| C4 | Markdown | 终端有限 | prose + highlight | D+ | |
| C5 | Mermaid 等 | 部分 | 视进度 | 🟡 | |
| C6 | 集成终端 | 终端即环境 | 无；ACP `terminal: false` | ❌ | 与 M11 一致 |
| C7 | PR | 有限 | Host 有、UI 弱 | 🟡 | |

---

## 7. 设置 / 账号 / 系统

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| Y1 | 登录 / 自定义中转 | `grok login` + config | **账户与提供商双 Tab**；中转图形化 | ✅/D+ | 双通道隔离；中转必须自带 api_key；login 写 Desktop `GROK_HOME` |
| Y2 | config.toml | 全量 | 设置子集 + 可打开文件 | 🟡 | |
| Y3 | 主题 | TUI 主题 | 固定浅色（Codex 向） | ❌ | |
| Y4 | 应用更新 | `grok update` | 无自动更新 | ❌ | 靠 Releases |
| Y5 | 托盘 | 弱 | tray + hide | D+ | |
| Y6 | 无原生菜单栏 | — | 已去 | D+ | 对齐 Codex |
| Y7 | 主区圆角卡片 | — | 有 | D+ | 对齐 Codex |
| Y8 | 打包内置 agent | CLI 安装 | agent-bin → 安装包 | D+ | `sync:agent` + VERSION.txt |
| Y9 | 关于 / 诊断 | version 命令 | 设置 → 关于 | ✅ | 路径、版本、sha256 |
| Y10 | 单实例 | CLI 多进程常见 | Host 单实例 + handoff | D+ | deep link / 二次启动 |

---

## 8. Desktop 专属 / 更强

| # | 能力 | 状态 | 说明 |
|---|------|------|------|
| D1 | 左栏项目树 + 会话 | ✅ | |
| D2 | 项目下归档夹 | ✅ | |
| D3 | 可拖拽分屏 + 侧栏 | 🟡 | 文件/浏览器等 |
| D4 | Goal 进度 UI | ✅ | 可视化强于纯 TUI 文本 |
| D5 | Codex 式壳层 | ✅ | 三栏、chip、无菜单 |
| D6 | 自定义供应商一等公民 | ✅ | 拉模型、多供应商、设默认 |
| D7 | Automations / Inbox | 🟡 | Host 有，UI 深度视进度 |
| D8 | 统一 Host 事件面 | D+ | UI 只订 `NormalizedEvent`，不解析 agent 原始 JSON |
| D9 | Roster 过滤子会话噪音 | D+ | 隐藏 `subagent` / goal 基建会话（列表更干净） |
| D10 | Fork 树形侧栏 | D+ | parent/child 层级 + ⋯ 派生 |

---

## 9. 建议对齐优先级（欢迎认领）

> 排序偏 **会话能力 → agent 能力 → 对话呈现**；Worktree/Diff 面板等后置。  
> 「对齐」= **能力可用**，入口优先 UI，slash 可选。

### 会话能力（优先）

1. ~~fork / rewind 主路径（S4/S5）~~ — ✅  
2. ~~新对话 / 继续 / 重命名 / 删除·归档（S1/S2/S7/S10/S11）~~ — ✅（UI）  
3. **compact 语义贴 shell**（S6）— ✅ 已接 `_x.ai/compact_conversation`；可选 userContext UI 仍可增强
4. **export 完整度**（S8）— 剪贴板一键、内容范围  
5. **session-info / context 明细**（S18/S23/A21）— turns + `ContextInfo` 分类  
6. ~~S20 杀任务~~ — ✅（`_x.ai/task/kill`）；附着/scheduled 仍弱；S19 agent btw / N10 QueueChanged 可选

### Agent 能力

7. ~~工具展示 / 权限 / subagent / monitor 事件（A2/A3/A6/A10）~~ — ✅  
8. ~~Goal / plan 审批 / yolo / set_model（A11–A14）~~ — ✅（goal budget/pause 可再贴）  
9. ~~动态能力探测（A15/A20）~~ — ✅（消费 available_commands）  
10. ~~attach/崩溃恢复体验（R3/R4）~~ — ✅  
11. ~~Memory：对齐 CLI GROK_HOME/memory（A18/E5）~~ — ✅  
12. Skills 真解析（E1）— 或明确「插提示」为产品选择  
13. Hooks（A19/E4）— 后置  
14. ~~Leader（A9）~~ — **长期 Mode B，不作为缺口**  

### 对话呈现 / 输入（摘要）

15. 附件 / 图片粘贴体验（I2/I4）  
16. Plan 工作流深度（I8）  
17. 历史回放连贯（S15）  

### 后置

- Worktree 向导（P3）、Diff/PR 面板（C1/C7）、主题/终端/自动更新  
- share / recap / imagine*（S21/S22）— 依赖扩展与产品意愿  

### 产品决策

- 是否共享/导入 CLI `GROK_HOME`（S14）  
- 是否做 `/auto`（I7）— CLI pager 有，Desktop 可永久不做  
- Memory 与 CLI 实验 memory 是否统一存储  
- Skills 是否走 shell 同源 resolve，还是保持「插提示」  

### 保持 Desktop 领先

- 归档、多项目、Goal 条、自定义供应商、Codex 壳、fork 树形侧栏、Inbox/Automations  

---

## 10. 能力入口对照（slash ≠ 能力）

> **CLI 双源**：Pager 本地命令 + Shell/ACP builtins + Skills。  
> **Desktop**：`src/renderer/slash-commands.ts` 静态表 + 动态 skills；其余走 UI。  
> 表中 **Desktop 入口** 写实际主路径，避免「没有 slash 就判 ❌」。

### 10.1 会话生命周期 / 导航

| 能力 | CLI 入口 | Desktop 入口 | 能力状态 |
|------|----------|--------------|----------|
| 新会话 | `/new` `/clear` | 侧栏「新对话」 | ✅ |
| 回欢迎 | `/home` `/welcome` | 欢迎页 / 关会话 | ✅ — |
| 退出 | `/quit` `/exit` | 关窗 | ✅ — |
| 恢复会话 | `/resume` | 搜索 + 会话树 | 🟡 |
| 重命名 | `/rename` `/title` | ⋯ 菜单 | ✅ |
| fork | `/fork` [flags] [directive] | `/fork` + ⋯ + 树 | ✅（参数弱） |
| rewind | `/rewind` | 气泡 + `/rewind` | ✅ |
| compact | shell `/compact [ctx]` 入队 | `/compact` → ACP compact_conversation | ✅ |
| export | `/export [file\|clip]` | `/export` 剪贴板 + ⋯ 文件 | ✅ |
| session-info | shell `/session-info` | `/status` → session/info | ✅ |
| context | shell `/context` 全量 | chip + `/context`（session/info） | ✅ |
| 复制回复 | `/copy [n]` | 气泡复制 | ✅ |
| prompt 历史 | `/history` | `/history` + ↑ 召回 | ✅ |
| 归档/删除 | 弱 | ⋯ + 归档夹 | D+ |

### 10.2 模型 / 权限 / 模式

| 能力 | CLI | Desktop | 状态 |
|------|-----|---------|------|
| 模型 | `/model` `/m` | chip + `/model` | ✅ |
| effort | `/effort` | chip + `/effort` | ✅ |
| always-approve | `/always-approve` `/yolo` | chip + slash | ✅ |
| auto 权限 | `/auto` + Shift+Tab | **不做** | — / ❌ 产品决策 |
| plan | `/plan` `/view-plan` | chip + slash + 面板 | 🟡 深度 |
| goal | shell `/goal … [--budget]` | slash + banner（无 budget） | ✅ / 🟡 参数 |
| multiline | `/multiline` | Shift+Enter 换行（固定） | ✅ — |

### 10.3 Agent 扩展 / 生态

| 能力 | CLI | Desktop | 状态 |
|------|-----|---------|------|
| skills 调用 | shell resolve skill | 动态 slash **插提示** | 🟡 |
| plugins | `/plugins` 模态 | 插件页 | ✅ |
| marketplace | `/marketplace` | 插件页 | ✅ |
| mcp | `/mcps` 等 | 设置/插件 MCP | ✅ |
| hooks | hooks-\* + `/hooks` | — | ❌ |
| memory | `/memory` `/flush` `/dream` `/remember` | 设置 + `/memory` 分栏 + `/remember` + `/flush` + `/dream`（CLI 同源目录） | ✅ |
| loop/定时 | `/loop` → scheduler | Automations 部分 | 🟡 |
| tasks | `/tasks` | 列表 + **停止**（`_x.ai/task/kill`） | ✅ |
| queue / btw | `/queue` `/btw` | 可编辑队列 + `/btw` 侧问卡片 + `/interject` | 🟡 |
| imagine* | `/imagine` `/imagine-video` | — | ❌ |
| share / recap | `/share` `/recap` | — | ❌ |
| personas / config-agents | pager 有 | — | ❌ 低优 |
| import-claude | pager 有 | — | ❌ 低优 |
| usage / feedback | pager 有 | 弱/无 | 🟡 低优 |

### 10.4 纯 TUI / 壳层（Desktop 不跟）

`/vim-mode` · `/minimal` · `/fullscreen` · `/compact-mode` · `/theme` · `/timestamps` · `/terminal-setup` · `/voice` · scroll/debug 类 · `/gboom` · `/toggle-mouse-reporting` 等 → 状态 **—**

### 10.5 Desktop 静态 slash 清单（实现真相 · `slash-commands.ts`）

| 命令 | 状态 | 备注 |
|------|------|------|
| `/always-approve` | ✅ | |
| `/plan` `/view-plan` | ✅ / 🟡 | |
| `/goal` `/goal-status` `/goal-clear` | ✅ | 无 pause/resume/budget |
| `/model` `/effort` | ✅ | |
| `/context` | ✅ | session/info ContextInfo；回退 signals |
| `/compact` | ✅ | `_x.ai/compact_conversation` |
| `/export` | ✅ | 默认剪贴板；⋯ 可存文件 |
| `/fork` | ✅ | 无 worktree/directive |
| `/rewind` | ✅ | |
| `/status` | ✅ | SessionInfoData（附着后） |

动态：skills → 插提示 🟡  

---

## 11. 原则映射

| 原则 | 本表 |
|------|------|
| 能力对齐，非 slash 列表对齐 | §10 入口列；§9 按能力排 |
| 语义对齐 | plan / goal / 权限 / ACP（§4）；compact 已接 S6 |
| 目录策略 | `~/.grok-desktop`（S12 / S14） |
| 进程策略 | **长期 Mode B**；Leader 不作必做项（A9 —） |
| 交互 Desktop 化 | 导航/设置/归档走 UI，不塞 `/` |
| Desktop 可更多 | §8 D+、fork 树、自定义供应商 |
| 不重写 agent | A1/A22；缺口在指挥面、事件与 meta |

---

## 12. 对齐结论（一页纸）

| 维度 | 判断 |
|------|------|
| 协议层 ACP wire | ✅ 高：同 `grok agent stdio` + JSON-RPC |
| Session 磁盘格式 | ✅ 高：同 schema，不同 `GROK_HOME` |
| 会话主路径（新/开/叉/撤/改名/删档） | ✅ 齐（入口多为 UI） |
| 会话高级（compact/export/session-info/queue/btw/interject 已接；QueueChanged 仍缺） | 🟡 |
| 单会话 turn（消息/工具/权限/plan/model） | ✅ 基本对齐 |
| Agent 内置工具（task/monitor/scheduler…） | ✅ 同源二进制即有（A22） |
| Subagent + monitor 事件 | ✅ 已落地；任务面板可选 |
| 进程拓扑 / Leader | — 故意 Mode B |
| Client meta（terminal / auto / clientId） | 🟡～❌ 弱于 CLI+leader |
| availableCommands / 动态能力 | ✅ 消费 available_commands_update + slash 合并 |
| Memory / hooks / skills 真解析 | 🟡 / ❌ / 🟡 |
| 产品互通（默认） | — 目录隔离 |

**一句话：** 会话与 agent **主路径已可用**，工具面随 agent 二进制对齐；compact/export/status/context 已接；与 CLI 的差距集中在 **memory/hooks、btw/interjection、QueueChanged wire、availableCommands 动态探测、skills 解析路径、任务杀/附着**——不是「缺一堆同名 slash」，也不是缺 task/monitor 等工具本体。

---

## 13. 审计笔记（2026-07-19 · `tmp/grok-build-main`）

### Shell builtins（`slash_commands.rs`）

| 命令 | gate | 要点 |
|------|------|------|
| compact | AlwaysOn | `user_context` 可选；真管道在 `compaction.rs` |
| always-approve | AlwaysOn | on/off |
| flush / dream / memory | Memory* | 实验 memory 后端 |
| context | AlwaysOn | 全量 ContextInfo |
| hooks-trust/list/add/remove/untrust | Hooks | |
| plugins / reload-plugins | Plugins | 子命令丰富 |
| session-info | AlwaysOn | alias status/info |
| feedback | Feedback | |
| goal | Goal | set / status / pause / resume / clear + `--budget` |
| loop | Scheduler（PROMPT_COMMANDS） | 入队调度，非本地定时器 |

### Pager 独有（节选 · 会话相关）

fork · rewind · export · copy · history · queue · btw · tasks · recap · share · remember · resume · rename · session-info（UI 侧）· transcript · find · plan/view-plan · auto · loop · imagine*

### Desktop compact 实现真相

`main.ts` `compactActiveSession()`：确认 → `threads.compact` → `AcpClient.compactConversation` → ACP `_x.ai/compact_conversation`（Shell `CompactSession` 管道）。  
不再走 `turns.prompt` 伪用户消息。UI 暂未暴露可选 `userContext` 输入框。

### Desktop status / context 实现真相

- `/status`：优先 `threads.sessionInfo`（`_x.ai/session/info` → `SessionInfoData` + `ContextInfo`）；未附着时本地简表。  
- `/context`：同 session/info 的 ContextInfo breakdown；失败回退 `signals.json` used/total。  
- CLI：同源 `SessionInfoData` + `ContextInfo`（turn_count、tool 定义 tokens、usage_categories、auto_compact_threshold_percent…）。

---

## 14. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-17 | 初版与多轮 slash / 模型 chip / rewind 等迭代 |
| 2026-07-17 | S12 更正为 `~/.grok-desktop` 隔离 |
| 2026-07-17 | 开源树恢复本表；对齐 v0.1：自定义供应商、Codex 壳、`/context`/`/view-plan`、安装包 agent；诚邀社区共维 |
| 2026-07-18 | 后台任务/monitor：`task.updated`（N7/A10）归一化 + UI toast/过程区 |
| 2026-07-18 | 侧栏 Subagent 树：`side-cat-agents` + `subagents.tree` / `subagent.updated` 增量 |
| 2026-07-18 | P0：Goal 首启投影、Subagent 事件归一化、继续上次会话 |
| 2026-07-18 | 对照 CLI 源码补充：S13–S15、§4.1–4.3（进程/meta/事件）、A11–A16、Y10/D8/D9、§12 对齐结论；细化 A6/A9/A12 与 P1 agent 项 |
| 2026-07-18 | **源码审计更新**：对照 pager `slash/commands/*` + shell `slash_commands.rs`；明确入口原则；修正 S4–S11/S16–S22、A9/A17–A19、E1/E5、§9–§12；compact 标为 prompt 近似；rewind 已进 slash；Leader 标为 Mode B 决策 |
| 2026-07-19 | **二次源码审计**：精读 compact/export/queue/btw/tasks/history/share/recap/fork、shell `ContextInfo`/`SessionInfoData`、`compaction.rs`、Desktop `compactActiveSession`/`resolve-grok`/`memory.ts`/`acp-client` initialize。新增 S23、A20–A22、N10、D10、§13 审计笔记；修正 S6/S18/S23/A12/E1 备注；§12 强调工具面同源、缺口在指挥面 |
| 2026-07-19 | **PR-A/B/C**：S6 真 compact（`_x.ai/compact_conversation`）；S8 默认剪贴板 + 文件导出；S18/S23 session/info + ContextInfo 明细 |
| 2026-07-19 | **S19/S20 v1**：本地 follow-up 队列（turn 中入队、结束后自动发、`/queue`）；`/tasks` 只读任务列表（task.updated 快照） |
| 2026-07-19 | **P1–P2**：A15/A20 availableCommands；R3/R4 崩溃条+reattach；Goal pause/resume/budget；S20 任务面板；S15 历史 thought；compact userContext；max-turns；S3/S9 搜索 resume |
| 2026-07-19 | **S20 kill + Memory**：`_x.ai/task/kill` 面板停止；Desktop 本地记忆浏览/添加/说明与 agent memory 隔离 |
| 2026-07-19 | **Memory 对齐 CLI**：`GROK_MEMORY` + `config.toml [memory]`；`GROK_HOME/memory` 浏览；`/remember` `/flush` `/dream`；废弃 JSON 主路径 |
| 2026-07-19 | **S17**：本会话 prompt 历史 `/history` 搜索插入 + 空输入 ↑/↓ 召回；打开会话从 user 消息 seed |
| 2026-07-19 | **S19 队列 UI**：全量列表编辑/上下移/删除；interrupt 暂停 + 继续发送；不做 share |
| 2026-07-19 | **S19 btw/interject**：`threads.btw`/`threads.interject` → `_x.ai/btw`/`_x.ai/interject`；侧问卡片 + 插话气泡；slash 与行内 `/btw` `/interject` |

---

**维护提示：** 改功能时顺手改对应行状态；优先改 **能力状态** 与 **Desktop 入口**，不要只为补同名 slash。Agent 协议级变更优先改 §4 / §4.1–4.3 / §12。CLI 对照以 `tmp/grok-build-main` 为准，用户指南可能滞后。
