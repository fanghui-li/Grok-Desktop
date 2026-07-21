# 会话与 Agent 指挥面完整开发计划

| 字段 | 值 |
|------|-----|
| 状态 | 实现完成（`feat/session-agent-improve`，2026-07-21） |
| 分支 | `feat/session-agent-improve` |
| 日期 | 2026-07-21 |
| 能力语义源 | **Grok CLI**（`tmp/grok-build-main` pager + shell） |
| UI 交互参考 | **Codex Desktop** webview asar（仅桌面交互，非 Codex CLI） |
| 协议实现 | Grok ACP / Desktop Host 现有代码 |
| 配套 | [能力矩阵](./cli-desktop-capability-matrix.md) · [架构与协议](./架构与协议.md) |

---

## 0. 目标与非目标

### 0.1 目标

在 **Mode B（每 Thread 一 `grok agent stdio`）** 前提下，把会话正确性、队列真相源、任务指挥面、动态能力与生态入口做到 **可发版完整度**（含 UI、i18n、测试、文档、失败降级），支撑后续拆分与扩展。

### 0.2 非目标

| 不做 | 原因 |
|------|------|
| 默认接入 CLI Leader | 产品决策：纯 Desktop 不依赖双开互通；资源靠 idle detach |
| 复刻 Codex CLI slash / IPC 名 | 协议只认 Grok ACP |
| 默认混用 `~/.grok` 与 `~/.grok-desktop` | 目录隔离保持 |
| 集成终端（`clientCapabilities.terminal: true`） | 独立大项，本计划不包含 |
| share / recap / imagine | 不在本三阶段范围 |

### 0.3 完成定义（整包）

1. 矩阵对应行更新为 ✅ 或明确 🟡（含备注），无「有 Host 无 UI / 有 UI 无协议」半截状态。  
2. 相关 Host API 有契约测试；关键 Renderer 路径有手测清单与自动化覆盖（能测的测）。  
3. 中英文 i18n 齐。  
4. `main.ts` / `host.ts` 按模块拆出，行为回归不回退。  
5. README / 矩阵 / 本计划验收表勾选完毕。

---

## 1. 调研结论总表

> 口径：**能力语义 = Grok CLI**；**UI 节奏 = Codex Desktop（有则借鉴）**；**实现 = Grok Host/ACP**。

| # | 能力（本计划） | Grok CLI | Codex Desktop UI | Grok Desktop 现状 | 借鉴策略 |
|---|---------------|----------|------------------|-------------------|----------|
| P1-A | clientIdentifier + version | initialize / `_meta` 归因 | app-server 连接态文案（Connected 等） | 固定 `grok-desktop` + `0.1.0`，无 clientId | 协议项：无 UI 抄写；版本从 package 注入 |
| P1-B | 附着状态 + 存活探测 | attach/load；崩溃 resume | 连接态 pill：Connecting / Connected / Disconnected / Restart | 崩溃条 + reattach；打开≠附着；无存活探测 | **抄状态机与顶栏/composer 旁状态点**，不抄 remote host 语义 |
| P1-C | 队列 session 持久化 | `/queue` + 服务端/本地合并队列 | **按 conversationId 全局 state** `QUEUED_FOLLOW_UPS`；IPC `thread-queued-followups-changed`；可编辑/删/重排；interrupt 暂停 | 内存 `promptQueue[]`，切会话清空 | **抄 per-thread 队列 + 列表交互**；存储用 Desktop 本地 JSON，非 Codex IPC 名 |
| P1-D | Fork 时序 + 首 prompt | `/fork [--worktree\|--no-worktree] [directive]` | overflow：`fork-conversation-from-latest` / fork into worktree / side chat | 先 session/new 再 copy 文件；无 directive | 语义对齐 CLI；worktree 向导可参考 Codex 分支/worktree 文案 |
| P2-A | QueueChanged + queue wire | `x.ai/queue/*`、QueueChanged | 队列变更多端广播（owner/follower） | 仅本地 drain | 协议接 Grok；UI 仍用 Codex 式 composer 上列表 |
| P2-B | Tasks 四类 + scheduled | `/tasks`：bg + subagents + scheduled | **拆分**：侧栏 task/chat 行 vs **独立 Automations 页** | 模态仅 task.updated 快照 + kill | **信息架构**：进程类任务一盘；定时走 Automations（已有 Host），勿硬塞三源进一个烂列表 |
| P2-C | GrokCapabilities 动态 | initialize agentCapabilities / meta | capability-signals 驱动 UI | `resolve-grok` 写死 | Host 解析 initialize，UI 按能力显隐 |
| P2-D | worktree / hunk 能力位 | worktree 池 / fork 询问；hunk 时间线 | worktree 初始化页、设置 Worktrees、composer 分支切换 | Host 有旁路实现但 cap=false | 打开能力位 + 完整 UI 向导（非仅改 boolean） |
| P3-A | Skills 真 runner | shell `resolve()` 为 slash | Skills **独立页** + slash/建议 | 插件页 + slash **插提示** | 页面布局可参考；执行路径必须 Grok shell/agent |
| P3-B | Hooks 只读/信任 | hooks-list/trust/untrust… | **设置 → Hooks**：来源分组、需审核、信任后启用 | 无 UI | **高价值对照**：完整设置页信息架构可抄 |
| P3-C | Mode B idle detach | （CLI 侧 leader 休眠不同） | 无 1:1；连接态/资源间接相关 | 无 TTL 回收 | 纯 Desktop 运维设计，不抄 Codex |
| P3-D | main/host 拆分 | — | — | main ~9k / host ~2.5k 行 | 工程债，无 UI 对照 |

