# IMPLEMENTATION

Implementation plan for BaudForge. The design source is
[`specs/ADR & SRS.md`](specs/ADR%20%26%20SRS.md). That document does not change.
This one does.

Progress lives in [PLAN.md](PLAN.md). This file holds the work breakdown.

## How we work

Work moves in four levels:

```text
phase  ->  feature  ->  subfeature  ->  pull request
```

- **Phase** is one milestone from SRS Part VI. A phase ends with a demo and a
  benchmark run.
- **Feature** is one testable capability. It gets a spec file
  `specs/NNNN-<title>.md` before the code, in the format that
  [`specs/README.md`](specs/README.md) defines.
- **Subfeature** is one pull request. One subfeature has one purpose.
- A pull request is done when four things hold: a test proves the behavior, the
  spec matches the code, `cargo fmt` and `cargo clippy -D warnings` pass, and the
  CI matrix is green.

Rules:

1. One subfeature per branch and per pull request.
2. No pull request merges without a test. Hardware-only behavior gets a mock.
3. A number in a report is a measurement, or it is marked as an estimate.
4. A decision that blocks work becomes a gate (see below), not a debate in chat.

## Sizes and estimates

Sizes are estimates, not promises. One developer, one working day.

| Label | Effort |
| --- | --- |
| S | 1 day |
| M | 2 to 3 days |
| L | 4 to 5 days |

## Scope statement

Phase 1 as the SRS writes it costs about **82 person-days**, which is roughly 16
weeks for one developer. The SRS allows 4 weeks, so it assumes a team or a
narrower first cut.

This plan therefore has two scopes. Both reach a working product; they differ in
what ships first.

| Scope | Content | Estimate |
| --- | --- | --- |
| **A. Full Phase 1** | Every FR block for transport, storage, framing and CLI | ~82 days |
| **B. First cut (recommended)** | One UART path, recording, replay, delimiter/COBS framing, CLI, benchmarks | ~35 days |

Scope B ships a tool a firmware engineer can use every day. It defers hotplug,
port yielding, TCP, SLIDE/Intel HEX, mmap compression and the assert language to
a follow-up. See "Phase 1B" below.

## Decision gates

A gate is a short spike with a written answer. No feature that depends on a gate
starts before that gate closes.

| Gate | Question | Options | Lean | Closes before |
| --- | --- | --- | --- | --- |
| G0 | Fan-out primitive | `rtrb` pair, `crossbeam-channel`, custom SPSC | Two `rtrb` queues, one per consumer. `rtrb` is single-producer single-consumer, so fan-out needs one queue per consumer. Measure first. | F1.1.2 |
| G1 | Serial driver base | `serialport` crate, per-OS shim, both | `serialport` first. It hides arbitrary baud and 1.5 stop bits on some systems, so a shim stays in the design. | F1.2.2 |
| G2 | Vault storage | `memmap2` + `lz4_flex`, `zstd`, plain files | `memmap2` + `lz4_flex`. Both are pure Rust, so CI needs no C toolchain. | F1.3.3 |
| G3 | Assert rule language | TOML subset, YAML, Lua | TOML with binary, regex and timing matchers. Scripting arrives in Phase 4. | F1.5.5 |
| G4 | Frame window over IPC | Tauri raw response, custom protocol, shared memory | Tauri v2 `ipc::Response` with raw bytes. Add shared memory only if measurement demands it. | F2.1.3 |
| G5 | Dissector IR boundary | IR per port, IR per frame, tree diff | One compiled IR per port, executed per frame, output is a plain tree. | F3.1 |
| G6 | Lua flavor | Lua 5.4, Luau | Lua 5.4 through `mlua` with a sandboxed environment. | F4.4 |

## Phase 0 — Scaffold (done)

Workspace, crate topology, shared types, config schema, CLI stub, CI for six
targets. See [PLAN.md](PLAN.md).

## Phase 1A — Iron core, full scope

