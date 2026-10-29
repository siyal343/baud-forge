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
| S6b vault and CLI | F1.3.5, F1.3.7, F1.5.5, F1.7.4 | done | index sidecar opens without scanning; repair cut a 33-byte tail to 56 records; assert passed 3 of 3 on a live recording; 5 contract tests |
| S11 dissection | F3.1, F3.2 (subset) | done | a 19-byte firmware frame decodes field by field from its header alone; 180k frames/s; 22 dissect tests |
| S12 symbolization | F3.5 | done | a fault line resolves 2 of 4 pointers to file:line in 1.2 us each; 17 elf tests |
| S8 engine half | framing and dissection on one path | done | `bforge tail` frames a real port and decodes a COBS frame through its header; framing settings come from `.bforge.toml` |
| S6c hotplug | F1.2.5 | done | three unplug runs on the bench: detection 17 to 47 ms, reopen call 1 ms, data resumed in the same session |
| S6d yield | F1.2.6, F1.5.6 | done | a second process can open COM8 while the session reports yielded, and the session takes it back when the window ends |
| Test firmware | `firmware/bforge_test` | done | esptool flashed 298 880 bytes while the session reported yielded; the new firmware decodes through its header; 0.69 MB/s measured over USB |
| S8b assert fields | D-15 | done | a 6 s recording from the board decodes to 122 frames and passes 5 field, protocol and count checks |
| S9 sockets | F1.2.7 (TCP, UDP, config) | done | simulator over loopback: tail decodes, record stores 60 frames, assert passes 3 of 3, no hardware |
| S10 native packs | F3.4 (CCSDS/PUS, CSP, Modbus; MAVLink deferred) | done | 12 pack tests on hand-built fixtures; a CCSDS packet in a vault decodes and passes assert rules with no schema file |
| S20 GUI recording | FR-UI-02 (the window keeps a vault) | done | 2308 records in a vault started by the window; the scrubber decoded a window from it; a port that was not up yet now retries instead of closing |
| S19 desktop shell | FR-UI-01 (a window around the workbench) | done | `MainWindowTitle "BaudForge"`, engine on `127.0.0.1:54348`, API and assets served; found and fixed a `Send` bound on the framing trait object |
| S18 bridge | FR-MITM-01 (tap and inline bridge between two ports) | done | bytes travel both ways between two loopback devices; a passive tap forwards nothing; validation refuses a missing port |
| S17 symbol badges | F2.2.1 (addresses in frames resolved and drawn) | done | `pc 0x140001480 -> std/src/env.rs:228` from a real image, over the live contract; 4 unit tests |
| S16 scrubber | F1.7.5 (vault window in the contract, slider in the workbench) | done | 517 frames from record 200 of 108 704, plotted from the window; found and fixed a vault that could not be read while recording |
| S15 fault injector | FR-FLT-01 (bit flips, drops, truncation, CRC corruption) | done | device received 2 bytes with exactly one bit flipped each; `off` restores clean sends; 6 unit tests |
| S14 send path | F2.1.1 (write from the UI, checksum on the wire) | done | 3 sent, then 7 sent with CRC-32C, 404 for an unknown port, 400 for odd hex; the device received 10 bytes in order |
| S13 telemetry | F1.7.4 (numeric series, plot band) | done | 98 880 chunks over 209 s, `sim.channel` plotted with 600 samples; found and fixed a pump starvation at 8 kHz |
| S12 workbench | F1.7.3 (SolidJS frontend over the served contract) | done | 258 326 chunks and 11.2 MB drawn live; frames decode to 9 fields each; hover marks a field's bytes |
| S11 serve | F1.7.2 (contract over HTTP, events over SSE) | done | 300 s session served: snapshot every 200 ms, 40 snapshot and 32 ui frames in 8 s, 74 032 chunks; page captured in Edge |

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

S6b notes:

- The writer keys its index by record ordinal, not by the port sequence. The same
  mistake that broke the reader in S4 would have written a useless index; the
  storage test that holds the line now covers both sides.
- The index is a cache with a hard link to one file length. A stale index sends
  the reader back to a scan, and a repair always scans fresh, because a stale
  index must not decide how much of a damaged file to keep.
- `repair` is a truncation, not a rewrite. The test sweeps every byte offset of a
  five-record vault and asserts both the record count and the repaired length.
- `bforge assert` reads the rule file before the vault, so a rule typo cannot look
  like a failed expectation.
- The contract test lists 25 zone fields with the JSON pointer that feeds each
  one. A zone field without a source fails there.

Remaining in S6: pins at 1 kHz (F1.2.3), USB tuple binding (F1.2.4), hotplug and
reconnect (F1.2.5), port yield (F1.2.6, F1.5.6) and segment compression (F1.3.4).
The first four want the board plugged and unplugged by a person, and compression
wants a measurement before a format.

