# 0006 Session and the UI state contract

Status: accepted (28 October 2026). Implements F1.5.3, F1.5.4, F1.7.1, F1.7.2
and F1.7.3.

## Problem

A recorder needs three things at once: bytes on disk, counters a person can read,
and a state the future window can draw. If each of those grows its own code path,
the number on screen and the number in CI drift apart. The headless tool also has
to send a recorded session back out without changing the gaps between chunks,
because that is how a captured command sequence is reused.

## Scope

`bforge record`, `bforge replay`, `bforge ports list`, `bforge status`, and the
snapshot and event types behind them. Not in this stage: recording through the
framing stage (S5), the yield window (F1.2.6), the diff engine (F4.7) and the
GUI (Phase 2).

## Behavior

1. A session owns one pipeline per port and one writer. The caller pumps it:
   `pump_once` moves whatever is ready into the vault. No second thread sits
   between the ring and the disk at this stage.
2. A recorder starts one consumer per port. The framing consumer joins in S5, so
   a recording session reports zero overruns by construction.
3. `record` runs for `--duration`, or until Enter when no duration is given.
   `--port` limits the session to named ports.
4. `record --json` prints the final snapshot; `--watch` prints one JSON line per
   event while recording.
5. `status` runs a short session with no vault and prints the snapshot. It is a
   probe, not a daemon: the window arrives in Phase 2.
6. `replay` sends every record in file order, sleeping until each record's
   original timestamp divided by `--speed`. Lateness is measured, not hidden.
7. The event bus remembers the last event and hands it to a new subscriber, so a
   client that attaches after `Started` still receives it.
8. A snapshot is the truth; events are a hint. A slow subscriber is dropped from
   the bus rather than allowed to stall the publisher.

## Data

Contract version 1. Every field name below is part of the contract.

```text
UiSnapshot
  contract: 1
  session: mode, vault, file_bytes, chunks, payload_bytes, elapsed_ms,
           started_epoch_ns, elf
  ports[]: id, device, baud_rate, framing, checksum, state, pins, chunks,
           bytes, overruns, stalls_ms, read_errors

PinsView: cts, dsr, dcd, ri, break_state, framing_error, parity_error

UiEvent, tagged by "event":
  started   { at_ms, ports, vault }
  stats     { at_ms, chunks, payload_bytes, overruns, chunks_per_sec }
  overrun   { at_ms, port, total }
  damaged_tail { at_ms, port }
  stopped   { at_ms, chunks, payload_bytes }
```

`state` is one of `closed`, `open`, `reconnecting`, `yielded`. `mode` is one of
`idle`, `record`, `replay`. DTR and RTS are outputs and join the view with
F1.2.3.

One correction this stage forced: the vault seek key is the record ordinal in
file order, not the chunk sequence, because every port starts its own sequence at
zero. See `specs/0003-bflog-container.md` and the storage test that holds it.

## Test

```sh
cargo test -p bforge-core --test session
cargo test -p bforge-cli --test cli
```

Core, 7 tests: two ports recorded and read back byte for byte; a session without
a vault writes nothing; the event stream starts with `Started` and ends with
`Stopped`; the bus delivers to every subscriber and drops a closed one; the
snapshot serializes with the field names above; replay sends every record; replay
at speed 2 keeps about half the original gaps.

CLI, 6 tests: the ports table, a missing `-c`, an unbindable device for `record`
and for `status`, a missing vault for `replay`, and a missing `-c` for `status`.

Hardware run, 28 October 2026, ESP32-C3 on COM8 at 115 200 baud:

```text
$ bforge ports list -c esp32c3.toml
device     vid:pid    serial               workspace port     state
COM8       303a:1001  30:ED:A0:5B:0C:84    esp32              bound
COM4       -          -                    -                  -
COM3       -          -                    -                  -

$ bforge status -c esp32c3.toml --duration 1s
{ "contract": 1, "session": { "mode": "record", "chunks": 33, "payload_bytes": 846, ... },
  "ports": [ { "id": "esp32", "device": "COM8", "state": "open", "chunks": 33, ... } ] }

$ bforge record -c esp32c3.toml -o target/s4-COM8.bflog --duration 3s
recording 1 port(s) into target/s4-COM8.bflog
   1.0s  33 chunks  0.00 MB
   2.0s  61 chunks  0.00 MB
sealed target/s4-COM8.bflog: 89 chunks, 1733 bytes in 3.00 s (578 B/s), 1 segment(s)

$ bforge status -c esp32c3.toml --duration 1200ms --watch
{"event":"started","at_ms":0,"ports":1,"vault":""}
{"event":"stats","at_ms":251,"chunks":11,"payload_bytes":309,"overruns":0,"chunks_per_sec":43}
{"event":"stats","at_ms":501,"chunks":15,"payload_bytes":367,"overruns":0,"chunks_per_sec":15}

$ bforge replay target/s4-COM8.bflog --to COM8 --speed 4
replaying target/s4-COM8.bflog: 89 chunks at speed 4
sent 89 chunks, 1733 bytes in 0.73 s, worst lateness 2.3 ms
```

The 89 chunks for 1 733 bytes repeat the S2 finding: a UART read returns small
fragments, and the 32-byte record header is then a large share of the file.
Coalescing is still owned by F1.4.5.

## Known gap

`record` without `--duration` stops on Enter. A Ctrl-C leaves the vault unsealed;
the reader still opens it and reports `damaged_tail`, which is the recovery path
until F1.3.7 adds a signal handler and a final flush.
