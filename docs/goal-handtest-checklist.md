# Goal 手测清单（Desktop ↔ CLI 对齐）

> **分支 / 范围**：`feat/goal-align-cli` · G0–G4  
> **原则**：能力语义认 Grok CLI；观察 **banner / chip / 是否误开目标**，必要时对照 Host 日志 `goal.apply` / `goal.drop_stale`。  
> **自动化已覆盖**：`session-goal-store` 单元 + 相关 Host 测；本清单补 **真 agent + UI**。  
> **自动测**：`npx vitest run test/goal-e2e-host.test.ts test/session-goal-store.test.ts`。  
> **维护者本地**（gitignore，可选）：本机 `.grok/skills/desktop-test/`、`docs/test-archive/`。

---

## 0. 准备

| # | 步骤 | 通过标准 |
|---|------|----------|
| 0.1 | 切到 `feat/goal-align-cli`，`npm run build` 成功 | 无 tsc 错误 |
| 0.2 | `npm start` 启动 Desktop，已 OAuth / 可用 agent | 能正常发消息 |
| 0.3 | 新开一个 **干净项目会话**（或新建对话） | 无旧 goal banner |
| 0.4 | （可选）开 DevTools / 看 Host 日志 | 能搜 `goal.apply`、`goal.drop_stale` |

**建议对照 CLI（可选）**：同一任务用 `grok` TUI 跑一遍 `/goal`，对比状态文案心智（不必像素一致）。

---

## 1. 负例：普通对话不得自动开目标（P0）

> 对齐用户反馈：「为啥会自动开启目标模式」

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| N1 | 在干净会话发普通需求，例如：「按项目风格指南改一下 README 结构」 | **无** 目标 banner、**无** 目标 chip（draft 也不应出现） | |
| N2 | 多轮继续普通开发（读文件、改代码、问问题） | 全程无目标 UI | |
| N3 | 若时间线里出现工具卡片含 `update_goal` /「Goal:…」但用户从未 `/goal` | **仍不** 因此单独抬起「进行中的目标」条（完成态 toast 也不应冒充已 setup） | |
| N4 | 切到另一干净会话再回来 | 仍无目标 UI | |

**失败信号**：未输入 `/goal` 或点「目标」却出现「进行中的目标」banner。

---

## 2. 正例：显式开启 goal（P0）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| P1 | 输入 `/goal` 无正文，回车（或 +菜单 → 目标） | 进入 **compose**：输入框 placeholder 变目标文案；chip 可呈 draft；**尚未** 算 harness 完成 | |
| P2 | 输入目标正文，例如：`在 docs 下加一个 FAQ 小节并提交说明`，发送 | 发出的 agent 内容应为 **`/goal …`**（可在网络/日志或用户气泡旁行为上感知为 goal 回合） | |
| P3 | 等待 agent 响应 | 出现 **目标 banner**（kicker「进行中的目标」或 Planning…）；chip 显示目标标题 | |
| P4 | 观察 banner | 有标题；若 wire 带 elapsed，可有 `· Ns`；phase 行可有「规划中 / 验证… / budget」 | |
| P5 | 输入栏再发一条普通跟进（非 slash） | 目标仍在（未 clear）；会话仍按 goal 会话推进，不误清 banner | |

**入口变体（任选 1–2 条）：**

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| P6 | 一行写完：`/goal 修复登录按钮无响应` 直接发送 | 与 P2–P4 相同，无需先 compose | |
| P7 | `+` 菜单点「目标」再写正文发送 | 同 P2–P4 | |

---

## 3. 生命周期：status / pause / resume / clear（P0）

**前置**：已有进行中目标（完成 §2）。

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| L1 | `/goal-status` 或 slash「目标状态」 | toast/提示含当前标题 + 状态（进行中/暂停等） | |
| L2 | banner 点 **暂停**，或 `/goal-pause` | kicker 变为暂停类文案；pause 钮隐藏、resume 显示；计时停 | |
| L3 | 点 **恢复** 或 `/goal-resume` | 回到进行中；agent 继续推进 | |
| L4 | Stop / Esc 停当前 turn（若有 in-flight） | 若产品会顺带 pause goal：banner 暂停 + toast；**队列策略**按现有 cancel 语义 | |
| L5 | banner 点 **清除** 或 `/goal-clear` | banner/chip **立刻消失**；toast「已清除」 | |
| L6 | clear 后继续普通聊天 1–2 轮 | **不再** 自动出现目标条 | |
| L7 | clear 后立刻再 `/goal 新目标B` 发送 | 新目标可正常建立（新 goal_id，不被旧 clear 挡住） | |

---

