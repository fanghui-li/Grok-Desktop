# Grok Desktop · Agent / 协作者全局约定

本文件是仓库级指令：编码助手（Grok Build / Claude / Cursor 等）与人类贡献者在本项目中**必须**遵守。

---

## 0. 语言与文档

- 使用中文与用户交流；git 提交信息使用英文。
- 项目已有英文文档不必翻译；**新写文档用中文**。
- 实现功能时默认不强制 TDD（除非用户明确要求测试）。

---

## 0.1 功能测试（公开约定）

- **默认门禁**：相关 **L0 单测 + L1 Host/fake** 绿（`npx vitest run test/<相关>.test.ts`）；不默认真 grok / Playwright。
- **真窗口**：合入/发版前由维护者按风险短剧本点验；goal 厚清单见 `docs/goal-handtest-checklist.md`（若有）。
- **维护者本地**（**不入库**）：`.grok/skills/desktop-test/` + `docs/test-archive/` 已 gitignore；仅本机 `/desktop-test` 工作流，勿把路径写进对外文档当必选。

---

## 1. 功能实现总流程（强制 · CLI 优先）

**实现任何功能、修任何行为 bug 之前，必须先看 CLI（Grok Build / pager / shell），再定桌面方案，最后再写代码。禁止上来就改 Desktop 表层 UI 或堆启发式补丁。**

### 1.1 固定顺序

```text
1. 调研 CLI
   - 主源码：tmp/grok-build-main（或同步后的 grok-build）
   - 重点：xai-grok-pager（TUI/交互）、xai-grok-shell（session/ACP/cancel/queue）
   - 协议/能力：docs/cli-desktop-capability-matrix.md

2. 归纳 CLI 语义
   - 用户可观察行为 + 状态真源（谁持有 turn/session 状态）
   - wire（ACP / _meta / notification vs request）
   - 明确「CLI 内部实现细节」与「产品语义」的边界

3. 设计适合 Desktop 的方案
   - 对齐：agent 契约、回合语义、用户心智
   - 可 Desktop 化：Electron 多会话 UI、乐观交互、history 面板
   - 不硬抄：Leader 进程池、TUI 按键、内部 Rust 结构名

4. 与用户确认（复杂/歧义时）→ 再实现 → 用日志/契约验证真源，不只靠 UI 观感
```

### 1.2 对齐什么 / 不抄什么

| 应对齐 | 不硬抄 |
|--------|--------|
| ACP / `_meta` / cancel 是 notification 还是 request | CLI 内部 `SessionCommand` 等类型名 |
| turn / session 状态真源与切换语义 | Leader 拓扑、TUI 全屏布局 |
| 停止、排队、send_now、后台继续跑等用户心智 | 为对齐而堆关键词过滤等启发式 |
| 可观察结果（停干净、切回仍 busy 等） | 与 Desktop 产品冲突的默认行为 |

### 1.3 反模式（禁止）

- 未读 CLI 就改 renderer 状态机或加内容毒化 / 长 suppress。
- 用 UI 乐观态冒充协议已成功（例如 cancel 失败仍当已停）。
- 文档/矩阵标 ✅ 但未验证 wire 与 agent 真行为。
- 只修截图症状、不查 Host 日志 / agent 方法是否 Method not found。

### 1.4 参考文档

- [docs/cli-desktop-capability-matrix.md](./docs/cli-desktop-capability-matrix.md) — 能力对照  
- [docs/cli-desktop-align-plan.md](./docs/cli-desktop-align-plan.md) — 适合对齐的分阶段计划  
- [docs/架构与协议.md](./docs/架构与协议.md) — 分层与协议  
- CLI 树：`tmp/grok-build-main/`  

---

## 2. 产品边界

1. Desktop 是 **指挥面 / ACP Client + Host**，不重写 agent runtime。  
2. Renderer **只走 IPC**，不 spawn `grok`。  
3. 数据目录默认 `~/.grok-desktop`，与 CLI `~/.grok` 隔离。  
4. 交互布局可参考 Codex Desktop；**能力语义认 Grok CLI**。

---

## 3. 编码纪律

### 3.1. 编码前思考
**不要想当然。不要掩盖困惑。坦诚地权衡利弊。**
实施前：|
- 明确陈述你的假设。如有疑问，请提出。
- 如果存在多种解释，请列出它们——不要默默地选择。
- 如果存在更简单的方法，请说明。必要时提出异议。
- 如果有任何不清楚的地方，请停止。指出困惑之处。提出问题。
- 必须考虑边界情况  

### 3.2. 简洁至上
**解决问题所需的最小代码量。不做任何推测性代码。**
- 不添加超出要求的功能。
- 不为一次性使用的代码编写抽象。
- 不添加任何未经请求的“灵活性”或“可配置性”。
- 不对不可能的情况进行错误处理。
- 如果你写了 200 行代码，而它其实可以简化成 50 行，那就重写。
问问自己：“一位资深工程师会觉得这段代码过于复杂吗？” 如果会，那就简化它。

### 3.3. 精准修改
**只修改必要的部分。只清理你自己造成的混乱。**
编辑现有代码时：
- 不要“改进”相邻的代码、注释或格式。
- 不要重构没有问题的代码。
- 保持与现有代码风格一致，即使你的想法不同。
- 如果你发现无关的无用代码，请指出——不要删除它。
当你的修改导致孤立代码出现时：
- 删除你修改后不再使用的导入/变量/函数。
- 除非被要求，否则不要删除已有的无用代码。
测试：每一行修改都应该直接追溯到用户的请求。
---
