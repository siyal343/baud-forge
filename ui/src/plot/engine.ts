// Plot Forge data engine — the non-reactive half of the plotting stack.
//
// Chart CONFIG lives in usePlotStore (Zustand); sample DATA lives here in
// Float64 rings outside the reactive tree, following the repo's hot-path
// convention (see rateTimestamps in useWorkstationStore). The engine is
// store-agnostic: main.tsx wires it to useWorkstationStore via start(), and
// tests drive ingestPackets()/ensureChannel() directly.
//
// Feed semantics per packet, in order:
//   1. scan dissectedFields into the field catalog (picker + units),
//   2. push every non-expr channel (field extraction / meta metrics),
//   3. evaluate expr channels with hold-last semantics (scope MATH style).
// Expr channels deliberately do NOT backfill — historical evaluation would
// need each ref channel's historical value, not the current one.

import { SampleRing } from './rings';
import { decimateMinMax, type DecimatedPoint } from './decimate';
import { compileExpr, type CompiledExpr } from './expr';
import type { ChannelDef, WindowStats } from './types';
import type { PacketRow } from '../types';

export const PLOT_DEPTH_MIN = 1_000;
export const PLOT_DEPTH_MAX = 250_000;
export const PLOT_DEPTH_DEFAULT = 60_000;
/** Mirror of the engine-side SeriesSet MAX_SERIES (crates/bforge-core/series.rs). */
export const MAX_ENGINE_CHANNELS = 32;
/** Field catalog cap — beyond this, new field names stop being cataloged. */
const CATALOG_CAP = 512;
/** meta:rate sliding window (µs). */
const RATE_WINDOW_US = 1_000_000;

const FIELD_NUMBER = /-?\d+(?:\.\d+)?/;

export interface CatalogEntry {
  name: string;
  unit?: string;
  count: number;
  lastTUs: number;
  lastValue: number;
}

/** Numeric value of a named dissected field, preferring native numbers. */
export const extractFieldNumber = (
  pkt: PacketRow,
  name: string
): { value: number; unit?: string } | null => {
  for (const f of pkt.dissectedFields ?? []) {
    if (f.name !== name) continue;
    const dv = f.decodedValue;
    if (typeof dv === 'number') return Number.isFinite(dv) ? { value: dv, unit: f.unit } : null;
    if (typeof dv === 'string') {
      const m = FIELD_NUMBER.exec(dv);
      return m ? { value: parseFloat(m[0]), unit: f.unit } : null;
    }
    return null; // field exists but is not numeric (boolean / empty)
  }
  return null;
};

interface ChannelRuntime {
  def: ChannelDef;
  /** Label this runtime is registered under in byLabel (rename tracking). */
  registeredLabel: string;
  ring: SampleRing;
  expr?: CompiledExpr;
  lastValue: number;
  lastTUs: number;
}

export interface DataExtent {
  tMinUs: number;
  tMaxUs: number;
}

export class PlotEngine {
  private channels = new Map<string, ChannelRuntime>();
  private byLabel = new Map<string, ChannelRuntime>();
  private catalog = new Map<string, CatalogEntry>();
  /** (tUs, bytes) sliding window for the meta:rate metric. */
  private rateWindow: Array<{ tUs: number; bytes: number }> = [];
  private lastSeqId = 0;
  private depth = PLOT_DEPTH_DEFAULT;
  private versionCounter = 0;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private sourcePackets: () => PacketRow[] = () => [];

  get channelCount(): number {
    return this.channels.size;
  }

  /** Bumped on every ingest that touched at least one packet. */
  get dataVersion(): number {
    return this.versionCounter;
  }

  /**
   * Wire the engine to the workstation store. Idempotent. `subscribe` receives
   * a listener and returns an unsubscribe fn (zustand's vanilla contract).
   */
  start(opts: { getSourcePackets: () => PacketRow[]; subscribe: (fn: () => void) => () => void }): void {
    this.sourcePackets = opts.getSourcePackets;
    if (this.started) return;
    this.started = true;
    this.unsubscribe = opts.subscribe(() => this.handleStoreChange());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
  }

  private handleStoreChange = (): void => {
    const pkts = this.sourcePackets();
    if (pkts.length === 0) {
      // clearStream(): the reactive buffer is gone — drop ring history but
      // keep channel definitions so the charts recover on the next frames.
      if (this.lastSeqId !== 0) this.clearData();
      return;
    }
    const maxSeq = pkts[pkts.length - 1].seqId;
    if (maxSeq <= this.lastSeqId) return; // hover/selection churn, no new frames
    // Walk back to the first packet this engine has not seen. seqIds are
    // monotonic per app session (withUniqueSeqId), so this is exact.
    let i = pkts.length - 1;
    while (i > 0 && pkts[i - 1].seqId > this.lastSeqId) i--;
    const fresh = pkts.slice(i);
    this.lastSeqId = maxSeq;
    this.ingestPackets(fresh);
  };

