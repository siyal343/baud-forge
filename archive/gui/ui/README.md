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

The fault injector sits beside it (spec 0022): pick a kind, set the amount and arm.
The send response reports `fault_bytes`, so the corruption is visible in the answer:

```sh
curl -X POST -d '{"port":"sim","kind":"bit_flip","flip_rate":1.0,"seed":7}' \
  http://127.0.0.1:7717/api/fault
```

## Bridges

A workspace may join two ports (spec 0025). The ribbon shows `tap obc↔eps` for a
passive pair or `bridge obc↔eps 12 kB` when bytes are being forwarded:

```toml
[[bridges]]
id = "link"
a = "obc"
b = "eps"
forward = true
```

## Crash badges

When the workspace names `elf_path`, addresses in decoded frames resolve to a function
and a source line (spec 0024). The `crash` column shows `field file:line`, and the
inspector lists each address with its source. Names arrive mangled (D-44), so the
location is the readable part.

## Looking back

With `bforge serve --vault session.bflog`, the slider above the plot reads a decoded
window from the vault (spec 0023). `live` returns to the stream, and `?at=<record>` in
the address opens the workbench at that position, which makes a finding shareable as a
link.

## What is missing

The six bands exist in some form: ribbon, ports, stream, plot, forge with faults,
inspector and footer, plus the scrubber. What is thinner than the guide: the inspector
is a flat field list (D-69), the plot is SVG with one series (D-63), there is no Tauri
shell (D-62), and the scrubber seeks by record, not time (D-68).

## Style rules

Color carries state only: emerald for valid and connected, cyan for transmit and
selection, amber for yield and drift, crimson for faults. Every color also has a
label, so the display works for a color-blind engineer. Monospace everywhere, because
the content is numbers and identifiers.
