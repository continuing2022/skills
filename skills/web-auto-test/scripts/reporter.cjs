'use strict';

const fs = require('fs');
const path = require('path');

function statusBadge(status) {
  switch (String(status || '').toLowerCase()) {
    case 'pass':
    case 'passed':
      return '✅ PASS';
    case 'fail':
    case 'failed':
      return '❌ FAIL';
    case 'blocked':
      return '⏸️ BLOCKED';
    case 'skipped':
    case 'skip':
      return '⏭️ SKIPPED';
    case 'running':
      return '🔄 RUNNING';
    default:
      return `ℹ️ ${String(status || 'UNKNOWN').toUpperCase()}`;
  }
}

function fmtMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeCell(str) {
  return String(str ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function toRelLink(outDir, filePath) {
  if (!filePath) return '';
  if (!path.isAbsolute(filePath)) return filePath.replace(/\\/g, '/');
  return path.relative(outDir, filePath).replace(/\\/g, '/');
}

function displayStep(step) {
  const hidesValue = (['fill', 'type'].includes(step.action) && step.recordValue !== true) ||
    step.action === 'assert:value';
  if (!hidesValue || !step.value || step.value === '[已隐藏]') return step;
  return {
    ...step,
    value: '[已隐藏]',
    actual: typeof step.actual === 'string' ? step.actual.replaceAll(step.value, '[已隐藏]') : step.actual,
    error: typeof step.error === 'string' ? step.error.replaceAll(step.value, '[已隐藏]') : step.error
  };
}

function groupAttempts(cases) {
  const groups = new Map();
  for (const attempt of cases) {
    if (!groups.has(attempt.id)) groups.set(attempt.id, []);
    groups.get(attempt.id).push(attempt);
  }
  return [...groups.values()].map((attempts, index) =>
    attempts.map((attempt, attemptIndex) => ({
      ...attempt,
      steps: (attempt.steps || []).map(displayStep),
      anchor: `case-${index + 1}-attempt-${attemptIndex + 1}`
    })));
}

function appendStepTable(lines, steps, outDir) {
  if (!steps.length) {
    lines.push('_无操作步骤记录_', '');
    return;
  }
  lines.push('| # | 动作 | 目标 / 预期 | 实际 / 状态 | 耗时 | 截图 |');
  lines.push('|---|---|---|---|---|---|');
  steps.forEach((step, index) => {
    const target = [step.label, step.target, step.value].filter(Boolean).join(' · ');
    const status = step.status ? statusBadge(step.status) : (step.ok === false ? '❌' : '✅');
    const result = [status, step.actual, step.error].filter(Boolean).join(' ');
    const shot = step.screenshot ? `[查看](${toRelLink(outDir, step.screenshot)})` : '-';
    lines.push(`| ${index + 1} | \`${escapeCell(step.action)}\` | ${escapeCell(target || '-')} | ${escapeCell(result)} | ${fmtMs(step.durationMs)} | ${shot} |`);
  });
  lines.push('');
}

function renderReportMarkdown(session, outDir, { raw = false } = {}) {
  const groups = groupAttempts(session.cases || []);
  const cases = groups.map((attempts) => attempts.at(-1));
  const issues = session.issues || [];
  const changes = session.changes || [];

  const counts = {
    total: cases.length,
    pass: cases.filter((c) => c.status === 'pass').length,
    fail: cases.filter((c) => c.status === 'fail').length,
    blocked: cases.filter((c) => c.status === 'blocked').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    running: cases.filter((c) => c.status === 'running').length
  };
  const passRate = counts.total > 0 ? `${Math.round((counts.pass / counts.total) * 100)}%` : '-';

  const startTs = session.startedAt ? new Date(session.startedAt).getTime() : null;
  const endTs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const totalDuration = startTs ? fmtMs(Math.max(0, endTs - startTs)) : '-';

  const lines = [];
  lines.push(`# Web 自动化测试报告：${session.name || 'Web Test Run'}`);
  lines.push('');

  // 1. Summary
  lines.push('## 1. 测试概览');
  lines.push('');
  lines.push('| 项目 | 内容 |');
  lines.push('|---|---|');
  lines.push(`| 测试模式 | ${escapeCell(session.mode || 'case-driven')} |`);
  lines.push(`| 入口地址 | ${escapeCell(session.baseUrl || session.lastUrl || '-')} |`);
  lines.push(`| 浏览器 / 视口 | ${escapeCell(session.browserLabel || 'Chrome')} · ${escapeCell(session.viewportLabel || '1440x900')} |`);
  lines.push(`| 开始时间 | ${escapeCell(session.startedAt || '-')} |`);
  lines.push(`| 运行状态 | ${session.endedAt ? '已结束' : '进行中'} |`);
  lines.push(`| 总耗时 | ${totalDuration} |`);
  lines.push(`| 用例统计 | 共 **${counts.total}** 条：✅ 通过 ${counts.pass} · ❌ 失败 ${counts.fail} · ⏸️ 阻塞 ${counts.blocked} · ⏭️ 跳过 ${counts.skipped} · 运行中 ${counts.running}（通过率 ${passRate}） |`);
  if (issues.length > 0) {
    lines.push(`| 发现问题数 | **${issues.length}** 条 |`);
  }
  lines.push('');

  if (session.summaryNote) {
    lines.push(`> **总结**：${session.summaryNote}`);
    lines.push('');
  }

  // 2. Case Summary Table
  if (cases.length > 0) {
    lines.push('## 2. 用例执行结果');
    lines.push('');
    lines.push('| 用例 ID | 用例名称 | 最终状态 | 耗时 | 说明 | 执行记录 |');
    lines.push('|---|---|---|---|---|---|');
    groups.forEach((attempts) => {
      const c = attempts.at(-1);
      const note = c.actual || c.note || c.expected || '-';
      const evidence = attempts.map((attempt, i) =>
        `[${i + 1}. ${statusBadge(attempt.status)}](${raw ? '' : 'report.raw.md'}#${attempt.anchor})`
      ).join(' / ');
      lines.push(`| ${escapeCell(c.id)} | ${escapeCell(c.title)} | ${statusBadge(c.status)} | ${fmtMs(c.durationMs)} | ${escapeCell(note)} | ${evidence} |`);
      const checks = c.steps.filter((step) => step.action === 'check' || step.label);
      for (const step of checks) {
        const label = escapeCell(step.label || step.action);
        const status = statusBadge(step.status || (step.ok ? 'pass' : 'fail'));
        const detail = [step.value && `预期 ${step.value}`, step.actual && `实际 ${step.actual}`, step.error]
          .filter(Boolean).join(' · ');
        lines.push(`| ↳ | ${label} | ${status} | - | ${escapeCell(detail || '-')} | - |`);
      }
    });
    lines.push('');
  }

  // 3. Failures & Discovered Issues (Highlighted)
  const failedCases = cases.filter((c) => c.status === 'fail' || c.status === 'blocked');
  if (failedCases.length > 0 || issues.length > 0) {
    lines.push('## 3. 失败用例与问题详情');
    lines.push('');

    for (const c of failedCases) {
      lines.push(`### ${statusBadge(c.status)} ${c.id}：${c.title}`);
      lines.push('');
      if (c.expected) lines.push(`- **预期结果**：${c.expected}`);
      if (c.actual) lines.push(`- **实际结果**：${c.actual}`);
      if (c.note && c.note !== c.actual) lines.push(`- **备注**：${c.note}`);
      if (c.lastUrl) lines.push(`- **出错页面**：\`${c.lastUrl}\``);

      const failShots = (c.steps || [])
        .filter((s) => s.screenshot)
        .map((s) => ({ step: s, rel: toRelLink(outDir, s.screenshot) }));
      const lastShot = failShots.findLast(({ step }) => step.ok === false) || failShots.at(-1);
      if (lastShot) {
        lines.push(`- **现场截图**：[\`${lastShot.rel}\`](${lastShot.rel})`);
        lines.push('');
        lines.push(`![${c.id} 现场截图](${lastShot.rel})`);
      }

      const reproSteps = (c.steps || []).filter((s) => s.action !== 'case-screenshot');
      if (raw && reproSteps.length > 0) {
        lines.push('');
        lines.push('**复现步骤**：');
        reproSteps.forEach((s, idx) => {
          const targetPart = s.target ? ` \`${s.target}\`` : '';
          const valPart = s.value ? ` = \`${s.value}\`` : '';
          const errPart = s.error ? ` → ❌ ${s.error}` : '';
          lines.push(`${idx + 1}. \`${s.action}\`${targetPart}${valPart}${errPart}`);
        });
      }

      const diagCount = (c.consoleErrors || []).length + (c.networkErrors || []).length;
      if (raw && diagCount > 0) {
        lines.push('');
        lines.push(`<details><summary>辅助诊断信息（Console 报错 ${(c.consoleErrors || []).length} 条 / 网络异常 ${(c.networkErrors || []).length} 条）</summary>`);
        lines.push('');
        if (c.consoleErrors && c.consoleErrors.length) {
          lines.push('**Console / Page Errors:**');
          for (const e of c.consoleErrors.slice(0, 15)) {
            lines.push(`- \`[${e.type}]\` ${e.text}`);
          }
          lines.push('');
        }
        if (c.networkErrors && c.networkErrors.length) {
          lines.push('**Network Errors:**');
          for (const n of c.networkErrors.slice(0, 15)) {
            lines.push(`- \`${n.status || 'ERR'}\` ${n.method || ''} ${n.url}${n.failure ? ` (${n.failure})` : ''}`);
          }
          lines.push('');
        }
        lines.push('</details>');
      }
      lines.push('');
    }

    for (const issue of issues) {
      const sev = String(issue.severity || 'medium').toUpperCase();
      lines.push(`### 🐞 [${sev}] ${issue.title}`);
      lines.push('');
      if (issue.url) lines.push(`- **页面地址**：\`${issue.url}\``);
      if (issue.description) lines.push(`- **问题描述**：${issue.description}`);
      if (issue.repro) lines.push(`- **复现步骤**：${issue.repro}`);
      if (issue.screenshot) {
        const rel = toRelLink(outDir, issue.screenshot);
        lines.push(`- **现场截图**：[\`${rel}\`](${rel})`);
        lines.push('');
        lines.push(`![${issue.title}](${rel})`);
      }
      lines.push('');
    }
  }

  if (changes.length > 0) {
    const cleanupLabels = { pending: '待清理', restored: '已恢复', retained: '保留', irreversible: '不可恢复' };
    lines.push('## 测试数据与遗留', '');
    lines.push('| 记录 ID | 用例 | 变更 | 清理状态 | 备注 |');
    lines.push('|---|---|---|---|---|');
    for (const change of changes) {
      const cells = [change.id, change.caseId, change.description, cleanupLabels[change.status], change.note];
      lines.push(`| ${cells.map((cell) => escapeCell(cell || '-')).join(' | ')} |`);
    }
    lines.push('');
  }

  if (raw) {
    lines.push('## 详细操作记录', '');
    for (const attempts of groups) {
      attempts.forEach((attempt, index) => {
        lines.push(`<a id="${attempt.anchor}"></a>`, '');
        lines.push(`### ${attempt.id} · ${attempt.title} · 第 ${index + 1} 次（${statusBadge(attempt.status)}）`, '');
        if (attempt.expected) lines.push(`- 预期结果：${attempt.expected}`);
        if (attempt.actual) lines.push(`- 实际结果：${attempt.actual}`);
        if (attempt.note) lines.push(`- 备注：${attempt.note}`);
        lines.push('');
        appendStepTable(lines, attempt.steps, outDir);
      });
    }
    if (session.orphanSteps?.length) {
      lines.push('### 通用操作轨迹（未归属具体用例）', '');
      appendStepTable(lines, session.orphanSteps.map(displayStep), outDir);
    }
  }

  lines.push('## 产物', '');
  lines.push(raw ? '- [验收报告](report.md)' : '- [详细操作记录](report.raw.md)');
  for (const source of session.sourceFiles || ['session.json']) {
    const relative = toRelLink(outDir, source);
    lines.push(`- [结构化执行记录 · ${relative}](${relative})`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeReport(outDir, session) {
  const md = renderReportMarkdown(session, outDir);
  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(path.join(outDir, 'report.raw.md'), renderReportMarkdown(session, outDir, { raw: true }), 'utf8');
  fs.writeFileSync(reportPath, md, 'utf8');
  return reportPath;
}

function readReportSource(directory) {
  const session = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'));
  const withScreenshot = (entry) => entry.screenshot
    ? { ...entry, screenshot: path.resolve(directory, entry.screenshot) }
    : entry;
  return {
    ...session,
    sourceFile: path.join(directory, 'session.json'),
    cases: (session.cases || []).map((entry) => ({
      ...entry, steps: (entry.steps || []).map(withScreenshot)
    })),
    issues: (session.issues || []).map(withScreenshot),
    orphanSteps: (session.orphanSteps || []).map(withScreenshot)
  };
}

function mergeReportSources(directories) {
  const sources = [...new Set(directories.map((directory) => path.resolve(directory)))]
    .map(readReportSource)
    .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  const merged = { ...sources[0], sourceFiles: sources.map((source) => source.sourceFile) };
  for (const field of ['cases', 'issues', 'orphanSteps']) {
    merged[field] = sources.flatMap((source) => source[field]);
  }
  merged.changes = [...new Map(sources.flatMap((source) =>
    (source.changes || []).map((change) => [change.id, change]))).values()];
  merged.endedAt = sources.every((source) => source.endedAt)
    ? sources.map((source) => source.endedAt).sort().at(-1)
    : null;
  return merged;
}

if (require.main === module) {
  try {
    const [, , outDir, ...args] = process.argv;
    if (!outDir || args.length % 2 || args.some((arg, i) => i % 2 === 0 && arg !== '--merge')) {
      throw new Error('Usage: node reporter.cjs <outDir> [--merge <anotherRunDir>]...');
    }
    const session = mergeReportSources([outDir, ...args.filter((_, i) => i % 2 !== 0)]);
    const reportPath = writeReport(outDir, session);
    console.log(JSON.stringify({ ok: true, reportPath, rawReportPath: path.join(outDir, 'report.raw.md') }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exitCode = 1;
  }
}

module.exports = {
  renderReportMarkdown,
  writeReport
};
