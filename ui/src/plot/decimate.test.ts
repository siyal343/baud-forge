// Decimation verification: envelope preservation, ordering, LTTB shape.
import { describe, it, expect } from 'vitest';
import { decimateMinMax, lttbIndices } from './decimate';

describe('decimateMinMax', () => {
  it('passes through when the slice fits within the bucket budget', () => {
    const t = [0, 1, 2];
    const v = [5, 6, 7];
    const out = decimateMinMax((i) => t[i], (i) => v[i], 0, 3, 10);
    expect(out).toEqual([
      { t: 0, v: 5 },
      { t: 1, v: 6 },
      { t: 2, v: 7 },
    ]);
  });

  it('preserves a narrow spike that pixel-stride sampling would miss', () => {
    // 1000-point flat line with a single spike at index 500.
    const n = 1000;
    const vOf = (i: number) => (i === 500 ? 1000 : 0);
    const out = decimateMinMax((i) => i, vOf, 0, n, 10);
    const vs = out.map((p) => p.v);
    expect(vs).toContain(1000);
    expect(out.length).toBeLessThanOrEqual(4 * 10);
  });

  it('keeps output sorted by t with min and max in time order', () => {
    // Descending ramp inside each bucket → max appears BEFORE min in time.
    const n = 100;
    const vOf = (i: number) => n - i;
    const out = decimateMinMax((i) => i, vOf, 0, n, 5);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThanOrEqual(out[i - 1].t);
    }
    // Envelope endpoints of the full ramp are present.
    expect(out.map((p) => p.v)).toContain(100);
    expect(out.map((p) => p.v)).toContain(1);
  });

  it('returns empty for empty ranges and degenerate buckets', () => {
    expect(decimateMinMax(() => 0, () => 0, 5, 5, 10)).toEqual([]);
    expect(decimateMinMax(() => 0, () => 0, 0, 10, 0)).toEqual([]);
  });
});

describe('lttbIndices', () => {
  it('is the identity when threshold >= n or below the minimum', () => {
    const xs = [0, 1, 2, 3];
    const ys = [0, 1, 0, 1];
    expect(lttbIndices(xs, ys, 10)).toEqual([0, 1, 2, 3]);
    expect(lttbIndices(xs, ys, 2)).toEqual([0, 1, 2, 3]);
  });

  it('returns exactly `threshold` indices including both endpoints', () => {
    const n = 200;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = Array.from({ length: n }, (_, i) => Math.sin(i / 5));
    const idx = lttbIndices(xs, ys, 12);
    expect(idx).toHaveLength(12);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(n - 1);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it('keeps a dominant spike', () => {
    const n = 300;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = Array.from({ length: n }, (_, i) => (i === 150 ? 500 : 0.01 * Math.sin(i)));
    const idx = lttbIndices(xs, ys, 20);
    expect(idx).toContain(150);
  });
});
