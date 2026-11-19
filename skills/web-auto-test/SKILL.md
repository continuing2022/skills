---
name: web-auto-test
description: 当用户需要在真实浏览器中按需求或用例验收 Web 页面、探索给定 URL 中的异常，或需要扫码登录后接力测试并交付可复核的测试报告时使用。
---

# Web AI 自动化测试（通用底座 + 项目插件）

本 skill 通过「**AI 决策与校验 + Playwright 持久会话 CLI**」驱动真实浏览器完成 Web 自动化测试，并自动记录每一步操作与截图，输出 Markdown 测试报告。

> **跨平台注意**：使用 Node.js 20 或更新版本。所有 CLI 命令均通过 `node <skill_dir>/scripts/webtest.cjs ...` 调用，macOS 与 Windows 通用；不要用 `./` 直接执行镜像脚本。
> 运行依赖 `playwright-core` 会在首次 `start` 时自动安装到 `~/.cache/web-auto-test/`（不污染当前仓库 `package.json`），默认复用本机已安装的 Chrome（无需下载大体积 Chromium）。

---

## 一、触发时机与前置检查

### 适用场景
- 用户提供一个 **Web URL + 需求/用例清单**，希望 AI 打开浏览器逐条点击、输入、断言并产出测试报告（**用例驱动模式**）
- 用户只提供一个 **Web URL + 测试目标**，希望 AI 自主浏览交互、排查功能异常并记录问题（**自由探索模式**）
- 需要持久化登录态、在真实浏览器窗口里边看 AI 操作边接力处理扫码/验证码登录

### 项目适配插件（可选）
底座本身零项目硬编码。如果被测对象属于特定业务项目，先检查 `adapters/` 下是否有对应适配插件并读取：
- 当前仓库 WegoKuikly H5 / 门户项目：见 [`adapters/wego-h5.md`](adapters/wego-h5.md)
- 新增其他项目适配：复制 [`adapters/TEMPLATE.md`](adapters/TEMPLATE.md)

---

## 二、标准执行流程（SOP）

### 第 1 步：确定模式与测试计划
在操作浏览器前，先在对话中向用户明确简短的测试计划：
- **用例驱动模式（`--mode case-driven`）**：把用户提供的 PRD、需求描述或用例文档拆解为编号清单（`TC-01`、`TC-02`…），每条写清「名称 + 核心步骤 + 预期结果」。
- **自由探索模式（`--mode exploratory`）**：列出本次探索的关注模块/主路径（如导航入口、搜索筛选、表单校验、核心业务闭环）。

### 第 2 步：启动持久化浏览器会话
```bash
# 默认：有头可见窗口 + 桌面端 1440x900 + 持久化 Profile
node <skill_dir>/scripts/webtest.cjs start \
  --name "<本次测试名称>" \
  --mode case-driven \
  --viewport desktop

# 移动端 H5 视口（390x844 + 触屏模拟）：
node <skill_dir>/scripts/webtest.cjs start --name "<测试名称>" --viewport mobile

# 接管本机已开启调试端口的 Chrome（不会关闭原浏览器）：
node <skill_dir>/scripts/webtest.cjs start --name "<测试名称>" --cdp http://127.0.0.1:9222

# 无头模式 / 指定输出目录 / 独立账号 Profile：
node <skill_dir>/scripts/webtest.cjs start --name "<测试名称>" --headless --profile staging --out tmp/my-report
```
记录返回的 `outDir`（默认 `tmp/web-test-reports/<timestamp>-<slug>/`）。并行测试时给每个 Agent 分配独立的 `--session`、`--profile` 和 `--out`，每条命令都带对应的 `--session`。使用 CDP 时为各会话分配独立的 Chrome 实例和端口。涉及写入的用例也应分配各自的测试数据。

### 第 3 步：打开入口页 & 登录态人机接力
```bash
node <skill_dir>/scripts/webtest.cjs open "<入口 URL>" --screenshot landing
node <skill_dir>/scripts/webtest.cjs snapshot
```

**登录态铁律（人机暂停接力）**：
1. 如果页面跳转到登录页，或出现**微信扫码、手机验证码、图形/滑块验证码、SSO 授权**等需要真人完成的环节：
   - **立即停止尝试点击/绕过**（禁止伪造或暴力尝试验证码/滑块）；
   - 确保当前是有头可见窗口（若误开了 `--headless`，先 `stop` 再以有头模式重启）；
   - 明确告知用户：「浏览器已停在登录页，请在该窗口完成登录，完成后回复我继续。」并等待用户回复。
2. 用户完成登录后，Profile 会自动保存登录态，先跑一次 `snapshot` 或目标页 `open` 确认已登录，再进入正式测试。

