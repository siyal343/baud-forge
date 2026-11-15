// usePlotStore verification: config actions, engine sync, persistence and
// validation of the persisted blob. mergePlotConfig is exercised pure; one
// rehydration test covers the localStorage load path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  usePlotStore,
  mergePlotConfig,
  makeDefaultChart,
  MAX_CHARTS,
  MAX_CHANNELS_PER_CHART,
  DEFAULT_SPAN_US,
} from './usePlotStore';
import { plotEngine, PLOT_DEPTH_DEFAULT } from '../plot/engine';

const KEY = 'bforge_plot_cfg_v1';

beforeEach(() => {
  localStorage.removeItem(KEY);
  usePlotStore.getState().resetPanel();
  plotEngine.reset();
});

afterEach(() => {
  localStorage.removeItem(KEY);
});

describe('chart tabs', () => {
  it('starts with one default chart', () => {
    const s = usePlotStore.getState();
    expect(s.charts).toHaveLength(1);
    expect(s.charts[0].name).toBe('Chart 1');
    expect(s.activeChartId).toBe(s.charts[0].id);
    expect(s.charts[0].live).toBe(true);
    expect(s.charts[0].spanUs).toBe(DEFAULT_SPAN_US);
  });

  it('adds, renames, activates and removes charts', () => {
    const s = usePlotStore.getState();
    const id2 = s.addChart('IMU Review');
    expect(usePlotStore.getState().charts).toHaveLength(2);
    expect(usePlotStore.getState().activeChartId).toBe(id2);
    usePlotStore.getState().setActiveChart(s.charts[0].id);
    expect(usePlotStore.getState().activeChartId).toBe(s.charts[0].id);
    usePlotStore.getState().renameChart(id2, '  Gyro Lab  ');
    expect(usePlotStore.getState().charts.find((c) => c.id === id2)?.name).toBe('Gyro Lab');
    usePlotStore.getState().removeChart(id2);
    expect(usePlotStore.getState().charts).toHaveLength(1);
    expect(usePlotStore.getState().activeChartId).toBe(s.charts[0].id);
  });

  it('refuses to remove the last chart', () => {
    const s = usePlotStore.getState();
    s.removeChart(s.charts[0].id);
    expect(usePlotStore.getState().charts).toHaveLength(1);
  });

  it('caps the chart count', () => {
    for (let i = 0; i < MAX_CHARTS + 3; i++) usePlotStore.getState().addChart();
    expect(usePlotStore.getState().charts.length).toBeLessThanOrEqual(MAX_CHARTS);
  });
});

describe('channels', () => {
  it('adds a channel, syncs the engine and persists', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const chId = s.addChannel(chartId, { kind: 'field', name: 'v_batt_mv' }, { unit: 'mV' });
    expect(chId).toBeTruthy();
    const def = usePlotStore.getState().charts[0].channels[0];
    expect(def.label).toBe('v_batt_mv');
    expect(def.unit).toBe('mV');
    expect(def.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(plotEngine.hasChannel(chId!)).toBe(true);
    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.version).toBe(1);
    expect(blob.charts[0].channels).toHaveLength(1);
  });

  it('derives labels per source kind', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const a = s.addChannel(chartId, { kind: 'meta', metric: 'rate' })!;
    const b = s.addChannel(chartId, { kind: 'field', name: 'gyro_z' })!;
    const channels = usePlotStore.getState().charts[0].channels;
    expect(channels.find((c) => c.id === a)?.label).toBe('rate');
    expect(channels.find((c) => c.id === b)?.label).toBe('gyro_z');
  });

  it('removes channels and cleans the engine + dependent chart fields', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const chId = s.addChannel(chartId, { kind: 'meta', metric: 'length' })!;
    usePlotStore.getState().setXyXChannel(chartId, chId);
    usePlotStore.getState().setHistConfig(chartId, { channelId: chId });
    usePlotStore.getState().removeChannel(chartId, chId);
    expect(plotEngine.hasChannel(chId)).toBe(false);
    const chart = usePlotStore.getState().charts[0];
    expect(chart.channels).toHaveLength(0);
    expect(chart.xyXChannelId).toBeNull();
    expect(chart.histChannelId).toBeNull();
  });

  it('enforces per-chart and engine-wide channel caps', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const other = s.addChart('B')!;
    for (let i = 0; i < MAX_CHANNELS_PER_CHART + 2; i++) {
      s.addChannel(chartId, { kind: 'meta', metric: 'length' });
    }
    expect(usePlotStore.getState().charts[0].channels.length).toBe(MAX_CHANNELS_PER_CHART);
    // Engine-wide cap of 32 rings across charts: 16 already exist, 16 more fit.
    let added = 0;
    while (usePlotStore.getState().addChannel(other, { kind: 'meta', metric: 'delta' })) added++;
    expect(added).toBe(32 - MAX_CHANNELS_PER_CHART);
    expect(plotEngine.channelCount).toBe(32);
  });

  it('updateChannel re-syncs the engine def', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const chId = s.addChannel(chartId, { kind: 'field', name: 'v_batt_mv' })!;
    usePlotStore.getState().updateChannel(chartId, chId, { axis: 'y2', visible: false, unit: 'mV' });
    const def = usePlotStore.getState().charts[0].channels[0];
    expect(def.axis).toBe('y2');
    expect(def.visible).toBe(false);
    usePlotStore.getState().toggleChannelVisible(chartId, chId);
    expect(usePlotStore.getState().charts[0].channels[0].visible).toBe(true);
  });
});

