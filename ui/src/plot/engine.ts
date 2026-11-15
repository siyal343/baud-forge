// Plot Forge data engine — the non-reactive half of the plotting stack.
//
// Chart CONFIG lives in usePlotStore (Zustand); sample DATA lives here in
// Float64 rings outside the reactive tree, following the repo's hot-path
// convention (see rateTimestamps in useWorkstationStore). The engine is
// store-agnostic: main.tsx wires it to useWorkstationStore via start(), and
// tests drive ingestPackets()/ensureChannel() directly.
//
// Feed semantics per packet, in order:
//   1. scan dissectedFields once into pktValues + field catalog (incl. arrays & bitfields),
//   2. update the O(1) 1s rate sliding window once per packet,
//   3. push every non-expr channel via O(1) pktValues lookup,
//   4. evaluate expr channels with hold-last semantics (scope MATH style).

import { SampleRing } from './rings';
import { decimateMinMax, decimateMinMaxInto, type DecimatedPoint } from './decimate';
import { compileExpr, type CompiledExpr } from './expr';
import { magnitudeSpectrum } from './fft';
import type { ChannelDef, WindowStats } from './types';
import type { PacketRow } from '../types';

export const PLOT_DEPTH_MIN = 1_000;
export const PLOT_DEPTH_MAX = 250_000;
export const PLOT_DEPTH_DEFAULT = 60_000;
/** Mirror of the engine-side SeriesSet MAX_SERIES (crates/bforge-core/series.rs). */
export const MAX_ENGINE_CHANNELS = 32;
/** Field catalog cap — beyond this, new field names stop being cataloged. */
const CATALOG_CAP = 512;
/** Max elements extracted per array field. */
const MAX_ARRAY_ELEMENTS = 16;
/** meta:rate sliding window (µs). */
const RATE_WINDOW_US = 1_000_000;

const FIELD_NUMBER = /-?\d+(?:\.\d+)?/;
const STRICT_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ARRAY_INDEX_SUFFIX = /^(.+)\[(\d+)\]$/;

export interface CatalogEntry {
  name: string;
  unit?: string;
  count: number;
  lastTUs: number;
  lastValue: number;
}

export interface CachedSpectrum {
  freqHz: Float64Array;
  mag: Float64Array;
  db: Float64Array;
  sampleRateHz: number;
  peakHz: number;
  peakDb: number;
}

function parseScalarNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (/^0b[01]+$/i.test(trimmed)) return parseInt(trimmed.slice(2), 2);
  const m = FIELD_NUMBER.exec(v);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseArrayField(dv: unknown): number[] | null {
  if (Array.isArray(dv)) {
    const limit = Math.min(dv.length, MAX_ARRAY_ELEMENTS);
    const out: number[] = [];
    for (let i = 0; i < limit; i++) {
      const n = parseScalarNumber(dv[i]);
      out.push(n === null ? NaN : n);
    }
    return out;
  }
  if (typeof dv !== 'string') return null;
  const s = dv.trim();
  const bracketed = s.startsWith('[') && s.endsWith(']');
  if (!bracketed && !s.includes(',')) return null;
  const inner = bracketed ? s.slice(1, -1).trim() : s;
  if (inner.length === 0) return bracketed ? [] : null;
  const parts = inner.split(',');
  if (!bracketed && parts.length < 2) return null;
  const limit = Math.min(parts.length, MAX_ARRAY_ELEMENTS);
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].trim();
    if (!STRICT_NUMBER.test(tok)) {
      if (tok === 'NaN' || tok === 'nan') {
        if (i < limit) out.push(NaN);
        continue;
      }
      return null;
    }
    if (i < limit) {
      const n = parseFloat(tok);
      out.push(Number.isFinite(n) ? n : NaN);
    }
  }
  return out;
}

