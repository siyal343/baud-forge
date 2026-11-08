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

  it('rangeFor finds the half-open window on monotonic timestamps', () => {
    const r = new SampleRing(100);
    for (let i = 0; i < 50; i++) r.push(i * 10, i);
    // Window [15, 35] µs → logical indices 2 (t=20) .. 3 (t=30), hi exclusive.
    expect(r.rangeFor(15, 35)).toEqual({ lo: 2, hi: 4 });
    // Clamp on both ends.
    expect(r.rangeFor(-100, 10_000)).toEqual({ lo: 0, hi: 50 });
    // Empty window when the range precedes all samples.
    expect(r.rangeFor(-50, -1)).toEqual({ lo: 0, hi: 0 });
  });

  it('rangeFor works across a wrapped buffer', () => {
    const r = new SampleRing(10);
    for (let i = 0; i < 25; i++) r.push(i * 10, i);
    // Ring now holds i=15..24 → t=150..240. Window [200, 220] → i=20,21.
    expect(r.rangeFor(200, 220)).toEqual({ lo: 5, hi: 7 });
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
  });
});
