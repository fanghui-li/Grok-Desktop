# 分支与发版约定（GitHub Flow / 方案 A）

本仓库采用 **以 `main` 为中心** 的开源常见模型：

- **`main`**：唯一长期分支，默认分支，保持可构建、可说明、可打 tag  
- **`feature/*` / `fix/*`**：短生命周期任务分支，完成后经 PR（或本地 merge）合回 `main`，然后删除  
- **不再使用远端 `develop`** 作为集成线  

内部过程笔记 **不进 git**（见 §1）；公开文档与代码一起进 `main`。

---

## 1. 目录约定

```
docs/
  README.md
  BRANCHING.md                      # 本文件
  cli-desktop-capability-matrix.md
  packaging.md
  架构与协议.md
  images/
  private/                          # ★ 永不入库（.gitignore）
```

| 路径 | 是否入库 | 用途 |
|------|----------|------|
| `docs/*`（除 `private/`） | 是 | 用户/贡献者可读的公开文档 |
| `docs/private/**` | **否** | 本地私密草稿、未公开计划 |
| `*.local.md` | **否** | 个人临时笔记 |
| `README*.md` / `CONTRIBUTING.md` / `SECURITY.md` | 是 | 开源门面 |
| `tmp/`、`release/`、`agent-bin/*`（除占位） | 否 | 本地构建与对照源码 |

**原则：**

1. 能公开的文档写在 `docs/` 根下，随功能 PR 进 `main`。  
2. 不想公开的过程文档放 `docs/private/` 或 `*.local.md`，**不要 `git add`**。  
3. 敏感内容不要进本仓库；公开历史删文件也抹不掉。  
4. 半成品靠 **未合并的 feature 分支** 隔离，不靠第二条长期远端分支。

---

## 2. 日常开发

```bash
git checkout main
git pull origin main
git checkout -b feature/简短描述

# … 开发、测试、中文 commit …

git push -u origin feature/简短描述
# 向 main 开 PR；或本地 merge 回 main 后再 push
```

合并后删除功能分支：

```bash
git checkout main
git pull origin main
git branch -d feature/简短描述
git push origin --delete feature/简短描述   # 若曾推送
```

- **不要**在 `main` 上直接堆长线半成品（个人热修可例外，仍建议短分支）。  
- PR 说明写清：改了什么、为什么、如何验证。  
- 涉及 Host API：更新 `src/shared/` 与测试；打包相关跑 `npm test` / `npm run check:agent`。

---

## 3. 发版（在 main 上打 tag）

`main` 上某次提交即可作为发版点，**不必**再从另一条分支「晋升」。

```bash
git checkout main
git pull origin main
npm test
npm run build
# 有 agent 时：npm run check:agent

git tag -a v0.x.y -m "Grok Desktop v0.x.y"
git push origin v0.x.y
# GitHub Releases 附安装包与说明
npm run dist:win   # 在已 sync agent 的环境
```

版本号建议语义化：`MAJOR.MINOR.PATCH`。

---

## 4. 质量门禁（可选 / 推荐）

| 工具 | 作用 |
|------|------|
| `npm run check:main-clean` | 当前树不应跟踪 `docs/private/`、`tmp/` 等 |
| `.github/workflows/main-guard.yml` | PR/push 到 `main` 时跑上述检查 |
| （建议后续）`test` + `build` workflow | PR 合入前自动验证 |

本地：

```bash
npm run check:main-clean
npm run check:main-clean -- --paths-only
```

---

## 5. 从旧模型（develop）迁到本约定

若本地或远端仍有 `develop`：

1. 确认 `develop` 上要保留的提交已合入 `main`（快进或 PR）。  
2. `git push origin main`  
3. 删除远端集成分支：`git push origin --delete develop`  
4. 删除本地：`git branch -d develop`  
5. 之后只从 `main` 拉 `feature/*`。

公开仓库中曾推送过的 commit 仍可能在历史中被访问；新工作不再推 `develop` 即可。

---

## 6. 快速对照

| 我要做的事 | 做法 |
|------------|------|
| 新功能 | `main` → `feature/xxx` → PR → `main` |
| 用户文档 | 写在 `docs/`，随 PR 进 `main` |
| 仅自己看的笔记 | `docs/private/` 或 `*.local.md`（不入库） |
| 发版 | `main` 上 tag + Release |
| 热修 | `fix/xxx` → PR → `main`，必要时再打 patch tag |

---

## 7. 修订

| 日期 | 说明 |
|------|------|
| 2026-07-18 | 初版：develop + 发版排除 docs/dev |
| 2026-07-18 | 改为方案 A（仅 main + 短功能分支）；内部笔记改 gitignore |
