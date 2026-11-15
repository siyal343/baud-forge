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

import type { ChartDef, ChannelDef, ChannelSource, ChartMode, CursorPair, FrozenView } from '../plot/types';
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
const PERSIST_DEBOUNCE_MS = 150;

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

export interface ChartTriggerConfig {
  enabled: boolean;
  sourceId: string;
  mode: 'AUTO' | 'NORM' | 'SINGLE' | 'ROLL';
  slope: 'RISING' | 'FALLING' | 'EITHER';
  level: number;
  position: number; // 0..1 horizontal trigger anchor, default 0.5
}

export type PlotMode = ChartMode;
export type PlotChannel = ChannelDef;
export type PlotLayoutMode = 'single' | 'stacked' | 'grid';

export type ChartConfig = ChartDef & {
  trigger?: ChartTriggerConfig;
  y1Cursor?: number | null;
  y2Cursor?: number | null;
  histSampleMode?: 'window' | 'tail';
};

export interface ChartViewportPatch {
  spanSec?: number;
  spanUs?: number;
  y1Range?: [number, number] | 'auto';
  y2Range?: [number, number] | 'auto';
  frozenWindow?: [number, number] | null;
  live?: boolean;
  frozen?: FrozenView | null;
  y1Min?: number | null;
  y1Max?: number | null;
  y2Min?: number | null;
  y2Max?: number | null;
}

const CHART_MODES: ChartMode[] = ['time', 'fft', 'xy', 'hist'];
const TRIGGER_MODES: ChartTriggerConfig['mode'][] = ['AUTO', 'NORM', 'SINGLE', 'ROLL'];
const TRIGGER_SLOPES: ChartTriggerConfig['slope'][] = ['RISING', 'FALLING', 'EITHER'];
const LAYOUT_MODES: PlotLayoutMode[] = ['single', 'stacked', 'grid'];
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

let idCounter = 1;
const genId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export const makeDefaultTrigger = (): ChartTriggerConfig => ({
  enabled: false,
  sourceId: '',
  mode: 'AUTO',
  slope: 'RISING',
  level: 0,
  position: 0.5,
});

export const makeDefaultChart = (name: string): ChartConfig => ({
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
  trigger: makeDefaultTrigger(),
  y1Cursor: null,
  y2Cursor: null,
  histSampleMode: 'window',
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

const validTrigger = (t: unknown): ChartTriggerConfig => {
  const def = makeDefaultTrigger();
  if (!t || typeof t !== 'object') return def;
  const r = t as Record<string, unknown>;
  const pos = typeof r.position === 'number' && Number.isFinite(r.position) ? r.position : def.position;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
    sourceId: typeof r.sourceId === 'string' ? r.sourceId : def.sourceId,
    mode: TRIGGER_MODES.includes(r.mode as ChartTriggerConfig['mode'])
      ? (r.mode as ChartTriggerConfig['mode'])
      : def.mode,
    slope: TRIGGER_SLOPES.includes(r.slope as ChartTriggerConfig['slope'])
      ? (r.slope as ChartTriggerConfig['slope'])
      : def.slope,
    level: typeof r.level === 'number' && Number.isFinite(r.level) ? r.level : def.level,
    position: Math.min(1, Math.max(0, pos)),
  };
};

const validChart = (c: unknown): ChartConfig | null => {
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
    trigger: validTrigger(ch.trigger),
    y1Cursor: optNum(ch.y1Cursor),
    y2Cursor: optNum(ch.y2Cursor),
    histSampleMode: ch.histSampleMode === 'tail' ? 'tail' : 'window',
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
  charts: ChartConfig[];
  activeChartId: string;
  cursors: Record<string, CursorPair>;
  plotDepth: number;
  layoutMode: PlotLayoutMode;
  gpuAccel: boolean;
}

/** Pure merge: defaults → saved blob. Corrupt entries are dropped, never fatal. */
export const mergePlotConfig = (saved: unknown): PlotConfig => {
  const fallback: PlotConfig = {
    charts: [makeDefaultChart('Chart 1')],
    activeChartId: '',
    cursors: {},
    plotDepth: PLOT_DEPTH_DEFAULT,
    layoutMode: 'single',
    gpuAccel: true,
  };
  fallback.activeChartId = fallback.charts[0].id;
  if (!saved || typeof saved !== 'object') return fallback;
  const s = saved as Record<string, unknown>;
  const charts = Array.isArray(s.charts)
    ? s.charts.slice(0, MAX_CHARTS).map(validChart).filter((x): x is ChartConfig => x !== null)
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
    layoutMode: LAYOUT_MODES.includes(s.layoutMode as PlotLayoutMode)
      ? (s.layoutMode as PlotLayoutMode)
      : 'single',
    gpuAccel: typeof s.gpuAccel === 'boolean' ? s.gpuAccel : true,
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

export interface PlotState extends PlotConfig {
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
  setHistSampleMode: (chartId: string, mode: 'window' | 'tail') => void;
  setXyXChannel: (chartId: string, channelId: string | null) => void;
  setChartTrigger: (chartId: string, patch: Partial<ChartTriggerConfig>) => void;
  setChartViewportFast: (chartId: string, patch: ChartViewportPatch) => void;
  // Cursors
  setCursorX: (chartId: string, which: 'x1' | 'x2', tUs: number | null) => void;
  setYCursors: (chartId: string, y1: number | null, y2: number | null) => void;
  // Global & studio preferences
  setPlotDepth: (depth: number) => void;
  setLayoutMode: (mode: PlotLayoutMode) => void;
  setGpuAccel: (enabled: boolean) => void;
  resetPanel: () => void;
}

export type PlotStoreState = PlotState;

const persist = (state: PlotConfig): void => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: CONFIG_VERSION, ...state })
    );
  } catch (_) {}
};

