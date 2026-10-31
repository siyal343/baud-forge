# 0034 A script that reads and writes fields

Status: accepted (31 October 2026). Closes D-83, the last item of the SRS's Lua example.

## Problem

A script received spaced hex. The SRS's own example is written in fields:

```lua
local pkt = frame:dissect("C_STRUCT:EpsCommand")
pkt.fields.cmd_id == 0x04
pkt.fields.target_temp_c = pkt.fields.target_temp_c ~ 0x0010
frame:repack_and_recalc_crc(pkt)
```

Without that, a person must know byte offsets by heart, which is the thing the
dissector exists to remove.

## Scope

The hook receives a `frame` object when its port has a C header schema: read a field,
write a field, recompute the checksum, send the result. Not in this stage: reading the
schema by name at run time (`frame:dissect("X")`), a per-port script schema (D-94), and
reading nested children as tables (a dotted name works).

## Behavior

1. `frame:get(name)` returns a number, an enum label, or nil. It reads the frame as it
   arrived, then the script's own uncommitted changes.
2. `frame:set(name, value)` takes a number or an enum label. It records a change; the
   bytes are patched when the hook returns.
3. Fields the script does not touch keep their bytes, including fields the schema does
   not name. A patch is not a re-encode, so nothing is zeroed.
4. `frame:recalc_crc("crc32c")` folds the pending changes in first, then writes the
   checksum over everything before its own width. `crc8` and `crc16_ccitt_false` work the
   same way.
5. `return frame` sends the patched bytes. A hex string is still accepted, and nil still
   drops the frame, so old scripts keep working.
6. A name the schema does not have is refused at `set`, not silently ignored.

## Data

`bforge_dissect::encoder::patch(ir, &mut [u8], &values)` writes named fields into bytes
that already exist. `bforge_script::frame::FrameState` holds the bytes, the schema and
the pending changes for one call.

## Measured

Script: `frame:set("v_batt_mv", 7500); frame:recalc_crc("crc32c"); return frame`

```text
sent values {sync:43605, version:3, v_batt_mv:7400, mode:1}
device received 55 AA … 1D 4C …  with the sync word untouched and the CRC recomputed
```

Ten runtime tests, including: a change touches one field and leaves the rest, a name the
schema does not have leaves the frame alone, and the checksum covers the patched field.

## Test

```sh
cargo test -p bforge-script --lib
cargo test -p bforge-core --test serve
```

## A fault worth recording

The first version returned the *unpatched* bytes: the Lua closures hold their own
reference to the frame state, so `Arc::try_unwrap` after the call always failed and the
fallback silently used the original. The fix is `patched_bytes(&self)` — and the lesson is
that a fallback which quietly returns the input hides a broken feature.

## Limits, recorded

- One schema is used for every port, which is right for a bridge and wrong for a workspace
  with two packet formats (D-94).
- `frame:dissect("OtherStruct")` does not exist; the port's root struct is the schema.
