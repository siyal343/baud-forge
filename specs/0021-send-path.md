# 0021 Send path: bytes from the browser to the port

Status: accepted (29 October 2026). Opens the write half of Phase 2.

## Problem

Every surface so far read. A serial tool that cannot answer a device is half a tool:
the command forge and the fault injector both need to put bytes on the wire, and
neither can open a second handle on a port that a reader already owns.

## Scope

One route, one encoder, one form. Not in this stage: typed field pills that encode a
struct from named values (D-64), scripted send sequences, and a record of sends in
the contract (D-65).

## Behavior

1. `POST /api/send` takes `{ "port": "<id>", "hex": "AA 55 03", "crc": "crc32c" }`
   and answers `{ "port": "...", "sent": 7 }`.
2. Hex accepts spaces, colons, commas and `0x` prefixes. An odd number of digits, a
   non-hex character or no bytes is a `400`, never a silent partial send.
3. `crc` is optional: `crc8`, `crc16_ccitt_false` or `crc32c`. The checksum is
   computed over the bytes and appended little endian, which is how these fields
   travel on the wire.
4. An unknown port is a `404`. A reader that has stopped is a `503`. A port that
   refuses the write is a `409` with the transport's message.
5. The **reader thread performs the write**. It owns the transport, so a write from
   another thread would race it — the same race the yield window exists to prevent.
   The request is queued to the reader and answered when it has written the bytes.
6. The forge in the workbench shows the byte count as you type, sends on submit, and
   lists the last six sends with their byte counts.

## Data

No contract change to the snapshot. A send is an action, not session state; the
workbench keeps its own short log (D-65). The request and response are JSON on the
existing HTTP surface.

## Measured

Against a socket device that records what it receives, in
`crates/bforge-core/tests/serve.rs`:

```text
POST {"port":"sim","hex":"AA 55 03"}                 -> 200 {"sent":3}
POST {"port":"sim","hex":"aa5503","crc":"crc32c"}    -> 200 {"sent":7}
POST {"port":"nope","hex":"00"}                       -> 404
POST {"port":"sim","hex":"ABC"}                       -> 400
device received 10 bytes: AA 55 03 | AA 55 03 <crc32c>
```

That last line is the point: the bytes left the browser-facing API, crossed the
reader thread, and arrived at the device in order with the checksum the request
asked for.

Captured in Edge at 1440×900: `docs/screenshots/workbench.png` shows the command
forge band with a hex entry and its byte count.

## Test

```sh
cargo test -p bforge-core --test serve
cd ui && npm run build
curl -X POST -d '{"port":"sim","hex":"AA 55 03","crc":"crc32c"}' \
  http://127.0.0.1:7717/api/send
```

## Why the reader writes

A serial port is exclusive: two writers interleave frames and corrupt both. The
pipeline already has exactly one owner of the transport, so the write path is a
queue into that owner and an answer back. A 2 s wait inside the request keeps a
stuck port from hanging the browser.

## Limits, recorded

- No typed encoding: the bytes are hex (D-64).
- Sends are not in the contract, so a second client cannot see them (D-65).
- No retries and no pacing: a script that needs either is a different feature.
