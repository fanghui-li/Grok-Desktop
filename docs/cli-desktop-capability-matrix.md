# CLI vs Desktop 能力矩阵（会话 / Agent 主战场）

> **原则**：对齐 CLI 的**能力与语义**；交互可 Desktop 化。  
> **工程流程（强制）**：**先调研 CLI → 再定适合 Desktop 的方案 → 再实现**（见根目录 [AGENTS.md](../AGENTS.md)）。  
> **入口原则**：**不要求**每个 CLI slash 在 Desktop 都有同名 `/`；能力可在 **侧栏 / chip / 气泡 / 设置** 体现。  
> **主战场**：会话生命周期 · turn/cancel 隔离 · 多会话焦点 · Agent ACP wire · 队列/插话。  
> **状态**：✅ 已对齐 · 🟡 部分 / 真源或验收未闭环 · ❌ 未做（仍值得做） · — 故意不同 / 不适用 · D+ Desktop 更强  
> **日期**：2026-07-22 · **CLI 树**：`tmp/grok-build-main` · **Desktop**：Mode B + Host ACP Client  
> **配套**：[架构与协议](./架构与协议.md) · [对齐计划 cancel/回合](./cli-desktop-align-plan.md)

---

## 0. 当前 Desktop 主架构（对齐基准）

```
Renderer（指挥面 UI）
  · 侧栏：对话组 + 项目树 + 会话行
  · 主区：单焦点 transcript（activeSession）
  · session-turn-store：per-session turn 投影（方案 B）
  · slash-commands：仅会话命令 + skills / agent 广告
        │ IPC（typed HostIpcMethod）
        ▼
Host（单实例 · 与 Main 同进程逻辑模块）
  · Thread 编目 / roster / thread-meta
  · 每 live Thread 一 AcpClient（Mode B）
  · L1 prompt 队列（desktop/queues/{sid}.json）
  · 归一化事件 → Renderer
        │ ACP JSON-RPC / stdio
        ▼
grok agent stdio（agent-bin / 安装包 / PATH）
  · 同源工具面（task/monitor/scheduler/…）
  · session 落盘（summary / chat_history.jsonl / …）
```

| 维度 | Desktop 现状 | CLI 对照 | 对齐策略 |
|------|--------------|----------|----------|
| 进程 | **Mode B**：每 Thread 一 `grok agent stdio` | Pager 常接 **Leader** 多 session 池 | **长期 Mode B**（隔离优先，非缺口） |
| 数据 | `GROK_HOME=~/.grok-desktop` | 默认 `~/.grok` | **故意隔离**；session schema 兼容 |
| 附着 | 懒附着：`history_only` → `attaching` → `live` | leader load + live buffer | 语义不同，产品 Mode B |
| 多会话 UI | 侧栏多会话；主区单焦点 + **per-session 投影** | `AppView.agents: IndexMap<AgentId, AgentView>` | **方案 B**：对齐「切 focus 不杀 turn」 |
| Turn 真源 | Host `isPromptInFlight` + generation gate；Renderer 投影 | `AgentView.session.state.is_turn_running/cancelling` | ✅ N1–N11 已验收 |
| Cancel | `session/cancel` **notification** + `_meta` | 同 CancelNotification | ✅ 2026-07-22 根因已修 |

**依赖方向**：Presentation → Host → Runtime/FS。禁止 Renderer spawn `grok`。

---

## 1. CLI 审计源（本表依据）

