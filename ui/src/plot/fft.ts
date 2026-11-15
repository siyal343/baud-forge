// Radix-2 iterative Cooley–Tukey FFT + Hann windowing for the spectrum mode.
// The Oscilloscope's naive O(N²) DFT caps at 64 samples; this runs 4096-point
// windows comfortably inside a frame budget. Pure functions, unit-tested
// against direct DFT and known sinusoids.

const HANN_CACHE = new Map<number, Float64Array>();
const TWIDDLE_CACHE = new Map<number, { cosTable: Float64Array; sinTable: Float64Array }>();

/**
 * Periodic Hann window (w[0] = 0, w[n-1] = w[1] ≠ 0, symmetric about n/2).
 * Returns a memoized read-only Float64Array — callers must not mutate it.
 */
export function hannWindow(n: number): Float64Array {
  const cached = HANN_CACHE.get(n);
  if (cached) return cached;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  if (n >= 0 && n <= 65536) HANN_CACHE.set(n, w);
  return w;
}

function getStageTwiddles(len: number): { cosTable: Float64Array; sinTable: Float64Array } {
  const cached = TWIDDLE_CACHE.get(len);
  if (cached) return cached;
  const half = len >>> 1;
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  const baseAng = (-2 * Math.PI) / len;
  for (let k = 0; k < half; k++) {
    const ang = baseAng * k;
    cosTable[k] = Math.cos(ang);
    sinTable[k] = Math.sin(ang);
  }
  const entry = { cosTable, sinTable };
  if (len <= 65536) TWIDDLE_CACHE.set(len, entry);
  return entry;
}

/**
 * In-place complex FFT. Length must be a power of two. Bit-reversal
 * permutation followed by the standard butterfly stages with cached twiddle tables.
 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error('re/im length mismatch');
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`fft length must be a power of two, got ${n}`);
  if (n === 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }

  // Butterfly stages using memoized cos/sin twiddle tables.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >>> 1;
    const { cosTable, sinTable } = getStageTwiddles(len);
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const curRe = cosTable[k];
        const curIm = sinTable[k];
        const idx1 = i + k;
        const idx2 = idx1 + half;
        const uRe = re[idx1];
        const uIm = im[idx1];
        const tRe = re[idx2];
        const tIm = im[idx2];
        const vRe = tRe * curRe - tIm * curIm;
        const vIm = tRe * curIm + tIm * curRe;
        re[idx1] = uRe + vRe;
        im[idx1] = uIm + vIm;
        re[idx2] = uRe - vRe;
        im[idx2] = uIm - vIm;
      }
    }
  }
}

export interface Spectrum {
  /** Bin center frequencies in Hz, length n/2+1. */
  freqHz: Float64Array;
  /** Linear magnitude (window-normalized, single-sided). */
  mag: Float64Array;
  /** 20·log10(mag) with a -200 dB floor for zeros. */
  db: Float64Array;
  /** Peak frequency excluding DC. */
  peakHz: number;
  peakMag: number;
}

/**
 * Single-sided amplitude spectrum of the last real samples. `sampleRateHz`
 * comes from the median sample interval of the window. Truncates to the
 * largest power of two ≤ samples.length (min 2) so callers can pass raw tails.
 * `detrend` subtracts the mean first — recommended for telemetry, where DC
 * offsets otherwise leak through the Hann window into bin 1 and can dominate
 * the peak search.
 */
export function magnitudeSpectrum(
  samples: ArrayLike<number>,
  sampleRateHz: number,
  opts?: { detrend?: boolean; window?: 'hann' | 'rect' }
): Spectrum {
  let n = 1;
  while (n * 2 <= samples.length) n *= 2;
  if (n < 2) {
    const empty = new Float64Array(0);
    return { freqHz: empty, mag: empty, db: empty, peakHz: 0, peakMag: 0 };
  }

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  if (opts?.detrend) {
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;
  }
  if (opts?.window === 'rect') {
    for (let i = 0; i < n; i++) re[i] = samples[i] - mean;
  } else {
    // Coherent-gain compensation for the Hann window (Σw/n = 0.5).
    const w = hannWindow(n);
    for (let i = 0; i < n; i++) re[i] = (samples[i] - mean) * w[i] * 2;
  }

  fftRadix2(re, im);

  const bins = n / 2 + 1;
  const freqHz = new Float64Array(bins);
  const mag = new Float64Array(bins);
  const db = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqHz[k] = (k * sampleRateHz) / n;
    const m = Math.hypot(re[k], im[k]) / n;
    mag[k] = k > 0 && k < n / 2 ? m * 2 : m; // single-sided doubling
    db[k] = mag[k] > 0 ? 20 * Math.log10(mag[k]) : -200;
  }

  let peakBin = 1;
  for (let k = 2; k < bins; k++) if (mag[k] > mag[peakBin]) peakBin = k;
  return {
    freqHz,
    mag,
    db,
    peakHz: bins > 1 ? freqHz[peakBin] : 0,
    peakMag: bins > 1 ? mag[peakBin] : 0,
  };
}