Weeks 1 to 4 in the SRS. Six features.

### F1.1 Pipeline

Owns: `bforge-core`. Depends on: nothing.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.1.1 | Gate G0: measure both primitives at 1.2 MB/s, 4 producers, 2 consumers | S | Numbers and a decision are in the spec file |
| F1.1.2 | Slab pool: 64 KB `BytesMut` slabs, recycled, zero allocation in the read loop | M | Allocation count stays flat over 10⁶ chunks |
| F1.1.3 | Reader loop: blocking read with timeout, monotonic ns stamp, per-port seq counter | M | A mock source of 1.2 MB/s produces monotonic ids |
| F1.1.4 | Fan-out: one queue per consumer, explicit overrun policy and counter | M | A slow consumer never stalls the reader; overruns are counted |
| F1.1.5 | Pipeline stats: chunks/s, bytes/s, overruns, consumer lag | S | `bforge record` prints the counters at exit |
| F1.1.6 | `MockTransport` with PRBS-31 generator at a set rate | S | A 60-second run yields a known byte count |

Open question for F1.1.4: a full queue must never drop a byte from the disk
logger. The dissector may fall behind. The spec file must state this.

### F1.2 Transport

Owns: `bforge-hal`. Depends on: F1.1.3.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.2.1 | Gate G1: spike the driver base on all three systems | M | Written answer with limits per platform |
| F1.2.2 | UART driver: open, close, read, write, line settings, pin read/write | M | Loopback at 2 Mbaud returns identical bytes |
| F1.2.3 | Pin poll task at 1 kHz for CTS, DSR, DCD, RI | M | Flags change within 1 ms of the pin change |
| F1.2.4 | Port match by USB tuple, with device path fallback | L | Two identical adapters bind by serial, not by order |
| F1.2.5 | Hotplug watch and reconnect within 10 ms | L | Replug during a record session resumes the same port |
| F1.2.6 | Port yield: local IPC, SIGUSR1, auto-reclaim | M | `esptool` flashes while BaudForge holds the port |
| F1.2.7 | TCP client, TCP server, UDP unicast and multicast | M | Record and replay work over TCP with no hardware |

F1.2.4 and F1.2.5 are the highest-risk items in Phase 1. They touch three
platform APIs. Estimate for each may double.

### F1.3 Session vault

Owns: `bforge-storage`. Depends on: F1.1.2.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.3.1 | Header, port descriptor table, config hash | S | Golden file test and a truncated-header test |
| F1.3.2 | Chunk record: fixed header plus payload, endianness fixed | S | Golden bytes test |
| F1.3.3 | Segmented writer: 64 MB pages, rotation, fsync policy (gate G2) | L | 1 GB written, RSS stays under 150 MB |
| F1.3.4 | Compressor thread for sealed segments | M | A sealed segment shrinks and reads back identical |
| F1.3.5 | Sparse index: one entry per 1024 frames, flushed on close and on a timer | M | Seek to a timestamp returns the right frame |
| F1.3.6 | Reader: open, time seek, window of N chunks, zero copy | L | A 100 GB file scrolls with constant memory |
| F1.3.7 | Crash recovery: truncated tail is detected, not fatal | M | `kill -9` during a write keeps the file readable |

### F1.4 Framing and checksums

Owns: `bforge-framer`. Depends on: F1.1.4.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.4.1 | Byte-machine trait: feed bytes, get frames, bounded buffer | S | One trait runs every mode below |
| F1.4.2 | Delimiter and COBS | M | Rule-vector tests from RFC examples |
| F1.4.3 | SLIP (RFC 1055) and Intel HEX | M | Rule-vector tests |
| F1.4.4 | Header plus length: sync word, field offset, width, adjust | M | Frames split across odd boundaries |
| F1.4.5 | Idle-gap split with an injectable clock | S | A fake clock proves the 3.5-character rule |
| F1.4.6 | CRC-8, CRC-16/CCITT-FALSE, CRC-32C and name registry | S | Published check values for `123456789` |
| F1.4.7 | Property tests: random split points give the same frames | M | `proptest` suite green |

