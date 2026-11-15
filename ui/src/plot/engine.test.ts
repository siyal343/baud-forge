// PlotEngine verification: field extraction, channel feeds, expr evaluation,
// backfill, depth changes, store-wiring behavior. Drives the engine directly
// (no workstation store involved).
import { describe, it, expect, beforeEach } from 'vitest';
import { plotEngine, extractFieldNumber, MAX_ENGINE_CHANNELS } from './engine';
import type { PacketRow, DissectedField } from '../types';
import type { ChannelDef, ChannelSource } from './types';

const mkField = (name: string, value: number | string | boolean, unit?: string): DissectedField => ({
  name,
  type: 'test',
  offset: 0,
  length: 4,
  rawHex: '',
  decodedValue: value,
  ...(unit ? { unit } : {}),
});

let seq = 0;
const mkPacket = (
  tUs: number,
  fields: DissectedField[],
  opts: { length?: number; deltaUs?: number } = {}
): PacketRow => ({
  seqId: ++seq,
  timestampNs: tUs * 1000,
  timestampUs: tUs,
  deltaUs: opts.deltaUs ?? 50_000,
  timeStr: '',
  direction: 'RX',
  port: 'COM8',
  length: opts.length ?? 20,
  rawBytes: [],
  rawHex: '',
  protocol: 'test',
  summary: '',
  dissectedFields: fields,
  hasError: false,
});

const mkChannel = (id: string, label: string, source: ChannelSource): ChannelDef => ({
  id,
  label,
  source,
  color: '#A855F7',
  visible: true,
  axis: 'y1',
});

beforeEach(() => {
  seq = 0;
  plotEngine.reset();
  plotEngine.stop();
});

describe('extractFieldNumber', () => {
  it('prefers native numbers and falls back to string regex', () => {
    const pkt = mkPacket(0, [mkField('a', 42, 'mV'), mkField('b', '8.18 V'), mkField('c', 'nope'), mkField('d', true)]);
    expect(extractFieldNumber(pkt, 'a')).toEqual({ value: 42, unit: 'mV' });
    expect(extractFieldNumber(pkt, 'b')?.value).toBe(8.18);
    expect(extractFieldNumber(pkt, 'c')).toBeNull();
    expect(extractFieldNumber(pkt, 'd')).toBeNull();
    expect(extractFieldNumber(pkt, 'missing')).toBeNull();
  });
});

describe('field channel feed', () => {
  it('pushes one sample per packet carrying the field', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'v_batt_mv', { kind: 'field', name: 'v_batt_mv' }));
    plotEngine.ingestPackets([
      mkPacket(1_000, [mkField('v_batt_mv', 8000)]),
      mkPacket(51_000, [mkField('v_batt_mv', 8100)]),
      mkPacket(101_000, [mkField('other', 1)]), // no v_batt → no sample
      mkPacket(151_000, [mkField('v_batt_mv', 8200)]),
    ]);
    expect(plotEngine.getTail('c1', 10).v.length).toBe(3);
    expect(plotEngine.lastValue('c1')).toBe(8200);
    const series = plotEngine.getSeries('c1', 0, 200_000, 100);
    expect(series).toHaveLength(3);
    expect(series[0]).toEqual({ t: 1_000, v: 8000 });
  });

  it('skips non-finite values', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'g', { kind: 'field', name: 'g' }));
    plotEngine.ingestPackets([
      mkPacket(0, [mkField('g', NaN)]),
      mkPacket(1, [mkField('g', Infinity)]),
      mkPacket(2, [mkField('g', 5)]),
    ]);
    expect(plotEngine.getTail('c1', 10).v.length).toBe(1);
  });
});

describe('meta channels', () => {
  it('tracks length, delta and 1 s byte-rate', () => {
    plotEngine.ensureChannel(mkChannel('len', 'length', { kind: 'meta', metric: 'length' }));
    plotEngine.ensureChannel(mkChannel('dly', 'delta', { kind: 'meta', metric: 'delta' }));
    plotEngine.ensureChannel(mkChannel('bps', 'rate', { kind: 'meta', metric: 'rate' }));
    plotEngine.ingestPackets([
      mkPacket(0, [], { length: 20, deltaUs: 1_000 }),
      mkPacket(400_000, [], { length: 30, deltaUs: 2_000 }),
      mkPacket(800_000, [], { length: 10, deltaUs: 3_000 }),
      mkPacket(1_500_000, [], { length: 5, deltaUs: 4_000 }), // t=0 and t=400k age out
    ]);
    expect(plotEngine.lastValue('len')).toBe(5);
    expect(plotEngine.lastValue('dly')).toBe(4_000);
    // 1 s window ending at 1.5 s → [0.5 s, 1.5 s] holds 0.8 s (10 B) + 1.5 s (5 B).
    expect(plotEngine.lastValue('bps')).toBe(15);
  });
});