  /** Feed raw packets (also the direct entry point for tests). */
  ingestPackets(pkts: PacketRow[]): void {
    if (pkts.length === 0) return;
    for (const pkt of pkts) {
      this.scanCatalog(pkt);
      for (const rt of this.channels.values()) {
        if (rt.def.source.kind === 'expr') continue;
        this.pushChannel(rt, pkt);
      }
      for (const rt of this.channels.values()) {
        if (rt.def.source.kind !== 'expr') continue;
        const value = this.evalExprChannel(rt);
        if (Number.isFinite(value)) {
          rt.ring.push(pkt.timestampUs, value);
          rt.lastValue = value;
          rt.lastTUs = pkt.timestampUs;
        }
      }
    }
    this.versionCounter++;
  }

  // ---- channel lifecycle -------------------------------------------------

  /**
   * Register or re-sync a channel. When the source of an existing channel
   * changed, its ring is rebuilt (and field/meta sources backfilled from the
   * reactive packet buffer via the wired accessor).
   */
  ensureChannel(def: ChannelDef): void {
    const existing = this.channels.get(def.id);
    if (existing) {
      const sourceChanged = JSON.stringify(existing.def.source) !== JSON.stringify(def.source);
      const labelChanged = existing.def.label !== def.label;
      existing.def = def;
      if (labelChanged) {
        if (this.byLabel.get(existing.registeredLabel) === existing) {
          this.byLabel.delete(existing.registeredLabel);
        }
        this.byLabel.set(def.label, existing);
        existing.registeredLabel = def.label;
      }
      if (sourceChanged) this.rebuildChannel(existing);
      return;
    }
    if (this.channels.size >= MAX_ENGINE_CHANNELS) return; // store layer enforces the UI cap
    const rt: ChannelRuntime = {
      def,
      registeredLabel: def.label,
      ring: new SampleRing(this.depth),
      lastValue: NaN,
      lastTUs: NaN,
    };
    if (def.source.kind === 'expr') {
      const compiled = compileExpr(def.source.source);
      if (!compiled.ok) return; // store validates before calling; belt & braces
      rt.expr = compiled;
    }
    this.channels.set(def.id, rt);
    this.byLabel.set(def.label, rt);
    if (def.source.kind !== 'expr') this.backfillChannel(rt);
  }

  removeChannel(channelId: string): void {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    if (this.byLabel.get(rt.registeredLabel) === rt) this.byLabel.delete(rt.registeredLabel);
    this.channels.delete(channelId);
  }

  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /** Register every channel def found in persisted chart configs. */
  syncFromCharts(charts: Array<{ channels: ChannelDef[] }>): void {
    for (const chart of charts) for (const def of chart.channels) this.ensureChannel(def);
  }

  /** Change ring depth, preserving the newest samples. */
  setDepth(depth: number): void {
    const clamped = Math.min(PLOT_DEPTH_MAX, Math.max(PLOT_DEPTH_MIN, Math.round(depth)));
    if (clamped === this.depth) return;
    this.depth = clamped;
    for (const rt of this.channels.values()) {
      const { t, v } = rt.ring.tailArrays(clamped);
      rt.ring = new SampleRing(clamped);
      for (let i = 0; i < t.length; i++) rt.ring.push(t[i], v[i]);
    }
  }

  get ringDepth(): number {
    return this.depth;
  }

  /** Drop all sample history + catalog; channel definitions survive. */
  clearData(): void {
    for (const rt of this.channels.values()) rt.ring.clear();
    this.rateWindow = [];
    this.catalog.clear();
    this.lastSeqId = 0;
    this.versionCounter++;
  }

  /** Full teardown (tests). Also unwires the backfill accessor. */
  reset(): void {
    this.channels.clear();
    this.byLabel.clear();
    this.catalog.clear();
    this.rateWindow = [];
    this.lastSeqId = 0;
    this.sourcePackets = () => [];
    this.depth = PLOT_DEPTH_DEFAULT;
    this.versionCounter++;
  }

  // ---- per-packet plumbing ------------------------------------------------

  private scanCatalog(pkt: PacketRow): void {
    for (const f of pkt.dissectedFields ?? []) {
      if (typeof f.decodedValue === 'boolean') continue;
      if (!this.catalog.has(f.name) && this.catalog.size >= CATALOG_CAP) continue;
      const value =
        typeof f.decodedValue === 'number'
          ? Number.isFinite(f.decodedValue)
            ? f.decodedValue
            : null
          : (() => {
              const m = FIELD_NUMBER.exec(String(f.decodedValue));
              return m ? parseFloat(m[0]) : null;
            })();
      if (value === null) continue;
      let entry = this.catalog.get(f.name);
      if (!entry) {
        entry = { name: f.name, count: 0, lastTUs: 0, lastValue: value };
        this.catalog.set(f.name, entry);
      }
      entry.count++;
      entry.unit = f.unit ?? entry.unit;
      entry.lastTUs = pkt.timestampUs;
      entry.lastValue = value;
    }
  }

