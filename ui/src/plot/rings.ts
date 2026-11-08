// Fixed-capacity ring buffer for (tUs, value) sample pairs backed by two
// parallel Float64Arrays. Newest-sample overwrite drops the oldest, mirroring
// the engine's SeriesSet rings. Iteration is always logical order (oldest →
// newest) so painters and decimators never see wrap-around.

export class SampleRing {
  private readonly cap: number;
  private readonly t: Float64Array;
  private readonly v: Float64Array;
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) throw new Error(`bad capacity: ${capacity}`);
    this.cap = Math.floor(capacity);
    this.t = new Float64Array(this.cap);
    this.v = new Float64Array(this.cap);
  }

  get length(): number {
    return this.count;
  }

  get capacity(): number {
    return this.cap;
  }

  /** Timestamp of the newest sample (NaN when empty). */
  get lastT(): number {
    return this.count === 0 ? NaN : this.tAt(this.count - 1);
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
    if (this.count < this.cap) {
      this.count++;
    } else {
      this.start = (this.start + 1) % this.cap;
    }
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  /** Iterate oldest → newest. Callback receives (logicalIndex, tUs, value). */
  forEach(fn: (i: number, tUs: number, value: number) => void): void {
    for (let i = 0; i < this.count; i++) fn(i, this.tAt(i), this.vAt(i));
  }

  /**
   * Logical-index range [lo, hi) covering tUs ∈ [tMin, tMax]. Both bounds are
   * clamped to [0, length]; hi is exclusive. Requires monotonic non-decreasing
   * timestamps (the feed guarantees this). Binary search on logical indices.
   */
  rangeFor(tMin: number, tMax: number): { lo: number; hi: number } {
    const lo = this.lowerBound(tMin);
    let hi = this.lowerBound(tMax);
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
