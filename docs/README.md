# Grok Desktop 文档

Grok Desktop 是 **Grok Build 的桌面客户端**：Electron 指挥面 + Host，通过 ACP 调用 `grok agent`，数据目录默认 `~/.grok-desktop`（与 CLI `~/.grok` 隔离）。

| 文档 | 说明 |
|------|------|
| [架构与协议.md](./架构与协议.md) | 分层、进程、Host API、会话与安全 |
| [cli-desktop-capability-matrix.md](./cli-desktop-capability-matrix.md) | CLI ↔ Desktop 能力对照（欢迎共维；现行能力真源） |
| [cli-desktop-align-plan.md](./cli-desktop-align-plan.md) | cancel / 回合 / 队列对齐计划与 N1–N11 验收 |
| [BRANCHING.md](./BRANCHING.md) | 分支模型（main + 短功能分支）与发版 |
| [archive/session-agent-improve-plan.md](./archive/session-agent-improve-plan.md) | **历史**：2026-07 会话/Agent 完整开发计划（已交付；勿作 backlog） |
| [根 README（English，主文档）](../README.md) | **End-user README**: intro, install, screenshots |
| [README 中文](../README_ZH.md) | **面向安装包用户（中文）**：介绍、安装、截图、反馈 |
| [CONTRIBUTING](../CONTRIBUTING.md) | **开发者**：环境、`npm start`、分支与脚本 |
| [packaging.md](./packaging.md) | agent-bin 与安装包 |
| [agent-bin/README](../agent-bin/README.md) | 二进制放置说明 |
| [SECURITY](../SECURITY.md) | 漏洞报告与数据边界 |

**原则：**

1. Desktop 是 Client / 指挥面，不重写 agent runtime。  
2. Agent 二进制由项目 **`agent-bin/`** 维护并可打进安装包（含 VERSION.txt）。  
3. 用户数据在 `~/.grok-desktop`，与 CLI `~/.grok` 隔离，**不随包分发**。  
4. **实现功能 / 修行为：先看 CLI → 再定适合 Desktop 的方案 → 再对齐实现**（强制，见根目录 [AGENTS.md](../AGENTS.md)）。
