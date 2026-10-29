# 0018 Serve the UI contract over HTTP

Status: accepted (29 October 2026). Implements F1.7.2 and unblocks D-01.

## Problem

The window and the engine were the same process, and that process needs a Tauri
build, which needs MSVC. Every change to a panel therefore cost a full desktop build
on one machine. It also meant CI could not see the UI at all: a test could check a
counter but not that it reached a screen.

## Scope

A loopback HTTP server that publishes the F1.7 contract, and one page that draws it.
Not in this stage: the SolidJS workbench with the six bands (the page is a
placeholder, D-60), authentication (loopback only, D-59), and writes (added by spec
0021).

## Behavior

1. `bforge serve -c <workspace>` binds `127.0.0.1:7717` by default, pumps the session
   on one thread, and answers requests on others.
2. `/api/snapshot` returns the current `UiSnapshot` as JSON, exactly the bytes
   `bforge status` prints.
3. `/api/events` is a server-sent event stream: one `snapshot` frame on connect, a
   `snapshot` frame every 200 ms, and a `ui` frame for every `UiEvent` as it happens.
4. `/api/health` reports the service version and the contract version, so a frontend
   can refuse a host it does not understand.
5. `/` serves a page that draws the snapshot and lists the events. It is the visible
   state in this phase, and it is replaced by the real workbench later.
6. `--vault` records while serving, `--duration` stops the server, and `--addr`
   changes the address.

The snapshot is the source of truth. Events are a hint: a client that misses a frame
is corrected by the next snapshot, and a client whose queue is full loses that frame
instead of stalling the pump.

## Data

No new types. The server serializes `UiSnapshot` and `UiEvent` from
`specs/0006-session-and-status.md`; the contract version stays 1.

## Measured

Over a socket simulator on loopback, `serve` was run for 300 s:

- snapshot every 200 ms: 40 `snapshot` frames in an 8 s capture, plus 32 `ui` frames;
- 74 032 chunks, 2.7 MB, port state `open`, 0 overruns;
- accumulated logger-ring wait 2 830 ms over 300 s, which is 0.9 % of the session and
  comes from the 2 ms pump cadence, not from lost data.

The page was captured in Edge headless at 1280×760:
`docs/screenshots/serve-page.png`.

Tests: `crates/bforge-core/tests/serve.rs` binds port 0, runs a socket device, and
checks `/api/health`, `/api/snapshot`, `/`, a 404, that the event stream pushes a
snapshot without being asked, and that the server counted requests and moved data.

## Test

```sh
cargo test -p bforge-core --test serve
bforge serve -c <workspace> --duration 30s
curl -s http://127.0.0.1:7717/api/snapshot
curl -s -N http://127.0.0.1:7717/api/events | head -20
```

## Why no web framework

Four routes and one event stream. A framework would add a dependency tree larger
than this module, and the project's rule is that a dependency must pay for itself in
the first release (ADR-001). The HTTP surface is HTTP/1.1 with `Connection: close`,
which any browser, `curl` and EventSource accept.

## Limits, recorded

- The surface grew a write route in spec 0021; it is loopback only and has no authentication (D-59).
- The page is not the workbench: D-60.
- `GET` and `HEAD` only; anything else answers 405.
