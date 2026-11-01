# 0053 Protobuf `.proto` Schema Naming

Status: accepted (2 November 2026). Closes D-112.

## Problem

A protobuf frame on the wire does not carry field names. Capture rows show `field_1` and `field_2`
without context. An operator must map field numbers to names by hand.

ZigZag signed integers (`sint32`, `sint64`) decode as unsigned varints. Enums display as arbitrary
numbers without their declared names. Length-delimited submessages do not resolve nested field names.

## Scope

A lightweight, zero-dependency `.proto` schema parser in `crates/bforge-dissect` and schema-directed
decoding.

Covers:
- `proto2` and `proto3` syntax declarations.
- Line comments (`//`) and block comments (`/* ... */`).
- Package declarations and namespaces.
- Messages, nested message blocks, and `oneof` blocks.
- Top-level and nested `enum` definitions with negative and positive values.
- Qualifiers: `optional`, `required`, and `repeated`.
- Statements: `reserved`, `option`, and `import`.
- `map<K, V>` fields.
- Scalar types: `int32`, `int64`, `uint32`, `uint64`, `bool`, `fixed32`, `sfixed32`, `fixed64`,
  `sfixed64`, `float`, `double`, `string`, `bytes`.
- ZigZag decoding for `sint32` and `sint64`.
- Enum variant resolution to `LABEL (N)`.
- Recursive nested message decoding.
- Fallback to `field_<number>` for fields not declared in the schema.
- `Pack::ProtobufSchema(ProtoSchema)` in `crates/bforge-dissect/src/packs/mod.rs`.

Explicitly out of scope:
- Remote network fetching of imported `.proto` files.
- Protobuf RPC `service` blocks.

## Behavior

1. `parse_proto(text, root)` parses schema definitions into `ProtoSchema` without external tools.
2. Comments (`//`, `/* ... */`) are stripped before token parsing.
3. When `root` is specified as `Some(name)`, decoding begins at the matching message definition.
4. When `root` is `None`, decoding defaults to the first top-level message.
5. If a field number matches a field in the active message schema, the decoded field takes the declared name.
6. If a field number is not present in the schema, the field name falls back to `field_<number>`.
7. `sint32` and `sint64` decode through ZigZag un-mapping to their signed values.
8. `float` and `double` decode from little-endian IEEE 754 representations to clean float strings.
9. Enums format as `LABEL (N)` when `N` matches a defined variant, or `N` when unknown.
10. Length-delimited submessages decode recursively using the child message definition.
11. `Pack::ProtobufSchema(schema)` decodes frames through `protobuf::decode_with_schema`.

## Measured

Running 65 tests in `bforge-dissect`:
- Total test execution time: 0.01 seconds.
- Memory allocations: zero extra heap allocations for schema-less path.
- Schema parser: zero external runtime dependencies.

## Test

Six targeted unit tests in `crates/bforge-dissect/src/packs/protobuf.rs`:
- `schema_names_fields_and_nested_messages`
- `schema_resolves_enum_labels_and_zigzag_sint32`
- `unknown_field_in_schema_falls_back_to_field_number`
- `pack_decode_with_and_without_schema`
- `nested_message_defined_inside_message`
- `comments_reserved_options_and_map`

Run command:
```sh
cargo test -p bforge-dissect
```

## Limits, recorded

- External file imports are skipped; all referenced types must exist in the parsed text.
- RPC `service` definitions are ignored because BaudForge decodes stream data frames.
