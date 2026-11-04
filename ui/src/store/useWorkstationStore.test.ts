// Store logic verification for the audit fix waves: unique seqIds, live TX
// accounting, direction filter state, HW-mode scope extraction from decoded
// payloads, and flash-yield interval replace-any semantics.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useWorkstationStore } from './useWorkstationStore';
import { PacketRow } from '../types';

const makePacket = (overrides: Partial<PacketRow> = {}): PacketRow => ({
  seqId: 0,
  timestampNs: 0,
  timestampUs: 1000,
  deltaUs: 50,
  timeStr: '00:00:00.000',
  direction: 'RX',
  port: 'COM8',
  length: 20,
  rawBytes: [0xaa],
  rawHex: 'AA',
  protocol: 'ImuPacket',
  summary: 'test frame',
  dissectedFields: [],
  hasError: false,
  ...overrides,
});

describe('workstation store', () => {
  beforeEach(() => {
    useWorkstationStore.setState({
      packets: [],
      scopeSamples: [],
      rxBytes: 0,
      txBytes: 0,
      isSimulated: false, // exercise the real-payload scope path
      isYielded: false,
      yieldRemainingSecs: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renumbers every packet with a unique monotonic seqId', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(makePacket({ seqId: 42 }));
    s.addPacket(makePacket({ seqId: 42 })); // deliberate duplicate attempt
    s.addPacketBatch([makePacket({ seqId: 7 }), makePacket({ seqId: 7 })]);
    const { packets } = useWorkstationStore.getState();
    expect(packets).toHaveLength(4);
    const ids = packets.map((p) => p.seqId);
    expect(new Set(ids).size).toBe(4);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // strictly increasing
  });

  it('recordTx accumulates transmitted bytes into the footer counter', () => {
    const s = useWorkstationStore.getState();
    s.recordTx(10);
    s.recordTx(184);
    expect(useWorkstationStore.getState().txBytes).toBe(194);
  });

  it('holds last scope reading across fieldless frames (HW mode)', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(
      makePacket({
        timestampUs: 5000,
        dissectedFields: [
          { name: 'v_batt_mv', type: 'uint32', offset: 4, length: 4, rawHex: '', decodedValue: '7430 mV' },
          { name: 'gyro_z', type: 'float32', offset: 8, length: 4, rawHex: '', decodedValue: '-0.45 rad/s' },
        ],
      })
    );
    // A TX command row carries no decoded fields -> previous reading holds.
    s.addPacket(makePacket({ timestampUs: 6000, direction: 'TX', dissectedFields: [] }));
    const { scopeSamples } = useWorkstationStore.getState();
    expect(scopeSamples).toHaveLength(2);
    expect(scopeSamples[0].vBattMv).toBe(7430);
    expect(scopeSamples[0].gyroZ).toBeCloseTo(-0.45, 5);
    expect(scopeSamples[1].vBattMv).toBe(7430); // held, not zeroed
    expect(scopeSamples[1].gyroZ).toBeCloseTo(-0.45, 5);
    expect(scopeSamples[1].timestampUs).toBe(6000);
  });

  it('parses volt-scale v_batt values up to millivolts', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(
      makePacket({
        dissectedFields: [
          { name: 'v_batt', type: 'float32', offset: 0, length: 4, rawHex: '', decodedValue: '8.2 V' },
        ],
      })
    );
    expect(useWorkstationStore.getState().scopeSamples[0].vBattMv).toBeCloseTo(8200, 5);
  });

  it('directionFilter defaults to all and is settable', () => {
    expect(useWorkstationStore.getState().directionFilter).toBe('all');
    useWorkstationStore.getState().setDirectionFilter('tx');
    expect(useWorkstationStore.getState().directionFilter).toBe('tx');
  });

  it('replaces a running flash-yield countdown instead of stacking intervals', () => {
    vi.useFakeTimers();
    const s = useWorkstationStore.getState();
    s.triggerFlashYield(30);
    s.triggerFlashYield(10); // second trigger while the first counts down
    vi.advanceTimersByTime(11000);
    // With stacked intervals the countdown would double-decrement and go
    // negative / reclaim twice; with replace-any it expires exactly once.
    const after = useWorkstationStore.getState();
    expect(after.isYielded).toBe(false);
    expect(after.yieldRemainingSecs).toBe(0);
    expect(after.portState).toBe('open');
  });
});
