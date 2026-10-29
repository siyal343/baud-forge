# 0023 Scrubber: the vault in the window

Status: accepted (29 October 2026). Completes the six-band surface.

## Problem

Everything the workbench drew came from the live stream. A session that ended
disappeared from the screen, and during a run there was no way to look at the last
minute. A monitor that forgets what it recorded is only useful in the moment.

## Scope

Read a bounded window of a vault over HTTP, and draw it in the same stream and plot.
Not in this stage: seeking by wall-clock time (only record ordinals), playback of a
window at speed, and a replay of a selection back out of a port (D-68).

## Behavior

1. `bforge serve --vault <path>` makes the recorder's vault readable. Without
   `--vault`, both routes answer `404`.
2. `GET /api/vault` answers `{path, records, bytes, damaged_tail}`, so a scrubber
   knows the range it may ask for.
3. `GET /api/vault/frames?at=<record>&count=<n>` decodes records `at .. at+count`
   with the workspace's framing and dissector, sorts the rows by timestamp and
   answers `{at, count, records, rows}`.
4. `count` is capped at 2000. A window past the end answers `200` with `"rows":[]`,
   not an error.
5. In the workbench a slider picks the record, a `live` button returns to the
   stream, and the plot draws the selected field from the window instead of the live
   series. The stream table shows the window's frames and says so.
6. `?at=<record>` in the page address opens the workbench at that position, so a
   finding can be shared as a link.

## A fault this stage found

A vault could not be read while it was being recorded: `LogWriter` kept its first
64 KiB in a `BufWriter`, so another process opening the file found a 256-byte header
and no records — or, before this change, an empty file. The scrubber depends on the
opposite. The writer now flushes the header at creation and the session flushes after
each pump that moved chunks, so a second reader sees records as they land.

Test: `crates/bforge-storage/tests/vault.rs::a_reader_opens_a_vault_that_is_not_sealed`
writes two records, does not seal, and expects a reader to see both.

## Data

No contract change: the window answers `TailRow` values, the same shape the live
stream uses, so the frontend draws both with one component.

## Measured

Live, against the socket simulator recording to a vault:

```text
GET /api/vault
  {"records":39175,"bytes":1296975,"damaged_tail":false}
GET /api/vault/frames?at=100&count=50
  {"at":100,"count":50,"records":39743,"rows":[…23-byte ImuPacket rows…]}
GET /api/vault/frames?at=99999999&count=5
  {"at":99999999,"count":5,"records":40472,"rows":[]}
```

In the workbench at `?at=200` of 108 704 records: 517 frames from record 200 in the
stream, and `sim.channel` plotted from those 517 samples, min 0, max 31. Captured at
`docs/screenshots/workbench.png`.

## Test

```sh
cargo test -p bforge-storage --test vault     # a live vault is readable
cargo test -p bforge-core --test serve        # info, a window, a past-the-end window
cd ui && npm run build
```

## Limits, recorded

- A seek decodes from the window start, so a frame that straddles the first record
  is lost: one frame per seek, and the stream resynchronises at the next delimiter.
- No time axis: the slider is a record ordinal (D-68).
- The window is not played back or re-transmitted (D-68).
