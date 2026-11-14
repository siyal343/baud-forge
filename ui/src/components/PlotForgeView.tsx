import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Minus, Pause, Play, Plus, X } from 'lucide-react';
import { usePlotStore, SPAN_MIN_US, SPAN_MAX_US, FFT_SIZES, HIST_BINS_MIN, HIST_BINS_MAX } from '../store/usePlotStore';
import { useShallow } from 'zustand/react/shallow';
import { plotEngine, PLOT_DEPTH_MAX, PLOT_DEPTH_MIN } from '../plot/engine';
import { plotPalette, type PlotPalette } from '../plot/palette';
import { magnitudeSpectrum } from '../plot/fft';
import { lttbIndices } from '../plot/decimate';
import { compileExpr } from '../plot/expr';
import type { ChannelDef, ChartDef } from '../plot/types';
import { toast } from '../store/useToastStore';

/**
 * Plot Forge — the advanced plotting engine panel.
 *
 * Renders the ACTIVE chart from usePlotStore onto a single Canvas2D surface.
 * Sample data is read imperatively from plotEngine's rings inside the rAF
 * loop (the Oscilloscope pattern): this component re-renders only on config
 * changes and a 2 Hz stats tick, never on data arrival. The rAF loop idles
 * when the chart is frozen (repaints come from interaction handlers).
 *
 * Modes: TIME (cursors/crosshair/zoom/pan), FFT (radix-2 spectrum of the
 * newest samples), XY (channel vs channel), HIST (amplitude histogram).
 *
 * Interactions (TIME mode):
 *   wheel            zoom X about the cursor (span stepper in LIVE mode)
 *   Ctrl+wheel       zoom the Y axis under the cursor (sets a manual range)
 *   drag             pan (freezes a LIVE chart at the current window)
 *   Shift+drag       box zoom → freeze into the selected X range
 *   drag X1/X2       measurement cursors (Δt + 1/Δt readout)
 *   double-click     reset both Y axes to autoscale
 */

// 1-2-5 X-span presets in ms (mirrors the scope's timebase family).
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

/** Compact axis/metric label: picks a unit and ≤3 significant decimals. */
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

// ---------------------------------------------------------------------------
// View-window + axis math (shared by painter and pointer handlers).
// ---------------------------------------------------------------------------

interface ViewWindow {
  tMinUs: number;
  tMaxUs: number;
}

interface AxisRange {
  min: number;
  max: number;
}

const M = { l: 46, r: 46, t: 8, b: 18 };
const margins = (hasY2: boolean) => ({ ...M, r: hasY2 ? M.r : 12 });

const resolveWindow = (chart: ChartDef): ViewWindow | null => {
  if (!chart.live && chart.frozen) return { tMinUs: chart.frozen.tMinUs, tMaxUs: chart.frozen.tMaxUs };
  // LIVE: [head − span, head] over all channels (head of the newest sample).
  const extent = plotEngine.getDataExtent();
  const head = extent ? extent.tMaxUs : 0;
  return { tMinUs: head - chart.spanUs, tMaxUs: head === 0 ? chart.spanUs : head };
};

