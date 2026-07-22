# Grok Desktop

<p align="center">
  <img src="./assets/icon.png" alt="Grok Desktop" width="88" height="88" />
</p>

<p align="center">
  <strong>Grok Build 桌面工作台</strong><br />
  <b>操作体验对齐 Codex</b> · 官方登录与自定义中转 · 多项目会话
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="https://github.com/fanghui-li/Grok-Desktop/releases">下载安装包</a>
</p>

<p align="center">
  <img alt="UX" src="https://img.shields.io/badge/UX-对齐%20Codex-8B5CF6.svg" />
  <img alt="Providers" src="https://img.shields.io/badge/providers-官方%20%2B%20中转-success.svg" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" />
  <img alt="Platform" src="https://img.shields.io/badge/Windows-x64-0078D4.svg" />
</p>

---

**Grok Desktop** 把 Grok agent 放进图形界面：布局与交互对标 OpenAI Codex 桌面端，智能仍由 Grok 执行。适合用安装包直接上手，无需配置开发环境。

## 安装与开始

1. 打开 [Releases](https://github.com/fanghui-li/Grok-Desktop/releases)，下载 **`Grok Desktop-*-win-x64.exe`**
2. 安装并启动
3. **设置 → 账户与提供商**  
   - **官方账户**：登录 xAI / Grok 官方  
   - **自定义提供商**：填写 OpenAI 兼容中转（Base URL、API Key、模型等）
4. 添加或选择项目，开始对话  

安装包可内置 agent，一般装完即可用。数据目录默认 **`~/.grok-desktop`**，与命令行 CLI 的 `~/.grok` 分开，互不影响。

## 你能做什么

- **三栏工作台**：项目 / 会话、对话过程、侧栏文件与工具
- **权限与模型**：完全访问等模式、模型与推理力度 chip
- **计划 / 目标模式**：在输入区 chip 切换，状态始终可见
- **多项目 · 多会话**：侧栏切换、搜索、归档
- **熟悉输入**：`@` 引用文件、附件、`/` 命令、Skills
- **自定义中转**：多供应商、设默认、连通测试（Ping）、对话中切换模型

### 自定义供应商（简要）

| | |
|--|--|
| 配置 | 名称、Base URL、API Key、协议、模型 |
| 体验 | 拉取模型列表；多供应商；设默认；对话 chip 切换 |
| 安全 | 与官方 OAuth **隔离**；中转自带 Key；Key **不明文回显** |

## 界面语言

**设置 → 常规 → 界面语言**：跟随系统 / 简体中文 / English。  
仅窗口 UI（导航、设置、按钮等）会切换；Agent 回复与工具日志不翻译。

## 遇到问题

- 打不开、登录失败、中转连不上：先看 **设置 → 账户与提供商** 是否配置正确；中转可点 **连通测试** 看延迟  
- 想反馈体验或缺陷：在 [Issues](https://github.com/fanghui-li/Grok-Desktop/issues) 写清系统版本、安装包版本与复现步骤  

## 诚邀一起维护

项目还在 **0.1**，缺口不少，也欢迎打补丁。  
我们用 [CLI ↔ Desktop 能力矩阵](./docs/cli-desktop-capability-matrix.md) 对照 Grok CLI：哪些已对齐、哪些半成品、哪些故意做成桌面体验。

| 你可以怎么参与 | |
|----------------|--|
| 提体验 | [Issue](https://github.com/fanghui-li/Grok-Desktop/issues) 写清复现即可 |
| 改矩阵 | 发现状态过时 → 直接改表并发 PR |
| 认领缺口 | 表里 🟡 / ❌ 都是待办线索 |
| 读约定 | [贡献指南](./CONTRIBUTING.md) · [文档索引](./docs/README.md) |

**不要求一次做完。** 修一小块、改一行状态，都超欢迎。



## 软件界面

### 欢迎页

<p align="center">
  <img src="./docs/images/home.png" alt="欢迎页" width="720" />
</p>

### 主工作台

<p align="center">
  <img src="./docs/images/workspace.png" alt="主工作台" width="900" />
</p>

### 自定义供应商

<p align="center">
  <img src="./docs/images/providers.png" alt="自定义供应商" width="900" />
</p>

### 计划模式 · 插件

| 计划模式 | 插件 |
|:---:|:---:|
| <img src="./docs/images/plan.png" alt="计划模式" width="440" /> | <img src="./docs/images/plugins.png" alt="插件" width="440" /> |




## 友情链接

- [LinuxDo](https://linux.do)
---

[Apache-2.0](./LICENSE) · © 2026 [fanghui-li](https://github.com/fanghui-li)
