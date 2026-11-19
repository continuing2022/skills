'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { writeReport } = require('../scripts/reporter.cjs');

const scripts = path.join(__dirname, '..', 'scripts');
const cli = path.join(scripts, 'webtest.cjs');

function temporaryDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtest-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 35_000 });
}

function expectExit(result, status = 0) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return JSON.parse(result.stdout || result.stderr);
}

const runData = {
  name: 'Synthetic report', startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T00:05:00Z'
};

test('unreachable live session retains its index', (t) => {
  const dir = temporaryDir(t);
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions);
  const state = path.join(sessions, 'default.json');
  fs.writeFileSync(state, JSON.stringify({ pid: process.pid, port: 1, outDir: dir }));

  const result = expectExit(run({ ...process.env, WEBTEST_DEPS_DIR: dir }, 'status'), 1);
  assert.equal(fs.existsSync(state), true);
  assert.equal(result.code, 'SESSION_UNREACHABLE');
  const forget = expectExit(run({ ...process.env, WEBTEST_DEPS_DIR: dir }, 'forget'), 1);
  assert.equal(forget.code, 'SESSION_PROCESS_PRESENT');
  assert.equal(fs.existsSync(state), true);
});

test('offline report masks historical input and retains final outcomes and attempts', (t) => {
  const dir = temporaryDir(t);
  const input = { action: 'fill', target: '#example', value: 'synthetic-private-input' };
  writeReport(dir, {
    ...runData,
    cases: [
      { id: 'TC-01', title: 'Search', status: 'fail', steps: [input] },
      { id: 'TC-01', title: 'Search', status: 'pass', steps: [] },
      { id: 'TC-02', title: 'Export', status: 'skipped', steps: [] }
    ],
    changes: [{ id: 'fixture', description: 'Created a test fixture', status: 'pending' }]
  });
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /共 \*\*2\*\* 条.*通过 1.*失败 0.*跳过 1/);
  const raw = fs.readFileSync(path.join(dir, 'report.raw.md'), 'utf8');
  assert.match(report, /report\.raw\.md#case-1-attempt-2/);
  assert.match(raw, /id="case-1-attempt-1"/);
  assert.match(raw, /id="case-1-attempt-2"/);
  assert.match(report, /Created a test fixture/);
  assert.doesNotMatch(report + raw, /synthetic-private-input/);
});

test('offline merge keeps links to evidence in the originating directories', (t) => {
  const dir = temporaryDir(t);
  const other = path.join(dir, 'part2');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    ...runData, cases: [{ id: 'TC-01', title: 'Search', status: 'fail', steps: [] }]
  }));
  fs.writeFileSync(path.join(other, 'session.json'), JSON.stringify({
    ...runData, startedAt: '2026-01-01T00:06:00Z', endedAt: '2026-01-01T00:07:00Z',
    cases: [{ id: 'TC-01', title: 'Search', status: 'pass',
      steps: [{ action: 'screenshot', screenshot: 'screenshots/rerun.png', ok: true }] }]
  }));
  expectExit(spawnSync(process.execPath, [path.join(scripts, 'reporter.cjs'), dir, '--merge', other], { encoding: 'utf8' }));
  const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  const raw = fs.readFileSync(path.join(dir, 'report.raw.md'), 'utf8');
  assert.match(report, /共 \*\*1\*\* 条.*通过 1.*失败 0/);
  assert.match(raw, /\]\(part2\/screenshots\/rerun\.png\)/);
});

test('browser CLI preserves evidence and refuses implicit passes', {
  skip: process.env.WEBTEST_BROWSER_TEST !== '1'
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtest-browser-'));
  const cache = path.join(dir, 'cache');
  const out = path.join(dir, 'report');
  const executable = process.env.WEBTEST_BROWSER_EXECUTABLE;
  const env = { ...process.env, WEBTEST_DEPS_DIR: cache };
  const call = (args, status) => expectExit(run(env, ...args), status);
  const data = () => JSON.parse(fs.readFileSync(path.join(out, 'session.json'), 'utf8'));

  t.after(() => {
    run(env, 'stop', '--no-report');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  call(['start', '--headless', '--out', out, ...(executable ? ['--executable-path', executable] : [])]);
  const page = 'data:text/html,' + encodeURIComponent(
    '<h1>Search</h1><input id="password" type="password"><input id="query">'
  );
  call(['open', page]);
  call(['case-start', '--id', 'TC-01']);
  call(['fill', '#password', 'synthetic-password-value', '--record-value']);
  call(['type', '#query', 'synthetic-private-value', '--delay', '0']);
  call(['assert', 'value', '#query', 'synthetic-private-value']);
  const snapshot = call(['snapshot', '--json']);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-(password|private)-value/);
  assert.doesNotMatch(JSON.stringify(data()), /synthetic-(password|private)-value/);
  call(['fill', '#query', 'public-search-term', '--record-value']);
  assert.match(JSON.stringify(data()), /public-search-term/);

  call(['case-start', '--id', 'TC-02'], 1);
  assert.equal(data().cases[0].status, 'running');
  const missed = call(['assert', 'text', 'No match', '--timeout', '10', '--label', 'Result loaded'], 2);
  assert.equal(fs.existsSync(missed.screenshot), true);
  call(['case-end'], 1);
  call(['case-end', '--status', 'pass'], 1);
  call(['case-end', '--status', 'fail', '--actual', 'Result failed']);

  call(['case-start', '--id', 'TC-01']);
  call(['assert', 'text', 'Search', '--label', 'Page title']);
  call(['check', '--label', 'Inventory refresh', '--status', 'blocked', '--actual', 'No test data']);
  call(['case-end', '--status', 'pass'], 1);
  call(['case-end', '--status', 'blocked']);
  call(['change', '--id', 'fixture', '--description', 'Changed test record']);
  call(['change', '--id', 'fixture', '--status', 'restored']);
  assert.equal(data().changes[0].status, 'restored');

  call(['case-start', '--id', 'TC-02']);
  call(['report']);
  assert.equal(data().endedAt, null);
  call(['stop']);
  assert.equal(data().cases.at(-1).status, 'blocked');
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /共 \*\*2\*\* 条.*阻塞 2/);
});
