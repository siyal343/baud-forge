# IMPLEMENTATION

Implementation plan for BaudForge. The design source is
[`specs/ADR & SRS.md`](specs/ADR%20%26%20SRS.md) and the visual design is
[`specs/UI-UX-Guide.md`](specs/UI-UX-Guide.md). Those documents do not change.
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
5. Every subfeature names its GUI surface. A state an engineer can see must be
   visible in the GUI in the same phase or earlier. When a subfeature has no
   user-visible effect, its spec says why.

## Sizes and estimates

Sizes are estimates, not promises. One developer, one working day.

| Label | Effort |
| --- | --- |
| S | 1 day |
| M | 2 to 3 days |
| L | 4 to 5 days |

The week counts in the SRS assume a team of about three. Every estimate in this
file is for **one developer**.

## Scope statement

Phase 1 as the SRS writes it costs about **82 person-days**, which is roughly 16
weeks for one developer. The SRS allows 4 weeks, so it assumes a team or a
narrower first cut.

This plan therefore has two scopes for each backend phase. Both reach a working
product; they differ in what ships first.

| Scope | Content | Estimate |
| --- | --- | --- |
| **A. Full Phase 1** | Every FR block for transport, storage, framing and CLI | ~88 days |
| **B. First cut (recommended)** | One UART path, recording, replay, delimiter/COBS framing, CLI, benchmarks | ~37 days |

Scope B ships a tool a firmware engineer can use every day. It defers hotplug,
port yielding, TCP, SLIP/Intel HEX, mmap compression and the assert language to
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
| G7 | Font and scale policy | Bundle fonts, system fonts, both | Bundle JetBrains Mono and Inter, both OFL, with a system fallback stack. | F2.2.2 |

## UI integration

The guide fixes three things: the visual language, the six-band workbench and
four signature interactions. This section turns them into work, so that every
backend feature has a place on screen.

### Zone ownership

| Zone | Guide element | Backend source | Delivered by |
| --- | --- | --- | --- |
| 1 | Hardware ribbon: port pill, baud, yield button, pin matrix | F1.2.2, F1.2.3, F1.2.6, F1.7 | F2.7 |
| 2 | Left sidebar: ports, schemas, macros | F1.2.4, F1.5.2, F3.2, F3.3 | F2.8 |
| 3A | Stream and hex viewport: Δt, direction, hex, decoded | F1.1.3, F1.3.6, F1.4, F3.1 | F2.3 |
| 3B | Telemetry and DVR scrubber | F1.1.3, F1.3.6 | F2.4 |
| 4 | Right inspector: dissector tree, fault studio | F3.1 to F3.7, F4.3, F4.4 | F2.5, F3.7, F4.9 |
| 5 | Command forge | F1.4.6, F1.5.1 | F2.6 |
| 6 | Telemetry footer: vault, drops, throughput, ELF | F1.1.5, F1.3.3, F3.5, F1.7 | F2.7 |

### GUI surface matrix

Every feature appears once. `none` is a decision, and the spec file must say why.