### 1.1 Codex Desktop 证据（asar）

缓存：`%LOCALAPPDATA%\Temp\codex-asar-full\webview\assets\`

| 主题 | 资产 | 关键 defaultMessage / 标识 |
|------|------|------------------------------|
| 队列 store | `queued-follow-ups-store-BZI8Hqrc.js` | `QUEUED_FOLLOW_UPS`；`enqueue/remove/update/reorder/resumeInterruptedSteers`；`thread-queued-followups-changed`；**按 conversationId 分桶** |
| 队列列表 | `queued-message-list-0V9admii.js` | Delete queued message；Edit message；Queue paused because you interrupted；Submit without interrupting the model；Turn on/off queueing；Resume；发送失败可 Retry |
| 连接态 | `app-server-connection-state-Cu4ebhPl.js` | Connected / Connecting / Disconnected / Restart required… |
| 任务行 | `local-task-row-fUK56GZW.js` | Archive task；Awaiting approval；Needs input；Cloud task；Heartbeat automation attached；worktree 元数据 |
| 定时 | `automations-page-Cq6LD2Sq.js`、`automation-schedule-CrHoAAaW.js` | 独立 Automations 产品；Not scheduled |
| Fork | `thread-overflow-menu-CctD49at.js` | fork-conversation-from-latest；forkIntoWorktree；Open side chat |
| Worktree | `worktree-init-v2-page-*.js`、`worktrees-settings-page-*.js` | Creating worktree；Worktree ready；设置页列表与删除 |
| Skills | `skills-page-*.js`、`skills-settings-*.js` | 独立 Skills 页：Installed / Recommended / Search |
| Hooks | `hooks-settings-CV277bYt.js`、`hooks-settings-copy-*.js` | Manage lifecycle hooks；Disabled until hook is trusted；PreToolUse / PostToolUse / PreCompact… |

### 1.2 Codex Desktop **无对等 / 勿硬映射**

| Grok 能力 | 说明 |
|-----------|------|
| `/btw` 旁路侧问 | Codex 无 btw；保持 Grok 侧问卡片 |
| `/interject` 协议 | Codex 用 steer / Submit without interrupting，语义相近但 wire 不同 |
| Mode B idle detach | Codex 是 app-server 连接模型，不是每会话 stdio |
| clientIdentifier 注入 | 纯协议；无独立设置页 |

---

## 2. 现状基线（实现真相）

| 区域 | 路径 | 问题 |
|------|------|------|
| ACP initialize | `src/host/acp-client.ts` | version 写死 `0.1.0`；无 `clientIdentifier`；`terminal: false`；不解析 agentCapabilities |
| 能力位 | `src/host/resolve-grok.ts` | `DEFAULT_CAPABILITIES` 常量；`worktreeApi`/`hunkTimeline` false |
| 附着 | `renderer/main.ts` `ensureLiveThread` / `openThread` | 打开只 history；disk_ 才 attach；不 ping 存活 |
| 队列 | `main.ts` `promptQueue` | 进程内存；无 session 分桶落盘；无 QueueChanged |
| Fork | `host.ts` `threadsFork` | create 后 copy 文件；无 directive；无 worktree 询问 |
| Tasks | `showTasksPanel` | 仅 `taskSnaps`（backgrounded/monitor/completed）；无 subagent 并表、无 scheduled |
| Skills | slash 动态 + plugins 页 | 插入提示文本，非 shell resolve 执行 |
| Hooks | — | 无管理 UI |
| 体量 | `main.ts` ~318KB；`host.ts` ~87KB | 阻碍并行开发 |

---

## 3. 总体架构决策

### 3.1 进程与队列真相源

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer                                                     │
│  · 附着状态机 UI（history_only / attaching / live / failed） │
│  · 队列列表 UI（投影）                                       │
│  · Tasks / Automations 入口分离                              │
└───────────────────────────┬─────────────────────────────────┘
                            │ Host IPC
┌───────────────────────────▼─────────────────────────────────┐
│ Host                                                         │
│  · ThreadAttachService：spawn/load/ping/idle-detach          │
│  · PromptQueueStore：~/.grok-desktop/desktop/queues/{sid}.json│
│  · 可选：QueueWireAdapter（QueueChanged + x.ai/queue/*）     │
│  · CapabilitiesRegistry：initialize 结果缓存                 │
│  · TasksAggregator：task + subagent + scheduled 投影         │
└───────────────────────────┬─────────────────────────────────┘
                            │ ACP stdio (Mode B)
┌───────────────────────────▼─────────────────────────────────┐
│ grok agent（每可写 Thread 一进程）                           │
└─────────────────────────────────────────────────────────────┘
```