S11 notes:

- `tree-sitter-c` cannot build here: the bundled mingw gcc cannot run `cc1`. The
  parser is hand-written for the specified subset, and the interface is one
  function, so the swap is local. Recorded as D-35 with its refusals (D-36, D-37).
- The parser refuses instead of guessing. A wrong layout decodes plausible values
  from the wrong bytes, which is worse than an error with a line number.
- Bitfields in an unpacked struct are refused: C alignment for bitfields is
  compiler-specific, and the specification only needs packed firmware structs.
- The executor bounds-checks every read and reports absolute offsets, so the hex
  pane can highlight the bytes a field came from.
- Decoding allocates a `String` per field. 180k frames/s is three times the target
  on 19-byte frames; the borrowed copy waits for the UI (D-38).

S12 notes:

- `object` and `addr2line` are pure Rust, so this built without a C compiler.
  ELF, PE and Mach-O all load, which is why the tests can use the test binary as
  the image and still exercise the same code a firmware `.elf` would.
- `addr2line` panics on `u64::MAX`: an integer overflow inside the line lookup.
  `resolve` now refuses any address outside the image's symbol span before the
  lookup, so a garbage hex number in a crash log returns `None` instead of taking
  the process down.
- The pointer scanner accepts 8 to 16 hex digits, not only 8 or 16: a 64-bit
  address prints without its leading zeros (`0x140001434`).
- The demo resolves 2 of 4 pointers in a fault line. `SP` and `CFSR` are data and
  status, so no line exists for them, and the tool says so instead of guessing.
- The image is our own debug binary: the board's sketch `.elf` is not on this
  machine (D-46).

S8 notes:

- `bforge tail` is the read path the window will consume: pipeline, framing
  machine, optional C-header dissector, rows with byte offsets. `--json` emits the
  row shape, so the GUI can be written against a real producer.
- The framing table now carries what the machines need: sync word, length offset,
  width and adjustment, idle gap, and a frame limit. D-17 is closed.
- The hardware demo first produced zero frames because the delimiter was `0x0A`
  and the sketch ends lines with `0x0D`. The tool reported an empty stream instead
  of inventing frames, which is what the configuration check is for.
- Frames inherit the timestamp of the read that completed them, so a burst in one
  slab shows a flat delta. Per-byte timing is D-47.
- D-15 stays open in its real form: `record` still writes raw chunks, so `assert`
  matches raw bytes rather than decoded fields.

CI also builds the app now: every green run uploads a release `bforge` binary per
platform, and a `v*` tag publishes all six through the release workflow.

S10 notes:

- Each pack decodes the fields a person asks first and reports the rest as a byte
  count. A guessed layout prints confident wrong numbers, so the gaps are entries
  in DEFERRED (D-56 to D-58) instead of guesses.
- Every pack reports absolute offsets, so the hex pane can still point at bytes.
- A pack never hides a fault: a length mismatch, a bad CRC and a bad byte count are
  fields with a name, not silent passes.
- MAVLink is deferred: it needs a dialect XML, not a header layout.

S11 notes:

- The server is 300 lines of standard library. Four routes and one event stream did
  not justify a framework (ADR-001).
- The snapshot is the source of truth and the events are a hint: a client that falls
  behind loses frames, never the pump. A full queue costs that client one frame.
- The page is a placeholder on purpose. It proves the contract reaches a screen with
  live numbers; it does not pretend to be the six-band workbench (D-60).
- Serving is read-only, loopback only, with no authentication (D-59).

S11 follow-up, found by CI:

- The macos-aarch64 job hung for twenty minutes in
  `a_yield_releases_the_port_and_takes_it_back_when_the_holder_leaves`. A full
  logger ring put the reader in a `yield_now` hot loop, and on a loaded macOS runner
  that could starve the thread that drains the ring or sets the stop flag. The wait
  now sleeps for the idle interval; the policy is unchanged and no byte is dropped.
  The test's fake port also delivers at a finite rate now, so the test measures the
  yield instead of the scheduler.
- The test job has `timeout-minutes: 12`, so a hung test fails the job rather than
  occupying a runner.

S12 notes:

- The engine gained one thing: frames as `event: frames`, built by the same
  `tail_config` the CLI uses. The vault stays raw, so the browser is a second view of
  the bytes, not a different recording.
- The frontend is SolidJS, TypeScript and Vite with no UI framework. The Vite proxy
  means one origin.
- The inspector's field-to-byte highlight is the first of the four interactions the
  UI guide names, and it works because every dissector reports absolute offsets.
- CI now builds the frontend (`npm ci`, `tsc -b`, `vite build`) and uploads `ui/dist`,
  so a broken type or bundle fails the push.

