// Headless UI smoke test for BaudForge (puppeteer-core + system Edge).
// Runs in its own browser instance - never touches the user's session.
// Covers the UI-interaction aspects that vitest cannot: global shortcuts,
// toasts, DVR readout, scope canvas lifecycle, dissector readout.
// Usage: node scripts/ui-smoke.mjs [baseUrl]
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:5173/';
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];
import { existsSync } from 'node:fs';
const executablePath = EDGE_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome executable found');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const streamCount = (page) =>
  page.evaluate(() => {
    const region = [...document.querySelectorAll('[role="region"]')].find((r) =>
      (r.getAttribute('aria-label') || '').includes('PACKET STREAM')
    );
    const m = region ? region.innerText.match(/OF (\d+)/) : null;
    return m ? Number(m[1]) : -1;
  });

const activeTestId = (page) =>
  page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

const toasts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="status"]')].map((d) => d.textContent).join(' || ')
  );

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  // --no-sandbox: CI runners may lack user namespaces; harmless locally.
  args: ['--window-size=1920,1080', '--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1920, height: 1080 },
});
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(2500); // app boot + simulation warm-up

  // T1: simulation stream grows
  const c1 = await streamCount(page);
  await sleep(1500);
  const c2 = await streamCount(page);
  check('sim stream flows', c2 > c1, `${c1} -> ${c2}`);

  // T2: '/' focuses the stream filter
  await page.keyboard.press('/');
  await sleep(250);
  const focus1 = await activeTestId(page);
  check("'/'' focuses stream filter", focus1 === 'bforge-stream-filter', String(focus1));

  // T3: Escape clears the filter text
  await page.keyboard.type('ImuPacket');
  await sleep(200);
  const typed = await page.$eval('#bforge-stream-filter', (el) => el.value);
  await page.keyboard.press('Escape');
  await sleep(250);
  const cleared = await page.$eval('#bforge-stream-filter', (el) => el.value);
  check('Escape clears filter', typed === 'ImuPacket' && cleared === '', `typed='${typed}' cleared='${cleared}'`);

  // T4: Ctrl+L clears the stream, sim regrows it
  await page.evaluate(() => document.activeElement?.blur?.());
  const before = await streamCount(page);
  await page.keyboard.down('Control');
  await page.keyboard.press('l');
  await page.keyboard.up('Control');
  await sleep(150);
  const afterClear = await streamCount(page);
  await sleep(1500);
  const regrown = await streamCount(page);
  // Sim regrows at ~20 pkt/s, so sample quickly after the clear: the count
  // must collapse toward zero and then recover.
  check('Ctrl+L clears stream', before > 0 && afterClear < 40 && regrown > afterClear, `${before} -> ${afterClear} -> ${regrown}`);

  // T5: Space pauses DVR with the spec'd readout
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press(' ');
  await sleep(400);
  const paused = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => /PAUSED AT T-[0-9.]+s/.test(d.textContent) && d.textContent.length < 80);
    return el ? (el.textContent.match(/PAUSED AT T-[0-9.]+s/) || ['no'])[0] : 'no';
  });
  await page.keyboard.press(' '); // resume
  await sleep(300);
  const liveAgain = await page.evaluate(() =>
    [...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'STREAMING LIVE')
  );
  check('Space pause shows PAUSED AT T-x.xxxs', paused !== 'no' && liveAgain, paused);

  // T5b: true replay loop — pause, Play walks the buffer, REPLAYING pill
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press(' '); // pause live
  await sleep(350);
  const playBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      (x.title || '').startsWith('Replay buffered frames')
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (playBtn) {
    await page.mouse.click(playBtn.x, playBtn.y);
    await sleep(900);
    const replaying = await page.evaluate(() =>
      [...document.querySelectorAll('div')].some((d) => /^REPLAYING ×/.test(d.textContent.trim()))
    );
    const sliderVal = () =>
      page.evaluate(() => {
        const s = document.querySelector('input[type="range"]');
        return s ? Number(s.value) : -1;
      });
    const selDuringReplay = await sliderVal();
    await sleep(1200); // let it walk further
    const selAfter = await sliderVal();
    // Space returns to live (setDvrPaused(false) stops the replay)
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press(' ');
    await sleep(400);
    const backLive = await page.evaluate(() =>
      [...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'STREAMING LIVE')
    );
    check(
      'true replay walks buffer while paused',
      replaying && backLive && selDuringReplay !== selAfter,
      `pill=${replaying} live=${backLive} hl '${selDuringReplay}' -> '${selAfter}'`
    );
  } else {
    check('true replay walks buffer while paused', false, 'Replay Play button missing');
  }

  // T6: REC pill honest label
  const rec = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('STANDBY') || x.textContent.includes('● REC'));
    return b ? b.textContent.trim() : 'not found';
  });
  check('REC pill reads STANDBY', rec === 'STANDBY', rec);

  // T7: DISCONNECT then CONNECT with engine offline -> honest warn toast.
  // The app boots in the connected (simulated) state, so the ribbon shows
  // DISCONNECT first; the CONNECT path exercises quick-connect + warn.
  const ribbonBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent.trim() === 'DISCONNECT' || x.textContent.trim() === 'CONNECT'
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { label: b.textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (ribbonBtn && ribbonBtn.label === 'DISCONNECT') {
    await page.mouse.click(ribbonBtn.x, ribbonBtn.y);
    await sleep(600);
  }
  const conn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'CONNECT');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (conn) {
    await page.mouse.click(conn.x, conn.y);
    let toast = '';
    // The connect path is honest about what an offline CONNECT means now.
    for (let i = 0; i < 12 && !toast.includes('Engine unreachable'); i++) {
      await sleep(500);
      toast = await toasts(page);
    }
    check('CONNECT warns engine offline', toast.includes('Engine unreachable'), toast.slice(0, 120));
  } else {
    check('CONNECT warns engine offline', false, 'CONNECT button not found after disconnect');
  }

  // T8: scope tab, RUN/STOP toggle, canvas keeps a frozen frame
  const activateTab = async (label) => {
    for (let i = 0; i < 3; i++) {
      const ok = await page.evaluate((lbl) => {
        const el = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.includes(lbl));
        if (!el) return false;
        el.focus();
        return el.getAttribute('aria-selected') === 'true';
      }, label);
      if (ok) return true;
      await page.keyboard.press('Enter');
      await sleep(450);
      const sel = await page.evaluate((lbl) => {
        const el = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.includes(lbl));
        return el ? el.getAttribute('aria-selected') === 'true' : false;
      }, label);
      if (sel) return true;
    }
    return false;
  };
  const scopeTab = await activateTab('TELEMETRY OSCILLOSCOPE');
  check('scope tab reachable', scopeTab);
  if (scopeTab) {
    const run = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'RUNNING');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (run) {
      await page.mouse.click(run.x, run.y);
      await sleep(500);
      const stopped = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'STOPPED')
      );
      const dataLen = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        return c ? c.toDataURL().length : 0;
      });
      check('scope STOPPED freezes with rendered frame', stopped && dataLen > 20000, `dataUrl=${dataLen}`);
      // back to RUNNING for a clean state
      const stop = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'STOPPED');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (stop) {
        await page.mouse.click(stop.x, stop.y);
        await sleep(300);
      }
    } else {
      check('scope STOPPED freezes with rendered frame', false, 'RUNNING button missing');
    }
  }

  // T8b: Struct Form composer — parse default header, pack, transmit
  const cfOk2 = await activateTab('COMMAND FORGE');
  if (cfOk2) {
    const structBtn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => x.textContent.trim() === 'STRUCT' && (x.getAttribute('data-tooltip') || '').includes('Struct form')
      );
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (structBtn) {
      await page.mouse.click(structBtn.x, structBtn.y);
      await sleep(500);
      const panel = await page.evaluate(() => {
        const label = [...document.querySelectorAll('span')].find((x) => /ImuPacket · \d+ fields · \d+ B packed LE/.test(x.textContent || ''));
        const wire = [...document.querySelectorAll('div')].find((x) => /^WIRE: [0-9A-F ]+$/.test((x.textContent || '').trim()));
        return { label: label ? label.textContent : null, wire: wire ? wire.textContent.trim().slice(0, 60) : null };
      });
      // Fill the first numeric field (seq) and transmit.
      const filled = await page.evaluate(() => {
        const input = [...document.querySelectorAll('input')].find((x) => x.placeholder === 'integer');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '7');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      });
      await sleep(300);
      const tx = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('TRANSMIT PAYLOAD'));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (tx) {
        await page.mouse.click(tx.x, tx.y);
        await sleep(900);
        const dispatched = await page.evaluate(() => {
          // The store is the authoritative record: the virtualized grid only
          // renders the visible window, which may have scrolled off the tail.
          const hasCommandRow = window.__bforgeStore.getState().packets.some((p) => p.protocol === 'Command');
          const toastsNow = [...document.querySelectorAll('[role="status"]')].map((d) => d.textContent).join(' ');
          return hasCommandRow && toastsNow.includes('TX recorded locally only');
        });
        check(
          'struct form parses, packs, and transmits',
          !!panel.label && !!panel.wire && filled && dispatched,
          `label=${panel.label ?? 'none'} wire=${panel.wire ? 'ok' : 'none'} filled=${filled} dispatched=${dispatched}`
        );
      } else {
        check('struct form parses, packs, and transmits', false, 'TRANSMIT button missing');
      }
    } else {
      check('struct form parses, packs, and transmits', false, 'STRUCT format button missing');
    }
  } else {
    check('struct form parses, packs, and transmits', false, 'COMMAND FORGE tab not reachable');
  }

  // T8c: MITM bridge panel opens and is honest about missing engine ports.
  // Opened via the store's panel-open action — the layouts menu is covered by
  // the interactive audit and is timing-flaky under automation mid-flow.
  {
    await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('bridge'));
    await sleep(800);
    const panelUp = await page.evaluate(() => {
      // Panel presence via its content — dockview renders the new tab inside
      // an overflowed strip that may sit outside the probed DOM region.
      const tab = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.includes('MITM BRIDGE'));
      const empty = [...document.querySelectorAll('div')].some((d) => d.textContent.includes('No engine session ports yet'));
      const composer = [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'ARM BRIDGE');
      return { opened: !!tab || (empty && composer), empty: empty && composer };
    });
    const armBtn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'ARM BRIDGE');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    let warn = '';
    if (armBtn) {
      await page.mouse.click(armBtn.x, armBtn.y);
      await sleep(600);
      warn = await toasts(page);
    }
    check(
      'MITM bridge panel opens and is honest offline',
      panelUp.opened && panelUp.empty && warn.includes('Pick both bridge ends'),
      `opened=${panelUp.opened} emptyState=${panelUp.empty} warn=${warn.includes('Pick both bridge ends')}`
    );
  }

  // T8d: Workflow B — scope click syncs stream/DVR to that instant
  const scopeOk2 = await activateTab('TELEMETRY OSCILLOSCOPE');
  if (scopeOk2) {
    // Ensure cursors are not armed: click the cursor-mode OFF chip if present.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'OFF' && (x.getAttribute('data-tooltip') || '').length >= 0);
      if (b) b.click();
    });
    await sleep(200);
    const before = await page.evaluate(() => window.__bforgeStore.getState().selectedPacket?.timestampUs ?? 0);
    // Click the left quarter of the canvas.
    const clicked = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      window.__wfB = { x: r.left + r.width * 0.25, y: r.top + r.height / 2 };
      return true;
    });
    if (clicked) {
      await page.mouse.click((await page.evaluate(() => window.__wfB.x)), (await page.evaluate(() => window.__wfB.y)));
      await sleep(600);
      const after = await page.evaluate(() => ({
        t: window.__bforgeStore.getState().selectedPacket?.timestampUs ?? 0,
        paused: window.__bforgeStore.getState().isPaused,
        live: window.__bforgeStore.getState().isLive,
      }));
      // Back to live.
      await page.evaluate(() => window.__bforgeStore.getState().setDvrLive());
      check(
        'Workflow B: scope click syncs workstation to that instant',
        after.t !== before && after.paused && !after.live,
        `t ${before} -> ${after.t} paused=${after.paused}`
      );
    } else {
      check('Workflow B: scope click syncs workstation to that instant', false, 'no canvas');
    }
  } else {
    check('Workflow B: scope click syncs workstation to that instant', false, 'scope tab not reachable');
  }

  // T9: dissector highlighted-field readout + honest plot action.
  // Both panels live in dockview groups whose inactive tabs are unmounted —
  // activate the tabs first (keyboard path, same as the scope).
  const hexTab = await activateTab('CANONICAL HEX & ASCII');
  const hl = hexTab
    ? await page.evaluate(() => {
        const el = [...document.querySelectorAll('div,span')].find((d) => /^HL: /.test(d.textContent.trim()) && d.textContent.includes('· 0x'));
        return el ? el.textContent.trim().slice(0, 90) : null;
      })
    : null;
  check('HexInspector shows full field readout', !!hl, hl || 'not found');
  const disTab = await activateTab('PROTOCOL DISSECTOR');
  const plotBtn = disTab
    ? await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('Plot ') && x.getBoundingClientRect().width > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })
    : null;
  if (plotBtn) {
    const boundName = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').startsWith('Plot '));
      return b ? (b.title.match(/Plot (\S+)/) || [])[1] : '';
    });
    await page.mouse.click(plotBtn.x, plotBtn.y);
    await sleep(600);
    const toast = await toasts(page);
    // The scope ribbon carries the trace stem — activate the scope tab first,
    // since dockview unmounts inactive panels.
    await activateTab('TELEMETRY OSCILLOSCOPE');
    await sleep(400);
    const stem = await page.evaluate((name) => {
      const b = [...document.querySelectorAll('button')].find(
        (x) =>
          x.querySelector('span') &&
          x.querySelector('span').textContent === name &&
          (x.getAttribute('data-tooltip') || '').includes('trace lane')
      );
      return b ? b.textContent.trim() : null;
    }, boundName);
    check(
      'plot binds a scope trace lane',
      toast.includes('Field bound to scope') && !!stem,
      `toast=${toast.includes('Field bound to scope')} stem=${stem ?? 'none'} (${boundName})`
    );
  } else {
    check('plot binds a scope trace lane', false, disTab ? 'no numeric-field plot button visible' : 'dissector tab not reachable');
  }

  // T10: activity log panel mounts, renders its chrome and its empty state.
  // The smoke runs without an engine, so the ring is unreachable — the empty
  // state IS the honest rendering here (live endpoints are covered by cargo
  // tests and the curl pass).
  {
    await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('activityLog'));
    await sleep(800);
    const state = await page.evaluate(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.includes('ACTIVITY LOG'));
      const header = [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === 'ACTIVITY LOG');
      const empty = [...document.querySelectorAll('p')].some((p) => p.textContent.includes('No entries yet'));
      const filters = ['debug', 'info', 'warn', 'error'].every((level) =>
        [...document.querySelectorAll('button')].some((b) => b.textContent.trim().toLowerCase() === level)
      );
      return { tab: !!tab, header, empty, filters };
    });
    check(
      'activity log panel opens with filters and honest empty state',
      state.header && state.empty && state.filters,
      `header=${state.header} empty=${state.empty} filters=${state.filters}`
    );
  }
  // T11: vault export modal — stacking order and honest export results.
  // The overlay must sit above dockview chrome (sashes are z-99, the floating
  // group host is forced to z-500) or panel separators paint over the dimmed
  // backdrop. A vault export without an engine must SAY it failed — the old
  // anchor download reported "Download initiated" while saving nothing.
  {
    await page.evaluate(() => window.__bforgeStore.getState().setExportModalOpen(true));
    await sleep(400);
    const modal = await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('div')].find((d) =>
        d.className?.includes?.('z-[999998]')
      );
      const open = [...document.querySelectorAll('h2')].some((h) =>
        h.textContent.includes('Session Vault Export')
      );
      return { open, z: overlay ? getComputedStyle(overlay).zIndex : null };
    });
    const zOk = modal.z !== null && Number(modal.z) >= 999998;
    check('export modal opens above dockview chrome', modal.open && zOk, `z=${modal.z}`);

    // Vault source with no engine: the click must produce a real request and
    // an honest failure, never a fake success message.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('EXPORT PCAPNG'))
        ?.click();
    });
    await sleep(1200);
    const vaultStatus = await page.evaluate(() =>
      [...document.querySelectorAll('span')].map((s) => s.textContent).find((t) => t.startsWith('Export failed') || t.startsWith('Saved'))
    );
    check(
      'vault export reports failure without an engine',
      typeof vaultStatus === 'string' && vaultStatus.startsWith('Export failed'),
      String(vaultStatus)
    );

    // Memory source: client-side export still succeeds.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Live Stream Buffer'))
        ?.click();
    });
    await sleep(300);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('EXPORT PCAPNG'))
        ?.click();
    });
    await sleep(1200);
    const memStatus = await page.evaluate(() =>
      [...document.querySelectorAll('span')].map((s) => s.textContent).find((t) => t.includes('Exported') || t.startsWith('Export failed'))
    );
    check(
      'memory export succeeds client-side',
      typeof memStatus === 'string' && memStatus.includes('Exported'),
      String(memStatus)
    );
    await page.evaluate(() => window.__bforgeStore.getState().setExportModalOpen(false));
  }

  // T12: Settings dialog — entry points, draft semantics, persistence, and
  // the hex/tooltip preferences it drives. Runs entirely against the real UI
  // (gear clicks, Ctrl+,) plus the persisted blob for the durability claims.
  {
    const clickInSettings = (text) =>
      page.evaluate((t) => {
        const overlay = [...document.querySelectorAll('div')].find((d) =>
          d.className?.includes?.('z-[999998]')
        );
        if (!overlay) return false; // dialog not open — report, don't crash
        const btn = [...overlay.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === t && b.getBoundingClientRect().width > 0
        );
        if (btn) btn.click();
        return !!btn;
      }, text);

    const settingsOpen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === 'SETTINGS')
      );

    const openViaGear = async () => {
      await page.evaluate(() => {
        const gear = [...document.querySelectorAll('button')].find((b) =>
          (b.getAttribute('title') || '').startsWith('Application settings')
        );
        gear?.click();
      });
      await sleep(400);
    };

    // Gear opens the dialog (lands on GENERAL)
    await openViaGear();
    check('gear opens settings dialog', await settingsOpen());
    check('settings dialog lands on GENERAL section', await page.evaluate(() => {
      const rail = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'GENERAL');
      return !!rail && rail.className.includes('border-bf-cyan');
    }));

    // Escape closes and DISCARDS the draft (no blob must be written)
    await clickInSettings('APPEARANCE');
    await clickInSettings('SESSION'); // stage timestampBase=relative
    await page.keyboard.press('Escape');
    await sleep(300);
    const afterDiscard = await page.evaluate(() => localStorage.getItem('bforge_settings_v1'));
    check(
      'Escape discards settings draft',
      !(await settingsOpen()) && afterDiscard === null,
      `blob=${afterDiscard === null ? 'absent' : 'written!'}`
    );

    // Ctrl+, opens
    await page.keyboard.down('Control');
    await page.keyboard.press(',');
    await page.keyboard.up('Control');
    await sleep(400);
    check('Ctrl+, opens settings dialog', await settingsOpen());

    // ⓘ hint: hovering a settings row body shows nothing; hovering the row's
    // ⓘ icon shows the styled hint surface (TooltipOverlay portal).
    // Ctrl+, above re-opened the dialog on GENERAL — go to APPEARANCE.
    await clickInSettings('APPEARANCE');
    const hintViaIcon = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const overlayVisible = () =>
        [...document.querySelectorAll('div')].some(
          (d) => d.className?.includes?.('pointer-events-none') && d.textContent.trim()
        );
      const label = [...document.querySelectorAll('span')].find(
        (s) => s.textContent.trim() === 'Tooltips:'
      );
      if (!label) return 'no-label';
      label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(300);
      const rowHoverSilent = !overlayVisible();
      label.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await sleep(300);
      const icon = label.querySelector('span[title]');
      if (!icon) return 'no-icon';
      icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(300);
      const iconHoverShows = overlayVisible();
      icon.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await sleep(200);
      return rowHoverSilent && iconHoverShows;
    });
    check('settings hint appears only via ⓘ icon', hintViaIcon === true, String(hintViaIcon));

    // Apply persists (timestamp base SESSION) and survives a reload.
    // The dialog lands on GENERAL now — navigate to APPEARANCE first.
    await openViaGear();
    await clickInSettings('APPEARANCE');
    await clickInSettings('SESSION');
    await clickInSettings('Apply');
    await sleep(300);
    let blob = JSON.parse(await page.evaluate(() => localStorage.getItem('bforge_settings_v1') || '{}'));
    check('Apply writes settings blob', blob.timestampBase === 'relative', JSON.stringify(blob.timestampBase));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    blob = JSON.parse(await page.evaluate(() => localStorage.getItem('bforge_settings_v1') || '{}'));
    check('settings survive reload', blob.timestampBase === 'relative', JSON.stringify(blob.timestampBase));

    // Theme system: GENERAL section — pick SKEUO + LIGHT, Apply, verify the
    // html attributes flip, the canvas surface repaints, and the blob records
    // the choice; then reload and confirm the pre-paint restore.
    await openViaGear();
    const sawThemePicker =
      (await clickInSettings('CLASSIC')) && (await clickInSettings('MATERIAL')) && (await clickInSettings('SKEUO'));
    check('theme picker lists all skins', !!sawThemePicker);
    await clickInSettings('SKEUO');
    await clickInSettings('LIGHT');
    await clickInSettings('Apply');
    await sleep(400);
    const themeAttrs = await page.evaluate(() => [
      document.documentElement.getAttribute('data-bf-theme'),
      document.documentElement.getAttribute('data-bf-mode'),
    ]);
    check(
      'theme apply flips html attrs',
      themeAttrs[0] === 'skeuomorph' && themeAttrs[1] === 'light',
      JSON.stringify(themeAttrs)
    );
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const darkCanvas = await page.evaluate(() => {
      const el = document.documentElement;
      const prev = [el.getAttribute('data-bf-theme'), el.getAttribute('data-bf-mode')];
      el.setAttribute('data-bf-theme', 'obsidian');
      el.setAttribute('data-bf-mode', 'dark');
      const dark = getComputedStyle(document.body).backgroundColor;
      el.setAttribute('data-bf-theme', prev[0]);
      el.setAttribute('data-bf-mode', prev[1]);
      return dark;
    });
    check('light theme repaints surfaces', bodyBg !== darkCanvas, `${bodyBg} vs dark ${darkCanvas}`);
    // Put the theme back through the dialog (attrs above were set manually).
    await openViaGear();
    await clickInSettings('SKEUO');
    await clickInSettings('LIGHT');
    await clickInSettings('Apply');
    await sleep(300);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const restoredAttrs = await page.evaluate(() => [
      document.documentElement.getAttribute('data-bf-theme'),
      document.documentElement.getAttribute('data-bf-mode'),
    ]);
    check(
      'theme survives reload (pre-paint restore)',
      restoredAttrs[0] === 'skeuomorph' && restoredAttrs[1] === 'light',
      JSON.stringify(restoredAttrs)
    );

    // Hex bytes/row setting reflows the Hex Inspector ruler (16 -> 32 cells)
    await openViaGear();
    await clickInSettings('APPEARANCE');
    await clickInSettings('32');
    await clickInSettings('Apply');
    await sleep(300);
    await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('hexInspector'));
    await sleep(800);
    const rulerCells = await page.evaluate(() => {
      const head = [...document.querySelectorAll('div')].find(
        (d) => d.className?.includes?.('h-[22px]') && d.textContent.includes('Offset')
      );
      return head ? head.children[1].querySelectorAll('span').length : -1;
    });
    check('hex bytes/row setting reflows inspector', rulerCells === 32, `cells=${rulerCells}`);

    // Tooltip kill switch: hover with tooltips OFF shows nothing, ON shows the surface
    await openViaGear();
    await clickInSettings('APPEARANCE');
    await clickInSettings('OFF'); // first OFF row is "Tooltips:"
    await clickInSettings('Apply');
    await sleep(300);
    await page.hover('button[title*="Application settings"]');
    await sleep(500);
    const tooltipOff = await page.evaluate(
      () => ![...document.querySelectorAll('div')].some((d) => d.className?.includes?.('pointer-events-none') && d.textContent.trim())
    );
    check('tooltip OFF silences overlay', tooltipOff);

    // Restore factory defaults and verify the blob matches them
    await openViaGear();
    await clickInSettings('Reset to defaults');
    await clickInSettings('Apply');
    await sleep(300);
    blob = JSON.parse(await page.evaluate(() => localStorage.getItem('bforge_settings_v1') || '{}'));
    check(
      'reset restores factory defaults',
      blob.timestampBase === 'wall' &&
        blob.hexBytesPerRow === 16 &&
        blob.tooltipsEnabled === true &&
        blob.maxPackets === 10000 &&
        blob.defaultExportFormat === 'pcapng' &&
        blob.theme === 'obsidian' &&
        blob.themeMode === 'dark',
      JSON.stringify(blob)
    );
  }

  // T13: named layout library — save the boot arrangement under a name from
  // the LAYOUTS & PANELS menu, load it on demand, star it as the startup
  // default (which must beat the session auto-save on the next boot), and
  // delete it via the two-click confirm.
  {
    const openLayoutsMenu = async () => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          b.textContent.includes('LAYOUTS & PANELS')
        );
        btn?.click();
      });
      await sleep(350);
    };
    const dockPanelIds = () =>
      page.evaluate(() =>
        (window.__bforgeDockApi?.panels ?? []).map((p) => p.id).sort().join(',')
      );

    // Save Current Layout… -> name it -> Enter. The input is pre-filled with
    // the last used name, so select-all before typing to replace it.
    await openLayoutsMenu();
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.includes('Save Current Layout')
      );
      btn?.click();
    });
    await sleep(250);
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'Layout name');
      input?.focus();
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('Smoke Layout');
    await page.keyboard.press('Enter');
    await sleep(700);
    let lib = await page.evaluate(() => JSON.parse(localStorage.getItem('bforge_layout_library_v1') || 'null'));
    check(
      'saving a named layout persists it to the library',
      !!lib?.layouts?.['Smoke Layout'],
      `layouts=${lib ? Object.keys(lib.layouts).join(',') : 'none'}`
    );

    // Load on demand: open a panel absent from the saved arrangement (MITM
    // bridge is not in the default CAD preset), then watch loading the saved
    // layout remove it again.
    await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('bridge'));
    await sleep(800);
    const withBridge = await dockPanelIds();
    await openLayoutsMenu();
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('button')].find((b) =>
        (b.getAttribute('title') || '').startsWith('Load “Smoke Layout”')
      );
      row?.click();
    });
    await sleep(800);
    const afterLoad = await dockPanelIds();
    check(
      'loading a saved layout restores its panel set on demand',
      withBridge.includes('bridge') && !afterLoad.includes('bridge'),
      `with=${withBridge} after=${afterLoad}`
    );

    // Star as startup default, dirty the session with the bridge again, then
    // reload: the auto-save now holds the bridge, so only the starred default
    // winning the boot proves the precedence chain.
    await openLayoutsMenu();
    await page.evaluate(() => {
      const star = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('title') === 'Load this layout on startup'
      );
      star?.click();
    });
    await sleep(300);
    lib = await page.evaluate(() => JSON.parse(localStorage.getItem('bforge_layout_library_v1') || 'null'));
    check(
      'saved layout can be starred as startup default',
      lib?.defaultLayout === 'Smoke Layout',
      `default=${String(lib?.defaultLayout)}`
    );

    await page.evaluate(() => window.__bforgeStore.getState().requestOpenPanel('bridge'));
    await sleep(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const afterBoot = await dockPanelIds();
    check(
      'default layout wins the next boot over the session auto-save',
      !afterBoot.includes('bridge') && afterBoot.includes('packetStream'),
      `boot=${afterBoot}`
    );

    // Two-click delete; deleting the starred layout must clear the default too.
    await openLayoutsMenu();
    await page.evaluate(() => {
      const trash = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('title') || '') === 'Delete layout'
      );
      trash?.click();
    });
    await sleep(250);
    await page.evaluate(() => {
      const armed = [...document.querySelectorAll('button')].find((b) =>
        (b.getAttribute('title') || '').startsWith('Click again to confirm')
      );
      armed?.click();
    });
    await sleep(400);
    lib = await page.evaluate(() => JSON.parse(localStorage.getItem('bforge_layout_library_v1') || 'null'));
    check(
      'two-click delete removes the layout and clears the default',
      !lib?.layouts?.['Smoke Layout'] && lib?.defaultLayout === null,
      `layouts=${lib ? Object.keys(lib.layouts).length : 0} default=${String(lib?.defaultLayout)}`
    );

    // Dismiss the menu so later checks start from a neutral surface.
    await page.mouse.click(5, 800);
    await sleep(200);
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