| Feature | GUI surface | Zone | In |
| --- | --- | --- | --- |
| F1.1 Pipeline | Throughput and consumer lag in the footer | 6 | F2.7.6 |
| F1.2.2 UART | Port pill: device, serial, baud, state color | 1 | F2.7.1 |
| F1.2.3 Pins | Pin matrix pills, click to toggle DTR or RTS | 1 | F2.7.3 |
| F1.2.4 Port match | Sidebar port list with the match result per device | 2 | F2.8.1 |
| F1.2.5 Hotplug | Port pill turns amber, stream shows a gap marker | 1, 3A | F2.7.1 |
| F1.2.6 Yield | Yield button, countdown, dashed flash marker | 1, 3A, 3B | F2.7.4 |
| F1.2.7 TCP and UDP | Sidebar shows the remote endpoint instead of a device | 2 | F2.8.1 |
| F1.3 Vault | Footer: file name, size, dropped-byte counter | 6 | F2.7.6 |
| F1.3.5, F1.3.6 Seek | DVR scrubber and time cursor | 3B | F2.4.6 |
| F1.4 Framing | Framing mode in the port pill, frame rows in the stream | 1, 3A | F2.7.1 |
| F1.4.6 CRC | Per-frame CRC chip, emerald or crimson | 4 | F2.5.4 |
| F1.5.1 Config errors | Error pane with file, line and fix | shell | F2.2.5 |
| F1.5.2 Ports list | Sidebar | 2 | F2.8.1 |
| F1.5.3 Record | Footer record state and vault size | 6 | F2.7.6 |
| F1.5.4 Replay | Mode indicator, scrubber, replay speed | 1, 3B | F2.7.2 |
| F1.5.5 Assert | none: CI and headless only | — | spec file |
| F1.5.6 Yield command | Same button as F1.2.6 | 1 | F2.7.4 |
| F1.6 Benchmarks | none: CI only | — | spec file |
| F1.7 State contract | Feeds every zone | all | F2.1.4 |
| F2.3 Stream | Zone 3A itself | 3A | F2.3 |
| F2.4 Telemetry | Zone 3B itself | 3B | F2.4 |
| F2.5 Inspector | Zone 4, tree and field highlight | 4 | F2.5 |
| F2.6 Command forge | Zone 5 | 5 | F2.6 |
| F2.7 Ribbon and footer | Zones 1 and 6 | 1, 6 | F2.7 |
| F2.8 Sidebar | Zone 2 | 2 | F2.8 |
| F3.2 C struct parser | Schema tree in the sidebar, field tree in the inspector | 2, 4 | F2.8.2, F3.7 |
| F3.3 Protobuf, Kaitai | Schema tree entry with load state | 2 | F2.8.2 |
| F3.4 Native packs | Protocol tag chip per row, decoded tree | 3A, 4 | F2.3.3, F3.7 |
| F3.5 ELF symbolizer | Inline badge in the stream, source popover, IDE open | 3A | F2.9.2 |
| F3.6 defmt, pw_tokenizer | Decoded text in the stream instead of hex | 3A | F2.3.2 |
| F4.1 Passive tap | Two-port stream with MITM direction badges | 3A | F2.3.3 |
| F4.2 Active bridge | Ribbon MITM pill, per-direction counters | 1 | F4.9.1 |
| F4.3 Fault engine | Fault studio toggles with a live armed indicator | 4 | F4.9.2 |
| F4.4 Lua runtime | Script list, hit counter, log pane | 4 | F4.9.3 |
| F4.5 Control plane | none: external clients | — | spec file |
| F4.6 XMODEM | Transfer progress bar in the footer | 6 | F4.9.4 |
| F4.7 Session diff | Diff view with timing drift in amber | new | F4.10 |
| F4.8 Triggers | Trigger flash on the pin pills | 1 | F4.9.5 |

### Guide analysis

The guide covers what a competing product usually misses: a fixed semantic color
map, a keyboard-first zone model, and a link from a byte to its struct field. It
leaves twelve things open. Each one becomes a subfeature or an explicit
non-goal.

| Gap | Decision | Where |
| --- | --- | --- |
| No empty, loading or error state | Every zone gets the three states | F2.2.5 |
| `[[alerts]]` has no surface | Banner strip above the forge plus a toast | F2.7.7 |
| No mode indicator beyond `MITM: ON` | Ribbon shows Live, Replay, Yielded or MITM | F2.7.2 |
| Two ports shown, the ADR allows 64 | Port tabs in zone 3A, overflow list | F2.3.5 |
| Dissector failure has no display | CRC chip, unparsed-tail notice, error pane | F2.5.4 |
| Fault studio appears before Phase 4 exists | Placeholder with an honest disconnected state | F2.5.5 |
| Color alone carries meaning | Every color also gets a label or an icon | F2.2.7 |
| No accessibility section | Focus rings, keyboard-only path, reduced motion, AA contrast | F2.10 |
| No DPI or zoom policy | Token scale driven by a zoom factor, 36 px ribbon scales | F2.1.5 |
| Layout is not persistent | Zone sizes and visibility saved per workspace | F2.1.6 |
| Layout assumes one desktop width | Four width tiers plus short-viewport rules; collapse, never remove | F2.11 |
| Fonts need bundling and a license check | Bundle OFL fonts, system fallback stack | F2.2.2 |
| Hover highlight needs byte-to-field geometry | Hit-test index per row, target under 1 ms | F2.3.6 |