| 源 | 路径 | 角色 |
|----|------|------|
| **Pager builtins** | `xai-grok-pager/src/slash/commands/*` | TUI 本地：new/resume/fork/rewind/export/queue/btw/tasks/share/recap… |
| **Shell builtins** | `xai-grok-shell/src/session/slash_commands.rs` → `BUILTIN_COMMANDS` + `PROMPT_COMMANDS` | Agent 侧：compact、context、goal、memory、hooks-*、plugins、`/loop`… |
| **ACP Agent 扩展** | `mvp_agent/acp_agent.rs` `ext_method` | `x.ai/session/info`、compact、btw、interject、memory、recap、task/kill… |
| **Cancel wire** | shell cancel + leader tests | `session/cancel` 无 id；`_meta.cancelSubagents/cancelTrigger/cancelPromptId/rewindIfPristine` |
| **多 Agent UI** | `pager/src/app/app_view.rs` | `agents: IndexMap<AgentId, AgentView>`；`switch_to_agent` 只换焦点 |
| **队列** | `xai-prompt-queue` + `acp_session_impl/prompt_queue.rs` | `QueueChanged` wire |
| **Tools** | `xai-grok-tools` | task/monitor/scheduler/update_goal/…（两端同源二进制） |

**Shell `BUILTIN_COMMANDS`（完整）**：  
`compact` · `always-approve` · `flush` · `dream` · `memory` · `context` · `hooks-trust/list/add/remove/untrust` · `plugins` · `reload-plugins` · `session-info` · `feedback` · `goal`  

**Shell `PROMPT_COMMANDS`**：`loop`（scheduler 入队，非本地定时器）

**Pager 会话相关命令模块（节选）**：  
`new` · `home` · `resume` · `rename` · `fork` · `rewind` · `export` · `copy` · `history` · `queue` · `btw` · `tasks` · `share` · `recap` · `remember` · `plan` · `view_plan` · `model` · `effort` · `auto` · `session_info` · `context` · `compact` · `loop_cmd` · `imagine*` · `mcps` · `plugin` · …

---

## 2. 图例

| 标记 | 含义 |
|------|------|
| ✅ | 能力可用，语义与 CLI 基本一致（入口可为 UI） |
| 🟡 | 有入口，但 wire/真源/组合路径/验收未闭环 |
| ❌ | CLI 有、Desktop 基本没有，且主战场仍相关 |
| — | 故意不同 / 纯 TUI / 产品不做 |
| D+ | Desktop 更强或独有 |

---

# 主战场 A · 会话生命周期

| # | 能力 | CLI | Desktop | 状态 | 备注 / 真源 |
|---|------|-----|---------|------|-------------|
| S1 | 新会话 | `/new` 等 | 侧栏「新对话」；欢迎页发送 → `threads.create` | ✅ | keepBackground 默认不弹窗 |
| S2 | 无项目会话 | 任意 `--cwd` | chip「不使用项目」+ 侧栏 **「对话」区**；默认 `chats-workspace` | ✅ | meta `noProject`；不按 cwd 挂项目 |
| S3 | 继续最近 | `-c` | 「继续上次」+ `threads.continueRecent` | ✅ | |
| S4 | 按 ID / 搜索 resume | `-r` / `/resume` | 全局搜索 session id + 树 | ✅ | 仅扫 Desktop `GROK_HOME` |
| S5 | fork | `/fork` + worktree/directive | `/fork` + ⋯ + 树；worktree 对话框 | ✅ | 参数面略弱于 CLI |
| S6 | rewind | `/rewind` | 气泡 ↩ + `/rewind` → `_x.ai/rewind/*` | ✅ | |
| S7 | compact | Shell `/compact [ctx]` → CompactSession | `/compact` → `_x.ai/compact_conversation` | ✅ | 可选 userContext 已有确认框 |
| S8 | 重命名 | `/rename` | 侧栏 ⋯ | ✅ | thread-meta + summary |
| S9 | 导出 | `/export` 空参=剪贴板 | `/export` + ⋯ 剪贴板/文件 | ✅ | |
| S10 | 列表 / 项目树 | resume 选择器 | 对话区 + 项目树 + 归档夹 | D+ | |
| S11 | 归档 / 删除 | CLI 弱 | 归档夹 + ⋯ 删 | D+ | |
| S12 | 磁盘格式 | `sessions/<cwd>/<sid>/` | 同 schema，不同 home | ✅ | Host 不另起 schema |
| S13 | 历史回放 | load 回放 + live | jsonl 回放；attach 期挂起直播 | ✅ | Mode B 防叠双份 |
| S14 | 复制回复 | `/copy` | 气泡复制 | ✅ | 无 slash 不必强求 |
| S15 | prompt 历史 | `/history` | `/history` + ↑↓ 召回 | ✅ | 本会话本地列表 |
| S16 | session-info | Shell `/session-info` → `SessionInfoData` | `/status` → `_x.ai/session/info` | ✅ | 未附着回退本地简表 |
| S17 | context 明细 | Shell `/context` → `ContextInfo` | chip + `/context` | ✅ | 失败回退 signals.json |
| S18 | share | `/share` → URL | 无 | ❌ | 低优 |
| S19 | recap | `/recap` → `x.ai/recap` | 无 | ❌ | 扩展事件未消费 |
| S20 | 跨端互通 | 同 `~/.grok` | 默认不可见 CLI 会话 | — | 故意隔离 |

