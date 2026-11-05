// Minimal C-header struct parser for the Struct-Form TX composer (spec 2.4).
//
// Deliberately small and honest: it handles the firmware-typical subset —
// fixed-width ints, float/double, bool, char arrays, fixed-size arrays of
// scalars — and reports everything it cannot parse as an error instead of
// guessing. Wire layout is packed little-endian (no implicit padding), which
// matches how embedded links frame payloads; `#pragma pack` is not modelled.
export interface ParsedField {
  name: string;
  type: string;
  /** Wire size of ONE element in bytes. */
  size: number;
  /** Array element count (1 for scalars). */
  count: number;
  kind: 'int' | 'float' | 'chars';
}

export interface ParsedStruct {
  name: string;
  fields: ParsedField[];
  /** Packed wire size in bytes. */
  size: number;
}

export interface ParseResult {
  structs: ParsedStruct[];
  errors: string[];
}

const TYPE_SIZES: Record<string, { size: number; kind: 'int' | 'float' | 'chars' }> = {
  uint8_t: { size: 1, kind: 'int' },
  int8_t: { size: 1, kind: 'int' },
  char: { size: 1, kind: 'chars' },
  bool: { size: 1, kind: 'int' },
  uint16_t: { size: 2, kind: 'int' },
  int16_t: { size: 2, kind: 'int' },
  short: { size: 2, kind: 'int' },
  uint32_t: { size: 4, kind: 'int' },
  int32_t: { size: 4, kind: 'int' },
  uint64_t: { size: 8, kind: 'int' },
  int64_t: { size: 8, kind: 'int' },
  float: { size: 4, kind: 'float' },
  double: { size: 8, kind: 'float' },
};

/** Integer range per type, enforced before packing (DataView wraps silently). */
const INT_RANGES: Record<string, [bigint, bigint]> = {
  uint8_t: [0n, 255n],
  int8_t: [-128n, 127n],
  bool: [0n, 255n],
  uint16_t: [0n, 65535n],
  int16_t: [-32768n, 32767n],
  short: [-32768n, 32767n],
  uint32_t: [0n, 4294967295n],
  int32_t: [-2147483648n, 2147483647n],
  uint64_t: [0n, 18446744073709551615n],
  int64_t: [-9223372036854775808n, 9223372036854775807n],
};

/** Strip // and /* *\/ comments so they cannot split declarations. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

export function parseCStructs(header: string): ParseResult {
  const errors: string[] = [];
  const structs: ParsedStruct[] = [];
  const clean = stripComments(header);

  // typedef struct {...} Name;  and  struct Name {...};
  const blockRe = /(?:typedef\s+)?struct\s*(\w+)?\s*\{([^}]*)\}\s*(\w+)?\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(clean)) !== null) {
    const inlineName = match[1];
    const body = match[2];
    const typedefName = match[3];
    const name = typedefName || inlineName || `struct_${structs.length + 1}`;

    const fields: ParsedField[] = [];
    for (const rawDecl of body.split(';')) {
      const decl = rawDecl.trim();
      if (!decl) continue;
      // type [*]name[N] [: bits]
      const declMatch = /^(\w+)\s*(\*)?\s*(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*(?::\s*\d+)?$/.exec(decl);
      if (!declMatch) {
        errors.push(`${name}: cannot parse declaration "${decl}"`);
        continue;
      }
      const [, typeName, pointer, fieldName, arrayLen] = declMatch;
      const info = TYPE_SIZES[typeName];
      if (pointer) {
        errors.push(`${name}.${fieldName}: pointers are not supported on the wire`);
        continue;
      }
      if (!info) {
        errors.push(`${name}.${fieldName}: unsupported type "${typeName}"`);
        continue;
      }
      if (/:\s*\d+$/.test(decl)) {
        errors.push(`${name}.${fieldName}: bitfields are not supported`);
        continue;
      }
      const count = arrayLen ? Math.max(1, parseInt(arrayLen, 10)) : 1;
      fields.push({
        name: fieldName,
        type: typeName,
        size: info.size,
        count,
        kind: info.kind,
      });
    }

    if (fields.length === 0) {
      errors.push(`${name}: no supported fields found`);
      continue;
    }
    structs.push({
      name,
      fields,
      size: fields.reduce((acc, f) => acc + f.size * f.count, 0),
    });
  }

  if (structs.length === 0 && errors.length === 0) {
    errors.push('no struct definitions found in the header');
  }
  return { structs, errors };
}

/** Serialize field values into packed little-endian wire bytes. */
export function serializeStruct(
  struct: ParsedStruct,
  values: Record<string, string>
): { bytes: number[]; errors: string[] } {
  const bytes: number[] = [];
  const errors: string[] = [];
  for (const field of struct.fields) {
    const raw = (values[field.name] ?? '').trim();
    if (field.kind === 'chars') {
      const encoded = Array.from(new TextEncoder().encode(raw));
      for (let i = 0; i < field.count; i++) {
        bytes.push(i < encoded.length ? encoded[i] : 0); // NUL pad
      }
      continue;
    }
    const numeric = raw === '' ? 0 : Number(raw);
    if (raw !== '' && Number.isNaN(numeric)) {
      errors.push(`${field.name}: "${raw}" is not a number`);
      continue;
    }
    const view = new DataView(new ArrayBuffer(field.size));
    try {
      if (field.kind === 'float') {
        if (field.size === 4) view.setFloat32(0, numeric, true);
        else view.setFloat64(0, numeric, true);
      } else {
        const unsigned = field.type.startsWith('u');
        if (field.size === 8) {
          // 64-bit via BigInt: setBigUint64/setBigInt64 write the full width.
          const [lo, hi] = INT_RANGES[field.type];
          const value = BigInt(Number.isInteger(numeric) ? numeric : 0);
          if (value < lo || value > hi) {
            throw new RangeError(`integer out of ${field.type} range`);
          }
          if (unsigned) view.setBigUint64(0, value, true);
          else view.setBigInt64(0, value, true);
        } else {
          const [lo, hi] = INT_RANGES[field.type];
          if (!Number.isInteger(numeric)) {
            throw new RangeError(`${field.type} requires an integer value`);
          }
          if (BigInt(numeric) < lo || BigInt(numeric) > hi) {
            throw new RangeError(`integer out of ${field.type} range (${lo}..${hi})`);
          }
          if (field.size === 1) view.setUint8(0, numeric);
          else if (field.size === 2) {
            if (unsigned) view.setUint16(0, numeric, true);
            else view.setInt16(0, numeric, true);
          } else if (field.size === 4) {
            if (unsigned) view.setUint32(0, numeric, true);
            else view.setInt32(0, numeric, true);
          }
        }
      }
    } catch (error) {
      errors.push(`${field.name}: ${(error as Error).message}`);
      continue;
    }
    for (let i = 0; i < field.size; i++) bytes.push(view.getUint8(i));
  }
  return { bytes, errors };
}