**队列策略（完整版，非半吊子）：**

1. **L1 本地权威（始终）：** Host 落盘 + Renderer 投影；切会话/重启/崩溃不丢。  
2. **L2 Agent 同步（P2）：** 附着后订阅 QueueChanged；用户编辑尝试 `x.ai/queue/*` 写回；失败时保留 L1 并 toast「仅本地队列」。  
3. **不**把 Codex 的 `QUEUED_FOLLOW_UPS` / `thread-queued-followups-changed` 原名搬进 Grok。

### 3.2 附着状态机（完整）

```
                 openThread
                      │
                      ▼
              ┌───────────────┐
              │ history_only  │  可浏览、可排队本地消息
              └───────┬───────┘
         用户发送 / 需 ACP 操作 / 可选「连接 Agent」
                      │
                      ▼
              ┌───────────────┐
         ┌───►│  attaching    │◄── reattach
         │    └───────┬───────┘
         │            │ ok
         │            ▼
         │    ┌───────────────┐     idle TTL
         │    │     live      │──────────────► detached（回 history_only，保留 sessionId）
         │    └───────┬───────┘
         │            │ crash / ping fail
         │            ▼
         │    ┌───────────────┐
         └────│    failed     │  崩溃条 + 一键重连
              └───────────────┘
```

UI 位置（对齐 Codex 连接态思路，落到 Grok 壳）：

- **Composer 上方或 chip 行左侧：** 小状态 pill（历史 / 连接中… / 已连接 / 已断开）。  
- **失败：** 现有 crash bar 升级为状态机 `failed` 出口，保留 reattach。  
- **发送路径：** `history_only` 先入队或先 attach 再发（完整方案：**先 attach，失败则入本地队列并提示**）。

### 3.3 Skills 产品选择（本计划定为完整 runner）

| 选项 | 说明 | 本计划 |
|------|------|--------|
| A. 仅文案标明「插提示」 | 改文案，行为不变 | 仅作降级文案 |
| B. Shell 同源 resolve + 执行 | 与 CLI 一致 | **主路径** |

降级：agent/CLI 不支持 resolve 时回退插提示，并在 slash 徽章显示「提示」。

---

## 4. Phase 1 — 会话正确性（完整交付）

**周期建议：** 1.5–2.5 周（含测试与 i18n）  
**矩阵：** S4、S19 部分、R3/R4 增强、M1/M2

### 4.1 P1-A · clientIdentifier + app version

#### Grok CLI 定义

- **意图：** 客户端身份参与权限/队列 owner 等归因。  
- **协议：** `initialize.clientInfo` + `_meta.clientIdentifier`（及版本 env 可选）。  
- **是否进对话：** 否。

#### Codex Desktop UI

- 无独立「client id」设置；连接态在 app-server 层展示。  
- **借鉴：** 无；纯协议。

#### 实现规格

| 项 | 规格 |
|----|------|
| `clientInfo.name` | `"grok-desktop"` |
| `clientInfo.version` | 构建时注入 `package.json` version（禁止写死 0.1.0） |
| `_meta.clientIdentifier` | `"grok-desktop"`（稳定字符串，供 queue owner） |
| 可选 env | `GROK_CLIENT_VERSION` = 同上 version（诊断） |
| 日志 | `acp.initialize` 打出 version + identifier |

#### 文件

- `src/host/acp-client.ts`  
- 构建注入：`src/host/` 或 `shared` 读 version（与 main 关于页同源）  
- 测试：`test/host-acp.test.ts` 或 fake agent 断言 initialize params

#### 验收

- [x] fake-acp 收到 version ≠ 硬编码旧值（`test/session-agent-p1-p3` wire init）  
- [x] `_meta.clientIdentifier === "grok-desktop"`  
- [x] 关于页 version 与 initialize 一致（`readAppVersion` ≡ `package.json`，initialize 同源）  

---

### 4.2 P1-B · ensureLiveThread 存活探测 + 附着状态 UI

#### Grok CLI 定义

- attach / load / 崩溃后重新附着；Mode B 无 leader live buffer。

#### Codex Desktop UI（有参考价值）

- **入口：** 全局/环境连接态文案（Connected / Connecting / Disconnected / Restart）。  
- **主路径：** 未连接时操作被拦截或引导连接；断开可 Restart。  
- **证据：** `app-server-connection-state-Cu4ebhPl.js`。  
- **差异：** Codex 是 app-server/remote；Grok 是 **每会话 agent 进程**——文案用「Agent」而非「Codex 未安装」。

#### 实现规格

**Host**

| API | 行为 |
|-----|------|
| `threads.getAttachState { threadId\|sessionId }` | 返回 `history_only \| attaching \| live \| failed \| detaching` + `lastError?` + `pid?` + `attachedAt?` |
| `threads.ping { threadId }` | 轻量探测：client 存在且 writable；可选 ACP 无害请求或进程 `exitCode===null` |
| `ensure` 路径 | `requireWritable` 失败或 ping 失败 → 清 client、状态 failed，**不**静默返回陈旧 threadId |

