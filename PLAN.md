# PLAN

Setup record and status of the BaudForge project. The design source is
[`specs/ADR & SRS.md`](specs/ADR%20%26%20SRS.md). This file tracks progress; the
specification does not change.

The work breakdown, with phases, features, subfeatures and gates, is in
[IMPLEMENTATION.md](IMPLEMENTATION.md). It now also carries the GUI: every
subfeature names the workbench band that shows it, and the engine publishes that
state through one contract (F1.7).

## Status

| Phase | State |
| --- | --- |
| 0. Scaffold | done |
| 1A. Iron core, full scope | in progress |
| 1B. First cut (recommended) | in progress |
| 2. GPU terminal | not started |
| 3. Dissectors and ELF | not started |
| 4. MITM, faults and lab sync | not started |

## Stage record

| Stage | Units | State | Result |
| --- | --- | --- | --- |
| S1 pipeline | F1.1.1 to F1.1.6 | done | 4 ports at 1.2 MB/s, 14.40 MB, 0 gaps, 0 overruns |
| S2 transport and vault | F1.2.2, F1.2.7, F1.3.1 to F1.3.3, F1.3.6 | done | ESP32-C3 recorded over COM8; mock session 2.39 MB at 1.20 MB/s, window read back |
| S3 framing and validation | F1.4.1, F1.4.2, F1.4.6, F1.5.1 | done | 2000 COBS frames through 4 KB slabs, 0 invalid, all CRC-32C valid; `bforge config check` names each problem |
| S4 record, replay, status | F1.5.2 to F1.5.4, F1.7.1 to F1.7.3 | done | ESP32-C3: 89 chunks sealed, JSON snapshot, JSONL events, replay at 4x with 2.3 ms worst lateness |
| S5 measurement | F1.6.1, F1.6.2, F1.6.3 | done | 4 ports at 12 Mbaud for 60 s: 288 MB, 0 gaps, 11.9 MiB peak; 512 MiB vault read at 21.5 MiB peak |
| S6a framers | F1.4.3, F1.4.4, F1.4.5, F1.4.7 | done | all six framing modes implemented; 38 framer tests, 4 property tests over random splits |

S1 notes:

- G0 measured `rtrb`, `crossbeam-channel` and std `sync_channel`. All three carry
  about 550 times the target, so the choice follows ADR-002: two `rtrb` rings.
  Numbers are in [`specs/0002-spmc-pipeline.md`](specs/0002-spmc-pipeline.md).
- The mock transport lives in `bforge-hal` rather than `bforge-core`, so every
  later crate can use it in tests.
- The reader abandons one slab on shutdown if the logger ring is full and no
  consumer is left. That is the only path that loses a slab, and the code marks it,
  so it is not a silent drop.

S2 notes:

- Gate G1 chose the `serialport` crate. It covers baud, 5 to 8 data bits, three
  of five parity modes, 1 and 2 stop bits, DTR and RTS, the four modem inputs,
  and USB identity. Mark and space parity plus 1.5 stop bits return
  `Unsupported`; F1.2.1 owns them.
- The board named in the request, COM3, is a Bluetooth link. The ESP32-C3 is on
  COM8, `303a:1001`. Port matching by USB identity is the reason F1.2.4 exists.
- Gate G2 kept plain files. Constant memory comes from seek plus a bounded
  window; compression waits for F1.3.4.
- Real UART reads fragment: 977 bytes arrived as 62 chunks, so the 32-byte
  record header cost three times the payload. Idle coalescing or idle-gap
  framing in F1.4.5 fixes it. It does not affect the 12 Mbaud target.
- Hardware throughput is unmeasured: the demo proves the path, not the rate.
  F1.6.1 needs a firmware that streams without pause.

S3 notes:

- Validation reports a path such as `ports[0].baud_rate`, not a line number.
  A line number is not reachable after deserialization; syntax errors keep the
  parser's line and column.
- The four modes that are not implemented yet (`slip`, `intel_hex`,
  `header_length`, `idle_gap`) validate and then return `UnsupportedMode`, so a
  configuration cannot silently fall back.
- The checksum engines are bitwise. They carried 156 MB/s in the S3 run, so a
  table-driven version is not needed for the 12 Mbaud target.
- `MockTransport::stream` replays a fixed byte script. It is the hook for framing
  and dissector tests, and it is how the S3 demo feeds the pipeline.

S4 notes:

- The vault seek key is the record ordinal, not the chunk sequence. Every port
  starts its own sequence at zero, so a two-port recording holds two records with
  `seq_id 0`. The reader compared against `seq_id` and failed on the second port;
  `records_from_two_ports_keep_their_own_sequences` now holds the line.
- The event bus replays the last event to a new subscriber. Without it the CLI,
  which subscribes after `Session::start`, never sees `Started`.
- A recorder runs one consumer per port. The framing consumer arrives in S5, so
  overruns are zero by construction today.
- `record` without `--duration` stops on Enter. Ctrl-C leaves an unsealed vault,
  which the reader reports as `damaged_tail` until F1.3.7.

S5 notes:

- The stress harness checks the vault, not the counters: every mock block carries
  its own sequence in the payload, so a dropped block is a gap in the file. 60 s
  at 4 x 12 Mbaud produced 288 MB, 5 segments and 0 gaps.
- Resident memory is read from the operating system on all three platforms:
  `/proc/self/status`, `GetProcessMemoryInfo`, and `ps` on macOS.