---

# 主战场 B · Turn / Cancel / 多会话隔离

> **本区是「停止混入下一对话」类 bug 的核心。**  
> **2026-07-22：负例 N1–N11 已手工验收通过**（真 agent）。回归时须重跑本表，禁止只标入口 ✅。

## B.1 单会话 Turn 与 Cancel

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| T1 | 停止当前 turn | Esc / Stop | 发送钮停止 + `turns.cancel` | ✅ | N3/N4 |
| T2 | `session/cancel` wire | **Notification**（无 JSON-RPC id） | `AcpClient.notify("session/cancel")` | ✅ | 2026-07-22：曾误用 request → Method not found |
| T3 | cancel `_meta` | `cancelSubagents` · `cancelTrigger` · `cancelPromptId` · `rewindIfPristine` | 同字段；默认 `rewindIfPristine:false` | ✅ | trigger：`stop` / `esc` / `send_now` |
| T4 | 跨 turn 流隔离 | generation / prompt 边界 | **generation gate** + 写 prompt 后开闸 | ✅ | **禁止**内容毒化；N1 |
| T5 | cancel 结算一次 | cancelled 单次终态 | `alreadyPaintedStopped` + ignore 迟到 cancelled | ✅ | N3 已验 |
| T6 | cancel join | 连点不风暴 | `cancelInFlight` join | ✅ | N8 |
| T7 | 忙时再发送 | 队列 or 打断 | `busySendMode`: queue / send_now | ✅ | N5/N6 |
| T8 | interrupt 队列 pause | 中断后 pause，Resume 再 drain | `pausedByInterrupt` + setFlags | ✅ | N7 已验；btw/L2 边角见主战场 D |
| T9 | quiet drain | cancel 后等残流安静 | `waitStreamQuiet` | ✅ | 窗口固定；N1–N4 可接受 |

## B.2 多会话焦点（对齐 CLI AgentView）

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| M1 | per-session turn 状态 | 每 `AgentView` 自有 `session.state` | `session-turn-store` 投影 | ✅ | 方案 B；N9–N11 |
| M2 | 切换 = 换 focus | `switch_to_agent` 不 cancel 后台 | openThread / keepBackground：快照 + 不 detach | ✅ | 新对话默认 keepBackground；N11 |
| M3 | 切回 rehydrate busy | 看该 agent `is_turn_running` | 真源优先 Host `promptInFlight` | ✅ | N9 busy / N10 idle |
| M4 | 后台事件路由 | 事件进对应 agent | Host 按 threadId；非焦点写 store | ✅ | N9–N10 |
| M5 | 侧栏 working | 多 agent 指示 | `workingSessions` + 行 spinner | ✅ | 与 M3 同源；N9–N11 |
| M6 | history resync 边界 | load 不叠 live | `history-resync-policy` + stop 后 block | ✅ | N1/N2；不注入 focus system-reminder 进用户正文 |