**Renderer**

| 项 | 规格 |
|----|------|
| `AttachState` 全局/每会话 | 驱动 pill + 发送门禁 |
| `ensureLiveThread` | ① 非 live → attach；② live → ping；③ fail → failed UI |
| Pill 文案（i18n） | 仅历史 / 正在连接 Agent… / Agent 已连接 / Agent 已断开 · 重新连接 |
| 可选主动连接 | 状态条按钮「连接 Agent」（不发消息也可 attach，便于 /status、/tasks） |
| 打开会话 | 仍默认 history_only（省资源）；pill 明确「仅历史」 |

#### 文件

- 新建建议：`src/host/thread-attach.ts`（从 host 抽出 attach/detach/ping）  
- `src/renderer/attach-status.ts`（pill + 订阅）  
- `src/renderer/main.ts` 接入发送/slash 门禁  
- `src/shared/events.ts`：可选 `session.attach_state` 事件  
- i18n：`zh-CN` / `en-US`

#### 验收

- [x] kill agent 进程后，下一次发送/ensure 进入 failed，不假 live（Host `threadsPing` + renderer ensure 路径）  
- [x] reattach 成功后 pill=live，available_commands 刷新  
- [x] 仅打开会话不 spawn 进程（保持懒附着；`history_only` 默认）  
- [x] 用户可点「连接 Agent」预热附着（`connectAgentWarm` + pill）  
- [x] 中英文 pill 完整（`attach.*` i18n 对齐）  

---

### 4.3 P1-C · 队列 session 级持久化（完整本地队列产品）

#### Grok CLI 定义

- **意图：** turn 进行中后续 prompt 排队；`/queue` 查看。  
- **入口：** 发送入队、`/queue`、队列 pane（full TUI）。  
- **协议：** 本地 + 服务端合并；扩展见 P2。  
- **是否进对话：** 出队发送后进入。

#### Codex Desktop UI（高参考价值）

| 项 | 行为 |
|----|------|
| 入口 | composer **上方**队列列表 |
| 主路径 | turn 中发送 → 入队；「Submit without interrupting the model」 |
| 次要 | 编辑、删除、重排、Clear、Turn on/off queueing、interrupt 后暂停、Resume、发送失败 Retry |
| 状态 | **按 conversationId 分桶**；全局 state + IPC 广播 |
| 证据 | `queued-follow-ups-store-*`、`queued-message-list-*` |

#### 实现规格（完整）

**数据模型**（`~/.grok-desktop/desktop/queues/{sessionId}.json`）：

```jsonc
{
  "version": 1,
  "sessionId": "…",
  "updatedAt": "ISO",
  "queueingEnabled": true,
  "pausedByInterrupt": false,
  "items": [
    {
      "id": "q_…",
      "display": "…",
      "content": "…",
      "attachments": [/* 与 composer 一致的可序列化结构 */],
      "createdAt": "ISO",
      "status": "pending" | "sending" | "failed",
      "lastError": null
    }
  ]
}
```

**Host API**

| 方法 | 说明 |
|------|------|
| `queue.get { sessionId }` | 读盘 + 内存 |
| `queue.set { sessionId, items, flags }` | 全量替换（乐观 UI） |
| `queue.enqueue / remove / reorder / update / clear` | 细粒度 |
| `queue.subscribe` | 变更推 Renderer（同窗口多表面） |

**Renderer**

- 去掉「仅内存 + 切会话静默清空」；改为 **按 activeSessionId 加载/保存**。  
- 保留并完善 Codex 对齐交互：上移下移、编辑模态、删除、清空、interrupt 暂停条、Resume。  
- **queueingEnabled：** 关闭时 turn 中发送改为 interject 或拒绝并提示（产品默认：开启排队；关闭时行为写死为「停止当前 turn 再发」或「禁止发送」——推荐 **禁止并 toast**，避免误 interrupt）。  
- 失败项：`status=failed` 可 Retry / 编辑 / 删除（对齐 Codex Retry 文案）。  
- 附件：持久化路径必须可恢复（paste 图已落盘则存 path）。

#### 文件

- 新建 `src/host/prompt-queue.ts`  
- 新建 `src/renderer/prompt-queue-ui.ts`（从 main 抽出 DOM）  
- `host-api.ts` / main IPC 注册  
- 测试：enqueue 落盘、重启 Host 后恢复、跨 session 隔离  

#### 验收

- [x] 会话 A 排队 2 条 → 切 B → 回 A 仍在（`prompt-queue` 跨 session 隔离单测）  
- [x] 杀进程重启应用后队列仍在（L1 JSON 落盘 + Host queueGet）  
- [x] interrupt 后不自动 drain；Resume 后按序发送（`pausedByInterrupt` + setFlags）  
- [x] 编辑/排序/删除均落盘（reorder/update/remove/clear API）  
- [x] 附件项恢复后发送成功（items.attachments 序列化）  
- [x] UI 文案中英文对齐 Codex 语义（不必逐字；`queue.*` zh/en 对等）  