describe('view state', () => {
  it('freeze/fit/live transitions', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    usePlotStore.getState().freezeView(chartId, 100, 200);
    let chart = usePlotStore.getState().charts[0];
    expect(chart.live).toBe(false);
    expect(chart.frozen).toEqual({ tMinUs: 100, tMaxUs: 200 });
    usePlotStore.getState().freezeView(chartId, 500, 100); // illegal → ignored
    expect(usePlotStore.getState().charts[0].frozen).toEqual({ tMinUs: 100, tMaxUs: 200 });
    usePlotStore.getState().setLive(chartId, true);
    chart = usePlotStore.getState().charts[0];
    expect(chart.live).toBe(true);
    expect(chart.frozen).toBeNull();
    // FIT with no engine data falls back to LIVE.
    usePlotStore.getState().freezeView(chartId, 0, 1);
    usePlotStore.getState().fitView(chartId);
    expect(usePlotStore.getState().charts[0].live).toBe(true);
  });

  it('FIT freezes onto the engine data extent with padding', () => {
    const chartId = usePlotStore.getState().charts[0].id;
    usePlotStore.getState().addChannel(chartId, { kind: 'meta', metric: 'length' });
    plotEngine.ingestPackets([
      { seqId: 1, timestampUs: 1_000, deltaUs: 0, length: 10 } as never,
      { seqId: 2, timestampUs: 2_000, deltaUs: 0, length: 10 } as never,
    ]);
    usePlotStore.getState().setLive(chartId, false);
    usePlotStore.getState().fitView(chartId);
    const chart = usePlotStore.getState().charts[0];
    expect(chart.live).toBe(false);
    expect(chart.frozen!.tMinUs).toBeLessThan(1_000);
    expect(chart.frozen!.tMaxUs).toBeGreaterThan(2_000);
  });

  it('spans and Y overrides clamp and persist', () => {
    const chartId = usePlotStore.getState().charts[0].id;
    usePlotStore.getState().setSpan(chartId, 5);
    expect(usePlotStore.getState().charts[0].spanUs).toBe(1_000);
    usePlotStore.getState().setYOverride(chartId, 'y1', 0, 100);
    const chart = usePlotStore.getState().charts[0];
    expect(chart.y1Min).toBe(0);
    expect(chart.y1Max).toBe(100);
    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.charts[0].y1Max).toBe(100);
  });

  it('cursors store per chart', () => {
    const chartId = usePlotStore.getState().charts[0].id;
    usePlotStore.getState().setCursorX(chartId, 'x1', 1_234);
    usePlotStore.getState().setCursorX(chartId, 'x2', 5_678);
    expect(usePlotStore.getState().cursors[chartId]).toEqual({ x1Us: 1_234, x2Us: 5_678 });
    usePlotStore.getState().setCursorX(chartId, 'x1', null);
    expect(usePlotStore.getState().cursors[chartId].x1Us).toBeNull();
  });

  it('mode + FFT/hist/XY config updates', () => {
    const chartId = usePlotStore.getState().charts[0].id;
    const chId = usePlotStore.getState().addChannel(chartId, { kind: 'meta', metric: 'length' })!;
    usePlotStore.getState().setChartMode(chartId, 'fft');
    usePlotStore.getState().setFftConfig(chartId, { fftSize: 512, fftDb: false });
    usePlotStore.getState().setHistConfig(chartId, { bins: 999, channelId: chId });
    usePlotStore.getState().setXyXChannel(chartId, chId);
    const chart = usePlotStore.getState().charts[0];
    expect(chart.mode).toBe('fft');
    expect(chart.fftSize).toBe(512);
    expect(chart.fftDb).toBe(false);
    expect(chart.histBins).toBe(256); // clamped
    expect(chart.histChannelId).toBe(chId);
    expect(chart.xyXChannelId).toBe(chId);
  });
});