账号、密码和验证码优先由用户在浏览器窗口输入。CLI 的位置参数可能出现在工具日志或进程列表。普通 `fill` 和 `type` 的值默认在测试产物里遮蔽。`--record-value` 只用于公开的测试输入。密码字段、标准账号/验证码自动填充字段和标记为 `data-webtest-private` 的元素始终遮蔽，截图也会遮住匹配的元素。分享产物前检查页面内容、截图、URL 和诊断信息中的业务数据。

### 第 4 步：执行测试循环（用例驱动 / 自由探索）

#### 推荐的最小操作闭环
1. **声明用例开始**（探索模式也可按模块建 `EXP-01` 等分组，方便报告结构化）：
   ```bash
   node <skill_dir>/scripts/webtest.cjs case-start --id TC-01 --title "搜索商品并查看详情" --expected "列表展示匹配商品且点击可进入详情页"
   ```
2. **获取可交互快照**（每次页面变化后调用，`@e1`、`@e2` 为当次有效定位句柄）：
   ```bash
   node <skill_dir>/scripts/webtest.cjs snapshot
   ```
3. **执行交互操作**（优先使用 `snapshot` 返回的 `@eN`）：
   ```bash
   node <skill_dir>/scripts/webtest.cjs fill @e3 "测试关键词"
   node <skill_dir>/scripts/webtest.cjs click @e4 --screenshot search-result
   node <skill_dir>/scripts/webtest.cjs wait --text "搜索结果" --timeout 8000
   ```
4. **执行状态校验（断言）**：
   ```bash
   node <skill_dir>/scripts/webtest.cjs assert text "搜索结果"
   node <skill_dir>/scripts/webtest.cjs assert url "/search"
   node <skill_dir>/scripts/webtest.cjs assert visible @e12
   ```
   - 断言通过退出码为 `0`。失败退出码为 `2`，脚本会尝试截图。用 `--label "检查点名称"` 把关键断言列在验收报告中。
   - 涉及多个预期的用例要逐项验收。可以用断言，也可以用 `check` 记录人工或自定义检查的依据。
     ```bash
     node <skill_dir>/scripts/webtest.cjs check --label "库存列表刷新" --status blocked \
       --expected "切换后展示新仓库库存" --actual "当前测试仓库无商品数据" --screenshot
     ```
5. **标记用例结束**。结束时显式指定 `pass`、`fail`、`blocked` 或 `skipped`，并写明实际结果。存在失败断言、失败或阻塞检查点的尝试无法标为通过。数据或环境缺失用 `blocked`，用户明确排除的检查用 `skipped`。
   ```bash
   node <skill_dir>/scripts/webtest.cjs case-end --status pass --actual "成功展示 12 条结果并进入详情页" --screenshot
   ```
6. **探索模式发现 Bug 时随时登记**：
   ```bash
   node <skill_dir>/scripts/webtest.cjs issue \
     --title "点击筛选重置按钮后列表未刷新" \
     --severity medium \
     --description "选中分类后点击重置，筛选标签清空但列表仍停留在旧数据" \
     --repro "1. 打开列表页 2. 选择分类 A 3. 点击重置按钮"
   ```

### 第 5 步：高危写操作安全确认（强制红线）
在执行以下**不可逆或影响真实业务数据**的操作前，**必须暂停并向用户明确确认**：
- 支付、下单、转账、退款、发券
- 删除数据、清空内容、注销账号、权限变更
- 面向外部用户的正式发布、群发消息、线上生产环境写提交

确认话术需写清「当前页面 URL + 即将点击的按钮/提交内容 + 可能产生的影响」，获得用户同意后再继续。

用 `change` 登记测试造成的数据变更。记录安全的业务标识、影响及恢复情况。恢复操作也按其实际影响判断是否需要授权。
```bash
node <skill_dir>/scripts/webtest.cjs change --id warehouse-order --description "调整测试仓库顺序"
node <skill_dir>/scripts/webtest.cjs change --id warehouse-order --status restored --note "刷新确认原顺序已恢复"
```
清理状态可用 `pending`（默认）、`restored`、`retained` 或 `irreversible`。

### 第 6 步：失败重试与继续策略
- **单条用例失败**：
  1. 先把该次执行用 `case-end` 关闭并记录实际失败现象。确认恢复路径安全时，用同一个用例 ID 再 `case-start` 重试一次，刷新快照并等待有意义的页面状态。所有尝试都会保留。
  2. 提交、上传或其他有副作用的动作失败时，先检查上一次是否已生效，再决定是否重试。重试仍失败时保留失败截图，从安全状态继续其余用例。
- **全局阻断（立即暂停并报告用户）**：
  - 登录态中途失效被踢回登录页
  - 被测服务宕机 / 端口不可达 / 整站白屏崩溃

