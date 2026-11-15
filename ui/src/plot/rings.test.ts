// SampleRing verification: wrap-around ordering, window queries, tail copies.
import { describe, it, expect } from 'vitest';
import { SampleRing } from './rings';

describe('SampleRing', () => {
  it('pushes and reads back in order before wrapping', () => {
    const r = new SampleRing(8);
    for (let i = 0; i < 5; i++) r.push(i * 10, i * 2);
    expect(r.length).toBe(5);
    expect(r.tAt(0)).toBe(0);
    expect(r.vAt(4)).toBe(8);
    expect(r.lastT).toBe(40);
    expect(r.lastV).toBe(8);
  });

  it('overwrites oldest samples after wrapping', () => {
    const r = new SampleRing(4);
    for (let i = 0; i < 10; i++) r.push(i, i * 100);
    expect(r.length).toBe(4);
    // Oldest→newest must be 6,7,8,9 despite physical layout wrapping.
    const vals: number[] = [];
    r.forEach((_, _t, v) => vals.push(v));
    expect(vals).toEqual([600, 700, 800, 900]);
    expect(r.lastV).toBe(900);
  });

  it('rejects out-of-range logical indices', () => {
    const r = new SampleRing(3);
    r.push(1, 2);
    expect(() => r.tAt(-1)).toThrow(RangeError);
    expect(() => r.vAt(1)).toThrow(RangeError);
  });

  it('rejects invalid capacity', () => {
    expect(() => new SampleRing(0)).toThrow();
    expect(() => new SampleRing(NaN)).toThrow();
  });

  it('rangeFor covers the window inclusive of tMax on monotonic timestamps', () => {
    const r = new SampleRing(100);
    for (let i = 0; i < 50; i++) r.push(i * 10, i);
    // Window [15, 30] µs → logical indices 2 (t=20) .. 3 (t=30): a sample
    // sitting exactly on tMax is inside the window (F-41).
    expect(r.rangeFor(15, 30)).toEqual({ lo: 2, hi: 4 });
    // Clamp on both ends.
    expect(r.rangeFor(-100, 10_000)).toEqual({ lo: 0, hi: 50 });
    // Empty window when the range precedes all samples.
    expect(r.rangeFor(-50, -1)).toEqual({ lo: 0, hi: 0 });
  });

  it('rangeFor works across a wrapped buffer', () => {
    const r = new SampleRing(10);
    for (let i = 0; i < 25; i++) r.push(i * 10, i);
    // Ring now holds i=15..24 → t=150..240. Window [200, 220] → i=20,21,22 —
    // the sample sitting exactly on tMax is inside the window (F-41).
    expect(r.rangeFor(200, 220)).toEqual({ lo: 5, hi: 8 });
  });

  it('tailArrays copies the newest n in chronological order', () => {
    const r = new SampleRing(8);
    for (let i = 0; i < 6; i++) r.push(i, i * 10);
    const { t, v } = r.tailArrays(4);
    expect([...t]).toEqual([2, 3, 4, 5]);
    expect([...v]).toEqual([20, 30, 40, 50]);
    // Asking for more than held returns everything available.
    const all = r.tailArrays(100);
    expect(all.v.length).toBe(6);
  });

  it('clear resets to empty', () => {
    const r = new SampleRing(4);
    r.push(1, 1);
    r.clear();
    expect(r.length).toBe(0);
    expect(Number.isNaN(r.lastT)).toBe(true);
    expect(Number.isNaN(r.tMin)).toBe(true);
    expect(Number.isNaN(r.tMax)).toBe(true);
  });

  it('exposes tMin and tMax across empty, partial, and wrapped states', () => {
    const r = new SampleRing(4);
    expect(Number.isNaN(r.tMin)).toBe(true);
    expect(Number.isNaN(r.tMax)).toBe(true);
    r.push(10, 1);
    r.push(20, 2);
    expect(r.tMin).toBe(10);
    expect(r.tMax).toBe(20);
    for (let i = 3; i <= 7; i++) r.push(i * 10, i);
    expect(r.tMin).toBe(40);
    expect(r.tMax).toBe(70);
  });

  it('statsInRange matches naive per-sample Welford across partial, wrapped, and multi-block slices', () => {
    const naiveStats = (ring: SampleRing, lo: number, hi: number) => {
      if (lo >= hi) return { min: 0, max: 0, mean: 0, stdDev: 0, rms: 0, pkPk: 0, last: 0, n: 0 };
      let n = 0;
      let mean = 0;
      let m2 = 0;
      let min = Infinity;
      let max = -Infinity;
      let sumSq = 0;
      for (let i = lo; i < hi; i++) {
        const v = ring.vAt(i);
        n++;
        const d = v - mean;
        mean += d / n;
        m2 += d * (v - mean);
        sumSq += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return {
        min,
        max,
        mean,
        stdDev: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0,
        rms: Math.sqrt(sumSq / n),
        pkPk: max - min,
        last: ring.vAt(hi - 1),
        n,
      };
    };

    // Use a non-multiple-of-64 capacity (530) and push > 800 samples so the ring wraps cleanly.
    const r = new SampleRing(530);
    for (let i = 0; i < 810; i++) {
      const val = 1000 + Math.sin(i * 0.13) * 42 + (i % 17) * 0.5;
      r.push(i * 100, val);
    }

    const slices: Array<[number, number]> = [
      [0, r.length],
      [1, 529],
      [13, 497],
      [64, 384],
      [0, 65],
      [200, 201], // single sample
      [300, 300], // empty
      [400, 200], // inverted empty
    ];

    for (const [lo, hi] of slices) {
      // Run twice to exercise both dirty recomputation and cached block reuse.
      for (let pass = 0; pass < 2; pass++) {
        const got = r.statsInRange(lo, hi);
        const exp = naiveStats(r, lo, hi);
        expect(got.n).toBe(exp.n);
        expect(got.min).toBe(exp.min);
        expect(got.max).toBe(exp.max);
        expect(got.last).toBe(exp.last);
        expect(got.pkPk).toBeCloseTo(exp.pkPk, 10);
        expect(got.mean).toBeCloseTo(exp.mean, 10);
        expect(got.stdDev).toBeCloseTo(exp.stdDev, 10);
        expect(got.rms).toBeCloseTo(exp.rms, 10);
      }
    }

    // Overwriting a single sample invalidates only the affected dirty block cleanly.
    r.push(81_000, -999);
    const afterPush = r.statsInRange(0, r.length);
    const expAfter = naiveStats(r, 0, r.length);
    expect(afterPush.min).toBe(-999);
    expect(afterPush.last).toBe(-999);
    expect(afterPush.mean).toBeCloseTo(expAfter.mean, 10);
    expect(afterPush.stdDev).toBeCloseTo(expAfter.stdDev, 10);
    expect(afterPush.rms).toBeCloseTo(expAfter.rms, 10);
  });

  it('resize preserves newest samples across shrink and grow on wrapped rings', () => {
    const r = new SampleRing(10);
    for (let i = 0; i < 17; i++) r.push(i * 10, i * 100);
    // Holds 7..16
    const shrunk = r.resize(4);
    expect(shrunk.capacity).toBe(4);
    expect(shrunk.length).toBe(4);
    expect(shrunk.tMin).toBe(130);
    expect(shrunk.tMax).toBe(160);
    expect([...shrunk.tailArrays(10).v]).toEqual([1300, 1400, 1500, 1600]);

    const grown = r.resize(20);
    expect(grown.capacity).toBe(20);
    expect(grown.length).toBe(10);
    expect(grown.tMin).toBe(70);
    expect(grown.tMax).toBe(160);
    expect(grown.vAt(0)).toBe(700);
    expect(grown.vAt(9)).toBe(1600);
    expect(grown.statsInRange(0, 10).last).toBe(1600);
  });
});
