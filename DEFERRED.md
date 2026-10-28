# DEFERRED

Work that was deliberately not done, with the reason and the condition that
brings it back. Every entry has an ID so a commit, a spec or `PLAN.md` can point
at it. Nothing here is forgotten by accident; each line is a decision.

The plan lives in [IMPLEMENTATION.md](IMPLEMENTATION.md), progress in
[PLAN.md](PLAN.md).

## How to use this file

- When a slice is closed, move its entries to "Closed" with the commit that
  closed them, or delete them.
- When an entry is blocked on a person or a machine, say which, so the next
  session does not wait for a thing that will not arrive.
- A risk is written for the reader who finds the entry two months later, not for
  the author who already knows.

## 1. Blocked by this machine

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-01 | Phase 2 GUI: Tauri v2 host, SolidJS workbench, six bands | Tauri needs the MSVC linker on Windows; this machine has only the GNU toolchain, so nothing could be compiled or verified. Node 22 is present. | A machine with MSVC, or a CI job that builds the GUI (Ubuntu or macOS runners can), or moving the GUI to the CI-only path | The engine already publishes the F1.7 contract, so the GUI is a consumer, not a redesign. Delay costs schedule, not architecture. |
| D-02 | `ui/` frontend | Same as D-01. The design is fixed by `specs/UI-UX-Guide.md`. | D-01 | As above. |
| D-03 | Windows ARM64 and macOS Intel installers | No Tauri build on this machine. CI cross-builds the CLI only. | D-01 plus a release job | Release artefacts for three of six targets do not exist. |
| D-04 | S6b commit `736b1d9` is local, not on origin | Git Credential Manager wants an interactive terminal and there is no SSH key or token in the environment. | `gh auth login`, or `git push` from a normal terminal | The work is safe locally. A lost disk loses one commit. |
| D-05 | Nightly workflow has not been dispatched | Needs GitHub auth to dispatch, or wait for 03:00 UTC. | Same as D-04 | The soak numbers in `specs/0007` come from a 60-second local run, not the nightly. |

## 2. Blocked by hardware or by a person

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-06 | Pins polled at 1 kHz (F1.2.3) | Reading CTS, DSR, DCD and RI at 1 kHz needs a device that changes them. The board on the bench is read-only in practice. | A loopback harness that toggles RTS, or a second adapter | Pin state in the UI would update at chunk rate instead of 1 kHz. |
| D-07 | USB tuple binding proved (F1.2.4) | Binding by `vid:pid` and serial needs two identical adapters to prove that order does not decide the match. One board is attached. | A second FTDI or CP210x adapter | A workspace with two identical adapters may bind them by enumeration order. |
| D-08 | Hotplug and reconnect within 10 ms (F1.2.5) | Needs a person to unplug and replug the board while a session runs, on three operating systems. | Someone at the bench, per OS | A dropped port currently stays open until the next read error; reconnecting is manual. |
| D-09 | Port yield: local IPC, SIGUSR1, auto-reclaim (F1.2.6, F1.5.6) | The test is a flash tool taking the port while BaudForge holds it. That means flashing the board. | Explicit permission to flash, plus `arduino-cli` in the loop | Flashing requires closing the recorder by hand. |
| D-10 | 12 Mbaud sustained on real hardware (F1.6.1, hardware half) | Needs a firmware that streams without pause. Flashing replaces the sketch on the board, which is the user's to decide. | Permission to flash a PRBS sketch, or a second board | The 0-dropped-bytes figure is proven on a mock source, not on a UART at 12 Mbaud. |
| D-11 | MITM latency at 50 µs (F4.2) | Needs two UARTs and a scope. | Phase 4 hardware | Not yet on the critical path. |

## 3. Deliberately later in the plan

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-12 | Segment compression, LZ4 or zstd (F1.3.4) | Gate G2 kept plain files. A compressed format should follow a write-throughput measurement and a decision on where the index points. | The measurement from `specs/0007`, then G2 revisit | Vaults are larger than they need to be; 1.2 MB/s of UART data compresses well. |
| D-13 | `memmap2` for the vault (G2 alternative) | Constant memory already comes from seek plus a bounded window, measured at 21.5 MiB peak for a 512 MiB file. | A measurement that shows seek cost dominating | None today. |
| D-14 | Sequential cursor API for the reader | The reader scans at 25 MiB/s because it seeks twice per record. A window is fast enough; a full 100 GB scan would take about 68 minutes. | F2.3, where the viewport scrolls and needs a forward cursor | Large soaks stay impractical. Full-scan `bforge assert` on 100 GB would be slow. |
| D-15 | Framing wired into the record path | A recorder writes raw chunks, one consumer per port. Framing is implemented but nothing calls it per chunk yet. | S8, or the framing consumer in the pipeline | `bforge record` cannot yet filter or annotate frames; `bforge assert` reads raw payload. |
| D-16 | Idle-gap framing needs its clock from the caller | `ByteMachine::tick` exists and is tested, but nothing in the read path calls it with a chunk timestamp. | D-15 | A port configured for `idle_gap` produces nothing until then. |
| D-17 | `.bforge.toml` cannot express `header_length` or `idle_gap` settings | The schema has `mode`, `delimiter` and `crc` only. The machines take a sync word, offsets, adjustment and gap. | The framing consumer work in D-15 | Those two modes validate but cannot be configured from a file. The gap is in the schema, not the framer. |
| D-18 | Dissector UI, real tree, field-to-hex highlight | Phase 3, after the GUI. | D-01 | None; the engine side is what S11 builds. |
| D-19 | Telemetry series in the contract | Contract v1 has no time-series field; plots need one. | Phase 2, with the DVR | The GUI cannot plot from the contract yet. |
| D-20 | DTR and RTS in the pin view | The view carries inputs only; the outputs are write-only in the transport. | F1.2.3, which needs the same plumbing | The ribbon cannot show the output state it just set. |
| D-21 | Command forge, script editor, fault studio, session diff view | Phases 2 and 4. | Their phases | None. |