/** Numeric value of a named dissected field, preferring native numbers (with array[k] support). */
export const extractFieldNumber = (
  pkt: PacketRow,
  name: string
): { value: number; unit?: string } | null => {
  const fields = pkt.dissectedFields ?? [];
  for (const f of fields) {
    if (f.name !== name) continue;
    const dv: unknown = f.decodedValue;
    if (typeof dv === 'boolean') return null;
    if (Array.isArray(dv)) return null;
    const n = parseScalarNumber(dv);
    return n !== null ? { value: n, unit: f.unit } : null;
  }
  const idxMatch = ARRAY_INDEX_SUFFIX.exec(name);
  if (idxMatch) {
    const baseName = idxMatch[1];
    const elemIdx = parseInt(idxMatch[2], 10);
    if (elemIdx >= 0 && elemIdx < MAX_ARRAY_ELEMENTS) {
      for (const f of fields) {
        if (f.name !== baseName) continue;
        const arr = parseArrayField(f.decodedValue);
        if (arr && elemIdx < arr.length && Number.isFinite(arr[elemIdx])) {
          return { value: arr[elemIdx], unit: f.unit };
        }
        return null;
      }
    }
  }
  return null;
};

function medianDeltaUs(t: Float64Array, scratchDiffs: Float64Array): number {
  const len = t.length;
  if (len < 2) return 1000;
  const n = len - 1;
  const diffs = scratchDiffs.length >= n ? scratchDiffs.subarray(0, n) : new Float64Array(n);
  for (let i = 0; i < n; i++) diffs[i] = t[i + 1] - t[i];
  diffs.sort();
  return diffs[Math.floor(n / 2)] || 1000;
}

interface ChannelRuntime {
  def: ChannelDef;
  /** Label this runtime is registered under in byLabel (rename tracking). */
  registeredLabel: string;
  ring: SampleRing;
  expr?: CompiledExpr;
  lastValue: number;
  lastTUs: number;
  scratchT?: Float64Array;
  scratchV?: Float64Array;
}

export interface DataExtent {
  tMinUs: number;
  tMaxUs: number;
}

interface SpectrumCacheEntry {
  length: number;
  tMax: number;
  result: CachedSpectrum;
}

export class PlotEngine {
  private channels = new Map<string, ChannelRuntime>();
  private byLabel = new Map<string, ChannelRuntime>();
  private catalog = new Map<string, CatalogEntry>();
  /** Reusable per-packet field cache for O(F + C) single-pass extraction. */
  private pktValues = new Map<string, number>();
  private pktValuesPkt: PacketRow | null = null;
  private exprVars: Record<string, number> = {};
  /** (tUs, bytes) O(1) sliding queue for the meta:rate metric. */
  private rateWindow: Array<{ tUs: number; bytes: number }> = [];
  private rateHead = 0;
  private rateWindowBytes = 0;
  private currentByteRate = 0;
  private lastSeqId = 0;
  private depth = PLOT_DEPTH_DEFAULT;
  private _dataVersion = 0;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private sourcePackets: () => PacketRow[] = () => [];

  // Reusable scratch buffers for zero-allocation queries.
  private scratchT = new Float64Array(4096);
  private scratchV = new Float64Array(4096);
  private xyScratchX = new Float64Array(4096);
  private xyScratchY = new Float64Array(4096);
  private fftDiffScratch = new Float64Array(4096);
  private spectrumCache = new Map<string, SpectrumCacheEntry>();