- The reader scans at 25 MiB/s because it seeks twice per record. Fast enough for
  a window, too slow for a 100 GB scan. A sequential cursor belongs with F2.3.
- The index estimate for 100 GB is 37.5 KiB at 24 bytes per entry. That number is
  derived, not measured, and the harness prints it as an estimate.
- Hardware throughput is still unmeasured: the ESP32-C3 prints a boot log, not a
  saturated line. F1.6.1 needs a streaming sketch.
- The nightly workflow runs 600 s of stress plus a 1 GiB memory read and writes
  both reports into the job summary.

S6a notes:

- S7 (the GUI shell) cannot be built on this machine: Tauri needs the MSVC
  linker and only the GNU toolchain is installed. Node 22 is present, so the
  frontend could be written, but nothing could be compiled or verified. The
  framing slice of S6 is pure Rust and fully verifiable, so it went first.
- Idle-gap framing takes its clock from `tick`, never from `Instant::now()`. A
  test decides when the bus went quiet, and the pipeline will pass the chunk
  timestamp when framing joins the read path in S8.
- `header_length` and `idle_gap` return `NeedsConfig` from the factory: a mode
  name is not enough to build them, and pretending otherwise would invent
  settings.
- Property tests feed each machine one stream in one piece and in random pieces,
  twenty rounds per machine, with a deterministic generator so a failure
  reproduces.

Remaining in S6: pins at 1 kHz (F1.2.3), USB tuple binding (F1.2.4), hotplug and
reconnect (F1.2.5), port yield (F1.2.6, F1.5.6), segment compression (F1.3.4),
the persisted index (F1.3.5), crash recovery (F1.3.7), `bforge assert` (F1.5.5)
and the contract test (F1.7.4).

Next action: S6b, the vault and the CLI. F1.3.7 (crash recovery), F1.3.5
(persisted index), F1.5.5 (`bforge assert`) and F1.7.4 (contract test) need no
hardware, and `assert` is what makes the tool useful in CI.

## What the setup did

1. Turned the single crate into a Cargo workspace with the nine crates from
   SRS section 2.1.
2. Kept the root crate `baud-forge` and all code in `src/legacy/` unchanged, so
   the telemetry core from porti-rs still builds.
3. Added the shared types from the specification: `RawChunk`, `DissectedFrame`,
   `TransportDriver`, `FaultProfile`, `ProjectConfig`.
4. Added the `.bforge.toml` schema and one sample workspace file.
5. Added the `bforge` CLI with the `help` and `version` commands.
6. Added the GitHub Actions workflow for the six target platforms.

## What is not implemented

Every crate compiles and holds types only. No crate runs an algorithm yet.

| Crate | Missing work | Milestone |
| --- | --- | --- |
| `bforge-hal` | UART, RTT, CAN and TCP drivers; USB hotplug watch; port yield IPC | 1 |
| `bforge-storage` | Memory-mapped writer, 64 MB segmentation, LZ4 compression, index writer, exporters | 1 |
| `bforge-framer` | Delimiter, COBS, SLIP, Intel HEX, sync-word and idle-gap framers; checksum engines | 1 |
| `bforge-core` | Config validation, port registry, pipeline coordinator, gRPC control plane | 1 |
| `bforge-cli` | `record`, `replay`, `assert`, `yield` | 1 |
| `bforge-gui` | Tauri v2 host, window, binary IPC channel | 2 |
| `ui/` | SolidJS frontend, terminal viewport, plots, packet tree | 2 |
| `bforge-dissect` | C struct parser, Protobuf, Kaitai, native packs, IR executor | 3 |
| `bforge-elf` | ELF load, DWARF lookup, file watch, defmt and pw_tokenizer decode | 3 |
| `bforge-script` | Fault engine, MITM bridge, Lua VM, pin triggers, session diff | 4 |
| `legacy` | None. Frozen. | — |

## Decisions still open

- Checksum library: write the CRC engines by hand, or use a crate.
- Fan-out primitive: `rtrb` or `crossbeam-channel`. The ADR names both.
- Async model of `TransportDriver`. The trait is synchronous today, which keeps
  it object safe. A real async driver may force a change to the trait.
- Lua binding: `mlua` with Lua 5.4 or Luau. The ADR names both.
- `ConfigError` shape for semantic validation. Duplicate port IDs, baud limits
  and unknown references are unchecked today.
- License files. `LICENSE-MIT` and `LICENSE-APACHE` are not in the tree yet.
- The `windows-11-arm` runner label is a public preview. Confirm it before the
  first release build, and drop the matrix entry when GitHub removes it.

## Verified

- `cargo build --workspace` succeeds, no warnings.
- `cargo test --workspace` passes, one test: the sample `.bforge.toml` parses
  into `ProjectConfig`.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -D
  warnings` pass.
- `bforge version` prints `bforge 0.1.0`.
- CI run 40473503649 passed on all seven jobs: format and lints, five native
  test runners, and the macOS Intel cross-build. The `windows-11-arm` and
  `ubuntu-24.04-arm` labels resolved.

Toolchain used for the check: `stable-x86_64-pc-windows-gnu` on Windows, because
this machine has no MSVC linker. The project itself does not depend on that
toolchain.

## Next step

Write the implementation plan for Milestone 1. Start with `bforge-hal` and
`bforge-storage`, because the ring buffer, the port match and the `.bflog`
writer are the base of every later feature.
