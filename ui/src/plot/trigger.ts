// Edge-crossing trigger detector over SampleRing with sub-sample linear
// interpolation and holdoff suppression.

import type { SampleRing } from './rings';

export type TriggerMode = 'AUTO' | 'NORM' | 'SINGLE' | 'ROLL';
export type TriggerSlope = 'RISING' | 'FALLING' | 'EITHER';

export interface TriggerConfig {
  mode: TriggerMode;
  slope: TriggerSlope;
  level: number;
  holdoffUs?: number;
}

export interface TriggerResult {
  triggered: boolean;
  triggerTimeUs: number;
  crossingIndex: number;
}

/**
 * Scan [tMinSearchUs, tMaxSearchUs] (default full ring) from oldest to newest
 * for edge crossings matching `cfg.slope` at `cfg.level`. Honors `cfg.holdoffUs`
 * from each accepted crossing and returns the latest valid crossing with
 * sub-sample linear timestamp interpolation.
 */
export function findTriggerCrossing(
  ring: SampleRing,
  cfg: TriggerConfig,
  tMinSearchUs?: number,
  tMaxSearchUs?: number
): TriggerResult {
  const fallbackT = ring.length > 0 ? ring.tMax : 0;
  if (cfg.mode === 'ROLL' || ring.length < 2 || !Number.isFinite(cfg.level)) {
    return { triggered: false, triggerTimeUs: fallbackT, crossingIndex: -1 };
  }

  const { lo, hi } =
    tMinSearchUs === undefined && tMaxSearchUs === undefined
      ? { lo: 0, hi: ring.length }
      : ring.rangeFor(tMinSearchUs ?? ring.tMin, tMaxSearchUs ?? ring.tMax);

  if (hi - lo < 2) {
    return { triggered: false, triggerTimeUs: fallbackT, crossingIndex: -1 };
  }

  const level = cfg.level;
  const slope = cfg.slope;
  const holdoff = cfg.holdoffUs ?? 0;

  let triggered = false;
  let lastTriggerT = -Infinity;
  let bestTime = fallbackT;
  let bestIndex = -1;

  let v0 = ring.vAt(lo);
  for (let i = lo + 1; i < hi; i++) {
    const v1 = ring.vAt(i);
    if (Number.isFinite(v0) && Number.isFinite(v1)) {
      const rising = v0 < level && v1 >= level;
      const falling = v0 > level && v1 <= level;
      const matched = slope === 'RISING' ? rising : slope === 'FALLING' ? falling : rising || falling;
      if (matched) {
        const t0 = ring.tAt(i - 1);
        const t1 = ring.tAt(i);
        const frac = (level - v0) / (v1 - v0);
        const tCross = t0 + frac * (t1 - t0);
        if (!triggered || holdoff <= 0 || tCross - lastTriggerT >= holdoff) {
          triggered = true;
          lastTriggerT = tCross;
          bestTime = tCross;
          bestIndex = i;
        }
      }
    }
    v0 = v1;
  }

  return {
    triggered,
    triggerTimeUs: bestTime,
    crossingIndex: bestIndex,
  };
}
