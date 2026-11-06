// One-off live check: the Activity Log panel against a REAL engine.
// Engine on :7717 (e2e workspace), dev server on :5173. Verifies the full
// loop: engine entries (session_started, port_state) render in the panel,
// and a UI-originated action logged through logAction shows up as source UI.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = EDGE_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('no Edge/Chrome found');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900 },
});
try {
  const page = await browser.newPage();
  // domcontentloaded, never networkidle: the SSE /api/events stream never
  // goes idle by design.
  await page.goto('http://localhost:5173/?api=http://127.0.0.1:7717', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Open the panel through the store, as a user's panel-menu click would.
  await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('activityLog'));
  await new Promise((r) => setTimeout(r, 3500));

  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()).join(' | ')
    );
    const engineRows = rows.filter((r) => r.includes('ENGINE')).length;
    const started = rows.find((r) => r.includes('session_started')) ?? null;
    const portState = rows.find((r) => r.includes('port_state')) ?? null;
    const errors = rows.filter((r) => r.includes('ERROR')).length;
    return { total: rows.length, engineRows, started, portState, errors, sample: rows.slice(0, 6) };
  });

  // A UI-originated entry through the real logAction path.
  await page.evaluate(() =>
    fetch('http://127.0.0.1:7717/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'info', event: 'live_probe', detail: 'activity-live-check' }),
    })
  );
  await new Promise((r) => setTimeout(r, 2500));
  const after = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => tr.textContent);
    return { total: rows.length, probeSeen: rows.some((r) => r.includes('live_probe') && r.includes('UI')) };
  });

  let ok = true;
  const check = (name, pass, detail) => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (!pass) ok = false;
  };
  check('panel shows engine entries', result.engineRows > 0, `${result.engineRows}/${result.total} rows from engine`);
  check('session_started visible', !!result.started, result.started ?? 'missing');
  check('port_state visible', !!result.portState, result.portState ?? 'missing');
  check('UI-source entry lands in the same timeline', after.probeSeen, `${result.total} -> ${after.total} rows`);
  console.log('\nsample rows:');
  for (const row of result.sample) console.log('  ' + row.slice(0, 150));
  process.exit(ok ? 0 : 1);
} finally {
  await browser.close();
}