describe('global config', () => {
  it('setPlotDepth clamps and syncs the engine', () => {
    usePlotStore.getState().setPlotDepth(5);
    expect(usePlotStore.getState().plotDepth).toBe(1_000);
    expect(plotEngine.ringDepth).toBe(1_000);
    usePlotStore.getState().setPlotDepth(80_000);
    expect(plotEngine.ringDepth).toBe(80_000);
  });

  it('resetPanel wipes charts, cursors and engine channels', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    s.addChannel(chartId, { kind: 'meta', metric: 'length' });
    s.setCursorX(chartId, 'x1', 9);
    usePlotStore.getState().resetPanel();
    const fresh = usePlotStore.getState();
    expect(fresh.charts).toHaveLength(1);
    expect(fresh.charts[0].channels).toHaveLength(0);
    expect(Object.keys(fresh.cursors)).toHaveLength(0);
    expect(fresh.plotDepth).toBe(PLOT_DEPTH_DEFAULT);
    expect(plotEngine.channelCount).toBe(0);
  });
});

describe('mergePlotConfig', () => {
  it('falls back to a single default chart on garbage', () => {
    for (const garbage of [null, undefined, 42, {}, { charts: 'nope' }, { charts: [] }]) {
      const cfg = mergePlotConfig(garbage);
      expect(cfg.charts).toHaveLength(1);
      expect(cfg.activeChartId).toBe(cfg.charts[0].id);
      expect(cfg.plotDepth).toBe(PLOT_DEPTH_DEFAULT);
    }
  });

  it('validates and clamps chart fields', () => {
    const cfg = mergePlotConfig({
      charts: [
        {
          id: 'c1',
          name: 'X'.repeat(99),
          mode: 'bogus',
          live: false,
          spanUs: -5,
          frozen: { tMinUs: 10, tMaxUs: 5 },
          fftSize: 300,
          histBins: 1,
          channels: [
            { id: 'ch1', label: 'ok', source: { kind: 'meta', metric: 'length' }, color: 'red', axis: 'sideways' },
            { id: '', source: null },
            { id: 'ch2', source: { kind: 'field', name: '  ' } },
            { id: 'ch3', source: { kind: 'field', name: 'f' }, visible: 'no' },
          ],
        },
        { id: '', name: 'no id' },
        'junk',
      ],
      activeChartId: 'missing',
      cursors: { c1: { x1Us: 3, x2Us: 'x' }, ghost: { x1Us: 1 } },
      plotDepth: 99999999,
    });
    expect(cfg.charts).toHaveLength(1);
    const c = cfg.charts[0];
    expect(c.name).toHaveLength(40);
    expect(c.mode).toBe('time');
    expect(c.spanUs).toBe(1_000);
    expect(c.frozen).toBeNull();
    expect(c.fftSize).toBe(1024);
    expect(c.histBins).toBe(4);
    expect(c.live).toBe(false);
    expect(c.channels).toHaveLength(2); // ch1 + ch3 survive
    expect(c.channels[0].color).toBe('#A855F7'); // bad color → default
    expect(c.channels[0].axis).toBe('y1');
    expect(c.channels[1].visible).toBe(true); // non-false → true
    expect(cfg.activeChartId).toBe('c1'); // unknown → first chart
    expect(cfg.cursors.c1).toEqual({ x1Us: 3, x2Us: null });
    expect(cfg.cursors.ghost).toBeUndefined();
    expect(cfg.plotDepth).toBe(250_000);
  });

  it('keeps a valid round-tripped blob intact', () => {
    const chart = { ...makeDefaultChart('Round'), id: 'chart-r', spanUs: 42_000 };
    const cfg = mergePlotConfig({
      version: 1,
      charts: [chart],
      activeChartId: 'chart-r',
      cursors: { 'chart-r': { x1Us: 7, x2Us: null } },
      plotDepth: 120_000,
    });
    expect(cfg.charts[0].name).toBe('Round');
    expect(cfg.charts[0].spanUs).toBe(42_000);
    expect(cfg.activeChartId).toBe('chart-r');
    expect(cfg.plotDepth).toBe(120_000);
    expect(cfg.layoutMode).toBe('single');
    expect(cfg.gpuAccel).toBe(true);
    expect(cfg.charts[0].histSampleMode).toBe('window');
    expect(cfg.charts[0].trigger?.position).toBe(0.5);
  });

  it('sanitizes studio preferences, triggers, y-cursors, and histSampleMode', () => {
    const cfg = mergePlotConfig({
      version: 1,
      layoutMode: 'grid',
      gpuAccel: false,
      charts: [
        {
          id: 'c1',
          trigger: { enabled: true, sourceId: 'ch1', mode: 'SINGLE', slope: 'EITHER', level: 3.3, position: 2 },
          y1Cursor: -1.5,
          y2Cursor: 'bad',
          histSampleMode: 'tail',
        },
      ],
    });
    expect(cfg.layoutMode).toBe('grid');
    expect(cfg.gpuAccel).toBe(false);
    expect(cfg.charts[0].trigger).toEqual({
      enabled: true,
      sourceId: 'ch1',
      mode: 'SINGLE',
      slope: 'EITHER',
      level: 3.3,
      position: 1,
    });
    expect(cfg.charts[0].y1Cursor).toBe(-1.5);
    expect(cfg.charts[0].y2Cursor).toBeNull();
    expect(cfg.charts[0].histSampleMode).toBe('tail');
  });
});

