# BaudForge High-Speed & Flexible Telemetry Plotting Architecture

Date: 2026-11-15  
Status: Implemented & Verified  
Scope: Unified zero-allocation `PlotEngine`, L1 mipmap `SampleRing`, real DSO trigger engine, memoized FFT, offscreen WebGL2 waveform blitter, and refactored `OscilloscopeView` + `PlotForgeView`.

---

## 1. Root-Cause Performance & Flexibility Audit (Previous Implementation)

### 1.1 Data Ingestion & Store Churn
- **Triple redundant storage**: Every incoming packet was stored in `useWorkstationStore.packets`, `useWorkstationStore.scopeSamples` (`ScopeSignalSample[]`, capped at `600`–`5,000`), `useWorkstationStore.traceSeries` (`Record<string, { tUs, value }[]>`), and `plotEngine.channels` (`SampleRing`).
- **Double-copy array slicing (`useWorkstationStore.ts`)**: `addPacket` and `addPacketBatch` ran `.slice(...)` followed by `[...slice, pkt]` or `.concat(...)` + `.slice(...)` on arrays up to `100,000` elements.
- **Repeated `O((1 + C) × F)` field scanning (`ui/src/plot/engine.ts`)**: `scanCatalog(pkt)` scanned every `dissectedFields` entry, and each of up to `32` registered channels called `extractFieldNumber` to re-scan `dissectedFields` and re-run regex parsing.
- **`meta:rate` shared-window bug & `O(W)` shift/sum (`ui/src/plot/engine.ts`)**: Mutated a shared `this.rateWindow` inside `pushChannel`, doubling computed byte rate when two `meta:rate` channels existed and calling `Array.shift()` + full summation on every packet.
- **Wheel-zoom `localStorage` thrashing (`usePlotStore.ts`, `PlotForgeView.tsx`)**: Every wheel tick triggered `localStorage.setItem('bforge_plot_cfg_v1', ...)` synchronously, recreated `renderCanvas`, and tore down/re-attached all 6 canvas DOM listeners.

### 1.2 Oscilloscope (`OscilloscopeView.tsx`) Bottlenecks & Rigidity
- **Unbounded full-buffer stroking**: `renderCanvas` iterated all `N_scope` samples (up to `5,000`) across CH1, CH2, MATH, and 3 logic rails without timestamp window culling or pixel-column decimation (up to `45,000` `lineTo` calls/frame = `2.7M` segments/sec at 60 FPS), plus per-frame `.filter(...)` allocations for `traceBindings`.
- **Duplicate `O(N²)` DFT**: Computed a 64-point naive `O(N²)` DFT in `stats` `useMemo` on every packet batch (even when `MATH` was turned off) and computed it a second time inside the 60 FPS `renderCanvas` loop.
- **Pointer hover & drag churn**: `handleMouseMove` allocated new `{ ch, marker }` objects on every pixel inside 8 px of a cursor, failing `Object.is` and re-rendering the entire React tree at pointer rate; drags mutated React state on every move.
- **Rigidity**: Hardcoded `CH1 = v_batt*` (centered at `7400 mV`) and `CH2 = gyro_z*`, non-functional `triggerMode` / `triggerSlope` (`AUTO`/`NORM` never phase-locked; `SINGLE` ignored thresholds), hardware-stubbed `[0, 0, 0]` logic flags, and colliding bound trace labels at `laneTop + 10`.