## 4. Deliberate limits in shipped code

| ID | Item | Why | What it would take | Risk |
| --- | --- | --- | --- | --- |
| D-22 | `bforge assert` scans the vault once per check | One pass per needle is simple and measured fine at 100 MB. At 100 GB it is the wrong shape. | An index-backed text search beside the dissector work | Ten checks on a 100 GB vault read it ten times. |
| D-23 | Assert has no regex or timing checks | A regex engine is a dependency for a matcher nobody asked for. Timing assertions need a definition of "late". | A decision, then the Lua runtime in F4.4 | Some expectations cannot be written yet. |
| D-24 | Checksums are bitwise, not table-driven | Measured 156 MB/s through framing and CRC together, far above the 12 Mbaud target. | A benchmark that shows the engine as a bottleneck | CPU burn on a soak; no correctness risk. |
| D-25 | COBS decode allocates one `Vec` per frame | Simple and correct; 3.2 million frames/s measured. | The zero-copy refactor that borrows from the slab | Allocator churn at extreme frame rates. |
| D-26 | `bforge record` stops on Enter, not on Ctrl-C | No signal handler. A killed recorder leaves a partial record. | F1.3.7 second half: a signal handler that seals | A Ctrl-C leaves a vault that needs `bforge vault repair`. |
| D-27 | `bforge status` is a one-second probe, not a daemon | The window that would consume a stream does not exist. | Phase 2 | Nothing can watch state for long without re-running. |
| D-28 | Config schema fixes 8N1 line settings | `PortConfig` carries `baud_rate` only; parity, data bits and stop bits default. | Schema fields plus validation | A 7E1 or 2-stop-bit device cannot be described. |
| D-29 | Mock transport holds back less than 4 KiB per block | Keeps slab counts realistic and the block sequence checkable. | Nothing; it is intended | A test that wants byte-for-byte immediacy must use a rate of 0. |
| D-30 | Contract test covers 25 fields | It covers what exists. Forge, inspector and telemetry fields arrive later. | Each new zone field adds a row | A zone can gain a field without a source until the row is added. |

## 5. Dissection (Track C)

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-35 | `tree-sitter-c` front end (ADR-003) | No C compiler on this machine: the bundled mingw gcc cannot run `cc1`, so the crate cannot build and nothing could be verified. A hand-written parser covers the specified subset. | A machine or CI job that compiles C; the interface is `cheader::parse`, so the swap is local | Real headers with macros, unions or nested structs are refused. See D-37. |
| D-36 | Enum-typed fields are 4 bytes wide | C gives an enum the width of `int` unless the build uses short enums. Guessing one byte would misplace every later field. | A header that says the width, or a parser flag for short enums | Firmware built with `-fshort-enums` decodes its enum field from the wrong bytes; the fix is to declare the wire field as `uint8_t`. |
| D-37 | Nested structs, unions, struct arrays, pointer members | Each needs its own layout rules and its own refusal cases. | Demand from a real header | A header using them fails with a line number instead of decoding. |
| D-38 | Every decoded field allocates a `String` | Enough for 180k frames/s, which is three times the 12 Mbaud target on 19-byte frames. | The UI copy, which will want borrowed values | Small frames at high rate spend most of the decode time in the allocator. |
| D-39 | No protocol packs (CCSDS, ECSS PUS, CSP, MAVLink, Modbus) | F3.4. Each needs a captured fixture to be trusted. | F3.4 | Aerospace and robotics users must export their schema as a C header first. |
| D-40 | The dissector is not wired to the pipeline | Nothing decodes per chunk yet; framing joins the read path in S8. | S8 | `bforge record` writes raw chunks and the tree exists only in tests and the example. |
| D-41 | Checksum status comes out as `NotApplicable` | The schema does not say where the checksum sits or which engine it uses. | A schema field for the checksum, plus F1.4.6 wiring | The CRC chip in the inspector will stay empty until then. |

## 6. Process and release

| ID | Item | Why deferred | Unblocked by | Risk |
| --- | --- | --- | --- | --- |
| D-31 | `LICENSE-MIT` and `LICENSE-APACHE` files | The manifests declare the dual licence but the texts are absent. | Any release | A published crate or binary without the licence texts is a legal problem. |
| D-32 | Guards that refuse a workspace which watches a missing `.elf` | Validation checks the setting, not the file on disk. | The ELF watcher in F3.5 | A typo in `elf_path` shows up at run time. |
| D-33 | `windows-11-arm` is a public preview runner | It resolved and passed, but GitHub can remove the label. | A GitHub announcement | CI breaks one morning on a label change. |
| D-34 | Light theme and phone layout | Non-goals for v1, stated in the UI guide. | A decision | None. |

## Closed

| ID | Item | Closed by |
| --- | --- | --- |
| — | Framing modes SLIP, Intel HEX, sync-word, idle gap | `99e2e93`, `specs/0005` part two |
| — | Persisted index, crash repair, `bforge assert`, contract test | `736b1d9`, `specs/0003`, `specs/0008` |
| — | IR executor and C header parser (S11) | `specs/0009` |
