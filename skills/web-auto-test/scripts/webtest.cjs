'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDepsDir, ensurePlaywright } = require('./ensure-deps.cjs');

const BASE_CACHE = getDepsDir();
const SESSIONS_DIR = path.join(BASE_CACHE, 'sessions');
const PROFILES_DIR = path.join(BASE_CACHE, 'profiles');

function parseCli(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] || 'help', args: positionals.slice(1), flags };
}

function sanitizeSlug(str, fallback = 'run') {
  const s = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function stateFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeSlug(sessionId, 'default')}.json`);
}

function requestDaemon(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(text) });
          } catch (_) {
            resolve({ statusCode: res.statusCode, data: { ok: false, raw: text } });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Request to web-auto-test daemon timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadRunningState(sessionId) {
  const file = stateFilePath(sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const health = await requestDaemon(state.port, 'GET', '/health');
    if (health.statusCode === 200 && health.data && health.data.ok) {
      return state;
    }
  } catch (_) {
    // stale state file
  }
  try {
    fs.unlinkSync(file);
  } catch (_) {}
  return null;
}

async function requireRunningState(sessionId) {
  const state = await loadRunningState(sessionId);
  if (!state) {
    throw new Error(
      `No active browser session "${sessionId}". Run "node webtest.cjs start" first.`
    );
  }
  return state;
}

function printOutput(data, rawText) {
  if (rawText) {
    console.log(rawText);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function printHelp() {
  console.log(`web-auto-test CLI (Playwright persistent session driver)

Usage: node webtest.cjs <command> [args] [options]