### 1.3 Plot Forge (`PlotForgeView.tsx`, `ui/src/plot/`) Bottlenecks & Limitations
- **Double `O(N)` window scan per frame**: `resolveAxisRange` called `plotEngine.getStats()` (Welford loop over up to `250,000` samples) and threw away `mean`/`stdDev`, immediately followed by `plotEngine.getSeries()` (`decimateMinMax`) scanning the identical `[lo, hi)` window.
- **Per-bucket heap garbage in `decimateMinMax`**: Allocated `[firstI, minI, maxI, lastI].sort(...)` + up to 4 `{ t, v }` objects per pixel bucket (`~576,000` array sorts/sec and `~2.3M` object allocations/sec across 8 channels at `1,200 px`, 60 FPS) while invoking `vAt(i)` 3× per inner sample.
- **60 FPS idle FFT/XY recomputation**: `drawFftChart` allocated 7 `Float64Array`s + 1 `number[]` sort + recomputed Hann/trig tables per channel at 60 FPS even when idle (`dataVersion` unchanged).
- **Functional gaps**: Single-chart tab lock, broken index-aligned XY mode (`subarray` ignoring timestamps), missing historical backfill for `expr` channels, missing `Y1`/`Y2` cursors and cursor `v(X)` readouts, missing array-element (`samples[0]`) and bitfield extraction, and no workstation cross-probing.

---

## 2. Architecture & Optimizations Implemented

### 2.1 Zero-Allocation Core DSP & Mipmap Rings (`ui/src/plot/`)
- **L1 Mipmap `SampleRing` (`rings.ts`)**: Maintains 64-sample physical-block aggregates (`RING_BLOCK_SIZE = 64`: `blockMin`, `blockMax`, `blockSum`, `blockSumSq`, `blockM2`, `blockDirty`) merged via Chan's parallel Welford formula in `statsInRange(lo, hi)`. Repeated window stat queries drop from `O(N)` to `O(N / 64)`. Added `resize(newCap)` avoiding intermediate `tailArrays` clones.
- **Zero-Allocation Decimation (`decimate.ts`)**: Cached `vFirst`/`minV`/`maxV`/`vLast` (1 `vAt` call per sample instead of 3) and replaced `[...].sort(...)` with branchless min/max index ordering. Added `decimateMinMaxInto(...)` writing `(t, v)` directly into pre-allocated `Float64Array` scratch buffers while returning exact window `[min, max]` in the same pass (eliminating the `getStats` + `getSeries` double scan and normalizing `-0` -> `0`).
- **Memoized Radix-2 FFT (`fft.ts`)**: Cached `hannWindow(n)` in `HANN_CACHE` and radix-2 butterfly twiddle tables in `TWIDDLE_CACHE`, supporting `'hann'` and `'rect'` windows.
- **Zero-Allocation Expression Evaluator (`expr.ts`)**: Added `PI`, `E`, `TAU` constants and `atan2`, `hypot`, `deg`, `rad`, `clamp` functions; specialized 0/1/2/3-arg closures to eliminate per-sample `args.map(...)` allocations.
- **Real Hardware-Style DSO Trigger (`trigger.ts`)**: Implemented `findTriggerCrossing(ring, cfg, tMinSearchUs, tMaxSearchUs)` for `AUTO` / `NORM` / `SINGLE` / `ROLL` and `RISING` / `FALLING` / `EITHER`, with `holdoffUs` enforcement and sub-sample linear interpolation (`t0 + frac * (t1 - t0)`).
- **Offscreen WebGL2 Waveform Renderer (`webglRenderer.ts`)**: Singleton offscreen WebGL2 context (`renderWaveformsWebGL`) performing relative `Float64` subtraction/normalization in JS before `Float32Array` VBO upload (`gl.bufferSubData` reuse) to avoid 24-bit mantissa stair-stepping on microsecond timestamps, optional phosphor persistence passes, and blitting onto the panel's single visible 2D `<canvas>` (`drawImage`), with automatic Canvas 2D fallback when WebGL2 is unavailable. Note: implementing this directly on top of `Float64Array` rings and WebGL2 avoided adding `uPlot` as a third-party dependency while preserving full custom DSO phosphor, triggering, FFT, XY, and cursor features.
- **Cached Palette (`palette.ts`)**: Cached theme palette keyed on `data-bf-theme|data-bf-mode` with `invalidatePlotPalette()`.
- **Unified Single-Pass `PlotEngine` (`engine.ts`)**:
  - Single-pass `scanCatalog(pkt)` populates reusable `pktValues` (`O(F + C)` extraction) including array elements (`samples[0..N]`), `bitmask` fields, `0b...` literals, and bitfields (`field.bit`).
  - Fixed `meta:rate` via single-update-per-packet `updateRateWindow` (`O(1)` amortized running byte sum).
  - Enabled historical backfill for `expr` channels (`backfillChannel`), added `getDataVersion()`, `getChannelRing()`, `getSeriesScratch()`, `getCachedSpectrum()`, and timestamp-aligned `getAlignedXy()` using interpolated two-pointer matching.