describe('expr channels', () => {
  it('evaluates against other channels with hold-last semantics', () => {
    plotEngine.ensureChannel(mkChannel('v', 'v', { kind: 'field', name: 'v_batt_mv' }));
    plotEngine.ensureChannel(mkChannel('g', 'g', { kind: 'field', name: 'gyro_z' }));
    plotEngine.ensureChannel(mkChannel('m', 'watts', { kind: 'expr', source: 'v * g' }));
    plotEngine.ingestPackets([
      mkPacket(0, [mkField('v_batt_mv', 10), mkField('gyro_z', 2)]),
      mkPacket(1, [mkField('v_batt_mv', 20), mkField('gyro_z', 3)]),
      mkPacket(2, [mkField('v_batt_mv', 30)]), // gyro held at 3 → 30*3
    ]);
    const tail = plotEngine.getTail('m', 10).v;
    expect([...tail]).toEqual([20, 60, 90]);
  });

  it('produces nothing when a ref channel is missing', () => {
    plotEngine.ensureChannel(mkChannel('m', 'm', { kind: 'expr', source: 'ghost + 1' }));
    plotEngine.ingestPackets([mkPacket(0, []), mkPacket(1, [])]);
    expect(plotEngine.getTail('m', 10).v.length).toBe(0);
  });
});

