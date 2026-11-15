// Downsampling for canvas painting. At 250k-ring depths a raw polyline is far
// beyond pixel resolution, so the painter asks for one pass of min-max bucket
// decimation (preserves spikes/envelope) or LTTB (preserves shape for
// scatter-style output). Both are pure and unit-tested.

/** A single plot-ready sample. */
export interface DecimatedPoint {
  t: number;
  v: number;
}

/**
 * Min-max bucket decimation over a contiguous slice of a SampleRing-like
 * accessor. Splits indices [lo, hi) into `buckets` equal columns and emits,
 * per column, the first/min/max/last points in time order (deduped) — the
 * classic envelope-preserving trick. Output is sorted by t, so callers can
 * stroke it directly.
 */
export function decimateMinMax(
  tAt: (i: number) => number,
  vAt: (i: number) => number,
  lo: number,
  hi: number,
  buckets: number
): DecimatedPoint[] {
  const count = hi - lo;
  if (count <= 0 || buckets < 1) return [];
  if (count <= buckets) {
    const out: DecimatedPoint[] = [];
    for (let i = lo; i < hi; i++) out.push({ t: tAt(i), v: vAt(i) });
    return out;
  }

  const out: DecimatedPoint[] = [];
  const colWidth = count / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = lo + Math.floor(b * colWidth);
    const end = b === buckets - 1 ? hi : lo + Math.floor((b + 1) * colWidth);
    if (start >= end) continue;

    const firstI = start;
    const lastI = end - 1;
    const vFirst = vAt(firstI);
    let minI = firstI;
    let maxI = firstI;
    let minV = vFirst;
    let maxV = vFirst;
    let vLast = vFirst;
    for (let i = start + 1; i < end; i++) {
      const v = vAt(i);
      if (v < minV) {
        minV = v;
        minI = i;
      }
      if (v > maxV) {
        maxV = v;
        maxI = i;
      }
      if (i === lastI) vLast = v;
    }

    // Emit first → (min/max in time order) → last without array/sort allocation.
    out.push({ t: tAt(firstI), v: vFirst });
    const loI = minI < maxI ? minI : maxI;
    const hiI = minI < maxI ? maxI : minI;
    if (loI !== firstI && loI !== lastI) {
      out.push({ t: tAt(loI), v: loI === minI ? minV : maxV });
    }
    if (hiI !== loI && hiI !== firstI && hiI !== lastI) {
      out.push({ t: tAt(hiI), v: hiI === minI ? minV : maxV });
    }
    if (lastI !== firstI) {
      out.push({ t: tAt(lastI), v: vLast });
    }
  }
  return out;
}

export interface DecimateIntoResult {
  count: number;
  min: number;
  max: number;
}

/**
 * Zero-allocation min-max bucket decimation into pre-allocated Float64Arrays,
 * computing global min/max across [lo, hi) in the same single pass.
 */
export function decimateMinMaxInto(
  lo: number,
  hi: number,
  buckets: number,
  tAt: (i: number) => number,
  vAt: (i: number) => number,
  outT: Float64Array,
  outV: Float64Array
): DecimateIntoResult {
  const total = hi - lo;
  const cap = Math.min(outT.length, outV.length);
  if (total <= 0 || buckets < 1 || cap <= 0) {
    return { count: 0, min: 0, max: 0 };
  }

  let gMin = Infinity;
  let gMax = -Infinity;

  if (total <= buckets * 4 && total <= cap) {
    for (let i = 0; i < total; i++) {
      const idx = lo + i;
      const v = vAt(idx);
      outT[i] = tAt(idx);
      outV[i] = v;
      if (v < gMin) gMin = v;
      if (v > gMax) gMax = v;
    }
    return {
      count: total,
      min: Number.isFinite(gMin) ? (gMin === 0 ? 0 : gMin) : 0,
      max: Number.isFinite(gMax) ? (gMax === 0 ? 0 : gMax) : 0,
    };
  }

  const effBuckets = cap >= buckets * 4 ? buckets : Math.max(1, Math.floor(cap / 4));
  const colWidth = total / effBuckets;
  let outIdx = 0;

  for (let b = 0; b < effBuckets; b++) {
    const start = lo + Math.floor(b * colWidth);
    const end = b === effBuckets - 1 ? hi : lo + Math.floor((b + 1) * colWidth);
    if (start >= end) continue;

    const firstI = start;
    const lastI = end - 1;
    const vFirst = vAt(firstI);
    let minI = firstI;
    let maxI = firstI;
    let minV = vFirst;
    let maxV = vFirst;
    let vLast = vFirst;

    for (let i = start + 1; i < end; i++) {
      const v = vAt(i);
      if (v < minV) {
        minV = v;
        minI = i;
      }
      if (v > maxV) {
        maxV = v;
        maxI = i;
      }
      if (i === lastI) vLast = v;
    }

    if (minV < gMin) gMin = minV;
    if (maxV > gMax) gMax = maxV;

    if (outIdx < cap) {
      outT[outIdx] = tAt(firstI);
      outV[outIdx] = vFirst;
      outIdx++;
    }
    const loI = minI < maxI ? minI : maxI;
    const hiI = minI < maxI ? maxI : minI;
    if (loI !== firstI && loI !== lastI && outIdx < cap) {
      outT[outIdx] = tAt(loI);
      outV[outIdx] = loI === minI ? minV : maxV;
      outIdx++;
    }
    if (hiI !== loI && hiI !== firstI && hiI !== lastI && outIdx < cap) {
      outT[outIdx] = tAt(hiI);
      outV[outIdx] = hiI === minI ? minV : maxV;
      outIdx++;
    }
    if (lastI !== firstI && outIdx < cap) {
      outT[outIdx] = tAt(lastI);
      outV[outIdx] = vLast;
      outIdx++;
    }
  }

  return {
    count: outIdx,
    min: Number.isFinite(gMin) ? (gMin === 0 ? 0 : gMin) : 0,
    max: Number.isFinite(gMax) ? (gMax === 0 ? 0 : gMax) : 0,
  };
}

/**
 * Largest-Triangle-Three-Buckets (Sveinn Steinarsson) over arbitrary (x, y)
 * pairs; returns the selected indices in input order. Keeps visual shape far
 * better than naive stride sampling for scatter/XY output. Input MUST be
 * sorted by x ascending.
 */
export function lttbIndices(xs: ArrayLike<number>, ys: ArrayLike<number>, threshold: number): number[] {
  const n = xs.length;
  if (threshold >= n || threshold < 3) {
    return Array.from({ length: n }, (_, i) => i);
  }

  const sampled: number[] = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    const bucketStart = Math.floor((i + 1) * every) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    const nextStart = bucketEnd;
    const nextEnd = Math.min(Math.floor((i + 3) * every) + 1, n);

    let avgX = 0;
    let avgY = 0;
    const avgLen = Math.max(1, nextEnd - nextStart);
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += xs[j];
      avgY += ys[j];
    }
    avgX /= avgLen;
    avgY /= avgLen;

    const rangeOffs = Math.floor(i * every) + 1;
    const rangeTo = bucketStart;
    let ax = xs[a];
    let ay = ys[a];
    let bestIdx = -1;
    let maxArea = -1;
    for (let j = rangeOffs; j < rangeTo; j++) {
      const area =
        0.5 * Math.abs((ax - avgX) * (ys[j] - ay) - (ax - xs[j]) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        bestIdx = j;
      }
    }
    sampled.push(bestIdx);
    a = bestIdx;
  }
  sampled.push(n - 1);
  return sampled;
}