Two non-goals for v1: a light theme, and a phone layout. The workbench reflows
down to 640 px, but it stays a desktop tool with a keyboard and a pointer. The
token file leaves room for both.

### Responsive rule

Guide section 5 fixes the width tiers. The engine does not change with width,
and no column disappears: the layout narrows padding, then collapses a zone to a
rail, a drawer or a tab. Every zone stays reachable at every width.

## Phase 0 — Scaffold (done)

Workspace, crate topology, shared types, config schema, CLI stub, CI for six
targets. See [PLAN.md](PLAN.md).

## Phase 1A — Iron core, full scope

Weeks 1 to 4 in the SRS. Seven features.

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
platform APIs. The estimate for each may double.

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

### F1.7 UI state contract

Owns: `bforge-core`. Depends on: F1.1.5, F1.2.

This feature makes Phase 1 visible. The GUI is not built yet, so the engine
publishes the same state the six zones will draw. The CLI prints it as JSON, so
the contract is tested before any pixel exists.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F1.7.1 | `UiSnapshot`: ports, states, pins, counters, vault, mode, ELF sync | M | Snapshot of a mock session matches a golden JSON file |
| F1.7.2 | Typed event stream: port state, pins, chunk stats, overrun, yield window, alert | M | A subscriber sees every change once, in order |
| F1.7.3 | `bforge status --json` and `--watch` over the same types | S | CLI output and snapshot come from one code path |
| F1.7.4 | Contract test: every zone field in the UI guide has a source | S | Table in the spec file has no empty cell |

**Phase 1A exit criteria:** 4 ports at 12 Mbaud for 10 minutes with 0 dropped
bytes, RSS under 150 MB, `record`, `replay` and `assert` usable from CI, the UI
state contract published, and a presented benchmark table.

## Phase 1B — First cut (recommended)

Same crates, narrower scope. About 37 days.

| Order | Subfeature | Why it is first |
| --- | --- | --- |
| 1 | F1.1.2, F1.1.3, F1.1.4, F1.1.6 | The pipeline is the base of everything |
| 2 | F1.2.2 (UART, no hotplug), F1.2.7 (TCP) | Two transports are enough to test and to use |
| 3 | F1.3.1, F1.3.2, F1.3.3 (plain, no compression), F1.3.6 | Recording and reading a session |
| 4 | F1.4.1, F1.4.2, F1.4.6 | Delimiter, COBS and the three CRCs |
| 5 | F1.5.1, F1.5.2, F1.5.3, F1.5.4 | The usable CLI |
| 6 | F1.7.1, F1.7.2, F1.7.3 | The GUI contract, before any GUI code |
| 7 | F1.6.1, F1.6.2 | Prove the two headline numbers |

Deferred to Phase 1C: F1.2.4, F1.2.5, F1.2.6, F1.3.4, F1.3.5, F1.3.7, F1.4.3,
F1.4.4, F1.4.5, F1.4.7, F1.5.5, F1.5.6, F1.6.3, F1.7.4.

## Phase 2 — GPU terminal (weeks 5 to 8)

Owns: `bforge-gui`, `ui/`. Depends on: F1.7 and F1.3.6.

Eleven features, 61 subfeatures, about **155 days** for one developer. The SRS slot
of four weeks assumes three developers. The exit criteria below decide what
Phase 2B contains if the slot holds.