### B.3 负例验收（门禁）

| # | 场景 | 期望 | 结果 |
|---|------|------|------|
| N1 | 玻璃 → 停 → 苹果 | 无 T1 字进 T2 直播 | ✅ 通过 |
| N2 | 同上 | 无 T1 经 history 贴进 T2；切回气泡无 Desktop focus `system-reminder` | ✅ 通过 |
| N3 | 点停 | 仅一条「已停止」 | ✅ 通过 |
| N4 | 点停后发新问 | 不长期卡「思考中」（无网除外） | ✅ 通过 |
| N5 | 忙时默认发送 | 入队，不 cancel 当前 | ✅ 通过 |
| N6 | send_now | cancel(trigger=send_now) + 新 prompt | ✅ 通过 |
| N7 | 停时有队列 | 队列保留且 pause，可 Resume | ✅ 通过 |
| N8 | 连点 Stop | join，无报错风暴 | ✅ 通过 |
| N9 | A 运行 → 切 B → 回 A（A 仍跑） | 主区 busy，侧栏 A working | ✅ 通过 |
| N10 | A 运行 → 切 B → A 后台完成 → 回 A | 主区 idle，无假「工作中」 | ✅ 通过 |
| N11 | A 运行 → 新对话 keepBackground | A 侧栏仍 working；欢迎页可发 | ✅ 通过 |

**验收日期**：2026-07-22 · 真 agent（bundled）手工。  
**日志真源**：`acp.cancel`（wire=notification）· `promptGen` · `threads.attachState.promptInFlight`。  
**禁止**：关键词过滤当隔离；UI 乐观 endTurn 冒充 cancel 成功；Desktop 把 focus 文案拼进 `session/prompt` 用户正文（会落盘进气泡）。

---

# 主战场 C · Agent 运行时与 ACP

## C.1 进程与附着

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| R1 | 进程拓扑 | Leader 池（主） | Mode B 每 Thread 一 stdio | — | 产品决策 |
| R2 | 可写互斥 | leader driver | Host 内 writable；无跨 CLI 锁 | 🟡 | 目录隔离下可接受 |
| R3 | Attach / resume | `session/load` + live buffer | 懒附着 + pill + ping + idle detach | ✅ | `history_only` 打开 |
| R4 | 崩溃恢复 | 可重连 | failed + 崩溃条 reattach | ✅ | 磁盘 session 不丢 |
| R5 | 单实例 Host | CLI 多进程常见 | 单实例 + handoff | D+ | |

## C.2 核心 ACP 方法（Host `AcpClient`）

| # | 方法 | CLI/Agent | Desktop | 状态 |
|---|------|-----------|---------|------|
| W1 | `initialize` + clientInfo | TUI/leader | `grok-desktop` + version | ✅ |
| W2 | `session/new` · `session/load` | ✅ | create / attach | ✅ |
| W3 | `session/prompt` | ✅ | `turns.prompt`；带 promptId meta | ✅ |
| W4 | `session/cancel` | **notify** | **notify** + meta | ✅ |
| W5 | `session/set_model` | ✅ | snake 优先，camel 回退 | ✅ |
| W6 | `session/set_mode` | plan/default | + `x.ai/toggle_plan_mode` notify | ✅ |
| W7 | `_x.ai/compact_conversation` | Shell 管道 | `threads.compact` | ✅ |
| W8 | `_x.ai/session/info` | SessionInfoData | `threads.sessionInfo` | ✅ |
| W9 | `_x.ai/rewind/*` | pager | points/preview/execute | ✅ |
| W10 | `_x.ai/btw` | 旁路侧问 | `threads.btw` + 侧栏 | ✅ | 2026-07-23：busy 并行、inFlight、失败态；fake agent 契约 |
| W11 | `_x.ai/interject` | mid-turn | `threads.interject` | ✅ | 2026-07-23：cancelling 拒、失败 rollback、inFlight |
| W12 | `_x.ai/task/kill` | pager tasks | `threads.killTask` | ✅ |
| W13 | `_x.ai/memory/flush` · rewrite | shell | flush/dream 路径 | ✅ |
| W14 | `x.ai/recap` · share 类 | pager | 未接 | ❌ |
| W15 | `x.ai/session/fork` 等 admin | leader/agent 扩展 | Desktop 自建 fork（拷历史） | 🟡 | 路径不同，语义近似 |
| W16 | L2 `x.ai/queue/*` + QueueChanged | agent 队列 wire | Host 可选 tryQueueWire；主路径 **L1 落盘** | 🟡 | 旧 agent Method not found → 仅 L1 |

