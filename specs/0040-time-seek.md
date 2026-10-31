# 0040 Seeking by time

Status: accepted (1 November 2026). Closes D-68 and narrows D-63 to the rails.

## Problem

The scrubber moved by **record number**. A person does not know that the voltage dip was at
record 48 211; they know it was at 12.4 seconds. The UI guide's band 3B calls for a DVR
timeline, and a timeline in seconds over a record slider would be a lie.

## Scope

A time seek in the vault, a span in the contract, and a timeline in seconds. Not in this
stage: a playhead that scrolls both the table and the plot at a chosen rate, bitfield rails,
and stacked plot rows.

## Behavior

1. `LogReader::seek_time(ns)` returns the first record at or after a timestamp. It starts at
   the nearest sparse-index entry that holds a timestamp and walks forward, so a seek costs
   at most one index stride of header reads.
2. `LogReader::last_timestamp_ns()` reads the last record directly. The sparse index holds
   only every stride-th record — a short session has none — so trusting it would report a
   duration of zero.
3. `GET /api/vault` reports `duration_ms`, the recording's span.
4. `GET /api/vault/frames?t_ms=8000&count=400` resolves the time to a record and decodes
   from there. `?at=` still selects a record, which is what an old link used.
5. The scrubber is a timeline in milliseconds: its maximum is `duration_ms`, the label reads
   `15.1 s recorded` or `8.001 s / 15.1 s`, and dragging it loads the window at that time.
6. The span refreshes every three seconds while the window is live, because the recording
   grows while it is being watched.

## Data

No schema change. `LogReader` gained `seek_time` and `last_timestamp_ns`; the vault route
gained `duration_ms`; the frames route gained `t_ms`.

## Measured

```text
GET /api/vault                          -> {records:11349, duration_ms:18577, …}
GET /api/vault/frames?t_ms=8000         -> {at:5032, rows:[{timestamp_us:7998513, …}]}
window capture                          -> the timeline reads "15.1 s recorded"
```

The 8 s request landed within 1.5 ms of the requested time, which is the record boundary: a
record carries the timestamp of the bytes that completed it.

## Test

```sh
cargo test -p bforge-storage --test vault    # a_time_seek_lands_on_the_first_record_at_or_after_it
cargo test -p bforge-core --test serve       # a_vault_window_can_be_seeked_by_time
cd ui && npm run build
```

The storage test pins the boundary cases: exactly on a record, between two records, before
the first, and past the end (which answers the last record so a slider stays usable).

## Limits, recorded

- Dragging seeks; it does not play. A playhead that advances on its own is not built.
- The plot and the table show the window around the requested time; there is no cursor
  pinned to that exact microsecond across both.
- `?at=` keeps its name but now means milliseconds, because the slider's unit changed. A
  bookmarked record number will land somewhere else.
