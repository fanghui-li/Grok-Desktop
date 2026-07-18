# 贡献指南

感谢关注 Grok Desktop。本仓库是 **仅桌面端** 的 Electron 客户端：Host 通过 ACP 调用 `grok agent`，不在 Renderer 中重写 agent runtime。

## 环境

- Node.js **≥ 20**
- Windows 为主开发/打包平台；macOS/Linux 可源码运行，发行包以 Win 为主
- 本地需能拿到 `grok` 二进制（CLI 安装或手动拷贝）

## 快速开始

```bash
npm install
npm run sync:agent    # 同步 agent 到 agent-bin/ 并写 VERSION.txt
npm test
npm start             # build + Electron
```

仅测 Host（无 UI）：

```bash
npm run start:host
# 或
npm run dev
```

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm test` | Vitest |
| `npm run build` | 编译 + 静态资源 + renderer bundle |
| `npm run sync:agent` | 复制二进制并写 `agent-bin/VERSION.txt` |
| `npm run check:agent` | 打包前检查 agent 是否存在且体积合理 |
| `npm run dist:win` | 构建并打 Windows 安装包（含 check） |

## 分支（方案 A / GitHub Flow）

- **`main`**：唯一长期分支与发版线，保持可发布。  
- **`feature/*` / `fix/*`**：从 `main` 拉出，完成后 PR 合回 `main`，再删分支。  
- **不使用远端 `develop`**。细节见 **[docs/BRANCHING.md](./docs/BRANCHING.md)**。

## 目录约定

| 路径 | 说明 |
|------|------|
| `src/shared/` | Host ↔ UI 类型与 IPC 契约；改 API 先改这里 |
| `src/host/` | 产品 API、ACP、落盘 |
| `src/main/` | Electron 主进程；preload 仅用 `preload.cjs` |
| `src/renderer/` | UI（仅 IPC，不 spawn agent） |
| `docs/` | 公开文档（随 PR 进 main） |
| `docs/private/` | 本地私密草稿，**gitignore，永不入库** |
| `agent-bin/` | 本地二进制 + VERSION.txt，**不入库** |
| `~/.grok-desktop` | 运行时用户数据（测试勿提交） |

## 贡献范围建议

优先：

- **[CLI ↔ Desktop 能力矩阵](./docs/cli-desktop-capability-matrix.md)**：改功能时同步状态；认领 🟡/❌
- 文档与实现一致
- Host 契约 / 测试覆盖
- 打包与 agent 同步可追溯性
- 明确的 bug 修复（附复现步骤）

避免：

- 在 Desktop 内重写 tools / MCP runtime
- 把 `~/.grok*` 会话、密钥、日志提交进仓库
- 无说明的大范围格式化或无关重构

### 维护能力矩阵

1. 打开 `docs/cli-desktop-capability-matrix.md`  
2. 按 § 编号更新状态（✅ / 🟡 / ❌ / D+）与备注  
3. 在 §12 修订记录加一行日期说明  
4. PR 标题可写：`docs(matrix): I4 图片粘贴 → ✅` 之类  

## Pull Request

1. 默认向 **`main`** 开 PR（从最新 `main` 拉功能分支）。
2. 分支命名自便，PR 说明写清：**改了什么、为什么、如何验证**。
3. 涉及 Host API：更新 `src/shared/` 与相关测试。
4. 涉及打包：本地跑通 `npm run check:agent`（有 agent 时）与 `npm test`。
5. 公开说明放 `docs/`；仅自己看的笔记放 `docs/private/`（勿提交）。可选：`npm run check:main-clean`。
6. 提交信息请使用 **中文**（本仓库约定）。

## 安全

请勿在 Issue/PR 中粘贴 API Key、`auth.json`、完整用户路径下的私密日志。安全问题见 [SECURITY.md](./SECURITY.md)。

## 行为准则

保持建设性讨论；争议以技术事实与可验证复现为准。