## 4. Budget（P1）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| B1 | `/goal-budget` 设一个较小预算（如 `50000`） | toast 确认预算；若已有目标会再发 `/goal <obj> --budget N` | |
| B2 | 或发送：`/goal 小任务说明 --budget 50000` | banner 可显示 budget 进度或 budget 相关 kicker（若 agent 推字段） | |
| B3 | 预算弹窗点「清除预算」 | 本地 budget 清空；后续新建 goal 不带 `--budget`（除非再设） | |

---

## 5. 完成与防复活（P1）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| C1 | 设一个 **极易完成** 的 goal（如「只回复：目标完成」类，或极短可验证任务） | 完成后 kicker「已完成」+ toast；约数秒后 UI 收起 | |
| C2 | 完成/clear 后 **不要** 再被迟到事件打回「进行中」 | 无回魂 banner | |
| C3 | 完成展示期间若仍有 agent 流 | 不把已完成条打回 active（短暂 active 噪声应被忽略） | |

---

## 6. 多会话 / 冷启动（P0）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| M1 | 会话 A 开 goal 并保持 active；会话 B 普通聊天 | B **无** A 的目标 banner | |
| M2 | 从 B 切回 A | A 仍显示正确目标（或经 sync 恢复） | |
| M3 | A 在 goal 进行中时切到 B 再回来 | 不丢投影；busy/turn 与 goal 条不串会话 | |
| M4 | 退出 Desktop 再启动，打开 **从未 /goal** 的旧会话 | **无** 因脏 `goal.json` 假「进行中」 | |
| M5 | 打开 **agent 侧确实有 goal** 的会话（jsonl 有 `goal_updated`） | bootstrap 后可显示对应状态（resume 场景） | |

---

## 7. 与 Plan 模式边界（P1）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| R1 | 仅开 `/plan`，不 `/goal` | 只有 plan chip/面板，**无** goal banner | |
| R2 | 先 plan 再 `/goal`（或反过来） | 两者可并存于 UI，但不互相顶替语义；clear goal 不影响 plan 审批流 | |

---

## 8. 细状态与指挥面（P2 · G3）

> 依赖 agent 真实 pause 原因，不一定每次都能触发；能碰到就勾。

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| S1 | goal 进入 planning | kicker/phase 出现「规划中」类文案 | |
| S2 | verifying / classifier 排队 | 可出现「完成确认中…」类提示（toast 或 kicker） | |
| S3 | blocked（环境不可达等） | kicker 阻塞类 + toast/Inbox 可有「Goal blocked」 | |
| S4 | elapsed | active 时秒数前进；pause 后冻结；不应从「已跑很多天」冷启动狂跳 | |

---

## 9. 日志 / 真源抽查（P1）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| D1 | 用户 `/goal` 后 | Host 日志出现 `goal.apply`（status active 等） | |
| D2 | clear 后若有迟到同 id 事件 | 可出现 `goal.drop_stale`，UI 不回魂 | |
| D3 | 会话目录 | 可有 `goal-projection.json` 缓存；**不应**仅靠旧脏 `goal.json` 决定 UI | |

---

## 10. 回归烟测（与 goal 弱相关）

| # | 步骤 | 期望 | ☐ |
|---|------|------|---|
| X1 | 普通发送 / 停止 / 排队 | cancel 与 goal pause 不互相打挂 | |
| X2 | 附件发图 | 预览与发送仍可用（与路径沙箱产品语义一致） | |
| X3 | 设置里账户区 | 仍可进（若本分支含设置排序改动） | |

---

## 结果记录

| 项 | 填写 |
|----|------|
| 日期 | 2026-07-24 |
| 构建 / commit | `feat/goal-align-cli` · Host E2E（非 Electron UI） |
| 环境（OS / grok 版本） | Windows · vitest + `fake-acp-agent.mjs` |
| P0 全过？ | **协议/投影层：是** · **真 UI / 真 grok agent：未跑** |
| 失败用例编号 | 无（`test/goal-e2e-host.test.ts` + `session-goal-store` **21/21**） |
| 备注 / 截图 | 见下方「自动化对照」 |

### 自动化对照（Host + fake agent · 2026-07-24）

> 命令：`npx vitest run test/goal-e2e-host.test.ts test/session-goal-store.test.ts`  
> **可自动**：协议投影、slash wire、多会话隔离、防复活 store。  
> **须人手**：Electron banner/chip/toast 观感、compose placeholder、+菜单、真 grok OAuth、Stop 顺带 pause、冷启动 jsonl resume（M5）、plan 边界（R*）、blocked/classifier（S2–S3）。

