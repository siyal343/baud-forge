# 02 — Architecture

## The nine crates

Dependencies point downward only. Nothing in a lower crate knows about a higher one.

```text
bforge-cli ─┬─ bforge-core ─┬─ bforge-hal      transports: UART, TCP, UDP, mock
bforge-gui ─┘               ├─ bforge-storage  vault: format, writer, reader, index, export
                            ├─ bforge-framer   six framing modes, checksums
                            ├─ bforge-dissect  C header IR, executor, five packs, encoder
                            ├─ bforge-elf      DWARF symbols
                            └─ bforge-script   Lua on transmit and receive
```

| Crate | Responsibility | Do not put here |
| --- | --- | --- |
| `bforge-hal` | The `TransportDriver` trait and four implementations | Anything about frames, records or UI |
| `bforge-storage` | `.bflog` bytes: header, records, sparse index, repair, export | Session logic, decoding |
| `bforge-framer` | Turn a byte stream into frames: delimiter, COBS, SLIP, Intel HEX, sync+length, idle gap; checksums | Protocol meaning |
| `bforge-dissect` | C header → IR → decoded fields; native packs; the encoder that builds frames from typed values | Sockets, threads, time |
| `bforge-elf` | ELF sections, DWARF lookup, symbol scan, demangling | Anything frame-shaped |
| `bforge-script` | A sandboxed Lua runtime with an instruction budget | I/O, threads, time |
| `bforge-core` | The engine: session, pipeline, faults, bridges, tail, contract (`ui.rs`), serve, assert, symbols | Platform dialogs, HTML |
| `bforge-cli` | Argument parsing and the commands: config, ports, record, replay, status, serve, tail, assert, export, vault (info, repair), yield | Logic that belongs in core |
| `bforge-gui` | Tauri shell around the same HTTP contract; the bundled frontend lives in `ui/` | Anything the browser page cannot also do |

## The data path

One direction, one owner per stage. Every arrow is a place where a change must be made
deliberately.

```text
transport.read_slab()                 bforge-hal
  → reader thread                    bforge-core/src/pipeline.rs  (owns the transport)
  → ring buffer (SPMC)               bforge-core/src/slab.rs
  → pump_once()                      bforge-core/src/session.rs
      ├→ vault writer                bforge-storage/src/writer.rs
      ├→ bridge forward              Session::forward → other port's outbox
      ├→ framing + decode            bforge-framer, bforge-dissect (via Session::streams)
      ├→ frames queue                Session::push_frame → take_frames()
      └→ series sampling             bforge-core/src/series.rs
  → serve loop                       bforge-core/src/serve.rs
      ├→ SSE "frames" batches        every 50 ms
      ├→ SSE "ui" events             on change only
      ├→ SSE "snapshot" + "series"   every 500 ms
      └→ HTTP routes                 /api/health, /api/snapshot, /api/vault,
                                     /api/vault/frames, /api/vault/export,
                                     /api/send, /api/pins, /api/yield, /api/fault
  → frontend                         ui/src/App.tsx, ui/src/lib/feed.ts
```

Rules that hold along this path:

- **One writer per transport.** The reader thread owns the `TransportDriver`. Writes, pin
  changes and yields are requests over channels, never direct calls.
- **The vault is the truth; the stream is a sample.** A batch a client did not read is replaced
  and counted (`Shared::sampled`), and the UI says so.
- **Decoding is optional.** A session runs with no ports config and still records; a review runs
  with no writer and still shows.

## The contract

`crates/bforge-core/src/ui.rs` is the single description of what a client sees:
`UiSnapshot`, `PortView`, `PinsView`, `BridgeView`, `SessionView`, `UiEvent`, `CONTRACT_VERSION`.

- Change it in one place and both clients follow: the desktop window and the served page load
  the same frontend.
- `tests/contract.rs` asserts the JSON shape. If you add a field, add it there.
- `TailRow` in `crates/bforge-core/src/tail.rs` is the row the stream shows; it is serialised
  straight to clients.

## The seams you will extend

| Seam | Where | How to add |
| --- | --- | --- |
| A protocol pack | `crates/bforge-dissect/src/packs/` | New module, `Pack` variant, `from_name`/`name`/`tag`/`decode`, `PACK_NAMES`; unit tests with hand-built fixtures |
| A framing mode | `crates/bforge-framer/src/` | New module implementing the framing trait, wire it into `machine.rs` and the config enum |
| An export format | `crates/bforge-storage/src/export.rs` | Match arm in `export()`, `format_extension`, `FORMAT_NAMES`, route content type, ribbon option |
| A fault primitive | `crates/bforge-core/src/fault.rs` | New `FaultProfile` field, apply in `apply()`, a seeded test |
| A UI surface | `ui/src/App.tsx` + `ui/src/index.css` | Read the contract, do not add a fetch the server does not serve |
| A CLI command | `crates/bforge-cli/src/main.rs` | `Some("name") => fn`, usage text, an integration test in `tests/cli.rs` |

## The vault format

`crates/bforge-storage/src/format.rs` is the authority; the doc comment carries the byte layout.

```text
0..256         file header: magic BFLG\x01\0, session id, start epoch, config hash,
               port_table_offset (written as 256, never read — see 08-TRAPS.md)
256..          records, back to back:
               0..8 seq u64 | 8..16 timestamp ns u64 | 16..18 port u16 | 18 direction u8
               19..21 line state u16 | 24..28 payload len u32, then the payload
               one index entry every 1024 records, in <name>.bflog.bfidx
```

`LogReader` has two read shapes and they are not interchangeable:

- `read_at` / `window` — seek to a frame id or a time, for a scrubber that jumps.
- `for_each` — walk forward with no per-record seek, for a whole-file pass such as export.

Using the first where the second belongs costs about a factor of two.

## The frontend

- SolidJS, no router, one page: `ui/src/App.tsx` plus `ui/src/lib/feed.ts` (SSE + snapshot) and
  `ui/src/lib/shell.ts` (engine base URL and Tauri `invoke`).
- `ui/public/desktop.html` is the picker page the desktop shell opens first.
- The desktop shell loads `index.html?api=http://127.0.0.1:PORT&v=<nonce>`; the nonce defeats
  webview caching, which has already cost a debugging session.
- The telemetry band is `ui/src/components/Telemetry.tsx` with `ui/src/lib/webgl.ts`; it falls
  back to canvas where WebGL is absent.

## Where the risk lives

Ranked by "how much would break if you got it wrong":

1. **`session.rs::pump_once`** — every feature joins here. A wrong budget starves the vault or
   the UI.
2. **`serve.rs` backpressure** — a client that stops reading must never stall the pump.
3. **`pipeline.rs` reader thread** — reconnect, yield and pulse all take the transport away from
   the read loop.
4. **`format.rs`** — a byte-level change breaks every existing vault and the reader's
   assumptions about record length.
5. **The contract** — a renamed JSON field silently breaks one of the two clients.
