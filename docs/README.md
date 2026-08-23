# Grok Desktop 文档

## Install (SHA-256)

Pin GitHub Release **v0.6.0** and verify `SHA256SUMS`. Website `install.sh` / `install.ps1` abort on mismatch.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/tag/v0.6.0
https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/PINNED-INSTALL.md

```
96cef605d3e030ccef99d27ea6240e0d3b668dd045e6b5b9e585c9fd03c6ef23  gbr-agent-darwin-amd64
de7e065ef2cf6877b3b2cd04679a67b627f876337f529247e236204543e4062c  gbr-agent-darwin-arm64
a50a5c41993e6531a3b477eb409ccc845212bf541384dc803061c80657f86719  gbr-agent-linux-amd64
5bfd22c7110234942c4c02ff8154b836d0af45a9422c178a4f52010187d40061  gbr-agent-linux-arm64
f773b89fd31310172b756e0593e0f3b2382b0a3440af2a7d0a8b3073b0c23e27  gbr-agent-windows-amd64.exe
8fb9efcbc7e2ac91c11964944bf0f45e31bb23f4356d9dcb4b305d7cb9b0fe8c  gbr-agent-windows-arm64.exe
```

```bash
VER=v0.6.0
BASE=https://github.com/LinespottingOrg/GrokBuildRemote-Agents/releases/download/$VER
# swap darwin-arm64 for your OS/arch
curl -fsSL -o gbr-agent-darwin-arm64 "$BASE/gbr-agent-darwin-arm64"
curl -fsSL -o SHA256SUMS "$BASE/SHA256SUMS"
shasum -a 256 -c SHA256SUMS --ignore-missing
gbr-agent pair && gbr-agent run
```


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

## What the phone sees

**Terminal windows** on this PC (machine-wide mailbox). Not headless OpenCode / CodeNomad sidecar / Electron. `:8788` in a sidecar is Bot API JSON, not a transcript.

https://github.com/LinespottingOrg/GrokBuildRemote-Agents/blob/main/docs/WHAT-THE-PHONE-SEES.md
https://grokbuildremote.com/integrations.html