describe('backfill + rebuild', () => {
  it('backfills field/meta channels from the wired packet accessor', () => {
    const history = [mkPacket(0, [mkField('f', 1)]), mkPacket(1, [mkField('f', 2)]), mkPacket(2, [mkField('f', 3)])];
    plotEngine.start({ getSourcePackets: () => history, subscribe: () => () => {} });
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    expect(plotEngine.getTail('c1', 100).v.length).toBe(3);
  });

  it('backfills expr channels from buffered packets with hold-last semantics', () => {
    const history = [
      mkPacket(0, [mkField('f', 1), mkField('g', 10)]),
      mkPacket(1, [mkField('f', 2)]), // g held at 10
    ];
    plotEngine.start({ getSourcePackets: () => history, subscribe: () => () => {} });
    plotEngine.ensureChannel(mkChannel('v', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ensureChannel(mkChannel('g', 'g', { kind: 'field', name: 'g' }));
    plotEngine.ensureChannel(mkChannel('m', 'x2', { kind: 'expr', source: 'f * 2 + g' }));
    expect([...plotEngine.getTail('m', 100).v]).toEqual([12, 14]);
    plotEngine.ingestPackets([mkPacket(2, [mkField('f', 3)])]);
    expect(plotEngine.lastValue('m')).toBe(16);
  });

  it('rebuilds the ring when the source changes', () => {
    const history = [mkPacket(0, [mkField('a', 1), mkField('b', 100)])];
    plotEngine.start({ getSourcePackets: () => history, subscribe: () => () => {} });
    const def = mkChannel('c1', 'a', { kind: 'field', name: 'a' });
    plotEngine.ensureChannel(def);
    plotEngine.ingestPackets([mkPacket(1, [mkField('a', 2), mkField('b', 200)])]);
    expect(plotEngine.lastValue('c1')).toBe(2);
    // Swap source to field b → ring rebuilt + backfilled from the history
    // accessor (which holds only the t=0 packet — the ingested t=1 packet is
    // not part of the backfill source).
    plotEngine.ensureChannel({ ...def, source: { kind: 'field', name: 'b' } });
    expect(plotEngine.lastValue('c1')).toBe(100);
    expect(plotEngine.getTail('c1', 10).v.length).toBe(1);
  });
});

describe('store wiring', () => {
  it('ingests fresh packets via subscription and clears on empty buffer', () => {
    let packets: PacketRow[] = [];
    let listener: (() => void) | null = null;
    plotEngine.start({
      getSourcePackets: () => packets,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    });
    packets = [mkPacket(0, [mkField('f', 1)]), mkPacket(1, [mkField('f', 2)])];
    listener!();
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    // ensureChannel backfilled both packets.
    expect(plotEngine.getTail('c1', 10).v.length).toBe(2);
    // New frame arrives → subscription pushes only the delta.
    packets = [...packets, mkPacket(2, [mkField('f', 3)])];
    listener!();
    expect(plotEngine.getTail('c1', 10).v.length).toBe(3);
    expect(plotEngine.lastValue('c1')).toBe(3);
    // clearStream() → empty reactive buffer wipes ring data, keeps channels.
    packets = [];
    listener!();
    expect(plotEngine.getTail('c1', 10).v.length).toBe(0);
    expect(plotEngine.hasChannel('c1')).toBe(true);
    // Re-delivery of the same buffer after clear re-ingests (seqId reset).
    packets = [mkPacket(3, [mkField('f', 9)])];
    listener!();
    expect(plotEngine.lastValue('c1')).toBe(9);
  });

  it('ignores selection churn that adds no new packets', () => {
    let packets: PacketRow[] = [mkPacket(0, [mkField('f', 1)])];
    let listener: (() => void) | null = null;
    const before = plotEngine.dataVersion;
    plotEngine.start({
      getSourcePackets: () => packets,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    });
    listener!();
    const after = plotEngine.dataVersion;
    listener!(); // same buffer again → no ingest
    expect(plotEngine.dataVersion).toBe(after);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('depth + queries', () => {
  it('setDepth preserves the newest samples', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ingestPackets(Array.from({ length: 1500 }, (_, i) => mkPacket(i, [mkField('f', i)])));
    plotEngine.setDepth(1000); // above PLOT_DEPTH_MIN, below the 1500 held
    expect(plotEngine.ringDepth).toBe(1000);
    const tail = plotEngine.getTail('c1', 100).v;
    expect([...tail]).toEqual(Array.from({ length: 100 }, (_, i) => 1400 + i));
  });

  it('clamps depth to the configured bounds', () => {
    plotEngine.setDepth(1);
    expect(plotEngine.ringDepth).toBe(1_000);
    plotEngine.setDepth(10 ** 9);
    expect(plotEngine.ringDepth).toBe(250_000);
  });

  it('computes window stats (Welford)', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    // t = 0..4, values 2, 4, 4, 4, 6 → mean 4, sample σ = √2.
    plotEngine.ingestPackets([0, 1, 2, 3, 4].map((t) => mkPacket(t, [mkField('f', [2, 4, 4, 4, 6][t])])));
    const stats = plotEngine.getStats('c1', -1, 10)!;
    expect(stats.count).toBe(5);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
    expect(stats.mean).toBeCloseTo(4, 12);
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(2), 12);
    expect(plotEngine.getStats('c1', 100, 200)).toBeNull();
  });

  it('getSeries respects the bucket budget', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ingestPackets(Array.from({ length: 1000 }, (_, i) => mkPacket(i, [mkField('f', i)])));
    expect(plotEngine.getSeries('c1', 0, 1000, 10).length).toBeLessThanOrEqual(40);
  });

  it('getWindowSamples strides down to the row budget', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ingestPackets(Array.from({ length: 100 }, (_, i) => mkPacket(i * 10, [mkField('f', i)])));
    const all = plotEngine.getWindowSamples('c1', -1, 10_000);
    expect(all).toHaveLength(100);
    expect(all[0]).toEqual({ tUs: 0, v: 0 });
    const capped = plotEngine.getWindowSamples('c1', -1, 10_000, 10);
    expect(capped).toHaveLength(10);
    expect(capped[capped.length - 1].v).toBeGreaterThanOrEqual(90); // strided, not tail-only
    expect(plotEngine.getWindowSamples('c1', 50_000, 60_000)).toHaveLength(0);
  });

  it('sampleNearest finds the closest sample within tolerance', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ingestPackets([
      mkPacket(0, [mkField('f', 10)]),
      mkPacket(100, [mkField('f', 20)]),
      mkPacket(200, [mkField('f', 30)]),
    ]);
    expect(plotEngine.sampleNearest('c1', 95, 10)).toEqual({ tUs: 100, value: 20 });
    expect(plotEngine.sampleNearest('c1', 170, 35)).toEqual({ tUs: 200, value: 30 }); // 30 µs away
    expect(plotEngine.sampleNearest('c1', 160, 20)).toBeNull(); // nearest is 40 µs away
    expect(plotEngine.sampleNearest('c1', 10_000, 5)).toBeNull();
    expect(plotEngine.sampleNearest('ghost', 0, 100)).toBeNull();
  });

  it('getDataExtent spans all channels', () => {
    plotEngine.ensureChannel(mkChannel('a', 'fa', { kind: 'field', name: 'fa' }));
    plotEngine.ensureChannel(mkChannel('b', 'fb', { kind: 'field', name: 'fb' }));
    plotEngine.ingestPackets([
      mkPacket(100, [mkField('fa', 1), mkField('fb', 1)]),
      mkPacket(200, [mkField('fa', 2)]),
      mkPacket(300, [mkField('fb', 2)]),
    ]);
    expect(plotEngine.getDataExtent()).toEqual({ tMinUs: 100, tMaxUs: 300 });
    expect(plotEngine.getDataExtent()).toBeTruthy();
  });

  it('caps the channel count like the engine-side SeriesSet', () => {
    for (let i = 0; i < MAX_ENGINE_CHANNELS + 5; i++) {
      plotEngine.ensureChannel(mkChannel(`c${i}`, `f${i}`, { kind: 'meta', metric: 'length' }));
    }
    expect(plotEngine.channelCount).toBe(MAX_ENGINE_CHANNELS);
  });
});

