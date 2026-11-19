---
name: "web-auto-test"
description: "通用 Web AI 自动化测试工具与工作流（Playwright 持久会话 CLI + 自动记录 + Markdown 测试报告）。支持按需求/用例清单精准验收，以及给 URL 做自由探索式测试；自带持久化登录态与人机暂停接力、高危写操作确认、失败自动重试与截图留证。需要让 AI 实际打开浏览器操作测试任意 Web 页面并输出结构化测试报告时调用。"
---

# Web AI 自动化测试（通用底座 + 项目插件）

本 skill 通过「**AI 决策与校验 + Playwright 持久会话 CLI**」驱动真实浏览器完成 Web 自动化测试，并自动记录每一步操作与截图，输出 Markdown 测试报告。

> **跨平台注意**：所有 CLI 命令均通过 `node <skill_dir>/scripts/webtest.cjs ...` 调用，macOS 与 Windows 通用；不要用 `./` 直接执行镜像脚本。
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
记录返回的 `outDir`（默认 `tmp/web-test-reports/<timestamp>-<slug>/`）。

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
   - 断言通过退出码为 `0`；失败退出码为 `2`，并**自动截取失败现场图**。
5. **标记用例结束**：
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

### 第 6 步：失败重试与继续策略
- **单条用例失败**：
  1. 自动**重试 1 次**（重新 `snapshot` 确认元素未变更，或刷新当前页重跑该用例步骤，排除偶发加载延迟）。
  2. 重试仍失败：确认已保留失败截图，调用 `case-end --status fail --actual "<具体现象与误差>"`，然后恢复到入口页或安全状态，**继续跑完剩余用例**。
- **全局阻断（立即暂停并报告用户）**：
  - 登录态中途失效被踢回登录页
  - 被测服务宕机 / 端口不可达 / 整站白屏崩溃

### 第 7 步：生成测试报告与收尾
```bash
# 生成最终报告并关闭本次测试会话（stop 默认会自动调用 report 刷新 report.md）
node <skill_dir>/scripts/webtest.cjs stop --summary "共执行 N 条用例，通过 X 条，失败 Y 条；核心阻塞项为……"
```
若用户希望保留浏览器窗口继续人工检查，可只跑 `report` 而不跑 `stop`：
```bash
node <skill_dir>/scripts/webtest.cjs report --summary "..."
```
最后在回复中向用户汇报：
- 测试总览（通过/失败/阻塞数）
- 失败用例与发现问题的精炼摘要
- `report.md` 及关键截图的可点击文件链接

报告结构规范见 [`references/report-template.md`](references/report-template.md)。

---

## 三、CLI 常用命令速查

| 分类 | 命令 | 说明 |
|---|---|---|
| 会话 | `start [--name --mode --viewport --headless --profile --cdp --out --session]` | 启动持久化浏览器并初始化报告目录 |
| 会话 | `status` | 查看当前 URL、标题、活跃用例、标签页与错误计数 |
| 会话 | `stop [--summary "..."] [--no-report]` | 输出报告并关闭会话（CDP 模式仅断开不杀原浏览器） |
| 导航 | `open <url> [--screenshot [name]]` | 打开 URL（可选截图） |
| 导航 | `reload` / `back` | 刷新 / 后退 |
| 观察 | `snapshot [--json] [--max-elements 120]` | 获取页面可见可交互元素（`@e1`…）与文本摘要 |
| 观察 | `screenshot [name] [--full-page]` | 手动截图并记入当前用例 |
| 交互 | `click <@ref\|sel> [--force] [--screenshot]` | 点击元素 |
| 交互 | `fill <@ref\|sel> <value>` / `type <@ref\|sel> <value>` | 填充 / 逐字输入 |
| 交互 | `select <@ref\|sel> <value>` / `press <key>` / `hover <@ref\|sel>` | 下拉选择 / 按键 / 悬停 |
| 交互 | `scroll [down\|up\|left\|right] [amount]` 或 `scroll --target <@ref\|sel>` | 滚动页面或滚动到元素 |
| 等待 | `wait [--ms 1000 \| --selector <sel> \| --text <txt> \| --url <substr>]` | 等待条件满足 |
| 断言 | `assert <text\|not-text\|url\|title\|visible\|hidden\|value> ...` | 功能与页面状态校验（失败自动截图，退出码 2） |
| 多页签 | `tabs [list \| switch <idx> \| new [url] \| close]` | 查看/切换/新建/关闭标签页 |
| 记录 | `case-start --id <id> --title "<name>" [--expected "..."]` | 开始记录一条用例 |
| 记录 | `case-end --status <pass\|fail\|blocked\|skipped> [--actual --note --screenshot]` | 结束当前用例并落盘 |
| 记录 | `issue --title "<bug>" [--severity high\|medium\|low] [--description --repro]` | 登记探索发现的问题（自动截图） |
| 报告 | `report [--summary "..."]` | 渲染 `<outDir>/report.md` |

---

## 四、常见问题排查

| 现象 | 原因与处理 |
|---|---|
| 首次 `start` 提示 `playwright-core` 安装失败 | 检查本机 `npm` 网络与权限，或手动执行 `mkdir -p ~/.cache/web-auto-test && cd ~/.cache/web-auto-test && npm install playwright-core` |
| 找不到 Chrome 浏览器 | 默认按 `chrome` → `msedge` → 内置 Chromium 顺序尝试；若装在自定义路径，传 `--executable-path "<Chrome 路径>"` |
| `@eN` 点击提示找不到元素 | 页面已局部重渲染导致旧引用失效，先重新执行一次 `snapshot` 获取最新 `@eN` 再点击 |
| 点击后新开了标签页 | 守护进程会自动切换活跃页到新标签；如需切回原页，用 `tabs list` 与 `tabs switch 0` |
| 需要同时跑两个互不干扰的测试 | 使用不同的 `--session <name>` 与 `--profile <name>` 隔离会话和登录态 |
