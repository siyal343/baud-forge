// Radix-2 iterative Cooley–Tukey FFT + Hann windowing for the spectrum mode.
// The Oscilloscope's naive O(N²) DFT caps at 64 samples; this runs 4096-point
// windows comfortably inside a frame budget. Pure functions, unit-tested
// against direct DFT and known sinusoids.

/** Periodic Hann window (w[0] = 0, w[n-1] = w[1] ≠ 0, symmetric about n/2). */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * In-place complex FFT. Length must be a power of two. Bit-reversal
 * permutation followed by the standard butterfly stages.
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

  // Butterfly stages.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
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
  opts?: { detrend?: boolean }
): Spectrum {
  let n = 1;
  while (n * 2 <= samples.length) n *= 2;
  if (n < 2) {
    const empty = new Float64Array(0);
    return { freqHz: empty, mag: empty, db: empty, peakHz: 0, peakMag: 0 };
  }

  const w = hannWindow(n);
  // Coherent-gain compensation for the Hann window (Σw/n = 0.5).
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  if (opts?.detrend) {
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;
  }
  for (let i = 0; i < n; i++) re[i] = (samples[i] - mean) * w[i] * 2;

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