### F1.5 Configuration and CLI

Owns: `bforge-core`, `bforge-cli`. Depends on: F1.2, F1.3, F1.4.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.5.1 | Semantic validation: duplicate ids, baud range, unknown names, missing files | S | Each error names the file, the line and the fix |
| F1.5.2 | `bforge ports list`: enumerate devices and show the match result | S | Table shows device, tuple and matched port id |
| F1.5.3 | `bforge record -c file --duration 10s -o run.bflog` | M | Round trip record and inspect |
| F1.5.4 | `bforge replay run.bflog --port X --speed 1.0` | M | Inter-frame gaps match the source within 1 ms |
| F1.5.5 | `bforge assert` with a TOML rule file (gate G3) | L | Exit code 1 on failure, JSON or JUnit output |
| F1.5.6 | `bforge yield --port X --for 30s` | S | Port is free for 30 s, then reclaimed |

### F1.6 Measurement

Owns: `bench/`. Depends on: F1.1, F1.3.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.6.1 | Stress harness: 4 mock ports at 12 Mbaud, PRBS-31, sequence check | M | 0 dropped bytes for 10 minutes |
| F1.6.2 | Memory assertion: RSS ceiling with a 1 GB session | M | Peak RSS is recorded and compared to 150 MB |
| F1.6.3 | Nightly CI job that reports the numbers in the job summary | S | Trend visible per run |

**Phase 1A exit criteria:** 4 ports at 12 Mbaud for 10 minutes with 0 dropped
bytes, RSS under 150 MB, `record`, `replay` and `assert` usable from CI, and a
presented benchmark table.

## Phase 1B — First cut (recommended)

Same crates, narrower scope. About 35 days.

| Order | Subfeature | Why it is first |
| --- | --- | --- |
| 1 | F1.1.2, F1.1.3, F1.1.4, F1.1.6 | The pipeline is the base of everything |
| 2 | F1.2.2 (UART, no hotplug), F1.2.7 (TCP) | Two transports are enough to test and to use |
| 3 | F1.3.1, F1.3.2, F1.3.3 (plain, no compression), F1.3.6 | Recording and reading a session |
| 4 | F1.4.1, F1.4.2, F1.4.6 | Delimiter, COBS and the three CRCs |
| 5 | F1.5.1, F1.5.2, F1.5.3, F1.5.4 | The usable CLI |
| 6 | F1.6.1, F1.6.2 | Prove the two headline numbers |

Deferred to Phase 1C: F1.2.4, F1.2.5, F1.2.6, F1.3.4, F1.3.5, F1.3.7, F1.4.3,
F1.4.4, F1.4.5, F1.4.7, F1.5.5, F1.5.6, F1.6.3.

## Phase 2 — GPU terminal (weeks 5 to 8)

Owns: `bforge-gui`, `ui/`. Depends on: F1.3.6 and F1.5.3.

The visual language, the color tokens, the type scale and the five-zone layout
come from [`specs/UI-UX-Guide.md`](specs/UI-UX-Guide.md). It is the input for
F2.2.1 and for the renderers in F2.3 and F2.4.

### F2.1 Desktop host

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.1.1 | Gate G4: pick the frame window transport | M | A 1 MB window crosses in under 8 ms |
| F2.1.2 | Tauri v2 shell: window, dev and prod profiles, single instance | M | `cargo tauri dev` opens the window |
| F2.1.3 | IPC commands: ports, open, write, frame window, telemetry subscribe | M | The UI shows live bytes with no JSON copy |
| F2.1.4 | Cold boot timer in CI | S | Interactive window under 400 ms, measured |

