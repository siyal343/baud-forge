import { create } from 'zustand';

/**
 * Plot Forge reactive config — chart tabs, channel definitions, view state
 * and cursors. Sample data NEVER flows through here (see plot/engine.ts);
 * the painter reads rings imperatively inside its rAF loop, so this store
 * only re-renders on user config changes.
 *
 * Persistence follows the manual-localStorage idiom of useSettingsStore:
 * one versioned JSON blob, merged through a validating pure function.
 */

import type { ChartDef, ChannelDef, ChannelSource, ChartMode, CursorPair } from '../plot/types';
import { nextPlotColor } from '../plot/palette';
import {
  plotEngine,
  PLOT_DEPTH_MIN,
  PLOT_DEPTH_MAX,
  PLOT_DEPTH_DEFAULT,
  MAX_ENGINE_CHANNELS,
} from '../plot/engine';

const STORAGE_KEY = 'bforge_plot_cfg_v1';
const CONFIG_VERSION = 1;

export const CHART_NAME_MAX = 40;
export const CHANNEL_NAME_MAX = 48;
export const MAX_CHARTS = 12;
export const MAX_CHANNELS_PER_CHART = 16;
export const SPAN_MIN_US = 1_000; // 1 ms
export const SPAN_MAX_US = 3_600_000_000; // 1 h
export const DEFAULT_SPAN_US = 10_000_000; // 10 s
export const FFT_SIZES = [256, 512, 1024, 2048];
export const HIST_BINS_MIN = 4;
export const HIST_BINS_MAX = 256;

const CHART_MODES: ChartMode[] = ['time', 'fft', 'xy', 'hist'];
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

let idCounter = 1;
const genId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export const makeDefaultChart = (name: string): ChartDef => ({
  id: genId('chart'),
  name,
  mode: 'time',
  channels: [],
  live: true,
  spanUs: DEFAULT_SPAN_US,
  frozen: null,
  y1Min: null,
  y1Max: null,
  y2Min: null,
  y2Max: null,
  fftSize: 1024,
  fftDb: true,
  xyXChannelId: null,
  histBins: 32,
  histChannelId: null,
});

// ---- validation -----------------------------------------------------------

const clampInt = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fb;
  return Math.min(hi, Math.max(lo, n));
};

const optNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const validSource = (s: unknown): ChannelSource | null => {
  if (!s || typeof s !== 'object') return null;
  const src = s as Record<string, unknown>;
  if (src.kind === 'field' && typeof src.name === 'string' && src.name.trim())
    return { kind: 'field', name: src.name };
  if (
    src.kind === 'meta' &&
    (src.metric === 'length' || src.metric === 'delta' || src.metric === 'rate')
  )
    return { kind: 'meta', metric: src.metric };
  if (src.kind === 'expr' && typeof src.source === 'string' && src.source.trim())
    return { kind: 'expr', source: src.source };
  return null;
};

const validChannel = (c: unknown): ChannelDef | null => {
  if (!c || typeof c !== 'object') return null;
  const ch = c as Record<string, unknown>;
  const source = validSource(ch.source);
  if (typeof ch.id !== 'string' || !ch.id || !source) return null;
  return {
    id: ch.id,
    label:
      typeof ch.label === 'string' && ch.label.trim()
        ? ch.label.slice(0, CHANNEL_NAME_MAX)
        : 'channel',
    source,
    color: typeof ch.color === 'string' && HEX_COLOR.test(ch.color) ? ch.color : '#A855F7',
    visible: ch.visible !== false,
    axis: ch.axis === 'y2' ? 'y2' : 'y1',
    unit: typeof ch.unit === 'string' ? ch.unit : undefined,
  };
};

