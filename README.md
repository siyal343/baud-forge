# BAUDFORGE

[![CI](https://github.com/siyal343/baud-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/siyal343/baud-forge/actions/workflows/ci.yml)

**Forge, Frame, Fault-Inject.**

BaudForge is a serial monitor, a protocol dissector and a fault-injection rig in
one tool. It records every byte a device sends. It decodes those bytes with the
C structs from the firmware. It can sit between two devices and inject bit
errors, delays and truncation into a live link.

Binary name: `bforge`.

## Status: scaffold only

This repository holds the project skeleton. It defines the crate topology, the
data types and the configuration schema from the
[ADR and SRS](specs/ADR%20%26%20SRS.md). It does not implement recording,
framing, dissection or the GUI yet. The implementation plan comes next.

What works today:

- The Cargo workspace builds, with the nine crates from the architecture.
- `.bforge.toml` parses into typed structs.
- `bforge help` and `bforge version` run.
- The telemetry core inherited from porti-rs stays available as `legacy`.

## Platforms

| Target | Triple | CI coverage |
| --- | --- | --- |
| Linux x86_64 | `x86_64-unknown-linux-gnu` | build and test, `ubuntu-latest` |
| Linux aarch64 | `aarch64-unknown-linux-gnu` | build and test, `ubuntu-24.04-arm` |
| macOS Apple Silicon | `aarch64-apple-darwin` | build and test, `macos-latest` |
| macOS Intel | `x86_64-apple-darwin` | cross-build, `macos-latest` |
| Windows x86_64 | `x86_64-pc-windows-msvc` | build and test, `windows-latest` |
| Windows ARM64 | `aarch64-pc-windows-msvc` | build and test, `windows-11-arm` |

No crate contains target-specific code yet. Every crate is pure Rust, so one
build covers all six targets.

## Why it exists

Serial monitors built on Electron drop bytes when an MCU prints in a loop at
4 Mbaud. BaudForge separates the byte path from the display path, so no byte is
lost and no frame is dropped.

| Target | Value | Verified by |
| --- | --- | --- |
| Sustained ingestion | 12 Mbaud on 4 ports, 0 dropped bytes | PRBS-31 loopback with sequence counters |
| Memory use | 150 MB or less with a 100 GB session | 72-hour soak test, `heaptrack` |
| MITM pass-through latency | 50 µs or less | Oscilloscope, RX of port A to TX of port B |
| UI frame time | 16.6 ms or less with 20 signals at 1 kHz | WebGPU frame profiler |
| Cold boot | 400 ms or less to an interactive window | CI startup timer |

These are target values from the ADR. No value is measured yet.

## Architecture

Four decisions drive the code.

1. **Rust core, Tauri v2 desktop host (ADR-001).** The engine has no garbage
   collector, so the I/O thread stays deterministic. The same static library
   powers the GUI and the headless CLI.
2. **Three-stage ring-buffer pipeline (ADR-002).** An OS thread reads the port
   into 64 KB slabs. A lock-free single-producer multi-consumer queue fans the
   slabs out to a disk logger and a frame dissector. The session goes to a
   memory-mapped `.bflog` file. The UI reads a small window over binary IPC and
   never holds the full log.
3. **Declarative dissection (ADR-003).** C packed structs, Protobuf and Kaitai
   schemas compile into one intermediate representation. Native packs cover
   CCSDS, ECSS PUS, CSP, MAVLink and Modbus. A DWARF symbolizer turns raw
   addresses into `file:line` badges.
4. **Embedded Lua fault runtime (ADR-004).** A sandboxed Lua VM intercepts a
   frame inside the Rust thread in microseconds. An external pytest suite drives
   the same pipeline over gRPC or a Unix domain socket.

### Pipeline

```text
port  ->  reader thread  ->  64 KB slab  ->  SPMC fan-out
                                                |
                              +-----------------+-----------------+
                              |                                   |
                       disk logger                          frame dissector
                       (.bflog vault)                       (framer, IR)
                              |                                   |
                              +------------- UI window ------------+
                                        (binary IPC)
```

## Workspace layout

| Path | Crate | Owns |
| --- | --- | --- |
| `crates/bforge-hal` | `bforge-hal` | `TransportDriver`, UART line settings, USB tuple match, pin flags |
| `crates/bforge-storage` | `bforge-storage` | `.bflog` header, `RawChunk`, sparse index, export formats |
| `crates/bforge-framer` | `bforge-framer` | Delimiter, COBS, SLIP, sync-word and idle-gap rules, checksums |
| `crates/bforge-dissect` | `bforge-dissect` | C header parser, `DissectorIr`, decoded field tree, CCSDS with PUS, CSP and Modbus packs |
| `crates/bforge-elf` | `bforge-elf` | `Symbolizer`, DWARF lookup, defmt and pw_tokenizer decoding |
| `crates/bforge-script` | `bforge-script` | Fault profile, MITM bridge mode, Lua hook contract |
| `crates/bforge-core` | `bforge-core` | `.bforge.toml` schema, coordinator, control plane |
| `crates/bforge-cli` | `bforge-cli` | Binary `bforge` for CI and HIL runners |
| `crates/bforge-gui` | `bforge-gui` | Tauri v2 host for the `ui/` frontend |
| `src/legacy/` | `baud-forge` | Telemetry core from porti-rs: frame, group, dataset, alarm band, ring buffer, running statistics |
| `firmware/bforge_test` | — | ESP32-C3 test instrument: four streaming modes, fault commands, sequence counters |
| `specs/` | — | [ADR and SRS](specs/ADR%20%26%20SRS.md) |

The frontend directory `ui/` (SolidJS, TypeScript, WebGPU) arrives in
Milestone 2.

### Legacy code

The root crate keeps the code inherited from
[porti-rs](https://github.com/siyal343/porti-rs). These types are in use and
stay:

- `legacy::core::frame`: `Frame`, `Group`, `Dataset`, `AlarmBand`,
  `AlarmSeverity`, `WidgetType`
- `legacy::core::ring_buffer`: `RingBuffer<T>`
- `legacy::core::stats`: `RunningStats`

New code goes in `crates/`. The legacy module does not import new crates, so a
change in one side cannot break the other.

## Workspace configuration

Each project commits one `.bforge.toml` file. Every engineer on the project then
uses the same ports, dissectors, command buttons and alerts.

See [`crates/bforge-core/examples/cubesat.bforge.toml`](crates/bforge-core/examples/cubesat.bforge.toml)
for a full example. A short form:

```toml
[workspace]
name = "CubeSat-OBC-Validation"
version = "1.0"
elf_path = "./firmware/build/obc_flight_sw.elf"
watch_elf = true

[[ports]]
id = "obc_telemetry"
match_vid_pid = "0403:6010"
match_serial = "FT5X9A1B"
baud_rate = 2000000
framing = { mode = "cobs", delimiter = 0x00, crc = "crc32c" }
dissector = { type = "c_header", file = "./firmware/include/telemetry_packets.h", root_struct = "ObcTelemetryFrame" }
yield_on_sigusr1 = true

[[commands]]
name = "Inject Safe-Mode Transition"
hotkey = "Ctrl+Shift+S"
port = "obc_telemetry"
append_crc = "crc16_ccitt_false"
fields = [
  { name = "sync", type = "u16_be", default = 0xCAFE },
  { name = "opcode", type = "u8", default = 0x09 },
  { name = "reason_code", type = "enum", options = { MANUAL = 1, THERMAL_FAULT = 2, RAD_SEU = 3 } },
  { name = "hold_time_sec", type = "u32_le", default = 300 }
]
```

`ports` binds a device by USB tuple, with the OS device path as fallback. A port
can also name a socket transport (`tcp-client`, `tcp-server`, `udp`) and an
`address`, which is how a simulator or a radio link reaches the same pipeline.
`commands` builds a frame from named fields and appends the checksum.
`alerts` runs a condition against the live stream and fires actions, such as a
pin pulse or a webhook.

## GUI workbench

The desktop window follows [`specs/UI-UX-Guide.md`](specs/UI-UX-Guide.md). Six
bands fill one screen, with no modal dialogs.

| Band | Content |
| --- | --- |
| 1. Hardware ribbon | Port pill, baud, yield button, live pin matrix |
| 2. Left sidebar | Connected ports, loaded schemas, saved macros |
| 3A. Stream and hex | Δt in µs, direction, hex, decoded text and inline badges |
| 3B. Telemetry and DVR | WebGL plots, state lanes, time scrubber |
| 4. Right inspector | Dissector tree and fault injector |
| 5. Command forge | Typed field pills with a live encoded preview |
| 6. Telemetry footer | Vault size, dropped bytes, throughput, ELF sync |

Four interactions define the product: byte-to-field highlighting in both
directions, plot-this-field on every numeric leaf, inline ELF crash badges with
a source popover, and a visible flash-yield handover.

Color carries state only: emerald for valid and connected, cyan for transmit and
selection, amber for yield and drift, crimson for faults. Every color also gets
a label or an icon, so the display works for a color-blind engineer.

One rule ties the engine to the screen: **every state an engineer can see has a
GUI surface in the same phase or earlier.** The engine publishes that state
through one contract, so the CLI can print it as JSON and the GUI draws it.

The workbench is responsive. Four width tiers cover 3840 px down to a 640 px
window: full workbench, dense workbench, two-zone workbench and single column.
A zone collapses to a rail, a drawer or a tab, but it never disappears, and
`Ctrl+1..5` reaches every zone at every size. Below 768 px of height the stream
and the plot stack instead of clipping.

## Build

Clone the repository first:

```sh
git clone https://github.com/siyal343/baud-forge.git
cd baud-forge
```

Then build from the root of the workspace:

```sh
cargo build --workspace     # all crates
cargo test --workspace      # unit tests
cargo fmt --all --check     # formatting, as CI runs it
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p bforge-cli -- version
cargo run                   # legacy binary
```

Requirements: Rust 1.85 or newer, because the crates use edition 2024.

On Windows, the default toolchain needs the MSVC linker from Visual Studio Build
Tools. When that linker is absent, build with the GNU toolchain instead:

```sh
rustup toolchain install stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build --workspace
```

## Roadmap

| Milestone | Weeks | Content |
| --- | --- | --- |
| 1. Iron core | 1–4 | SPMC ring buffer, `.bflog` writer, hotplug match, port yielding, headless record and replay |
| 2. GPU terminal | 5–8 | Tauri v2 host, SolidJS UI, virtualized hex and ANSI viewport, 60 FPS plots, time scrubber |
| 3. Dissectors | 9–12 | C struct parser, Protobuf, native packs, DWARF symbolizer, defmt decoding |
| 4. MITM and faults | 13–16 | Active bridge, bit-error generator, Lua runtime, session diff, hardware triggers |

Work breakdown by phase, feature and subfeature: [IMPLEMENTATION.md](IMPLEMENTATION.md).
A one-page plan sheet in Apollo handbook style: [docs/handbook/baudforge-plan.pdf](docs/handbook/baudforge-plan.pdf).
Progress notes: [PLAN.md](PLAN.md).

## Continuous integration

The workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on
every push to `main`, on every pull request and on demand. It has three jobs:

- `lint` checks the format with `cargo fmt --check` and the lints with
  `cargo clippy -D warnings`.
- `test` builds and tests on five native runners, then runs the headless CLI.
- `macos-intel` cross-builds the `x86_64-apple-darwin` target, because GitHub
  no longer hosts an Intel macOS runner.

Every green run also builds the release binary and uploads it as an artifact named
`bforge-<platform>`. A tag `v*` starts `.github/workflows/release.yml`, which
builds all six targets and publishes them as a GitHub release.

The repository is public. The workflow needs no secret, and a fork runs the same
checks without setup.

## License

Dual licensed under MIT or Apache-2.0, at your choice.