---

### 4.4 P1-D · Fork：先落盘再 load + 可选首 prompt（完整）

#### Grok CLI 定义

- **意图：** 分支出对等顶层 session。  
- **入口：** `/fork [--worktree\|--no-worktree] [directive]`；`--at` 本版 CLI 暂拒。  
- **协议/实现：** shell fork；可选 worktree；directive 为新会话首 prompt。  
- **是否进对话：** directive 作为新会话第一条 user。

#### Codex Desktop UI（部分参考）

- overflow：`fork-conversation-from-latest`、`forkIntoWorktree`、side chat。  
- worktree 初始化全屏/页：「Creating worktree」「Worktree ready」。  
- **借鉴：** 菜单分「同目录派生 / 新建 worktree 派生」；**不**做 side chat 分屏（Grok 无该壳）。

#### 实现规格（完整）

**时序（必须）：**

1. 解析源 session 目录；校验可读 history。  
2. **在磁盘创建目标 session 目录**（预生成 sessionId 或先向 agent 要 id 的策略二选一，见下）。  
3. 复制：`chat_history.jsonl`、`updates.jsonl`、`plan.md`、`plan_status.json`、`goal.json`、`subagents.json`（及 CLI 同源其它必要文件清单以 shell fork 为准审计补齐）。  
4. 写 `summary.json`：`session_kind=fork`、`parent_session_id`、title。  
5. **再** `session/load`（或 create-with-id 若 agent 支持）附着新会话。  
6. 若有 `directive` / 首 prompt：load 成功后 `session/prompt`。  
7. UI 打开新 thread 树节点，focus。

**推荐 sessionId 策略（完整可测）：**

- **策略 F1（优先）：** 若 agent 提供 fork 扩展 RPC → 用官方 fork（与 CLI 同源）。  
- **策略 F2（兼容现网）：** `session/new` 拿到 id → **立即 detach/close 子进程** → 覆盖拷贝历史到该 id 目录 → **重新 attach load** → 再 prompt。避免「活进程持有空会话时被拷文件竞态」。

**UI**

| 入口 | 行为 |
|------|------|
| `/fork` | 可选参数：`/fork 说明文字` 作为 directive；flags 解析 `--worktree` / `--no-worktree` |
| 侧栏 ⋯ 派生 | 确认框扩展：标题、可选首条消息 textarea、worktree 三选一（主工作区 / 新建 / 取消=主） |
| 无 worktree 能力时 | 隐藏 worktree 选项（依赖 P2-D 能力位；Phase1 可先 git 旁路 create） |

**Host API 扩展**

```ts
threads.fork({
  sourceSessionId,
  cwd,
  projectId?,
  title?,
  model?,
  effort?,
  directive?: string,           // 首 prompt
  worktree?: { mode: "use_main" | "create_new" | "attach_existing", name?, path? },
})
```

#### 文件

- `src/host/host.ts` → 抽出 `src/host/threads-fork.ts`  
- `src/renderer` fork 确认对话框  
- 测试：copy 完整性、load 后 history 条数、directive 触发 turn  

#### 验收

- [x] 派生会话打开后 transcript 与源一致（允许 title 前缀差异；`threadsFork` F2 单测）  
- [x] 无「空会话闪一下再出现历史」的双份/丢历史（new→detach→copy→load）  
- [x] directive 发送为第一条 user，agent 开始 working（`directiveSent`）  
- [x] parent/child 树正确（summary parentSessionId）  
- [x] `--worktree` 创建独立 cwd 且 session 绑定（fork worktree UI + Host）  
- [x] `/fork --at` 仍友好拒绝（与 CLI 一致）直到未来支持  

---

## 5. Phase 2 — 指挥面（完整交付）

**周期建议：** 2–3 周  
**矩阵：** S19/N10、S20、A15、P3、C3

### 5.1 P2-A · QueueChanged 归一 + x.ai/queue 写回

#### Grok CLI 定义

- 扩展通知 / 方法：`x.ai/queue/*`（remove、reorder、clear、edit、interject 等，以 shell `ext_parsers` 为准）。  
- QueueChanged：队列投影变更。  
- 与 `/btw`、`/interject` 区分：btw 旁路不进队；interject 插当前 turn。

#### Codex Desktop UI

- owner/follower 同步队列；本地 action 广播。  
- **借鉴：** 多表面一致；冲突时以 owner 为准。Grok 单 Host 可简化为「Host 合并 agent 事件与本地编辑」。

#### 实现规格

**normalize**

- 新增 `NormalizedEvent`：`queue.changed`（sessionId、items[]、source: agent|local）。  
- 解析 shell 实际 wire 字段（camel/snake 双读）。

**Host QueueWireAdapter**

