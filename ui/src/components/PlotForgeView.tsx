import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Minus, Pause, Play, Plus, X } from 'lucide-react';
import { usePlotStore } from '../store/usePlotStore';
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
 * changes, never on data arrival. The rAF loop idles when the chart is
 * frozen (repaints only on config/state changes), like the scope's RUN/STOP.
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
// Painter: one frame of the active chart (time mode).
// ---------------------------------------------------------------------------

interface ViewWindow {
  tMinUs: number;
  tMaxUs: number;
}

interface AxisRange {
  min: number;
  max: number;
}

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

export const PlotForgeView: React.FC = () => {
  const { charts, activeChartId, plotDepth } = usePlotStore(
    useShallow((s) => ({
      charts: s.charts,
      activeChartId: s.activeChartId,
      plotDepth: s.plotDepth,
    }))
  );
  const store = usePlotStore.getState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);

  const chart = charts.find((c) => c.id === activeChartId) ?? charts[0];

  // Field catalog grows as packets flow — resample the picker list at 2 Hz
  // while the menu is open (cheap; catalog is capped at 512 entries).
  useEffect(() => {
    if (!addMenuOpen) return;
    const t = setInterval(() => setCatalogVersion((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [addMenuOpen]);

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
    // Axis margins: left hosts Y1 labels, right hosts Y2 (when present).
    const hasY2 = chart.channels.some((c) => c.visible && c.axis === 'y2');
    const margin = { l: 44, r: hasY2 ? 44 : 12, t: 8, b: 18 };
    const plotW = Math.max(10, W - margin.l - margin.r);
    const plotH = Math.max(10, H - margin.t - margin.b);

    ctx.fillStyle = pal.canvas;
    ctx.fillRect(0, 0, W, H);

    const win = resolveWindow(chart);
    const tSpan = win ? Math.max(1e-9, win.tMaxUs - win.tMinUs) : 1;
    const xOf = (tUs: number) => margin.l + ((tUs - (win?.tMinUs ?? 0)) / tSpan) * plotW;

    // Graticule: 10 cols × 8 rows (scope layout).
    ctx.lineWidth = 1;
    ctx.strokeStyle = pal.gridMinor;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    for (let c = 1; c < 10; c++) {
      const x = Math.round(margin.l + (plotW * c) / 10) + 0.5;
      ctx.moveTo(x, margin.t);
      ctx.lineTo(x, margin.t + plotH);
    }
    for (let r = 1; r < 8; r++) {
      const y = Math.round(margin.t + (plotH * r) / 8) + 0.5;
      ctx.moveTo(margin.l, y);
      ctx.lineTo(margin.l + plotW, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = pal.grid;
    ctx.strokeRect(margin.l + 0.5, margin.t + 0.5, plotW - 1, plotH - 1);

    // Tick labels.
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = pal.textFaint;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (win) {
      for (let c = 0; c <= 10; c += 2) {
        const t = win.tMinUs + (tSpan * c) / 10;
        ctx.fillText(fmtTimeUs(t), margin.l + (plotW * c) / 10, margin.t + plotH + 3);
      }
    }

    if (!chart.channels.some((c) => c.visible)) {
      ctx.fillStyle = pal.textFaint;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        chart.channels.length === 0 ? 'NO CHANNELS — USE "+ ADD CHANNEL"' : 'ALL CHANNELS HIDDEN',
        margin.l + plotW / 2,
        margin.t + plotH / 2
      );
      return;
    }
    if (!win) return;

    const y1 = resolveAxisRange(chart, 'y1', win);
    const y2 = resolveAxisRange(chart, 'y2', win);
    const yOf = (v: number, ax: AxisRange) => margin.t + plotH - ((v - ax.min) / (ax.max - ax.min)) * plotH;

    // Y labels: Y1 left, Y2 right.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.textDim;
    for (let r = 0; r <= 8; r += 2) {
      const v = y1.max - ((y1.max - y1.min) * r) / 8;
      ctx.fillText(fmtValue(v), margin.l - 4, margin.t + (plotH * r) / 8);
    }
    if (hasY2) {
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.textDim;
      for (let r = 0; r <= 8; r += 2) {
        const v = y2.max - ((y2.max - y2.min) * r) / 8;
        ctx.fillText(fmtValue(v), margin.l + plotW + 4, margin.t + (plotH * r) / 8);
      }
    }

    // Channels: min-max decimated polylines (bucket per pixel column).
    const buckets = Math.max(10, Math.floor(plotW));
    let drewAny = false;
    for (const ch of chart.channels) {
      if (!ch.visible) continue;
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
      ctx.fillText('AWAITING DATA…', margin.l + plotW / 2, margin.t + plotH / 2);
    }
  }, [chart]);

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

  if (!chart) return null;

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Chart tabs */}
      <div className="h-[26px] flex items-center gap-1 px-1.5 bg-bf-head border-b border-bf-line overflow-x-auto shrink-0">
        {charts.map((c) => (
          <button
            key={c.id}
            onClick={() => store.setActiveChart(c.id)}
            className={`px-2 py-0.5 rounded-sm border text-[9.5px] tracking-wider whitespace-nowrap ${
              c.id === chart.id
                ? 'bg-bf-btn-hi text-bf-bright border-bf-cyan'
                : 'bg-bf-panel text-bf-dim border-bf-line hover:bg-bf-btn'
            }`}
          >
            {c.name.toUpperCase()}
          </button>
        ))}
        <button
          onClick={() => store.addChart()}
          data-tooltip="New chart tab"
          className="p-0.5 rounded-sm border border-bf-line bg-bf-panel text-bf-dim hover:bg-bf-btn hover:text-bf-bright shrink-0"
        >
          <Plus size={11} />
        </button>
      </div>

      {/* Ribbon */}
      <div className="h-[26px] flex items-center gap-2 px-2 bg-bf-subpanel border-b border-bf-line shrink-0">
        <button
          onClick={() => store.setLive(chart.id, !chart.live)}
          className={chart.live ? ribbonActive : ribbonBtn}
          data-tooltip={chart.live ? 'Following newest samples — click to freeze the view' : 'Frozen view — click to resume live follow'}
        >
          {chart.live ? <Pause size={10} /> : <Play size={10} />}
          {chart.live ? 'LIVE' : 'FROZEN'}
        </button>
        <button onClick={() => store.fitView(chart.id)} className={ribbonBtn} data-tooltip="Zoom to full data extent">
          FIT
        </button>
        <div className="flex items-center gap-0.5 border border-bf-line rounded bg-bf-panel" data-tooltip="X window span (1-2-5 presets)">
          <button className="px-1 text-bf-dim hover:text-bf-bright" onClick={() => store.setSpan(chart.id, stepSpan(chart.spanUs, -1))}>
            <Minus size={10} />
          </button>
          <span className="px-1 text-[9.5px] text-bf-body font-mono w-[52px] text-center">{fmtSpan(chart.spanUs)}</span>
          <button className="px-1 text-bf-dim hover:text-bf-bright" onClick={() => store.setSpan(chart.id, stepSpan(chart.spanUs, 1))}>
            <Plus size={10} />
          </button>
        </div>
        <span className="text-bf-faint text-[9px]">
          {chart.live ? 'FOLLOWING HEAD' : chart.frozen ? `WINDOW ${fmtTimeUs(chart.frozen.tMinUs)} … ${fmtTimeUs(chart.frozen.tMaxUs)}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1.5 text-bf-faint text-[9px]" data-tooltip="Ring depth per channel — older samples drop off">
          DEPTH
          <select
            value={plotDepth}
            onChange={(e) => store.setPlotDepth(Number(e.target.value))}
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
              onClick={() => store.toggleChannelVisible(chart.id, ch.id)}
              data-tooltip={ch.visible ? 'Hide channel' : 'Show channel'}
            >
              {ch.label}
              {ch.unit ? <span className="text-bf-faint"> ({ch.unit})</span> : null}
            </button>
            <button
              onClick={() => store.updateChannel(chart.id, ch.id, { axis: ch.axis === 'y1' ? 'y2' : 'y1' })}
              className={`px-0.5 rounded-sm text-[8.5px] border ${
                ch.axis === 'y2' ? 'border-bf-math text-bf-math' : 'border-bf-line text-bf-faint'
              }`}
              data-tooltip="Toggle left (Y1) / right (Y2) axis"
            >
              {ch.axis.toUpperCase()}
            </button>
            <button
              onClick={() => store.toggleChannelVisible(chart.id, ch.id)}
              className="text-bf-faint hover:text-bf-bright px-0.5"
              data-tooltip={ch.visible ? 'Hide channel' : 'Show channel'}
            >
              {ch.visible ? <Eye size={10} /> : <EyeOff size={10} />}
            </button>
            <button
              onClick={() => store.removeChannel(chart.id, ch.id)}
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
              <div className="px-2 py-1 text-[9px] tracking-wider text-bf-faint border-t border-bf-line text-bf-faint">
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
      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>

      {/* Footer readout */}
      <div className="h-[20px] flex items-center gap-3 px-2 bg-bf-subpanel border-t border-bf-line text-[9px] text-bf-faint shrink-0">
        <span>{chart.channels.filter((c) => c.visible).length} CH PLOTTED</span>
        <span className="text-bf-dim">{chart.name}</span>
        <span className="ml-auto">FEED: {plotEngine.dataVersion > 0 ? 'STREAMING' : 'IDLE'}</span>
      </div>
    </div>
  );
};