| 清单 # | 自动化 | 结果 |
|--------|--------|------|
| N1–N2 | ✅ `N1/N2 ordinary prompts…` | PASS |
| N3 | ✅ `update_goal tool noise…` | PASS |
| N4 | 🔶 切会话 UI | 人手 |
| P1 | 🔶 compose / placeholder | 人手 |
| P2–P4 | ✅ `/goal objective creates…` | PASS |
| P5 | ✅ `follow-up plain message…` | PASS |
| P6–P7 | 🔶 入口变体 UI | 人手（wire 同 P2） |
| L1 | ✅ `/goal status` 不破坏投影 | PASS（toast 文案人手） |
| L2–L3 | ✅ pause / resume | PASS |
| L4 | 🔶 Stop/Esc → pause | 人手 |
| L5–L6 | ✅ clear + plain clean | PASS |
| L7 | ✅ new goal after clear | PASS |
| B1 / B3 | 🔶 budget 弹窗 | 人手 |
| B2 | ✅ `--budget 50000` | PASS |
| C1 | ✅ `/goal complete`（fake） | PASS |
| C2 | ✅ late same-id dropped | PASS |
| C3 | 🔶 完成展示期噪声 | 部分由 store 单元覆盖 |
| M1–M2 | ✅ A/B isolation | PASS |
| M3 | 🔶 busy/turn 切回 | 人手 / 另有 turn store 测 |
| M4 | ✅ dirty `goal.json` 非权威 | PASS（偏 store API） |
| M5 | 🔶 真 jsonl bootstrap | 人手 / 真 agent |
| R1–R2 | 🔶 plan 边界 | 人手 |
| S1 | ✅ planning phase | PASS |
| S2–S4 | 🔶 verifying / blocked / elapsed UI | store 单元有 elapsed floor；UI 人手 |
| D1–D3 | 🔶 日志 / 目录 | 投影路径已测；日志字段人手 |
| X1–X3 | 🔶 弱相关回归 | 人手 / 其它套件 |

### P0 最小集（时间紧时只跑这些）

1. **N1–N2** 普通对话不自动开目标  
2. **P2–P4** `/goal` 开启 + banner  
3. **L2–L3** pause / resume  
4. **L5–L6** clear 后干净  
5. **M1–M2** 双会话不串  
6. **M4** 冷启动无脏 goal  

---

## 现阶段仍需手测（Host E2E 之后）

> **前提**：`npx vitest run test/goal-e2e-host.test.ts test/session-goal-store.test.ts` 已绿（协议/投影）。  
> **环境**：`npm run build` → `npm start`，OAuth / 可用真 grok agent，**新干净会话**。  
> **分工**：自动化已证明 wire/store；手测盯 **banner / chip / toast / 按钮 / compose / 真 agent / 冷启动**。

### 标注

| 标记 | 含义 |
|------|------|
| **全手测** | 几乎无自动化 |
| **UI 仍手测** | wire/store 已测，须看真实 DOM/交互 |
| **可选** | P2 或弱相关，时间紧可跳 |

### A. 每次准备

| # | 步骤 | 标记 |
|---|------|------|
| 0.1 | 分支 `feat/goal-align-cli`，`npm run build` 无 tsc 错 | 全手测 |
| 0.2 | `npm start`，能正常发消息 | 全手测 |
| 0.3 | 新干净会话，无旧 goal banner | 全手测 |
| 0.4 | （建议）Host 日志可搜 `goal.apply` / `goal.drop_stale` | 可选 |

### B. P0 必做

#### 负例

| # | 步骤 / 期望 | 标记 |
|---|-------------|------|
| N1 | 普通需求一句 → **无** banner、**无** goal chip（含 draft） | UI 仍手测 |
| N2 | 多轮读文件/改代码/提问 → 全程无目标 UI | UI 仍手测 |
| N3 | 时间线若出现 `update_goal` 工具卡 → **仍不**抬「进行中的目标」条 | UI 仍手测 |
| N4 | 切另一干净会话再回来 → 仍无目标 UI | 全手测 |

#### 开启

| # | 步骤 / 期望 | 标记 |
|---|-------------|------|
| P1 | `/goal` 无正文 或 `+`→目标 → compose、placeholder、draft chip；**未**完成 harness | 全手测 |
| P2–P4 | 发目标正文 → 感知为 `/goal …`；banner（kicker/Planning）+ chip 标题；elapsed/phase 若有 | UI 仍手测 |
| P5 | 普通跟进一句 → banner **不消失** | UI 仍手测 |
| P6 | （任选）一行 `/goal …` 直发 | 可选 |
| P7 | （任选）`+` 菜单「目标」再写再发 | 可选 |

#### 生命周期

