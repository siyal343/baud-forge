// FFT verification: radix-2 correctness against direct DFT, spectral peak of
// known sinusoids, windowing, and input guards.
import { describe, it, expect } from 'vitest';
import { fftRadix2, hannWindow, magnitudeSpectrum } from './fft';

/** Naive O(N²) DFT reference. */
const dft = (re: number[], im: number[]) => {
  const n = re.length;
  const outRe = new Array(n).fill(0);
  const outIm = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(ang) - im[t] * Math.sin(ang);
      outIm[k] += re[t] * Math.sin(ang) + im[t] * Math.cos(ang);
    }
  }
  return { outRe, outIm };
};

describe('fftRadix2', () => {
  it('matches the direct DFT on a random complex input', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const inRe = Array.from({ length: n }, () => rand());
    const inIm = Array.from({ length: n }, () => rand());
    re.set(inRe);
    im.set(inIm);

    fftRadix2(re, im);
    const { outRe, outIm } = dft(inRe, inIm);
    for (let k = 0; k < n; k++) {
      expect(Math.abs(re[k] - outRe[k])).toBeLessThan(1e-9);
      expect(Math.abs(im[k] - outIm[k])).toBeLessThan(1e-9);
    }
  });

  it('maps a constant signal to DC-only output', () => {
    const re = new Float64Array(8).fill(3);
    const im = new Float64Array(8);
    fftRadix2(re, im);
    expect(re[0]).toBeCloseTo(24, 6);
    for (let k = 1; k < 8; k++) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9);
  });

  it('rejects non-power-of-two lengths', () => {
    expect(() => fftRadix2(new Float64Array(3), new Float64Array(3))).toThrow();
    expect(() => fftRadix2(new Float64Array(0), new Float64Array(0))).toThrow();
  });

  it('handles the trivial single-point transform', () => {
    const re = new Float64Array([5]);
    const im = new Float64Array([0]);
    expect(() => fftRadix2(re, im)).not.toThrow();
    expect(re[0]).toBe(5);
  });
});

describe('hannWindow', () => {
  it('has a zero leading edge, symmetric shape, and n/2 coherent gain', () => {
    const w = hannWindow(16);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[15]).toBeCloseTo(0.03806, 4); // periodic form: w[n-1] = w[1] ≠ 0
    expect(w[8]).toBeCloseTo(1, 12);
    expect(w[4]).toBeCloseTo(w[12], 12);
    const sum = [...w].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(8, 6); // Σ Hann = n/2
  });
});

describe('magnitudeSpectrum', () => {
  it('finds the exact bin and unit amplitude of an on-bin sine', () => {
    // fs=1000 Hz, n=256, f=125 Hz → bin 32 exactly. Hann×2 gain + single-sided
    // doubling should recover amplitude ≈ 1.0.
    const fs = 1000;
    const n = 256;
    const samples = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 125 * i) / fs));
    const spec = magnitudeSpectrum(samples, fs);
    expect(spec.freqHz.length).toBe(129);
    expect(spec.freqHz[spec.freqHz.length - 1]).toBeCloseTo(fs / 2, 6);
    expect(spec.peakHz).toBeCloseTo(125, 6);
    expect(spec.peakMag).toBeCloseTo(1.0, 2);
    expect(spec.db[32]).toBeCloseTo(0, 1);
  });

  it('keeps DC undoubled; its window leakage dominates an un-detrended peak', () => {
    const fs = 500;
    const n = 128;
    // DC 2.0 plus a small 50 Hz ripple (fractional bin 12.8).
    const samples = Array.from(
      { length: n },
      (_, i) => 2 + 0.5 * Math.sin((2 * Math.PI * 50 * i) / fs)
    );
    const raw = magnitudeSpectrum(samples, fs);
    expect(raw.mag[0]).toBeCloseTo(2, 2); // DC = mean value, no doubling
    expect(raw.peakHz).toBeGreaterThan(0);
    // DC × Hann leaks into bin 1 with magnitude ~1.0, exceeding the ripple.
    expect(raw.peakHz).toBeCloseTo((1 * fs) / n, 6);
  });

  it('detrending removes DC leakage so the true tone wins the peak', () => {
    const fs = 500;
    const n = 128;
    const samples = Array.from(
      { length: n },
      (_, i) => 2 + 0.5 * Math.sin((2 * Math.PI * 50 * i) / fs)
    );
    const spec = magnitudeSpectrum(samples, fs, { detrend: true });
    expect(spec.peakHz).toBeCloseTo(Math.round((50 / fs) * n) * (fs / n), 1); // bin 13
    expect(Math.abs(spec.mag[0])).toBeLessThan(0.01);
  });

  it('truncates non-power-of-two input to the largest power of two', () => {
    const fs = 1000;
    const samples = Array.from({ length: 300 }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / fs));
    const spec = magnitudeSpectrum(samples, fs);
    // 300 → n=256 → bins 129.
    expect(spec.freqHz.length).toBe(129);
    // 100 Hz sits at fractional bin 25.6 → nearest-bin peak = 26 → 101.5625 Hz.
    expect(spec.peakHz).toBeCloseTo(101.5625, 1);
  });

  it('returns empty spectra for degenerate inputs', () => {
    const spec = magnitudeSpectrum([1], 1000);
    expect(spec.freqHz.length).toBe(0);
    expect(spec.peakHz).toBe(0);
  });
});
