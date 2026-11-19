# WegoKuikly H5 / 门户项目适配插件

当本次被测对象是本仓库的 **Kuikly H5 页面（`h5App-js`）** 或 **`wsxc_portal` 门户 H5 页面** 时，遵循本适配说明衔接既有工程流程。

> 详细的启服、编译与验包步骤已在 WegoKuikly 仓库内文档维护，本插件直接复用、不重复定义：
> - 编译与构建校验：项目内 `web-check` skill
> - 启服（`:8080` 门户 + `:9090` `h5App-js`）与验包：项目内 `simulator-setup-and-run` skill 的 `references/H5_BROWSER.md`

---

## 1. 测试前必做：端口与包新鲜度检查

在执行 `webtest.cjs start` 之前，先确认两个本地服务活着且包不是旧缓存：
- 门户服务 `localhost:8080`（`wsxc_portal`，注意默认环境选 `--env=3` 客户云）
- 宿主 dev server `localhost:9090`（`h5App-js`）

若改动了 `kuikly_shared/**` 或 `core-render-web/**`，请先按 `H5_BROWSER.md` 第二节完成重编与 `curl` 验包，再开始自动化测试，避免对着旧 bundle 误报 Bug。

---

## 2. 推荐启动方式

### 方式 A：独立持久化 Profile（推荐，默认移动端 H5 视口）
```bash
node .agents/skills/web-auto-test/scripts/webtest.cjs start \
  --name "wego-h5-<页面名>" \
  --viewport mobile \
  --profile wego-h5
```

### 方式 B：接管已登录的调试 Chrome（已有 `:9222` CDP 窗口时）
如果按 `H5_BROWSER.md` 4.1 已经起好了带登录态的 `:9222` 调试 Chrome，可直接接管（测试结束 `stop` 不会关闭该 Chrome）：
```bash
node .agents/skills/web-auto-test/scripts/webtest.cjs start \
  --name "wego-h5-<页面名>" \
  --cdp http://127.0.0.1:9222
```

---

## 3. 入口 URL 与登录态判定

- **登录入口**：`http://localhost:8080/static/index.html#/pc_login`
- **Kuikly H5 页面入口**：`http://localhost:8080/kuikly_static/index.html?page_name=<页面名>`
- **登录态判定**：
  - 停留在 `#/pc_login`、或页面提示未登录 / `NO real customer (not logged in?)` → **暂停测试**，提示用户在可见浏览器窗口完成微信扫码或手机号登录，完成后再继续。
  - 登录成功后 URL 通常跳转到 `#/album_home`（含 `shop_id`），此时切回目标 `page_name` URL 继续执行。

---

## 4. H5 场景注意事项

1. **Kuikly Web 渲染节点**：Kuikly 渲染出的按钮多为带 `cursor: pointer` 的 `div` 而非原生 `<button>`，`snapshot` 已内置启发式识别；若个别自定义画布/复杂手势元素未被标出 `@eN`，可用 `eval` 查询坐标或 CSS 选择器精准定位。
2. **避免缓存假象**：若刚重新编过业务包，进入页面后可先执行一次 `reload` 再测。
3. **高危写操作**：涉及真实客户云环境的**创建/修改/删除商品、发布动态、发券、下单、修改客户储值/账单**等操作前，必须先暂停向用户确认。
