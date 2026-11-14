// Self-bootstrapping smoke gate: starts the Vite dev server on a private port,
// runs ui/scripts/ui-smoke.mjs against it, then tears the server down.
// Exit code = smoke suite exit code (2 = no Edge/Chrome found, 1 = checks failed,
// 3 = dev server never came up). Lets CI / agents run `node scripts/smoke-gate.mjs`
// from the repo root without a server already running.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Edge 157 on this machine exits instantly in headless mode (post-update regression),
// so prefer the downloaded chrome-headless-shell when it is present. ui-smoke.mjs
// picks BFORGE_SMOKE_BROWSER before its built-in browser list.
const BROWSER_CACHE = 'C:/Users/mushii/AppData/Local/bforge-browsers';
function findHeadlessShell(dir, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findHeadlessShell(p, depth + 1);
      if (hit) return hit;
    } else if (entry.name === 'chrome-headless-shell.exe') {
      return p;
    }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolve the browser to drive: a chrome-headless-shell when one is available
// (possibly landing mid-run from a slow CDN download), else the installed Edge.
async function resolveBrowser(waitMs = 20 * 60 * 1000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const shell = findHeadlessShell(BROWSER_CACHE);
    if (shell) return { path: shell, source: 'chrome-headless-shell' };
    const zip = join(BROWSER_CACHE, 'dl', 'chs.zip');
    if (existsSync(zip)) {
      // Native bsdtar handles zip archives on Windows 10+ and accepts C:/ paths
      // (Git Bash's GNU tar does not); a partial download fails and retries.
      spawnSync('C:/Windows/System32/tar.exe', ['-xf', zip, '-C', join(BROWSER_CACHE, 'dl', 'extracted')], { stdio: 'ignore' });
      const extracted = findHeadlessShell(BROWSER_CACHE);
      if (extracted) return { path: extracted, source: 'chrome-headless-shell (extracted)' };
    }
    if (Date.now() > deadline) return { path: null, source: 'installed Edge (fallback)' };
    await sleep(30000);
  }
}
const browser = await resolveBrowser();
console.log(`smoke gate browser: ${browser.source}`);
const shellPath = browser.path;
if (!shellPath) {
  console.error('chrome-headless-shell not found; falling back to the installed Edge');
}

const PORT = 5174;
const BASE = `http://127.0.0.1:${PORT}/`;

let serverLog = '';
// Spawn vite's binary directly: `pnpm run dev -- <flags>` mangles flag forwarding
// (the flags arrive quoted and vite starts on its default port instead).
const server = spawn(
  'node',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: 'ui', stdio: ['ignore', 'pipe', 'pipe'] },
);
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const killServer = () => {
  if (!server.pid || server.killed) return;
  server.killed = true;
  try {
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* best effort teardown */
  }
};
process.on('SIGINT', () => { killServer(); process.exit(130); });
process.on('SIGTERM', () => { killServer(); process.exit(143); });

async function waitForServer(deadlineMs = 60000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let exitCode = 3;
try {
  const up = await waitForServer();
  if (!up) {
    console.error('DEV SERVER DID NOT START');
    console.error(serverLog.slice(-4000));
  } else {
    const smoke = spawn('node', ['scripts/ui-smoke.mjs', BASE], {
      cwd: 'ui',
      stdio: ['ignore', 'inherit', 'inherit'],
      env: shellPath ? { ...process.env, BFORGE_SMOKE_BROWSER: shellPath } : process.env,
    });
    exitCode = (await new Promise((resolve) => smoke.on('exit', resolve))) ?? 1;
  }
} finally {
  killServer();
}
process.exit(exitCode);
