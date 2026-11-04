// BaudForge High-Fidelity Simulation Telemetry Generator
// Implements simulated ImuPacket streaming per crates/bforge-dissect/tests/fixtures/imu_packet.h

import { PacketRow, DissectedField, ScopeSignalSample } from '../types';

let globalSeq = 1;
let bootEpochUs = 100000;
let lastPacketTimeUs = 100000;

export function generateSampleImuPacket(
  portId = 'COM8',
  injectFault = false,
  customDeltaUs = 50000
): PacketRow {
  const seqId = globalSeq++;
  const deltaUs = customDeltaUs + Math.floor((Math.random() - 0.5) * 400); // 50ms +- 200us jitter
  lastPacketTimeUs += deltaUs;
  const timestampUs = lastPacketTimeUs;
  bootEpochUs += deltaUs;

  const tSec = bootEpochUs / 1000000;

  // Realistic aerospace sensor physics
  const baseVbatt = 8180 - Math.min(200, (bootEpochUs / 1000000) * 0.2); // Slowly declining 8.18V down
  const vBattMv = Math.round(baseVbatt + Math.sin(tSec * 0.5) * 25);
  const gyroZ = parseFloat((0.45 * Math.sin(tSec * 1.8) + 0.08 * Math.cos(tSec * 5.2)).toFixed(4));
  
  // Flags & Channel (byte 3)
  const flagRun = 1;
  const flagArmed = tSec > 2 ? 1 : 0;
  const flagFault = injectFault ? 1 : 0;
  const flagsBits = (flagFault << 2) | (flagArmed << 1) | flagRun; // 3 bits
  const channel = 2; // 5 bits
  const byte3 = (channel << 3) | (flagsBits & 0x07);

  const mode = injectFault ? 2 : 1; // 1=RUN, 2=FAULT
  const samples = [
    Math.floor(128 + 60 * Math.sin(tSec * 4.0)),
    Math.floor(128 + 50 * Math.sin(tSec * 4.0 + 1.0)),
    Math.floor(128 + 40 * Math.sin(tSec * 4.0 + 2.0)),
    Math.floor(128 + 30 * Math.sin(tSec * 4.0 + 3.0)),
  ];

  // Construct raw 20-byte payload
  const rawBytes = new Array(20).fill(0);
  // 0..2 sync (0xAA, 0x55)
  rawBytes[0] = 0xaa;
  rawBytes[1] = 0x55;
  // 2..3 version
  rawBytes[2] = 0x01;
  // 3..4 flags & channel
  rawBytes[3] = byte3;
  // 4..8 timestamp_us (le32)
  const tsView = new DataView(new ArrayBuffer(4));
  tsView.setUint32(0, bootEpochUs & 0xffffffff, true);
  for (let i = 0; i < 4; i++) rawBytes[4 + i] = tsView.getUint8(i);

  // 8..10 v_batt_mv (__be16, big endian)
  const vbView = new DataView(new ArrayBuffer(2));
  vbView.setUint16(0, vBattMv, false);
  rawBytes[8] = vbView.getUint8(0);
  rawBytes[9] = vbView.getUint8(1);

  // 10..14 gyro_z (float, le32)
  const gzView = new DataView(new ArrayBuffer(4));
  gzView.setFloat32(0, gyroZ, true);
  for (let i = 0; i < 4; i++) rawBytes[10 + i] = gzView.getUint8(i);

  // 14..18 samples (4 bytes)
  for (let i = 0; i < 4; i++) rawBytes[14 + i] = samples[i];

  // 18..19 mode
  rawBytes[18] = mode;

  // 19..20 simple checksum or CRC
  let sum = 0;
  for (let i = 0; i < 19; i++) sum = (sum + rawBytes[i]) & 0xff;
  if (injectFault) {
    rawBytes[19] = (sum ^ 0xff) & 0xff; // Corrupt checksum
  } else {
    rawBytes[19] = sum;
  }

  const rawHex = rawBytes
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const isValidCrc = !injectFault;

  const dissectedFields: DissectedField[] = [
    {
      name: 'sync',
      type: 'uint16',
      offset: 0,
      length: 2,
      rawHex: 'AA 55',
      decodedValue: '0x55AA',
      unit: 'marker',
    },
    {
      name: 'version',
      type: 'uint8',
      offset: 2,
      length: 1,
      rawHex: '01',
      decodedValue: 1,
    },
    {
      name: 'flags',
      type: 'bitfield (3b)',
      offset: 3,
      length: 1,
      rawHex: rawBytes[3].toString(16).padStart(2, '0').toUpperCase(),
      decodedValue: `0b${flagsBits.toString(2).padStart(3, '0')}`,
      bitfield: [
        { bit: 0, name: 'RUN', val: flagRun },
        { bit: 1, name: 'ARMED', val: flagArmed },
        { bit: 2, name: 'FAULT', val: flagFault },
      ],
      isMutated: injectFault,
    },
    {
      name: 'channel',
      type: 'bitfield (5b)',
      offset: 3,
      length: 1,
      rawHex: rawBytes[3].toString(16).padStart(2, '0').toUpperCase(),
      decodedValue: channel,
    },
    {
      name: 'timestamp_us',
      type: 'uint32_le',
      offset: 4,
      length: 4,
      rawHex: rawBytes.slice(4, 8).map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase(),
      decodedValue: bootEpochUs,
      unit: 'us',
    },
    {
      name: 'v_batt_mv',
      type: 'uint16_be',
      offset: 8,
      length: 2,
      rawHex: rawBytes.slice(8, 10).map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase(),
      decodedValue: (vBattMv / 1000).toFixed(2),
      unit: 'V',
    },
    {
      name: 'gyro_z',
      type: 'float32_le',
      offset: 10,
      length: 4,
      rawHex: rawBytes.slice(10, 14).map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase(),
      decodedValue: gyroZ,
      unit: 'rad/s',
      isMutated: injectFault,
      originalValue: injectFault ? '0.0000' : undefined,
    },
    {
      name: 'samples',
      type: 'uint8[4]',
      offset: 14,
      length: 4,
      rawHex: rawBytes.slice(14, 18).map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase(),
      decodedValue: `[${samples.join(', ')}]`,
    },
    {
      name: 'mode',
      type: 'enum mode_t',
      offset: 18,
      length: 1,
      rawHex: rawBytes[18].toString(16).padStart(2, '0').toUpperCase(),
      decodedValue: mode === 1 ? 'MODE_RUN (1)' : mode === 2 ? 'MODE_FAULT (2)' : 'MODE_IDLE (0)',
      unit: 'state',
    },
    {
      name: 'checksum',
      type: 'checksum8',
      offset: 19,
      length: 1,
      rawHex: rawBytes[19].toString(16).padStart(2, '0').toUpperCase(),
      decodedValue: `0x${rawBytes[19].toString(16).padStart(2, '0').toUpperCase()}`,
      isValidCrc,
      isMutated: injectFault,
      originalValue: injectFault ? `0x${sum.toString(16).padStart(2, '0').toUpperCase()}` : undefined,
    },
  ];

  return {
    seqId,
    timestampNs: timestampUs * 1000,
    timestampUs,
    deltaUs,
    timeStr,
    direction: injectFault ? 'FAULT' : 'RX',
    port: portId,
    length: 20,
    rawBytes,
    rawHex,
    protocol: 'ImuPacket',
    summary: `v_batt=${(vBattMv / 1000).toFixed(2)}V gyro_z=${gyroZ.toFixed(3)} rad/s ${isValidCrc ? 'CRC OK' : 'CRC FAIL'}`,
    dissectedFields,
    hasError: !isValidCrc,
    errorMsg: !isValidCrc ? 'Checksum mismatch (injected SEU)' : undefined,
    isFaultInjected: injectFault,
  };
}

export function generateScopeSample(tUs: number): ScopeSignalSample {
  const tSec = tUs / 1000000;
  const baseVbatt = 8180 - Math.min(200, (tUs / 1000000) * 0.2);
  const vBattMv = Math.round(baseVbatt + Math.sin(tSec * 0.5) * 25);
  const gyroZ = parseFloat((0.45 * Math.sin(tSec * 1.8) + 0.08 * Math.cos(tSec * 5.2)).toFixed(4));
  const flagRun = 1;
  const flagArmed = tSec > 2 ? 1 : 0;
  const flagFault = Math.sin(tSec * 0.8) > 0.85 ? 1 : 0;

  return {
    timestampUs: tUs,
    vBattMv,
    gyroZ,
    flags: [flagRun, flagArmed, flagFault],
    mode: flagFault ? 2 : 1,
  };
}
