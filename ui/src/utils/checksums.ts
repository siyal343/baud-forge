/**
 * Pure bitwise checksum helpers shared by Command Forge and the offline Lua sandbox.
 */

export const crc8Atm = (bytes: number[]): number => {
  let crc = 0x00;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
};

export const crc16CcittFalse = (bytes: number[]): number => {
  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

export const crc16Modbus = (bytes: number[]): number => {
  // CRC-16/MODBUS: poly 0x8005 (reflected 0xA001), init 0xFFFF, reflect in/out.
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x0001 ? ((crc >> 1) ^ 0xa001) & 0xffff : crc >> 1;
    }
  }
  return crc;
};

export const crc16Xmodem = (bytes: number[]): number => {
  // CRC-16/XMODEM: poly 0x1021, init 0x0000, MSB-first, no reflection or xorout.
  let crc = 0x0000;
  for (const b of bytes) {
    crc ^= (b & 0xff) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

export const crc32c = (bytes: number[]): number => {
  // CRC-32C (Castagnoli): reflected poly 0x82F63B78, init/xorout 0xFFFFFFFF.
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x00000001 ? ((crc >>> 1) ^ 0x82f63b78) >>> 0 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Checksum byte sequence to append on the wire, per algorithm convention. */
export const checksumBytes = (kind: string, bytes: number[]): number[] => {
  if (kind === 'sum8') {
    return [bytes.reduce((acc, b) => (acc + b) & 0xff, 0)];
  }
  if (kind === 'crc8' || kind === 'crc8_atm') {
    return [crc8Atm(bytes)];
  }
  if (kind === 'crc16') {
    const crc = crc16CcittFalse(bytes);
    return [(crc >> 8) & 0xff, crc & 0xff]; // big-endian (network order)
  }
  if (kind === 'crc16modbus') {
    const crc = crc16Modbus(bytes);
    return [crc & 0xff, (crc >> 8) & 0xff]; // little-endian per MODBUS spec
  }
  if (kind === 'crc32') {
    const crc = crc32c(bytes);
    return [crc & 0xff, (crc >> 8) & 0xff, (crc >> 16) & 0xff, (crc >>> 24) & 0xff]; // little-endian
  }
  return [];
};