describe('studio preferences, triggers, y-cursors, and fast viewport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates and persists layoutMode and gpuAccel', () => {
    expect(usePlotStore.getState().layoutMode).toBe('single');
    expect(usePlotStore.getState().gpuAccel).toBe(true);

    usePlotStore.getState().setLayoutMode('stacked');
    usePlotStore.getState().setGpuAccel(false);

    const s = usePlotStore.getState();
    expect(s.layoutMode).toBe('stacked');
    expect(s.gpuAccel).toBe(false);

    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.layoutMode).toBe('stacked');
    expect(blob.gpuAccel).toBe(false);
  });

  it('updates chart trigger settings, clamps position, and clears on source channel removal', () => {
    const s = usePlotStore.getState();
    const chartId = s.charts[0].id;
    const chId = s.addChannel(chartId, { kind: 'field', name: 'v_batt_mv' })!;

    s.setChartTrigger(chartId, {
      enabled: true,
      sourceId: chId,
      mode: 'NORM',
      slope: 'FALLING',
      level: 7400,
      position: 0.25,
    });
    expect(usePlotStore.getState().charts[0].trigger).toEqual({
      enabled: true,
      sourceId: chId,
      mode: 'NORM',
      slope: 'FALLING',
      level: 7400,
      position: 0.25,
    });

    // Clamps position to [0, 1] while keeping other fields
    usePlotStore.getState().setChartTrigger(chartId, { position: -0.5 });
    expect(usePlotStore.getState().charts[0].trigger?.position).toBe(0);

    // Removing the trigger source channel resets sourceId and disables trigger
    usePlotStore.getState().removeChannel(chartId, chId);
    expect(usePlotStore.getState().charts[0].trigger?.sourceId).toBe('');
    expect(usePlotStore.getState().charts[0].trigger?.enabled).toBe(false);
  });

  it('sets y1Cursor, y2Cursor, and histSampleMode and persists immediately', () => {
    const chartId = usePlotStore.getState().charts[0].id;
    usePlotStore.getState().setYCursors(chartId, 1.25, -2.5);
    usePlotStore.getState().setHistSampleMode(chartId, 'tail');

    const chart = usePlotStore.getState().charts[0];
    expect(chart.y1Cursor).toBe(1.25);
    expect(chart.y2Cursor).toBe(-2.5);
    expect(chart.histSampleMode).toBe('tail');

    const blob = JSON.parse(localStorage.getItem(KEY)!);
    expect(blob.charts[0].y1Cursor).toBe(1.25);
    expect(blob.charts[0].y2Cursor).toBe(-2.5);
    expect(blob.charts[0].histSampleMode).toBe('tail');
  });

  it('setChartViewportFast updates state immediately and debounces persistence by 150ms', () => {
    vi.useFakeTimers();
    const chartId = usePlotStore.getState().charts[0].id;
    const beforeSpan = JSON.parse(localStorage.getItem(KEY)!).charts[0].spanUs;
    expect(beforeSpan).toBe(DEFAULT_SPAN_US);

    usePlotStore.getState().setChartViewportFast(chartId, {
      spanSec: 2,
      y1Range: [-10, 10],
      y2Range: [0, 100],
      frozenWindow: [1_000, 5_000],
    });

    // Zustand state updates immediately
    const c = usePlotStore.getState().charts[0];
    expect(c.spanUs).toBe(2_000_000);
    expect(c.y1Min).toBe(-10);
    expect(c.y1Max).toBe(10);
    expect(c.y2Min).toBe(0);
    expect(c.y2Max).toBe(100);
    expect(c.live).toBe(false);
    expect(c.frozen).toEqual({ tMinUs: 1_000, tMaxUs: 5_000 });

    // localStorage is not yet written before 150ms
    expect(JSON.parse(localStorage.getItem(KEY)!).charts[0].spanUs).toBe(DEFAULT_SPAN_US);

    vi.advanceTimersByTime(149);
    expect(JSON.parse(localStorage.getItem(KEY)!).charts[0].spanUs).toBe(DEFAULT_SPAN_US);

    vi.advanceTimersByTime(1);
    const persisted = JSON.parse(localStorage.getItem(KEY)!).charts[0];
    expect(persisted.spanUs).toBe(2_000_000);
    expect(persisted.y1Min).toBe(-10);
    expect(persisted.frozen).toEqual({ tMinUs: 1_000, tMaxUs: 5_000 });

    // Auto Y and live resume via null frozenWindow, cancelled by immediate setSpan
    usePlotStore.getState().setChartViewportFast(chartId, {
      spanSec: 4,
      y1Range: 'auto',
      y2Range: 'auto',
      frozenWindow: null,
    });
    const autoChart = usePlotStore.getState().charts[0];
    expect(autoChart.y1Min).toBeNull();
    expect(autoChart.y2Max).toBeNull();
    expect(autoChart.live).toBe(true);
    expect(autoChart.frozen).toBeNull();

    // Immediate save clears pending debounce timer so stale value never overwrites
    usePlotStore.getState().setSpan(chartId, 50_000);
    vi.advanceTimersByTime(200);
    expect(JSON.parse(localStorage.getItem(KEY)!).charts[0].spanUs).toBe(50_000);
  });
});