### 第 7 步：生成测试报告与收尾
```bash
# 生成最终报告并关闭本次测试会话（stop 默认会自动调用 report 刷新 report.md）
node <skill_dir>/scripts/webtest.cjs stop --summary "库存列表受测试数据限制"
```
`stop` 将尚未结束的用例登记为阻塞。需要保留浏览器窗口继续检查时，运行 `report` 生成当前进度。统计由脚本生成，摘要适合记录范围和主要发现。
```bash
node <skill_dir>/scripts/webtest.cjs report --summary "..."
```
最后在回复中向用户汇报：
- 测试总览（通过/失败/阻塞数）
- 失败用例与发现问题的精炼摘要
- `report.md` 及关键截图的可点击文件链接。通过报告中的执行记录链接可打开 `report.raw.md` 查看完整步骤和复测历史。
- 测试数据变更、清理结果和需交接的遗留项。

报告结构规范见 [`references/report-template.md`](references/report-template.md)。

---

## 三、CLI 常用命令速查

| 分类 | 命令 | 说明 |
|---|---|---|
| 会话 | `start [--name --mode --viewport --headless --profile --cdp --out --session]` | 启动持久化浏览器并初始化报告目录 |
| 会话 | `status` / `forget` | 查询为只读。退出的会话可用 `forget` 显式清理索引 |
| 会话 | `stop [--summary "..."] [--no-report]` | 输出报告并关闭会话（CDP 模式仅断开不杀原浏览器） |
| 导航 | `open <url> [--screenshot [name]]` | 打开 URL（可选截图） |
| 导航 | `reload` / `back` | 刷新 / 后退 |
| 观察 | `snapshot [--json] [--max-elements 120]` | 获取页面可见可交互元素（`@e1`…）与文本摘要 |
| 观察 | `screenshot [name] [--full-page]` | 手动截图并记入当前用例 |
| 交互 | `click <@ref\|sel> [--force] [--screenshot]` | 点击元素 |
| 交互 | `fill <@ref\|sel> <value>` / `type <@ref\|sel> <value>` | 填充 / 逐字输入，默认遮蔽输入值 |
| 交互 | `select <@ref\|sel> <value>` / `press <key>` / `hover <@ref\|sel>` | 下拉选择 / 按键 / 悬停 |
| 交互 | `scroll [down\|up\|left\|right] [amount]` 或 `scroll --target <@ref\|sel>` | 滚动页面或滚动到元素 |
| 等待 | `wait [--ms 1000 \| --selector <sel> \| --text <txt> \| --url <substr>]` | 等待条件满足 |
| 断言 | `assert <text\|not-text\|url\|title\|visible\|hidden\|value> ...` | 功能与页面状态校验（失败自动截图，退出码 2） |
| 多页签 | `tabs [list \| switch <idx> \| new [url] \| close]` | 查看/切换/新建/关闭标签页 |
| 记录 | `case-start --id <id> --title "<name>" [--expected "..."]` | 开始记录一条用例 |
| 记录 | `case-end --status <pass\|fail\|blocked\|skipped> [--actual --note --screenshot]` | 结束当前用例并落盘 |
| 记录 | `check --label <name> --status <status> [--expected --actual --screenshot]` | 登记一个可独立验证的检查点 |
| 记录 | `change --id <id> [--description --status --note]` | 登记变更或更新清理状态 |
| 记录 | `issue --title "<bug>" [--severity high\|medium\|low] [--description --repro]` | 登记探索发现的问题（自动截图） |
| 报告 | `report [--summary "..."]` | 渲染 `report.md` 和 `report.raw.md` |

---

## 四、常见问题排查

| 现象 | 原因与处理 |
|---|---|
| 首次 `start` 提示 `playwright-core` 安装失败 | 检查本机 `npm` 网络与权限，或手动执行 `mkdir -p ~/.cache/web-auto-test && cd ~/.cache/web-auto-test && npm install playwright-core` |
| 找不到 Chrome 浏览器 | 默认按 `chrome` → `msedge` → 内置 Chromium 顺序尝试；若装在自定义路径，传 `--executable-path "<Chrome 路径>"` |
| `@eN` 点击提示找不到元素 | 页面已局部重渲染导致旧引用失效，先重新执行一次 `snapshot` 获取最新 `@eN` 再点击 |
| 点击后新开了标签页 | 守护进程会自动切换活跃页到新标签；如需切回原页，用 `tabs list` 与 `tabs switch 0` |
| 需要同时跑两个互不干扰的测试 | 使用不同的 `--session <name>` 与 `--profile <name>` 隔离会话和登录态 |
| `status` 返回 `SESSION_UNREACHABLE` | 回到能够连接本机后台的环境再查询。该错误会保留索引 |
| `status` 返回 `SESSION_EXITED` | 进程已退出，可先 `forget --session <name>` 再启动。已有报告和 Profile 会保留 |