S13 notes:

- Sampling lives in `SeriesSet`: one ring per port and field, 32 series, 600 samples
  each, and only new samples travel. A text field makes no series.
- The live run found two faults that no unit test would have found. `pump_once`
  drained a port until the ring was empty, so a source faster than the pump kept it
  inside the loop and froze the snapshot; it now moves at most 1024 chunks per call.
  Frames and snapshots also shared one client queue, so a slow client lost snapshots
  with the frames; frames now replace an unread batch instead.
- The stall figure is large and honest at 8 kHz: 164 s of cumulative reader wait over
  209 s. No chunk was lost. The fix for that is a larger ring or a faster pump, not a
  different policy.

S14 notes:

- The write is performed by the reader thread. It owns the transport, so a second
  writer would interleave frames with the reader on a serial port.
- The route validates before it sends: odd hex, an unknown port and an unknown
  checksum are refusals, not partial writes.
- `crc` appends `crc8`, `crc16_ccitt_false` or `crc32c` little endian, which is how
  the field travels.
- Typed encoding is not there yet (D-64): the forge takes hex. Sends are not in the
  contract either (D-65).

S15 notes:

- A profile is applied in the session's send path, before the reader writes, so the
  device sees the corruption and the caller learns what it sent.
- One SplitMix64 stream per profile, seeded, makes every fault reproducible.
- `/api/send` now reports `fault_bytes` and `dropped`, so a test can assert that the
  corruption happened rather than infer it.
- Jitter and latency are still missing (D-66), as are the MITM bridge and scripted
  faults (D-67).

S16 notes:

- The window answers the same `TailRow` shape as the live stream, so one component
  draws both and the plot can read either.
- A fault found by building it: `LogWriter` buffered its first 64 KiB, so no other
  process could read a vault until it was sealed. The writer flushes the header at
  creation and the session flushes after each pump that moved chunks. A reader test
  now covers a vault that is still being written.
- A seek loses the frame that straddles the first record, and resynchronises at the
  next delimiter. Recorded, with the reason.
- Seeks are by record ordinal, not wall-clock time (D-68).

S17 notes:

- The resolver is a parameter, not a global: the session passes the loaded image, a
  test passes a stub, and the rule (finite, integral, at least 0x1000, inside the
  image) is pinned by four unit tests.
- The demo found the boundary: a 32-bit field cannot hold an address from an image at
  0x140000000, so the truncated value resolved to nothing. A wrong function would have
  been worse than no badge, and the rule refuses it.
- Mangling (D-44) makes function names unreadable, so the badge leads with the source
  location and the name stays in the tooltip.
- Text crash lines are not parsed (D-71) and no source text is fetched (D-70).

S18 notes:

- The bridge is a forwarder in the session, so it works for `record` and `serve`
  alike, and the fault profiles already apply to the destination port.
- The vault records the forwarded copy with `direction = Tx` on the receiving port.
  Without that a bridged session could not answer "what did the engine put on the
  wire?".
- The write has a 100 ms budget and a failure ends with an error instead of a silent
  drop: a wedged destination is visible, not absorbed. A queue per direction is D-72.
- Validation covers the three ways a bridge can be wrong.

S19 notes:

- The window is a webview onto the same HTTP surface the browser uses. No second data
  path, no second set of panels, and the shell is 120 lines that mostly read a
  workspace.
- `bforge serve` now serves a built frontend from a directory, with `index.html` as the
  client-side fallback. That one small change is what makes the shell possible without
  an IPC layer.
- The GUI needed the session to move to a thread, which exposed a missing `Send` on
  `Box<dyn ByteMachine>`. One bound fixed it; the machines were always thread-safe.
- CI excludes the crate everywhere except a Windows job, because Tauri wants platform
  libraries that headless Linux runners do not have.

S20 notes:

- The installer is deliberately deferred to release (D-74, 29 October 2026), so the
  shell stays a folder until the surface settles.
- Recording from the window needed one line of plumbing plus one behaviour change: a
  first open that fails now goes through the reconnect budget. Without it, a window
  opened before the board was plugged in closed its port for good, which the live run
  showed as `state: closed, chunks: 0` after 74 s.
- The vault path is printed at startup and `--vault` overrides it (D-78 keeps the
  picker open).

Next action: the receive-side gap that matters most for a rig: `serve` and the window
only record what arrives. A tap on two RX ports is one timeline (spec 0025), but the
direction column is still one per port (D-72), so a bridge reads as two streams
instead of one bus. That is the next honest improvement. `serve` is the only interface it needs, so the
work can be done in Edge with hot reload, and the Tauri shell wraps the same files
afterwards. The engine has published the contract since S4; this is the first phase
where a change to a panel can be seen without a desktop build.

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
