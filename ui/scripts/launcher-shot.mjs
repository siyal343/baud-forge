// Renders the desktop launcher headlessly (puppeteer-core + system Edge) and
// saves the screenshot used by the documentation site (docs/site/img/launcher.png).
// `window.__TAURI__` is mocked with sample data so the two-column launcher
// renders exactly as it does inside the Tauri shell, without the shell.
// Usage: node scripts/launcher-shot.mjs [baseUrl] [outPath]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:5173/';
const OUT = process.argv[3] || '../docs/site/img/launcher.png';
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];
const executablePath = EDGE_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome executable found');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--window-size=1920,1080', '--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1920, height: 1080 },
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const ports = [
      { device_path: 'COM7', vid_pid: '1A86:7523', serial: 'A1B2' },
      { device_path: 'COM12', vid_pid: '0403:6001', serial: null },
      { device_path: 'COM14', vid_pid: '10C4:EA60', serial: null },
    ];
    const recents = [
      'C:\\rigs\\obc-hil\\obc-hil.bforge.toml',
      'C:\\rigs\\imu-bench\\imu-bench.bforge.toml',
      'C:\\rigs\\xmodem-boot\\boot-probe.bforge.toml',
    ];
    const profiles = [
      { name: 'IMU bench @ 921600', path: 'C:\\Users\\demo\\AppData\\Roaming\\BaudForge\\profiles\\IMU-bench-921600.bforge.toml' },
      { name: 'OBC HIL 115200 8N1', path: 'C:\\Users\\demo\\AppData\\Roaming\\BaudForge\\profiles\\OBC-HIL-115200-8N1.bforge.toml' },
      { name: 'Bootloader probe @ 460800', path: 'C:\\Users\\demo\\AppData\\Roaming\\BaudForge\\profiles\\Bootloader-probe-460800.bforge.toml' },
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'list_serial_ports') return ports;
          if (cmd === 'recent_workspaces') return recents;
          if (cmd === 'list_profiles') return profiles;
          return null;
        },
      },
    };
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(1200); // launcher render + port list fill
  await page.screenshot({ path: OUT });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
}
