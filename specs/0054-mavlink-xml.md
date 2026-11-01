# 0054 MAVLink XML Dialect Loader

Status: accepted (2 November 2026). Closes D-56.

## Problem

MAVLink messages outside the four built-in types decode only as raw hex bytes.
The pack does not compute or verify the message-specific `CRC_EXTRA` byte.
Corrupted payloads and incompatible dialect versions pass without detection.

MAVLink dialect XML definitions declare fields in logical order.
The MAVLink wire protocol requires fields sorted by element size.
Without this reordering, fields read incorrect bytes from the wire.
MAVLink v2 frames also strip trailing zero bytes from payloads on the wire.
Without zero-padding, decoders fail on truncated base fields.

## Scope

A zero-dependency XML dialect parser and schema-directed MAVLink frame decoder in `crates/bforge-dissect`.

Covers:
- Parse `<mavlink>` XML with `<enums>`, `<enum>`, `<entry>`, `<messages>`, `<message>`, `<field>`, and `<extensions/>`.
- Sort base fields by element wire size in descending order (8, 4, 2, 1 byte) with XML declaration order as a tie-breaker.
- Keep extension fields in XML declaration order after all base fields.
- Calculate official `CRC_EXTRA` byte seeds with X.25 CRC-16 (MCRF4XX) over message names, base field types, names, and array lengths.
- Verify frame checksums against computed X.25 CRC-16 including `CRC_EXTRA`.
- Emit `"crc_status"` (`"valid"`, `"invalid"`, `"unverified"`) and formatted `"checksum"` status.
- Zero-pad truncated payloads in MAVLink v2 frames before decoding base fields.
- Resolve field `enum` attributes to `VALUE (LABEL)` representations.
- Add `Pack::MavlinkDialect(MavlinkDialect)` to `crates/bforge-dissect/src/packs/mod.rs`.

Explicitly out of scope:
- Remote fetching and resolution of external XML `<include>` files.
- Cryptographic signature validation for signed MAVLink v2 frames.

## Behavior

1. `parse_xml(xml)` parses dialect definitions into a `MavlinkDialect` struct without external crates.
2. XML comments (`<!-- ... -->`) and processing instructions (`<? ... ?>`) are removed before tag extraction.
3. Base fields before `<extensions/>` sort by element size in descending order. When element sizes match, fields keep declaration order.
4. Extension fields after `<extensions/>` keep XML declaration order at the end of the payload.
5. `CRC_EXTRA` calculations match official reference values: `HEARTBEAT` = 50, `GPS_RAW_INT` = 24, `ATTITUDE` = 39, `GLOBAL_POSITION_INT` = 104.
6. `decode_with_dialect(frame, dialect)` verifies the trailing 16-bit CRC with the message `CRC_EXTRA` byte.
7. Valid checksums report `0xXXXX (valid)` and `crc_status` as `valid`.
8. Checksum mismatches report `0xXXXX (invalid, expected 0xYYYY)` and `crc_status` as `invalid`.
9. Frames without a known `CRC_EXTRA` report `0xXXXX (needs the dialect's CRC_EXTRA to verify)` and `crc_status` as `unverified`.
10. MAVLink v2 payloads trimmed of trailing zeros are padded with zeroes up to the message base payload length.
11. Decoded enum fields format as `VALUE (ENTRY_NAME)`.

## Measured

Running 68 unit tests in `bforge-dissect`:
- Execution time: 0.01 seconds.
- Memory allocations: zero external XML parsing dependencies.
- Checksum accuracy: `CRC_EXTRA` matches reference values for all standard message definitions.

## Test

Targeted unit tests in `crates/bforge-dissect/src/packs/mavlink.rs`:
- `crc_extra_matches_standard_for_builtin_messages`
- `xml_dialect_reorders_fields_by_element_width_and_decodes_custom_message`
- `v2_zero_trimmed_payload_and_bad_crc_are_reported`

Run command:
```sh
cargo test -p bforge-dissect
```

## Limits, recorded

- Referenced files in `<include>` elements are ignored; all messages must exist in the parsed XML dialect string.
- MAVLink v2 frame signatures are reported through the `signed` envelope field, but cryptographic signatures are not validated.
