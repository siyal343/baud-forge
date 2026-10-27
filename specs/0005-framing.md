# 0005 Framing and checksums

Status: accepted (28 October 2026). Implements F1.4.1, F1.4.2, F1.4.6 and
F1.5.1.

## Problem

A serial stream has no message boundaries. Splitting on a delimiter by hand
loses the bytes that arrive between two reads. A decoder that assumes whole
frames also fails on the first real port. Checksums are the only way to tell a
valid frame from a plausible one, and a typo in a checksum name must fail before
the tool starts, not after.

## Scope

The byte-machine contract, delimiter and COBS framing, three checksum engines,
and semantic validation of `.bforge.toml`. Not in this stage: SLIP and Intel HEX
(F1.4.3), sync-word and length framing (F1.4.4), idle-gap framing (F1.4.5),
property tests with a generator (F1.4.7), and the GUI error surface (F2.2.5).

## Behavior

1. A byte machine holds the bytes of an unfinished frame between calls. A frame
   that arrives in two slabs decodes exactly as a frame that arrives in one.
2. Splitting the input at any byte offset gives the same frames. The test walks
   every split point over a four-frame input.
3. A machine reports how many bytes it holds back, so the UI can show an
   incomplete frame and the writer can decide when to flush.
4. `reseed`/`reset` drops partial data after a reconnect or a settings change.
   Without it, half a frame from the old baud rate would join the new stream.
5. An empty frame is not a frame: `\n\n` yields nothing.
6. A frame longer than the limit is dropped and counted, not buffered forever.
   The limit is the only defence against a port that never sends a delimiter.
7. COBS: the zero byte is the block delimiter. An invalid block is counted and
   dropped; it does not desynchronise the next block.
8. A framing mode that this build cannot run returns `FrameError`, so a
   configuration never falls back silently to another mode.
9. Checksums name themselves: `crc8` and `crc8_atm`, `crc16` and
   `crc16_ccitt_false`, `crc32c`. An unknown name is a configuration error.
10. Validation reports a path, not a line, for a semantic problem: a line
    number is not reachable after deserialization. Syntax errors keep the
    parser's line and column.

## Data

Checksums, with the published check value for `123456789`:

| Name | Engine | Polynomial | Init | Check |
| --- | --- | --- | --- | --- |
| `crc8_atm` | CRC-8/ATM | 0x07 | 0x00 | 0xF4 |
| `crc16_ccitt_false` | CRC-16/CCITT-FALSE | 0x1021 | 0xFFFF | 0x29B1 |
| `crc32c` | CRC-32C, Castagnoli | 0x82F63B78 reflected | 0xFFFFFFFF | 0xE3069283 |

Framing modes a configuration may name: `delimiter`, `cobs`, `slip`,
`intel_hex`, `header_length`, `idle_gap`. The last four validate but return
`UnsupportedMode` until F1.4.3 to F1.4.5.

Validation paths: `workspace.name`, `workspace.elf_path`, `ports[i].id`,
`ports[i].baud_rate`, `ports[i].framing.mode`, `ports[i].framing.delimiter`,
`ports[i].framing.crc`, `ports[i].match_vid_pid`, `commands[i].name`,
`commands[i].port`, `commands[i].hotkey`, `commands[i].append_crc`,
`commands[i].fields`, `commands[i].fields[j].name`, `.type`, `.options`,
`alerts[i].name`, `.condition`, `.actions`.

## Test

```sh
cargo test -p bforge-framer -p bforge-core -p bforge-cli
```

Framer, 13 tests:

- `published_check_values`: the three vectors above.
- `names_round_trip_and_reject_typos`, `compute_matches_the_engine_and_the_width`,
  `a_changed_byte_changes_every_checksum`.
- `delimiter_splits_across_calls`, `multi_byte_delimiter_is_removed`,
  `empty_frames_and_overlong_frames_are_dropped`.
- `cobs_decodes_rfc_style_vectors`, `cobs_round_trips_including_the_254_byte_run`,
  `cobs_machine_splits_on_zero_and_decodes`,
  `cobs_machine_counts_an_invalid_block`.
- `every_split_point_gives_the_same_frames`.
- `the_factory_names_only_the_implemented_modes`.

Validation, 14 tests, one per rule plus `the_example_workspace_is_clean` and
`several_problems_arrive_in_document_order`.

CLI, 4 tests: valid file exits 0, a semantic problem exits 1 and names the path,
a syntax error reports the parser message, a missing file exits 1.

S3 demonstration, measured on 28 October 2026:

```text
stream     90616 bytes in, 86616 bytes of frame payload
pipeline   23 chunks, 90616 bytes, 0 overruns, 156.48 MB/s
framing    2000 frames decoded, 86616 bytes out, 0 invalid blocks
checksum   2000 valid, 0 invalid, 3453635 frames/s

2000 of 2000 frames decoded with a valid CRC-32C
```

The stream is built so that every frame contains a zero byte, which forces the
COBS encoder to insert a code byte in the middle. The pipeline feeds the framer
with 4 KB slabs, so most frames cross a slab boundary.

CLI surface:

```text
$ bforge config check crates/bforge-core/examples/cubesat.bforge.toml
crates/bforge-core/examples/cubesat.bforge.toml: ok, 1 port(s), 1 command(s), 1 alert(s)

$ bforge config check bad.toml
bad.toml: ports[0].baud_rate: 1 is outside 110 to 12000000
bad.toml: ports[0].framing.crc: `crc32` is not a checksum; use crc8_atm, crc16_ccitt_false or crc32c
2 problem(s) in bad.toml
```

## Known cost

The checksum engines are bitwise: 8 shifts per byte. At 1.2 MB/s that is about
10 million iterations per second, well inside the target, and the S3 run reached
156 MB/s through framing and CRC together. A table-driven engine is available
later without changing the API.