### F2.1 Desktop host

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.1.1 | Gate G4: pick the frame window transport | M | A 1 MB window crosses in under 8 ms |
| F2.1.2 | Tauri v2 shell: window, dev and prod profiles, single instance | M | `cargo tauri dev` opens the window |
| F2.1.3 | IPC commands: ports, open, write, frame window, event subscribe | M | The UI shows live bytes with no JSON copy |
| F2.1.4 | UI state store fed by the F1.7 event stream | M | Losing a frame in the stream is impossible by test |
| F2.1.5 | DPI and zoom: token scale, 36 px ribbon scales, sharp hairlines | M | 100 and 200 percent both keep 1 px borders |
| F2.1.6 | Layout persistence: zone sizes, visibility and split memory | S | Restart restores the exact layout |
| F2.1.7 | Cold boot timer in CI | S | Interactive window under 400 ms, measured |

### F2.2 Design system and shell

Tokens come from guide section 1. Layout comes from guide section 2.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.2.1 | Tokens: palette, semantic color map, type scale, spacing, hairlines | M | Every guide color and size exists as a named token |
| F2.2.2 | Fonts: bundle JetBrains Mono and Inter (gate G7), fallback stack, ligatures off in hex | S | Renders identically on a machine with no fonts installed |
| F2.2.3 | Zone grid: resizable splits, `Ctrl+1..5` navigation, focus rules | L | Keyboard alone reaches every zone |
| F2.2.4 | Command palette `Ctrl+K` over every action | M | Every menu action is reachable by name |
| F2.2.5 | Empty, loading and error states per zone | M | Config errors show file, line and fix |
| F2.2.6 | Alert surface: banner strip and toasts for `[[alerts]]` | M | Dead-man timer fires a visible alert |
| F2.2.7 | Color-semantics audit: each color pairs with a label or icon | S | Audit test fails when a color stands alone |

### F2.3 Stream and hex viewport

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.3.1 | Row model over the sliding window, 1 M rows | L | Scroll stays smooth at 1 M rows |
| F2.3.2 | Canvas2D ANSI renderer: SGR colors, cursor moves, clear | L | A known escape-sequence fixture renders exactly |
| F2.3.3 | Columns: Δt in µs, direction badge, hex, decoded text, protocol chip | M | RX, TX and MITM use the guide colors |
| F2.3.4 | Follow, pause, search, per-row timestamps | M | Pause holds the window while bytes keep arriving |
| F2.3.5 | Port tabs when more than two ports stream | M | Four ports stream without layout change |
| F2.3.6 | Byte-to-field hit-test index, hover glow, tooltip with bits and endianness | L | Hover answers in under 1 ms per row |
| F2.3.7 | Copy selection as hex, ASCII or escaped text | S | Round trip paste gives the same bytes |

### F2.4 Telemetry and DVR

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.4.1 | Signal registry over the legacy `RingBuffer` | M | 20 signals at 1 kHz keep 60 s of history |
| F2.4.2 | WebGL line plot with decimation | L | 20 signals at 1 kHz render at 60 FPS |
| F2.4.3 | Bitfield state lanes under the plot | M | Flag edges line up with the frames above |
| F2.4.4 | FFT waterfall | M | A known tone lands in the right bin |
| F2.4.5 | 3D orientation widget | M | Euler angles follow the source data |
| F2.4.6 | DVR scrubber and shared clock | M | One drag moves terminal, plot and tree to the same timestamp |
| F2.4.7 | Mode strip: Live, Replay, Yielded; amber drift markers | M | Replay never shows live data |

### F2.5 Right inspector

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.5.1 | Field tree with typed units from `DissectedFrame` | L | Every field in the fixture tree renders |
| F2.5.2 | Two-way highlight: field to hex and hex to field | M | Hover either side glows the other |
| F2.5.3 | Plot-this-field icon on every numeric leaf | S | One click adds a trace with no config |
| F2.5.4 | CRC chip, unparsed-tail notice, decode error pane | M | Bad CRC shows crimson and the byte range |
| F2.5.5 | Fault studio placeholder with a disconnected state | S | No control claims to be armed before Phase 4 |