### F2.2 Frontend base

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.2.1 | SolidJS, Vite, TypeScript, lint and format, tokens from the UI guide | M | `npm ci && npm run build` is green in CI |
| F2.2.2 | App shell: split panes, toolbars, status bar, keyboard map | M | Layout survives a window resize at 60 FPS |

### F2.3 Terminal

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.3.1 | Row model and virtual scroll over the sliding window | L | 1 M rows scroll with no jank |
| F2.3.2 | Canvas2D ANSI renderer: SGR colors, cursor moves, clear | L | A known escape-sequence fixture renders exactly |
| F2.3.3 | Hex and ASCII pane with byte-range selection and copy | M | Selection maps to the same bytes as the tree |
| F2.3.4 | Follow, pause, search, timestamps per row | M | Pause holds the window while bytes keep arriving |

### F2.4 Telemetry

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.4.1 | Signal registry over the legacy `RingBuffer` | M | 20 signals at 1 kHz keep 60 s of history |
| F2.4.2 | WebGL line plot with decimation | L | 20 signals at 1 kHz render at 60 FPS |
| F2.4.3 | FFT waterfall | M | A known tone lands in the right bin |
| F2.4.4 | 3D orientation widget | M | Euler angles follow the source data |
| F2.4.5 | Shared DVR clock and crosshair scrubber | M | One drag moves terminal, plot and tree to the same timestamp |

### F2.5 Command builder

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.5.1 | Field editor from `.bforge.toml` with a live hex preview | M | Every field type in Part IV round trips |
| F2.5.2 | CRC append, hotkeys, DTR and RTS pulse sequencer | M | ESP32 bootloader entry profile works on hardware |
| F2.5.3 | Flow-controlled paste with XON and XOFF | S | A 100 KB paste loses no character |

**Phase 2 exit criteria:** 60 FPS with 20 live signals, cold boot under 400 ms, a
recorded session plays back with a synchronized scrubber, and a command macro
drives a real board.

## Phase 3 — Dissectors and ELF (weeks 9 to 12)

Owns: `bforge-dissect`, `bforge-elf`. Depends on: Phase 1 framing.

| Order | Feature | Subfeatures | Size |
| --- | --- | --- | --- |
| 1 | F3.1 IR executor | Bounds-checked execution, error path, units, throughput test | M |
| 2 | F3.2 C struct parser | `tree-sitter-c` walk, packed structs, bitfields, enums, arrays, endian annotations, golden frames | L |
| 3 | F3.3 Schema loaders | Protobuf through `prost-reflect`; Kaitai runtime | L |
| 4 | F3.4 Native packs | CCSDS 133.0-B-2 and ECSS PUS (L), CSP v1/v2 (M), MAVLink v1/v2 with XML dialects (L), Modbus RTU (S) |
| 5 | F3.5 ELF symbolizer | Load with `gimli` and `object`, file watch with `notify`, address scan in text streams, editor jump | L |
| 6 | F3.6 Log decoders | `defmt` frames, `pw_tokenizer` strings | M |
| 7 | F3.7 Dissector UI | Field tree, field to hex highlight, plot on right-click | M |

Every native pack needs a captured fixture file, because the parser is judged on
real frames.

**Phase 3 exit criteria:** a firmware `.h` file alone decodes a live stream, a
crash address turns into `file:line`, and every native pack passes its fixture
suite.

## Phase 4 — MITM, faults and lab sync (weeks 13 to 16)

Owns: `bforge-script`, `bforge-core`. Depends on: Phase 3 dissectors.

