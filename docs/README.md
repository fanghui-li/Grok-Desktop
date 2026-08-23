# Grok Desktop 文档

Grok Desktop 是 **Grok Build 的桌面客户端**（Electron 指挥面 + Host，通过 ACP 驱动 `grok agent`）。数据目录默认 `~/.grok-desktop`（与 CLI `~/.grok` 隔离）。

| 文档 | 说明 |
|------|------|
| [架构与协议.md](./架构与协议.md) | 分层、进程、Host API、会话与安全 |
| [cli-desktop-capability-matrix.md](./cli-desktop-capability-matrix.md) | CLI ↔ Desktop 能力对照（欢迎共建；能力真源） |
| [cli-desktop-align-plan.md](./cli-desktop-align-plan.md) | cancel / 回合 / 排队等对齐计划（N1–N11 路线） |
| [BRANCHING.md](./BRANCHING.md) | 分支模型：main + 短功能分支与发版 |
| [根 README（English / 用户向）](../README.md) | **End-user README**: intro, install, screenshots |
| [README 中文](../README_ZH.md) | **中文安装与用户说明**：功能、安装、截图、排障 |
| [CONTRIBUTING](../CONTRIBUTING.md) | **贡献者**：环境、`npm start`、分支与提交 |
| [packaging.md](./packaging.md) | agent-bin 与安装包 |
| [agent-bin/README](../agent-bin/README.md) | 捆绑 agent 说明 |
| [SECURITY](../SECURITY.md) | 安全与数据边界 |
| [gbr.md](./gbr.md) | Build Remote Agent：桌面 Grok 会话的手机 spectator（`gbr/1`，独立产品，非 xAI） |

**原则**

1. Desktop 是 Client / 指挥面，不重写 agent runtime。  
2. Agent 二进制在项目 **`agent-bin/`** 维护（可打进安装包，见 VERSION.txt）。  
3. 用户数据在 `~/.grok-desktop`，与 CLI `~/.grok` 隔离，**不要混写**。  
4. **实现功能 / 修行为：先看 CLI → 再定适合 Desktop 的方案 → 再动手实现**（强制，见仓库根 [AGENTS.md](../AGENTS.md)）。
