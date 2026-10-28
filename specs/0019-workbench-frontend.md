# 0019 Workbench frontend

Status: accepted (29 October 2026). First half of Phase 2 (D-01).

## Problem

`bforge serve` published the contract, but the page at `/` was a proof, not a
workbench: three flat sections and no way to read a frame's fields. The stream — the
reason the product exists — was not on screen at all, because the contract carried
no frames.

## Scope

A SolidJS and TypeScript frontend that draws the engine's live stream, decoded
fields and session state, developed in the browser with hot reload. Not in this
stage: the plot band, the command forge, the full inspector, the time scrubber and
the Tauri shell (D-61, D-62).

## Behavior

1. `bforge serve -c <workspace>` publishes frames as `event: frames`, each value a
   JSON array of `TailRow` from spec 0006/0018. The frame and dissector are the ones
   the port config already selects, built by `tail_config`.
2. The vault stays raw. Frames are a second view of the same chunks that go to disk,
   so a schema written later still applies to an old session.
3. `ui/` runs with `npm run dev` against the engine through a Vite proxy, and
   `npm run build` produces the files the Tauri shell will wrap.
4. Eight states are visible: connection, contract, mode, port count, elapsed,
   chunks, payload, and vault size.
5. The inspector highlights the bytes a field came from: hovering a field marks its
   `offset` and `len` in the hex row. That is the first of the four interactions the
   UI guide names, and it needs absolute offsets, which every dissector already
   reports.
6. A frame that failed to decode is marked in the stream and the reason shows in the
   inspector. Nothing is hidden.

## Data

The stream carries `TailRow { port, timestamp_us, delta_us, len, hex, text,
protocol, fields, decode_error }` with `FieldRow { name, offset, len, value }`.
The engine keeps at most 4096 undelivered frames and counts what it drops, so a
browser that stops reading cannot grow the process. The frontend keeps the last 500
in view.

## Measured

A socket simulator at 4000 Hz, one port with the `ImuPacket` C header:

| Figure | Value |
| --- | --- |
| Session served | 258 326 chunks, 11.2 MB, port `open` |
| Frames in view | 120 of 4096 received |
| Frames decoded | `C_STRUCT:ImuPacket`, 9 fields per frame |
| Vault | 19.4 MB, sealed on exit |

Captured in Edge at 1440×860: `docs/screenshots/workbench.png`.

`cargo test -p bforge-core --test serve` also asserts that a subscriber receives
`event: frames` with a port name and fields, so a break in the stream fails CI.

Not measured: rendering cost at high frame rates, because the plot band does not
exist yet.

## Test

```sh
cargo test -p bforge-core --test serve      # the frames event reaches a client
cd ui && npm run build                      # type check, then bundle
bforge serve -c <workspace> & cd ui && npm run dev
```

## Limits, recorded

- The stream is live only; a vault cannot be scrubbed (D-61).
- Five of the six bands are missing: plots, command forge, full inspector, the
  scrubber and the fault injector (D-61).
- No Tauri shell yet: the browser is the host (D-62).