const patchChart = (charts: ChartConfig[], chartId: string, fn: (c: ChartConfig) => ChartConfig): ChartConfig[] =>
  charts.map((c) => (c.id === chartId ? fn(c) : c));

const resolveAxisPatch = (
  curMin: number | null,
  curMax: number | null,
  range: [number, number] | 'auto' | undefined,
  minOpt: number | null | undefined,
  maxOpt: number | null | undefined
): [number | null, number | null] => {
  if (range === 'auto') return [null, null];
  if (Array.isArray(range) && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    return [range[0], range[1]];
  }
  return [
    minOpt !== undefined ? optNum(minOpt) : curMin,
    maxOpt !== undefined ? optNum(maxOpt) : curMax,
  ];
};

export const usePlotStore = create<PlotState>((set, get) => {
  // Sync the engine with whatever config survived a reload.
  const initial = loadConfig();
  plotEngine.setDepth(initial.plotDepth);
  plotEngine.syncFromCharts(initial.charts);

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPersistTimer = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };

  const commitCharts = (
    charts: ChartConfig[],
    extra?: Partial<PlotConfig>,
    opts?: { deferPersist?: boolean }
  ) => {
    const next: PlotConfig = {
      charts,
      activeChartId: get().activeChartId,
      cursors: get().cursors,
      plotDepth: get().plotDepth,
      layoutMode: get().layoutMode,
      gpuAccel: get().gpuAccel,
      ...extra,
    };
    set(next);
    clearPersistTimer();
    if (opts?.deferPersist) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        const cur = get();
        persist({
          charts: cur.charts,
          activeChartId: cur.activeChartId,
          cursors: cur.cursors,
          plotDepth: cur.plotDepth,
          layoutMode: cur.layoutMode,
          gpuAccel: cur.gpuAccel,
        });
      }, PERSIST_DEBOUNCE_MS);
    } else {
      persist(next);
    }
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
          trigger:
            c.trigger && c.trigger.sourceId === channelId
              ? { ...c.trigger, sourceId: '', enabled: false }
              : c.trigger,
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

    setHistSampleMode: (chartId, mode) => {
      const clean: 'window' | 'tail' = mode === 'tail' ? 'tail' : 'window';
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, histSampleMode: clean })));
    },

    setXyXChannel: (chartId, channelId) => {
      commitCharts(patchChart(get().charts, chartId, (c) => ({ ...c, xyXChannelId: channelId })));
    },

    setChartTrigger: (chartId, patch) => {
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          trigger: validTrigger({ ...(c.trigger ?? makeDefaultTrigger()), ...patch }),
        }))
      );
    },

    setChartViewportFast: (chartId, patch) => {
      if (!get().charts.some((c) => c.id === chartId)) return;
      const next = patchChart(get().charts, chartId, (c) => {
        let spanUs = c.spanUs;
        if (typeof patch.spanUs === 'number' && Number.isFinite(patch.spanUs)) {
          spanUs = Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, Math.round(patch.spanUs)));
        } else if (typeof patch.spanSec === 'number' && Number.isFinite(patch.spanSec)) {
          spanUs = Math.min(SPAN_MAX_US, Math.max(SPAN_MIN_US, Math.round(patch.spanSec * 1_000_000)));
        }
        const [y1Min, y1Max] = resolveAxisPatch(c.y1Min, c.y1Max, patch.y1Range, patch.y1Min, patch.y1Max);
        const [y2Min, y2Max] = resolveAxisPatch(c.y2Min, c.y2Max, patch.y2Range, patch.y2Min, patch.y2Max);

        let live = c.live;
        let frozen = c.frozen;
        if (patch.frozenWindow !== undefined) {
          if (patch.frozenWindow === null) {
            live = true;
            frozen = null;
          } else if (
            Array.isArray(patch.frozenWindow) &&
            Number.isFinite(patch.frozenWindow[0]) &&
            Number.isFinite(patch.frozenWindow[1]) &&
            patch.frozenWindow[1] > patch.frozenWindow[0]
          ) {
            live = false;
            frozen = { tMinUs: patch.frozenWindow[0], tMaxUs: patch.frozenWindow[1] };
          }
        } else {
          if (patch.frozen !== undefined) {
            if (patch.frozen === null) {
              frozen = null;
            } else if (
              Number.isFinite(patch.frozen.tMinUs) &&
              Number.isFinite(patch.frozen.tMaxUs) &&
              patch.frozen.tMaxUs > patch.frozen.tMinUs
            ) {
              frozen = { tMinUs: patch.frozen.tMinUs, tMaxUs: patch.frozen.tMaxUs };
              if (patch.live === undefined) live = false;
            }
          }
          if (patch.live !== undefined) {
            live = patch.live;
            if (patch.live === true && patch.frozen === undefined) frozen = null;
          }
        }

        return { ...c, spanUs, y1Min, y1Max, y2Min, y2Max, live, frozen };
      });
      commitCharts(next, undefined, { deferPersist: true });
    },

    setCursorX: (chartId, which, tUs) => {
      const cursors = { ...get().cursors };
      const cur = cursors[chartId] ?? { x1Us: null, x2Us: null };
      cursors[chartId] = which === 'x1' ? { ...cur, x1Us: tUs } : { ...cur, x2Us: tUs };
      commitCharts(get().charts, { cursors });
    },

    setYCursors: (chartId, y1, y2) => {
      commitCharts(
        patchChart(get().charts, chartId, (c) => ({
          ...c,
          y1Cursor: optNum(y1),
          y2Cursor: optNum(y2),
        }))
      );
    },

    setPlotDepth: (depth) => {
      const clamped = Math.min(PLOT_DEPTH_MAX, Math.max(PLOT_DEPTH_MIN, Math.round(depth)));
      plotEngine.setDepth(clamped);
      commitCharts(get().charts, { plotDepth: clamped });
    },

    setLayoutMode: (mode) => {
      const clean: PlotLayoutMode = LAYOUT_MODES.includes(mode) ? mode : 'single';
      commitCharts(get().charts, { layoutMode: clean });
    },

    setGpuAccel: (enabled) => {
      commitCharts(get().charts, { gpuAccel: Boolean(enabled) });
    },

    resetPanel: () => {
      clearPersistTimer();
      for (const chart of get().charts) for (const ch of chart.channels) plotEngine.removeChannel(ch.id);
      const fresh: PlotConfig = {
        charts: [makeDefaultChart('Chart 1')],
        activeChartId: '',
        cursors: {},
        plotDepth: PLOT_DEPTH_DEFAULT,
        layoutMode: 'single',
        gpuAccel: true,
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