  get channelCount(): number {
    return this.channels.size;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Bumped on every data or channel-registry mutation. */
  get dataVersion(): number {
    return this._dataVersion;
  }

  getDataVersion(): number {
    return this._dataVersion;
  }

  getChannelRing(id: string): SampleRing | undefined {
    return this.channels.get(id)?.ring;
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
      this.updateRateWindow(pkt.timestampUs, pkt.length);
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
    this._dataVersion++;
  }

  // ---- channel lifecycle -------------------------------------------------

  /**
   * Register or re-sync a channel. When the source of an existing channel
   * changed, its ring is rebuilt (and field/meta/expr sources backfilled from
   * the reactive packet buffer via the wired accessor).
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
    this.backfillChannel(rt);
    this._dataVersion++;
  }

  removeChannel(channelId: string): void {
    const rt = this.channels.get(channelId);
    if (!rt) return;
    if (this.byLabel.get(rt.registeredLabel) === rt) this.byLabel.delete(rt.registeredLabel);
    this.channels.delete(channelId);
    this.invalidateSpectrumForChannel(channelId);
    this._dataVersion++;
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
      rt.ring = rt.ring.resize(clamped);
    }
    this.spectrumCache.clear();
    this._dataVersion++;
  }

  get ringDepth(): number {
    return this.depth;
  }

  /** Drop all sample history + catalog; channel definitions survive. */
  clearData(): void {
    for (const rt of this.channels.values()) {
      rt.ring.clear();
      rt.lastValue = NaN;
      rt.lastTUs = NaN;
    }
    this.rateWindow = [];
    this.rateHead = 0;
    this.rateWindowBytes = 0;
    this.currentByteRate = 0;
    this.pktValues.clear();
    this.pktValuesPkt = null;
    this.catalog.clear();
    this.spectrumCache.clear();
    this.lastSeqId = 0;
    this._dataVersion++;
  }

  /** Full teardown (tests). Also unwires the backfill accessor. */
  reset(): void {
    this.channels.clear();
    this.byLabel.clear();
    this.catalog.clear();
    this.pktValues.clear();
    this.pktValuesPkt = null;
    this.rateWindow = [];
    this.rateHead = 0;
    this.rateWindowBytes = 0;
    this.currentByteRate = 0;
    this.spectrumCache.clear();
    this.lastSeqId = 0;
    this.sourcePackets = () => [];
    this.depth = PLOT_DEPTH_DEFAULT;
    this._dataVersion++;
  }

  private invalidateSpectrumForChannel(channelId: string): void {
    const prefix = `${channelId}:`;
    for (const key of this.spectrumCache.keys()) {
      if (key.startsWith(prefix)) this.spectrumCache.delete(key);
    }
  }

  // ---- per-packet plumbing ------------------------------------------------

  private updateRateWindow(tUs: number, bytes: number): void {
    this.rateWindow.push({ tUs, bytes });
    this.rateWindowBytes += bytes;
    const floor = tUs - RATE_WINDOW_US;
    while (this.rateHead < this.rateWindow.length && this.rateWindow[this.rateHead].tUs < floor) {
      this.rateWindowBytes -= this.rateWindow[this.rateHead].bytes;
      this.rateHead++;
    }
    if (this.rateHead > 1024 && this.rateHead * 2 >= this.rateWindow.length) {
      this.rateWindow = this.rateWindow.slice(this.rateHead);
      this.rateHead = 0;
    }
    this.currentByteRate = this.rateWindowBytes;
  }

  private recordCatalogValue(name: string, value: number, unit: string | undefined, tUs: number): void {
    if (!Number.isFinite(value)) return;
    this.pktValues.set(name, value);
    let entry = this.catalog.get(name);
    if (!entry) {
      if (this.catalog.size >= CATALOG_CAP) return;
      entry = { name, count: 0, lastTUs: 0, lastValue: value };
      this.catalog.set(name, entry);
    }
    entry.count++;
    entry.unit = unit ?? entry.unit;
    entry.lastTUs = tUs;
    entry.lastValue = value;
  }

  private scanCatalog(pkt: PacketRow): void {
    this.pktValues.clear();
    this.pktValuesPkt = pkt;
    for (const f of pkt.dissectedFields ?? []) {
      const dv: unknown = f.decodedValue;
      if (typeof dv === 'boolean') continue;

      if (Array.isArray(dv) || typeof dv === 'string') {
        const arr = parseArrayField(dv);
        if (arr !== null) {
          for (let k = 0; k < arr.length; k++) {
            this.recordCatalogValue(`${f.name}[${k}]`, arr[k], f.unit, pkt.timestampUs);
          }
          if (Array.isArray(f.bitfield)) {
            for (const bf of f.bitfield) {
              if (typeof bf.val === 'number') {
                this.recordCatalogValue(`${f.name}.${bf.name}`, bf.val, undefined, pkt.timestampUs);
              }
            }
          }
          continue;
        }
      }

      const scalar = parseScalarNumber(dv);
      if (scalar !== null) {
        this.recordCatalogValue(f.name, scalar, f.unit, pkt.timestampUs);
      }

      if (Array.isArray(f.bitfield)) {
        for (const bf of f.bitfield) {
          if (typeof bf.val === 'number') {
            this.recordCatalogValue(`${f.name}.${bf.name}`, bf.val, undefined, pkt.timestampUs);
          }
        }
      }
    }
  }

  private pushChannel(rt: ChannelRuntime, pkt: PacketRow): void {
    const src = rt.def.source;
    let value: number | null = null;
    if (src.kind === 'field') {
      if (this.pktValuesPkt === pkt) {
        const cached = this.pktValues.get(src.name);
        if (cached !== undefined) value = cached;
      } else {
        const extracted = extractFieldNumber(pkt, src.name);
        if (extracted) value = extracted.value;
      }
    } else if (src.kind === 'meta') {
      if (src.metric === 'length') value = pkt.length;
      else if (src.metric === 'delta') value = pkt.deltaUs;
      else value = this.currentByteRate;
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
    const vars = this.exprVars;
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
    this.invalidateSpectrumForChannel(rt.def.id);
    if (rt.def.source.kind === 'expr') {
      rt.expr = undefined;
      const compiled = compileExpr(rt.def.source.source);
      if (compiled.ok) rt.expr = compiled;
    }
    this.backfillChannel(rt);
    this._dataVersion++;
  }

  /** Seed a channel (field, meta, or expr) from the reactive packet buffer. */
  private backfillChannel(rt: ChannelRuntime): void {
    const pkts = this.sourcePackets();
    if (pkts.length === 0) return;

    const src = rt.def.source;
    if (src.kind === 'meta' && src.metric === 'rate') {
      // Compute local 1s sliding byte rate without mutating live rateWindow.
      const win: Array<{ tUs: number; bytes: number }> = [];
      let head = 0;
      let bytes = 0;
      for (const pkt of pkts) {
        win.push({ tUs: pkt.timestampUs, bytes: pkt.length });
        bytes += pkt.length;
        const floor = pkt.timestampUs - RATE_WINDOW_US;
        while (head < win.length && win[head].tUs < floor) {
          bytes -= win[head].bytes;
          head++;
        }
        if (Number.isFinite(bytes)) {
          rt.ring.push(pkt.timestampUs, bytes);
          rt.lastValue = bytes;
          rt.lastTUs = pkt.timestampUs;
        }
      }
      this._dataVersion++;
      return;
    }

    if (src.kind === 'expr') {
      if (!rt.expr) {
        const compiled = compileExpr(src.source);
        if (!compiled.ok) return;
        rt.expr = compiled;
      }
      const expr = rt.expr;
      const refs = expr.refs;
      const vars = this.exprVars;
      const refChannels = refs.map((r) => this.byLabel.get(r));
      const exprRingPtrs = new Int32Array(refs.length);
      let needLocalRate = false;
      for (let i = 0; i < refs.length; i++) {
        vars[refs[i]] = NaN;
        const ch = refChannels[i];
        if (ch?.def.source.kind === 'meta' && ch.def.source.metric === 'rate') {
          needLocalRate = true;
        }
      }
      const rateWin: Array<{ tUs: number; bytes: number }> = [];
      let rateHead = 0;
      let rateBytes = 0;

      for (const pkt of pkts) {
        if (needLocalRate) {
          rateWin.push({ tUs: pkt.timestampUs, bytes: pkt.length });
          rateBytes += pkt.length;
          const floor = pkt.timestampUs - RATE_WINDOW_US;
          while (rateHead < rateWin.length && rateWin[rateHead].tUs < floor) {
            rateBytes -= rateWin[rateHead].bytes;
            rateHead++;
          }
        }
        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i];
          const ch = refChannels[i];
          if (!ch) {
            const extracted = extractFieldNumber(pkt, ref);
            if (extracted) vars[ref] = extracted.value;
          } else if (ch.def.source.kind === 'field') {
            const extracted = extractFieldNumber(pkt, ch.def.source.name);
            if (extracted) vars[ref] = extracted.value;
          } else if (ch.def.source.kind === 'meta') {
            if (ch.def.source.metric === 'length') vars[ref] = pkt.length;
            else if (ch.def.source.metric === 'delta') vars[ref] = pkt.deltaUs;
            else vars[ref] = rateBytes;
          } else if (ch.ring.length > 0) {
            let ptr = exprRingPtrs[i];
            while (ptr + 1 < ch.ring.length && ch.ring.tAt(ptr + 1) <= pkt.timestampUs) ptr++;
            exprRingPtrs[i] = ptr;
            if (ch.ring.tAt(ptr) <= pkt.timestampUs) vars[ref] = ch.ring.vAt(ptr);
          }
        }
        const value = expr.fn(vars);
        if (Number.isFinite(value)) {
          rt.ring.push(pkt.timestampUs, value);
          rt.lastValue = value;
          rt.lastTUs = pkt.timestampUs;
        }
      }
      this._dataVersion++;
      return;
    }

    for (const pkt of pkts) this.pushChannel(rt, pkt);
    this._dataVersion++;
  }