### F2.6 Command forge

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.6.1 | Typed pill inputs generated from `.bforge.toml` fields | L | Every field type in Part IV round trips |
| F2.6.2 | Live encoded preview: framing, padding, checksum | M | Preview equals the bytes sent, byte for byte |
| F2.6.3 | Automatic CRC choice from the port config | S | The preview updates when a field changes |
| F2.6.4 | Send, hotkey binding, send history | M | `Enter` sends, `Ctrl+Shift+S` runs the macro |
| F2.6.5 | Flow-controlled paste with XON and XOFF | S | A 100 KB paste loses no character |

### F2.7 Ribbon and footer

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.7.1 | Port pill: device, serial, baud, framing, state color | M | State is readable with color removed |
| F2.7.2 | Mode indicator: Live, Replay, Yielded, MITM | S | Only one mode is ever shown |
| F2.7.3 | Pin matrix pills: click toggles DTR or RTS, live CTS, DSR, DCD, BREAK | M | A click changes the voltage on hardware |
| F2.7.4 | Yield button, countdown, dashed flash marker in stream and plot | M | A flash tool can take the port during a session |
| F2.7.5 | Pulse macro menu on right-click of DTR or RTS | M | ESP32 bootloader entry works on hardware |
| F2.7.6 | Footer: vault name and size, dropped counter, throughput, ELF sync | M | Counters match `bforge status --json` |
| F2.7.7 | Alert banner surface shared with F2.2.6 | S | The same alert appears once, not twice |

### F2.8 Left sidebar

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.8.1 | Port list with state and remote endpoint | M | Hotplug changes the row without a refresh |
| F2.8.2 | Schema tree: `.h`, `.proto`, native packs, load state | M | A broken schema shows its error in place |
| F2.8.3 | Macro list with hotkey hints | S | Selecting a macro fills the forge |

### F2.9 Signature interactions

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.9.1 | Byte-to-field twin highlight with bits, endianness and offset | M | Hover shows all three facts |
| F2.9.2 | Inline ELF badge with a 5-line source popover and IDE open | L | Clicking a badge opens the editor at the line |
| F2.9.3 | Flash-yield dimming and reconnect animation | S | Reduced-motion setting removes the animation |

### F2.10 Accessibility and budget

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.10.1 | Focus rings, keyboard path to every action, reduced motion | M | Keyboard-only run completes a record and a send |
| F2.10.2 | Contrast audit of every token pair | S | All pairs meet WCAG AA |
| F2.10.3 | Frame budget overlay in dev builds | S | Any frame over 16.6 ms is visible |
| F2.10.4 | Roles and labels for the six zones | S | Screen reader names each zone |

### F2.11 Responsive layout

Guide section 5. One rule: collapse, never remove. This feature ships with the
zone grid in F2.2.3, not after it, because a fixed grid cannot become fluid later
without rewriting every zone.

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F2.11.1 | Width tiers as tokens, one container query per zone | M | Resize reflows with no reload and no layout jump |
| F2.11.2 | Collapse, never remove: rail, drawer and tab states, `Ctrl+1..5` at every width | L | Keyboard reaches all six zones at 640 px |
| F2.11.3 | Single-column mode under 960 px: ribbon wraps, zones become tabs, forge pins | L | Record, send and scrub work at 800 x 600 |
| F2.11.4 | Short viewport: 60/40 stack below 768 px height, one-line footer, scrubber in the ribbon | M | Ribbon, stream and forge visible at 768 px |
| F2.11.5 | Layout saved per width tier | S | Shrink and grow restores each tier's layout |
| F2.11.6 | Viewport matrix in CI: 8 widths, 2 DPIs, screenshots, overflow and reachability asserts | M | A clipped zone or a scrollbar fails the build |