### 2.2 Rust Library Telemetry Module (`crates/bforge-core/src/telemetry.rs`)
- Added `TriggerSlope`, `TriggerMode`, `TriggerConfig`, `find_trigger_crossing`, `DecimatedBucket`, `WindowStats`, and single-pass `decimate_min_max` exported via `pub mod telemetry;` in `crates/bforge-core/src/lib.rs`, ready for backend trigger/decimation offload.

### 2.3 Store & UI Workbenches (`useWorkstationStore.ts`, `usePlotStore.ts`, `ProtocolDissector.tsx`, `OscilloscopeView.tsx`, `PlotForgeView.tsx`)
- **Stores & Cross-Bind**:
  - Single-allocation `appendBounded` / `concatBounded` helpers and real digital logic extraction (`extractLogicFlags` from `flags`/`status`/`gpio` fields or `TX`/error/fault status) in `useWorkstationStore.ts`.
  - Extended `usePlotStore.ts` with `layoutMode` (`'single' | 'stacked' | 'grid'`), `gpuAccel`, `ChartTriggerConfig`, `y1Cursor`/`y2Cursor`, `histSampleMode` (`'window' | 'tail'`), and 150ms debounced `setChartViewportFast`.
  - `ProtocolDissector.tsx` `Plot` button now binds to both `OscilloscopeView` (`bindScopeTrace`) and `PlotForgeView` (`usePlotStore.addChannel`).
- **`OscilloscopeView.tsx`**:
  - Any-field `CH1`/`CH2` dropdown selectors backed by deep `plotEngine` `SampleRing`s (`__scope_ch1`, `__scope_ch2`, `__scope_trace_*`), per-channel vertical center + `AUTOSET` button, working `AUTO`/`NORM`/`SINGLE`/`ROLL` trigger phase-locking, `OVERLAY`/`STACKED` lane toggle, `GPU`/`2D` renderer toggle, cached palette, ref-based drag/hover updates, dirty-flag `rAF` loop, binary-searched culling + `decimateMinMaxInto`, cached radix-2 FFT, and non-colliding bound trace labels.
- **`PlotForgeView.tsx`**:
  - `TAB` (`single`), `STACK` (`stacked`), and `GRID` (`grid`) multi-chart layouts on the single `<canvas>`, real-time `TRIG` popover (`findTriggerCrossing`), `X` and `X+Y` cursors with interpolated `v(X1)`/`v(X2)`/`Δv` readouts, interactive crosshairs in `TIME`/`FFT`/`XY`/`HIST`, `HIST` window vs tail modes, inline channel renaming, timestamp-aligned XY (`getAlignedXy`), workstation cross-probing (`seekToTimestamp` + playhead), dirty-flag `rAF` loop, and single-mount DOM event listeners with debounced `setChartViewportFast` wheel zoom.

---

## 3. Verification Results (Observed After Final Edit)

| Gate | Command | Result |
| :--- | :--- | :--- |
| Frontend Unit Tests | `cd ui && pnpm test` (`vitest run`) | **14/14** test files, **160/160** tests passed (`0` failed) |
| TypeScript & Bundle | `cd ui && pnpm exec tsc --noEmit && pnpm run build` | **0** TS errors; Vite built `2111` modules; synced to `target/release/ui` |
| End-to-End Smoke Gate | `node scripts/smoke-gate.mjs` (`chrome-headless-shell`) | **40/40** checks passed |
| Rust Format & Clippy | `cargo fmt --all --check` & `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed, **0** warnings |
| Rust Workspace Tests | `cargo test --workspace --locked` | **26** test targets, **379/379** tests passed (including `8/8` in `bforge_core::telemetry::tests`) |