const validChart = (c: unknown): ChartDef | null => {
  if (!c || typeof c !== 'object') return null;
  const ch = c as Record<string, unknown>;
  if (typeof ch.id !== 'string' || !ch.id) return null;
  const channels = Array.isArray(ch.channels)
    ? ch.channels.slice(0, MAX_CHANNELS_PER_CHART).map(validChannel).filter((x): x is ChannelDef => x !== null)
    : [];
  const frozen =
    ch.frozen &&
    typeof ch.frozen === 'object' &&
    Number.isFinite((ch.frozen as Record<string, unknown>).tMinUs) &&
    Number.isFinite((ch.frozen as Record<string, unknown>).tMaxUs)
      ? {
          tMinUs: (ch.frozen as Record<string, number>).tMinUs,
          tMaxUs: (ch.frozen as Record<string, number>).tMaxUs,
        }
      : null;
  return {
    id: ch.id,
    name: typeof ch.name === 'string' && ch.name.trim() ? ch.name.slice(0, CHART_NAME_MAX) : 'Chart',
    mode: CHART_MODES.includes(ch.mode as ChartMode) ? (ch.mode as ChartMode) : 'time',
    channels,
    live: ch.live !== false,
    spanUs: clampInt(ch.spanUs, SPAN_MIN_US, SPAN_MAX_US, DEFAULT_SPAN_US),
    frozen: frozen && frozen.tMaxUs > frozen.tMinUs ? frozen : null,
    y1Min: optNum(ch.y1Min),
    y1Max: optNum(ch.y1Max),
    y2Min: optNum(ch.y2Min),
    y2Max: optNum(ch.y2Max),
    fftSize: FFT_SIZES.includes(ch.fftSize as number) ? (ch.fftSize as number) : 1024,
    fftDb: ch.fftDb !== false,
    xyXChannelId: typeof ch.xyXChannelId === 'string' ? ch.xyXChannelId : null,
    histBins: clampInt(ch.histBins, HIST_BINS_MIN, HIST_BINS_MAX, 32),
    histChannelId: typeof ch.histChannelId === 'string' ? ch.histChannelId : null,
  };
};

const validCursor = (c: unknown): CursorPair => {
  const p = (c ?? {}) as Record<string, unknown>;
  return {
    x1Us: optNum(p.x1Us),
    x2Us: optNum(p.x2Us),
  };
};

export interface PlotConfig {
  charts: ChartDef[];
  activeChartId: string;
  cursors: Record<string, CursorPair>;
  plotDepth: number;
}

/** Pure merge: defaults → saved blob. Corrupt entries are dropped, never fatal. */
export const mergePlotConfig = (saved: unknown): PlotConfig => {
  const fallback: PlotConfig = {
    charts: [makeDefaultChart('Chart 1')],
    activeChartId: '',
    cursors: {},
    plotDepth: PLOT_DEPTH_DEFAULT,
  };
  fallback.activeChartId = fallback.charts[0].id;
  if (!saved || typeof saved !== 'object') return fallback;
  const s = saved as Record<string, unknown>;
  const charts = Array.isArray(s.charts)
    ? s.charts.slice(0, MAX_CHARTS).map(validChart).filter((x): x is ChartDef => x !== null)
    : [];
  if (charts.length === 0) return fallback;
  const ids = new Set(charts.map((c) => c.id));
  const activeChartId =
    typeof s.activeChartId === 'string' && ids.has(s.activeChartId) ? s.activeChartId : charts[0].id;
  const cursors: Record<string, CursorPair> = {};
  if (s.cursors && typeof s.cursors === 'object') {
    for (const [id, c] of Object.entries(s.cursors as Record<string, unknown>)) {
      if (ids.has(id)) cursors[id] = validCursor(c);
    }
  }
  return {
    charts,
    activeChartId,
    cursors,
    plotDepth: clampInt(s.plotDepth, PLOT_DEPTH_MIN, PLOT_DEPTH_MAX, PLOT_DEPTH_DEFAULT),
  };
};

const loadConfig = (): PlotConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.version === CONFIG_VERSION) {
        return mergePlotConfig(parsed);
      }
    }
  } catch (_) {}
  return mergePlotConfig(null);
};

// ---- store -----------------------------------------------------------------

interface PlotState extends PlotConfig {
  // Chart tabs
  addChart: (name?: string) => string;
  removeChart: (chartId: string) => void;
  renameChart: (chartId: string, name: string) => void;
  setActiveChart: (chartId: string) => void;
  // Channels
  addChannel: (chartId: string, source: ChannelSource, opts?: { label?: string; unit?: string }) => string | null;
  removeChannel: (chartId: string, channelId: string) => void;
  updateChannel: (chartId: string, channelId: string, partial: Partial<Omit<ChannelDef, 'id' | 'source'>>) => void;
  setChannelSource: (chartId: string, channelId: string, source: ChannelSource) => void;
  toggleChannelVisible: (chartId: string, channelId: string) => void;
  // View
  setChartMode: (chartId: string, mode: ChartMode) => void;
  setLive: (chartId: string, live: boolean) => void;
  setSpan: (chartId: string, spanUs: number) => void;
  freezeView: (chartId: string, tMinUs: number, tMaxUs: number) => void;
  fitView: (chartId: string) => void;
  setYOverride: (chartId: string, axis: 'y1' | 'y2', min: number | null, max: number | null) => void;
  setFftConfig: (chartId: string, cfg: { fftSize?: number; fftDb?: boolean }) => void;
  setHistConfig: (chartId: string, cfg: { bins?: number; channelId?: string | null }) => void;
  setXyXChannel: (chartId: string, channelId: string | null) => void;
  // Cursors
  setCursorX: (chartId: string, which: 'x1' | 'x2', tUs: number | null) => void;
  // Global
  setPlotDepth: (depth: number) => void;
  resetPanel: () => void;
}

