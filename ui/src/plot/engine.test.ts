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

  it('does not backfill expr channels (would need historical ref values)', () => {
    const history = [mkPacket(0, [mkField('f', 1)]), mkPacket(1, [mkField('f', 2)])];
    plotEngine.start({ getSourcePackets: () => history, subscribe: () => () => {} });
    plotEngine.ensureChannel(mkChannel('v', 'f', { kind: 'field', name: 'f' }));
    plotEngine.ensureChannel(mkChannel('m', 'x2', { kind: 'expr', source: 'f * 2' }));
    expect(plotEngine.getTail('m', 100).v.length).toBe(0);
    plotEngine.ingestPackets([mkPacket(2, [mkField('f', 3)])]);
    expect(plotEngine.lastValue('m')).toBe(6);
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
