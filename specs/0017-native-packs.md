# 0017 Native protocol packs

Status: accepted (28 October 2026). Implements most of F3.4.

## Problem

A C header covers a team's own structs. It does not cover the standards their
subsystem already speaks: a CCSDS telemetry packet, a CSP datagram, a Modbus
request. Before this stage those arrived as bytes with no field names, so the
first question after every capture was "which byte was the APID?".

## Scope

Three packs: CCSDS Space Packet with an ECSS PUS secondary header, CSP v1, and
Modbus RTU. Not in this stage: MAVLink (D-56), CCSDS packet time codes and
segmentation (D-57), and Modbus function coverage beyond the register and coil
reads and writes (D-58).

## Behavior

1. A workspace names a pack instead of a schema file:
   `dissector = { type = "native", name = "ccsds_tm" }`.
2. Pack names: `ccsds_tm`, `ccsds_tc`, `csp`, `modbus_rtu`. Validation refuses an
   unknown name and lists the valid ones.
3. Every pack reports absolute byte offsets, so the hex pane can point at the bytes
   a field came from.
4. A pack never hides a fault. A declared length that does not match the frame, a
   CRC that does not verify, a byte count that disagrees with the payload: each
   becomes a field with a name and a `false` or a sentence, not a silent pass.
5. A frame too short for its header fails with the name of what is missing, and the
   row keeps `decode_error`, so a truncated packet is visible in the stream.

## Data

CCSDS: `version`, `type`, `type_matches_pack`, `secondary_header`, `apid`,
`sequence_flags`, `sequence_count`, `data_length`, `payload_bytes_present`,
`length_mismatch`, and for a PUS secondary header `pus.version`,
`pus.time_reference`, `service_type`, `service_subtype`, `user_data_bytes`.

CSP v1: `priority`, `source`, `destination`, `destination_port`, `source_port`,
`flags`, `payload_bytes`, and when the CRCT flag is set `crc32`, `crc32_valid`.

Modbus RTU: `slave`, `function`, `function_name`, `data_bytes`, `crc16`,
`crc16_valid`, plus `start_register` and `quantity` (or `register` and `value`) on
an 8-byte request, `byte_count` and `byte_count_mismatch` on a read response, and
`exception` on an exception response.

## Measured

No hardware and no external tool: each pack is judged by a hand-built fixture that
follows the published layout, in the crate's own tests.

```text
cargo test -p bforge-dissect      # 30 tests, 12 of them packs
cargo test -p bforge-core --test assert_fields
```

One end-to-end case sits in `assert_fields`: a CCSDS packet in a raw vault, framed
by a line delimiter, decoded by the pack, then checked by `bforge assert` rules
(`apid equals 291`, `protocol CCSDS_TM`) with no schema file anywhere.

## Why the packs are small

None of them tries to be complete. Each decodes the fields a person asks for first,
and reports the rest as a byte count. A pack that guesses a layout produces
confident wrong numbers, which is the failure mode this project exists to avoid, so
the gaps are named in DEFERRED instead of filled with a guess.

## Test

```sh
cargo test -p bforge-dissect
```

CCSDS, 4 tests: a telemetry packet decodes field by field, a length mismatch is
flagged and not hidden, a TM pack marks a telecommand, and a short frame names what
is missing.

CSP, 4 tests: every header field, payload bytes and a verified CRC, a wrong CRC
reported as invalid, and a frame too short for its CRC.

Modbus, 6 tests: a read-holding-registers request, a read response and its byte
count, a broken CRC, an exception response naming the reason, a write-single-
register request, and a short frame.

Config, 3 tests: a pack without a name is refused, an unknown name is refused with
the list, and a pack decodes a vault with no schema file.