  private pushChannel(rt: ChannelRuntime, pkt: PacketRow): void {
    const src = rt.def.source;
    let value: number | null = null;
    if (src.kind === 'field') {
      const extracted = extractFieldNumber(pkt, src.name);
      if (extracted) value = extracted.value;
    } else if (src.kind === 'meta') {
      if (src.metric === 'length') value = pkt.length;
      else if (src.metric === 'delta') value = pkt.deltaUs;
      else {
        this.rateWindow.push({ tUs: pkt.timestampUs, bytes: pkt.length });
        const floor = pkt.timestampUs - RATE_WINDOW_US;
        while (this.rateWindow.length > 0 && this.rateWindow[0].tUs < floor) this.rateWindow.shift();
        let bytes = 0;
        for (const e of this.rateWindow) bytes += e.bytes;
        value = bytes;
      }
    }
    if (value !== null && Number.isFinite(value)) {
      rt.ring.push(pkt.timestampUs, value);
      rt.lastValue = value;
      rt.lastTUs = pkt.timestampUs;
    }
  }

  /** Hold-last evaluation: refs resolve to other channels' latest values. */
  private evalExprChannel(rt: ChannelRuntime): number {
    if (!rt.expr) return NaN;
    const vars: Record<string, number> = {};
    for (const ref of rt.expr.refs) {
      const src = this.byLabel.get(ref);
      vars[ref] = src ? src.lastValue : NaN;
    }
    return rt.expr.fn(vars);
  }

  private rebuildChannel(rt: ChannelRuntime): void {
    rt.ring = new SampleRing(this.depth);
    rt.lastValue = NaN;
    rt.lastTUs = NaN;
    if (rt.def.source.kind === 'expr') {
      rt.expr = undefined;
      const compiled = compileExpr(rt.def.source.source);
      if (compiled.ok) rt.expr = compiled;
    } else {
      this.backfillChannel(rt);
    }
  }

  /** Seed a field/meta channel from the reactive packet buffer (wired). */
  private backfillChannel(rt: ChannelRuntime): void {
    for (const pkt of this.sourcePackets()) this.pushChannel(rt, pkt);
    this.versionCounter++;
  }

  // ---- queries -------------------------------------------------------------

  /** Min-max decimated series for painting a [tMin, tMax] µs window. */
  getSeries(channelId: string, tMinUs: number, tMaxUs: number, buckets: number): DecimatedPoint[] {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return [];
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    if (hi <= lo) return [];
    return decimateMinMax((i) => rt.ring.tAt(i), (i) => rt.ring.vAt(i), lo, hi, Math.max(1, buckets));
  }

  /** Contiguous newest-n copy for FFT / histogram / XY pairing. */
  getTail(channelId: string, n: number): { t: Float64Array; v: Float64Array } {
    const rt = this.channels.get(channelId);
    if (!rt) return { t: new Float64Array(0), v: new Float64Array(0) };
    return rt.ring.tailArrays(n);
  }

  getStats(channelId: string, tMinUs: number, tMaxUs: number): WindowStats | null {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return null;
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    if (hi <= lo) return null;
    // Welford single pass — windows can reach the full ring depth.
    let n = 0;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = rt.ring.vAt(i);
      n++;
      const d = v - mean;
      mean += d / n;
      m2 += d * (v - mean);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max, mean, stdDev: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0, count: n };
  }

  /** Full-data time extent across all channels (for FIT). */
  getDataExtent(): DataExtent | null {
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const rt of this.channels.values()) {
      if (rt.ring.length === 0) continue;
      if (rt.ring.tAt(0) < tMin) tMin = rt.ring.tAt(0);
      if (rt.ring.lastT > tMax) tMax = rt.ring.lastT;
    }
    return Number.isFinite(tMin) && tMax > tMin ? { tMinUs: tMin, tMaxUs: tMax } : null;
  }

  /** Field catalog snapshot for the Add-Channel picker (sorted by name). */
  catalogList(): CatalogEntry[] {
    return [...this.catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  catalogEntry(name: string): CatalogEntry | undefined {
    return this.catalog.get(name);
  }

  lastValue(channelId: string): number {
    const rt = this.channels.get(channelId);
    return rt ? rt.lastValue : NaN;
  }

  channelLabel(channelId: string): string {
    return this.channels.get(channelId)?.def.label ?? '';
  }
}

export const plotEngine = new PlotEngine();