## C.3 Client `_meta` / Capabilities

| # | 字段 | CLI（常经 leader） | Desktop | 状态 |
|---|------|-------------------|---------|------|
| M-C1 | `clientIdentifier` | e.g. grok-tui | `grok-desktop` | ✅ |
| M-C2 | `yoloMode` | ✅ | create / alwaysApprove | ✅ |
| M-C3 | `modelId` · `reasoningEffort` · `planMode` | ✅ | ✅ | ✅ |
| M-C4 | `maxTurns` | flags | 新会话 `_meta` | ✅ | agent 可忽略 |
| M-C5 | `autoMode` | leader 可注 | **未写** | ❌ |
| M-C6 | `codeNavEnabled` | 可注 | **未写** | ❌ |
| M-C7 | `clientTerminal` / `terminal` cap | 可 true | **false** | — / ❌ | 无集成终端，可长期不做 |
| M-C8 | `fs` read/write | 视客户端 | read true · write **false** | 🟡 | 影响部分工具假设 |
| M-C9 | `GROK_HOME` | `~/.grok` | 强制 desktop | — | 故意 |

## C.4 事件归一化（Host → Renderer）

| # | 事件族 | CLI 产出 | Desktop | 状态 |
|---|--------|----------|---------|------|
| E1 | message / thought / tool | ✅ | delta + 过程块 | ✅ |
| E2 | permission | ✅ | bar + Inbox | ✅ |
| E3 | plan 审批 `exit_plan_mode` | ✅ | 面板 | ✅ |
| E4 | goal_updated | ✅ | banner / chip | ✅ |
| E5 | auto_compact | ✅ | context.compacted | ✅ |
| E6 | subagent spawn/progress/finish | ✅ | 侧栏树 + toast | ✅ |
| E7 | task / monitor | ✅ | task.updated + kill | ✅ |
| E8 | available_commands_update | ✅ | slash 合并广告 | ✅ |
| E9 | QueueChanged | ✅ | L1 为主；L2 可选 | 🟡 |
| E10 | hooks / plugins / dream / recap 等 | 多种 | **多数未映射** | ❌ |
| E11 | agent 进程退出 | — | agent.error / failed | ✅ |
| E12 | ask_user_question | 扩展 | Host 等待 UI | ✅ |

## C.5 Agent 工具面

| # | 能力 | 状态 | 备注 |
|---|------|------|------|
| A-T1 | bash / 文件 / 搜索等内置工具 | ✅ | 同源 agent 二进制 |
| A-T2 | task / monitor / scheduler / update_goal | ✅ | 缺口在指挥面 UI，不在缺装 |
| A-T3 | Subagent 树展示 | ✅ | |
| A-T4 | Sandbox / 细粒度禁网 UI | 🟡 / ❌ | 设置入口弱 |
| A-T5 | best-of-n headless | ❌ | 低优 |

---

