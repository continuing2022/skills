---
name: qa-test-design
description: Use when asked to design QA scope and optionally create Excel test cases from a commit, branch comparison, feature, requirement, or confirmed impact report.
---

# 测试设计入口

默认交付给测试人员，围绕「修改文件、影响范围、测试范围」组织 Markdown。测试范围按业务模块列出可执行场景，具体格式由 `test-impact-analysis` 定义。将用户指定的参考文档及其用途一并传入范围阶段。仅供参考格式的用例文档不作为本轮范围、执行参数或操作授权的依据。

指定分支、提交或作者用于确定分析范围。用户要求审计或提交明细时，再按要求提供对比证据。

1. 用户明确只要范围或要求先评审时，读取同级 `../test-impact-analysis/SKILL.md`，交付或复核独立的 Markdown 后停在范围阶段。已有范围文件时，以指定版本为基础。
2. 已有明确确认的影响范围文件时，直接读取同级 `../test-case-excel/SKILL.md` 并执行。以本轮指定的文件版本为准。未确认的文件继续应用下面的判断条件。
3. 其余情况先读取同级 `../test-impact-analysis/SKILL.md`，按要求完成并保存独立的 Markdown。
4. 仅当范围局部、受影响功能和平台都已核实、预期行为有依据，且没有会改变范围或预期的待确认项时，才在同一轮读取并执行 `../test-case-excel/SKILL.md`。其余情况也先交付 Markdown，点明需要确认的内容。
5. 恢复时以用户确认或修订的范围为准。仍缺少可执行前置条件或可观察的预期结果时，指出具体场景与缺口。交付时链接实际写出的文件。

从本 Skill 所在目录解析子 Skill 路径。按需读取并在当前会话执行，两个子 Skill 也支持独立调用。
