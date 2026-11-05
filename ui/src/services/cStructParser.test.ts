// C-header struct parser + serializer verification (spec 2.4 Struct Form).
import { describe, it, expect } from 'vitest';
import { parseCStructs, serializeStruct } from './cStructParser';

const IMU_HEADER = `
#pragma pack(push, 1)
// Telemetry frame broadcast at 20 Hz.
typedef struct {
    uint32_t seq;          // frame counter
    uint64_t timestamp_ns; // monotonically rising
    float gyro_z;
    uint16_t vbatt_mv;
    uint8_t mode;
    uint8_t flags;
} ImuPacket;

struct ConfigMsg {
    char product[8];
    int16_t offset;
    bool enabled;
};
#pragma pack(pop)
`;

describe('parseCStructs', () => {
  it('parses typedef structs with fixed-width fields', () => {
    const { structs, errors } = parseCStructs(IMU_HEADER);
    expect(errors).toEqual([]);
    expect(structs).toHaveLength(2);

    const imu = structs[0];
    expect(imu.name).toBe('ImuPacket');
    expect(imu.fields.map((f) => f.name)).toEqual([
      'seq',
      'timestamp_ns',
      'gyro_z',
      'vbatt_mv',
      'mode',
      'flags',
    ]);
    expect(imu.size).toBe(4 + 8 + 4 + 2 + 1 + 1);
  });

  it('parses plain struct blocks with char arrays and bools', () => {
    const { structs } = parseCStructs(IMU_HEADER);
    const cfg = structs[1];
    expect(cfg.name).toBe('ConfigMsg');
    expect(cfg.fields[0]).toMatchObject({ name: 'product', type: 'char', count: 8, kind: 'chars' });
    expect(cfg.size).toBe(8 + 2 + 1);
  });

  it('reports unsupported declarations as errors instead of guessing', () => {
    const { structs, errors } = parseCStructs(`
      struct Bad {
          uint32_t *ptr;
          uint8_t bits : 3;
          SomeStruct nested;
      };
    `);
    // Every declaration failed, so the struct itself is dropped with an
    // honest "no supported fields" note on top of the three field errors.
    expect(structs).toHaveLength(0);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('pointers are not supported');
    expect(errors[1]).toContain('bitfields are not supported');
    expect(errors[2]).toContain('unsupported type');
    expect(errors[3]).toContain('no supported fields');
  });

  it('reports an empty header honestly', () => {
    const { structs, errors } = parseCStructs('int main(void) { return 0; }');
    expect(structs).toHaveLength(0);
    expect(errors[0]).toContain('no struct definitions');
  });
});

describe('serializeStruct', () => {
  const { structs } = parseCStructs(IMU_HEADER);
  const imu = structs[0];

  it('packs little-endian scalars and floats in field order', () => {
    const { bytes, errors } = serializeStruct(imu, {
      seq: '1',
      timestamp_ns: '2',
      gyro_z: '0.5',
      vbatt_mv: '7430',
      mode: '1',
      flags: '0',
    });
    expect(errors).toEqual([]);
    expect(bytes).toHaveLength(imu.size);
    // seq = uint32 LE 0x00000001
    expect(bytes.slice(0, 4)).toEqual([1, 0, 0, 0]);
    // timestamp_ns = uint64 LE 2
    expect(bytes.slice(4, 12)).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    // gyro_z = float32 LE 0.5 -> 0x3F000000
    expect(bytes.slice(12, 16)).toEqual([0, 0, 0, 0x3f]);
    // vbatt_mv = uint16 LE 7430 = 0x1D06
    expect(bytes.slice(16, 18)).toEqual([0x06, 0x1d]);
    // mode, flags
    expect(bytes.slice(18)).toEqual([1, 0]);
  });

  it('NUL-pads char arrays and flags out-of-range integers', () => {
    const cfg = parseCStructs(IMU_HEADER).structs[1];
    const ok = serializeStruct(cfg, { product: 'BF', offset: '-2', enabled: '1' });
    expect(ok.errors).toEqual([]);
    expect(ok.bytes.slice(0, 8)).toEqual([
      0x42, 0x46, 0, 0, 0, 0, 0, 0, // 'B','F' + NUL pad
    ]);
    expect(ok.bytes.slice(8, 10)).toEqual([0xfe, 0xff]); // int16 LE -2

    const bad = serializeStruct(cfg, { product: '', offset: '99999', enabled: '' });
    expect(bad.errors[0]).toContain('offset');
  });

  it('treats empty numeric fields as zero without error', () => {
    const { bytes, errors } = serializeStruct(imu, {});
    expect(errors).toEqual([]);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});