# 主战场 D · 队列 / 插话 / 任务面板

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| Q1 | 跟进队列 | pager `/queue` + agent queue | L1 `desktop/queues/{sid}.json` + composer 列表 | ✅ | 跨 session 隔离 |
| Q2 | 队列编辑 | 删/改/重排 | UI 全量编辑 | ✅ | |
| Q3 | interrupt pause | 中断后 pause | `pausedByInterrupt` | ✅ | N7 / T8 已验 |
| Q4 | QueueChanged 多端 | wire 广播 | 未作多端主路径 | 🟡 | Mode B 单 Host 够用 |
| Q5 | `/btw` | `x.ai/btw` 旁路 | 侧栏侧问 + slash | ✅ | 与主 turn 并行；不误 cancel |
| Q6 | mid-turn interject | `x.ai/interject` | slash + IPC | ✅ | working only；失败回滚气泡 |
| Q7 | `/tasks` | 列 bg + subagent + scheduled | 四类聚合 + kill | ✅ | scheduled 绑 session |
| Q8 | `/loop` | PROMPT_COMMANDS → scheduler | 无同名；Automations 部分替代 | 🟡 | **勿假装语义等同** |

---

# 主战场 E · 模式 / Goal / Plan / 模型

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| G1 | always-approve / yolo | `/always-approve` | chip + slash + meta | ✅ | |
| G2 | plan 模式 | `/plan` | chip + slash + 面板 + set_mode | ✅ | 2026-07-23：进 plan 开侧栏；回合结束自动 surface |
| G3 | exit plan 审批 | reverse request | 同 | ✅ | |
| G4 | goal set/status/clear/pause/resume | Shell `/goal` + `--budget` | slash + banner + budget 弹窗 | ✅ | |
| G5 | model / effort 热切换 | set_model | chip + `/model` `/effort` | ✅ | 不兼容 harness → 新会话 |
| G6 | `/auto` 权限 | pager 有 | **产品不做** | — | |
| G7 | max-turns | flags | `/max-turns` → 新会话 meta | ✅ | |

---

# 主战场 F · Memory / Skills / Hooks / Plugins（Agent 生态）

| # | 能力 | CLI | Desktop | 状态 | 备注 |
|---|------|-----|---------|------|------|
| X1 | Memory 目录 | `GROK_HOME/memory` | Desktop home 下同源布局 + `GROK_MEMORY` | ✅ | |
| X2 | `/remember` `/flush` `/dream` | shell/pager | slash + 设置浏览 | ✅ | reattach 后 agent 吃开关 |
| X3 | Skills 解析 | shell `resolve()` 真解析 | Host `skillsResolve` → CLI `<skill>` envelope | ✅ | 2026-07-23：对齐 build_skill_message + skill_information |
| X4 | availableCommands 合并 | agent 广告 | Host 缓存 + slash 合并 | ✅ | |
| X5 | Plugins / 市场 | `/plugins` | 插件页 | ✅ | |
| X6 | MCP | `/mcps` 等 | 设置 + session 透传 | ✅ | |
| X7 | Hooks | hooks-* + `/hooks` | 设置扫描 + 本地 trust | 🟡 | 非 shell 全量子命令 |

---

# 辅线 · 项目 / 输入 / 桌面壳（摘要）

| # | 能力 | 状态 | 一句话 |
|---|------|------|--------|
| P1 | 项目绑定 cwd + trust | ✅ | |
| P2 | 多项目侧栏 | D+ | |
| P3 | Worktree | 🟡 | Host git；非 agent 池 |
| P4 | 无项目「对话」区 | ✅ | 与项目同级 section |
| I1 | `@` 文件 | ✅ | |
| I2 | 附件 / 粘贴图 | ✅ | 2026-07-23：上限 20、巨图拒绝、拖放、i18n 错误态 |
| I3 | 停止钮 / 多行发送 | ✅ | |
| D1 | Codex 壳 / 三栏 / 自定义供应商 | D+ | |
| D2 | Automations / Inbox | 🟡 | ≠ `/loop` |
| D3 | 集成终端 | — | ACP terminal false |

**纯 TUI 不跟**：`/vim-mode` · `/theme` · `/fullscreen` · `/voice` · `/gboom` · scroll/debug 类 → **—**

---

