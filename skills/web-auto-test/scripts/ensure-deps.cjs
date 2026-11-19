'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_DIR = process.env.WEBTEST_DEPS_DIR || path.join(os.homedir(), '.cache', 'web-auto-test');

function getDepsDir() {
  return CACHE_DIR;
}

function resolvePlaywrightCore() {
  // 1. Check current resolution paths (NODE_PATH, local node_modules, etc.)
  try {
    return require.resolve('playwright-core');
  } catch (_) {
    // continue
  }

  // 2. Check cache directory
  try {
    return require.resolve('playwright-core', { paths: [CACHE_DIR] });
  } catch (_) {
    // continue
  }

  // 3. Check full `playwright` package if already installed
  try {
    return require.resolve('playwright', { paths: [process.cwd(), CACHE_DIR] });
  } catch (_) {
    return null;
  }
}

function ensurePlaywright(options = {}) {
  const silent = Boolean(options.silent);
  const existing = resolvePlaywrightCore();
  if (existing) {
    return require(existing);
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const pkgJsonPath = path.join(CACHE_DIR, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'web-auto-test-runtime',
          version: '1.0.0',
          private: true,
          description: 'Runtime dependency cache for web-auto-test skill'
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  if (!silent) {
    process.stderr.write(`[web-auto-test] Installing playwright-core into ${CACHE_DIR} ...\n`);
  }

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(
    npmCmd,
    ['install', '--no-audit', '--no-fund', '--loglevel=error', 'playwright-core'],
    {
      cwd: CACHE_DIR,
      stdio: silent ? 'pipe' : 'inherit',
      env: process.env
    }
  );

  if (res.error || res.status !== 0) {
    const detail = res.error
      ? res.error.message
      : (res.stderr ? res.stderr.toString('utf8').trim() : `exit code ${res.status}`);
    throw new Error(
      `Failed to install playwright-core into ${CACHE_DIR}: ${detail}\n` +
        `Manual fix: mkdir -p "${CACHE_DIR}" && cd "${CACHE_DIR}" && npm install playwright-core`
    );
  }

  const resolved = resolvePlaywrightCore();
  if (!resolved) {
    throw new Error(`playwright-core installed but could not be resolved from ${CACHE_DIR}`);
  }
  return require(resolved);
}

if (require.main === module) {
  try {
    const modPath = resolvePlaywrightCore();
    if (modPath) {
      console.log(JSON.stringify({ ok: true, cached: true, path: modPath, depsDir: CACHE_DIR }));
    } else {
      ensurePlaywright({ silent: false });
      const installedPath = resolvePlaywrightCore();
      console.log(JSON.stringify({ ok: true, cached: false, path: installedPath, depsDir: CACHE_DIR }));
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

module.exports = {
  getDepsDir,
  resolvePlaywrightCore,
  ensurePlaywright
};
