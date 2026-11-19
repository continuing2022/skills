# 测试报告格式说明

`scripts/reporter.cjs` 会根据每次运行自动落盘的 `session.json`，在 `<outDir>/report.md` 生成如下结构的 Markdown 测试报告：

## 目录产物
```text
tmp/web-test-reports/<YYYYMMDD-HHMMSS>-<slug>/
├── report.md           # 可直接分享或归档的 Markdown 报告
├── session.json        # 全量结构化执行数据（用例、步骤、截图路径、报错摘要）
├── daemon.log          # 浏览器守护进程运行日志（排障用）
└── screenshots/        # 按序号归档的关键节点与失败现场截图
    ├── 001-landing.png
    ├── 002-tc-01-pass.png
    └── 003-tc-02-fail.png
```

## 报告章节结构
1. **测试概览**：模式、入口 URL、浏览器与视口、起止耗时、用例通过率统计与一句话总结。
2. **用例执行结果**：按用例 ID 汇总状态（`✅ PASS` / `❌ FAIL` / `⏸️ BLOCKED` / `⏭️ SKIPPED`）、耗时与结论说明。
3. **失败用例与问题详情**：前置高亮展示所有失败/阻塞用例及探索发现的 Bug，包含预期 vs 实际、复现步骤、页面 URL、嵌入式现场截图，以及折叠的辅助诊断信息（Console/Network 报错）。
4. **详细操作记录**：按用例分节列出每一步的动作、目标/输入、执行结果、耗时及截图链接。
5. **产物目录**：指向 `report.md`、`session.json` 与 `screenshots/`。

## 离线重新渲染
如果手动补充或修订了 `session.json`，可随时离线重新生成 `report.md`：
```bash
node <skill_dir>/scripts/reporter.cjs "<outDir>"
```
