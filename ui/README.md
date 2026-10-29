# BaudForge workbench frontend

SolidJS and TypeScript, built with Vite. It draws the engine's contract: the session,
the ports, the live frames and their decoded fields. The engine publishes that
contract over loopback HTTP (spec 0018, 0019).

## Two terminals

```sh
# 1. the engine, from the repository root
bforge serve -c <workspace> --vault session.bflog

# 2. the workbench
cd ui
npm install
npm run dev
```

Open <http://localhost:5180/>. Vite proxies `/api` to `127.0.0.1:7717`, so there is
one origin and no CORS.

No hardware:

```sh
cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9100 4000
```

Point a port at `127.0.0.1:9100` with `transport = "tcp-client"`, `mode = "cobs"`
framing, and the `ImuPacket` fixture as the dissector. Start the simulator first:
the reader has a reconnect budget, and a port that was never there spends it.

## Scripts

| Command | Effect |
| --- | --- |
| `npm run dev` | dev server with hot reload on port 5180 |
| `npm run build` | type check, then `dist/` for the shell to wrap |
| `npm run preview` | serve `dist/` locally |

## Layout

```text
src/
  App.tsx          ribbon, ports, stream, inspector, footer
  index.css        one theme, no CSS framework
  lib/types.ts     the wire types of the contract
  lib/feed.ts      one EventSource: snapshot, ui events, frames
```

The snapshot is the source of truth and the events are a hint. The frame list is a
bounded window; the engine bounds its own queue at 4096 and counts what it drops.

## Sending bytes

The command forge posts hex to `/api/send`. The reader thread performs the write and
the engine appends the checksum you pick (spec 0021):

```sh
curl -X POST -d '{"port":"sim","hex":"AA 55 03","crc":"crc32c"}' \
  http://127.0.0.1:7717/api/send
```

Typed field entry is not there yet (D-64); the form takes hex and shows its length.

## What is missing

Five of the six bands in `specs/UI-UX-Guide.md`: plots, command forge, full
inspector, time scrubber and fault injector. No Tauri shell yet. See D-61 and D-62
in `DEFERRED.md`.

## Style rules

Color carries state only: emerald for valid and connected, cyan for transmit and
selection, amber for yield and drift, crimson for faults. Every color also has a
label, so the display works for a color-blind engineer. Monospace everywhere, because
the content is numbers and identifiers.
