# 0048 MAVLink pack

Status: accepted (1 November 2026). Closes most of D-56.

## Problem

MAVLink is what a drone speaks, and it was decoded as raw bytes. The earlier note said a pack
was impossible without a dialect XML, because the message bodies are dialect data. That is true
of the bodies, and false of the envelope: version, length, sequence, system, component, message
id and checksum sit in the same place in every frame, and four messages are in almost every
capture.

## Scope

Both versions, the envelope for every frame, and the message bodies of `HEARTBEAT` (0),
`GPS_RAW_INT` (24), `ATTITUDE` (30) and `GLOBAL_POSITION_INT` (33). Not in this stage: any other
body, the CRC_EXTRA check, and signing.

## Behavior

1. `dissector = { type = "native", name = "mavlink" }`. The pack reads v1 (`0xFE`) and v2
   (`0xFD`); any other start byte is refused by name.
2. Every frame reports `version`, `payload_len`, `sequence`, `system_id`, `component_id` and
   `msgid` with its message name. A v2 frame also reports `incompat_flags` and `compat_flags`,
   and says `frame is signed` when the signing bit is set.
3. The four known bodies decode by offset. Anything else keeps `msgid` and shows the payload as
   hex, which is honest: a wrong offset prints a confident number from the wrong bytes.
4. Signed integers read as signed: a latitude of `-355000000` prints with its minus sign.
5. The checksum is reported, not verified. MAVLink's CRC covers the header and payload plus a
   CRC_EXTRA byte that only the dialect knows, so the field says what it needs.
6. A frame shorter than its own header, payload or checksum fails with the reason, and the row
   keeps `decode_error`.

## Test

Seven unit tests in `crates/bforge-dissect/src/packs/mavlink.rs`: a v1 HEARTBEAT, a v2 HEARTBEAT
with its flags and three-byte id, ATTITUDE floats, a negative latitude in
GLOBAL_POSITION_INT, an unknown message id, a short frame and a wrong start byte.

One end-to-end test in `crates/bforge-core/tests/assert_fields.rs` decodes a HEARTBEAT through a
vault and reads `type`, `base_mode` and `mavlink_version`.

```sh
cargo test -p bforge-dissect --lib packs::mavlink
cargo test -p bforge-core --test assert_fields
```

The v2 test found a real bug while it was being written: the sequence byte sits at index 4 in a
v2 frame, not 5, and the first version of the pack read the system id as the sequence.

## Limits, recorded

- Four message bodies only. MAVLink has ~300 in the common set, and each needs its field order
  copied from the dialect by hand.
- No CRC_EXTRA, so a corrupted payload is not detected.
- Signing is reported, not removed: the signature bytes after the checksum are not parsed.