Session:
  start [--name "..."] [--mode case-driven|exploratory] [--viewport desktop|mobile|WxH]
        [--headless] [--profile default] [--cdp http://127.0.0.1:9222] [--out <dir>] [--session default]
  status [--session default]
  stop [--summary "..."] [--no-report] [--session default]

Navigation & Inspection:
  open <url> [--screenshot [name]] [--wait-until domcontentloaded|load|networkidle]
  reload [--screenshot [name]]
  back [--screenshot [name]]
  snapshot [--json] [--max-elements 120]
  screenshot [name] [--full-page]
  tabs [list|switch <index>|new [url]|close]

Interactions:
  click <@ref|selector> [--screenshot [name]] [--force]
  fill <@ref|selector> <value> [--screenshot [name]]
  type <@ref|selector> <value> [--delay 30] [--screenshot [name]]
  select <@ref|selector> <value> [--screenshot [name]]
  press <key> [--target <@ref|selector>] [--screenshot [name]]
  hover <@ref|selector> [--screenshot [name]]
  scroll [down|up|left|right] [amount] | scroll --target <@ref|selector>
  wait [--ms 1000 | --selector <sel> | --text <txt> | --url <substr>] [--timeout 15000]
  eval "<js expression>"

Assertions (exit code 2 on failure + auto failure screenshot):
  assert text "<expected>" [--timeout 5000]
  assert not-text "<forbidden>"
  assert url "<substring>" [--timeout 5000]
  assert title "<substring>"
  assert visible <@ref|selector> [--timeout 5000]
  assert hidden <@ref|selector> [--timeout 5000]
  assert value <@ref|selector> "<expected>" [--timeout 5000]

Recording & Reporting:
  case-start --id <TC-01> --title "<name>" [--expected "<expected>"]
  case-end --status <pass|fail|blocked|skipped> [--actual "..."] [--note "..."] [--screenshot]
  issue --title "<bug>" [--severity high|medium|low] [--description "..."] [--repro "..."]
  report [--summary "..."]
`);
}

async function cmdStart(flags) {
  const sessionId = flags.session || 'default';
  const existing = await loadRunningState(sessionId);
  if (existing) {
    printOutput({
      ok: true,
      reused: true,
      session: sessionId,
      pid: existing.pid,
      port: existing.port,
      outDir: existing.outDir,
      profileDir: existing.profileDir
    });
    return;
  }

  // Bootstrap playwright-core before spawning detached daemon
  ensurePlaywright({ silent: false });

  const name = flags.name || 'Web Test Run';
  const mode = flags.mode || 'case-driven';
  const profileName = sanitizeSlug(flags.profile || 'default', 'default');
  const profileDir = path.join(PROFILES_DIR, profileName);
  const outDir = flags.out
    ? path.resolve(process.cwd(), flags.out)
    : path.join(process.cwd(), 'tmp', 'web-test-reports', `${timestampSlug()}-${sanitizeSlug(name, 'run')}`);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const stateFile = stateFilePath(sessionId);
  const logFile = path.join(outDir, 'daemon.log');
  const logFd = fs.openSync(logFile, 'a');

  const daemonArgs = [
    path.join(__dirname, 'daemon.cjs'),
    '--state-file',
    stateFile,
    '--out-dir',
    outDir,
    '--profile-dir',
    profileDir,
    '--name',
    name,
    '--mode',
    mode,
    '--viewport',
    String(flags.viewport || 'desktop')
  ];
  if (flags.headless) daemonArgs.push('--headless', 'true');
  if (flags.cdp) daemonArgs.push('--cdp', String(flags.cdp));
  if (flags.channel) daemonArgs.push('--channel', String(flags.channel));
  if (flags['executable-path']) daemonArgs.push('--executable-path', String(flags['executable-path']));

  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env
  });
  child.unref();
  fs.closeSync(logFd);

  // Wait up to 25s for daemon readiness
  const deadline = Date.now() + 25000;
  let state = null;
  while (Date.now() < deadline) {
    state = await loadRunningState(sessionId);
    if (state) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!state) {
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-1000) : '';
    throw new Error(`Daemon failed to start within 25s.\nLog (${logFile}):\n${tail}`);
  }

  printOutput({
    ok: true,
    reused: false,
    session: sessionId,
    pid: state.pid,
    port: state.port,
    outDir: state.outDir,
    profileDir: state.profileDir
  });
}

async function main() {
  const { command, args, flags } = parseCli(process.argv.slice(2));
  const sessionId = flags.session || 'default';

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'ensure-deps') {
    ensurePlaywright({ silent: false });
    printOutput({ ok: true, depsDir: BASE_CACHE });
    return;
  }

  if (command === 'start') {
    await cmdStart(flags);
    return;
  }

  const state = await requireRunningState(sessionId);

  if (command === 'status') {
    const res = await requestDaemon(state.port, 'GET', '/status');
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'open') {
    const url = args[0] || flags.url;
    if (!url) throw new Error('Usage: open <url>');
    const res = await requestDaemon(state.port, 'POST', '/open', {
      url,
      waitUntil: flags['wait-until'],
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'reload') {
    const res = await requestDaemon(state.port, 'POST', '/reload', {
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'back') {
    const res = await requestDaemon(state.port, 'POST', '/back', {
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'snapshot') {
    const res = await requestDaemon(state.port, 'POST', '/snapshot', {
      maxElements: flags['max-elements'],
      maxTextChars: flags['max-text-chars']
    });
    if (!res.data.ok) {
      printOutput(res.data);
      process.exit(1);
    }
    if (flags.json) {
      printOutput(res.data);
    } else {
      let out = res.data.formatted;
      const cErr = (res.data.recentErrors && res.data.recentErrors.console) || [];
      const nErr = (res.data.recentErrors && res.data.recentErrors.network) || [];
      if (cErr.length || nErr.length) {
        out += `\n\n[Diagnostic Hint] Recent errors: console=${cErr.length}, network=${nErr.length}`;
      }
      printOutput(null, out);
    }
    return;
  }

  if (command === 'click') {
    const target = args[0] || flags.target;
    if (!target) throw new Error('Usage: click <@ref|selector>');
    const res = await requestDaemon(state.port, 'POST', '/click', {
      target,
      force: Boolean(flags.force),
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'fill') {
    const target = args[0] || flags.target;
    const value = args[1] !== undefined ? args[1] : flags.value;
    if (!target || value === undefined) throw new Error('Usage: fill <@ref|selector> <value>');
    const res = await requestDaemon(state.port, 'POST', '/fill', {
      target,
      value,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'type') {
    const target = args[0] || flags.target;
    const value = args[1] !== undefined ? args[1] : flags.value;
    if (!target || value === undefined) throw new Error('Usage: type <@ref|selector> <value>');
    const res = await requestDaemon(state.port, 'POST', '/type', {
      target,
      value,
      delay: flags.delay,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'select') {
    const target = args[0] || flags.target;
    const value = args[1] !== undefined ? args[1] : flags.value;
    if (!target || value === undefined) throw new Error('Usage: select <@ref|selector> <value>');
    const res = await requestDaemon(state.port, 'POST', '/select', {
      target,
      value,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'press') {
    const key = args[0] || flags.key;
    if (!key) throw new Error('Usage: press <key> [--target <@ref|selector>]');
    const res = await requestDaemon(state.port, 'POST', '/press', {
      key,
      target: flags.target,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'hover') {
    const target = args[0] || flags.target;
    if (!target) throw new Error('Usage: hover <@ref|selector>');
    const res = await requestDaemon(state.port, 'POST', '/hover', {
      target,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'scroll') {
    const res = await requestDaemon(state.port, 'POST', '/scroll', {
      direction: args[0] || flags.direction || 'down',
      amount: args[1] || flags.amount || 600,
      target: flags.target,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'wait') {
    const res = await requestDaemon(state.port, 'POST', '/wait', {
      ms: flags.ms || (args[0] && /^\d+$/.test(args[0]) ? Number(args[0]) : undefined),
      selector: flags.selector,
      text: flags.text,
      url: flags.url,
      state: flags.state,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'assert') {
    const kind = args[0];
    if (!kind) throw new Error('Usage: assert <text|not-text|url|title|visible|hidden|value> ...');
    let target = '';
    let expected = '';
    if (kind === 'visible' || kind === 'hidden') {
      target = args[1] || flags.target || '';
    } else if (kind === 'value') {
      target = args[1] || flags.target || '';
      expected = args[2] !== undefined ? args[2] : flags.expected || '';
    } else {
      expected = args[1] !== undefined ? args[1] : flags.expected || '';
    }
    const res = await requestDaemon(state.port, 'POST', '/assert', {
      kind,
      target,
      expected,
      timeout: flags.timeout,
      screenshot: flags.screenshot
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 2);
  }

  if (command === 'screenshot') {
    const name = args[0] || flags.name || 'capture';
    const res = await requestDaemon(state.port, 'POST', '/screenshot', {
      name,
      fullPage: Boolean(flags['full-page'])
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'eval') {
    const script = args[0] || flags.script;
    if (!script) throw new Error('Usage: eval "<js>"');
    const res = await requestDaemon(state.port, 'POST', '/eval', { script });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'tabs') {
    const action = args[0] || 'list';
    const res = await requestDaemon(state.port, 'POST', '/tabs', {
      action,
      index: action === 'switch' ? args[1] : undefined,
      url: action === 'new' ? args[1] : undefined
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'case-start') {
    const res = await requestDaemon(state.port, 'POST', '/case/start', {
      id: flags.id || args[0],
      title: flags.title || args[1],
      expected: flags.expected
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'case-end') {
    const res = await requestDaemon(state.port, 'POST', '/case/end', {
      status: flags.status || args[0] || 'pass',
      actual: flags.actual,
      note: flags.note,
      screenshot: Boolean(flags.screenshot)
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'issue') {
    const res = await requestDaemon(state.port, 'POST', '/issue', {
      title: flags.title || args[0],
      severity: flags.severity || 'medium',
      description: flags.description,
      repro: flags.repro,
      screenshot: flags['no-screenshot'] ? false : true
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'report') {
    const res = await requestDaemon(state.port, 'POST', '/report', {
      summary: flags.summary
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  if (command === 'stop') {
    const res = await requestDaemon(state.port, 'POST', '/stop', {
      summary: flags.summary,
      report: flags['no-report'] ? false : true
    });
    printOutput(res.data);
    process.exit(res.data.ok ? 0 : 1);
  }

  throw new Error(`Unknown command "${command}". Run "node webtest.cjs help" for usage.`);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
  process.exit(1);
});
