// Trigger crossing detector verification: rising, falling, either, sub-sample
// linear interpolation, holdoff suppression, search bounds, and ROLL/empty guards.
import { describe, it, expect } from 'vitest';
import { SampleRing } from './rings';
import { findTriggerCrossing } from './trigger';

describe('findTriggerCrossing', () => {
  it('returns untriggered for ROLL mode, empty rings, or single-sample rings', () => {
    const empty = new SampleRing(16);
    expect(findTriggerCrossing(empty, { mode: 'NORM', slope: 'RISING', level: 0 })).toEqual({
      triggered: false,
      triggerTimeUs: 0,
      crossingIndex: -1,
    });

    const single = new SampleRing(16);
    single.push(420, 1);
    expect(findTriggerCrossing(single, { mode: 'AUTO', slope: 'RISING', level: 0 })).toEqual({
      triggered: false,
      triggerTimeUs: 420,
      crossingIndex: -1,
    });

    const multi = new SampleRing(16);
    multi.push(100, -1);
    multi.push(200, 1);
    expect(findTriggerCrossing(multi, { mode: 'ROLL', slope: 'RISING', level: 0 })).toEqual({
      triggered: false,
      triggerTimeUs: 200,
      crossingIndex: -1,
    });
  });

  it('detects rising edges with sub-sample linear interpolation and returns the latest', () => {
    const r = new SampleRing(32);
    // Crossing 1 between t=100 (v=-2) and t=200 (v=2) -> level=0 at t=150
    r.push(100, -2);
    r.push(200, 2);
    // Crossing 2 between t=300 (v=-1) and t=400 (v=3) -> level=0 at t=325
    r.push(300, -1);
    r.push(400, 3);

    const res = findTriggerCrossing(r, { mode: 'NORM', slope: 'RISING', level: 0 });
    expect(res.triggered).toBe(true);
    expect(res.crossingIndex).toBe(3);
    expect(res.triggerTimeUs).toBeCloseTo(325, 10);
  });

  it('detects falling edges with sub-sample interpolation', () => {
    const r = new SampleRing(32);
    r.push(0, 0);
    r.push(100, 5);
    r.push(200, 3); // crosses 4 at t=150
    r.push(300, 6); // rising across 4 — ignored for FALLING

    const res = findTriggerCrossing(r, { mode: 'SINGLE', slope: 'FALLING', level: 4 });
    expect(res.triggered).toBe(true);
    expect(res.crossingIndex).toBe(2);
    expect(res.triggerTimeUs).toBeCloseTo(150, 10);
  });

  it('detects EITHER slope (rising or falling) and picks the latest crossing', () => {
    const r = new SampleRing(32);
    r.push(0, 0);
    r.push(100, 10); // rising across 5 at t=50
    r.push(200, 0); // falling across 5 at t=150

    const res = findTriggerCrossing(r, { mode: 'NORM', slope: 'EITHER', level: 5 });
    expect(res.triggered).toBe(true);
    expect(res.crossingIndex).toBe(2);
    expect(res.triggerTimeUs).toBeCloseTo(150, 10);
  });

  it('suppresses crossings inside the holdoff window while accepting later crossings', () => {
    const r = new SampleRing(64);
    // Rising crossing #1 at t=100 (0 -> 2 across 1 -> t=50)
    r.push(0, 0);
    r.push(100, 2);
    // Drop back and rise crossing #2 at t=125 (0 -> 2 across 1 between 120 and 130)
    r.push(110, 0);
    r.push(120, 0);
    r.push(130, 2);
    // Drop back and rise crossing #3 at t=260 (0 -> 2 across 1 between 250 and 270)
    r.push(240, 0);
    r.push(250, 0);
    r.push(270, 2);

    // With holdoff=150 µs: #1 at t=50 accepted; #2 at t=125 suppressed (75 < 150); #3 at t=260 accepted (210 >= 150).
    const acceptedThird = findTriggerCrossing(r, {
      mode: 'NORM',
      slope: 'RISING',
      level: 1,
      holdoffUs: 150,
    });
    expect(acceptedThird.triggered).toBe(true);
    expect(acceptedThird.triggerTimeUs).toBeCloseTo(260, 10);
    expect(acceptedThird.crossingIndex).toBe(7);

    // With holdoff=300 µs: #2 and #3 are both suppressed, so #1 at t=50 remains the latest valid crossing.
    const heldOff = findTriggerCrossing(r, {
      mode: 'NORM',
      slope: 'RISING',
      level: 1,
      holdoffUs: 300,
    });
    expect(heldOff.triggered).toBe(true);
    expect(heldOff.triggerTimeUs).toBeCloseTo(50, 10);
    expect(heldOff.crossingIndex).toBe(1);
  });

  it('restricts search to [tMinSearchUs, tMaxSearchUs]', () => {
    const r = new SampleRing(32);
    r.push(0, 0);
    r.push(100, 10); // rising at t=50
    r.push(200, 0);
    r.push(300, 10); // rising at t=250

    const earlier = findTriggerCrossing(r, { mode: 'NORM', slope: 'RISING', level: 5 }, 0, 150);
    expect(earlier.triggered).toBe(true);
    expect(earlier.triggerTimeUs).toBeCloseTo(50, 10);

    const none = findTriggerCrossing(r, { mode: 'NORM', slope: 'RISING', level: 5 }, 100, 200);
    expect(none.triggered).toBe(false);
    expect(none.crossingIndex).toBe(-1);
  });
});