  // ---- queries -------------------------------------------------------------

  /**
   * Raw samples in [tMin, tMax] for CSV export, uniformly strided down to at
   * most `maxSamples` rows (0/undefined = no limit).
   */
  getWindowSamples(
    channelId: string,
    tMinUs: number,
    tMaxUs: number,
    maxSamples = 0
  ): Array<{ tUs: number; v: number }> {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return [];
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    const count = hi - lo;
    if (count <= 0) return [];
    const stride = maxSamples > 0 ? Math.max(1, Math.ceil(count / maxSamples)) : 1;
    const out: Array<{ tUs: number; v: number }> = [];
    for (let i = lo; i < hi; i += stride) out.push({ tUs: rt.ring.tAt(i), v: rt.ring.vAt(i) });
    return out;
  }

  /** Raw sample count in [tMin, tMax] — the pre-stride row count. */
  getWindowSampleCount(channelId: string, tMinUs: number, tMaxUs: number): number {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return 0;
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    return Math.max(0, hi - lo);
  }

  /** Min-max decimated series for painting a [tMin, tMax] µs window. */
  getSeries(channelId: string, tMinUs: number, tMaxUs: number, buckets: number): DecimatedPoint[] {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return [];
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    if (hi <= lo) return [];
    return decimateMinMax((i) => rt.ring.tAt(i), (i) => rt.ring.vAt(i), lo, hi, Math.max(1, buckets));
  }

