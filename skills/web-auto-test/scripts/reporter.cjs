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

function renderReportMarkdown(session, outDir) {
  const cases = Array.isArray(session.cases) ? session.cases : [];
  const issues = Array.isArray(session.issues) ? session.issues : [];
  const orphanSteps = Array.isArray(session.orphanSteps) ? session.orphanSteps : [];

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
  lines.push(`| 总耗时 | ${totalDuration} |`);
  lines.push(`| 用例统计 | 共 **${counts.total}** 条：✅ 通过 ${counts.pass} · ❌ 失败 ${counts.fail} · ⏸️ 阻塞 ${counts.blocked} · ⏭️ 跳过 ${counts.skipped}（通过率 ${passRate}） |`);
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
    lines.push('| 用例 ID | 用例名称 | 状态 | 耗时 | 说明 |');
    lines.push('|---|---|---|---|---|');
    for (const c of cases) {
      const note = c.actual || c.note || c.expected || '-';
      lines.push(
        `| ${escapeCell(c.id)} | ${escapeCell(c.title)} | ${statusBadge(c.status)} | ${fmtMs(c.durationMs)} | ${escapeCell(note)} |`
      );
    }
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
      const lastShot = failShots.length ? failShots[failShots.length - 1] : null;
      if (lastShot) {
        lines.push(`- **现场截图**：[\`${lastShot.rel}\`](${lastShot.rel})`);
        lines.push('');
        lines.push(`![${c.id} 现场截图](${lastShot.rel})`);
      }

      const reproSteps = (c.steps || []).filter((s) => s.action !== 'case-screenshot');
      if (reproSteps.length > 0) {
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
      if (diagCount > 0) {
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

  // 4. Full Execution Trace
  lines.push('## 4. 详细操作记录');
  lines.push('');

  if (cases.length > 0) {
    for (const c of cases) {
      lines.push(`### ${c.id}：${c.title}（${statusBadge(c.status)}）`);
      lines.push('');
      const steps = c.steps || [];
      if (steps.length === 0) {
        lines.push('_无操作步骤记录_');
        lines.push('');
        continue;
      }
      lines.push('| # | 动作 | 目标 / 参数 | 结果 | 耗时 | 截图 |');
      lines.push('|---|---|---|---|---|---|');
      steps.forEach((s, idx) => {
        const target = [s.target, s.value ? `=> ${s.value}` : ''].filter(Boolean).join(' ');
        const res = s.ok === false ? `❌ ${escapeCell(s.error || 'failed')}` : '✅';
        const shot = s.screenshot
          ? `[查看](${toRelLink(outDir, s.screenshot)})`
          : '-';
        lines.push(
          `| ${idx + 1} | \`${escapeCell(s.action)}\` | ${escapeCell(target || '-')} | ${res} | ${fmtMs(s.durationMs)} | ${shot} |`
        );
      });
      lines.push('');
    }
  }

  if (orphanSteps.length > 0) {
    lines.push('### 通用操作轨迹（未归属具体用例）');
    lines.push('');
    lines.push('| # | 动作 | 目标 / 参数 | 结果 | 耗时 | 截图 |');
    lines.push('|---|---|---|---|---|---|');
    orphanSteps.forEach((s, idx) => {
      const target = [s.target, s.value ? `=> ${s.value}` : ''].filter(Boolean).join(' ');
      const res = s.ok === false ? `❌ ${escapeCell(s.error || 'failed')}` : '✅';
      const shot = s.screenshot ? `[查看](${toRelLink(outDir, s.screenshot)})` : '-';
      lines.push(
        `| ${idx + 1} | \`${escapeCell(s.action)}\` | ${escapeCell(target || '-')} | ${res} | ${fmtMs(s.durationMs)} | ${shot} |`
      );
    });
    lines.push('');
  }

  // 5. Artifacts
  lines.push('## 5. 产物目录');
  lines.push('');
  lines.push(`- 测试报告：\`report.md\``);
  lines.push(`- 原始执行记录：\`session.json\``);
  lines.push(`- 截图目录：\`screenshots/\``);
  lines.push('');

  return lines.join('\n');
}

function writeReport(outDir, session) {
  const md = renderReportMarkdown(session, outDir);
  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(reportPath, md, 'utf8');
  return reportPath;
}

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node reporter.cjs <outDir>');
    process.exit(1);
  }
  const sessionPath = path.join(outDir, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    console.error(`session.json not found in ${outDir}`);
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const reportPath = writeReport(outDir, session);
  console.log(JSON.stringify({ ok: true, reportPath }));
}

module.exports = {
  renderReportMarkdown,
  writeReport
};
