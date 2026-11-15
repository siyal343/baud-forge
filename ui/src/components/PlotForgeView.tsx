import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Eye, EyeOff, Minus, Pause, Pencil, Play, Plus, X, Zap } from 'lucide-react';
import {
  usePlotStore,
  SPAN_MIN_US,
  SPAN_MAX_US,
  FFT_SIZES,
  HIST_BINS_MIN,
  HIST_BINS_MAX,
  makeDefaultTrigger,
  type ChartConfig,
  type ChartTriggerConfig,
  type PlotLayoutMode,
} from '../store/usePlotStore';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useShallow } from 'zustand/react/shallow';
import { plotEngine, PLOT_DEPTH_MAX, PLOT_DEPTH_MIN, type CachedSpectrum } from '../plot/engine';
import type { SampleRing } from '../plot/rings';
import { findTriggerCrossing } from '../plot/trigger';
import { renderWaveformsWebGL, type WebGLTrace } from '../plot/webglRenderer';
import { plotPalette, invalidatePlotPalette, type PlotPalette } from '../plot/palette';
import { compileExpr, EXPR_CONSTS, EXPR_FUNCS } from '../plot/expr';
import type { ChannelDef, CursorPair } from '../plot/types';
import type { PacketRow } from '../types';
import { toast } from '../store/useToastStore';

/**
 * Plot Forge — high-speed plotting engine panel.
 *
 * Renders single (TAB), stacked (STACK), or 2-column grid (GRID) charts onto
 * a single <canvas>. Sample data is read imperatively inside the dirty-flag
 * rAF loop using zero-allocation engine queries (`getSeriesScratch`,
 * `getCachedSpectrum`, `getAlignedXy`, mipmap `getStats`) and optional WebGL2
 * waveform acceleration with automatic Canvas 2D fallback.
 *
 * Modes: TIME (trigger, X/Y cursors, crosshair, pan/zoom, click-to-seek),
 *        FFT (cached radix-2 spectrum + bin crosshair),
 *        XY (timestamp-aligned XY + sample crosshair),
 *        HIST (window/tail amplitude histogram + bin crosshair).
 */

const SPAN_PRESETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 600000];

const stepSpan = (currentUs: number, dir: 1 | -1): number => {
  const currentMs = currentUs / 1000;
  let idx = SPAN_PRESETS_MS.findIndex((v) => v >= currentMs);
  if (idx === -1) idx = SPAN_PRESETS_MS.length - 1;
  idx = Math.min(SPAN_PRESETS_MS.length - 1, Math.max(0, idx + dir));
  return SPAN_PRESETS_MS[idx] * 1000;
};