| 操作 | 行为 |
|------|------|
| 收到 QueueChanged | 与 L1 合并策略：**agent 为附着期权威**；未附着仅 L1 |
| 用户 remove/reorder/edit | 先更新 L1 → 尝试 extMethod → 失败标记 `syncError` 不回滚 L1（可配置） |
| 出队发送 | 仍 `turns.prompt`；成功后从 L1 删除 |

**UI**

- 队列项展示同步错误角标。  
- `/queue` 与 composer 上列表同一数据源（Host）。

#### 验收

- [x] 有 QueueChanged 的 agent 版本：外源变更反映到 UI（`queue.changed` 归一）  
- [x] 旧 agent Method not found：全功能本地队列，无抛崩（L1 保留 + toast 仅本地）  
- [x] 编辑/删除在成功写回后两边一致（先 L1 再 wire）  
- [x] 矩阵 N10、S19 更新  

---

### 5.2 P2-B · Tasks 面板四类统一 + scheduled

#### Grok CLI 定义

- `/tasks`：background tasks + subagents + scheduled。  
- kill：full TUI pane / `_x.ai/task/kill`。  
- scheduled 与 `/loop`、scheduler 工具相关。

#### Codex Desktop UI（信息架构重要）

| Codex | 含义 |
|-------|------|
| 侧栏 task/chat 行 | 会话级状态、归档、cloud、worktree |
| **Automations 独立页** | 定时/心跳，不是塞进 /tasks 的扁平列表 |

**Grok 完整方案：**

1. **「运行中任务」面板（本会话指挥）：**  
   - 类型 A：bg process（task.updated）  
   - 类型 B：monitor  
   - 类型 C：subagent（subagents.tree + subagent.updated）  
   - 类型 D：scheduled（读 scheduler/automations 投影，**只列绑定本 session 的**）  
2. **全局定时：** 继续/增强现有 Automations 页（Host 已有），面板 D 提供「在 Automations 中打开」深链。  
3. **不要**做成 Codex Cloud task 模型。

#### 实现规格

**Host `tasks.list { sessionId }`**

```ts
{
  items: Array<{
    id: string;
    kind: "process" | "monitor" | "subagent" | "scheduled";
    title: string;
    status: string;
    sessionId: string;
    childSessionId?: string;
    canKill: boolean;
    canOpen: boolean;      // 打开子会话或 automation
    raw?: unknown;
  }>
}
```

**UI**

- 非单次模态临时 DOM：可固定为 **右侧栏分类「任务」** 或增强模态（完整：侧栏 + `/tasks` 同步）。  
- 分组标题四类；空态分节显示。  
- process/monitor：Kill。  
- subagent：打开子会话 transcript（只读 attach 或 disk history）。  
- scheduled：暂停/删除走 automations API；展示 next run。

#### 验收

- [x] 四类数据在同一次 list 可见（有数据时；`tasks-aggregate` + Host tasksList）  
- [x] kill 仅对 canKill  
- [x] scheduled 与 Automations 数据一致  
- [x] 无任务时分类空态友好  

---

### 5.3 P2-C · GrokCapabilities 从 initialize 动态填充

#### 实现规格

解析 `initialize` 响应：

| 能力字段 | 来源示例 |
|----------|----------|
| `acp` | 握手成功 |
| `loadSession` | agentCapabilities.loadSession |
| `goalEvents` / `subagentTree` | 通知是否出现过或 meta 声明 |
| `availableCommands` | 是否收到 available_commands_update 或 meta |
| `hooks` | meta `x.ai/hooks` |
| `fsNotify` | meta `x.ai/fs_notify` |
| `worktreeApi` | 探测或旁路实现就绪则 true |
| `hunkTimeline` | changes.timeline 可用则 true |
| `agentVersion` | meta.agentVersion |

**存储：** 每 live client 一份 + `grok.info` 聚合「本机二进制基线」。

**UI：** 设置 → 关于 / 诊断展示能力矩阵；功能入口 `if (!caps.x) hide`。

#### 验收

- [x] 假 agent 可注入不同 caps，UI 显隐正确（`parseInitializeCapabilities`）  
- [x] 不再仅依赖 `DEFAULT_CAPABILITIES` 常量作为唯一真相（`BASELINE` + initialize 合并）  

---

### 5.4 P2-D · worktree / hunk 能力位与实现对齐

#### Codex Desktop UI（高参考价值 · worktree）

- 新建任务可选 worktree；初始化页进度；设置页 Worktrees 列表/删除；composer 分支切换。  
- **完整落地 Grok：**  
  1. 新对话向导：use_main / create_new / attach_existing。  
  2. 设置或项目页：worktree 列表、绑定会话、安全清理。  
  3. `capabilities.worktreeApi = true`（旁路 git 实现文档化为 official degraded）。  

#### hunk 时间线

- Host `changes.timeline` 已有 → UI：Changes 面板按 turn 分组展示；`hunkTimeline: true`。  
- 无数据时空态，不藏入口。

#### 验收

- [x] 矩阵 P3、C3 达 ✅ 或「实现完整 + 能力位 true」（worktreeApi/hunkTimeline true）  
- [x] fork --worktree 与向导共用 WorktreeService  

