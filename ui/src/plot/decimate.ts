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
    let firstI = start;
    let lastI = end - 1;
    let minI = start;
    let maxI = start;
    for (let i = start + 1; i < end; i++) {
      if (vAt(i) < vAt(minI)) minI = i;
      if (vAt(i) > vAt(maxI)) maxI = i;
    }
    // Emit first → (min/max in time order) → last, skipping duplicates.
    const order = [firstI, minI, maxI, lastI].sort((a, b2) => a - b2);
    let prevT = NaN;
    for (const i of order) {
      const t = tAt(i);
      if (t === prevT) continue; // same sample already emitted (or shared extrema)
      out.push({ t, v: vAt(i) });
      prevT = t;
    }
  }
  return out;
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
