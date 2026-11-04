// Checksum engine verification against the standard check-value vectors.
// CRC-16/CCITT-FALSE('123456789') = 0x29B1 (catalogue check value)
// CRC-16/MODBUS('123456789')     = 0x4B37
// CRC-32C('123456789')           = 0xE3069283
// Regression guard for the audit finding where these were implemented as
// plain byte sums and labeled as CRCs.
import { describe, it, expect } from 'vitest';
import {
  crc16CcittFalse,
  crc16Modbus,
  crc32c,
  checksumBytes,
} from '../components/CommandForge';

const ascii = (s: string) => Array.from(new TextEncoder().encode(s));
const demoPayload = [0xaa, 0x55, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00];

describe('checksum engines', () => {
  it('CRC-16/CCITT-FALSE matches the catalogue check value', () => {
    expect(crc16CcittFalse(ascii('123456789'))).toBe(0x29b1);
  });

  it('CRC-16/CCITT-FALSE matches the audit vector for the demo payload', () => {
    // The old byte-sum implementation printed 0x0102 for this payload.
    expect(crc16CcittFalse(demoPayload)).toBe(0xb4b8);
  });

  it('CRC-16/MODBUS matches the catalogue check value', () => {
    expect(crc16Modbus(ascii('123456789'))).toBe(0x4b37);
  });

  it('CRC-32C matches the catalogue check value', () => {
    expect(crc32c(ascii('123456789'))).toBe(0xe3069283);
  });

  it('checksumBytes appends per algorithm byte order conventions', () => {
    const check = ascii('123456789');
    expect(checksumBytes('sum8', [0x01, 0x02])).toEqual([0x03]);
    // CCITT-FALSE(0x29B1) big-endian on the wire
    expect(checksumBytes('crc16', check)).toEqual([0x29, 0xb1]);
    // MODBUS(0x4B37) little-endian on the wire
    expect(checksumBytes('crc16modbus', check)).toEqual([0x37, 0x4b]);
    // CRC-32C(0xE3069283) little-endian on the wire
    expect(checksumBytes('crc32', check)).toEqual([0x83, 0x92, 0x06, 0xe3]);
    expect(checksumBytes('none', [0x01])).toEqual([]);
  });
});