describe('Step 2 performance + accuracy features', () => {
  it('multiple meta:rate channels report identical accurate 1s byte rates without doubling', () => {
    plotEngine.ensureChannel(mkChannel('r1', 'rate1', { kind: 'meta', metric: 'rate' }));
    plotEngine.ensureChannel(mkChannel('r2', 'rate2', { kind: 'meta', metric: 'rate' }));
    plotEngine.ensureChannel(mkChannel('r3', 'rate3', { kind: 'meta', metric: 'rate' }));
    plotEngine.ingestPackets([
      mkPacket(0, [], { length: 20 }),
      mkPacket(400_000, [], { length: 30 }),
      mkPacket(800_000, [], { length: 10 }),
      mkPacket(1_500_000, [], { length: 5 }), // t=0 and t=400k age out -> 10 + 5 = 15
    ]);
    expect(plotEngine.lastValue('r1')).toBe(15);
    expect(plotEngine.lastValue('r2')).toBe(15);
    expect(plotEngine.lastValue('r3')).toBe(15);
    expect([...plotEngine.getTail('r1', 10).v]).toEqual([20, 50, 60, 15]);
    expect([...plotEngine.getTail('r2', 10).v]).toEqual([20, 50, 60, 15]);
  });

  it('extracts array elements (samples[0], etc.) and bitmask fields in a single pass', () => {
    plotEngine.ensureChannel(mkChannel('s0', 's0', { kind: 'field', name: 'samples[0]' }));
    plotEngine.ensureChannel(mkChannel('s2', 's2', { kind: 'field', name: 'samples[2]' }));
    plotEngine.ensureChannel(mkChannel('csv1', 'csv1', { kind: 'field', name: 'vec[1]' }));
    plotEngine.ensureChannel(mkChannel('bm', 'bm', { kind: 'field', name: 'status' }));

    const bitmaskField = { ...mkField('status', 7), bitmask: 0x07 } as DissectedField & { bitmask: number };
    const nativeArrayField = { ...mkField('vec', '0'), decodedValue: [100, 200, 300] as unknown as string };

    plotEngine.ingestPackets([
      mkPacket(10, [mkField('samples', '[12, 34, 56, 78]'), nativeArrayField, bitmaskField]),
      mkPacket(20, [mkField('samples', '9, 8, 7'), nativeArrayField, bitmaskField]),
    ]);

    expect([...plotEngine.getTail('s0', 10).v]).toEqual([12, 9]);
    expect([...plotEngine.getTail('s2', 10).v]).toEqual([56, 7]);
    expect([...plotEngine.getTail('csv1', 10).v]).toEqual([200, 200]);
    expect([...plotEngine.getTail('bm', 10).v]).toEqual([7, 7]);
    expect(plotEngine.catalogEntry('samples[0]')?.lastValue).toBe(9);
    expect(plotEngine.catalogEntry('samples[2]')?.lastValue).toBe(7);
    expect(plotEngine.catalogEntry('status')?.lastValue).toBe(7);
  });

  it('getSeriesScratch reuses per-channel scratch buffers and computes exact bounds', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'a', { kind: 'field', name: 'a' }));
    plotEngine.ensureChannel(mkChannel('c2', 'b', { kind: 'field', name: 'b' }));
    plotEngine.ingestPackets(
      Array.from({ length: 500 }, (_, i) =>
        mkPacket(i * 10, [mkField('a', i === 250 ? 999 : i), mkField('b', -i)])
      )
    );

    const s1a = plotEngine.getSeriesScratch('c1', 0, 5000, 20);
    const s2 = plotEngine.getSeriesScratch('c2', 0, 5000, 20);
    // Multi-channel queries must not clobber s1a's buffers before use.
    expect(s1a.min).toBe(0);
    expect(s1a.max).toBe(999);
    expect(s2.min).toBe(-499);
    expect(s2.max).toBe(0);

    const expected = plotEngine.getSeries('c1', 0, 5000, 20);
    expect(s1a.count).toBe(expected.length);
    for (let i = 0; i < s1a.count; i++) {
      expect(s1a.t[i]).toBe(expected[i].t);
      expect(s1a.v[i]).toBe(expected[i].v);
    }

    const s1b = plotEngine.getSeriesScratch('c1', 0, 5000, 20);
    expect(s1b.t).toBe(s1a.t);
    expect(s1b.v).toBe(s1a.v);
  });

  it('getCachedSpectrum caches by (id, fftSize, window) and invalidates when data changes', () => {
    plotEngine.ensureChannel(mkChannel('c1', 'sig', { kind: 'field', name: 'sig' }));
    const fs = 1000; // 1000 Hz -> 1000 µs per sample
    const pkts = Array.from({ length: 128 }, (_, i) =>
      mkPacket(i * 1000, [mkField('sig', Math.sin((2 * Math.PI * 125 * i) / fs))])
    );
    plotEngine.ingestPackets(pkts);

    const spec1 = plotEngine.getCachedSpectrum('c1', 128, 'hann');
    const spec2 = plotEngine.getCachedSpectrum('c1', 128, 'hann');
    expect(spec1).not.toBeNull();
    expect(spec2).toBe(spec1); // cache hit returns identical object
    expect(spec1!.sampleRateHz).toBeCloseTo(1000, 4);
    expect(spec1!.peakHz).toBeCloseTo(125, 4);
    expect(spec1!.peakDb).toBeCloseTo(0, 1);

    const rectSpec = plotEngine.getCachedSpectrum('c1', 128, 'rect');
    expect(rectSpec).not.toBe(spec1);
    expect(rectSpec!.peakHz).toBeCloseTo(125, 4);

    // Appending a new packet updates length/tMax and invalidates cache.
    plotEngine.ingestPackets([mkPacket(128_000, [mkField('sig', 0)])]);
    const spec3 = plotEngine.getCachedSpectrum('c1', 128, 'hann');
    expect(spec3).not.toBe(spec1);
  });

  it('getAlignedXy aligns asynchronous channels by interpolated timestamp inside overlapping range', () => {
    plotEngine.ensureChannel(mkChannel('x', 'x', { kind: 'field', name: 'x' }));
    plotEngine.ensureChannel(mkChannel('y', 'y', { kind: 'field', name: 'y' }));

    // X sampled at t = 0, 100, 200; Y sampled at t = 50, 100, 150, 250.
    // Overlap is [50, 200]. Within [50, 200]: X has t=100,200 (count 2); Y has t=50,100,150 (count 3).
    // Y drives: at t=50 -> X=5, Y=50; at t=100 -> X=10, Y=100; at t=150 -> X=15, Y=150.
    plotEngine.ingestPackets([
      mkPacket(0, [mkField('x', 0)]),
      mkPacket(50, [mkField('y', 50)]),
      mkPacket(100, [mkField('x', 10), mkField('y', 100)]),
      mkPacket(150, [mkField('y', 150)]),
      mkPacket(200, [mkField('x', 20)]),
      mkPacket(250, [mkField('y', 250)]),
    ]);

    const aligned = plotEngine.getAlignedXy('x', 'y', 100);
    expect(aligned.count).toBe(3);
    expect([...aligned.xs.subarray(0, aligned.count)]).toEqual([5, 10, 15]);
    expect([...aligned.ys.subarray(0, aligned.count)]).toEqual([50, 100, 150]);
  });

  it('exposes getDataVersion() and getChannelRing()', () => {
    const v0 = plotEngine.getDataVersion();
    plotEngine.ensureChannel(mkChannel('c1', 'f', { kind: 'field', name: 'f' }));
    const v1 = plotEngine.getDataVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(plotEngine.getChannelRing('c1')).toBeDefined();
    expect(plotEngine.getChannelRing('missing')).toBeUndefined();
    plotEngine.ingestPackets([mkPacket(0, [mkField('f', 42)])]);
    expect(plotEngine.getDataVersion()).toBeGreaterThan(v1);
    expect(plotEngine.getChannelRing('c1')?.lastV).toBe(42);
  });
});