# Desktop 会话 Slash 清单（实现真相）

来源：`src/renderer/slash-commands.ts`（导航类故意不进 `/`）

| 命令 | 状态 |
|------|------|
| `/always-approve` | ✅（主入口 chip） |
| `/plan` `/view-plan` | ✅ / 🟡 深度 |
| `/goal` `/goal-status` `/goal-clear` `/goal-pause` `/goal-resume` `/goal-budget` | ✅ |
| `/model` `/effort` `/max-turns` | ✅ |
| `/context` `/status` | ✅ |
| `/compact` `/export` `/fork` `/rewind` | ✅ |
| `/queue` `/queue-clear` `/btw` `/interject` | ✅ / 🟡 wire |
| `/tasks` `/history` | ✅ |
| `/memory` `/remember` `/flush` `/dream` | ✅ |
| 动态 skills / agent 广告 | 🟡 / ✅ |

---

# 建议对齐优先级（仅主战场）

```text
P0  多会话 + turn 真源 + 负例 N1–N11  ——— ✅ 2026-07-22 已验收
    · 回归：改 cancel / openThread / history / 投影时重跑 N1–N11

P1  队列 / 插话 wire 边角 ——— Q5/Q6 btw·interject ✅ 2026-07-23
    · QueueChanged L2 仍可选（Q4）；L1 主路径已齐

P2  Agent 扩展完整度（按产品选型）
    · autoMode / fs write（若需要）
    · recap/share 可后置

P3  Plan / Skills ——— G2·X3 ✅ 2026-07-23；Hooks 全量仍 🟡
    · 体验债，非串台根因

明确不做
    · Leader 池 · 默认共享 GROK_HOME · /auto · 集成终端（除非立项）
    · 内容毒化当隔离 · Desktop 长 focus system-reminder 拼进用户 prompt
```

---

# 一页纸结论

| 维度 | 判断 |
|------|------|
| ACP 主路径（new/load/prompt/cancel/set_model/mode） | ✅ 高（cancel 已按 notification） |
| Session 磁盘格式 | ✅ 兼容，home 隔离 |
| 会话 CRUD / fork / rewind / compact / export / status | ✅ 齐 |
| **多会话 turn 隔离 + 切回 rehydrate** | ✅ N1–N11 已验收（方案 B + promptInFlight） |
| 队列 L1 / 任务 kill / memory | ✅ 主路径；L2 wire 🟡 |
| Agent 工具本体 | ✅ 同源二进制 |
| Client meta（terminal/auto/codeNav） | 🟡～❌ 按产品 |
| 与 CLI 差距本质 | 体验/扩展面（queue L2、hooks、skills 解析等），**非**主路径串台 |

**一句话：**  
Desktop 已是 **Mode B 指挥面 + 同源 agent**；会话/Agent **主路径与 cancel/多会话负例已闭环**。  
后续优先队列/插话边角与生态深度，改 B 区代码必须重跑 N1–N11。

---

# 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-22 | **N1–N11 验收通过**：主战场 B（T5/T8/T9、M1–M6）标 ✅；P0 闭环；更新优先级与一页纸结论 |
| 2026-07-22 | **重写整表**：基于当前 Mode B / Host ACP / session-turn-store 与 `tmp/grok-build-main` 再审计；主战场聚焦会话+Agent；并入 cancel notification 根因与方案 B；负例 N1–N11 |
| （历史） | 旧表迭代见 git 历史；本版作废「入口有就标满 ✅」的写法 |

---

**维护提示**

1. 改会话/cancel/多会话代码时，**同步改主战场 B 状态与负例**，并重跑 N1–N11。  
2. 优先改 **能力状态 + 真源列**，不要只补同名 slash。  
3. CLI 对照以 `tmp/grok-build-main` 为准；用户指南可能滞后。  
4. 对齐计划细节仍见 [cli-desktop-align-plan.md](./cli-desktop-align-plan.md)。