  /**
   * Zero-allocation min-max decimated series into per-channel reusable scratch
   * Float64Arrays, returning global min/max over [tMinUs, tMaxUs] in the same pass.
   */
  getSeriesScratch(
    id: string,
    tMinUs: number,
    tMaxUs: number,
    buckets: number
  ): { t: Float64Array; v: Float64Array; count: number; min: number; max: number } {
    const rt = this.channels.get(id);
    if (!rt || rt.ring.length === 0 || buckets < 1) {
      return { t: this.scratchT, v: this.scratchV, count: 0, min: 0, max: 0 };
    }
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    if (hi <= lo) {
      return { t: this.scratchT, v: this.scratchV, count: 0, min: 0, max: 0 };
    }
    const b = Math.max(1, Math.floor(buckets));
    const needed = b * 4;
    if (!rt.scratchT || !rt.scratchV || rt.scratchT.length < needed) {
      let cap = Math.max(4096, rt.scratchT?.length ?? 4096);
      while (cap < needed) cap *= 2;
      rt.scratchT = new Float64Array(cap);
      rt.scratchV = new Float64Array(cap);
    }
    const res = decimateMinMaxInto(
      lo,
      hi,
      b,
      (i) => rt.ring.tAt(i),
      (i) => rt.ring.vAt(i),
      rt.scratchT,
      rt.scratchV
    );
    return {
      t: rt.scratchT,
      v: rt.scratchV,
      count: res.count,
      min: res.min,
      max: res.max,
    };
  }

