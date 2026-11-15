// Fixed-capacity ring buffer for (tUs, value) sample pairs backed by two
// parallel Float64Arrays, plus an L1 64-sample physical-block mipmap for O(N/64)
// range statistics. Newest-sample overwrite drops the oldest, mirroring the
// engine's SeriesSet rings. Iteration is always logical order (oldest → newest)
// so painters and decimators never see wrap-around.

export const RING_BLOCK_SIZE = 64;

export interface RangeStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  rms: number;
  pkPk: number;
  last: number;
  n: number;
}

export class SampleRing {
  readonly cap: number;
  private readonly t: Float64Array;
  private readonly v: Float64Array;
  private start = 0;
  private count = 0;

  // L1 physical-block mipmap (lazy dirty recomputation on statsInRange).
  private readonly blockCount: number;
  private readonly blockMin: Float64Array;
  private readonly blockMax: Float64Array;
  private readonly blockSum: Float64Array;
  private readonly blockSumSq: Float64Array;
  private readonly blockM2: Float64Array;
  private readonly blockCountArr: Uint16Array;
  private readonly blockDirty: Uint8Array;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) throw new Error(`bad capacity: ${capacity}`);
    this.cap = Math.floor(capacity);
    this.t = new Float64Array(this.cap);
    this.v = new Float64Array(this.cap);

    this.blockCount = Math.ceil(this.cap / RING_BLOCK_SIZE);
    this.blockMin = new Float64Array(this.blockCount);
    this.blockMax = new Float64Array(this.blockCount);
    this.blockSum = new Float64Array(this.blockCount);
    this.blockSumSq = new Float64Array(this.blockCount);
    this.blockM2 = new Float64Array(this.blockCount);
    this.blockCountArr = new Uint16Array(this.blockCount);
    this.blockDirty = new Uint8Array(this.blockCount);
    this.blockDirty.fill(1);
  }

  get length(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Timestamp of the oldest sample (NaN when empty). */
  get tMin(): number {
    return this.count === 0 ? NaN : this.t[this.start];
  }

  /** Timestamp of the newest sample (NaN when empty). */
  get tMax(): number {
    return this.count === 0 ? NaN : this.t[(this.start + this.count - 1) % this.cap];
  }

  /** Timestamp of the newest sample (NaN when empty). */
  get lastT(): number {
    return this.tMax;
  }

  /** Value of the newest sample (NaN when empty). */
  get lastV(): number {
    return this.count === 0 ? NaN : this.vAt(this.count - 1);
  }

  /** Logical-index access, 0 = oldest. Throws outside [0, length). */
  tAt(i: number): number {
    if (i < 0 || i >= this.count) throw new RangeError(`index ${i} / ${this.count}`);
    return this.t[(this.start + i) % this.cap];
  }

  vAt(i: number): number {
    if (i < 0 || i >= this.count) throw new RangeError(`index ${i} / ${this.count}`);
    return this.v[(this.start + i) % this.cap];
  }

  push(tUs: number, value: number): void {
    const idx = (this.start + this.count) % this.cap;
    this.t[idx] = tUs;
    this.v[idx] = value;
    this.blockDirty[(idx / RING_BLOCK_SIZE) | 0] = 1;
    if (this.count < this.cap) {
      this.count++;
    } else {
      this.start = (this.start + 1) % this.cap;
    }
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.blockDirty.fill(1);
    this.blockCountArr.fill(0);
  }

  /**
   * Create a new SampleRing with `newCap`, keeping up to the newest `newCap`
   * samples directly without intermediate array allocation.
   */
  resize(newCap: number): SampleRing {
    const next = new SampleRing(newCap);
    const take = Math.min(this.count, next.cap);
    const from = this.count - take;
    for (let i = 0; i < take; i++) {
      const phy = (this.start + from + i) % this.cap;
      next.t[i] = this.t[phy];
      next.v[i] = this.v[phy];
    }
    next.count = take;
    return next;
  }

  private recomputeBlock(b: number): void {
    const base = b * RING_BLOCK_SIZE;
    let bMin = Infinity;
    let bMax = -Infinity;
    let bSum = 0;
    let bSumSq = 0;
    let bMean = 0;
    let bM2 = 0;
    for (let k = 0; k < RING_BLOCK_SIZE; k++) {
      const val = this.v[base + k];
      if (val < bMin) bMin = val;
      if (val > bMax) bMax = val;
      bSum += val;
      bSumSq += val * val;
      const d = val - bMean;
      bMean += d / (k + 1);
      bM2 += d * (val - bMean);
    }
    this.blockMin[b] = bMin;
    this.blockMax[b] = bMax;
    this.blockSum[b] = bSum;
    this.blockSumSq[b] = bSumSq;
    this.blockM2[b] = bM2;
    this.blockCountArr[b] = RING_BLOCK_SIZE;
    this.blockDirty[b] = 0;
  }

  /**
   * Compute summary statistics across logical indices [lo, hi) using L1 cached
   * physical blocks for interior 64-sample segments and Chan's parallel Welford
   * combination for numerical stability.
   */
  statsInRange(lo: number, hi: number): RangeStats {
    const startI = Math.max(0, Math.min(this.count, Math.floor(lo)));
    const endI = Math.max(0, Math.min(this.count, Math.floor(hi)));
    if (startI >= endI) {
      return { min: 0, max: 0, mean: 0, stdDev: 0, rms: 0, pkPk: 0, last: 0, n: 0 };
    }

    let n = 0;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    let sumSq = 0;

    let i = startI;
    while (i < endI) {
      const phy = (this.start + i) % this.cap;
      const rem = endI - i;
      if (phy % RING_BLOCK_SIZE === 0 && rem >= RING_BLOCK_SIZE && phy + RING_BLOCK_SIZE <= this.cap) {
        const b = (phy / RING_BLOCK_SIZE) | 0;
        if (this.blockDirty[b]) this.recomputeBlock(b);
        const bn = this.blockCountArr[b];
        const bMean = this.blockSum[b] / bn;
        const bM2 = this.blockM2[b];
        if (n === 0) {
          n = bn;
          mean = bMean;
          m2 = bM2;
        } else {
          const newN = n + bn;
          const delta = bMean - mean;
          mean += delta * (bn / newN);
          m2 += bM2 + delta * delta * ((n * bn) / newN);
          n = newN;
        }
        sumSq += this.blockSumSq[b];
        if (this.blockMin[b] < min) min = this.blockMin[b];
        if (this.blockMax[b] > max) max = this.blockMax[b];
        i += RING_BLOCK_SIZE;
      } else {
        const toBlockEnd = RING_BLOCK_SIZE - (phy % RING_BLOCK_SIZE);
        const toCap = this.cap - phy;
        const step = Math.min(rem, toBlockEnd, toCap);
        for (let k = 0; k < step; k++) {
          const val = this.v[phy + k];
          n++;
          const d = val - mean;
          mean += d / n;
          m2 += d * (val - mean);
          sumSq += val * val;
          if (val < min) min = val;
          if (val > max) max = val;
        }
        i += step;
      }
    }

    const last = this.v[(this.start + endI - 1) % this.cap];
    const stdDev = n > 1 ? Math.sqrt(Math.max(0, m2) / (n - 1)) : 0;
    const rms = Math.sqrt(sumSq / n);
    return {
      min,
      max,
      mean,
      stdDev,
      rms,
      pkPk: max - min,
      last,
      n,
    };
  }

  /** Iterate oldest → newest. Callback receives (logicalIndex, tUs, value). */
  forEach(fn: (i: number, tUs: number, value: number) => void): void {
    for (let i = 0; i < this.count; i++) fn(i, this.tAt(i), this.vAt(i));
  }

  /**
   * Logical-index range [lo, hi) covering tUs ∈ [tMin, tMax] inclusive: a
   * sample sitting exactly at tMax belongs to the window (F-41), so hi is the
   * first index with t > tMax. Both bounds are clamped to [0, length]; hi is
   * exclusive. Requires monotonic non-decreasing timestamps (the feed
   * guarantees this). Binary search on logical indices.
   */
  rangeFor(tMin: number, tMax: number): { lo: number; hi: number } {
    const lo = this.lowerBound(tMin);
    const hi = this.upperBound(tMax);
    return { lo, hi: Math.min(this.count, Math.max(lo, hi)) };
  }

  /** First logical index with t >= target (== count when none). */
  lowerBound(target: number): number {
    let a = 0;
    let b = this.count;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (this.tAt(mid) < target) a = mid + 1;
      else b = mid;
    }
    return a;
  }

  /** First logical index with t > target (== count when none). */
  upperBound(target: number): number {
    let a = 0;
    let b = this.count;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (this.tAt(mid) <= target) a = mid + 1;
      else b = mid;
    }
    return a;
  }

  /**
   * Copy the newest `n` samples into freshly allocated arrays (oldest →
   * newest). Returns fewer than `n` when the ring holds less. Used by FFT,
   * histogram and XY pairing, which need contiguous arrays.
   */
  tailArrays(n: number): { t: Float64Array; v: Float64Array } {
    const take = Math.min(n, this.count);
    const t = new Float64Array(take);
    const v = new Float64Array(take);
    const from = this.count - take;
    for (let i = 0; i < take; i++) {
      t[i] = this.tAt(from + i);
      v[i] = this.vAt(from + i);
    }
    return { t, v };
  }
}
