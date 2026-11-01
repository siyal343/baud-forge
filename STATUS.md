# BaudForge status

Written 2 November 2026 at `v0.8.0` plus Fast-Build Waves 1 and 2, measured from the repository.

## Where it is

A complete four-milestone serial monitor, protocol dissector, session differ, file transfer tool, and fault-injection workbench in Rust and Tauri v2. Engine, command line, browser workbench, and desktop window share one HTTP/SSE contract. Signing is deferred by the user (`D-95`), so the Windows installer shows SmartScreen on first launch.

## Numbers

| Figure | Value | How |
| --- | --- | --- |
| Releases | 13 tags, `v0.1.0` … `v0.8.0` | `git tag` |
| Crates | 9 workspace crates | `ls crates` |
| Feature specs | 60 (`specs/0002` … `specs/0057`) | `ls specs/*.md` |
| Tests | 328 passing | `cargo test --workspace --exclude bforge-gui` |
| CI | 11 jobs: 5 test targets, lint, UI, desktop (Windows, Linux, macOS), macOS Intel cross-build | `.github/workflows/ci.yml` |

## What works, and the evidence

Each line was measured on this machine or verified by automated test; the figures are in `RELEASE-NOTES.md` and `specs/`.

| Capability | Evidence |
| --- | --- |
| Pipeline with no gaps | 4 ports × 1.2 MB/s for 60 s: 288 MB, 0 gaps, 11.9 MiB peak |
| Vault with constant memory | 512 MiB read at 21.5 MiB peak (4.2 % of the file) |
| Export (`csv`, `jsonl`, `saleae`, `pcapng`) | 285,740 records exported via forward cursor in 3.4–5.5 s (`specs/0044`) |
| Serial, TCP client/server, UDP | Socket simulator for CI, hotplug reconnect in 17–47 ms on Windows (`specs/0012`) |
| Six framing modes, three checksums | Delimiter, COBS, SLIP, Intel HEX, sync+length, idle gap; CRC-8, CRC-16/CCITT-FALSE, CRC-32C |
| C header dissection & typed encoding | 180,422 frames/s; bitfields, enums, typedefs, nested structs, typed frame encoding (`specs/0032`) |
| Native packs + XML & `.proto` schemas | CCSDS TM/TC with PUS, CSP v1, Modbus RTU, MAVLink v1/v2 + XML dialects (`specs/0048`, `specs/0054`), Protobuf wire + `.proto` schemas (`specs/0047`, `specs/0053`) |
| DWARF symbols + `defmt` & `pw_tokenizer` | Address → `std::env::var::<&str>` at `env.rs:228` in 1.2 µs (`specs/0035`); `.defmt` and `.pw_tokenizer.entries` ELF extraction and frame formatting (`specs/0055`) |
| Yield to a flash tool | `arduino-cli upload` wrote 298,880 bytes during a `yielded` window (`specs/0014`) |
| Pin control & timed sequencer | Manual `DTR`/`RTS`, single pulse (`specs/0049`), and multi-step timed sequences from API and UI without starving reads (`specs/0052`, `specs/0057`) |
| Flow-controlled paced send | Chunked writes with configurable inter-chunk pacing from API and UI while servicing full-duplex reads (`specs/0052`, `specs/0057`) |
| Session diff | `bforge diff <a> <b>`, `GET /api/diff`, and Workbench Diff panel (`specs/0050`, `specs/0057`) |
| XMODEM / YMODEM file transfer | XMODEM-Checksum, XMODEM-CRC, XMODEM-1K, and YMODEM batch state machines + `bforge xfer` (`specs/0056`) |
| Fault profiles & Lua scripts | Bit flips, drops, truncation, CRC corruption, latency, jitter; Lua on TX and RX with named fields (`specs/0031`–`0034`) |
| Bridge and tap | Passive tap and inline forwarding bridge with live `Tx` rows (`specs/0045`) |
| Virtualized workbench & WebGL plots | Frameless Tauri shell, 10,000-frame virtualized stream (`specs/0051`), paged hex dump, field tree, WebGL stacked rows, state lanes, bit rails, time-axis DVR playback (`specs/0039`–`0043`) |

## Against the SRS

| Milestone | State |
| --- | --- |
| 1. Iron core | **complete** — record, replay, assert, hotplug, yield, vault repair, forward export |
| 2. GPU terminal and plotter | **complete** — frameless shell, virtualized stream & hex viewport, WebGL traces/lanes/rails, time seek & playback, typed command forge, paced sends |
| 3. Dissectors and ELF | **complete** — C header parser, CCSDS/CSP/Modbus/MAVLink (built-in + XML dialects), Protobuf (wire + `.proto`), DWARF symbols with demangling, `defmt` & `pw_tokenizer` token decoding |
| 4. MITM, faults, scripting | **complete** — bridge, all fault primitives, Lua TX/RX with fields, semantic session diff, timed pin sequencer, XMODEM/YMODEM transfers |