const resolveAxisRange = (chart: ChartDef, axis: 'y1' | 'y2', win: ViewWindow): AxisRange => {
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (manualMin !== null) min = manualMin;
  if (manualMax !== null) max = manualMax;
  if (max === min) {
    const pad = Math.max(1e-9, Math.abs(max) * 0.5);
    min -= pad;
    max += pad;
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
};

// ---------------------------------------------------------------------------
// Non-time mode painters (FFT / XY / HIST). Pure-ish: read engine tails.
// ---------------------------------------------------------------------------

interface PaintCtx {
  ctx: CanvasRenderingContext2D;
  pal: PlotPalette;
  mg: { l: number; r: number; t: number; b: number };
  plotW: number;
  plotH: number;
  chart: ChartDef;
}

const MONO = '9px "JetBrains Mono", monospace';

const drawGrid = (p: PaintCtx): void => {
  const { ctx, pal, mg, plotW, plotH } = p;
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.gridMinor;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  for (let c = 1; c < 10; c++) {
    const x = Math.round(mg.l + (plotW * c) / 10) + 0.5;
    ctx.moveTo(x, mg.t);
    ctx.lineTo(x, mg.t + plotH);
  }
  for (let r = 1; r < 8; r++) {
    const y = Math.round(mg.t + (plotH * r) / 8) + 0.5;
    ctx.moveTo(mg.l, y);
    ctx.lineTo(mg.l + plotW, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = pal.grid;
  ctx.strokeRect(mg.l + 0.5, mg.t + 0.5, plotW - 1, plotH - 1);
};

const drawHint = (p: PaintCtx, text: string): void => {
  const { ctx, pal, mg, plotW, plotH } = p;
  ctx.fillStyle = pal.textFaint;
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, mg.l + plotW / 2, mg.t + plotH / 2);
};

/** Median sample interval (µs) of a tail — the FFT sample-rate estimator. */
const medianDeltaUs = (t: Float64Array): number => {
  if (t.length < 2) return 1000;
  const diffs: number[] = [];
  for (let i = 1; i < t.length; i++) diffs.push(t[i] - t[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 1000;
};

const drawFftChart = (p: PaintCtx): void => {
  const { ctx, pal, mg, plotW, plotH, chart } = p;
  const chs = chart.channels.filter((c) => c.visible).slice(0, 4);
  const spectra = chs
    .map((ch) => {
      const tail = plotEngine.getTail(ch.id, chart.fftSize);
      if (tail.v.length < 16) return null;
      const fs = 1e6 / medianDeltaUs(tail.t);
      return { ch, spec: magnitudeSpectrum(tail.v, fs, { detrend: true }) };
    })
    .filter((s): s is { ch: ChannelDef; spec: NonNullable<ReturnType<typeof magnitudeSpectrum>> } => s !== null);

  if (spectra.length === 0) {
    drawHint(p, 'AWAITING DATA… (FFT needs ≥16 samples per channel)');
    return;
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of spectra) {
    const arr = chart.fftDb ? s.spec.db : s.spec.mag;
    for (const v of arr) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // The axis spans the actual data: a dB clamp to floor+5 dB put the peak tens
  // of plot-heights above the canvas and rendered the spectrum invisible (F-39).
  if (hi - lo < 1e-9) hi = lo + 1;
  lo -= (hi - lo) * 0.06;
  hi += (hi - lo) * 0.06;
  const nyq = spectra[0].spec.freqHz[spectra[0].spec.freqHz.length - 1] || 1;
  const xOf = (hz: number) => mg.l + (hz / nyq) * plotW;
  const yOf = (v: number) => mg.t + plotH - ((v - lo) / (hi - lo)) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let c = 0; c <= 10; c += 2) ctx.fillText(fmtFreq((nyq * c) / 10), mg.l + (plotW * c) / 10, mg.t + plotH + 3);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const v = hi - ((hi - lo) * r) / 8;
    ctx.fillText(`${fmtValue(v)}${chart.fftDb ? ' dB' : ''}`, mg.l - 4, mg.t + (plotH * r) / 8);
  }

  for (const s of spectra) {
    const arr = chart.fftDb ? s.spec.db : s.spec.mag;
    const bins = arr.length;
    const stride = Math.max(1, Math.floor(bins / Math.max(10, plotW)));
    ctx.strokeStyle = s.ch.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < bins; k += stride) {
      const x = xOf(s.spec.freqHz[k]);
      const y = yOf(arr[k]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Peak marker (peak search excludes DC).
    if (s.spec.peakMag > 0) {
      const px = xOf(s.spec.peakHz);
      const pv = chart.fftDb ? 20 * Math.log10(s.spec.peakMag) : s.spec.peakMag;
      const py = yOf(Math.min(hi, Math.max(lo, pv)));
      ctx.fillStyle = s.ch.color;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtFreq(s.spec.peakHz), px + 4, py - 2);
    }
  }
};

const drawXyChart = (p: PaintCtx): void => {
  const { ctx, pal, mg, plotW, plotH, chart } = p;
  const xCh = chart.channels.find((c) => c.id === chart.xyXChannelId) ?? chart.channels.find((c) => c.visible) ?? null;
  const yChs = chart.channels.filter((c) => c.visible && (!xCh || c.id !== xCh.id));
  if (!xCh || yChs.length === 0) {
    drawHint(p, 'XY NEEDS AN X CHANNEL + AT LEAST ONE OTHER VISIBLE CHANNEL');
    return;
  }

  const xTail = plotEngine.getTail(xCh.id, 5000);
  const xVals = xTail.v;
  if (xVals.length < 2) {
    drawHint(p, 'AWAITING DATA…');
    return;
  }
  const pairs: Array<{ ch: ChannelDef; xs: Float64Array; ys: Float64Array }> = [];
  let xLo = Infinity;
  let xHi = -Infinity;
  for (const v of xVals) {
    if (v < xLo) xLo = v;
    if (v > xHi) xHi = v;
  }
  let yLo = Infinity;
  let yHi = -Infinity;
  for (const yCh of yChs) {
    const yTail = plotEngine.getTail(yCh.id, 5000);
    const n = Math.min(xVals.length, yTail.v.length);
    if (n < 2) continue;
    const xs = xVals.subarray(xVals.length - n);
    const ys = yTail.v.subarray(yTail.v.length - n);
    pairs.push({ ch: yCh, xs, ys });
    for (const v of ys) {
      if (v < yLo) yLo = v;
      if (v > yHi) yHi = v;
    }
  }
  if (pairs.length === 0) {
    drawHint(p, 'AWAITING DATA…');
    return;
  }
  if (xHi === xLo) xHi = xLo + 1e-9;
  if (yHi === yLo) yHi = yLo + 1e-9;
  const xPad = (xHi - xLo) * 0.06;
  const yPad = (yHi - yLo) * 0.06;
  const xOf = (v: number) => mg.l + ((v - (xLo - xPad)) / (xHi - xLo + 2 * xPad)) * plotW;
  const yOf = (v: number) => mg.t + plotH - ((v - (yLo - yPad)) / (yHi - yLo + 2 * yPad)) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const v = yHi + yPad - ((yHi - yLo + 2 * yPad) * r) / 8;
    ctx.fillText(fmtValue(v), mg.l - 4, mg.t + (plotH * r) / 8);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let c = 0; c <= 10; c += 2) {
    const v = xLo - xPad + ((xHi - xLo + 2 * xPad) * c) / 10;
    ctx.fillText(fmtValue(v), mg.l + (plotW * c) / 10, mg.t + plotH + 3);
  }
  ctx.fillStyle = pal.textDim;
  ctx.textAlign = 'right';
  ctx.fillText(`${xCh.label}${xCh.unit ? ` (${xCh.unit})` : ''} →`, mg.l + plotW, mg.t + plotH + 3);

  for (const pair of pairs) {
    ctx.strokeStyle = pair.ch.color;
    ctx.fillStyle = pair.ch.color;
    ctx.lineWidth = 1;
    const n = pair.xs.length;
    if (n > 2000) {
      const idxs = lttbIndices(pair.xs, pair.ys, 2000);
      ctx.beginPath();
      idxs.forEach((i, k) => {
        const x = xOf(pair.xs[i]);
        const y = yOf(pair.ys[i]);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(pair.xs[i]);
        const y = yOf(pair.ys[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (n <= 800) {
        for (let i = 0; i < n; i++) ctx.fillRect(xOf(pair.xs[i]) - 1, yOf(pair.ys[i]) - 1, 2, 2);
      }
    }
  }
};

const drawHistChart = (p: PaintCtx): void => {
  const { ctx, pal, mg, plotW, plotH, chart } = p;
  const src = chart.channels.find((c) => c.id === chart.histChannelId) ?? chart.channels.find((c) => c.visible) ?? null;
  if (!src) {
    drawHint(p, 'HIST NEEDS A SOURCE CHANNEL');
    return;
  }
  const tail = plotEngine.getTail(src.id, chart.fftSize);
  if (tail.v.length < 2) {
    drawHint(p, 'AWAITING DATA…');
    return;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of tail.v) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi === lo) hi = lo + 1e-9;
  const bins = chart.histBins;
  const counts = new Array<number>(bins).fill(0);
  const bw = (hi - lo) / bins;
  for (const v of tail.v) {
    let b = Math.floor((v - lo) / bw);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const maxCount = Math.max(...counts, 1);
  const yOf = (c: number) => mg.t + plotH - (c / maxCount) * plotH;

  ctx.font = MONO;
  ctx.fillStyle = pal.textFaint;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let r = 0; r <= 8; r += 2) {
    const c = Math.round((maxCount * r) / 8);
    ctx.fillText(String(c), mg.l - 4, mg.t + (plotH * r) / 8);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(fmtValue(lo), mg.l, mg.t + plotH + 3);
  ctx.fillText(fmtValue(hi), mg.l + plotW, mg.t + plotH + 3);

  const barW = plotW / bins;
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = src.color;
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue;
    const x = mg.l + b * barW;
    const y = yOf(counts[b]);
    ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), mg.t + plotH - y);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = src.color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let b = 0; b < bins; b++) {
    const x = mg.l + b * barW + barW / 2;
    const y = yOf(counts[b]);
    if (b === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

type DragMode = null | 'pan' | 'box' | 'c1' | 'c2';

interface InteractionState {
  drag: DragMode;
  /** X pixel where the drag started (pan/box). */
  startX: number;
  /** Working window during a pan — committed to the store on release. */
  panWin: ViewWindow | null;
  /** Working box-zoom range in µs — committed on release. */
  boxUs: { t0: number; t1: number } | null;
}

export const PlotForgeView: React.FC = () => {
  const { charts, activeChartId, cursors, plotDepth } = usePlotStore(
    useShallow((s) => ({
      charts: s.charts,
      activeChartId: s.activeChartId,
      cursors: s.cursors,
      plotDepth: s.plotDepth,
    }))
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(false);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const interRef = useRef<InteractionState>({ drag: null, startX: 0, panWin: null, boxUs: null });
  const cursorOverrideRef = useRef<{ x1Us: number | null; x2Us: number | null } | null>(null);
  /** Cursor positions as fractions of the window while LIVE (see painter). */
  const cursorFracRef = useRef<{ f1: number; f2: number } | null>(null);
  const [statsTick, setStatsTick] = useState(0);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const chart = charts.find((c) => c.id === activeChartId) ?? charts[0];
  const cursorPair = chart ? cursors[chart.id] : undefined;
  const cursorsOn = !!(cursorPair && (cursorPair.x1Us !== null || cursorPair.x2Us !== null));

  // Field catalog grows as packets flow — resample the picker list at 2 Hz
  // while the menu is open (cheap; catalog is capped at 512 entries).
  useEffect(() => {
    if (!addMenuOpen) return;
    const t = setInterval(() => setCatalogVersion((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [addMenuOpen]);

  // Stats strip refresh while LIVE (frozen charts recompute on each render).
  useEffect(() => {
    if (!chart?.live) return;
    const t = setInterval(() => setStatsTick((v) => v + 1), 500);
    return () => clearInterval(t);
  }, [chart?.live]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !chart) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const pal = plotPalette();
    const W = rect.width;
    const H = rect.height;
    const hasY2 = chart.channels.some((c) => c.visible && c.axis === 'y2');
    const mg = margins(hasY2);
    const plotW = Math.max(10, W - mg.l - mg.r);
    const plotH = Math.max(10, H - mg.t - mg.b);

    ctx.fillStyle = pal.canvas;
    ctx.fillRect(0, 0, W, H);

    // Non-time modes are self-contained painters (own grid/axes, no cursors).
    if (chart.mode !== 'time') {
      const p: PaintCtx = { ctx, pal, mg, plotW, plotH, chart };
      drawGrid(p);
      if (chart.mode === 'fft') drawFftChart(p);
      else if (chart.mode === 'xy') drawXyChart(p);
      else drawHistChart(p);
      return;
    }

    // Effective window: in-drag pan override wins over the committed one.
    const win = interRef.current.panWin ?? resolveWindow(chart);
    const tSpan = win ? Math.max(1e-9, win.tMaxUs - win.tMinUs) : 1;
    const xOf = (tUs: number) => mg.l + ((tUs - (win?.tMinUs ?? 0)) / tSpan) * plotW;

    // Graticule: 10 cols × 8 rows (scope layout).
    ctx.lineWidth = 1;
    ctx.strokeStyle = pal.gridMinor;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    for (let c = 1; c < 10; c++) {
      const x = Math.round(mg.l + (plotW * c) / 10) + 0.5;
      ctx.moveTo(x, mg.t);
      ctx.lineTo(x, mg.t + plotH);
    }
    for (let r = 1; r < 8; r++) {
      const y = Math.round(mg.t + (plotH * r) / 8) + 0.5;
      ctx.moveTo(mg.l, y);
      ctx.lineTo(mg.l + plotW, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = pal.grid;
    ctx.strokeRect(mg.l + 0.5, mg.t + 0.5, plotW - 1, plotH - 1);

    // X tick labels.
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = pal.textFaint;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (win) {
      for (let c = 0; c <= 10; c += 2) {
        const t = win.tMinUs + (tSpan * c) / 10;
        ctx.fillText(fmtTimeUs(t), mg.l + (plotW * c) / 10, mg.t + plotH + 3);
      }
    }

    const visible = chart.channels.filter((c) => c.visible);
    if (visible.length === 0) {
      ctx.fillStyle = pal.textFaint;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        chart.channels.length === 0 ? 'NO CHANNELS — USE "+ ADD CHANNEL"' : 'ALL CHANNELS HIDDEN',
        mg.l + plotW / 2,
        mg.t + plotH / 2
      );
      return;
    }
    if (!win) return;

    const y1 = resolveAxisRange(chart, 'y1', win);
    const y2 = resolveAxisRange(chart, 'y2', win);
    const yOf = (v: number, ax: AxisRange) => mg.t + plotH - ((v - ax.min) / (ax.max - ax.min)) * plotH;

    // Y labels: Y1 left, Y2 right.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.textDim;
    for (let r = 2; r <= 6; r += 2) {
      const v = y1.max - ((y1.max - y1.min) * r) / 8;
      ctx.fillText(fmtValue(v), mg.l - 4, mg.t + (plotH * r) / 8);
    }
    if (hasY2) {
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.textDim;
      for (let r = 2; r <= 6; r += 2) {
        const v = y2.max - ((y2.max - y2.min) * r) / 8;
        ctx.fillText(fmtValue(v), mg.l + plotW + 4, mg.t + (plotH * r) / 8);
      }
    }

    // Channels: min-max decimated polylines (bucket per pixel column).
    const buckets = Math.max(10, Math.floor(plotW));
    let drewAny = false;
    for (const ch of visible) {
      const series = plotEngine.getSeries(ch.id, win.tMinUs, win.tMaxUs, buckets);
      if (series.length === 0) continue;
      const ax = ch.axis === 'y2' ? y2 : y1;
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const x = xOf(series[i].t);
        const y = yOf(series[i].v, ax);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      drewAny = true;
    }
    if (!drewAny) {
      ctx.fillStyle = pal.textFaint;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AWAITING DATA…', mg.l + plotW / 2, mg.t + plotH / 2);
    }

    // Box-zoom rubber band.
    const box = interRef.current.boxUs;
    if (box) {
      const bx0 = xOf(Math.min(box.t0, box.t1));
      const bx1 = xOf(Math.max(box.t0, box.t1));
      ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
      ctx.fillRect(bx0, mg.t, Math.max(2, bx1 - bx0), plotH);
      ctx.strokeStyle = pal.cyan;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(bx0 + 0.5, mg.t + 0.5, Math.max(2, bx1 - bx0) - 1, plotH - 1);
      ctx.setLineDash([]);
    }

    // X cursors — in LIVE mode they ride the window at their set fractions
    // (absolute µs would drift off-screen as the head advances); frozen mode
    // uses the committed absolute positions. Fractions self-heal on mount:
    // persisted positions may predate the current live window.
    const cEff = cursorOverrideRef.current ?? cursorPair ?? { x1Us: null, x2Us: null };
    if (chart.live && cursorsOn && win && !cursorFracRef.current) {
      const span0 = win.tMaxUs - win.tMinUs;
      const fracOf = (t: number | null, fb: number) =>
        t === null ? fb : Math.min(1, Math.max(0, (t - win.tMinUs) / span0));
      cursorFracRef.current = { f1: fracOf(cEff.x1Us, 0.3), f2: fracOf(cEff.x2Us, 0.7) };
    }
    let e1 = cEff.x1Us;
    let e2 = cEff.x2Us;
    if (chart.live && cursorFracRef.current && win) {
      const span = win.tMaxUs - win.tMinUs;
      e1 = win.tMinUs + cursorFracRef.current.f1 * span;
      e2 = win.tMinUs + cursorFracRef.current.f2 * span;
    }
    const cursorXs: Array<{ x: number; label: string }> = [];
    if (cursorsOn) {
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      for (const [which, tUs] of [
        ['X1', e1],
        ['X2', e2],
      ] as const) {
        if (tUs === null) continue;
        const x = xOf(tUs);
        if (x < mg.l - 1 || x > mg.l + plotW + 1) continue;
        ctx.strokeStyle = pal.cursor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, mg.t);
        ctx.lineTo(Math.round(x) + 0.5, mg.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        // Grab handle: small filled triangle at the top edge.
        ctx.fillStyle = pal.cursor;
        ctx.beginPath();
        ctx.moveTo(x - 4, mg.t);
        ctx.lineTo(x + 4, mg.t);
        ctx.lineTo(x, mg.t + 5);
        ctx.closePath();
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(which, x + 3, mg.t + 6);
        cursorXs.push({ x, label: which });
      }
      if (e1 !== null && e2 !== null) {
        const dtUs = Math.abs(e2 - e1);
        ctx.fillStyle = 'rgba(10, 13, 19, 0.85)';
        const label = `Δt ${fmtTimeUs(dtUs)}  ·  ${dtUs > 0 ? fmtValue(1e6 / dtUs) : '—'} Hz`;
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        const tw = ctx.measureText(label).width + 10;
        ctx.fillRect(mg.l + plotW - tw - 4, mg.t + 2, tw, 14);
        ctx.strokeStyle = pal.cursor;
        ctx.lineWidth = 1;
        ctx.strokeRect(mg.l + plotW - tw - 3.5, mg.t + 2.5, tw - 1, 13);
        ctx.fillStyle = pal.cursor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, mg.l + plotW - 9, mg.t + 9.5);
      }
    }

    // Crosshair + nearest-sample tooltip.
    const hover = hoverRef.current;
    if (hover && interRef.current.drag === null && hover.x >= mg.l && hover.x <= mg.l + plotW) {
      const tHover = win.tMinUs + ((hover.x - mg.l) / plotW) * tSpan;
      ctx.strokeStyle = pal.textFaint;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.x) + 0.5, mg.t);
      ctx.lineTo(Math.round(hover.x) + 0.5, mg.t + plotH);
      ctx.moveTo(mg.l, Math.round(hover.y) + 0.5);
      ctx.lineTo(mg.l + plotW, Math.round(hover.y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      const tol = (tSpan / plotW) * 25;
      const rows: Array<{ label: string; value: string; color: string }> = [
        { label: 't', value: fmtTimeUs(tHover), color: pal.textDim },
      ];
      for (const ch of visible) {
        const s = plotEngine.sampleNearest(ch.id, tHover, tol);
        if (!s) continue;
        rows.push({ label: ch.label, value: `${fmtValue(s.value)}${ch.unit ? ` ${ch.unit}` : ''}`, color: ch.color });
      }
      const rowW = Math.max(...rows.map((r) => ctx.measureText(`${r.label}  ${r.value}`).width), 96) + 12;
      const rowH = 13;
      const boxW = rowW;
      const boxH = rows.length * rowH + 6;
      let bx = hover.x + 12;
      let by = hover.y + 12;
      if (bx + boxW > mg.l + plotW) bx = hover.x - boxW - 12;
      if (by + boxH > mg.t + plotH) by = hover.y - boxH - 12;
      ctx.fillStyle = 'rgba(10, 13, 19, 0.92)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = pal.grid;
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      rows.forEach((r, i) => {
        const ry = by + 4 + i * rowH;
        ctx.fillStyle = r.color;
        ctx.fillText(r.label, bx + 6, ry + rowH / 2 - 2);
        ctx.fillStyle = pal.text;
        ctx.textAlign = 'right';
        ctx.fillText(r.value, bx + boxW - 6, ry + rowH / 2 - 2);
        ctx.textAlign = 'left';
      });
    }
  }, [chart, cursorPair, cursorsOn]);

  liveRef.current = chart?.live ?? false;

  // rAF loop: repaint at 60 fps while LIVE; frozen charts repaint on config
  // change only (renderCanvas identity), mirroring the scope's idle-out.
  useEffect(() => {
    let animId = 0;
    const loop = () => {
      renderCanvas();
      if (!liveRef.current) return;
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [renderCanvas]);

  // Theme switches repaint the next frame even when frozen.
  useEffect(() => {
    const obs = new MutationObserver(() => renderCanvas());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bf-theme', 'data-bf-mode'] });
    return () => obs.disconnect();
  }, [renderCanvas]);

  // ---- pointer + wheel interactions --------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !chart) return;
    const store = usePlotStore.getState();

    const geom = () => {
      const rect = wrap.getBoundingClientRect();
      const hasY2 = chart.channels.some((c) => c.visible && c.axis === 'y2');
      const mg = margins(hasY2);
      return { rect, mg, plotW: Math.max(10, rect.width - mg.l - mg.r), plotH: Math.max(10, rect.height - mg.t - mg.b) };
    };
    const paint = () => renderCanvas();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { rect, mg, plotW, plotH } = geom();
      const win = interRef.current.panWin ?? resolveWindow(chart);
      if (!win) return;
      const tSpan = win.tMaxUs - win.tMinUs;
      const factor = e.deltaY > 0 ? 1.25 : 0.8;

      if (e.ctrlKey || e.metaKey) {
        // Y zoom under the cursor → manual range override for that axis.
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const axis: 'y1' | 'y2' =
          hasY2Local() && x > mg.l + plotW * 0.62 ? 'y2' : 'y1';
        const ax = resolveAxisRange(chart, axis, win);
        const vAt = ax.min + (1 - (y - mg.t) / plotH) * (ax.max - ax.min);
        const half = Math.max(((ax.max - ax.min) * factor) / 2, 1e-12);
        store.setYOverride(chart.id, axis, vAt - half, vAt + half);
        return;
      }

      // X zoom about the cursor.
      const frac = (e.clientX - rect.left - mg.l) / plotW;
      if (chart.live) {
        // LIVE keeps the head anchored right; zoom just rescales the span.
        store.setSpan(chart.id, Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, chart.spanUs * factor)));
      } else {
        const tAt = win.tMinUs + frac * tSpan;
        const newSpan = Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, tSpan * factor));
        store.freezeView(chart.id, tAt - frac * newSpan, tAt - frac * newSpan + newSpan);
      }
      function hasY2Local() {
        return chart.channels.some((c) => c.visible && c.axis === 'y2');
      }
    };

    const effCursorUs = (): { x1Us: number | null; x2Us: number | null } => {
      const c = cursorOverrideRef.current ?? cursorPair ?? { x1Us: null, x2Us: null };
      const win = resolveWindow(chart);
      if (chart.live && cursorFracRef.current && win) {
        const span = win.tMaxUs - win.tMinUs;
        return {
          x1Us: c.x1Us === null ? null : win.tMinUs + cursorFracRef.current.f1 * span,
          x2Us: c.x2Us === null ? null : win.tMinUs + cursorFracRef.current.f2 * span,
        };
      }
      return c;
    };

    const hitCursor = (x: number): 'c1' | 'c2' | null => {
      if (!cursorsOn) return null;
      const { mg, plotW } = geom();
      const win = resolveWindow(chart);
      if (!win) return null;
      const tSpan = win.tMaxUs - win.tMinUs;
      const cEff = effCursorUs();
      for (const [which, tUs] of [
        ['c2', cEff.x2Us],
        ['c1', cEff.x1Us],
      ] as const) {
        if (tUs === null) continue;
        const cx = mg.l + ((tUs - win.tMinUs) / tSpan) * plotW;
        if (Math.abs(x - cx) <= 8) return which;
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const { rect, mg, plotW } = geom();
      const x = e.clientX - rect.left;
      const win = resolveWindow(chart);
      if (!win || x < mg.l || x > mg.l + plotW) return;
      const tSpan = win.tMaxUs - win.tMinUs;
      const tAt = win.tMinUs + ((x - mg.l) / plotW) * tSpan;

      const cursorHit = hitCursor(x);
      if (cursorHit) {
        interRef.current = { drag: cursorHit, startX: x, panWin: null, boxUs: null };
        cursorOverrideRef.current = { ...(cursorPair ?? { x1Us: null, x2Us: null }) };
        // Seed fractions from the current effective positions so LIVE drags
        // re-anchor cleanly even if the window advanced since the last set.
        const eff = effCursorUs();
        const span = win.tMaxUs - win.tMinUs;
        cursorFracRef.current = {
          f1: eff.x1Us === null ? 0.3 : Math.min(1, Math.max(0, (eff.x1Us - win.tMinUs) / span)),
          f2: eff.x2Us === null ? 0.7 : Math.min(1, Math.max(0, (eff.x2Us - win.tMinUs) / span)),
        };
        return;
      }
      if (e.shiftKey) {
        interRef.current = { drag: 'box', startX: x, panWin: null, boxUs: { t0: tAt, t1: tAt } };
      } else {
        // Pan (a LIVE chart freezes at its current window first).
        interRef.current = { drag: 'pan', startX: x, panWin: { ...win }, boxUs: null };
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const { rect, mg, plotW } = geom();
      hoverRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const it = interRef.current;
      const win = resolveWindow(chart);
      if (!win) return;
      const tSpan = win.tMaxUs - win.tMinUs;
      const tAt = win.tMinUs + ((hoverRef.current.x - mg.l) / plotW) * tSpan;

      if (it.drag === 'pan' && it.panWin) {
        const dt = ((it.startX - hoverRef.current.x) / plotW) * tSpan;
        const span = it.panWin.tMaxUs - it.panWin.tMinUs;
        it.panWin = { tMinUs: it.panWin.tMinUs + dt, tMaxUs: it.panWin.tMinUs + dt + span };
      } else if (it.drag === 'box' && it.boxUs) {
        it.boxUs.t1 = tAt;
      } else if (it.drag === 'c1' || it.drag === 'c2') {
        const t = Math.min(win.tMaxUs, Math.max(win.tMinUs, tAt));
        const frac = (t - win.tMinUs) / (win.tMaxUs - win.tMinUs);
        if (cursorOverrideRef.current) {
          cursorOverrideRef.current[it.drag === 'c1' ? 'x1Us' : 'x2Us'] = t;
        }
        if (cursorFracRef.current) {
          cursorFracRef.current[it.drag === 'c1' ? 'f1' : 'f2'] = frac;
        }
      }
      paint();
    };

    const commitDrag = () => {
      const it = interRef.current;
      const win = resolveWindow(chart);
      if (it.drag === 'pan' && it.panWin && win) {
        store.freezeView(chart.id, it.panWin.tMinUs, it.panWin.tMaxUs);
        // Re-anchor parked cursors into the newly frozen window so they stay
        // visible instead of drifting outside their old absolute positions.
        if (cursorsOn && cursorFracRef.current) {
          const span = it.panWin.tMaxUs - it.panWin.tMinUs;
          store.setCursorX(chart.id, 'x1', it.panWin.tMinUs + cursorFracRef.current.f1 * span);
          store.setCursorX(chart.id, 'x2', it.panWin.tMinUs + cursorFracRef.current.f2 * span);
        }
      } else if (it.drag === 'box' && it.boxUs && win) {
        const tSpan = win.tMaxUs - win.tMinUs;
        const lo = Math.min(it.boxUs.t0, it.boxUs.t1);
        const hi = Math.max(it.boxUs.t0, it.boxUs.t1);
        if (hi - lo > tSpan * 0.01) store.freezeView(chart.id, lo, hi); // ignore tiny accidental boxes
      } else if ((it.drag === 'c1' || it.drag === 'c2') && cursorOverrideRef.current) {
        store.setCursorX(chart.id, it.drag === 'c1' ? 'x1' : 'x2', cursorOverrideRef.current[it.drag === 'c1' ? 'x1Us' : 'x2Us']);
      }
      interRef.current = { drag: null, startX: 0, panWin: null, boxUs: null };
      cursorOverrideRef.current = null;
      paint();
    };

    const onMouseUp = () => commitDrag();
    const onMouseLeave = () => {
      hoverRef.current = null;
      commitDrag();
    };
    const onDblClick = () => {
      store.setYOverride(chart.id, 'y1', null, null);
      store.setYOverride(chart.id, 'y2', null, null);
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
  }, [chart, cursorPair, cursorsOn, renderCanvas]);

  const catalog = useMemo(() => {
    void catalogVersion;
    // Recompute when the menu opens — the memo's mount-time snapshot can
    // predate the first ingested packets, showing a phantom "none seen yet".
    void addMenuOpen;
    return plotEngine.catalogList();
  }, [catalogVersion, addMenuOpen]);

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
    usePlotStore.getState().addChannel(chart.id, { kind: 'meta', metric }, { label: metric, unit });
    setAddMenuOpen(false);
  };

  const toggleCursors = () => {
    if (!chart) return;
    const store = usePlotStore.getState();
    if (cursorsOn) {
      store.setCursorX(chart.id, 'x1', null);
      store.setCursorX(chart.id, 'x2', null);
      cursorFracRef.current = null;
    } else {
      const win = resolveWindow(chart);
      if (!win) return;
      const span = win.tMaxUs - win.tMinUs;
      cursorFracRef.current = { f1: 0.3, f2: 0.7 };
      store.setCursorX(chart.id, 'x1', win.tMinUs + span * 0.3);
      store.setCursorX(chart.id, 'x2', win.tMinUs + span * 0.7);
    }
  };

  // ---- export --------------------------------------------------------------
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
    const win = resolveWindow(chart);
    const vis = chart.channels.filter((c) => c.visible);
    if (!win || vis.length === 0) {
      toast.warn('Nothing to export', 'add visible channels with samples first');
      return;
    }
    const master = plotEngine.getWindowSamples(vis[0].id, win.tMinUs, win.tMaxUs, 100_000);
    if (master.length === 0) {
      toast.warn('No samples in the current window');
      return;
    }
    // Median inter-sample gap doubles as the nearest-sample alignment
    // tolerance for the secondary channels' columns.
    const mid = Math.floor(master.length / 2);
    const medDt = master.length > 1 ? Math.abs(master[mid].tUs - master[mid - 1].tUs) : 1e6;
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

  // ---- expression channels -------------------------------------------------
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

  // Window stats for the footer (recomputed per render + 2 Hz tick while live).
  // The tick state must be a dependency: with only [chart], the memo returned
  // the values from the last config change and the strip froze while the chart
  // streamed (F-42) — the sibling catalog memo had the identical miss.
  const statsRows = useMemo(() => {
    void statsTick;
    if (!chart) return [];
    const win = resolveWindow(chart);
    if (!win) return [];
    return chart.channels
      .filter((c) => c.visible)
      .map((c) => ({ ch: c, stats: plotEngine.getStats(c.id, win.tMinUs, win.tMaxUs) }));
  }, [chart, statsTick]);

  if (!chart) return null;

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Chart tabs */}
      <div className="h-[26px] flex items-center gap-1 px-1.5 bg-bf-head border-b border-bf-line overflow-x-auto shrink-0">
        {charts.map((c) => (
          <span
            key={c.id}
            className={`group flex items-center gap-1 px-2 py-0.5 rounded-sm border text-[9.5px] tracking-wider whitespace-nowrap cursor-pointer ${
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
                className="w-24 bg-bf-canvas border border-bf-cyan rounded-sm px-1 text-[9.5px] text-bf-bright outline-none"
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
      </div>

      {/* Ribbon */}
      <div className="h-[26px] flex items-center gap-2 px-2 bg-bf-subpanel border-b border-bf-line shrink-0">
        <button
          onClick={() => {
            if (chart.live) {
              // Freeze on the window being displayed right now: setLive alone
              // cleared the frozen window, so the chart kept tracking the head
              // on the next paint and CSV exported rows the user never saw (F-40).
              const win = resolveWindow(chart);
              if (win && win.tMaxUs > win.tMinUs) {
                usePlotStore.getState().freezeView(chart.id, win.tMinUs, win.tMaxUs);
              } else {
                usePlotStore.getState().setLive(chart.id, false);
              }
            } else {
              usePlotStore.getState().setLive(chart.id, true);
            }
          }}
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
          <span className="px-1 text-[9.5px] text-bf-body font-mono w-[52px] text-center">{fmtSpan(chart.spanUs)}</span>
          <button className="px-1 text-bf-dim hover:text-bf-bright" onClick={() => usePlotStore.getState().setSpan(chart.id, stepSpan(chart.spanUs, 1))}>
            <Plus size={10} />
          </button>
        </div>
        <button onClick={toggleCursors} className={cursorsOn ? ribbonActive : ribbonBtn} data-tooltip="X measurement cursors — drag X1/X2 for Δt and frequency">
          X CURSORS
        </button>
        <div className="flex items-center rounded border border-bf-line overflow-hidden shrink-0" data-tooltip="Chart mode">
          {(['time', 'fft', 'xy', 'hist'] as const).map((m) => (
            <button
              key={m}
              onClick={() => usePlotStore.getState().setChartMode(chart.id, m)}
              className={`px-1.5 py-0.5 text-[9px] tracking-wider ${chart.mode === m ? 'bg-bf-btn-hi text-bf-bright' : 'bg-bf-panel text-bf-dim hover:bg-bf-btn'}`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        {chart.mode === 'fft' && (
          <>
            <select
              value={chart.fftSize}
              onChange={(e) => usePlotStore.getState().setFftConfig(chart.id, { fftSize: Number(e.target.value) })}
              className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[9.5px] text-bf-body"
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
          </>
        )}
        {chart.mode === 'xy' && (
          <select
            value={chart.xyXChannelId ?? ''}
            onChange={(e) => usePlotStore.getState().setXyXChannel(chart.id, e.target.value || null)}
            className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[9.5px] text-bf-body"
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
              className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[9.5px] text-bf-body"
              data-tooltip="Histogram source channel"
            >
              <option value="">Source…</option>
              {chart.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-0.5 border border-bf-line rounded bg-bf-panel" data-tooltip="Bin count">
              <button
                className="px-1 text-bf-dim hover:text-bf-bright"
                onClick={() => usePlotStore.getState().setHistConfig(chart.id, { bins: Math.max(HIST_BINS_MIN, Math.round(chart.histBins / 2)) })}
              >
                <Minus size={10} />
              </button>
              <span className="px-1 text-[9.5px] font-mono w-6 text-center">{chart.histBins}</span>
              <button
                className="px-1 text-bf-dim hover:text-bf-bright"
                onClick={() => usePlotStore.getState().setHistConfig(chart.id, { bins: Math.min(HIST_BINS_MAX, chart.histBins * 2) })}
              >
                <Plus size={10} />
              </button>
            </div>
          </>
        )}
        <span className="text-bf-faint text-[9px] hidden xl:inline">
          {chart.live && chart.mode === 'time' ? 'FOLLOWING HEAD' : chart.frozen && chart.mode === 'time' ? `WINDOW ${fmtTimeUs(chart.frozen.tMinUs)} … ${fmtTimeUs(chart.frozen.tMaxUs)}` : ''}
          {' · wheel zoom · drag pan · ⇧drag box · dbl-click autoscale'}
        </span>
        <button onClick={exportCsv} className={`${ribbonBtn} shrink-0`} data-tooltip="Export the visible channels over the current window as CSV">
          CSV
        </button>
        <button onClick={exportPng} className={`${ribbonBtn} shrink-0`} data-tooltip="Save the chart canvas as a PNG image">
          PNG
        </button>
        <div className="ml-auto flex items-center gap-1.5 text-bf-faint text-[9px]" data-tooltip="Ring depth per channel — older samples drop off">
          DEPTH
          <select
            value={plotDepth}
            onChange={(e) => usePlotStore.getState().setPlotDepth(Number(e.target.value))}
            className="bg-bf-panel border border-bf-line rounded px-0.5 py-[1px] text-[9.5px] text-bf-body"
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
            className="flex items-center gap-1 pl-1 pr-0.5 py-px rounded border border-bf-line bg-bf-subpanel text-[9.5px]"
          >
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: ch.color, boxShadow: `0 0 4px ${ch.color}` }} />
            <button
              className="text-bf-body hover:text-bf-bright"
              onClick={() => usePlotStore.getState().toggleChannelVisible(chart.id, ch.id)}
              data-tooltip={ch.visible ? 'Hide channel' : 'Show channel'}
            >
              {ch.label}
              {ch.unit ? <span className="text-bf-faint"> ({ch.unit})</span> : null}
            </button>
            <button
              onClick={() => usePlotStore.getState().updateChannel(chart.id, ch.id, { axis: ch.axis === 'y1' ? 'y2' : 'y1' })}
              className={`px-0.5 rounded-sm text-[8.5px] border ${
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
        <div className="relative">
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className={`flex items-center gap-1 px-1.5 py-px rounded border text-[9.5px] ${
              addMenuOpen ? 'bg-bf-btn-hi text-bf-bright border-bf-cyan' : 'border-bf-line bg-bf-panel text-bf-cyan hover:bg-bf-btn'
            }`}
            data-tooltip="Plot a decoded field, packet metric or expression"
          >
            <Plus size={10} /> ADD CHANNEL
          </button>
          {addMenuOpen && (
            <div className="absolute z-[500] top-[22px] left-0 w-64 max-h-72 overflow-y-auto bg-bf-surface border border-bf-line-strong rounded shadow-xl text-[10px]">
              <div className="px-2 py-1 text-[9px] tracking-wider text-bf-faint border-b border-bf-line">PACKET METRICS</div>
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
              <div className="px-2 py-1 text-[9px] tracking-wider text-bf-faint border-b border-bf-line">
                DECODED FIELDS {catalog.length === 0 ? '(none seen yet)' : `(${catalog.length})`}
              </div>
              {catalog.map((e) => (
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
              <div className="px-2 py-1 text-[9px] tracking-wider text-bf-faint border-t border-bf-line">EXPRESSION</div>
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
                    placeholder="e.g. v_batt_mv * gyro_z"
                    className="w-full bg-bf-canvas border border-bf-line rounded-sm px-1 py-0.5 text-[10px] font-mono text-bf-bright outline-none focus:border-bf-cyan"
                  />
                  {exprValue.trim() === '' ? (
                    <div className="text-[9px] text-bf-faint">Refs resolve to channel labels (e.g. v_batt_mv, rate).</div>
                  ) : exprOk ? (
                    <div className="text-[9px] text-bf-ok">OK · refs: {exprOk.refs.length ? exprOk.refs.join(', ') : 'none'}</div>
                  ) : (
                    <div className="text-[9px] text-bf-fault">{exprErr}</div>
                  )}
                  <button
                    onClick={addExprChannel}
                    disabled={!exprOk}
                    className="w-full py-0.5 rounded-sm bg-bf-btn-hi border border-bf-cyan text-bf-bright text-[9.5px] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ADD EXPRESSION CHANNEL
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {chart.channels.length === 0 && (
          <span className="text-bf-faint text-[9.5px]">Plot any decoded field, frame metric or derived expression.</span>
        )}
      </div>

      {/* Canvas */}
      <div ref={wrapRef} className="relative flex-1 min-h-0 cursor-crosshair">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>

      {/* Footer: per-channel window stats (time) or mode summary */}
      <div className="min-h-[20px] flex items-center gap-3 px-2 py-0.5 bg-bf-subpanel border-t border-bf-line text-[9px] shrink-0 overflow-x-auto whitespace-nowrap">
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
            {chart.mode === 'fft' && `FFT · n=${chart.fftSize} newest samples · ${chart.fftDb ? 'dB magnitude' : 'linear magnitude'} · Hann window, detrended`}
            {chart.mode === 'xy' && `XY · X: ${chart.channels.find((c) => c.id === chart.xyXChannelId)?.label ?? '(first channel)'} · pairs aligned by index from the newest 5000 samples`}
            {chart.mode === 'hist' && `HIST · source: ${chart.channels.find((c) => c.id === chart.histChannelId)?.label ?? '(first channel)'} · ${chart.histBins} bins over the newest ${chart.fftSize} samples`}
          </span>
        )}
      </div>
    </div>
  );
};