const persist = (state: PlotConfig): void => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: CONFIG_VERSION, ...state })
    );
  } catch (_) {}
};

const patchChart = (charts: ChartDef[], chartId: string, fn: (c: ChartDef) => ChartDef): ChartDef[] =>
  charts.map((c) => (c.id === chartId ? fn(c) : c));

export const usePlotStore = create<PlotState>((set, get) => {
  // Sync the engine with whatever config survived a reload.
  const initial = loadConfig();
  plotEngine.setDepth(initial.plotDepth);
  plotEngine.syncFromCharts(initial.charts);

  const commitCharts = (charts: ChartDef[], extra?: Partial<PlotConfig>) => {
    const next: PlotConfig = {
      charts,
      activeChartId: get().activeChartId,
      cursors: get().cursors,
      plotDepth: get().plotDepth,
      ...extra,
    };
    persist(next);
    set(next);
  };

  return {
    ...initial,

    addChart: (name) => {
      const charts = get().charts;
      if (charts.length >= MAX_CHARTS) return charts[get().charts.length - 1].id;
      const chart = makeDefaultChart(name?.trim().slice(0, CHART_NAME_MAX) || `Chart ${charts.length + 1}`);
      commitCharts([...charts, chart], { activeChartId: chart.id });
      return chart.id;
    },

    removeChart: (chartId) => {
      const charts = get().charts;
      if (charts.length <= 1) return; // always keep one chart
      const victim = charts.find((c) => c.id === chartId);
      if (!victim) return;
      for (const ch of victim.channels) plotEngine.removeChannel(ch.id);
      const next = charts.filter((c) => c.id !== chartId);
      const cursors = { ...get().cursors };
      delete cursors[chartId];
      const activeChartId =
        get().activeChartId === chartId ? next[next.length - 1].id : get().activeChartId;
      commitCharts(next, { activeChartId, cursors });
    },

    renameChart: (chartId, name) => {
      const clean = name.trim().slice(0, CHART_NAME_MAX) || 'Chart';
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, name: clean })));
    },

    setActiveChart: (chartId) => {
      if (get().charts.some((c) => c.id === chartId)) {
        commitCharts(get().charts, { activeChartId: chartId });
      }
    },

    addChannel: (chartId, source, opts) => {
      const chart = get().charts.find((c) => c.id === chartId);
      if (!chart) return null;
      if (chart.channels.length >= MAX_CHANNELS_PER_CHART) return null;
      if (get().charts.reduce((n, c) => n + c.channels.length, 0) >= MAX_ENGINE_CHANNELS) return null;
      const label =
        (opts?.label?.trim() || (source.kind === 'field' ? source.name : source.kind === 'meta' ? source.metric : 'expr')).slice(
          0,
          CHANNEL_NAME_MAX
        );
      const def: ChannelDef = {
        id: genId('ch'),
        label,
        source,
        color: nextPlotColor(get().charts.reduce((n, c) => n + c.channels.length, 0)),
        visible: true,
        axis: 'y1',
        unit: opts?.unit,
      };
      plotEngine.ensureChannel(def);
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, channels: [...c.channels, def] })));
      return def.id;
    },

    removeChannel: (chartId, channelId) => {
      plotEngine.removeChannel(channelId);
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          channels: c.channels.filter((ch) => ch.id !== channelId),
          xyXChannelId: c.xyXChannelId === channelId ? null : c.xyXChannelId,
          histChannelId: c.histChannelId === channelId ? null : c.histChannelId,
        }))
      );
    },

    updateChannel: (chartId, channelId, partial) => {
      const chart = get().charts.find((c) => c.id === chartId);
      const def = chart?.channels.find((ch) => ch.id === channelId);
      if (!chart || !def) return;
      const next: ChannelDef = { ...def, ...partial };
      plotEngine.ensureChannel(next);
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          channels: c.channels.map((ch) => (ch.id === channelId ? next : ch)),
        }))
      );
    },

    setChannelSource: (chartId, channelId, source) => {
      const chart = get().charts.find((c) => c.id === chartId);
      const def = chart?.channels.find((ch) => ch.id === channelId);
      if (!chart || !def) return;
      const label =
        source.kind === 'field' ? source.name : source.kind === 'meta' ? source.metric : def.label;
      const next: ChannelDef = { ...def, source, label: label.slice(0, CHANNEL_NAME_MAX) };
      plotEngine.ensureChannel(next); // source change → engine rebuilds the ring
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          channels: c.channels.map((ch) => (ch.id === channelId ? next : ch)),
        }))
      );
    },

    toggleChannelVisible: (chartId, channelId) => {
      const chart = get().charts.find((c) => c.id === chartId);
      const def = chart?.channels.find((ch) => ch.id === channelId);
      if (!chart || !def) return;
      get().updateChannel(chartId, channelId, { visible: !def.visible });
    },

    setChartMode: (chartId, mode) => {
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, mode })));
    },

    setLive: (chartId, live) => {
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, live, frozen: null })));
    },

    setSpan: (chartId, spanUs) => {
      const clamped = Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, Math.round(spanUs)));
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, spanUs: clamped })));
    },

    freezeView: (chartId, tMinUs, tMaxUs) => {
      if (!(tMaxUs > tMinUs)) return;
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, live: false, frozen: { tMinUs, tMaxUs } })));
    },

    fitView: (chartId) => {
      const extent = plotEngine.getDataExtent();
      if (!extent) {
        get().setLive(chartId, true);
        return;
      }
      // Pad 5% on both sides so endpoints are visible.
      const pad = (extent.tMaxUs - extent.tMinUs) * 0.05 || 1_000;
      get().freezeView(chartId, extent.tMinUs - pad, extent.tMaxUs + pad);
    },

    setYOverride: (chartId, axis, min, max) => {
      commitCharts(
        patchChart(get().charts, chartId, (c) =>
          axis === 'y1'
            ? { ...c, y1Min: min, y1Max: max }
            : { ...c, y2Min: min, y2Max: max }
        )
      );
    },

    setFftConfig: (chartId, cfg) => {
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          fftSize: cfg.fftSize !== undefined && FFT_SIZES.includes(cfg.fftSize) ? cfg.fftSize : c.fftSize,
          fftDb: cfg.fftDb !== undefined ? cfg.fftDb : c.fftDb,
        }))
      );
    },

    setHistConfig: (chartId, cfg) => {
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          histBins:
            cfg.bins !== undefined
              ? Math.min(HIST_BINS_MAX, Math.max(HIST_BINS_MIN, Math.round(cfg.bins)))
              : c.histBins,
          histChannelId: cfg.channelId !== undefined ? cfg.channelId : c.histChannelId,
        }))
      );
    },

    setXyXChannel: (chartId, channelId) => {
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, xyXChannelId: channelId })));
    },

    setCursorX: (chartId, which, tUs) => {
      const cursors = { ...get().cursors };
      const cur = cursors[chartId] ?? { x1Us: null, x2Us: null };
      cursors[chartId] = which === 'x1' ? { ...cur, x1Us: tUs } : { ...cur, x2Us: tUs };
      commitCharts(get().charts, { cursors });
    },

    setPlotDepth: (depth) => {
      const clamped = Math.min(PLOT_DEPTH_MAX, Math.max(PLOT_DEPTH_MIN, Math.round(depth)));
      plotEngine.setDepth(clamped);
      commitCharts(get().charts, { plotDepth: clamped });
    },

    resetPanel: () => {
      for (const chart of get().charts) for (const ch of chart.channels) plotEngine.removeChannel(ch.id);
      const fresh: PlotConfig = {
        charts: [makeDefaultChart('Chart 1')],
        activeChartId: '',
        cursors: {},
        plotDepth: PLOT_DEPTH_DEFAULT,
      };
      fresh.activeChartId = fresh.charts[0].id;
      plotEngine.setDepth(fresh.plotDepth);
      persist(fresh);
      set(fresh);
    },
  };
});

// Smoke-test handle (mirrors __bforgeStore in useWorkstationStore).
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__bforgePlotStore = usePlotStore;
}
