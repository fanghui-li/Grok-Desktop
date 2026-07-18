# Grok Desktop 文档

Grok Desktop 是 **Grok Build 的桌面客户端**：Electron 指挥面 + Host，通过 ACP 调用 `grok agent`，数据目录默认 `~/.grok-desktop`（与 CLI `~/.grok` 隔离）。

| 文档 | 说明 |
|------|------|
| [架构与协议.md](./架构与协议.md) | 分层、进程、Host API、会话与安全 |
| [cli-desktop-capability-matrix.md](./cli-desktop-capability-matrix.md) | CLI ↔ Desktop 能力对照（欢迎共维） |
| [BRANCHING.md](./BRANCHING.md) | 分支模型（main + 短功能分支）与发版 |
| [根 README（中文）](../README.md) | 产品介绍、截图、安装 |
| [README (English)](../README_EN.md) | Product intro, screenshots, install |
| [packaging.md](./packaging.md) | agent-bin 与安装包 |
| [agent-bin/README](../agent-bin/README.md) | 二进制放置说明 |
| [CONTRIBUTING](../CONTRIBUTING.md) | 贡献指南 |
| [SECURITY](../SECURITY.md) | 漏洞报告与数据边界 |

**原则：**

1. Desktop 是 Client / 指挥面，不重写 agent runtime。  
2. Agent 二进制由项目 **`agent-bin/`** 维护并可打进安装包（含 VERSION.txt）。  
3. 用户数据在 `~/.grok-desktop`，与 CLI `~/.grok` 隔离，**不随包分发**。
