// Documentation site builder: docs/src/*.md → docs/site/*.html (static, GitHub Pages).
// Run from ui/: node scripts/build-docs.mjs   (marked is a ui devDependency)
import { marked } from 'marked';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, '..');
const repoRoot = join(uiDir, '..');
const srcDir = join(repoRoot, 'docs', 'src');
const outDir = join(repoRoot, 'docs', 'site');

// Page order = sidebar order. {file, title, group}
const PAGES = [
  { file: 'index', title: 'Overview & Quickstart', group: 'Getting started' },
  { file: 'launcher', title: 'Desktop Launcher', group: 'Getting started' },
  { file: 'packet-stream', title: 'Packet Stream', group: 'Observing' },
  { file: 'protocol-dissector', title: 'Protocol Dissector', group: 'Observing' },
  { file: 'hex-inspector', title: 'Hex & ASCII', group: 'Observing' },
  { file: 'oscilloscope', title: 'Telemetry Oscilloscope', group: 'Observing' },
  { file: 'dvr-replay', title: 'DVR & Replay', group: 'Observing' },
  { file: 'session-diff', title: 'Session Diff', group: 'Observing' },
  { file: 'command-forge', title: 'Command Forge', group: 'Instruments' },
  { file: 'pin-sequencer', title: 'Pin Sequencer', group: 'Instruments' },
  { file: 'fault-rig', title: 'HIL Fault Rig', group: 'Instruments' },
  { file: 'file-transfer', title: 'X/YMODEM Transfer', group: 'Instruments' },
  { file: 'mitm-bridge', title: 'MITM Bridge', group: 'Instruments' },
  { file: 'elf-symbols', title: 'ELF Symbols', group: 'Instruments' },
  { file: 'schema-dialects', title: 'Schema Dialects', group: 'Observing' },
  { file: 'activity-log', title: 'Activity Log', group: 'Records' },
  { file: 'rec-vaults', title: 'REC & Vaults', group: 'Records' },
  { file: 'exports', title: 'Exports', group: 'Records' },
  { file: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', group: 'Reference' },
  { file: 'troubleshooting', title: 'Troubleshooting', group: 'Reference' },
];

marked.setOptions({ gfm: true, breaks: false });

const css = `
:root{--bg:#0a0d13;--panel:#10141d;--panel2:#161c28;--line:#222d3d;--fg:#e2e8f0;--dim:#94a3b8;--faint:#64748b;--accent:#00e5ff;--warn:#f59e0b;--err:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 'Segoe UI',system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:12px;padding:10px 22px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:10}
header.top .brand{font-family:Consolas,monospace;font-weight:700;letter-spacing:.18em;color:var(--accent);font-size:15px}
header.top .tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:3px;padding:1px 7px}
header.top .gh{margin-left:auto;font-size:12px}
.wrap{display:flex;max-width:1440px;margin:0 auto}
nav.side{width:250px;min-width:250px;padding:22px 14px 60px;border-right:1px solid var(--line);position:sticky;top:53px;height:calc(100vh - 53px);overflow-y:auto;background:var(--panel)}
nav.side .grp{font-family:Consolas,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:18px 10px 6px}
nav.side a{display:block;padding:5px 10px;border-radius:5px;color:var(--dim);font-size:13px}
nav.side a:hover{background:var(--panel2);color:var(--fg);text-decoration:none}
nav.side a.cur{background:rgba(0,229,255,.08);color:var(--accent);border-left:2px solid var(--accent)}
main{flex:1;min-width:0;padding:34px 44px 90px;max-width:940px}
main h1{font-size:27px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-top:0}
main h2{font-size:19px;margin-top:38px;border-left:3px solid var(--accent);padding-left:10px}
main h3{font-size:15px;color:var(--dim)}
main img{max-width:100%;border:1px solid var(--line);border-radius:8px;margin:14px 0;box-shadow:0 6px 24px rgba(0,0,0,.45);display:block}
main code{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:1px 6px;font:12.5px Consolas,monospace;color:#fbcfe8}
main pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
main pre code{background:none;border:none;padding:0;color:#a5f3fc;line-height:1.55}
main table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}
main th{background:var(--panel2);text-align:left;font-family:Consolas,monospace;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim)}
main th,main td{border:1px solid var(--line);padding:7px 11px;vertical-align:top}
main tr:nth-child(even) td{background:rgba(22,28,40,.4)}
main blockquote{border-left:3px solid var(--warn);background:rgba(245,158,11,.07);margin:14px 0;padding:10px 16px;color:var(--dim)}
.pager{display:flex;justify-content:space-between;margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-family:Consolas,monospace;font-size:13px}
.pager a.prev::before{content:'← '}
.pager a.next::after{content:' →'}
footer{border-top:1px solid var(--line);color:var(--faint);font-size:12px;padding:16px 22px;text-align:center}
`;

function renderNav(current) {
  const groups = [];
  for (const p of PAGES) {
    let g = groups.find((x) => x.group === p.group);
    if (!g) { g = { group: p.group, items: [] }; groups.push(g); }
    g.items.push(p);
  }
  return groups
    .map(
      (g) =>
        `<div class="grp">${g.group}</div>` +
        g.items
          .map(
            (p) =>
              `<a href="${p.file}.html"${p.file === current ? ' class="cur"' : ''}>${p.title}</a>`
          )
          .join('')
    )
    .join('\n');
}

function pager(current) {
  const i = PAGES.findIndex((p) => p.file === current);
  const prev = i > 0 ? PAGES[i - 1] : null;
  const next = i < PAGES.length - 1 ? PAGES[i + 1] : null;
  return (
    '<div class="pager">' +
    (prev ? `<a class="prev" href="${prev.file}.html">${prev.title}</a>` : '<span></span>') +
    (next ? `<a class="next" href="${next.file}.html">${next.title}</a>` : '<span></span>') +
    '</div>'
  );
}

function shell(page, title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — BaudForge</title>
<meta name="description" content="BaudForge user documentation — hardware engineering workstation">
<style>${css}</style></head>
<body>
<header class="top"><span class="brand">BAUDFORGE</span><span class="tag">v1.0 docs</span><a class="gh" href="https://github.com/siyal343/baud-forge">GitHub ↗</a></header>
<div class="wrap">
<nav class="side">${renderNav(page)}</nav>
<main>${body}${pager(page)}</main>
</div>
<footer>BaudForge — hardware engineering workstation · built from docs/src with marked · screenshots from the live application on real hardware</footer>
</body></html>`;
}

mkdirSync(outDir, { recursive: true });
const imgDir = join(outDir, 'img');
mkdirSync(imgDir, { recursive: true });

let built = 0;
for (const p of PAGES) {
  const mdPath = join(srcDir, `${p.file}.md`);
  if (!existsSync(mdPath)) {
    console.error(`missing source: docs/src/${p.file}.md`);
    process.exit(1);
  }
  const md = readFileSync(mdPath, 'utf8');
  // Rewrite bare image paths (img/…) as relative to the page (they already are).
  const body = marked.parse(md);
  const title = p.title;
  writeFileSync(join(outDir, `${p.file}.html`), shell(p.file, title, body));
  built++;
}

// Screenshots already live in docs/site/img (captured from the running app
// in place); markdown references them as img/<name>.png relative to each page.
console.log(`built ${built} pages → docs/site/`);