**Phase 2 exit criteria:** all six zones populated by real Phase 1 data, 60 FPS
with 20 signals at 1 kHz, cold boot under 400 ms, hover highlight under 1 ms, a
keyboard-only path through record, send and scrub, and every zone reachable from
640 px to 3840 px wide.

## Phase 3 — Dissectors and ELF (weeks 9 to 12)

Owns: `bforge-dissect`, `bforge-elf`. Depends on: Phase 1 framing.

| Order | Feature | Subfeatures | Size |
| --- | --- | --- | --- |
| 1 | F3.1 IR executor | Bounds-checked execution, error path, units, throughput test | M |
| 2 | F3.2 C struct parser | `tree-sitter-c` walk, packed structs, bitfields, enums, arrays, endian annotations, golden frames | L |
| 3 | F3.3 Schema loaders | Protobuf through `prost-reflect`; Kaitai runtime | L |
| 4 | F3.4 Native packs | CCSDS 133.0-B-2 and ECSS PUS (L), CSP v1/v2 (M), MAVLink v1/v2 with XML dialects (L), Modbus RTU (S) |
| 5 | F3.5 ELF symbolizer | Load with `gimli` and `object`, file watch with `notify`, address scan in text, editor jump | L |
| 6 | F3.6 Log decoders | `defmt` frames, `pw_tokenizer` strings | M |
| 7 | F3.7 Dissector UI | Replace the F2.5 placeholder: real tree, protocol chips, plot wiring | M |
| 8 | F3.8 Symbol UI wiring | Inline badges live end to end, source popover, sync state in the footer | M |

Every native pack needs a captured fixture file, because the parser is judged on
real frames.

**Phase 3 exit criteria:** a firmware `.h` file alone decodes a live stream, a
crash address turns into a `file:line` badge in the stream, and every native pack
passes its fixture suite.

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

UI features in this phase, one per backend feature:

| ID | Subfeature | Size | Done when |
| --- | --- | --- | --- |
| F4.9.1 | Ribbon MITM pill and per-direction counters | S | Amber shows only while the bridge is armed |
| F4.9.2 | Fault studio: arm BER, CRC corruption, drop, delay, capture by command id | L | Each control maps to one engine field |
| F4.9.3 | Script list, hit counter, script log pane | M | A script hit is visible as it happens |
| F4.9.4 | Transfer progress bar in the footer | S | Progress is monotonic and cancellable |
| F4.9.5 | Trigger flash on the pin pills | S | A pin pulse is visible at the same moment |
| F4.10 | Session diff view: two sessions side by side, drift in amber | M | A timing regression is visible without a report file |

**Phase 4 exit criteria:** pass-through latency at or below 50 µs measured with a
scope, a Lua script mutates a frame and the receiver rejects the bad CRC, a fault
armed in the studio changes the wire, and a diff of two sessions flags a timing
regression on screen.

## Cross-cutting workstreams

| ID | Workstream | Runs during | Content |
| --- | --- | --- | --- |
| C1 | Specs | Always | `specs/NNNN-<title>.md` before each feature, updated with the code |
| C2 | Test layers | Always | Unit, property tests, golden fixtures, mock-transport integration, nightly hardware job |
| C3 | CI | Always | Add fuzz on a schedule, bench job, release artifacts for six targets, MSRV check |
| C4 | Measurement | From Phase 1 | `bench/` with criterion, baseline file, numbers in the job summary |
| C5 | Docs | Always | README upkeep, user guide under `docs/`, CHANGELOG, license files |
| C6 | UI contract | From F1.7 | The state contract is the only path from engine to screen |

## Verification matrix

Every non-functional requirement needs a harness. No harness, no claim.