  /** Contiguous newest-n copy for FFT / histogram / XY pairing. */
  getTail(channelId: string, n: number): { t: Float64Array; v: Float64Array } {
    const rt = this.channels.get(channelId);
    if (!rt) return { t: new Float64Array(0), v: new Float64Array(0) };
    return rt.ring.tailArrays(n);
  }

  /**
   * Cached FFT magnitude spectrum for `id`, invalidated only when the ring's
   * sample count or latest timestamp changes.
   */
  getCachedSpectrum(
    id: string,
    fftSize: number,
    window: 'hann' | 'rect'
  ): CachedSpectrum | null {
    const rt = this.channels.get(id);
    if (!rt || rt.ring.length < 2 || fftSize < 2) return null;

    const len = rt.ring.length;
    const tMax = rt.ring.tMax;
    const key = `${id}:${fftSize}:${window}`;
    const cached = this.spectrumCache.get(key);
    if (cached && cached.length === len && cached.tMax === tMax) {
      return cached.result;
    }

    const tail = rt.ring.tailArrays(fftSize);
    if (tail.v.length < 2) return null;
    if (this.fftDiffScratch.length < tail.t.length) {
      let cap = this.fftDiffScratch.length;
      while (cap < tail.t.length) cap *= 2;
      this.fftDiffScratch = new Float64Array(cap);
    }
    const dtUs = medianDeltaUs(tail.t, this.fftDiffScratch);
    const sampleRateHz = dtUs > 0 ? 1e6 / dtUs : 1000;
    const spec = magnitudeSpectrum(tail.v, sampleRateHz, { detrend: true, window });
    if (spec.freqHz.length === 0) return null;

    const result: CachedSpectrum = {
      freqHz: spec.freqHz,
      mag: spec.mag,
      db: spec.db,
      sampleRateHz,
      peakHz: spec.peakHz,
      peakDb: spec.peakMag > 0 ? 20 * Math.log10(spec.peakMag) : -200,
    };
    this.spectrumCache.set(key, { length: len, tMax, result });
    return result;
  }

  /**
   * Timestamp-aligned XY sample pairs across the overlapping window
   * [max(x.tMin, y.tMin), min(x.tMax, y.tMax)], linearly interpolating the
   * sparser series onto the denser series' timestamps into reusable buffers.
   */
  getAlignedXy(
    xId: string,
    yId: string,
    maxPoints: number
  ): { xs: Float64Array; ys: Float64Array; count: number } {
    const xRt = this.channels.get(xId);
    const yRt = this.channels.get(yId);
    if (!xRt || !yRt || xRt.ring.length === 0 || yRt.ring.length === 0 || maxPoints < 1) {
      return { xs: this.xyScratchX, ys: this.xyScratchY, count: 0 };
    }

    const xRing = xRt.ring;
    const yRing = yRt.ring;
    const tLo = Math.max(xRing.tMin, yRing.tMin);
    const tHi = Math.min(xRing.tMax, yRing.tMax);
    if (tHi < tLo) {
      return { xs: this.xyScratchX, ys: this.xyScratchY, count: 0 };
    }

    const xRange = xRing.rangeFor(tLo, tHi);
    const yRange = yRing.rangeFor(tLo, tHi);
    const xCount = xRange.hi - xRange.lo;
    const yCount = yRange.hi - yRange.lo;
    if (xCount === 0 || yCount === 0) {
      return { xs: this.xyScratchX, ys: this.xyScratchY, count: 0 };
    }

    const cap = Math.max(1, Math.floor(maxPoints));
    if (this.xyScratchX.length < cap) {
      let newCap = this.xyScratchX.length;
      while (newCap < cap) newCap *= 2;
      this.xyScratchX = new Float64Array(newCap);
      this.xyScratchY = new Float64Array(newCap);
    }

    const xDrives = xCount >= yCount;
    const driver = xDrives ? xRing : yRing;
    const other = xDrives ? yRing : xRing;
    const dRange = xDrives ? xRange : yRange;
    const dStart = Math.max(dRange.lo, dRange.hi - cap);
    const dEnd = dRange.hi;

    let j = other.lowerBound(driver.tAt(dStart));
    let outIdx = 0;

    for (let i = dStart; i < dEnd; i++) {
      const t = driver.tAt(i);
      const dVal = driver.vAt(i);
      while (j < other.length && other.tAt(j) < t) j++;

      let oVal: number;
      if (j < other.length && other.tAt(j) === t) {
        oVal = other.vAt(j);
      } else if (j > 0 && j < other.length) {
        const t0 = other.tAt(j - 1);
        const t1 = other.tAt(j);
        const v0 = other.vAt(j - 1);
        const v1 = other.vAt(j);
        oVal = t1 > t0 ? v0 + ((t - t0) / (t1 - t0)) * (v1 - v0) : v0;
      } else if (j === 0) {
        oVal = other.vAt(0);
      } else {
        oVal = other.vAt(other.length - 1);
      }

      this.xyScratchX[outIdx] = xDrives ? dVal : oVal;
      this.xyScratchY[outIdx] = xDrives ? oVal : dVal;
      outIdx++;
    }

    return { xs: this.xyScratchX, ys: this.xyScratchY, count: outIdx };
  }

