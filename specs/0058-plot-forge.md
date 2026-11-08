# 0058 — Plot Forge: Advanced Plotting Engine Panel

Status: shipped (2026-11-09) — panel `plotForge`, commits 468fc40 → Phase 6.
Companion: `specs/0020-telemetry-series.md` (engine-side rings this work complements UI-side).

## 1. Purpose

A general-purpose plotting engine as a dockable panel (Bottom-Left Subdeck tab, next to the
Oscilloscope): plot **any** numeric signal flowing through the workstation — decoded struct
fields, packet metrics, derived expressions — across multiple chart tabs with measurement
cursors, zoom/pan, FFT / XY / histogram modes and CSV/PNG export.

Unlike the fixed-channel Oscilloscope (CH1/CH2/MATH), Plot Forge has no hardcoded channels:
every channel is user-defined and fed from the rolling packet stream.

## 2. Architecture

```
useWorkstationStore.packets ──subscribe──► PlotEngine (non-reactive, ui/src/plot/engine.ts)
   dissectedFields  │                        per-channel Float64 rings (tUs, value)
   seqId deltas     │                        field catalog (name → unit/count)
                    │                        expr evaluation (hold-last)
usePlotStore (Zustand, config only) ──────► PlotForgeView (Canvas2D, rAF painter)
   charts / channels / cursors / view state     reads rings imperatively; re-renders only
   persisted: bforge_plot_cfg_v1 (versioned)    on config changes + 2 Hz stats tick
```

- **Data never flows through Zustand.** Rings live outside the reactive tree (repo hot-path
  convention); the painter reads them inside `requestAnimationFrame` — the Oscilloscope
  pattern — so a 20 Hz+ stream costs zero React re-renders.
- **Engine is store-agnostic**: `main.tsx` wires `plotEngine.start({ getSourcePackets, subscribe })`
  before first render so history accumulates while the panel is closed. Tests drive
  `ingestPackets()`/`ensureChannel()` directly.
- **Feed semantics per packet, in order**: catalog scan → non-expr channels → expr channels
  (hold-last, scope-MATH style). New packets are found by monotonic `seqId` deltas;
  `clearStream()` wipes ring data but keeps channel definitions.
- **Backfill**: adding a field/meta channel mid-session replays the reactive packet buffer
  (≤ `maxPackets`) so the plot appears instantly. Expr channels deliberately do not backfill
  (historical refs would need per-packet historical values, not hold-last).

## 3. Channel sources

| Kind | Source | Unit |
|---|---|---|
| `field` | dissected field by exact name (native number, else regex from `decodedValue`) | field's `unit` |
| `meta:length` | frame length | B |
| `meta:delta` | inter-arrival µs | µs |
| `meta:rate` | byte throughput over a sliding 1 s window | B/s |
| `expr` | safe expression over other channels' **labels** (`+ - * / % ^`, parens, abs/min/max/sqrt/sin/cos/tan/log*/ln/exp/floor/ceil/round/sign; no `eval`) | — |

Caps: 32 channels app-wide (`MAX_ENGINE_CHANNELS`, mirrors the engine's `SeriesSet`), 16 per
chart, 12 charts, ring depth 1k–250k points/channel (default 60k, persisted).

## 4. Chart modes

- **TIME** — min-max decimated polylines (envelope-preserving, bucket-per-pixel), dual Y axes
  (Y1 left / Y2 right) with autoscale or manual range, 1-2-5 X-span presets, LIVE head-follow
  or frozen window.
- **FFT** — radix-2 iterative Cooley–Tukey + Hann window, detrended (DC otherwise leaks into
  bin 1), coherent-gain compensated single-sided spectrum; dB or linear; newest 256–2048
  samples; sample rate from the median Δt; peak frequency marker per channel (DC excluded).
  Replaces nothing — the scope keeps its 64-point naive DFT; this runs 2048-point windows.
- **XY** — channel vs channel, index-aligned from the newest 5 000 samples, LTTB-decimated
  above 2 000 points, scatter dots ≤ 800 pairs.
- **HIST** — amplitude histogram of one channel over the newest `fftSize` samples,
  4–256 bins.

## 5. Interactions (TIME mode)

`wheel` zoom X about cursor · `Ctrl+wheel` zoom Y under cursor (sets manual range) ·
`drag` pan (freezes a LIVE chart) · `Shift+drag` box zoom · drag `X1`/`X2` cursors (Δt +
1/Δt readout) · `double-click` reset Y autoscale · `FIT` full-extent. Crosshair tooltip shows
the nearest sample per channel (`sampleNearest`, tolerance = 25 px-width in µs).
Drag gestures mutate local refs and commit to the store **on release** — no 60 Hz
localStorage spam. The rAF loop idles when frozen (scope RUN/STOP idle-out pattern).

## 6. Export

- **CSV** (TIME mode): raw window samples of the first visible channel as the master
  timeline (≤100k rows), other channels aligned by nearest sample within 1.5× median Δt.
- **PNG**: `canvas.toBlob` of the painted chart.
- Both use an anchor download with an honest toast. In the desktop shell anchor downloads
  are unreliable (see the vault-export lesson, `CONVERSATION_CONTEXT.md` §4.5) — a native
  save dialog command is the noted follow-up.

## 7. Persistence

`bforge_plot_cfg_v1` — `{ version: 1, charts, activeChartId, cursors, plotDepth }`, merged
through `mergePlotConfig()` (every field type/enum/clamp validated; corrupt blobs fall back
to one default chart). Panel reset via `resetPanel()`.

## 8. Test handles & verification

- `(window).__bforgePlotStore` / `(window).__bforgePlotEngine` — smoke handles (mirror `__bforgeStore`).
- `pnpm test`: `ui/src/plot/*.test.ts` (rings, decimation, FFT vs direct DFT, expression
  parser incl. no-globals check), `engine.test.ts` (feed, backfill, rebuild-on-source-change,
  depth resize, stats, store-wiring incl. clearStream), `usePlotStore.test.ts` (actions,
  validation, rehydration).
- `pnpm smoke` T14: panel opens via `requestOpenPanel('plotForge')`, two channels added
  through the plot store, sim stream fills both tails, canvas paints, config reset after.

## 9. Future work (deliberately out of scope)

- Vault replay plotting: `/api/vault/frames` returns the same `TailRow` shape with
  `value_num`; a "REPLAY" data source feeding `ingestPackets()` would plot recorded sessions.
- Engine `series` SSE event (`SeriesUpdate` deltas, 200 ms tick) as a lightweight source —
  the UI still does not subscribe.
- Desktop-native PNG/CSV save dialog (Tauri command, `pick_vault` dialog pattern).
- Split-view / grid layouts inside the panel.