| # | 步骤 / 期望 | 标记 |
|---|-------------|------|
| L1 | slash「目标状态」→ toast 含标题 + 状态 | UI 仍手测 |
| L2 | banner **暂停** 或 `/goal-pause` → 暂停 kicker；pause 隐 / resume 显；计时停 | UI 仍手测 |
| L3 | **恢复** 或 `/goal-resume` → 进行中；真 agent 继续 | UI 仍手测 |
| L4 | in-flight 时 **Stop/Esc** → 是否顺带 pause + toast；队列符合 cancel | 全手测 |
| L5 | **清除** → banner/chip 立刻消失 + toast「已清除」 | UI 仍手测 |
| L6 | clear 后普通聊 1–2 轮 → 不再自动出目标条 | UI 仍手测 |
| L7 | clear 后再 `/goal 新目标B` → 能新建 | UI 仍手测 |

#### 多会话 / 冷启动

| # | 步骤 / 期望 | 标记 |
|---|-------------|------|
| M1 | A 有 goal，B 普通聊 → B **无** A 的 banner | UI 仍手测 |
| M2 | B 切回 A → A 目标仍对 | UI 仍手测 |
| M3 | A goal 进行中切 B 再回 → 不丢条；busy/turn **不串会话** | 全手测 |
| M4 | 退出再开，打开**从未 /goal** 的旧会话 → **无**脏 goal 假「进行中」 | 全手测（真冷启动） |
| M5 | 打开 agent 侧**确实有** goal 的会话 → bootstrap 显示 | 全手测 |

### C. P1 建议做

| # | 步骤 / 期望 | 标记 |
|---|-------------|------|
| B1 | `/goal-budget` 设小预算 → toast；已有 goal 时同步 `--budget` | 全手测（弹窗） |
| B2 | `/goal … --budget N` → banner 是否显示 budget（依赖 agent 字段） | UI 仍手测 |
| B3 | 弹窗「清除预算」→ 本地清空；后续新建不带 `--budget` | 全手测 |
| C1 | 极易完成的**真** goal →「已完成」+ toast → 数秒收起 | 全手测（真完成） |
| C2–C3 | 完成/clear 后无回魂；完成展示期不被打回 active | UI 仍手测 |
| R1 | 仅 `/plan` → 有 plan、**无** goal banner | 全手测 |
| R2 | plan 与 goal 可并存；clear goal 不影响 plan 审批 | 全手测 |
| D1–D3 | 日志 `goal.apply` / `goal.drop_stale`；目录 `goal-projection.json` 非脏 `goal.json` 独断 | 全手测 |

### D. P2 / 可选（碰到再勾）

| # | 步骤 / 期望 |
|---|-------------|
| S1–S4 | planning / verifying / blocked / elapsed 心智（S2–S3 依赖真 agent，难稳定复现） |
| X1–X3 | 发送·停止·排队与 goal 不互挂；附件发图；设置账户区 |

### E. 最小手测路径（约 10–15 分钟）

时间紧时只跑这一条路径，覆盖当前最大风险：

1. **0.1–0.3** 构建 + 启动 + 干净会话  
2. **N1–N2** 普通聊两轮 → 无目标 UI  
3. **P1**（可选但快）compose 入口  
4. **P6 或 P2–P4** 一条 `/goal …` → banner + chip  
5. **P5** 普通跟进 → banner 仍在  
6. **L2 → L3** 暂停 / 恢复（优先点 banner）  
7. **L5 → L6** 清除 → 再聊仍干净  
8. **M1–M2** 双会话不串  
9. **M4** 重启后打开未 goal 旧会话 → 无假 banner  

有余力再加：**L4**（Stop）、**L1** toast、**B1/B3** 弹窗、**R1** plan、**C1** 短真完成。

### F. 一句话对照

| 已不需要为「协议对不对」再手测 | 手测真正盯的 |
|--------------------------------|--------------|
| 无 `/goal` 不写投影、tool 不合成、pause/clear/budget 数字、A/B store 隔离、clear 后同 id 不回魂 | **真窗口** banner/chip/toast/按钮/compose、**真 grok** 继续与完成、**切会话/冷启动/Stop**、plan 边界、日志字段 |

---

## 对照矩阵

| 清单块 | 矩阵 |
|--------|------|
| §1 负例 | G4b |
| §2 开启 | G4a / G4b |
| §3 生命周期 | G4a / G4c |
| §4 budget | G4a |
| §5 完成 / 防复活 | G4c |
| §6 多会话 | G4b + session store |
| §8 细状态 | G4c / G4d |

失败时优先查：是否误走 tool 合成、是否 `userOptedInGoal` 残留逻辑、Host 是否对非 `goal_updated` 写投影。