  /**
   * Nearest sample to `tUs` within `toleranceUs` — crosshair readout helper.
   * Returns null when the channel is empty or has no sample within tolerance.
   */
  sampleNearest(channelId: string, tUs: number, toleranceUs: number): { tUs: number; value: number } | null {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return null;
    const ring = rt.ring;
    const { lo, hi } = ring.rangeFor(tUs - toleranceUs, tUs + toleranceUs);
    if (hi <= lo) return null;
    const idx = Math.min(hi, Math.max(lo, ring.lowerBound(tUs)));
    let best = -1;
    let bestDist = Infinity;
    for (const i of [idx - 1, idx]) {
      if (i < lo || i >= hi) continue;
      const d = Math.abs(ring.tAt(i) - tUs);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === -1 || bestDist > toleranceUs) return null;
    return { tUs: ring.tAt(best), value: ring.vAt(best) };
  }

  getStats(
    channelId: string,
    tMinUs: number,
    tMaxUs: number
  ): (WindowStats & { rms: number; pkPk: number; last: number }) | null {
    const rt = this.channels.get(channelId);
    if (!rt || rt.ring.length === 0) return null;
    const { lo, hi } = rt.ring.rangeFor(tMinUs, tMaxUs);
    if (hi <= lo) return null;
    const s = rt.ring.statsInRange(lo, hi);
    return {
      min: s.min,
      max: s.max,
      mean: s.mean,
      stdDev: s.stdDev,
      count: s.n,
      rms: s.rms,
      pkPk: s.pkPk,
      last: s.last,
    };
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

  /**
   * Direct ingestion hook for Lua `bforge.plot(series, value)` metrics when
   * packets are dropped by a script or when PlotEngine has not subscribed to the store.
   */
  pushScriptMetric(series: string, tUs: number, value: number, unit?: string): void {
    if (!Number.isFinite(value) || !Number.isFinite(tUs)) return;
    const key = series.startsWith('script:') ? series : `script:${series}`;
    const prefixedKey = `field:${key}`;
    this.recordCatalogValue(key, value, unit, tUs);
    let updated = false;
    for (const rt of this.channels.values()) {
      const src = rt.def.source;
      if (src.kind === 'field' && (src.name === key || src.name === prefixedKey)) {
        const safeT = Number.isFinite(rt.lastTUs) && tUs <= rt.lastTUs ? rt.lastTUs + 1 : tUs;
        rt.ring.push(safeT, value);
        rt.lastValue = value;
        rt.lastTUs = safeT;
        updated = true;
      }
    }
    if (updated) {
      this._dataVersion++;
    }
  }

  channelLabel(channelId: string): string {
    return this.channels.get(channelId)?.def.label ?? '';
  }
}

export const plotEngine = new PlotEngine();

// Smoke-test handle (mirrors __bforgeStore in useWorkstationStore).
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__bforgePlotEngine = plotEngine;
}
