import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Minus, Pause, Play, Plus, X } from 'lucide-react';
import { usePlotStore, SPAN_MIN_US, SPAN_MAX_US } from '../store/usePlotStore';
import { useShallow } from 'zustand/react/shallow';
import { plotEngine, PLOT_DEPTH_MAX, PLOT_DEPTH_MIN } from '../plot/engine';
import { plotPalette } from '../plot/palette';
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
 * Interactions:
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
  const [, setStatsTick] = useState(0);
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
    for (let r = 0; r <= 8; r += 2) {
      const v = y1.max - ((y1.max - y1.min) * r) / 8;
      ctx.fillText(fmtValue(v), mg.l - 4, mg.t + (plotH * r) / 8);
    }
    if (hasY2) {
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.textDim;
      for (let r = 0; r <= 8; r += 2) {
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

    // X cursors (store positions, or the in-drag override).
    const cEff = cursorOverrideRef.current ?? cursorPair ?? { x1Us: null, x2Us: null };
    const cursorXs: Array<{ x: number; label: string }> = [];
    if (cursorsOn) {
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      for (const [which, tUs] of [
        ['X1', cEff.x1Us],
        ['X2', cEff.x2Us],
      ] as const) {
        if (tUs === null) continue;
        const x = xOf(tUs);
        if (x < mg.l - 1 || x > mg.l + plotW + 1) continue;
        ctx.strokeStyle = pal.cursor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, mg.t);
        ctx.lineTo(Math.round(x) + 0.5, mg.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = pal.cursor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(which, x + 3, mg.t + 2);
        cursorXs.push({ x, label: which });
      }
      if (cEff.x1Us !== null && cEff.x2Us !== null) {
        const dtUs = Math.abs(cEff.x2Us - cEff.x1Us);
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

    const hitCursor = (x: number): 'c1' | 'c2' | null => {
      if (!cursorsOn) return null;
      const { mg, plotW } = geom();
      const win = resolveWindow(chart);
      if (!win) return null;
      const tSpan = win.tMaxUs - win.tMinUs;
      const cEff = cursorOverrideRef.current ?? cursorPair ?? { x1Us: null, x2Us: null };
      for (const [which, tUs] of [
        ['c2', cEff.x2Us],
        ['c1', cEff.x1Us],
      ] as const) {
        if (tUs === null) continue;
        const cx = mg.l + ((tUs - win.tMinUs) / tSpan) * plotW;
        if (Math.abs(x - cx) <= 6) return which;
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
        if (cursorOverrideRef.current) {
          cursorOverrideRef.current[it.drag === 'c1' ? 'x1Us' : 'x2Us'] = t;
        }
      }
      paint();
    };

    const commitDrag = () => {
      const it = interRef.current;
      const win = resolveWindow(chart);
      if (it.drag === 'pan' && it.panWin && win) {
        store.freezeView(chart.id, it.panWin.tMinUs, it.panWin.tMaxUs);
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
    return plotEngine.catalogList();
  }, [catalogVersion]);

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
    } else {
      const win = resolveWindow(chart);
      if (!win) return;
      const span = win.tMaxUs - win.tMinUs;
      store.setCursorX(chart.id, 'x1', win.tMinUs + span * 0.3);
      store.setCursorX(chart.id, 'x2', win.tMinUs + span * 0.7);
    }
  };

  const commitRename = () => {
    if (renamingId) usePlotStore.getState().renameChart(renamingId, renameValue);
    setRenamingId(null);
  };

  // Window stats for the footer (recomputed per render + 2 Hz tick while live).
  const statsRows = useMemo(() => {
    if (!chart) return [];
    const win = resolveWindow(chart);
    if (!win) return [];
    return chart.channels
      .filter((c) => c.visible)
      .map((c) => ({ ch: c, stats: plotEngine.getStats(c.id, win.tMinUs, win.tMaxUs) }));
  }, [chart]);

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
          onClick={() => usePlotStore.getState().setLive(chart.id, !chart.live)}
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
        <span className="text-bf-faint text-[9px] hidden xl:inline">
          {chart.live ? 'FOLLOWING HEAD' : chart.frozen ? `WINDOW ${fmtTimeUs(chart.frozen.tMinUs)} … ${fmtTimeUs(chart.frozen.tMaxUs)}` : ''}
          {' · wheel zoom · drag pan · ⇧drag box · dbl-click autoscale'}
        </span>
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
              <div className="px-2 py-1 text-[9px] tracking-wider text-bf-faint border-t border-bf-line">
                Expression channels land with the FFT/XY update
              </div>
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

      {/* Footer: per-channel window stats */}
      <div className="min-h-[20px] flex items-center gap-3 px-2 py-0.5 bg-bf-subpanel border-t border-bf-line text-[9px] shrink-0 overflow-x-auto whitespace-nowrap">
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
      </div>
    </div>
  );
};
