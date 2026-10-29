# 0022 Fault injector on the transmit path

Status: accepted (29 October 2026). First slice of FR-FLT-01.

## Problem

The product is called *Forge, Frame, Fault-Inject*, and until now it could only
observe. A person testing a device's error handling needs corrupted bytes on the
wire: a single-event upset, a dropped byte, a frame cut short, a CRC that no longer
verifies. Hand-editing hex is possible and does not reproduce.

## Scope

Fault profiles applied to what the engine sends. Not in this stage: jitter and
latency up to 5 s (D-66), the dual-port MITM bridge and the Lua runtime (D-67), and
faults on the receive path.

## Behavior

1. `POST /api/fault` arms a profile on a port:
   `{ "port": "sim", "kind": "bit_flip", "flip_rate": 1.0, "seed": 7 }`.
2. Kinds: `bit_flip` (per-byte probability, `burst` bits, default 1), `drop`
   (`drop_every` bytes), `truncate` (bytes cut from the end), `corrupt_crc`
   (`corrupt_crc` bytes at the end inverted), and `off` to disarm.
3. Every random choice comes from one SplitMix64 stream seeded by the profile, so a
   failure reproduces exactly from the same seed.
4. The profile is applied **before the reader writes**, in the session's send path.
   The device sees the corruption; the caller learns what it sent.
5. `/api/send` reports the result: `{"sent":2,"fault_bytes":2,"dropped":false}`.
   `fault_bytes` counts bytes this profile changed; a write that the profile removed
   entirely answers `{"dropped":true}`.
6. An unknown kind is a `400` that lists the kinds. An unknown port is a `404`.
7. The workbench has a fault row in the forge band: kind, amount, Arm.

## Data

`FaultProfile { flip_rate, burst, drop_every, truncate, corrupt_crc, seed }` is
serialised back to the caller when a profile is armed, so the record of what was
armed cannot drift from what runs. Counters live in the injector: writes, touched,
dropped.

## Measured

End to end in `crates/bforge-core/tests/serve.rs`, against a socket device that
records what it receives:

```text
POST /api/fault {"kind":"bit_flip","flip_rate":1.0,"seed":7}   -> 200, profile echoed
POST /api/send  {"hex":"0000"}                                  -> 200 {"sent":2,"fault_bytes":2}
device received 2 bytes, each with exactly one bit set (0x00 flipped)
POST /api/fault {"kind":"off"}                                  -> 200 {"profile":null}
POST /api/send  {"hex":"00"}                                    -> 200 {"fault_bytes":0}
```

Live against the socket simulator:

```text
{"port":"sim","sent":2,"fault_bytes":2,"dropped":false}
{"error":"`wobble` is not a fault kind; use bit_flip, drop, truncate, corrupt_crc or off"}
```

Captured in Edge at 1440×900: `docs/screenshots/workbench.png` shows the forge band
with the fault row.

## Test

```sh
cargo test -p bforge-core --lib fault     # 6 tests
cargo test -p bforge-core --test serve    # a fault changes what the device gets
```

The unit tests pin: an off profile changes nothing, a certain flip changes exactly
one bit per byte, one seed reproduces the same faults, `drop_every: 2` removes half
the bytes, truncation cuts the end and can drop the write, and a corrupt CRC touches
only the tail.

## Limits, recorded

- No delay or jitter (D-66): a delayed write needs a queue with deadlines, and
  blocking the reader would stop the receive path.
- No MITM bridge and no scripted faults (D-67).
- Receive-path faults are not implemented: the injector sits on the send path only.