| Order | Feature | Subfeatures | Size |
| --- | --- | --- | --- |
| 1 | F4.1 Passive tap | Merge two RX ports into one timeline, direction tags, interleaved view | M |
| 2 | F4.2 Active bridge | Bidirectional routing, flush rules, latency harness | L |
| 3 | F4.3 Fault engine | BER, drop every N, truncate, CRC corruption, jitter, seeded RNG, per-channel config | M |
| 4 | F4.4 Lua runtime | Sandbox, `bforge` table, `on_mitm_frame`, `dissect`, `repack_and_recalc_crc`, `forward_after_ms`, `trigger_pin` | L |
| 5 | F4.5 Control plane | gRPC over a Unix socket and TCP, pytest client, CI example | L |
| 6 | F4.6 File transfer | XMODEM, YMODEM, ZMODEM send and receive | L |
| 7 | F4.7 Session diff | Normalization rules for counters and addresses, timing regression report | L |
| 8 | F4.8 Triggers | Pin pulse profiles, oscilloscope sync output | M |

**Phase 4 exit criteria:** pass-through latency at or below 50 µs measured with a
scope, a Lua script mutates a frame and the receiver rejects the bad CRC, and a
diff of two sessions flags a timing regression.

## Cross-cutting workstreams

| ID | Workstream | Runs during | Content |
| --- | --- | --- | --- |
| C1 | Specs | Always | `specs/NNNN-<title>.md` before each feature, updated with the code |
| C2 | Test layers | Always | Unit, property tests, golden fixtures, mock-transport integration, nightly hardware job |
| C3 | CI | Always | Add fuzz on a schedule, bench job, release artifacts for six targets, MSRV check |
| C4 | Measurement | From Phase 1 | `bench/` with criterion, baseline file, numbers in the job summary |
| C5 | Docs | Always | README upkeep, user guide under `docs/`, CHANGELOG, license files |

## Verification matrix

Every non-functional requirement needs a harness. No harness, no claim.

| Requirement | Target | Harness | Phase |
| --- | --- | --- | --- |
| Ingestion | 12 Mbaud, 4 ports, 0 dropped bytes | Mock PRBS-31 plus optional real loopback | F1.6.1 |
| Memory | 150 MB RSS with a 100 GB file | Replay file plus RSS sampling | F1.6.2 |
| MITM latency | 50 µs | Scope on RX to TX, plus an in-process timer | F4.2 |
| UI frame time | 16.6 ms with 20 signals at 1 kHz | WebGPU profiler overlay | F2.4.2 |
| Cold boot | 400 ms | CI startup timer | F2.1.4 |

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| Hotplug and port match on three platforms | Phase 1 slips by weeks | Isolated in F1.2.4 and F1.2.5, after the recording path works |
| Arbitrary baud and 1.5 stop bits not in `serialport` | FR-HAL-01 unmet | Gate G1 decides before F1.2.2; keep a platform shim path |
| mmap writer and crash safety | Data loss in the vault | F1.3.7 is a first-class subfeature, not a cleanup task |
| Tauri IPC throughput | UI drops frames under burst | Gate G4 measures before the UI work starts |
| Lua sandbox escape | Host compromise | Sandbox test suite, no `os`, no `io`, no `package` |
| Scope of Phase 1 | 82 days of work in a 4-week slot | Scope B is the recommended first cut |
| Six-target CI cost | Slow feedback | Lint and test only; release artifacts build on tags |

## Next ten working days

Ordered, assuming Scope B.

1. Write `specs/0002-spmc-pipeline.md`: slab pool, queue per consumer, overrun
   policy, timestamps. (S)
2. F1.1.1 gate G0: benchmark `rtrb` against `crossbeam-channel`. (S)
3. F1.1.2 and F1.1.3: slab pool and reader loop, with the mock transport. (M)
4. F1.1.4 and F1.1.5: fan-out and counters. (M)
5. `specs/0003-bflog-container.md`: byte layout of header, chunk and index. (S)
6. F1.3.1 and F1.3.2: header and chunk records with golden tests. (S)
7. F1.3.3: segmented writer with fsync policy. (L)
8. F1.3.6 first part: open and read a window back. (M)
9. F1.5.3: `bforge record` end to end over the mock transport. (M)
10. F1.6.1: the stress harness, then publish the first real numbers. (M)
