// Simulation engine data-integrity spot checks (audit P3 fixes).
import { describe, it, expect } from 'vitest';
import { generateSampleImuPacket } from './simulationEngine';

describe('simulation engine', () => {
  it('decodes the AA 55 sync marker in big-endian order (0xAA55)', () => {
    const pkt = generateSampleImuPacket('COM8', false, 50000);
    const sync = pkt.dissectedFields.find((f) => f.name === 'sync');
    expect(sync?.decodedValue).toBe('0xAA55');
    expect(sync?.rawHex).toBe('AA 55');
  });

  it('marks injected fault frames with direction FAULT and CRC FAIL', () => {
    const ok = generateSampleImuPacket('COM8', false, 50000);
    const bad = generateSampleImuPacket('COM8', true, 50000);
    expect(ok.direction).toBe('RX');
    expect(ok.hasError).toBe(false);
    expect(bad.direction).toBe('FAULT');
    expect(bad.hasError).toBe(true);
  });
});