const fmtSpan = (us: number): string => {
  const ms = us / 1000;
  if (ms >= 1000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
  return `${ms.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;
};

const fmtValue = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
};

const fmtTimeUs = (tUs: number): string => {
  const a = Math.abs(tUs);
  if (a >= 60e6) return `${(tUs / 60e6).toFixed(2)} m`;
  if (a >= 1e6) return `${(tUs / 1e6).toFixed(2)} s`;
  if (a >= 1e3) return `${(tUs / 1e3).toFixed(1)} ms`;
  return `${tUs.toFixed(0)} µs`;
};

const fmtFreq = (hz: number): string => {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
  return `${hz.toFixed(1)} Hz`;
};

const ribbonBtn =
  'flex items-center gap-1 px-1.5 py-0.5 rounded border border-bf-line bg-bf-panel text-bf-body hover:bg-bf-btn hover:border-bf-line-strong disabled:opacity-40 disabled:cursor-not-allowed';
const ribbonActive =
  'flex items-center gap-1 px-1.5 py-0.5 rounded border bg-bf-btn-hi text-bf-bright border-bf-cyan';

const MONO = '10px "JetBrains Mono", monospace';
const MONO_BOLD = 'bold 10px "JetBrains Mono", monospace';
const PANE_HEAD_H = 18;
const MAX_XY_POINTS = 5000;

// Reusable scratch buffers for histogram counts and WebGL trace packing.
const histCountsScratch = new Int32Array(HIST_BINS_MAX);
const webglTracesScratch: WebGLTrace[] = [];

// ---------------------------------------------------------------------------
// View-window, sampling & axis helpers
// ---------------------------------------------------------------------------

interface ViewWindow {
  tMinUs: number;
  tMaxUs: number;
}

interface AxisRange {
  min: number;
  max: number;
}

interface Margins {
  l: number;
  r: number;
  t: number;
  b: number;
}

interface TriggerRunState {
  triggered: boolean;
  waiting: boolean;
  anchorUs: number | null;
}

interface SubViewport {
  chart: ChartConfig;
  x: number;
  y: number;
  w: number;
  h: number;
  headH: number;
  mg: Margins;
  absMg: Margins;
  plotW: number;
  plotH: number;
  hasY2: boolean;
  yCursorAxis: 'y1' | 'y2';
  win: ViewWindow | null;
  trigState: TriggerRunState | null;
  y1: AxisRange;
  y2: AxisRange;
}

const marginsForPane = (hasY2: boolean, headH: number): Margins => ({
  l: 50,
  r: hasY2 ? 50 : 12,
  t: headH + 10,
  b: 20,
});

/**
 * Binary-search + linear-interpolate sample value at `tUs` on a SampleRing.
 * Returns null if `ring` is empty or `tUs` lies outside `[tMin, tMax]`.
 */
const sampleAtTime = (ring: SampleRing | undefined, tUs: number): number | null => {
  if (!ring || ring.length === 0 || !Number.isFinite(tUs)) return null;
  const firstT = ring.tAt(0);
  const lastT = ring.tAt(ring.length - 1);
  if (tUs < firstT || tUs > lastT) return null;
  const idx = ring.lowerBound(tUs);
  if (idx === 0) return ring.tAt(0) === tUs ? ring.vAt(0) : null;
  if (idx >= ring.length) return null;
  const t1 = ring.tAt(idx);
  const v1 = ring.vAt(idx);
  if (t1 === tUs) return Number.isFinite(v1) ? v1 : null;
  const t0 = ring.tAt(idx - 1);
  const v0 = ring.vAt(idx - 1);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
  if (t1 <= t0) return v1;
  return v0 + ((tUs - t0) / (t1 - t0)) * (v1 - v0);
};

const finalizeAxisRange = (
  minIn: number,
  maxIn: number,
  manualMin: number | null,
  manualMax: number | null
): AxisRange => {
  if (manualMin !== null && manualMax !== null && manualMax > manualMin) {
    return { min: manualMin, max: manualMax };
  }
  let min = minIn;
  let max = maxIn;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (manualMin !== null) min = manualMin;
  if (manualMax !== null) max = manualMax;
  if (max < min) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  if (max === min) {
    const pad = Math.max(1e-9, Math.abs(max) * 0.5);
    min -= pad;
    max += pad;
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
};

const resolveAxisRangeStats = (chart: ChartConfig, axis: 'y1' | 'y2', win: ViewWindow): AxisRange => {
  const manualMin = axis === 'y1' ? chart.y1Min : chart.y2Min;
  const manualMax = axis === 'y1' ? chart.y1Max : chart.y2Max;
  if (manualMin !== null && manualMax !== null && manualMax > manualMin) {
    return { min: manualMin, max: manualMax };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const ch of chart.channels) {
    if (!ch.visible || ch.axis !== axis) continue;
    const stats = plotEngine.getStats(ch.id, win.tMinUs, win.tMaxUs);
    if (!stats) continue;
    if (stats.min < min) min = stats.min;
    if (stats.max > max) max = stats.max;
  }
  return finalizeAxisRange(min, max, manualMin, manualMax);
};

const resolveBaseWindow = (chart: ChartConfig): ViewWindow => {
  if (!chart.live && chart.frozen) {
    return { tMinUs: chart.frozen.tMinUs, tMaxUs: chart.frozen.tMaxUs };
  }
  const extent = plotEngine.getDataExtent();
  const head = extent ? extent.tMaxUs : 0;
  return { tMinUs: head - chart.spanUs, tMaxUs: head === 0 ? chart.spanUs : head };
};

const computeSubViewportShells = (
  charts: ChartConfig[],
  activeChartId: string,
  layoutMode: PlotLayoutMode,
  W: number,
  H: number
): SubViewport[] => {
  const active = charts.find((c) => c.id === activeChartId) ?? charts[0];
  if (!active) return [];

  if (layoutMode === 'single') {
    const hasY2 = active.channels.some((c) => c.visible && c.axis === 'y2');
    const hasY1 = active.channels.some((c) => c.visible && c.axis === 'y1');
    const mg = marginsForPane(hasY2, 0);
    return [
      {
        chart: active,
        x: 0,
        y: 0,
        w: W,
        h: H,
        headH: 0,
        mg,
        absMg: mg,
        plotW: Math.max(10, W - mg.l - mg.r),
        plotH: Math.max(10, H - mg.t - mg.b),
        hasY2,
        yCursorAxis: hasY1 || !hasY2 ? 'y1' : 'y2',
        win: null,
        trigState: null,
        y1: { min: 0, max: 1 },
        y2: { min: 0, max: 1 },
      },
    ];
  }

  const headH = PANE_HEAD_H;
  const count = charts.length;
  const cols = layoutMode === 'grid' && count > 1 ? 2 : 1;
  const rows = Math.ceil(count / cols);
  const cellW = W / cols;
  const cellH = H / rows;

  return charts.map((c, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = Math.round(col * cellW);
    const y = Math.round(row * cellH);
    const nextX = col === cols - 1 ? Math.round(W) : Math.round((col + 1) * cellW);
    const nextY = row === rows - 1 ? Math.round(H) : Math.round((row + 1) * cellH);
    const w = Math.max(20, nextX - x);
    const h = Math.max(20, nextY - y);
    const hasY2 = c.channels.some((ch) => ch.visible && ch.axis === 'y2');
    const hasY1 = c.channels.some((ch) => ch.visible && ch.axis === 'y1');
    const mg = marginsForPane(hasY2, headH);
    return {
      chart: c,
      x,
      y,
      w,
      h,
      headH,
      mg,
      absMg: { l: x + mg.l, r: mg.r, t: y + mg.t, b: mg.b },
      plotW: Math.max(10, w - mg.l - mg.r),
      plotH: Math.max(10, h - mg.t - mg.b),
      hasY2,
      yCursorAxis: hasY1 || !hasY2 ? 'y1' : 'y2',
      win: null,
      trigState: null,
      y1: { min: 0, max: 1 },
      y2: { min: 0, max: 1 },
    };
  });
};

// ---------------------------------------------------------------------------
// Canvas theme-safe box + tooltip helpers
// ---------------------------------------------------------------------------

const fillAlphaPanel = (
  ctx: CanvasRenderingContext2D,
  pal: PlotPalette,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 0.9
): void => {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pal.canvas;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
};

interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

const drawTooltipRows = (
  ctx: CanvasRenderingContext2D,
  pal: PlotPalette,
  absMg: Margins,
  plotW: number,
  plotH: number,
  anchorX: number,
  anchorY: number,
  rows: TooltipRow[]
): void => {
  if (rows.length === 0) return;
  ctx.font = MONO;
  let maxRowW = 96;
  for (let i = 0; i < rows.length; i++) {
    const w = ctx.measureText(`${rows[i].label}  ${rows[i].value}`).width;
    if (w > maxRowW) maxRowW = w;
  }
  const boxW = maxRowW + 14;
  const rowH = 15;
  const boxH = rows.length * rowH + 6;
  let bx = anchorX + 12;
  let by = anchorY + 12;
  if (bx + boxW > absMg.l + plotW) bx = anchorX - boxW - 12;
  if (by + boxH > absMg.t + plotH) by = anchorY - boxH - 12;
  if (bx < absMg.l + 2) bx = absMg.l + 2;
  if (by < absMg.t + 2) by = absMg.t + 2;

  fillAlphaPanel(ctx, pal, bx, by, boxW, boxH, 0.92);
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

  ctx.textBaseline = 'middle';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ry = by + 4 + i * rowH + rowH / 2 - 1;
    ctx.fillStyle = r.color;
    ctx.textAlign = 'left';
    ctx.fillText(r.label, bx + 6, ry);
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'right';
    ctx.fillText(r.value, bx + boxW - 6, ry);
  }
};

// ---------------------------------------------------------------------------
// Non-time mode painters (FFT / XY / HIST) with interactive crosshairs
// ---------------------------------------------------------------------------

interface ModePaintCtx {
  ctx: CanvasRenderingContext2D;
  pal: PlotPalette;
  absMg: Margins;
  plotW: number;
  plotH: number;
  chart: ChartConfig;
  hover: { x: number; y: number } | null;
  fftWindow: 'hann' | 'rect';
  gpuAccel: boolean;
  dpr: number;
  win: ViewWindow | null;
}

const drawGrid = (
  ctx: CanvasRenderingContext2D,
  pal: PlotPalette,
  absMg: Margins,
  plotW: number,
  plotH: number
): void => {
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.gridMinor;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  for (let c = 1; c < 10; c++) {
    const x = Math.round(absMg.l + (plotW * c) / 10) + 0.5;
    ctx.moveTo(x, absMg.t);
    ctx.lineTo(x, absMg.t + plotH);
  }
  for (let r = 1; r < 8; r++) {
    const y = Math.round(absMg.t + (plotH * r) / 8) + 0.5;
    ctx.moveTo(absMg.l, y);
    ctx.lineTo(absMg.l + plotW, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = pal.grid;
  ctx.strokeRect(absMg.l + 0.5, absMg.t + 0.5, plotW - 1, plotH - 1);
};

const drawHint = (p: Pick<ModePaintCtx, 'ctx' | 'pal' | 'absMg' | 'plotW' | 'plotH'>, text: string): void => {
  const { ctx, pal, absMg, plotW, plotH } = p;
  ctx.fillStyle = pal.textFaint;
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, absMg.l + plotW / 2, absMg.t + plotH / 2);
};

const drawFftChart = (p: ModePaintCtx): void => {
  const { ctx, pal, absMg, plotW, plotH, chart, hover, fftWindow } = p;
  const chs = chart.channels.filter((c) => c.visible).slice(0, 4);
  const spectra: Array<{ ch: ChannelDef; spec: CachedSpectrum }> = [];
  for (const ch of chs) {
    const ring = plotEngine.getChannelRing(ch.id);
    if (!ring || ring.length < 16) continue;
    const spec = plotEngine.getCachedSpectrum(ch.id, chart.fftSize, fftWindow);
    if (spec && spec.freqHz.length >= 2) spectra.push({ ch, spec });
  }

  if (spectra.length === 0) {
    drawHint(p, 'AWAITING DATA… (FFT needs ≥16 samples per channel)');
    return;
  }

  let lo = Infinity;
  let hi = -Infinity;
  let nyq = 1;
  for (const s of spectra) {
    const arr = chart.fftDb ? s.spec.db : s.spec.mag;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const chNyq = s.spec.freqHz[s.spec.freqHz.length - 1] || 1;
    if (chNyq > nyq) nyq = chNyq;
  }
  if (hi - lo < 1e-9) hi = lo + 1;
  lo -= (hi - lo) * 0.06;
  hi += (hi - lo) * 0.06;
  const xOf = (hz: number) => absMg.l + (hz / nyq) * plotW;
  const yOf = (v: number) => absMg.t + plotH - ((v - lo) / (hi - lo)) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let c = 0; c <= 10; c += 2) {
    ctx.fillText(fmtFreq((nyq * c) / 10), absMg.l + (plotW * c) / 10, absMg.t + plotH + 3);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const v = hi - ((hi - lo) * r) / 8;
    ctx.fillText(`${fmtValue(v)}${chart.fftDb ? ' dB' : ''}`, absMg.l - 4, absMg.t + (plotH * r) / 8);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(absMg.l, absMg.t, plotW, plotH);
  ctx.clip();

  for (const s of spectra) {
    const arr = chart.fftDb ? s.spec.db : s.spec.mag;
    const bins = arr.length;
    const stride = Math.max(1, Math.floor(bins / Math.max(10, plotW)));
    ctx.strokeStyle = s.ch.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < bins; k += stride) {
      const x = xOf(s.spec.freqHz[k]);
      const y = yOf(arr[k]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    if (s.spec.peakHz > 0 && s.spec.peakDb > -199.9) {
      const px = xOf(s.spec.peakHz);
      const pv = chart.fftDb ? s.spec.peakDb : Math.pow(10, s.spec.peakDb / 20);
      const py = yOf(Math.min(hi, Math.max(lo, pv)));
      ctx.fillStyle = s.ch.color;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = MONO;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${fmtFreq(s.spec.peakHz)} (${fmtValue(pv)}${chart.fftDb ? ' dB' : ''})`, px + 4, py - 2);
    }
  }
  ctx.restore();

  // Interactive FFT crosshair + nearest-bin readout
  if (
    hover &&
    hover.x >= absMg.l &&
    hover.x <= absMg.l + plotW &&
    hover.y >= absMg.t &&
    hover.y <= absMg.t + plotH
  ) {
    const fHover = ((hover.x - absMg.l) / plotW) * nyq;
    ctx.strokeStyle = pal.textFaint;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(hover.x) + 0.5, absMg.t);
    ctx.lineTo(Math.round(hover.x) + 0.5, absMg.t + plotH);
    ctx.moveTo(absMg.l, Math.round(hover.y) + 0.5);
    ctx.lineTo(absMg.l + plotW, Math.round(hover.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const rows: TooltipRow[] = [{ label: 'f', value: fmtFreq(fHover), color: pal.textDim }];
    for (const s of spectra) {
      const bins = s.spec.freqHz.length;
      const chNyq = s.spec.freqHz[bins - 1] || nyq;
      const k = Math.min(bins - 1, Math.max(0, Math.round((fHover / chNyq) * (bins - 1))));
      const fBin = s.spec.freqHz[k];
      const val = chart.fftDb ? s.spec.db[k] : s.spec.mag[k];
      const sx = xOf(fBin);
      const sy = yOf(val);
      if (sx >= absMg.l && sx <= absMg.l + plotW) {
        ctx.fillStyle = s.ch.color;
        ctx.beginPath();
        ctx.arc(sx, Math.min(absMg.t + plotH, Math.max(absMg.t, sy)), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      rows.push({
        label: s.ch.label,
        value: `${fmtValue(val)}${chart.fftDb ? ' dB' : ''} @ ${fmtFreq(fBin)}`,
        color: s.ch.color,
      });
    }
    drawTooltipRows(ctx, pal, absMg, plotW, plotH, hover.x, hover.y, rows);
  }
};

const drawXyChart = (p: ModePaintCtx): void => {
  const { ctx, pal, absMg, plotW, plotH, chart, hover, gpuAccel, dpr } = p;
  const xCh =
    chart.channels.find((c) => c.id === chart.xyXChannelId) ??
    chart.channels.find((c) => c.visible) ??
    null;
  const yChs = chart.channels.filter((c) => c.visible && (!xCh || c.id !== xCh.id));
  if (!xCh || yChs.length === 0) {
    drawHint(p, 'XY NEEDS AN X CHANNEL + AT LEAST ONE OTHER VISIBLE CHANNEL');
    return;
  }

  // Note: plotEngine.getAlignedXy shares xyScratchX/xyScratchY across calls.
  // Fast path for single-Y uses 1 call (zero extra passes); multi-Y computes global
  // bounds in pass 1 then strokes in pass 2 with zero heap allocations.
  let xLo = Infinity;
  let xHi = -Infinity;
  let yLo = Infinity;
  let yHi = -Infinity;
  let validCount = 0;

  let singleAligned: { xs: Float64Array; ys: Float64Array; count: number } | null = null;
  for (let yi = 0; yi < yChs.length; yi++) {
    const aligned = plotEngine.getAlignedXy(xCh.id, yChs[yi].id, MAX_XY_POINTS);
    if (aligned.count < 2) continue;
    validCount++;
    if (yChs.length === 1) singleAligned = aligned;
    for (let i = 0; i < aligned.count; i++) {
      const xv = aligned.xs[i];
      const yv = aligned.ys[i];
      if (xv < xLo) xLo = xv;
      if (xv > xHi) xHi = xv;
      if (yv < yLo) yLo = yv;
      if (yv > yHi) yHi = yv;
    }
  }

  if (validCount === 0 || !Number.isFinite(xLo) || !Number.isFinite(yLo)) {
    drawHint(p, 'AWAITING OVERLAPPING DATA…');
    return;
  }

  if (xHi === xLo) {
    const d = Math.max(1e-9, Math.abs(xLo) * 0.5);
    xLo -= d;
    xHi += d;
  }
  if (yHi === yLo) {
    const d = Math.max(1e-9, Math.abs(yLo) * 0.5);
    yLo -= d;
    yHi += d;
  }
  const xPad = (xHi - xLo) * 0.06;
  const yPad = (yHi - yLo) * 0.06;
  const xMin = xLo - xPad;
  const xMax = xHi + xPad;
  const yMin = yLo - yPad;
  const yMax = yHi + yPad;
  const xOf = (v: number) => absMg.l + ((v - xMin) / (xMax - xMin)) * plotW;
  const yOf = (v: number) => absMg.t + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const v = yMax - ((yMax - yMin) * r) / 8;
    ctx.fillText(fmtValue(v), absMg.l - 4, absMg.t + (plotH * r) / 8);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let c = 0; c <= 10; c += 2) {
    const v = xMin + ((xMax - xMin) * c) / 10;
    ctx.fillText(fmtValue(v), absMg.l + (plotW * c) / 10, absMg.t + plotH + 3);
  }
  ctx.fillStyle = pal.textDim;
  ctx.textAlign = 'right';
  ctx.fillText(`${xCh.label}${xCh.unit ? ` (${xCh.unit})` : ''} →`, absMg.l + plotW, absMg.t + plotH + 3);

  const hoverInside =
    hover !== null &&
    hover.x >= absMg.l &&
    hover.x <= absMg.l + plotW &&
    hover.y >= absMg.t &&
    hover.y <= absMg.t + plotH;

  let bestDistSq = 28 * 28;
  let bestPt: { ch: ChannelDef; xv: number; yv: number; sx: number; sy: number } | null = null;

  // WebGL2 path for single-Y aligned XY (zero copies)
  let drewSingleWithGpu = false;
  if (gpuAccel && singleAligned) {
    webglTracesScratch.length = 0;
    webglTracesScratch.push({
      t: singleAligned.xs,
      v: singleAligned.ys,
      count: singleAligned.count,
      xMin,
      xMax,
      yMin,
      yMax,
      color: yChs[0].color,
      lineWidth: 1.3,
    });
    drewSingleWithGpu = renderWaveformsWebGL(
      ctx,
      { x: absMg.l, y: absMg.t, w: plotW, h: plotH, dpr, phosphor: true },
      webglTracesScratch
    );
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(absMg.l, absMg.t, plotW, plotH);
  ctx.clip();

  for (let yi = 0; yi < yChs.length; yi++) {
    const yCh = yChs[yi];
    const aligned =
      singleAligned && yi === 0 ? singleAligned : plotEngine.getAlignedXy(xCh.id, yCh.id, MAX_XY_POINTS);
    const n = aligned.count;
    if (n < 2) continue;

    if (!drewSingleWithGpu) {
      ctx.strokeStyle = yCh.color;
      ctx.fillStyle = yCh.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const xv = aligned.xs[i];
        const yv = aligned.ys[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
          started = false;
          continue;
        }
        const sx = xOf(xv);
        const sy = yOf(yv);
        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.stroke();
      if (n <= 800) {
        for (let i = 0; i < n; i++) {
          const xv = aligned.xs[i];
          const yv = aligned.ys[i];
          if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
          ctx.fillRect(xOf(xv) - 1, yOf(yv) - 1, 2, 2);
        }
      }
    }

    // Highlight newest sample position on XY phase plane
    if (Number.isFinite(aligned.xs[n - 1]) && Number.isFinite(aligned.ys[n - 1])) {
      const hx = xOf(aligned.xs[n - 1]);
      const hy = yOf(aligned.ys[n - 1]);
      ctx.fillStyle = yCh.color;
      ctx.beginPath();
      ctx.arc(hx, hy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hoverInside && hover) {
      for (let i = 0; i < n; i++) {
        const xv = aligned.xs[i];
        const yv = aligned.ys[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        const sx = xOf(xv);
        const sy = yOf(yv);
        const dx = sx - hover.x;
        const dy = sy - hover.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestPt = { ch: yCh, xv, yv, sx, sy };
        }
      }
    }
  }
  ctx.restore();

  if (hoverInside && hover) {
    const cx = bestPt ? bestPt.sx : hover.x;
    const cy = bestPt ? bestPt.sy : hover.y;
    ctx.strokeStyle = pal.textFaint;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, absMg.t);
    ctx.lineTo(Math.round(cx) + 0.5, absMg.t + plotH);
    ctx.moveTo(absMg.l, Math.round(cy) + 0.5);
    ctx.lineTo(absMg.l + plotW, Math.round(cy) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (bestPt) {
      ctx.strokeStyle = bestPt.ch.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bestPt.sx, bestPt.sy, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      drawTooltipRows(ctx, pal, absMg, plotW, plotH, bestPt.sx, bestPt.sy, [
        {
          label: xCh.label,
          value: `${fmtValue(bestPt.xv)}${xCh.unit ? ` ${xCh.unit}` : ''}`,
          color: pal.textDim,
        },
        {
          label: bestPt.ch.label,
          value: `${fmtValue(bestPt.yv)}${bestPt.ch.unit ? ` ${bestPt.ch.unit}` : ''}`,
          color: bestPt.ch.color,
        },
      ]);
    } else {
      const xVal = xMin + ((hover.x - absMg.l) / plotW) * (xMax - xMin);
      const yVal = yMax - ((hover.y - absMg.t) / plotH) * (yMax - yMin);
      drawTooltipRows(ctx, pal, absMg, plotW, plotH, hover.x, hover.y, [
        { label: xCh.label, value: fmtValue(xVal), color: pal.textDim },
        { label: 'Y', value: fmtValue(yVal), color: pal.text },
      ]);
    }
  }
};

const drawHistChart = (p: ModePaintCtx): void => {
  const { ctx, pal, absMg, plotW, plotH, chart, hover, win } = p;
  const src =
    chart.channels.find((c) => c.id === chart.histChannelId) ??
    chart.channels.find((c) => c.visible) ??
    null;
  if (!src) {
    drawHint(p, 'HIST NEEDS A SOURCE CHANNEL');
    return;
  }

  const sampleMode = chart.histSampleMode ?? 'window';
  const bins = Math.min(HIST_BINS_MAX, Math.max(HIST_BINS_MIN, chart.histBins));
  histCountsScratch.fill(0, 0, bins);

  let lo = Infinity;
  let hi = -Infinity;
  let totalSamples = 0;

  if (sampleMode === 'tail') {
    const tail = plotEngine.getTail(src.id, chart.fftSize);
    const n = tail.v.length;
    if (n < 2) {
      drawHint(p, 'AWAITING DATA…');
      return;
    }
    for (let i = 0; i < n; i++) {
      const v = tail.v[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi === lo) hi = lo + 1e-9;
    const bw = (hi - lo) / bins;
    for (let i = 0; i < n; i++) {
      let b = Math.floor((tail.v[i] - lo) / bw);
      if (b >= bins) b = bins - 1;
      if (b < 0) b = 0;
      histCountsScratch[b]++;
    }
    totalSamples = n;
  } else {
    const ring = plotEngine.getChannelRing(src.id);
    if (!ring || !win || ring.length < 2) {
      drawHint(p, 'AWAITING DATA…');
      return;
    }
    const range = ring.rangeFor(win.tMinUs, win.tMaxUs);
    const count = range.hi - range.lo;
    if (count < 2) {
      drawHint(p, 'AWAITING WINDOW DATA…');
      return;
    }
    const stats = ring.statsInRange(range.lo, range.hi);
    lo = stats.min;
    hi = stats.max;
    if (hi === lo) hi = lo + 1e-9;
    const bw = (hi - lo) / bins;
    for (let i = range.lo; i < range.hi; i++) {
      let b = Math.floor((ring.vAt(i) - lo) / bw);
      if (b >= bins) b = bins - 1;
      if (b < 0) b = 0;
      histCountsScratch[b]++;
    }
    totalSamples = count;
  }

  let maxCount = 1;
  for (let b = 0; b < bins; b++) {
    if (histCountsScratch[b] > maxCount) maxCount = histCountsScratch[b];
  }
  const yOf = (c: number) => absMg.t + plotH - (c / maxCount) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const c = Math.round((maxCount * r) / 8);
    ctx.fillText(String(c), absMg.l - 4, absMg.t + plotH - (plotH * r) / 8);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(fmtValue(lo), absMg.l, absMg.t + plotH + 3);
  ctx.fillText(fmtValue((lo + hi) / 2), absMg.l + plotW / 2, absMg.t + plotH + 3);
  ctx.fillText(fmtValue(hi), absMg.l + plotW, absMg.t + plotH + 3);

  const hoverInside =
    hover !== null &&
    hover.x >= absMg.l &&
    hover.x <= absMg.l + plotW &&
    hover.y >= absMg.t &&
    hover.y <= absMg.t + plotH;
  const hoverBin = hoverInside && hover ? Math.min(bins - 1, Math.max(0, Math.floor(((hover.x - absMg.l) / plotW) * bins))) : -1;

  const barW = plotW / bins;
  for (let b = 0; b < bins; b++) {
    const cnt = histCountsScratch[b];
    if (cnt === 0) continue;
    const x = absMg.l + b * barW;
    const y = yOf(cnt);
    ctx.globalAlpha = b === hoverBin ? 0.98 : 0.78;
    ctx.fillStyle = src.color;
    ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), absMg.t + plotH - y);
    if (b === hoverBin) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, barW - 1), Math.max(1, absMg.t + plotH - y - 1));
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = src.color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let b = 0; b < bins; b++) {
    const x = absMg.l + b * barW + barW / 2;
    const y = yOf(histCountsScratch[b]);
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  if (hoverInside && hover && hoverBin >= 0) {
    const bw = (hi - lo) / bins;
    const binLo = lo + hoverBin * bw;
    const binHi = binLo + bw;
    const cnt = histCountsScratch[hoverBin];
    const pct = totalSamples > 0 ? (cnt / totalSamples) * 100 : 0;
    const bxCenter = absMg.l + hoverBin * barW + barW / 2;
    ctx.strokeStyle = pal.textFaint;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(bxCenter) + 0.5, absMg.t);
    ctx.lineTo(Math.round(bxCenter) + 0.5, absMg.t + plotH);
    ctx.moveTo(absMg.l, Math.round(hover.y) + 0.5);
    ctx.lineTo(absMg.l + plotW, Math.round(hover.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    drawTooltipRows(ctx, pal, absMg, plotW, plotH, hover.x, hover.y, [
      { label: 'range', value: `[${fmtValue(binLo)}, ${fmtValue(binHi)})`, color: pal.textDim },
      { label: 'count', value: `${cnt} (${pct.toFixed(1)}%)`, color: src.color },
      { label: 'total', value: `${totalSamples} pts`, color: pal.textFaint },
    ]);
  }
};

// ---------------------------------------------------------------------------
// Interaction & store snapshot refs
// ---------------------------------------------------------------------------

type DragMode = null | 'pan' | 'box' | 'c1' | 'c2' | 'y1' | 'y2';

interface InteractionState {
  drag: DragMode;
  chartId: string | null;
  startX: number;
  startY: number;
  moved: boolean;
  panAnchorWin: ViewWindow | null;
  panWin: ViewWindow | null;
  boxUs: { t0: number; t1: number } | null;
}

interface PlotStoreSnapshot {
  charts: ChartConfig[];
  activeChartId: string;
  cursors: Record<string, CursorPair>;
  layoutMode: PlotLayoutMode;
  gpuAccel: boolean;
}

interface WorkstationSnapshot {
  selectedPacket: PacketRow | null;
  isPaused: boolean;
  hasPackets: boolean;
}

export const PlotForgeView: React.FC = () => {
  const { charts, activeChartId, cursors, plotDepth, layoutMode, gpuAccel } = usePlotStore(
    useShallow((s) => ({
      charts: s.charts,
      activeChartId: s.activeChartId,
      cursors: s.cursors,
      plotDepth: s.plotDepth,
      layoutMode: s.layoutMode,
      gpuAccel: s.gpuAccel,
    }))
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Refs synced for zero-churn rAF + single-mount DOM event listeners.
  const chartsStateRef = useRef<PlotStoreSnapshot>({
    charts,
    activeChartId,
    cursors,
    layoutMode,
    gpuAccel,
  });
  chartsStateRef.current = { charts, activeChartId, cursors, layoutMode, gpuAccel };

  const wsRef = useRef<WorkstationSnapshot>({
    selectedPacket: useWorkstationStore.getState().selectedPacket,
    isPaused: useWorkstationStore.getState().isPaused,
    hasPackets: useWorkstationStore.getState().packets.length > 0,
  });

  const dirtyRef = useRef(true);
  const lastPaintedVersionRef = useRef(-1);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const interRef = useRef<InteractionState>({
    drag: null,
    chartId: null,
    startX: 0,
    startY: 0,
    moved: false,
    panAnchorWin: null,
    panWin: null,
    boxUs: null,
  });

  // Per-chart interaction overrides & trigger state (never causes React renders).
  const cursorOverrideRef = useRef<{ chartId: string; x1Us: number | null; x2Us: number | null } | null>(null);
  const yCursorOverrideRef = useRef<{ chartId: string; y1: number | null; y2: number | null } | null>(null);
  const cursorFracsRef = useRef<Map<string, { f1: number; f2: number }>>(new Map());
  const singleArmTimeRef = useRef<Map<string, number>>(new Map());
  const lastTriggerWinRef = useRef<Map<string, ViewWindow>>(new Map());
  const singleFreezePendingRef = useRef<Set<string>>(new Set());
  const subVpsRef = useRef<SubViewport[]>([]);

  const [statsTick, setStatsTick] = useState(0);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [trigMenuOpen, setTrigMenuOpen] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingChId, setRenamingChId] = useState<string | null>(null);
  const [renameChValue, setRenameChValue] = useState('');
  const [fftWindow, setFftWindow] = useState<'hann' | 'rect'>('hann');

  const fftWindowRef = useRef<'hann' | 'rect'>(fftWindow);
  fftWindowRef.current = fftWindow;

  const addMenuContainerRef = useRef<HTMLDivElement>(null);
  const trigMenuContainerRef = useRef<HTMLDivElement>(null);

  const chart = charts.find((c) => c.id === activeChartId) ?? charts[0];
  const cursorPair = chart ? cursors[chart.id] : undefined;
  const xCursorsOn = !!(cursorPair && (cursorPair.x1Us !== null || cursorPair.x2Us !== null));
  const yCursorsOn = !!(chart && (chart.y1Cursor !== null && chart.y1Cursor !== undefined || chart.y2Cursor !== null && chart.y2Cursor !== undefined));
  const cursorModeLabel: 'OFF' | 'X' | 'X+Y' = yCursorsOn ? 'X+Y' : xCursorsOn ? 'X' : 'OFF';

  const anyVisibleLive =
    layoutMode === 'single' ? !!chart?.live : charts.some((c) => c.live);

  // Trigger window resolver (pure when allowSideEffects === false).
  const resolveChartWindow = useCallback(
    (c: ChartConfig, allowSideEffects: boolean): { win: ViewWindow; trigState: TriggerRunState | null } => {
      if (!c.live && c.frozen) {
        return { win: { tMinUs: c.frozen.tMinUs, tMaxUs: c.frozen.tMaxUs }, trigState: null };
      }
      const defaultWin = resolveBaseWindow(c);
      const trig = c.trigger;
      if (!trig?.enabled || c.mode !== 'time') {
        return { win: defaultWin, trigState: null };
      }
      const ring = trig.sourceId ? plotEngine.getChannelRing(trig.sourceId) : undefined;
      if (!ring || ring.length < 2) {
        const waiting = trig.mode === 'NORM' || trig.mode === 'SINGLE';
        const held = waiting ? lastTriggerWinRef.current.get(c.id) : undefined;
        return {
          win: held ?? defaultWin,
          trigState: { triggered: false, waiting, anchorUs: null },
        };
      }
      if (trig.mode === 'ROLL') {
        return { win: defaultWin, trigState: { triggered: false, waiting: false, anchorUs: null } };
      }

      const pos = Math.min(1, Math.max(0, trig.position));
      const tLeft = pos * c.spanUs;
      const tRight = (1 - pos) * c.spanUs;
      const rHead = ring.tMax;

      if (trig.mode === 'SINGLE') {
        let armT = singleArmTimeRef.current.get(c.id);
        if (armT === undefined) {
          armT = rHead;
          singleArmTimeRef.current.set(c.id, armT);
        }
        const res = findTriggerCrossing(ring, trig, armT, rHead);
        if (res.triggered && res.triggerTimeUs > armT) {
          const caughtWin: ViewWindow = {
            tMinUs: res.triggerTimeUs - tLeft,
            tMaxUs: res.triggerTimeUs + tRight,
          };
          lastTriggerWinRef.current.set(c.id, caughtWin);
          if (allowSideEffects && !singleFreezePendingRef.current.has(c.id)) {
            singleFreezePendingRef.current.add(c.id);
            queueMicrotask(() => {
              singleFreezePendingRef.current.delete(c.id);
              usePlotStore.getState().freezeView(c.id, caughtWin.tMinUs, caughtWin.tMaxUs);
            });
          }
          return {
            win: caughtWin,
            trigState: { triggered: true, waiting: false, anchorUs: res.triggerTimeUs },
          };
        }
        return {
          win: lastTriggerWinRef.current.get(c.id) ?? defaultWin,
          trigState: { triggered: false, waiting: true, anchorUs: null },
        };
      }

      const tSearchStart = Math.max(ring.tMin, rHead - c.spanUs * 2);
      let res =
        rHead - tRight > tSearchStart
          ? findTriggerCrossing(ring, trig, tSearchStart, rHead - tRight)
          : { triggered: false, triggerTimeUs: rHead, crossingIndex: -1 };
      if (!res.triggered) {
        res = findTriggerCrossing(ring, trig, tSearchStart, rHead);
      }

      if (res.triggered) {
        const tWin: ViewWindow = {
          tMinUs: res.triggerTimeUs - tLeft,
          tMaxUs: res.triggerTimeUs + tRight,
        };
        lastTriggerWinRef.current.set(c.id, tWin);
        return {
          win: tWin,
          trigState: { triggered: true, waiting: false, anchorUs: res.triggerTimeUs },
        };
      }

      if (trig.mode === 'NORM') {
        return {
          win: lastTriggerWinRef.current.get(c.id) ?? defaultWin,
          trigState: { triggered: false, waiting: true, anchorUs: null },
        };
      }
      return {
        win: defaultWin,
        trigState: { triggered: false, waiting: false, anchorUs: null },
      };
    },
    []
  );

  // Mark canvas dirty when React-tracked plot store props or fftWindow change.
  useEffect(() => {
    dirtyRef.current = true;
  }, [charts, activeChartId, cursors, layoutMode, gpuAccel, fftWindow]);

  // Subscribe imperatively to workstation store for playhead/pause/clear updates
  // without causing PlotForgeView React re-renders on every packet or hover.
  useEffect(() => {
    const unsub = useWorkstationStore.subscribe((state) => {
      const prev = wsRef.current;
      const hasPackets = state.packets.length > 0;
      const pktChanged =
        prev.selectedPacket?.seqId !== state.selectedPacket?.seqId ||
        prev.selectedPacket?.timestampUs !== state.selectedPacket?.timestampUs;
      const pauseChanged = prev.isPaused !== state.isPaused;
      const cleared = prev.hasPackets && !hasPackets;

      wsRef.current = {
        selectedPacket: state.selectedPacket,
        isPaused: state.isPaused,
        hasPackets,
      };
      if (pktChanged || pauseChanged || cleared) {
        dirtyRef.current = true;
      }
    });
    return unsub;
  }, []);

  // Refresh catalog every 2s while ADD CHANNEL menu is open.
  useEffect(() => {
    if (!addMenuOpen) return;
    const t = setInterval(() => setCatalogVersion((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [addMenuOpen]);

  // Close popovers on outside click / Escape.
  useEffect(() => {
    if (!addMenuOpen && !trigMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (addMenuOpen && addMenuContainerRef.current && target && !addMenuContainerRef.current.contains(target)) {
        setAddMenuOpen(false);
      }
      if (trigMenuOpen && trigMenuContainerRef.current && target && !trigMenuContainerRef.current.contains(target)) {
        setTrigMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAddMenuOpen(false);
        setTrigMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [addMenuOpen, trigMenuOpen]);

  // Stats strip 2 Hz refresh while any visible chart is live.
  useEffect(() => {
    if (!anyVisibleLive) return;
    const t = setInterval(() => setStatsTick((v) => v + 1), 500);
    return () => clearInterval(t);
  }, [anyVisibleLive]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const st = chartsStateRef.current;
    if (!canvas || !wrap || st.charts.length === 0) return;

    const rect = wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const pal = plotPalette();
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = pal.canvas;
    ctx.fillRect(0, 0, W, H);

    const vps = computeSubViewportShells(st.charts, st.activeChartId, st.layoutMode, W, H);
    const it = interRef.current;

    // Resolve all subplot windows first so stacked crosshairs synchronize both up and down.
    for (let i = 0; i < vps.length; i++) {
      const vp = vps[i];
      if (it.drag === 'pan' && it.chartId === vp.chart.id && it.panWin) {
        vp.win = it.panWin;
        vp.trigState = null;
      } else {
        const resolved = resolveChartWindow(vp.chart, true);
        vp.win = resolved.win;
        vp.trigState = resolved.trigState;
      }
    }

    // Determine hovered subplot and synchronized timestamp for stacked TIME mode.
    const hover = hoverRef.current;
    let hoveredVp: SubViewport | null = null;
    let syncedHoverTUs: number | null = null;
    if (hover && it.drag === null) {
      for (let i = 0; i < vps.length; i++) {
        const vp = vps[i];
        if (hover.x >= vp.x && hover.x <= vp.x + vp.w && hover.y >= vp.y && hover.y <= vp.y + vp.h) {
          hoveredVp = vp;
          if (
            st.layoutMode === 'stacked' &&
            vp.chart.mode === 'time' &&
            vp.win &&
            hover.x >= vp.absMg.l &&
            hover.x <= vp.absMg.l + vp.plotW &&
            hover.y >= vp.absMg.t &&
            hover.y <= vp.absMg.t + vp.plotH
          ) {
            const tSpan = Math.max(1e-9, vp.win.tMaxUs - vp.win.tMinUs);
            syncedHoverTUs = vp.win.tMinUs + ((hover.x - vp.absMg.l) / vp.plotW) * tSpan;
          }
          break;
        }
      }
    }

    const activeId = st.charts.some((c) => c.id === st.activeChartId) ? st.activeChartId : st.charts[0].id;
    const ws = wsRef.current;

    for (let vi = 0; vi < vps.length; vi++) {
      const vp = vps[vi];
      const c = vp.chart;
      const { absMg, plotW, plotH, hasY2 } = vp;

      // Pane border + compact header in STACK / GRID modes
      if (st.layoutMode !== 'single') {
        const isActive = c.id === activeId;
        ctx.fillStyle = pal.gridMinor;
        ctx.fillRect(vp.x, vp.y, vp.w, vp.headH);
        if (isActive) {
          ctx.fillStyle = pal.cyan;
          ctx.fillRect(vp.x, vp.y, 3, vp.headH);
        }
        ctx.strokeStyle = isActive ? pal.cyan : pal.grid;
        ctx.lineWidth = 1;
        ctx.strokeRect(vp.x + 0.5, vp.y + 0.5, vp.w - 1, vp.h - 1);

        ctx.font = MONO_BOLD;
        ctx.fillStyle = isActive ? pal.text : pal.textDim;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const trigBadge = c.mode === 'time' && c.trigger?.enabled ? ` · TRIG ${c.trigger.mode}` : '';
        const statusTxt = c.mode === 'time' ? (c.live ? 'LIVE' : 'FROZEN') : c.mode.toUpperCase();
        ctx.fillText(
          `${c.name.toUpperCase()}  [${statusTxt}${trigBadge}]`,
          vp.x + 8,
          vp.y + vp.headH / 2
        );

        ctx.font = MONO;
        ctx.fillStyle = pal.textFaint;
        ctx.textAlign = 'right';
        ctx.fillText(`${c.channels.filter((ch) => ch.visible).length}/${c.channels.length} ch`, vp.x + vp.w - 6, vp.y + vp.headH / 2);
      }

      const paneHover =
        hoveredVp === vp &&
        hover &&
        hover.x >= absMg.l &&
        hover.x <= absMg.l + plotW &&
        hover.y >= absMg.t &&
        hover.y <= absMg.t + plotH
          ? hover
          : null;

      if (c.mode !== 'time') {
        drawGrid(ctx, pal, absMg, plotW, plotH);
        const modeCtx: ModePaintCtx = {
          ctx,
          pal,
          absMg,
          plotW,
          plotH,
          chart: c,
          hover: paneHover,
          fftWindow: fftWindowRef.current,
          gpuAccel: st.gpuAccel,
          dpr,
          win: vp.win,
        };
        if (c.mode === 'fft') drawFftChart(modeCtx);
        else if (c.mode === 'xy') drawXyChart(modeCtx);
        else drawHistChart(modeCtx);
        continue;
      }

      const win = vp.win;
      const tSpan = win ? Math.max(1e-9, win.tMaxUs - win.tMinUs) : 1;
      const xOf = (tUs: number) => absMg.l + ((tUs - (win?.tMinUs ?? 0)) / tSpan) * plotW;

      drawGrid(ctx, pal, absMg, plotW, plotH);

      // X tick labels
      ctx.font = MONO;
      ctx.fillStyle = pal.textFaint;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (win) {
        for (let col = 0; col <= 10; col += 2) {
          const t = win.tMinUs + (tSpan * col) / 10;
          ctx.fillText(fmtTimeUs(t), absMg.l + (plotW * col) / 10, absMg.t + plotH + 3);
        }
      }

      const visible = c.channels.filter((ch) => ch.visible);
      if (visible.length === 0) {
        drawHint(
          { ctx, pal, absMg, plotW, plotH },
          c.channels.length === 0 ? 'NO CHANNELS — USE "+ ADD CHANNEL"' : 'ALL CHANNELS HIDDEN'
        );
        continue;
      }
      if (!win) continue;

      // Single-pass zero-allocation decimation + bounds scan via getSeriesScratch
      const buckets = Math.max(10, Math.floor(plotW));
      let y1Min = Infinity;
      let y1Max = -Infinity;
      let y2Min = Infinity;
      let y2Max = -Infinity;

      const chSeries: Array<{
        ch: ChannelDef;
        t: Float64Array;
        v: Float64Array;
        count: number;
      }> = [];

      for (let ci = 0; ci < visible.length; ci++) {
        const ch = visible[ci];
        const scratch = plotEngine.getSeriesScratch(ch.id, win.tMinUs, win.tMaxUs, buckets);
        chSeries.push({ ch, t: scratch.t, v: scratch.v, count: scratch.count });
        if (scratch.count > 0) {
          if (ch.axis === 'y2') {
            if (scratch.min < y2Min) y2Min = scratch.min;
            if (scratch.max > y2Max) y2Max = scratch.max;
          } else {
            if (scratch.min < y1Min) y1Min = scratch.min;
            if (scratch.max > y1Max) y1Max = scratch.max;
          }
        }
      }

      const y1 = finalizeAxisRange(y1Min, y1Max, c.y1Min, c.y1Max);
      const y2 = finalizeAxisRange(y2Min, y2Max, c.y2Min, c.y2Max);
      vp.y1 = y1;
      vp.y2 = y2;

      const yOf = (v: number, ax: AxisRange) => absMg.t + plotH - ((v - ax.min) / (ax.max - ax.min)) * plotH;

      // Y axis labels
      ctx.font = MONO;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = pal.textDim;
      for (let r = 2; r <= 6; r += 2) {
        const v = y1.max - ((y1.max - y1.min) * r) / 8;
        ctx.fillText(fmtValue(v), absMg.l - 4, absMg.t + (plotH * r) / 8);
      }
      if (hasY2) {
        ctx.textAlign = 'left';
        ctx.fillStyle = pal.textDim;
        for (let r = 2; r <= 6; r += 2) {
          const v = y2.max - ((y2.max - y2.min) * r) / 8;
          ctx.fillText(fmtValue(v), absMg.l + plotW + 4, absMg.t + (plotH * r) / 8);
        }
      }

      // Render waveforms (WebGL2 when gpuAccel is true, falling back to Canvas 2D)
      let drewAny = false;
      webglTracesScratch.length = 0;
      for (let i = 0; i < chSeries.length; i++) {
        const s = chSeries[i];
        if (s.count > 0) drewAny = true;
        if (s.count >= 2) {
          const ax = s.ch.axis === 'y2' ? y2 : y1;
          webglTracesScratch.push({
            t: s.t,
            v: s.v,
            count: s.count,
            xMin: win.tMinUs,
            xMax: win.tMaxUs,
            yMin: ax.min,
            yMax: ax.max,
            color: s.ch.color,
            lineWidth: 1.4,
          });
        }
      }

      const usedGpu =
        st.gpuAccel &&
        webglTracesScratch.length > 0 &&
        renderWaveformsWebGL(
          ctx,
          { x: absMg.l, y: absMg.t, w: plotW, h: plotH, dpr, phosphor: true },
          webglTracesScratch
        );

      ctx.save();
      ctx.beginPath();
      ctx.rect(absMg.l, absMg.t, plotW, plotH);
      ctx.clip();

      for (let i = 0; i < chSeries.length; i++) {
        const s = chSeries[i];
        if (s.count === 0) continue;
        const ax = s.ch.axis === 'y2' ? y2 : y1;
        if (s.count === 1) {
          ctx.fillStyle = s.ch.color;
          ctx.fillRect(xOf(s.t[0]) - 1.5, yOf(s.v[0], ax) - 1.5, 3, 3);
          continue;
        }
        if (usedGpu) continue;
        ctx.strokeStyle = s.ch.color;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (let j = 0; j < s.count; j++) {
          const tv = s.t[j];
          const vv = s.v[j];
          if (!Number.isFinite(tv) || !Number.isFinite(vv)) {
            started = false;
            continue;
          }
          const px = xOf(tv);
          const py = yOf(vv, ax);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
      ctx.restore();

      if (!drewAny) {
        drawHint({ ctx, pal, absMg, plotW, plotH }, 'AWAITING DATA…');
      }

      // Trigger level + horizontal anchor indicators
      if (c.trigger?.enabled) {
        const trig = c.trigger;
        const trigCh = c.channels.find((ch) => ch.id === trig.sourceId);
        const trigAx = trigCh?.axis === 'y2' ? y2 : y1;
        const rawTy = yOf(trig.level, trigAx);
        const clampedTy = Math.min(absMg.t + plotH - 1, Math.max(absMg.t + 1, rawTy));
        const tx = absMg.l + trig.position * plotW;
        const trigColor = trig.mode === 'ROLL' ? pal.textDim : vp.trigState?.waiting ? pal.amber : pal.ok;

        ctx.save();
        ctx.strokeStyle = trigColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (rawTy >= absMg.t && rawTy <= absMg.t + plotH) {
          ctx.moveTo(absMg.l, Math.round(rawTy) + 0.5);
          ctx.lineTo(absMg.l + plotW, Math.round(rawTy) + 0.5);
        }
        if (trig.mode !== 'ROLL') {
          ctx.moveTo(Math.round(tx) + 0.5, absMg.t);
          ctx.lineTo(Math.round(tx) + 0.5, absMg.t + plotH);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Trigger anchor top triangle
        if (trig.mode !== 'ROLL') {
          ctx.fillStyle = trigColor;
          ctx.beginPath();
          ctx.moveTo(tx - 4, absMg.t);
          ctx.lineTo(tx + 4, absMg.t);
          ctx.lineTo(tx, absMg.t + 5);
          ctx.closePath();
          ctx.fill();
        }
        // Trigger level badge at left edge
        const trigTag = `T:${fmtValue(trig.level)}${vp.trigState?.waiting ? ' WAIT' : ''}`;
        ctx.font = MONO_BOLD;
        const ttw = ctx.measureText(trigTag).width + 6;
        fillAlphaPanel(ctx, pal, absMg.l + 2, clampedTy - 7, ttw, 13, 0.85);
        ctx.fillStyle = trigColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(trigTag, absMg.l + 5, clampedTy - 0.5);
        ctx.restore();
      }

      // Workstation playhead marker when paused / investigating a packet
      if (ws.isPaused && ws.selectedPacket) {
        const pTime = ws.selectedPacket.timestampUs;
        if (pTime >= win.tMinUs && pTime <= win.tMaxUs) {
          const px = xOf(pTime);
          ctx.save();
          ctx.strokeStyle = pal.cyan;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(Math.round(px) + 0.5, absMg.t);
          ctx.lineTo(Math.round(px) + 0.5, absMg.t + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = pal.cyan;
          ctx.beginPath();
          ctx.moveTo(px, absMg.t + plotH);
          ctx.lineTo(px - 4, absMg.t + plotH - 6);
          ctx.lineTo(px + 4, absMg.t + plotH - 6);
          ctx.closePath();
          ctx.fill();

          const pLabel = `#${ws.selectedPacket.seqId}`;
          ctx.font = MONO_BOLD;
          ctx.textAlign = px + 36 > absMg.l + plotW ? 'right' : 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(pLabel, px + (px + 36 > absMg.l + plotW ? -5 : 4), absMg.t + plotH - 2);
          ctx.restore();
        }
      }

      // Box-zoom rubber band
      if (it.drag === 'box' && it.chartId === c.id && it.boxUs) {
        const bx0 = xOf(Math.min(it.boxUs.t0, it.boxUs.t1));
        const bx1 = xOf(Math.max(it.boxUs.t0, it.boxUs.t1));
        ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
        ctx.fillRect(bx0, absMg.t, Math.max(2, bx1 - bx0), plotH);
        ctx.strokeStyle = pal.cyan;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(bx0 + 0.5, absMg.t + 0.5, Math.max(2, bx1 - bx0) - 1, plotH - 1);
        ctx.setLineDash([]);
      }

      // X1/X2 and Y1/Y2 measurement cursors
      const committedX = st.cursors[c.id] ?? { x1Us: null, x2Us: null };
      const cEff =
        cursorOverrideRef.current && cursorOverrideRef.current.chartId === c.id
          ? cursorOverrideRef.current
          : committedX;
      const chartXCursorsOn = cEff.x1Us !== null || cEff.x2Us !== null;

      if (c.live && chartXCursorsOn) {
        if (!cursorFracsRef.current.has(c.id)) {
          const fracOf = (t: number | null, fb: number) =>
            t === null ? fb : Math.min(1, Math.max(0, (t - win.tMinUs) / tSpan));
          cursorFracsRef.current.set(c.id, {
            f1: fracOf(cEff.x1Us, 0.3),
            f2: fracOf(cEff.x2Us, 0.7),
          });
        }
      }
      let e1 = cEff.x1Us;
      let e2 = cEff.x2Us;
      const frac = c.live ? cursorFracsRef.current.get(c.id) : undefined;
      if (c.live && frac) {
        if (e1 !== null) e1 = win.tMinUs + frac.f1 * tSpan;
        if (e2 !== null) e2 = win.tMinUs + frac.f2 * tSpan;
      }

      const yOv = yCursorOverrideRef.current && yCursorOverrideRef.current.chartId === c.id ? yCursorOverrideRef.current : null;
      const ey1 = yOv ? yOv.y1 : c.y1Cursor ?? null;
      const ey2 = yOv ? yOv.y2 : c.y2Cursor ?? null;
      const chartYCursorsOn = ey1 !== null || ey2 !== null;

      if (chartXCursorsOn) {
        ctx.font = MONO_BOLD;
        for (const [which, tUs] of [
          ['X1', e1],
          ['X2', e2],
        ] as const) {
          if (tUs === null) continue;
          const cx = xOf(tUs);
          if (cx < absMg.l - 1 || cx > absMg.l + plotW + 1) continue;
          ctx.strokeStyle = pal.cursor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(Math.round(cx) + 0.5, absMg.t);
          ctx.lineTo(Math.round(cx) + 0.5, absMg.t + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = pal.cursor;
          ctx.beginPath();
          ctx.moveTo(cx - 4, absMg.t);
          ctx.lineTo(cx + 4, absMg.t);
          ctx.lineTo(cx, absMg.t + 5);
          ctx.closePath();
          ctx.fill();
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(which, cx + 3, absMg.t + 6);
        }
      }

      if (chartYCursorsOn) {
        const yAx = vp.yCursorAxis === 'y2' ? y2 : y1;
        ctx.font = MONO_BOLD;
        for (const [which, yVal] of [
          ['Y1', ey1],
          ['Y2', ey2],
        ] as const) {
          if (yVal === null) continue;
          const cy = yOf(yVal, yAx);
          if (cy < absMg.t - 1 || cy > absMg.t + plotH + 1) continue;
          ctx.strokeStyle = pal.sky;
          ctx.lineWidth = 1.3;
          ctx.setLineDash([5, 3]);
          ctx.beginPath();
          ctx.moveTo(absMg.l, Math.round(cy) + 0.5);
          ctx.lineTo(absMg.l + plotW, Math.round(cy) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = pal.sky;
          ctx.beginPath();
          ctx.moveTo(absMg.l, cy - 4);
          ctx.lineTo(absMg.l, cy + 4);
          ctx.lineTo(absMg.l + 5, cy);
          ctx.closePath();
          ctx.fill();
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${which} ${fmtValue(yVal)}`, absMg.l + 7, cy - 2);
        }
      }

      // Cursor HUD box: Δt, 1/Δt, Y1/Y2/ΔY, and per-channel interpolated X1/X2/Δv
      if (chartXCursorsOn || chartYCursorsOn) {
        const hudRows: Array<{ text: string; color: string; bold?: boolean }> = [];
        if (e1 !== null && e2 !== null) {
          const dtUs = Math.abs(e2 - e1);
          hudRows.push({
            text: `Δt ${fmtTimeUs(dtUs)} · ${dtUs > 0 ? fmtFreq(1e6 / dtUs) : '—'}`,
            color: pal.cursor,
            bold: true,
          });
        } else if (e1 !== null || e2 !== null) {
          const tOnly = e1 !== null ? e1 : e2!;
          hudRows.push({
            text: `${e1 !== null ? 'X1' : 'X2'} ${fmtTimeUs(tOnly)}`,
            color: pal.cursor,
            bold: true,
          });
        }

        if (ey1 !== null && ey2 !== null) {
          hudRows.push({
            text: `Y1 ${fmtValue(ey1)} · Y2 ${fmtValue(ey2)} · ΔY ${fmtValue(Math.abs(ey2 - ey1))}`,
            color: pal.sky,
            bold: true,
          });
        } else if (ey1 !== null || ey2 !== null) {
          hudRows.push({
            text: `${ey1 !== null ? 'Y1' : 'Y2'} ${fmtValue(ey1 !== null ? ey1 : ey2!)}`,
            color: pal.sky,
            bold: true,
          });
        }

        if (chartXCursorsOn && plotH >= 85) {
          const maxChRows = plotH >= 150 ? 6 : 2;
          for (let i = 0; i < Math.min(visible.length, maxChRows); i++) {
            const ch = visible[i];
            const ring = plotEngine.getChannelRing(ch.id);
            const v1 = e1 !== null ? sampleAtTime(ring, e1) : null;
            const v2 = e2 !== null ? sampleAtTime(ring, e2) : null;
            const unitSuffix = ch.unit ? ` ${ch.unit}` : '';
            if (e1 !== null && e2 !== null) {
              const dv = v1 !== null && v2 !== null ? fmtValue(v2 - v1) : '—';
              hudRows.push({
                text: `${ch.label}: ${v1 !== null ? fmtValue(v1) : '—'} → ${v2 !== null ? fmtValue(v2) : '—'} (Δ ${dv}${unitSuffix})`,
                color: ch.color,
              });
            } else {
              const sv = e1 !== null ? v1 : v2;
              hudRows.push({
                text: `${ch.label}: ${sv !== null ? fmtValue(sv) : '—'}${unitSuffix}`,
                color: ch.color,
              });
            }
          }
        }

        if (hudRows.length > 0) {
          ctx.font = MONO_BOLD;
          let maxW = 100;
          for (const r of hudRows) {
            ctx.font = r.bold ? MONO_BOLD : MONO;
            const tw = ctx.measureText(r.text).width;
            if (tw > maxW) maxW = tw;
          }
          const boxW = Math.min(plotW - 8, maxW + 12);
          const rowH = 14;
          const boxH = hudRows.length * rowH + 6;
          const bx = absMg.l + plotW - boxW - 4;
          const by = absMg.t + 3;

          fillAlphaPanel(ctx, pal, bx, by, boxW, boxH, 0.88);
          ctx.strokeStyle = chartXCursorsOn ? pal.cursor : pal.sky;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          for (let i = 0; i < hudRows.length; i++) {
            const r = hudRows[i];
            ctx.font = r.bold ? MONO_BOLD : MONO;
            ctx.fillStyle = r.color;
            ctx.fillText(r.text, bx + 6, by + 4 + i * rowH + rowH / 2 - 1, boxW - 12);
          }
        }
      }

      // Crosshair + nearest-sample tooltip (or synchronized crosshair in STACK mode)
      if (paneHover) {
        const tHover = win.tMinUs + ((paneHover.x - absMg.l) / plotW) * tSpan;
        ctx.strokeStyle = pal.textFaint;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(paneHover.x) + 0.5, absMg.t);
        ctx.lineTo(Math.round(paneHover.x) + 0.5, absMg.t + plotH);
        ctx.moveTo(absMg.l, Math.round(paneHover.y) + 0.5);
        ctx.lineTo(absMg.l + plotW, Math.round(paneHover.y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        const tol = (tSpan / plotW) * 25;
        const rows: TooltipRow[] = [{ label: 't', value: fmtTimeUs(tHover), color: pal.textDim }];
        for (const ch of visible) {
          const s = plotEngine.sampleNearest(ch.id, tHover, tol);
          if (!s) continue;
          rows.push({
            label: ch.label,
            value: `${fmtValue(s.value)}${ch.unit ? ` ${ch.unit}` : ''}`,
            color: ch.color,
          });
        }
        drawTooltipRows(ctx, pal, absMg, plotW, plotH, paneHover.x, paneHover.y, rows);
      } else if (
        st.layoutMode === 'stacked' &&
        syncedHoverTUs !== null &&
        syncedHoverTUs >= win.tMinUs &&
        syncedHoverTUs <= win.tMaxUs
      ) {
        const sx = xOf(syncedHoverTUs);
        ctx.strokeStyle = pal.textFaint;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(sx) + 0.5, absMg.t);
        ctx.lineTo(Math.round(sx) + 0.5, absMg.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);

        const tol = (tSpan / plotW) * 25;
        const rows: TooltipRow[] = [{ label: 't', value: fmtTimeUs(syncedHoverTUs), color: pal.textDim }];
        for (let i = 0; i < Math.min(visible.length, 3); i++) {
          const ch = visible[i];
          const s = plotEngine.sampleNearest(ch.id, syncedHoverTUs, tol);
          if (!s) continue;
          rows.push({
            label: ch.label,
            value: `${fmtValue(s.value)}${ch.unit ? ` ${ch.unit}` : ''}`,
            color: ch.color,
          });
        }
        if (rows.length > 1) {
          drawTooltipRows(ctx, pal, absMg, plotW, plotH, sx, absMg.t + 16, rows);
        }
      }
    }

    subVpsRef.current = vps;
  }, [resolveChartWindow]);

  const renderFnRef = useRef(renderCanvas);
  renderFnRef.current = renderCanvas;

  // Dirty-flag rAF loop: skips repainting when paused/idle and dataVersion
  // hasn't changed while dirtyRef is false.
  useEffect(() => {
    let animId = 0;
    let disposed = false;

    const loop = () => {
      if (disposed) return;
      if (!document.hidden) {
        const st = chartsStateRef.current;
        const visibleCharts =
          st.layoutMode === 'single'
            ? [st.charts.find((c) => c.id === st.activeChartId) ?? st.charts[0]].filter(Boolean)
            : st.charts;
        const hasAnyLiveChart = visibleCharts.some((c) => c.live);
        const dv = plotEngine.getDataVersion();
        const dataDirty = dv !== lastPaintedVersionRef.current && hasAnyLiveChart;

        if (dirtyRef.current || dataDirty) {
          dirtyRef.current = false;
          lastPaintedVersionRef.current = dv;
          renderFnRef.current();
        }
      }
      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
    };
  }, []);

  // ResizeObserver, visibilitychange, and theme MutationObserver -> mark dirty.
  useEffect(() => {
    const wrap = wrapRef.current;
    const ro = wrap
      ? new ResizeObserver(() => {
          dirtyRef.current = true;
        })
      : null;
    if (wrap && ro) ro.observe(wrap);

    const mo = new MutationObserver(() => {
      invalidatePlotPalette();
      dirtyRef.current = true;
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bf-theme', 'data-bf-mode'],
    });

    const onVis = () => {
      if (!document.hidden) dirtyRef.current = true;
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      ro?.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Stabilized pointer + wheel listeners attached ONCE on mount (uses refs).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const store = usePlotStore.getState();

    const getVps = (): SubViewport[] => {
      if (subVpsRef.current.length > 0) return subVpsRef.current;
      const rect = wrap.getBoundingClientRect();
      const st = chartsStateRef.current;
      return computeSubViewportShells(st.charts, st.activeChartId, st.layoutMode, rect.width, rect.height);
    };

    const findVpAt = (x: number, y: number): SubViewport | null => {
      const vps = getVps();
      for (let i = 0; i < vps.length; i++) {
        const vp = vps[i];
        if (x >= vp.x && x <= vp.x + vp.w && y >= vp.y && y <= vp.y + vp.h) return vp;
      }
      return vps[0] ?? null;
    };

    const findVpById = (id: string | null): SubViewport | null => {
      if (!id) return null;
      const vps = getVps();
      return vps.find((vp) => vp.chart.id === id) ?? null;
    };

    const effCursorUs = (c: ChartConfig, win: ViewWindow): { x1Us: number | null; x2Us: number | null } => {
      const st = chartsStateRef.current;
      const ov = cursorOverrideRef.current;
      const committed = ov && ov.chartId === c.id ? ov : st.cursors[c.id] ?? { x1Us: null, x2Us: null };
      const frac = c.live ? cursorFracsRef.current.get(c.id) : undefined;
      if (c.live && frac) {
        const span = win.tMaxUs - win.tMinUs;
        return {
          x1Us: committed.x1Us === null ? null : win.tMinUs + frac.f1 * span,
          x2Us: committed.x2Us === null ? null : win.tMinUs + frac.f2 * span,
        };
      }
      return committed;
    };

    const hitCursor = (
      vp: SubViewport,
      x: number,
      y: number,
      win: ViewWindow
    ): 'c1' | 'c2' | 'y1' | 'y2' | null => {
      const c = vp.chart;
      const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
      const cEff = effCursorUs(c, win);
      for (const [which, tUs] of [
        ['c2', cEff.x2Us],
        ['c1', cEff.x1Us],
      ] as const) {
        if (tUs === null) continue;
        const cx = vp.absMg.l + ((tUs - win.tMinUs) / tSpan) * vp.plotW;
        if (Math.abs(x - cx) <= 8) return which;
      }

      const yOv = yCursorOverrideRef.current;
      const ey1 = yOv && yOv.chartId === c.id ? yOv.y1 : c.y1Cursor ?? null;
      const ey2 = yOv && yOv.chartId === c.id ? yOv.y2 : c.y2Cursor ?? null;
      const yAx = vp.yCursorAxis === 'y2' ? vp.y2 : vp.y1;
      const ySpan = Math.max(1e-12, yAx.max - yAx.min);
      for (const [which, yVal] of [
        ['y2', ey2],
        ['y1', ey1],
      ] as const) {
        if (yVal === null) continue;
        const cy = vp.absMg.t + vp.plotH - ((yVal - yAx.min) / ySpan) * vp.plotH;
        if (Math.abs(y - cy) <= 8) return which;
      }
      return null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const vp = findVpAt(x, y);
      if (!vp || vp.chart.mode !== 'time') return;

      const freshChart = usePlotStore.getState().charts.find((ch) => ch.id === vp.chart.id) ?? vp.chart;
      const win =
        interRef.current.drag === 'pan' && interRef.current.chartId === freshChart.id && interRef.current.panWin
          ? interRef.current.panWin
          : !freshChart.live && freshChart.frozen
            ? { tMinUs: freshChart.frozen.tMinUs, tMaxUs: freshChart.frozen.tMaxUs }
            : vp.win ?? resolveBaseWindow(freshChart);
      const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;

      if (e.ctrlKey || e.metaKey) {
        const axis: 'y1' | 'y2' = vp.hasY2 && x > vp.absMg.l + vp.plotW * 0.62 ? 'y2' : 'y1';
        const ax = resolveAxisRangeStats(freshChart, axis, win);
        const vAt = ax.min + (1 - (y - vp.absMg.t) / vp.plotH) * (ax.max - ax.min);
        const half = Math.max(((ax.max - ax.min) * factor) / 2, 1e-12);
        store.setChartViewportFast(
          freshChart.id,
          axis === 'y1' ? { y1Range: [vAt - half, vAt + half] } : { y2Range: [vAt - half, vAt + half] }
        );
        dirtyRef.current = true;
        return;
      }

      const frac = Math.min(1, Math.max(0, (x - vp.absMg.l) / vp.plotW));
      if (freshChart.live) {
        store.setChartViewportFast(freshChart.id, {
          spanUs: Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, freshChart.spanUs * factor)),
        });
      } else {
        const tAt = win.tMinUs + frac * tSpan;
        const newSpan = Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, tSpan * factor));
        const nextMin = tAt - frac * newSpan;
        store.setChartViewportFast(freshChart.id, { frozenWindow: [nextMin, nextMin + newSpan] });
      }
      dirtyRef.current = true;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const vp = findVpAt(x, y);
      if (!vp) return;

      if (vp.chart.id !== chartsStateRef.current.activeChartId) {
        store.setActiveChart(vp.chart.id);
      }

      // Clicking the per-pane header activates the subplot without starting a canvas drag.
      if (y < vp.y + vp.headH) return;
      if (vp.chart.mode !== 'time') return;

      const c = usePlotStore.getState().charts.find((ch) => ch.id === vp.chart.id) ?? vp.chart;
      const win =
        !c.live && c.frozen
          ? { tMinUs: c.frozen.tMinUs, tMaxUs: c.frozen.tMaxUs }
          : vp.win ?? resolveBaseWindow(c);
      if (x < vp.absMg.l || x > vp.absMg.l + vp.plotW || y < vp.absMg.t || y > vp.absMg.t + vp.plotH) {
        return;
      }

      const cursorHit = hitCursor(vp, x, y, win);
      if (cursorHit === 'c1' || cursorHit === 'c2') {
        const committed = chartsStateRef.current.cursors[c.id] ?? { x1Us: null, x2Us: null };
        const eff = effCursorUs(c, win);
        const span = Math.max(1e-9, win.tMaxUs - win.tMinUs);
        cursorOverrideRef.current = { chartId: c.id, x1Us: committed.x1Us, x2Us: committed.x2Us };
        cursorFracsRef.current.set(c.id, {
          f1: eff.x1Us === null ? 0.3 : Math.min(1, Math.max(0, (eff.x1Us - win.tMinUs) / span)),
          f2: eff.x2Us === null ? 0.7 : Math.min(1, Math.max(0, (eff.x2Us - win.tMinUs) / span)),
        });
        interRef.current = {
          drag: cursorHit,
          chartId: c.id,
          startX: x,
          startY: y,
          moved: false,
          panAnchorWin: null,
          panWin: null,
          boxUs: null,
        };
        dirtyRef.current = true;
        return;
      }

      if (cursorHit === 'y1' || cursorHit === 'y2') {
        yCursorOverrideRef.current = {
          chartId: c.id,
          y1: c.y1Cursor ?? null,
          y2: c.y2Cursor ?? null,
        };
        interRef.current = {
          drag: cursorHit,
          chartId: c.id,
          startX: x,
          startY: y,
          moved: false,
          panAnchorWin: null,
          panWin: null,
          boxUs: null,
        };
        dirtyRef.current = true;
        return;
      }

      const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
      const tAt = win.tMinUs + ((x - vp.absMg.l) / vp.plotW) * tSpan;
      if (e.shiftKey) {
        interRef.current = {
          drag: 'box',
          chartId: c.id,
          startX: x,
          startY: y,
          moved: false,
          panAnchorWin: null,
          panWin: null,
          boxUs: { t0: tAt, t1: tAt },
        };
      } else {
        interRef.current = {
          drag: 'pan',
          chartId: c.id,
          startX: x,
          startY: y,
          moved: false,
          panAnchorWin: { ...win },
          panWin: { ...win },
          boxUs: null,
        };
      }
      dirtyRef.current = true;
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      hoverRef.current = { x: mx, y: my };

      const it = interRef.current;
      if (it.drag && it.chartId) {
        if (!it.moved && Math.hypot(mx - it.startX, my - it.startY) > 4) {
          it.moved = true;
        }
        const vp = findVpById(it.chartId);
        if (vp) {
          const c = vp.chart;
          const win = vp.win ?? resolveBaseWindow(c);
          const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
          const tAt = win.tMinUs + ((mx - vp.absMg.l) / vp.plotW) * tSpan;

          if (it.drag === 'pan' && it.moved && it.panAnchorWin) {
            const anchorSpan = Math.max(1e-9, it.panAnchorWin.tMaxUs - it.panAnchorWin.tMinUs);
            const dt = ((it.startX - mx) / vp.plotW) * anchorSpan;
            it.panWin = {
              tMinUs: it.panAnchorWin.tMinUs + dt,
              tMaxUs: it.panAnchorWin.tMaxUs + dt,
            };
          } else if (it.drag === 'box' && it.boxUs) {
            it.boxUs.t1 = tAt;
          } else if ((it.drag === 'c1' || it.drag === 'c2') && cursorOverrideRef.current) {
            const t = Math.min(win.tMaxUs, Math.max(win.tMinUs, tAt));
            const frac = (t - win.tMinUs) / tSpan;
            cursorOverrideRef.current[it.drag === 'c1' ? 'x1Us' : 'x2Us'] = t;
            const fEntry = cursorFracsRef.current.get(c.id);
            if (fEntry) fEntry[it.drag === 'c1' ? 'f1' : 'f2'] = frac;
          } else if ((it.drag === 'y1' || it.drag === 'y2') && yCursorOverrideRef.current) {
            const yAx = vp.yCursorAxis === 'y2' ? vp.y2 : vp.y1;
            const norm = 1 - Math.min(1, Math.max(0, (my - vp.absMg.t) / vp.plotH));
            const vAt = yAx.min + norm * (yAx.max - yAx.min);
            yCursorOverrideRef.current[it.drag] = vAt;
          }
        }
      }

      dirtyRef.current = true;
    };

    const commitDrag = (fromMouseUp: boolean, upX = 0, upY = 0) => {
      const it = interRef.current;
      const vp = findVpById(it.chartId);
      const c = vp?.chart;
      const win = vp?.win ?? (c ? resolveBaseWindow(c) : null);

      if (c && vp && win) {
        if (it.drag === 'pan') {
          if (it.moved && it.panWin) {
            store.freezeView(c.id, it.panWin.tMinUs, it.panWin.tMaxUs);
            const curPair = chartsStateRef.current.cursors[c.id];
            const fEntry = cursorFracsRef.current.get(c.id);
            if (curPair && fEntry) {
              const span = it.panWin.tMaxUs - it.panWin.tMinUs;
              if (curPair.x1Us !== null) store.setCursorX(c.id, 'x1', it.panWin.tMinUs + fEntry.f1 * span);
              if (curPair.x2Us !== null) store.setCursorX(c.id, 'x2', it.panWin.tMinUs + fEntry.f2 * span);
            }
          } else if (fromMouseUp && !it.moved && c.mode === 'time') {
            // Clean click on TIME plot (not dragging pan/box/cursors) -> workstation cross-probe seek!
            const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
            const clickedTimeUs = win.tMinUs + ((upX - vp.absMg.l) / vp.plotW) * tSpan;
            if (
              useWorkstationStore.getState().packets.length > 0 &&
              upX >= vp.absMg.l &&
              upX <= vp.absMg.l + vp.plotW &&
              upY >= vp.absMg.t &&
              upY <= vp.absMg.t + vp.plotH
            ) {
              useWorkstationStore.getState().seekToTimestamp(clickedTimeUs);
            }
          }
        } else if (it.drag === 'box' && it.boxUs && it.moved) {
          const tSpan = Math.max(1e-9, win.tMaxUs - win.tMinUs);
          const lo = Math.min(it.boxUs.t0, it.boxUs.t1);
          const hi = Math.max(it.boxUs.t0, it.boxUs.t1);
          if (hi - lo > tSpan * 0.01) store.freezeView(c.id, lo, hi);
        } else if ((it.drag === 'c1' || it.drag === 'c2') && cursorOverrideRef.current) {
          const which = it.drag === 'c1' ? 'x1' : 'x2';
          const val = cursorOverrideRef.current[it.drag === 'c1' ? 'x1Us' : 'x2Us'];
          store.setCursorX(c.id, which, val);
        } else if ((it.drag === 'y1' || it.drag === 'y2') && yCursorOverrideRef.current) {
          store.setYCursors(c.id, yCursorOverrideRef.current.y1, yCursorOverrideRef.current.y2);
        }
      }

      interRef.current = {
        drag: null,
        chartId: null,
        startX: 0,
        startY: 0,
        moved: false,
        panAnchorWin: null,
        panWin: null,
        boxUs: null,
      };
      cursorOverrideRef.current = null;
      yCursorOverrideRef.current = null;
      dirtyRef.current = true;
    };

    const onMouseUp = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      commitDrag(true, e.clientX - rect.left, e.clientY - rect.top);
    };

    const onMouseLeave = () => {
      hoverRef.current = null;
      commitDrag(false);
    };

    const onDblClick = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      const vp = findVpAt(e.clientX - rect.left, e.clientY - rect.top);
      if (!vp || vp.chart.mode !== 'time') return;
      store.setChartViewportFast(vp.chart.id, { y1Range: 'auto', y2Range: 'auto' });
      dirtyRef.current = true;
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }, []);

  const catalog = useMemo(() => {
    void catalogVersion;
    void addMenuOpen;
    return plotEngine.catalogList();
  }, [catalogVersion, addMenuOpen]);

  const filteredCatalog = useMemo(() => {
    const q = catalogFilter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((e) => e.name.toLowerCase().includes(q));
  }, [catalog, catalogFilter]);

  const metaEntries: Array<{ label: string; metric: 'length' | 'delta' | 'rate'; unit: string }> = [
    { label: 'Frame length', metric: 'length', unit: 'B' },
    { label: 'Frame gap (Δt)', metric: 'delta', unit: 'µs' },
    { label: 'Throughput (1 s)', metric: 'rate', unit: 'B/s' },
  ];

  const handleAddField = (name: string, unit?: string) => {
    if (!chart) return;
    const ok = usePlotStore
      .getState()
      .addChannel(chart.id, { kind: 'field', name }, { label: name, unit });
    if (!ok) {
      toast.warn('Channel limit reached', 'Up to 32 channels across all charts');
    }
    setAddMenuOpen(false);
  };

  const handleAddMeta = (metric: 'length' | 'delta' | 'rate', unit: string) => {
    if (!chart) return;
    const ok = usePlotStore.getState().addChannel(chart.id, { kind: 'meta', metric }, { label: metric, unit });
    if (!ok) {
      toast.warn('Channel limit reached', 'Up to 32 channels across all charts');
    }
    setAddMenuOpen(false);
  };

  const applyCursorMode = (mode: 'OFF' | 'X' | 'X+Y') => {
    if (!chart) return;
    const store = usePlotStore.getState();
    if (mode === 'OFF') {
      store.setCursorX(chart.id, 'x1', null);
      store.setCursorX(chart.id, 'x2', null);
      store.setYCursors(chart.id, null, null);
      cursorFracsRef.current.delete(chart.id);
      return;
    }

    const { win } = resolveChartWindow(chart, false);
    const span = Math.max(1e-9, win.tMaxUs - win.tMinUs);
    const cur = cursors[chart.id];
    if (!cur || (cur.x1Us === null && cur.x2Us === null)) {
      cursorFracsRef.current.set(chart.id, { f1: 0.3, f2: 0.7 });
      store.setCursorX(chart.id, 'x1', win.tMinUs + span * 0.3);
      store.setCursorX(chart.id, 'x2', win.tMinUs + span * 0.7);
    }

    if (mode === 'X') {
      store.setYCursors(chart.id, null, null);
      return;
    }

    // X+Y mode: initialize Y1/Y2 within primary Y axis range if unset.
    if (chart.y1Cursor === null || chart.y1Cursor === undefined || chart.y2Cursor === null || chart.y2Cursor === undefined) {
      const hasY1 = chart.channels.some((c) => c.visible && c.axis === 'y1');
      const hasY2 = chart.channels.some((c) => c.visible && c.axis === 'y2');
      const ax = resolveAxisRangeStats(chart, hasY1 || !hasY2 ? 'y1' : 'y2', win);
      const ySpan = ax.max - ax.min;
      store.setYCursors(
        chart.id,
        chart.y1Cursor ?? ax.min + ySpan * 0.3,
        chart.y2Cursor ?? ax.min + ySpan * 0.7
      );
    }
  };

  const toggleLiveFreeze = () => {
    if (!chart) return;
    const store = usePlotStore.getState();
    if (chart.live) {
      const { win } = resolveChartWindow(chart, false);
      const frac = cursorFracsRef.current.get(chart.id);
      if (frac) {
        const span = win.tMaxUs - win.tMinUs;
        if (cursorPair?.x1Us !== null) store.setCursorX(chart.id, 'x1', win.tMinUs + frac.f1 * span);
        if (cursorPair?.x2Us !== null) store.setCursorX(chart.id, 'x2', win.tMinUs + frac.f2 * span);
      }
      if (win.tMaxUs > win.tMinUs) {
        store.freezeView(chart.id, win.tMinUs, win.tMaxUs);
      } else {
        store.setLive(chart.id, false);
      }
    } else {
      if (chart.trigger?.enabled && chart.trigger.mode === 'SINGLE') {
        const ring = chart.trigger.sourceId ? plotEngine.getChannelRing(chart.trigger.sourceId) : undefined;
        singleArmTimeRef.current.set(chart.id, ring ? ring.tMax : 0);
      }
      store.setLive(chart.id, true);
    }
  };

  // ---- trigger helpers ----------------------------------------------------
  const updateTrigger = (patch: Partial<ChartTriggerConfig>) => {
    if (!chart) return;
    const cur = chart.trigger ?? makeDefaultTrigger();
    const nextPatch: Partial<ChartTriggerConfig> = { ...patch };

    // Auto-select first channel when enabling trigger without a source.
    if (nextPatch.enabled && !cur.sourceId && !nextPatch.sourceId && chart.channels.length > 0) {
      const firstVis = chart.channels.find((c) => c.visible) ?? chart.channels[0];
      nextPatch.sourceId = firstVis.id;
    }

    const nextMode = nextPatch.mode ?? cur.mode;
    const nextEnabled = nextPatch.enabled ?? cur.enabled;
    const nextSourceId = nextPatch.sourceId ?? cur.sourceId;
    if (nextEnabled && nextMode === 'SINGLE') {
      const ring = nextSourceId ? plotEngine.getChannelRing(nextSourceId) : undefined;
      singleArmTimeRef.current.set(chart.id, ring ? ring.tMax : 0);
      if (!chart.live) usePlotStore.getState().setLive(chart.id, true);
    }

    usePlotStore.getState().setChartTrigger(chart.id, nextPatch);
  };

  // ---- export -------------------------------------------------------------
  const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const downloadBlob = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const exportPng = (): void => {
    if (!chart) return;
    canvasRef.current?.toBlob((blob) => {
      if (!blob) {
        toast.error('PNG export failed', 'canvas.toBlob returned null');
        return;
      }
      const name = `plotforge-${chart.name}-${stamp()}.png`;
      downloadBlob(blob, name);
      toast.success('PNG export started', name);
    }, 'image/png');
  };

  const exportCsv = (): void => {
    if (!chart) return;
    if (chart.mode !== 'time') {
      toast.warn('CSV export is available in TIME mode', 'switch the chart mode and retry');
      return;
    }
    const { win } = resolveChartWindow(chart, false);
    const vis = chart.channels.filter((c) => c.visible);
    if (vis.length === 0) {
      toast.warn('Nothing to export', 'add visible channels with samples first');
      return;
    }
    const MAX_ROWS = 100_000;
    const master = plotEngine.getWindowSamples(vis[0].id, win.tMinUs, win.tMaxUs, MAX_ROWS);
    if (master.length === 0) {
      toast.warn('No samples in the current window');
      return;
    }
    const rawCount = plotEngine.getWindowSampleCount(vis[0].id, win.tMinUs, win.tMaxUs);
    const stride = Math.max(1, Math.ceil(rawCount / MAX_ROWS));
    const diffs: number[] = [];
    const diffStep = Math.max(1, Math.floor(master.length / 512));
    for (let i = 1; i < master.length; i += diffStep) {
      diffs.push(Math.abs(master[i].tUs - master[i - 1].tUs));
    }
    diffs.sort((a, b) => a - b);
    const medDt = diffs.length ? diffs[Math.floor(diffs.length / 2)] / stride : 1e6;
    const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines: string[] = [`t_us,${vis.map((c) => esc(`${c.label}${c.unit ? ` (${c.unit})` : ''}`)).join(',')}`];
    for (const m of master) {
      const row = [String(Math.round(m.tUs)), String(m.v)];
      for (const ch of vis.slice(1)) {
        const s = plotEngine.sampleNearest(ch.id, m.tUs, medDt * 1.5 + 1);
        row.push(s ? String(s.value) : '');
      }
      lines.push(row.join(','));
    }
    const name = `plotforge-${chart.name}-${stamp()}.csv`;
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), name);
    toast.success('CSV export started', `${master.length} rows × ${vis.length} channels`);
  };

  // ---- expression channels ------------------------------------------------
  const [exprOpen, setExprOpen] = useState(false);
  const [exprValue, setExprValue] = useState('');
  const exprCheck = useMemo(() => (exprValue.trim() ? compileExpr(exprValue) : null), [exprValue]);
  const exprOk = exprCheck?.ok === true ? exprCheck : null;
  const exprErr = exprCheck && !exprCheck.ok ? exprCheck.error : null;

  const addExprChannel = (): void => {
    if (!chart || !exprCheck?.ok) return;
    const ok = usePlotStore
      .getState()
      .addChannel(chart.id, { kind: 'expr', source: exprValue.trim() }, { label: exprValue.trim().slice(0, 48) });
    if (!ok) toast.warn('Channel limit reached', 'Up to 32 channels across all charts');
    else toast.success('Expression channel added', exprValue.trim());
    setExprOpen(false);
    setExprValue('');
    setAddMenuOpen(false);
  };

  const commitRename = () => {
    if (renamingId) usePlotStore.getState().renameChart(renamingId, renameValue);
    setRenamingId(null);
  };

  const commitChannelRename = () => {
    if (chart && renamingChId) {
      const clean = renameChValue.trim();
      if (clean) {
        usePlotStore.getState().updateChannel(chart.id, renamingChId, { label: clean.slice(0, 48) });
      }
    }
    setRenamingChId(null);
  };

  const trigLevelStoreVal = chart?.trigger?.level ?? 0;
  const [trigLevelDraft, setTrigLevelDraft] = useState(() => String(trigLevelStoreVal));
  const trigLevelFocusedRef = useRef(false);
  useEffect(() => {
    if (!trigMenuOpen) trigLevelFocusedRef.current = false;
    if (!trigLevelFocusedRef.current) {
      setTrigLevelDraft(String(trigLevelStoreVal));
    }
  }, [chart?.id, trigLevelStoreVal, trigMenuOpen]);

  // Window stats for footer (recomputed on config changes + 2 Hz live tick).
  const statsRows = useMemo(() => {
    void statsTick;
    if (!chart) return [];
    const { win } = resolveChartWindow(chart, false);
    return chart.channels
      .filter((c) => c.visible)
      .map((c) => ({ ch: c, stats: plotEngine.getStats(c.id, win.tMinUs, win.tMaxUs) }));
  }, [chart, statsTick, resolveChartWindow]);

  if (!chart) return null;

  const trig = chart.trigger ?? makeDefaultTrigger();
  const histMode = chart.histSampleMode ?? 'window';

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Top Bar: Chart tabs + Layout Mode (TAB/STACK/GRID) + GPU toggle */}
      <div className="h-[26px] flex items-center gap-1 px-1.5 bg-bf-head border-b border-bf-line overflow-x-auto shrink-0">
        {charts.map((c) => (
          <span
            key={c.id}
            className={`group flex items-center gap-1 px-2 py-0.5 rounded-sm border text-[11px] tracking-wider whitespace-nowrap cursor-pointer ${
              c.id === chart.id
                ? 'bg-bf-btn-hi text-bf-bright border-bf-cyan'
                : 'bg-bf-panel text-bf-dim border-bf-line hover:bg-bf-btn'
            }`}
            onClick={() => usePlotStore.getState().setActiveChart(c.id)}
            onDoubleClick={() => {
              setRenamingId(c.id);
              setRenameValue(c.name);
            }}
            data-tooltip="Click to switch · double-click to rename"
          >
            {renamingId === c.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                className="w-24 bg-bf-canvas border border-bf-cyan rounded-sm px-1 text-[12px] text-bf-bright outline-none"
              />
            ) : (
              <span>{c.name.toUpperCase()}</span>
            )}
            {charts.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  usePlotStore.getState().removeChart(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-bf-faint hover:text-bf-fault"
                data-tooltip="Close chart"
              >
                <X size={9} />
              </button>
            )}
          </span>
        ))}
        <button
          onClick={() => usePlotStore.getState().addChart()}
          data-tooltip="New chart tab"
          className="p-0.5 rounded-sm border border-bf-line bg-bf-panel text-bf-dim hover:bg-bf-btn hover:text-bf-bright shrink-0"
        >
          <Plus size={11} />
        </button>

        <div className="ml-auto flex items-center gap-1.5 shrink-0 pl-2">
          <div className="flex items-center rounded border border-bf-line overflow-hidden" data-tooltip="Multi-chart layout mode">
            {([
              ['single', 'TAB'],
              ['stacked', 'STACK'],
              ['grid', 'GRID'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => usePlotStore.getState().setLayoutMode(mode)}
                className={`px-1.5 py-0.5 text-[11px] tracking-wider ${
                  layoutMode === mode ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => usePlotStore.getState().setGpuAccel(!gpuAccel)}
            className={gpuAccel ? ribbonActive : ribbonBtn}
            data-tooltip={gpuAccel ? 'WebGL2 GPU waveform acceleration ON (click for Canvas 2D)' : 'Canvas 2D software renderer (click to enable WebGL2 GPU)'}
          >
            <Zap size={10} />
            {gpuAccel ? 'GPU' : '2D'}
          </button>
        </div>
      </div>

      {/* Ribbon */}
      <div className="min-h-[26px] flex items-center flex-wrap gap-1.5 px-2 py-0.5 bg-bf-subpanel border-b border-bf-line shrink-0">
        <button
          onClick={toggleLiveFreeze}
          className={chart.live ? ribbonActive : ribbonBtn}
          data-tooltip={chart.live ? 'Following newest samples — click to freeze the view' : 'Frozen view — click to resume live follow'}
        >
          {chart.live ? <Pause size={10} /> : <Play size={10} />}
          {chart.live ? 'LIVE' : 'FROZEN'}
        </button>
        <button onClick={() => usePlotStore.getState().fitView(chart.id)} className={ribbonBtn} data-tooltip="Zoom to full data extent">
          FIT
        </button>
        <div className="flex items-center gap-0.5 border border-bf-line rounded bg-bf-panel" data-tooltip="X window span (1-2-5 presets)">
          <button className="px-1 text-bf-dim hover:text-bf-bright" onClick={() => usePlotStore.getState().setSpan(chart.id, stepSpan(chart.spanUs, -1))}>
            <Minus size={10} />
          </button>
          <span className="px-1 text-[11px] text-bf-body font-mono w-[60px] text-center">{fmtSpan(chart.spanUs)}</span>
          <button className="px-1 text-bf-dim hover:text-bf-bright" onClick={() => usePlotStore.getState().setSpan(chart.id, stepSpan(chart.spanUs, 1))}>
            <Plus size={10} />
          </button>
        </div>

        {/* Cursors: OFF | X | X+Y */}
        <div className="flex items-center rounded border border-bf-line overflow-hidden shrink-0" data-tooltip="Measurement cursors (drag X1/X2 and Y1/Y2 lines)">
          <span className="px-1 py-0.5 text-[10px] text-bf-faint bg-bf-panel border-r border-bf-line flex items-center gap-0.5">
            <Crosshair size={10} /> CURSORS
          </span>
          {(['OFF', 'X', 'X+Y'] as const).map((cm) => (
            <button
              key={cm}
              onClick={() => applyCursorMode(cm)}
              className={`px-1.5 py-0.5 text-[11px] ${
                cursorModeLabel === cm ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'
              }`}
            >
              {cm}
            </button>
          ))}
        </div>

        {/* Chart mode */}
        <div className="flex items-center rounded border border-bf-line overflow-hidden shrink-0" data-tooltip="Chart mode">
          {(['time', 'fft', 'xy', 'hist'] as const).map((m) => (
            <button
              key={m}
              onClick={() => usePlotStore.getState().setChartMode(chart.id, m)}
              className={`px-1.5 py-0.5 text-[11px] tracking-wider ${chart.mode === m ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'}`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        {/* TRIG control chip + popover (TIME mode) */}
        {chart.mode === 'time' && (
          <div ref={trigMenuContainerRef} className="relative">
            <button
              onClick={() => setTrigMenuOpen((v) => !v)}
              className={trig.enabled ? ribbonActive : ribbonBtn}
              data-tooltip="Configure edge trigger (AUTO / NORM / SINGLE / ROLL)"
            >
              <span>TRIG</span>
              {trig.enabled && (
                <span className="text-[10px] font-mono text-bf-cyan">
                  {trig.mode} {trig.slope === 'RISING' ? '↗' : trig.slope === 'FALLING' ? '↘' : '↕'} {fmtValue(trig.level)}
                </span>
              )}
            </button>
            {trigMenuOpen && (
              <div className="absolute z-[500] top-[24px] left-0 w-72 bg-bf-surface border border-bf-line-strong rounded shadow-xl p-2.5 space-y-2 text-[11px]">
                <div className="flex items-center justify-between border-b border-bf-line pb-1.5">
                  <span className="font-semibold tracking-wider text-bf-bright">EDGE TRIGGER</span>
                  <button
                    onClick={() => updateTrigger({ enabled: !trig.enabled })}
                    className={`px-2 py-0.5 rounded border text-[11px] ${
                      trig.enabled
                        ? 'bg-bf-btn-hi border-bf-cyan text-bf-bright'
                        : 'bg-bf-panel border-bf-line text-bf-dim hover:bg-bf-btn'
                    }`}
                  >
                    {trig.enabled ? 'TRIG ON' : 'TRIG OFF'}
                  </button>
                </div>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-bf-dim">Source</span>
                  <select
                    value={trig.sourceId}
                    onChange={(e) => updateTrigger({ sourceId: e.target.value })}
                    className="w-44 bg-bf-panel border border-bf-line rounded px-1 py-0.5 text-[11px] text-bf-body"
                  >
                    <option value="">Select channel…</option>
                    {chart.channels.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-bf-dim">Mode</span>
                  <div className="flex rounded border border-bf-line overflow-hidden">
                    {(['AUTO', 'NORM', 'SINGLE', 'ROLL'] as const).map((tm) => (
                      <button
                        key={tm}
                        onClick={() => updateTrigger({ mode: tm })}
                        className={`px-1.5 py-0.5 text-[10px] ${
                          trig.mode === tm ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'
                        }`}
                      >
                        {tm}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-bf-dim">Slope</span>
                  <div className="flex rounded border border-bf-line overflow-hidden">
                    {(['RISING', 'FALLING', 'EITHER'] as const).map((sl) => (
                      <button
                        key={sl}
                        onClick={() => updateTrigger({ slope: sl })}
                        className={`px-1.5 py-0.5 text-[10px] ${
                          trig.slope === sl ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'
                        }`}
                      >
                        {sl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-bf-dim">Level</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={trigLevelDraft}
                      onFocus={() => {
                        trigLevelFocusedRef.current = true;
                      }}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setTrigLevelDraft(raw);
                        const val = parseFloat(raw);
                        if (Number.isFinite(val)) updateTrigger({ level: val });
                      }}
                      onBlur={() => {
                        trigLevelFocusedRef.current = false;
                        const val = parseFloat(trigLevelDraft);
                        if (Number.isFinite(val)) {
                          updateTrigger({ level: val });
                          setTrigLevelDraft(String(val));
                        } else {
                          setTrigLevelDraft(String(trig.level));
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        }
                      }}
                      className="w-28 bg-bf-canvas border border-bf-line rounded px-1.5 py-0.5 text-[12px] font-mono text-bf-bright outline-none focus:border-bf-cyan"
                    />
                    <button
                      onClick={() => {
                        const targetId = trig.sourceId || chart.channels[0]?.id;
                        if (!targetId) return;
                        const { win } = resolveChartWindow(chart, false);
                        const stats = plotEngine.getStats(targetId, win.tMinUs, win.tMaxUs);
                        if (stats) {
                          const nextLevel = Number(((stats.min + stats.max) / 2).toPrecision(5));
                          updateTrigger({
                            sourceId: targetId,
                            level: nextLevel,
                          });
                          setTrigLevelDraft(String(nextLevel));
                        }
                      }}
                      className={ribbonBtn}
                      data-tooltip="Set trigger level to channel midpoint"
                    >
                      50%
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-2">
                  <span className="text-bf-dim">H-Pos ({Math.round(trig.position * 100)}%)</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(trig.position * 100)}
                    onChange={(e) => updateTrigger({ position: Number(e.target.value) / 100 })}
                    className="w-36 accent-bf-cyan"
                  />
                </label>

                {trig.mode === 'SINGLE' && (
                  <button
                    onClick={() => {
                      const ring = trig.sourceId ? plotEngine.getChannelRing(trig.sourceId) : undefined;
                      singleArmTimeRef.current.set(chart.id, ring ? ring.tMax : 0);
                      updateTrigger({ enabled: true, mode: 'SINGLE' });
                      usePlotStore.getState().setLive(chart.id, true);
                    }}
                    className="w-full py-0.5 rounded bg-bf-btn-hi border border-bf-cyan text-bf-bright text-[11px]"
                  >
                    RE-ARM SINGLE
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {chart.mode === 'fft' && (
          <>
            <select
              value={chart.fftSize}
              onChange={(e) => usePlotStore.getState().setFftConfig(chart.id, { fftSize: Number(e.target.value) })}
              className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
              data-tooltip="FFT window length (newest samples)"
            >
              {FFT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button onClick={() => usePlotStore.getState().setFftConfig(chart.id, { fftDb: !chart.fftDb })} className={ribbonBtn} data-tooltip="Toggle dB / linear magnitude">
              {chart.fftDb ? 'dB' : 'LIN'}
            </button>
            <button
              onClick={() => setFftWindow((w) => (w === 'hann' ? 'rect' : 'hann'))}
              className={ribbonBtn}
              data-tooltip="Toggle Hann / Rectangular FFT window"
            >
              {fftWindow === 'hann' ? 'HANN' : 'RECT'}
            </button>
          </>
        )}

        {chart.mode === 'xy' && (
          <select
            value={chart.xyXChannelId ?? ''}
            onChange={(e) => usePlotStore.getState().setXyXChannel(chart.id, e.target.value || null)}
            className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
            data-tooltip="Channel driving the X axis"
          >
            <option value="">X channel…</option>
            {chart.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}

        {chart.mode === 'hist' && (
          <>
            <select
              value={chart.histChannelId ?? ''}
              onChange={(e) => usePlotStore.getState().setHistConfig(chart.id, { channelId: e.target.value || null })}
              className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
              data-tooltip="Histogram source channel"
            >
              <option value="">Source…</option>
              {chart.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={histMode}
              onChange={(e) => usePlotStore.getState().setHistSampleMode(chart.id, e.target.value === 'tail' ? 'tail' : 'window')}
              className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
              data-tooltip="Sample over current time window or newest N tail samples"
            >
              <option value="window">WINDOW</option>
              <option value="tail">TAIL ({chart.fftSize})</option>
            </select>
            {histMode === 'tail' && (
              <select
                value={chart.fftSize}
                onChange={(e) => usePlotStore.getState().setFftConfig(chart.id, { fftSize: Number(e.target.value) })}
                className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
                data-tooltip="Tail sample count"
              >
                {FFT_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-0.5 border border-bf-line rounded bg-bf-panel" data-tooltip="Histogram bin count">
              <button
                className="px-1 text-bf-dim hover:text-bf-bright"
                onClick={() => usePlotStore.getState().setHistConfig(chart.id, { bins: Math.max(HIST_BINS_MIN, Math.round(chart.histBins / 2)) })}
              >
                <Minus size={10} />
              </button>
              <span className="px-1 text-[11px] font-mono w-7 text-center">{chart.histBins}</span>
              <button
                className="px-1 text-bf-dim hover:text-bf-bright"
                onClick={() => usePlotStore.getState().setHistConfig(chart.id, { bins: Math.min(HIST_BINS_MAX, chart.histBins * 2) })}
              >
                <Plus size={10} />
              </button>
            </div>
          </>
        )}

        <span className="text-bf-faint text-[10px] hidden xl:inline">
          {chart.live && chart.mode === 'time' ? 'FOLLOWING HEAD' : chart.frozen && chart.mode === 'time' ? `WINDOW ${fmtTimeUs(chart.frozen.tMinUs)} … ${fmtTimeUs(chart.frozen.tMaxUs)}` : ''}
          {' · click seek · drag pan · ⇧drag box · wheel zoom · dbl-click auto'}
        </span>
        <button onClick={exportCsv} className={`${ribbonBtn} shrink-0`} data-tooltip="Export the visible channels over the current window as CSV">
          CSV
        </button>
        <button onClick={exportPng} className={`${ribbonBtn} shrink-0`} data-tooltip="Save the chart canvas as a PNG image">
          PNG
        </button>
        <div className="ml-auto flex items-center gap-1.5 text-bf-faint text-[11px]" data-tooltip="Ring depth per channel — older samples drop off">
          DEPTH
          <select
            value={plotDepth}
            onChange={(e) => usePlotStore.getState().setPlotDepth(Number(e.target.value))}
            className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[11px] text-bf-body"
          >
            {[...new Set([10000, 30000, 60000, 120000, PLOT_DEPTH_MAX, plotDepth, PLOT_DEPTH_MIN])]
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d >= 1000 ? `${d / 1000}k` : d}
                </option>
              ))}
          </select>
        </div>
      </div>

      {/* Legend / channel strip */}
      <div className="min-h-[24px] flex items-center gap-1 px-2 py-0.5 bg-bf-panel border-b border-bf-line flex-wrap shrink-0">
        {chart.channels.map((ch: ChannelDef) => (
          <span
            key={ch.id}
            className="flex items-center gap-1 pl-1 pr-0.5 py-px rounded border border-bf-line bg-bf-subpanel text-[11px]"
          >
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: ch.color, boxShadow: `0 0 4px ${ch.color}` }} />
            {renamingChId === ch.id ? (
              <input
                autoFocus
                value={renameChValue}
                onChange={(e) => setRenameChValue(e.target.value)}
                onBlur={commitChannelRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitChannelRename();
                  if (e.key === 'Escape') setRenamingChId(null);
                }}
                className="w-28 bg-bf-canvas border border-bf-cyan rounded-sm px-1 text-[12px] text-bf-bright outline-none"
              />
            ) : (
              <button
                className="text-bf-body hover:text-bf-bright"
                onClick={() => usePlotStore.getState().toggleChannelVisible(chart.id, ch.id)}
                onDoubleClick={() => {
                  setRenamingChId(ch.id);
                  setRenameChValue(ch.label);
                }}
                data-tooltip={ch.visible ? 'Click to hide · double-click to rename' : 'Click to show · double-click to rename'}
              >
                {ch.label}
                {ch.unit ? <span className="text-bf-faint"> ({ch.unit})</span> : null}
              </button>
            )}
            <button
              onClick={() => {
                setRenamingChId(ch.id);
                setRenameChValue(ch.label);
              }}
              className="text-bf-faint hover:text-bf-bright px-0.5"
              data-tooltip="Rename channel"
            >
              <Pencil size={9} />
            </button>
            <button
              onClick={() => usePlotStore.getState().updateChannel(chart.id, ch.id, { axis: ch.axis === 'y1' ? 'y2' : 'y1' })}
              className={`px-0.5 rounded-sm text-[10px] border ${
                ch.axis === 'y2' ? 'border-bf-math text-bf-math' : 'border-bf-line text-bf-faint'
              }`}
              data-tooltip="Toggle left (Y1) / right (Y2) axis"
            >
              {ch.axis.toUpperCase()}
            </button>
            <button
              onClick={() => usePlotStore.getState().toggleChannelVisible(chart.id, ch.id)}
              className="text-bf-faint hover:text-bf-bright px-0.5"
              data-tooltip={ch.visible ? 'Hide channel' : 'Show channel'}
            >
              {ch.visible ? <Eye size={10} /> : <EyeOff size={10} />}
            </button>
            <button
              onClick={() => usePlotStore.getState().removeChannel(chart.id, ch.id)}
              className="text-bf-faint hover:text-bf-fault px-0.5"
              data-tooltip="Remove channel"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <div ref={addMenuContainerRef} className="relative">
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`flex items-center gap-1 px-1.5 py-px rounded border text-[11px] ${
              addMenuOpen ? 'bg-bf-btn-hi text-bf-bright border-bf-cyan' : 'border-bf-line bg-bf-panel text-bf-cyan hover:bg-bf-btn'
            }`}
            data-tooltip="Plot a decoded field, array element, packet metric or expression"
          >
            <Plus size={10} /> ADD CHANNEL
          </button>
          {addMenuOpen && (
            <div className="absolute z-[500] top-[22px] left-0 w-72 max-h-80 overflow-y-auto bg-bf-surface border border-bf-line-strong rounded shadow-xl text-[11px]">
              <div className="px-2 py-1 text-[11px] tracking-wider text-bf-faint border-b border-bf-line">PACKET METRICS</div>
              {metaEntries.map((m) => (
                <button
                  key={m.metric}
                  onClick={() => handleAddMeta(m.metric, m.unit)}
                  className="w-full text-left px-2 py-1 hover:bg-bf-btn text-bf-body flex justify-between"
                >
                  <span>{m.label}</span>
                  <span className="text-bf-faint">{m.unit}</span>
                </button>
              ))}
              <div className="px-2 py-1 text-[11px] tracking-wider text-bf-faint border-b border-bf-line flex items-center justify-between gap-2">
                <span>DECODED FIELDS {catalog.length === 0 ? '(none seen yet)' : `(${catalog.length})`}</span>
              </div>
              {catalog.length > 6 && (
                <div className="px-2 py-1 border-b border-bf-line">
                  <input
                    value={catalogFilter}
                    onChange={(e) => setCatalogFilter(e.target.value)}
                    placeholder="Filter fields (e.g. samples[0])…"
                    className="w-full bg-bf-canvas border border-bf-line rounded-sm px-1.5 py-0.5 text-[12px] text-bf-bright outline-none focus:border-bf-cyan"
                  />
                </div>
              )}
              {filteredCatalog.map((e) => (
                <button
                  key={e.name}
                  onClick={() => handleAddField(e.name, e.unit)}
                  className="w-full text-left px-2 py-1 hover:bg-bf-btn text-bf-body flex justify-between gap-2"
                >
                  <span className="truncate">{e.name}</span>
                  <span className="text-bf-faint shrink-0">
                    {e.unit ? `${e.unit} · ` : ''}
                    {e.count} pkt
                  </span>
                </button>
              ))}
              {catalog.length === 0 && (
                <div className="px-2 py-1.5 text-bf-faint">No numeric fields decoded yet — load a capture or connect a stream.</div>
              )}
              {catalog.length > 0 && filteredCatalog.length === 0 && (
                <div className="px-2 py-1.5 text-bf-faint">No fields match “{catalogFilter}”.</div>
              )}
              <div className="px-2 py-1 text-[11px] tracking-wider text-bf-faint border-t border-bf-line">EXPRESSION</div>
              {!exprOpen ? (
                <button onClick={() => setExprOpen(true)} className="w-full text-left px-2 py-1 hover:bg-bf-btn text-bf-cyan">
                  + New expression…
                </button>
              ) : (
                <div className="p-2 space-y-1">
                  <input
                    autoFocus
                    value={exprValue}
                    onChange={(e) => setExprValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && exprCheck?.ok) addExprChannel();
                      if (e.key === 'Escape') setExprOpen(false);
                    }}
                    placeholder="e.g. deg(atan2(gyro_y, gyro_x))"
                    className="w-full bg-bf-canvas border border-bf-line rounded-sm px-1 py-0.5 text-[12px] font-mono text-bf-bright outline-none focus:border-bf-cyan"
                  />
                  {exprValue.trim() === '' ? (
                    <div className="text-[10px] text-bf-faint">Refs resolve to channel labels (e.g. v_batt_mv, rate).</div>
                  ) : exprOk ? (
                    <div className="text-[10px] text-bf-ok">OK · refs: {exprOk.refs.length ? exprOk.refs.join(', ') : 'none'}</div>
                  ) : (
                    <div className="text-[10px] text-bf-fault">{exprErr}</div>
                  )}
                  <div className="text-[10px] text-bf-faint leading-snug">
                    Consts: {EXPR_CONSTS.join(', ')} · Fns: {EXPR_FUNCS.join(', ')}
                  </div>
                  <button
                    onClick={addExprChannel}
                    disabled={!exprOk}
                    className="w-full py-0.5 rounded-sm bg-bf-btn-hi border border-bf-cyan text-bf-bright text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ADD EXPRESSION CHANNEL
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {chart.channels.length === 0 && (
          <span className="text-bf-faint text-[11px]">Plot any decoded field, frame metric or derived expression.</span>
        )}
      </div>

      {/* Single Canvas (TAB / STACK / GRID) */}
      <div ref={wrapRef} className="relative flex-1 min-h-0 cursor-crosshair">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>

      {/* Footer: per-channel window stats (time) or mode summary */}
      <div className="min-h-[20px] flex items-center gap-3 px-2 py-0.5 bg-bf-subpanel border-t border-bf-line text-[11px] shrink-0 overflow-x-auto whitespace-nowrap">
        {chart.mode === 'time' ? (
          <>
            {statsRows.length === 0 && <span className="text-bf-faint">NO ACTIVE CHANNELS</span>}
            {statsRows.map(({ ch, stats }) => (
              <span key={ch.id} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: ch.color }} />
                <span className="text-bf-body">{ch.label}</span>
                {stats ? (
                  <span className="text-bf-faint font-mono">
                    min {fmtValue(stats.min)} · max {fmtValue(stats.max)} · μ {fmtValue(stats.mean)} · σ {fmtValue(stats.stdDev)}
                    {ch.unit ? ` ${ch.unit}` : ''}
                  </span>
                ) : (
                  <span className="text-bf-faint">no samples in window</span>
                )}
              </span>
            ))}
          </>
        ) : (
          <span className="text-bf-faint">
            {chart.mode === 'fft' && `FFT · n=${chart.fftSize} newest samples · ${chart.fftDb ? 'dB magnitude' : 'linear magnitude'} · ${fftWindow === 'hann' ? 'Hann' : 'Rect'} window, detrended`}
            {chart.mode === 'xy' && `XY · X: ${chart.channels.find((c) => c.id === chart.xyXChannelId)?.label ?? '(first channel)'} · timestamp-aligned (up to ${MAX_XY_POINTS} pairs)`}
            {chart.mode === 'hist' && `HIST · source: ${chart.channels.find((c) => c.id === chart.histChannelId)?.label ?? '(first channel)'} · ${chart.histBins} bins · ${histMode === 'tail' ? `newest ${chart.fftSize} samples` : 'current time window'}`}
          </span>
        )}
      </div>
    </div>
  );
};
