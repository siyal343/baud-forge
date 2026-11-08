// Plot Forge — shared type contracts for the advanced plotting engine.
// Reactive chart CONFIG lives in usePlotStore; sample DATA never does (it
// lives in PlotEngine's Float64 rings outside Zustand — see engine.ts).

/** Where a channel's samples come from. */
export type ChannelSource =
  /** Numeric dissected field matched by exact name on every packet. */
  | { kind: 'field'; name: string }
  /** Packet metadata series — no dissector needed. */
  | { kind: 'meta'; metric: MetaMetric }
  /** Derived channel: safe expression over other channels (hold-last eval). */
  | { kind: 'expr'; source: string };

export type MetaMetric = 'length' | 'delta' | 'rate';

/** A single plotted channel definition. */
export interface ChannelDef {
  /** Stable id (`ch-<base36>`), independent of label renames. */
  id: string;
  label: string;
  source: ChannelSource;
  color: string;
  visible: boolean;
  axis: 'y1' | 'y2';
  /** Display unit (seeded from the field's unit when available). */
  unit?: string;
}

export type ChartMode = 'time' | 'fft' | 'xy' | 'hist';

/** Frozen X window in µs — present only when a chart is not LIVE. */
export interface FrozenView {
  tMinUs: number;
  tMaxUs: number;
}

export interface ChartDef {
  id: string;
  name: string;
  mode: ChartMode;
  channels: ChannelDef[];
  /** LIVE follows the newest samples with this X span; false = frozen view. */
  live: boolean;
  /** X span while LIVE (µs). */
  spanUs: number;
  frozen: FrozenView | null;
  /** Manual Y overrides; null = autoscale that axis. */
  y1Min: number | null;
  y1Max: number | null;
  y2Min: number | null;
  y2Max: number | null;
  // Mode-specific configuration
  /** FFT window length (power of two, samples from the head). */
  fftSize: number;
  /** FFT magnitude in dB (true) or linear (false). */
  fftDb: boolean;
  /** XY mode: which channel drives X (must differ from the Y selection). */
  xyXChannelId: string | null;
  /** Histogram bin count. */
  histBins: number;
  /** Histogram source channel. */
  histChannelId: string | null;
}

/** Draggable X cursors in absolute µs (null = parked). */
export interface CursorPair {
  x1Us: number | null;
  x2Us: number | null;
}

/** Stats over the visible window for one channel. */
export interface WindowStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  count: number;
}