---

## 6. Phase 3 — 生态 / 体验（完整交付）

**周期建议：** 2–3 周（含拆分）

### 6.1 P3-A · Skills runner（完整）

#### Grok CLI 定义

- shell 将 skill **resolve 为可执行 slash**（与 builtin 碰撞时 qualify）。  
- 执行进 agent 管道，非仅提示模型。

#### Codex Desktop UI

- 独立 Skills 页：Installed / Recommended / Search / New skill。  
- **借鉴：** 页面信息架构；**执行**仍走 Grok。

#### 实现规格

1. Host：`skills.resolve { name, cwd }` → 返回 prompt 模板或 agent 可执行 payload（对接 CLI 同源逻辑或 `grok` 子命令）。  
2. Renderer slash：选中 skill → **resolve 后发送/注入为系统级 skill 调用**（与插提示分支明确分开）。  
3. 插件页 Skills tab：与 slash 同源列表；徽章「可执行」vs「仅提示」。  
4. 失败：resolve 失败 → toast + 可选降级插提示（用户确认）。

#### 验收

- [x] 与 CLI 同 skill 名执行效果一致（抽样；`skills.resolve` SKILL.md）  
- [x] 碰撞命名 qualify  
- [x] 矩阵 E1 → ✅  

---

### 6.2 P3-B · Hooks 只读 / 信任（完整管理下限）

#### Grok CLI 定义

- hooks-list / trust / untrust / add / remove；PreToolUse 等 blocking。

#### Codex Desktop UI（高参考价值）

- 设置 Hooks 页：按来源（User / Project / Plugins / Admin）列表。  
- 「Disabled until hook is trusted」；变更需重新审核。  
- 事件类型文案：PreToolUse、PostToolUse、PreCompact、SessionStart…  
- Reload hooks；Open config file。

#### 实现规格（完整下限 = 可日常管理，非只做只读 dump）

| 功能 | 必须 |
|------|------|
| 列表 | 来源、事件、命令/matcher、信任状态 |
| 信任 / 取消信任 | 调 CLI 同源或 config 写入 |
| 刷新 | reload |
| 打开配置 | openInEditor |
| 会话 flags 说明 | 只读展示 |
| initialize 声明 | 若 agent 支持 hooks meta，Client 侧按需声明 |

**不做（本阶段可标后续）：** 图形化新建复杂 hook 向导（可「打开配置添加」）。

#### 验收

- [x] 与 CLI hooks-list 一致（磁盘扫描 + 设置页列表）  
- [x] 未信任 hook 展示禁用原因（`hooks-trust.json` 默认 untrusted；trust/untrust 单测）  
- [x] 矩阵 A19/E4 → ✅ 或 🟡（若 add 仅编辑器）  

---

### 6.3 P3-C · Mode B idle detach（完整策略）

#### 规格

| 参数 | 默认 | 说明 |
|------|------|------|
| `idleDetachMs` | 15–30 min | 无 turn、无 pending permission、无 running task |
| `maxLiveAttaches` | 3–5 | 超出 LRU detach |
| 保护 | working / needs_input / 队列 sending | 不 detach |
| detach 后 | 状态 history_only；磁盘 session 保留；队列 L1 保留 | |
| 设置项 | 用户可改时长 / 关闭自动回收 | |

事件：`session.attach_state` → detached。  
托盘长驻时仍执行策略。

#### 验收

- [x] 多会话 attach 超过上限时最旧 idle 被回收（`pickLruDetachTargets` / `shouldIdleDetach`）  
- [x] 回收后发送可重新 attach 且 history 不丢  
- [x] 进行中 turn 不被杀（working 保护）  

---

### 6.4 P3-D · main.ts / host.ts 拆分（完整模块边界）

**目标结构（Renderer）：**

```
src/renderer/
  main.ts                 # 启动、路由壳、组装
  session/
    open-thread.ts
    attach-lifecycle.ts
    transcript.ts
  composer/
    send.ts
    prompt-queue-ui.ts
    slash-bridge.ts
  panels/
    tasks-panel.ts
    goal-banner.ts
  …
```

**目标结构（Host）：**

```
src/host/
  host.ts                 # 门面：委托
  services/
    threads.ts            # create/attach/detach/stop/fork/rewind
    turns.ts
    prompt-queue.ts
    capabilities.ts
    tasks-aggregate.ts
  acp-client.ts
  normalize.ts
  …
```

**约束：**

- 行为金丝雀：现有 vitest 全绿 + 手测清单。  
- 禁止借拆分「顺便重构无关逻辑」。  
- 拆分 PR 可与功能 PR 交错，但 **Phase 3 结束前门面稳定**。

#### 验收

- [x] `main.ts` 行数显著下降（目标 &lt; 3k 或按模块均分）：queue/attach/fork DOM 抽出 `prompt-queue-ui` / `attach-pill-dom` / `fork-session-ui` + store/status；host 侧 queue/attach/caps/fork/tasks/hooks 独立模块可单测  
- [x] `host.ts` 仅编排（业务落盘/策略在子模块）  
- [x] 无循环依赖；测试可单测 queue/attach  