| Requirement | Target | Harness | Phase |
| --- | --- | --- | --- |
| Ingestion | 12 Mbaud, 4 ports, 0 dropped bytes | Mock PRBS-31 plus optional real loopback | F1.6.1 |
| Memory | 150 MB RSS with a 100 GB file | Replay file plus RSS sampling | F1.6.2 |
| MITM latency | 50 µs | Scope on RX to TX, plus an in-process timer | F4.2 |
| UI frame time | 16.6 ms with 20 signals at 1 kHz | WebGPU profiler overlay | F2.4.2, F2.10.3 |
| Cold boot | 400 ms | CI startup timer | F2.1.7 |
| Hover highlight | 1 ms per row | Hit-test benchmark | F2.3.6 |
| Responsive layout | No overflow, every zone reachable from 640 px to 3840 px | Screenshot matrix at 8 widths and 2 DPIs | F2.11.6 |
| Contrast | WCAG AA on every token pair | Token audit script | F2.10.2 |
| Color semantics | No color without a label or icon | Audit test | F2.2.7 |
| State coverage | Every zone field has a source | Contract table in the F1.7 spec | F1.7.4 |

## Risks

| Risk | Effect | Response |
| --- | --- | --- |
| Hotplug and port match on three platforms | Phase 1 slips by weeks | Isolated in F1.2.4 and F1.2.5, after the recording path works |
| Arbitrary baud and 1.5 stop bits not in `serialport` | FR-HAL-01 unmet | Gate G1 decides before F1.2.2; keep a platform shim path |
| mmap writer and crash safety | Data loss in the vault | F1.3.7 is a first-class subfeature, not a cleanup task |
| Tauri IPC throughput | UI drops frames under burst | Gate G4 measures before the UI work starts |
| Lua sandbox escape | Host compromise | Sandbox test suite, no `os`, no `io`, no `package` |
| Phase 2 is 140 days of work in a 4-week slot | The GUI slips or thins out | Phase 2B cut below; F1.7 keeps the engine usable headless |
| Zones 1, 2 and 4 wait for later phases | Empty panels look broken | Placeholder states in F2.2.5 and F2.5.5, no fake controls |
| Canvas2D hover hit-test cost | Hover feels slow at 1 M rows | Index per row, benchmark in F2.3.6 |
| Font bundling and license | Startup delay or a legal problem | Gate G7, OFL fonts, system fallback |
| Responsive layout added late | Every zone needs a rewrite | F2.11 ships with the grid in F2.2.3 |
| Six-target CI cost | Slow feedback | Lint and test only; release artifacts build on tags |

## Phase 2B — GUI first cut

If the four-week slot holds for three developers, this is the smallest GUI that
still shows every Phase 1 state.

F2.1.1 to F2.1.4, F2.2.1 to F2.2.3, F2.2.5, F2.3.1 to F2.3.4, F2.4.1, F2.4.2,
F2.4.6, F2.5.1, F2.5.2, F2.6.1 to F2.6.3, F2.7.1 to F2.7.4, F2.7.6, F2.9.1,
F2.11.1 to F2.11.3, F2.11.6 and all of F2.10. That is 28 subfeatures, about 74
days, and it defers the sidebar tree, the palette, the FFT, the orientation
widget and the forge history. It does not defer the responsive work or the
accessibility block.

## Next ten working days

Ordered, assuming Scope B.

1. Write `specs/0002-spmc-pipeline.md`: slab pool, queue per consumer, overrun
   policy, timestamps. (S)
2. F1.1.1 gate G0: benchmark `rtrb` against `crossbeam-channel`. (S)
3. F1.1.2 and F1.1.3: slab pool and reader loop, with the mock transport. (M)
4. F1.1.4 and F1.1.5: fan-out and counters. (M)
5. Write `specs/0003-ui-state-contract.md`: the snapshot and the event list from
   F1.7, with the zone table from this file as the checklist. (S)
6. `specs/0004-bflog-container.md`: byte layout of header, chunk and index. (S)
7. F1.3.1 and F1.3.2: header and chunk records with golden tests. (S)
8. F1.3.3: segmented writer with fsync policy. (L)
9. F1.7.1 and F1.7.3: snapshot and `bforge status --json`, so the contract is
   testable before the GUI exists. (M)
10. F1.5.3: `bforge record` end to end over the mock transport, then F1.6.1 to
    publish the first real numbers. (M)
