# 0047 Protobuf pack

Status: accepted (1 November 2026). Takes the protobuf half of D-56.

## Problem

Protobuf is the common wire format for a companion computer, and the SRS lists a
`tree-sitter`/Protobuf dissector (F3.3). A `.proto` file is not always available: a capture
often arrives without the schema, and the question is still "which field is the battery
voltage?".

## Scope

A schema-less decoder for the protobuf wire format, as a native pack named `protobuf`. Not in
this stage: applying a `.proto` file to produce field names, `sint`/`zigzag` presentation,
packed repeated fields as one row, or proto3 `Any` resolution.

## Behavior

1. `dissector = { type = "native", name = "protobuf" }` in a workspace. Validation lists it
   with the other pack names.
2. Every field is reported as `field_<number>`, because the number is what the bytes carry.
3. Wire types map to a value: varint to a number, `fixed64` and `fixed32` to a number with its
   hex, `length-delimited` to a string when it prints and to hex when it does not.
4. A length-delimited body that parses **entirely** as fields becomes a nested message with
   children. Nesting stops at eight levels.
5. A frame whose first byte is not a field fails with the reason, and the row keeps
   `decode_error`; a frame that parses and then runs out names the remaining bytes `unparsed`
   with the error in front of them. Partial truth beats a blank row.
6. Group wire types (3 and 4) are refused by name: proto3 removed them, so a frame that uses
   them is not a frame this pack should guess at.

## Test

Ten unit tests in `crates/bforge-dissect/src/packs/protobuf.rs`, built from the protobuf
documentation's own example (`08 96 01` is field 1, varint, 150) and from hand-built frames for
strings, hex payloads, nested messages, fixed widths, truncation, groups and field number zero.

One end-to-end test in `crates/bforge-core/tests/assert_fields.rs`: a vault recorded with the
pack decodes to `field_1 = varint 150` and `field_2 = "abc"`, and an assert rule passes on it.

```sh
cargo test -p bforge-dissect --lib packs::protobuf
cargo test -p bforge-core --test assert_fields
```

## Measured

`08 96 01 12 03 61 62 63 0A` through a delimiter-framed vault:

```text
field_1   varint 150            offset 1, length 2
field_2   "abc"                 offset 6, length 3
```

## Limits, recorded

- No schema, so no names: `field_7` is a battery voltage only if the reader knows it is.
- `sint32`/`sint64` are shown as their unsigned varint. Zigzag decoding needs the schema's type.
- A packed repeated field decodes as one hex blob, not one value per element.
- Maps and `oneof` have no marker on the wire, so they show as ordinary fields.