describe('rehydration', () => {
  it('restores charts from a versioned localStorage blob at import time', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        charts: [
          {
            id: 'chart-x',
            name: 'IMU',
            mode: 'time',
            channels: [
              {
                id: 'ch-1',
                label: 'v_batt_mv',
                source: { kind: 'field', name: 'v_batt_mv' },
                color: '#123456',
                visible: true,
                axis: 'y1',
                unit: 'mV',
              },
            ],
            live: true,
            spanUs: 25_000,
            frozen: null,
            y1Min: null,
            y1Max: null,
            y2Min: null,
            y2Max: null,
            fftSize: 512,
            fftDb: false,
            xyXChannelId: null,
            histBins: 64,
            histChannelId: null,
          },
        ],
        activeChartId: 'chart-x',
        cursors: { 'chart-x': { x1Us: 5, x2Us: 10 } },
        plotDepth: 5_000,
      })
    );
    vi.resetModules();
    const { usePlotStore: freshStore } = await import('./usePlotStore');
    const s = freshStore.getState();
    expect(s.charts[0].id).toBe('chart-x');
    expect(s.charts[0].name).toBe('IMU');
    expect(s.charts[0].channels[0].label).toBe('v_batt_mv');
    expect(s.charts[0].fftSize).toBe(512);
    expect(s.cursors['chart-x']).toEqual({ x1Us: 5, x2Us: 10 });
    expect(s.plotDepth).toBe(5_000);
    // Unversioned legacy blobs are ignored.
    localStorage.setItem(KEY, JSON.stringify({ charts: [] }));
    vi.resetModules();
    const { usePlotStore: freshStore2 } = await import('./usePlotStore');
    expect(freshStore2.getState().charts[0].name).toBe('Chart 1');
    localStorage.removeItem(KEY);
    freshStore2.getState().resetPanel();
  });
});
