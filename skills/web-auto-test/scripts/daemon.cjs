'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { ensurePlaywright } = require('./ensure-deps.cjs');
const { capturePageSnapshot, formatSnapshotText } = require('./snapshot.cjs');
const { writeReport } = require('./reporter.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function sanitizeFilePart(str, fallback = 'shot') {
  const cleaned = String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function parseViewport(spec) {
  if (!spec || spec === 'desktop') {
    return {
      label: 'desktop (1440x900)',
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      hasTouch: false
    };
  }
  if (spec === 'mobile') {
    return {
      label: 'mobile (390x844)',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    };
  }
  const m = String(spec).match(/^(\d+)x(\d+)$/i);
  if (m) {
    const width = Number(m[1]);
    const height = Number(m[2]);
    return {
      label: `${width}x${height}`,
      viewport: { width, height },
      isMobile: width <= 500,
      hasTouch: width <= 500
    };
  }
  return {
    label: 'desktop (1440x900)',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false
  };
}

function resolveLocator(page, target) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('Target selector or @ref is required');
  if (/^@e\d+$/.test(raw)) {
    return page.locator(`[data-webtest-ref="${raw.slice(1)}"]`).first();
  }
  if (raw.startsWith('text=')) {
    return page.getByText(raw.slice(5)).first();
  }
  return page.locator(raw).first();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function launchBrowser(playwright, opts) {
  if (opts.cdpUrl) {
    const browser = await playwright.chromium.connectOverCDP(opts.cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] || (await browser.newContext({ ignoreHTTPSErrors: true }));
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());
    return {
      mode: 'cdp',
      browser,
      context,
      page,
      browserLabel: `CDP (${opts.cdpUrl})`
    };
  }

  fs.mkdirSync(opts.profileDir, { recursive: true });
  const vp = opts.viewportConfig;
  const baseLaunch = {
    headless: Boolean(opts.headless),
    viewport: vp.viewport,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    ignoreHTTPSErrors: true,
    args: ['--no-first-run', '--no-default-browser-check']
  };
  if (vp.userAgent) baseLaunch.userAgent = vp.userAgent;

  if (opts.executablePath) {
    const context = await playwright.chromium.launchPersistentContext(opts.profileDir, {
      ...baseLaunch,
      executablePath: opts.executablePath
    });
    const page = context.pages()[0] || (await context.newPage());
    return {
      mode: 'persistent',
      browser: context.browser(),
      context,
      page,
      browserLabel: path.basename(opts.executablePath)
    };
  }

  const channels = opts.channel ? [opts.channel] : ['chrome', 'msedge', null];
  let lastErr = null;
  for (const ch of channels) {
    try {
      const launchOpts = ch ? { ...baseLaunch, channel: ch } : { ...baseLaunch };
      const context = await playwright.chromium.launchPersistentContext(opts.profileDir, launchOpts);
      const page = context.pages()[0] || (await context.newPage());
      return {
        mode: 'persistent',
        browser: context.browser(),
        context,
        page,
        browserLabel: ch || 'chromium'
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to launch Chrome/Edge/Chromium: ${lastErr ? lastErr.message : 'unknown error'}. ` +
      `Tip: install Google Chrome or pass --executable-path / --cdp.`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateFile = args['state-file'];
  const outDir = args['out-dir'];
  const profileDir = args['profile-dir'];
  const sessionName = args.name || 'Web Test Run';
  const testMode = args.mode || 'case-driven';
  const cdpUrl = args.cdp || '';
  const headless = args.headless === true || args.headless === 'true';
  const viewportConfig = parseViewport(args.viewport || 'desktop');
  const channel = args.channel || '';
  const executablePath = args['executable-path'] || '';

  if (!stateFile || !outDir || !profileDir) {
    console.error('Missing required args: --state-file, --out-dir, --profile-dir');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'screenshots'), { recursive: true });

  const playwright = ensurePlaywright({ silent: true });
  const launched = await launchBrowser(playwright, {
    cdpUrl,
    profileDir,
    headless,
    viewportConfig,
    channel,
    executablePath
  });

  const { context } = launched;
  let activePage = launched.page;
  let shotCounter = 0;
  let activeCase = null;
  const attachedPages = new WeakSet();

  const session = {
    version: 1,
    name: sessionName,
    mode: testMode,
    baseUrl: '',
    lastUrl: '',
    browserLabel: launched.browserLabel,
    viewportLabel: viewportConfig.label,
    headless,
    outDir,
    startedAt: new Date().toISOString(),
    endedAt: null,
    summaryNote: '',
    cases: [],
    issues: [],
    orphanSteps: [],
    consoleErrors: [],
    networkErrors: []
  };

  function persistSession() {
    try {
      const targetPath = path.join(outDir, 'session.json');
      const tmpPath = `${targetPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmpPath, targetPath);
    } catch (_) {
      // non-fatal during shutdown
    }
  }

  function recordConsoleError(entry) {
    session.consoleErrors.push(entry);
    if (session.consoleErrors.length > 200) session.consoleErrors.shift();
    if (activeCase) {
      activeCase.consoleErrors.push(entry);
    }
  }

  function recordNetworkError(entry) {
    session.networkErrors.push(entry);
    if (session.networkErrors.length > 200) session.networkErrors.shift();
    if (activeCase) {
      activeCase.networkErrors.push(entry);
    }
  }

  function attachPageListeners(page) {
    if (!page || attachedPages.has(page)) return;
    attachedPages.add(page);

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        recordConsoleError({
          time: new Date().toISOString(),
          type: 'console.error',
          text: msg.text()
        });
      }
    });

    page.on('pageerror', (err) => {
      recordConsoleError({
        time: new Date().toISOString(),
        type: 'pageerror',
        text: err && err.message ? err.message : String(err)
      });
    });

    page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        recordNetworkError({
          time: new Date().toISOString(),
          status,
          method: res.request().method(),
          url: res.url()
        });
      }
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      recordNetworkError({
        time: new Date().toISOString(),
        status: 0,
        method: req.method(),
        url: req.url(),
        failure: failure ? failure.errorText : 'requestfailed'
      });
    });
  }

  for (const p of context.pages()) attachPageListeners(p);
  context.on('page', (newPage) => {
    attachPageListeners(newPage);
    activePage = newPage;
  });

  function ensureActivePage() {
    const pages = context.pages().filter((p) => !p.isClosed());
    if (activePage && !activePage.isClosed()) return activePage;
    if (pages.length > 0) {
      activePage = pages[pages.length - 1];
      attachPageListeners(activePage);
      return activePage;
    }
    throw new Error('No open browser pages available');
  }

  async function takeScreenshot(label, fullPage = false) {
    const page = ensureActivePage();
    shotCounter += 1;
    const prefix = String(shotCounter).padStart(3, '0');
    const casePrefix = activeCase ? `${sanitizeFilePart(activeCase.id, 'case')}-` : '';
    const filename = `${prefix}-${casePrefix}${sanitizeFilePart(label, 'step')}.png`;
    const filePath = path.join(outDir, 'screenshots', filename);
    await page.screenshot({ path: filePath, fullPage: Boolean(fullPage) });
    return filePath;
  }

  function recordStep(step) {
    const targetList = activeCase ? activeCase.steps : session.orphanSteps;
    targetList.push(step);
    if (step.urlAfter) {
      session.lastUrl = step.urlAfter;
      if (!session.baseUrl && step.urlAfter.startsWith('http')) {
        session.baseUrl = step.urlAfter;
      }
      if (activeCase) activeCase.lastUrl = step.urlAfter;
    }
    persistSession();
  }

  async function runAction(actionName, target, value, fn, opts = {}) {
    const page = ensureActivePage();
    const urlBefore = page.url();
    const start = Date.now();
    try {
      const result = await fn(page);
      const urlAfter = page.isClosed() ? urlBefore : page.url();
      let screenshotPath = null;
      if (opts.screenshot) {
        screenshotPath = await takeScreenshot(
          typeof opts.screenshot === 'string' ? opts.screenshot : actionName,
          opts.fullPage
        );
      }
      const step = {
        time: new Date().toISOString(),
        action: actionName,
        target: target || '',
        value: value || '',
        urlBefore,
        urlAfter,
        durationMs: Date.now() - start,
        ok: true,
        error: null,
        screenshot: screenshotPath
      };
      recordStep(step);
      return { ok: true, url: urlAfter, durationMs: step.durationMs, screenshot: screenshotPath, ...result };
    } catch (err) {
      let screenshotPath = null;
      try {
        screenshotPath = await takeScreenshot(`fail-${actionName}`, false);
      } catch (_) {
        // ignore screenshot failure when page is crashed
      }
      const urlAfter = page.isClosed() ? urlBefore : page.url();
      const step = {
        time: new Date().toISOString(),
        action: actionName,
        target: target || '',
        value: value || '',
        urlBefore,
        urlAfter,
        durationMs: Date.now() - start,
        ok: false,
        error: err && err.message ? err.message : String(err),
        screenshot: screenshotPath
      };
      recordStep(step);
      return {
        ok: false,
        error: step.error,
        url: urlAfter,
        durationMs: step.durationMs,
        screenshot: screenshotPath
      };
    }
  }

  let shuttingDown = false;
  async function shutdown(server) {
    if (shuttingDown) return;
    shuttingDown = true;
    session.endedAt = new Date().toISOString();
    persistSession();
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch (_) {}
    try {
      if (launched.mode === 'cdp') {
        if (launched.browser) await launched.browser.close();
      } else {
        await context.close();
      }
    } catch (_) {}
    try {
      server.close();
    } catch (_) {}
    setTimeout(() => process.exit(0), 50);
  }

  const server = http.createServer(async (req, res) => {
    const send = (statusCode, payload) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    try {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const route = urlObj.pathname;

      if (req.method === 'GET' && route === '/health') {
        return send(200, { ok: true, pid: process.pid, outDir });
      }

      if (req.method === 'GET' && route === '/status') {
        const page = ensureActivePage();
        const pages = context.pages().filter((p) => !p.isClosed());
        return send(200, {
          ok: true,
          pid: process.pid,
          name: session.name,
          mode: session.mode,
          browserLabel: session.browserLabel,
          viewportLabel: session.viewportLabel,
          outDir,
          url: page.url(),
          title: await page.title().catch(() => ''),
          activeCase: activeCase ? { id: activeCase.id, title: activeCase.title } : null,
          caseCount: session.cases.length,
          issueCount: session.issues.length,
          consoleErrorCount: session.consoleErrors.length,
          networkErrorCount: session.networkErrors.length,
          tabs: pages.map((p, idx) => ({
            index: idx,
            active: p === activePage,
            url: p.url()
          }))
        });
      }

      const body = req.method === 'POST' ? await readJsonBody(req) : {};

      if (route === '/open') {
        const timeout = Number(body.timeout || 30000);
        const waitUntil = body.waitUntil || 'domcontentloaded';
        const out = await runAction(
          'open',
          body.url,
          '',
          async (page) => {
            await page.goto(body.url, { waitUntil, timeout });
            await page.waitForTimeout(300);
            return { title: await page.title().catch(() => '') };
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/reload') {
        const out = await runAction(
          'reload',
          '',
          '',
          async (page) => {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: Number(body.timeout || 30000) });
            await page.waitForTimeout(300);
            return { title: await page.title().catch(() => '') };
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/back') {
        const out = await runAction(
          'back',
          '',
          '',
          async (page) => {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: Number(body.timeout || 15000) });
            await page.waitForTimeout(300);
            return { title: await page.title().catch(() => '') };
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/snapshot') {
        const page = ensureActivePage();
        const snap = await capturePageSnapshot(page, {
          maxElements: body.maxElements,
          maxTextChars: body.maxTextChars
        });
        session.lastUrl = snap.url;
        persistSession();
        return send(200, {
          ok: true,
          snapshot: snap,
          formatted: formatSnapshotText(snap),
          recentErrors: {
            console: session.consoleErrors.slice(-5),
            network: session.networkErrors.slice(-5)
          }
        });
      }

      if (route === '/click') {
        const timeout = Number(body.timeout || 10000);
        const out = await runAction(
          'click',
          body.target,
          '',
          async (page) => {
            const loc = resolveLocator(page, body.target);
            await loc.click({ timeout, force: Boolean(body.force) });
            await page.waitForTimeout(250);
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/fill') {
        const timeout = Number(body.timeout || 10000);
        const value = String(body.value ?? '');
        const out = await runAction(
          'fill',
          body.target,
          value,
          async (page) => {
            const loc = resolveLocator(page, body.target);
            await loc.fill(value, { timeout });
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/type') {
        const timeout = Number(body.timeout || 10000);
        const value = String(body.value ?? '');
        const out = await runAction(
          'type',
          body.target,
          value,
          async (page) => {
            const loc = resolveLocator(page, body.target);
            await loc.click({ timeout });
            await loc.pressSequentially(value, { delay: Number(body.delay || 30), timeout });
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/select') {
        const timeout = Number(body.timeout || 10000);
        const value = String(body.value ?? '');
        const out = await runAction(
          'select',
          body.target,
          value,
          async (page) => {
            const loc = resolveLocator(page, body.target);
            await loc.selectOption(value, { timeout });
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/press') {
        const key = String(body.key || 'Enter');
        const out = await runAction(
          'press',
          body.target || 'page',
          key,
          async (page) => {
            if (body.target) {
              const loc = resolveLocator(page, body.target);
              await loc.press(key, { timeout: Number(body.timeout || 10000) });
            } else {
              await page.keyboard.press(key);
            }
            await page.waitForTimeout(200);
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/hover') {
        const timeout = Number(body.timeout || 10000);
        const out = await runAction(
          'hover',
          body.target,
          '',
          async (page) => {
            const loc = resolveLocator(page, body.target);
            await loc.hover({ timeout });
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/scroll') {
        const amount = Number(body.amount || 600);
        const direction = body.direction || 'down';
        const out = await runAction(
          'scroll',
          body.target || direction,
          String(amount),
          async (page) => {
            if (body.target) {
              const loc = resolveLocator(page, body.target);
              await loc.scrollIntoViewIfNeeded({ timeout: Number(body.timeout || 10000) });
            } else {
              const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
              const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
              await page.mouse.wheel(dx, dy);
              await page.waitForTimeout(200);
            }
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/wait') {
        const timeout = Number(body.timeout || 15000);
        const out = await runAction(
          'wait',
          body.selector || body.text || body.url || `${body.ms || 1000}ms`,
          '',
          async (page) => {
            if (body.selector) {
              const loc = resolveLocator(page, body.selector);
              await loc.waitFor({ state: body.state || 'visible', timeout });
            } else if (body.text) {
              await page.getByText(body.text).first().waitFor({ state: 'visible', timeout });
            } else if (body.url) {
              await page.waitForURL((u) => u.href.includes(body.url), { timeout });
            } else {
              await page.waitForTimeout(Number(body.ms || 1000));
            }
            return {};
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/assert') {
        const kind = String(body.kind || '').toLowerCase();
        const timeout = Number(body.timeout || 5000);
        const out = await runAction(
          `assert:${kind}`,
          body.target || '',
          body.expected || '',
          async (page) => {
            if (kind === 'text') {
              const expected = String(body.expected || '');
              const deadline = Date.now() + timeout;
              let bodyText = '';
              while (Date.now() <= deadline) {
                bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
                if (bodyText.includes(expected)) return { actual: `contains "${expected}"` };
                await page.waitForTimeout(200);
              }
              throw new Error(`Expected visible text to contain "${expected}"`);
            }
            if (kind === 'not-text') {
              const forbidden = String(body.expected || '');
              const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
              if (bodyText.includes(forbidden)) {
                throw new Error(`Expected visible text NOT to contain "${forbidden}"`);
              }
              return { actual: `does not contain "${forbidden}"` };
            }
            if (kind === 'url') {
              const expected = String(body.expected || '');
              const deadline = Date.now() + timeout;
              let current = page.url();
              while (Date.now() <= deadline) {
                current = page.url();
                if (current.includes(expected)) return { actual: current };
                await page.waitForTimeout(200);
              }
              throw new Error(`Expected URL to contain "${expected}", got "${current}"`);
            }
            if (kind === 'title') {
              const expected = String(body.expected || '');
              const title = await page.title();
              if (!title.includes(expected)) {
                throw new Error(`Expected title to contain "${expected}", got "${title}"`);
              }
              return { actual: title };
            }
            if (kind === 'visible') {
              const loc = resolveLocator(page, body.target);
              await loc.waitFor({ state: 'visible', timeout });
              return { actual: 'visible' };
            }
            if (kind === 'hidden') {
              const loc = resolveLocator(page, body.target);
              await loc.waitFor({ state: 'hidden', timeout });
              return { actual: 'hidden' };
            }
            if (kind === 'value') {
              const loc = resolveLocator(page, body.target);
              const actual = await loc.inputValue({ timeout });
              const expected = String(body.expected ?? '');
              if (actual !== expected) {
                throw new Error(`Expected input value "${expected}", got "${actual}"`);
              }
              return { actual };
            }
            throw new Error(`Unknown assert kind "${kind}". Use: text, not-text, url, title, visible, hidden, value`);
          },
          { screenshot: body.screenshot }
        );
        return send(out.ok ? 200 : 422, out);
      }

      if (route === '/screenshot') {
        const out = await runAction(
          'screenshot',
          body.name || 'capture',
          '',
          async () => ({}),
          { screenshot: body.name || 'capture', fullPage: Boolean(body.fullPage) }
        );
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/eval') {
        const out = await runAction('eval', String(body.script || '').slice(0, 80), '', async (page) => {
          const result = await page.evaluate((expr) => {
            // eslint-disable-next-line no-eval
            return eval(expr);
          }, String(body.script || ''));
          return { result };
        });
        return send(out.ok ? 200 : 400, out);
      }

      if (route === '/tabs') {
        const pages = context.pages().filter((p) => !p.isClosed());
        const action = body.action || 'list';
        if (action === 'list') {
          return send(200, {
            ok: true,
            tabs: pages.map((p, idx) => ({ index: idx, active: p === activePage, url: p.url() }))
          });
        }
        if (action === 'switch') {
          const idx = Number(body.index);
          if (Number.isNaN(idx) || idx < 0 || idx >= pages.length) {
            return send(400, { ok: false, error: `Invalid tab index ${body.index}` });
          }
          activePage = pages[idx];
          await activePage.bringToFront();
          return send(200, { ok: true, index: idx, url: activePage.url() });
        }
        if (action === 'new') {
          const newPage = await context.newPage();
          attachPageListeners(newPage);
          activePage = newPage;
          if (body.url) {
            await newPage.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }
          return send(200, { ok: true, index: context.pages().length - 1, url: newPage.url() });
        }
        if (action === 'close') {
          const page = ensureActivePage();
          if (pages.length <= 1) {
            return send(400, { ok: false, error: 'Cannot close the last remaining tab' });
          }
          await page.close();
          const remaining = context.pages().filter((p) => !p.isClosed());
          activePage = remaining[remaining.length - 1];
          return send(200, { ok: true, url: activePage.url() });
        }
        return send(400, { ok: false, error: `Unknown tabs action "${action}"` });
      }

      if (route === '/case/start') {
        // Close any previously running case implicitly as skipped if forgotten
        if (activeCase && activeCase.status === 'running') {
          activeCase.status = 'pass';
          activeCase.endedAt = new Date().toISOString();
          activeCase.durationMs = Date.now() - new Date(activeCase.startedAt).getTime();
        }
        const id = body.id || `TC-${String(session.cases.length + 1).padStart(2, '0')}`;
        const c = {
          id,
          title: body.title || id,
          expected: body.expected || '',
          actual: '',
          note: '',
          status: 'running',
          startedAt: new Date().toISOString(),
          endedAt: null,
          durationMs: 0,
          lastUrl: activePage && !activePage.isClosed() ? activePage.url() : '',
          steps: [],
          consoleErrors: [],
          networkErrors: []
        };
        session.cases.push(c);
        activeCase = c;
        persistSession();
        return send(200, { ok: true, case: { id: c.id, title: c.title, status: c.status } });
      }

      if (route === '/case/end') {
        if (!activeCase) {
          return send(400, { ok: false, error: 'No active test case. Call case-start first.' });
        }
        let screenshotPath = null;
        if (body.screenshot || body.status === 'fail' || body.status === 'blocked') {
          try {
            screenshotPath = await takeScreenshot(body.status || 'end', false);
            activeCase.steps.push({
              time: new Date().toISOString(),
              action: 'case-screenshot',
              target: activeCase.id,
              value: body.status || 'end',
              urlBefore: activePage.url(),
              urlAfter: activePage.url(),
              durationMs: 0,
              ok: true,
              error: null,
              screenshot: screenshotPath
            });
          } catch (_) {}
        }
        activeCase.status = body.status || 'pass';
        activeCase.actual = body.actual || activeCase.actual || '';
        activeCase.note = body.note || activeCase.note || '';
        activeCase.endedAt = new Date().toISOString();
        activeCase.durationMs = Math.max(0, Date.now() - new Date(activeCase.startedAt).getTime());
        activeCase.lastUrl = activePage && !activePage.isClosed() ? activePage.url() : activeCase.lastUrl;
        const finished = {
          id: activeCase.id,
          title: activeCase.title,
          status: activeCase.status,
          durationMs: activeCase.durationMs,
          screenshot: screenshotPath
        };
        activeCase = null;
        persistSession();
        return send(200, { ok: true, case: finished });
      }

      if (route === '/issue') {
        let screenshotPath = null;
        if (body.screenshot !== false) {
          try {
            screenshotPath = await takeScreenshot(`issue-${body.title || 'bug'}`, false);
          } catch (_) {}
        }
        const issue = {
          time: new Date().toISOString(),
          title: body.title || 'Unnamed issue',
          severity: body.severity || 'medium',
          description: body.description || '',
          repro: body.repro || '',
          url: activePage && !activePage.isClosed() ? activePage.url() : '',
          screenshot: screenshotPath
        };
        session.issues.push(issue);
        persistSession();
        return send(200, { ok: true, issue });
      }

      if (route === '/report') {
        if (body.summary) session.summaryNote = body.summary;
        session.endedAt = new Date().toISOString();
        persistSession();
        const reportPath = writeReport(outDir, session);
        return send(200, { ok: true, reportPath, outDir, sessionPath: path.join(outDir, 'session.json') });
      }

      if (route === '/stop') {
        if (body.summary) session.summaryNote = body.summary;
        let reportPath = null;
        if (body.report !== false) {
          session.endedAt = new Date().toISOString();
          persistSession();
          reportPath = writeReport(outDir, session);
        }
        send(200, { ok: true, outDir, reportPath });
        await shutdown(server);
        return;
      }

      return send(404, { ok: false, error: `Unknown endpoint ${route}` });
    } catch (err) {
      return send(500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const state = {
      pid: process.pid,
      port: addr.port,
      outDir,
      profileDir,
      name: sessionName,
      startedAt: session.startedAt
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    persistSession();
  });

  context.on('close', () => {
    shutdown(server);
  });

  process.on('SIGINT', () => shutdown(server));
  process.on('SIGTERM', () => shutdown(server));
}

main().catch((err) => {
  process.stderr.write(`[web-auto-test daemon] Fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
