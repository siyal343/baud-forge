# 0009 Dissection: C headers and the IR executor

Status: accepted (28 October 2026). Implements F3.1 and the F3.2 subset.

## Problem

Firmware already describes its own wire format in a header. Asking an engineer
to retype that as JSON, or to add `printf` fields one at a time, is how a monitor
falls out of date with the firmware it is watching. The tool should read the
struct and decode the frame.

Two things can go wrong, and both are worse than not decoding at all: a layout
that is guessed wrong produces plausible numbers from the wrong bytes, and a read
past the end of a short frame produces garbage. So the parser refuses what it
cannot prove, and the executor bounds-checks every read.

## Scope

A C header parser for the subset the specification names, an intermediate
representation, and an executor. Not in this stage: `tree-sitter-c` (see the
deviation), Protobuf and Kaitai (F3.3), protocol packs (F3.4), checksum status
from the schema, and wiring the decoder into the live pipeline (S8).

## Behavior

1. The parser reads `struct` definitions, with or without
   `__attribute__((packed))`, a trailing typedef name, or both orders of the
   attribute.
2. Members may be fixed-width integers, floats, `char`, `bool`, arrays, bitfields
   and enum-typed fields. Storage qualifiers (`const`, `volatile`, `static`) are
   ignored. `typedef` aliases of a known type resolve.
3. Anything else is refused with a line: an unknown type, a bitfield in an
   unpacked struct, an array of structs, a member without a name. Guessing is not
   an option.
4. Layout: packed structs place fields back to back. Unpacked structs align each
   field to its own size and the size is the end of the last field. Bitfields are
   packed into a storage unit of their declared type, and a new unit starts when
   the bits do not fit.
5. Bit numbering runs from the least significant bit of the storage unit, which
   is how a little-endian compiler lays a packed C bitfield out.
6. `__le16`, `__be32` and friends set the byte order. An unannotated type is
   little endian, matching the firmware this tool is for.
7. Comments, `#include` lines and forward declarations do not disturb the parse.
8. The executor bounds-checks every read and names the field that does not fit.
   A decoded tree reports absolute byte offsets, so a field can point at the bytes
   in the hex pane.
9. Float widths other than 4 and 8 are refused, not rounded.

## Data

Types the parser resolves:

| Form | Size | Note |
| --- | --- | --- |
| `u8`, `uint8_t`, `char`, `unsigned char`, `bool` | 1 | unsigned |
| `i8`, `int8_t`, `signed char` | 1 | signed |
| `u16`, `uint16_t`, `short` | 2 | |
| `i16`, `int16_t` | 2 | signed |
| `u32`, `uint32_t`, `int`, `unsigned` | 4 | |
| `i32`, `int32_t` | 4 | signed |
| `u64`, `uint64_t`, `long long` | 8 | |
| `i64`, `int64_t` | 8 | signed |
| `float`, `double` | 4, 8 | |
| `__leN`, `__beN`, `leN_t`, `beN_t`, `uintN_le`, `uintN_be` | N/8 | sets byte order |
| enum typedef | 4 | C default width |

`CHeader { structs, enums }`, `CStruct { name, packed, size, fields }`,
`CField { name, type_name, offset, len, bit, array, enum_name }`,
`CEnum { name, variants }`. Compiled output is the existing `DissectorIr` with
`IrOp` labels, and `DecodedField { name, byte_offset, byte_len, value,
value_num, children }`.

## Deviation from ADR-003

ADR-003 names `tree-sitter-c`. This build has no C compiler: the bundled mingw
`gcc` cannot execute `cc1`, so `tree-sitter-c` cannot compile here and nothing
could be verified. The front end is therefore hand-written for the subset above.

The interface is `cheader::parse(&str) -> CHeader`, so a `tree-sitter-c` front end
can replace the tokenizer without touching the executor or the compiled IR. The
gap is recorded as D-35 in [DEFERRED.md](../DEFERRED.md), together with the
shapes this parser refuses (D-36, D-37).

## Measured

28 October 2026, Windows, `--release`, the `imu_packet.h` fixture:

```text
header: 2 struct(s), 1 enum(s), parsed in 0.1 ms
  ImuPacket   19 bytes, 9 field(s), packed
  EpsCommand   7 bytes, 3 field(s), packed

decoded 9 fields from 19 bytes in 31.9 us
sync           +0x00  2B  43605
version        +0x02  1B  3
flags          +0x03  1B  5
channel        +0x03  1B  18
timestamp_us   +0x04  4B  123456
v_batt_mv      +0x08  2B  8190
gyro_z         +0x0a  4B  -0.042
samples        +0x0e  4B  [4 items]
  samples        +0x0e  1B  1
  ...
mode           +0x12  1B  1

200000 frames in 1.11 s = 180422 frames/s (3.4 MB/s of frame bytes)
```

180 422 frames/s of 19-byte frames is 3.4 MB/s of frame bytes, about three times
the 12 Mbaud target. Every field allocates a `String` for the UI value, which is
where the time goes; a borrowed-value copy is D-38.

## Test

```sh
cargo test -p bforge-dissect
cargo run -p bforge-dissect --release --example s11_dissect
```

Executor, 7 tests: integers and floats in both byte orders, bitfields from the low
bits, enum labels with a numeric fallback, arrays with absolute child offsets, a
short frame naming the field that does not fit, a bad float width, and sizes.

Parser, 9 tests: the packed layout of the fixture end to end, enum labels with
explicit values, unpacked alignment, a bitfield outside a packed struct refused,
an unknown type refused with its line, typedef aliases, comments and includes, the
compiled field order with byte order kept, and a missing root struct reported.

Golden frame, 6 tests: a 19-byte frame built the way the firmware writes it
decodes to the exact values; the array keeps its elements; field offsets point at
the bytes they came from; a truncated frame is refused; a second struct in the
same header compiles and decodes.