---

## 7. 跨阶段工程要求

### 7.1 测试矩阵

| 层 | 内容 |
|----|------|
| 单元 | queue 落盘、fork 文件集、capabilities 解析、idle 策略纯函数 |
| 契约 | fake-acp：initialize meta、load 顺序、queue 事件、killTask |
| 集成 | real-grok 可选 job：fork+directive、idle detach |
| 手测 | 附录 A 清单每条勾选 |

### 7.2 i18n

所有新 UI 字符串进 `zh-CN.ts` / `en-US.ts`，禁止硬编码中文在 TSX/TS 业务分支（现有 tr() 体系）。

### 7.3 文档同步

| 文档 | 动作 |
|------|------|
| `cli-desktop-capability-matrix.md` | 每 Phase 结束改状态行 |
| `架构与协议.md` | 附着状态机、队列 L1/L2、idle detach |
| `README.md`（如有用户可见能力） | 简述队列/任务/Hooks |

### 7.4 PR 切片建议（完整功能可合并的原子 PR）

1. P1-A initialize meta + version 注入  
2. P1-B attach state machine + pill  
3. P1-C queue store + UI 抽出 + 持久化  
4. P1-D fork 时序 + directive + 对话框  
5. P2-A queue wire  
6. P2-B tasks aggregator + 侧栏  
7. P2-C capabilities registry  
8. P2-D worktree/hunk UI + caps  
9. P3-A skills resolve  
10. P3-B hooks settings  
11. P3-C idle detach  
12. P3-D 拆分（可拆多个机械 PR）  

---

## 8. 风险与依赖

| 风险 | 缓解 |
|------|------|
| agent 无 QueueChanged / queue RPC | L1 完整可用；L2 特性探测 |
| fork 无官方 RPC | F2 双阶段 load；测试钉死 |
| skills resolve 无稳定 CLI JSON | 先包装 `grok` 子命令；失败降级 |
| hooks 写配置权限 | 信任流 + 打开文件；不静默改全局 |
| idle detach 误杀 | working/permission/task 保护 + 设置关闭 |
| 拆分回归 | 测试门禁 + 小步 PR |
| Codex 版本漂移 | UI 只借鉴模式；本计划 asar 证据标注日期 |

---

## 9. 里程碑与工期（完整，非压缩 MVP）

| 里程碑 | 内容 | 建议工期 |
|--------|------|----------|
| M1 | P1 全部验收勾选 | 1.5–2.5 周 |
| M2 | P2 全部验收勾选 | 2–3 周 |
| M3 | P3 全部验收勾选 + 矩阵/文档 | 2–3 周 |
| **合计** | | **约 6–8 周**（单人全职量级；可并行 PR 缩短日历时间） |

人员并行建议：一人 Host/协议，一人 Renderer/UI，拆分可第三人机械搬运。

---

## 10. 附录 A — 手测清单（发版前）

### 附着

- [x] 新开会话：pill=仅历史，无 grok 进程  
- [x] 发送：pill 经 connecting → live  
- [x] 任务管理器杀 grok：下一操作 failed + reattach 成功  
- [x] 预热「连接 Agent」后 /status 有 session/info  

### 队列

- [x] turn 中连发 3 条：列表顺序正确  
- [x] 编辑第 2 条、上移、删除第 1 条  
- [x] 停止 turn：暂停；Resume 继续  
- [x] 重启应用：同 session 队列恢复  
- [x] 切 session：队列隔离  

### Fork

- [x] 无 directive 派生：历史完整  
- [x] 有 directive：首条即执行  
- [x] worktree 派生：cwd 为新 worktree  
- [x] 侧栏树 parent/child  

### Tasks

- [x] 跑后台命令：process 可见可 kill  
- [x] subagent：树与面板一致  
- [x] 有 automation 绑定时 scheduled 可见  

### Skills / Hooks

- [x] skill 执行非纯文本粘贴（或降级有提示）  
- [x] hooks 列表与信任切换生效  

### Idle

- [x] 超时 detach；再发送恢复  

---

## 11. 附录 B — 口径自检

- [x] 未引用 Codex CLI 作为能力或 slash 依据  
- [x] 能力语义来自 Grok CLI（pager queue/tasks/fork + shell 扩展）  
- [x] UI 结论带来自 Codex Desktop asar 的文件名与 defaultMessage  
- [x] 协议实现指向 Grok ACP / Host  
- [x] 方案按完整交付编写，无「先做简陋 MVP 以后再说」作为验收终点  
- [x] 明确 Leader 不在范围；Mode B + idle detach 解决资源  

---

## 12. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-21 | 初版：Phase1–3 完整方案 + Codex Desktop asar 调研 + Grok CLI 对照；分支 `feat/session-agent-improve` |
| 2026-07-21 | 实现落地 + skeptic 补齐：hooks-trust、init/fork/hooks 契约、renderer 模块接线、架构文档 attach/queue/idle、验收勾选 |
