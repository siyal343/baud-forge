# 01 — State

Verified 1 November 2026 at commit `3f061e4`. Re-verify before you trust any number here.

## Numbers

| Measure | Value | How it was measured |
| --- | --- | --- |
| Tests | **299** | `cargo test --workspace --exclude bforge-gui`, summed over crates |
| Rust lines | 23,487 | `wc -l` over `crates/**/*.rs`, excluding `target` |
| Frontend lines | 1,854 | `wc -l` over `ui/src/**/*.ts*` |
| Crates | 9 | `ls crates` |
| Specs | 52 | `ls specs/*.md` |
| Open deferred entries | 79 | `grep -c '^| D-' DEFERRED.md` |
| Releases | 13 | `git tag` |
| Latest release | `v0.8.0`, 1 Nov 2026 | `gh release list` |
| CI | 9 jobs, green | `gh run list` |

Lines per crate, for orientation: core 11,275; dissect 4,236; storage 1,876; framer 1,545;
cli 1,473; hal 1,070; script 758; elf 664; gui 587.

Tests per crate: core 112; dissect 65; framer 38; storage 23; elf 20; cli 19; hal 12;
script 10.

## What is proven, and what is only reasoned about

This distinction matters more than the feature list. `STATUS.md` keeps the full table. The short
version:

**Proven by measurement in this repository:**

- Throughput and memory: 2.5 MB/s into the vault with the writer polling, 0 dropped slabs at
  50 k frames/s in the stress example, ring-buffer ordering over 50 k chunks.
- Reconnect on Windows: 17–47 ms detection, 1 ms reopen, data resumed (spec 0012).
- The stream fix of 0.7.0: dropped batches fell from 14,269 to 3 while the window saw 8,988
  frames in 25 s.
- Export: 285,740 records to CSV in 5.5 s, JSON Lines 4.4 s, PCAPNG 3.4 s, with the PCAPNG
  checked by an independent parser and all three outputs byte-identical before and after the
  cursor change.
- Playback and review: captures of the running window showing the playhead advancing and a
  review landing at the end of a 43.8 s recording.
- Pin control: the request reaches the transport (refused by a TCP port), and the success path
  is a pipeline test with a mock, because this machine has no serial port.

**Proven only by test, never on hardware:** pin pulses on a real UART, 12 Mbaud, USB
re-enumeration, long soaks over hours, macOS and Linux shells.

**Proven only by reasoning:** the dissector memory claims, the MITM latency target, the
segment-compression design.

## What the tool does today

- **Record, replay, tail, assert, yield, repair** on serial ports, TCP client, TCP server, UDP.
- **Six framing modes** (delimiter, COBS, SLIP, Intel HEX, sync-word plus length, idle gap) and
  CRC-8, CRC-16/CCITT-FALSE, CRC-32C.
- **Dissection**: a hand-written C header parser (packed structs, bitfields, enums, arrays,
  endianness), five native packs (CCSDS TM/TC with PUS, CSP v1, Modbus RTU, MAVLink v1/v2,
  schema-less Protobuf), and DWARF symbols with demangling for crash badges.
- **Faults**: bit flips, drops, truncation, corrupted CRC, latency, jitter, seeded and
  reproducible; Lua hooks on the transmit path and on the receive path with decoded fields.
- **Bridges**: passive tap or inline forward, with live transmit rows.
- **Export**: CSV, JSON Lines, Saleae CSV, PCAPNG, from the CLI, from a route, and from the
  ribbon.
- **The window**: frameless shell with a session menu and saved geometry, stream and inspector,
  WebGL telemetry band with stacked rows, state lanes and bit rails, timeline by seconds with
  playback, command forge, fault injector, vault picker, review mode, pin control.
- **A headless HTTP contract**: one JSON snapshot plus two event streams, so the browser page,
  the desktop window and a script see the same state.

## What is absent

- No MAVLink bodies beyond four messages (D-56).
- No session diff (Milestone 4).
- No X/Y/ZMODEM.
- No signed or notarised binaries (D-95; SignPath application is a human step).
- No macOS or Linux desktop build that anyone has run (D-77).
- No Parquet export (deliberate, D-109).
- The vault header's `port_table_offset` is written and never read (see `08-TRAPS.md`).

## Releases and branches

- `main` is the trunk; it is always green when this document was written.
- Tags `v0.1.0` … `v0.8.0`; the release workflow builds seven binaries plus the Windows
  installer and publishes them with `SHA256SUMS.txt`.
- Pushing a tag starting with `v` triggers `.github/workflows/release.yml`.
- Releases are **paused by the user**. `v0.8.0` closed the GUI stretch. Say what you would
  release and ask before tagging.

## The three documents that must stay true

If you change behaviour, these change in the same commit:

1. `specs/NNNN-<title>.md` — new or edited spec, in the format `specs/README.md` defines.
2. `DEFERRED.md` — close the entry you fixed, add the gap you created.
3. `NEXT.md` — move the item you finished out of the plan.

`STATUS.md` and `RELEASE-NOTES.md` change when a stage ends, not on every commit.

## A note on this directory

The handoff documents are a snapshot. `DEFERRED.md`, `NEXT.md` and `STATUS.md` are the live
records. If this directory disagrees with them, they are right and the directory is stale:
`handoff/tools/check.sh` prints the numbers above so you can tell which.
