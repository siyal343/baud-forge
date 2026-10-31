# BaudForge status

Written 29 October 2026, measured from the repository at commit `8b5ee82`; updated 30 October 2026 during the release pass.

## Numbers

| Figure | Value | How |
| --- | --- | --- |
| Commits | 57 | `git rev-list --count HEAD` |
| Rust | 18 323 lines across 9 crates | `wc -l` over `crates/**/*.rs` |
| Frontend | 1 010 lines, SolidJS + TypeScript | `wc -l` over `ui/src` |
| Tests | 241 passing, ~25 s, workspace | `cargo test --workspace --exclude bforge-gui` |
| Feature specs | 30 written before the code | `specs/0001` … `specs/0030` |
| CI | 9 jobs green, 6 targets | GitHub Actions |
| Open gaps | 71 entries | `DEFERRED.md` |

## What works end to end

Proof is a run, not a claim. Each line was measured in this project.

| Capability | Evidence |
| --- | --- |
| Ring-buffer pipeline, no gaps | 4 ports × 1.2 MB/s for 60 s, 288 MB, 0 gaps, 11.9 MiB peak |
| `.bflog` vault, constant memory | 512 MiB read at 21.5 MiB peak (4.2 %) |
| Serial, TCP client/server, UDP transports | 190 + tests, a device simulator for CI |
| Six framing modes | 2000 COBS frames at 156 MB/s, 0 invalid |
| C header dissector | 180 422 frames/s |
| Native packs: CCSDS+PUS, CSP, Modbus RTU | 12 fixture tests, one end-to-end vault test |
| DWARF symbols | address → `std/src/env.rs:228`, 1.2 µs per lookup |
| Hotplug | unplug detected in 16.8–47.1 ms, reopened in 1 ms, same session |
| Yield to a flash tool | `arduino-cli upload` wrote 298 880 bytes while the session reported `yielded` |
| Record, replay, tail, assert, vault repair | CLI commands, on hardware and on sockets |
| UI contract over HTTP + SSE | 40 snapshot and 32 ui frames in an 8 s capture |
| Workbench | live stream, decoded fields, field→byte highlight, plot, forge, fault row, scrubber, bus view |
| Send path | device received 10 bytes in order, with a CRC-32C appended |
| Fault injection | bit flip, drop, truncate, corrupt CRC; reproducible by seed |
| Bridge and tap | bytes forwarded both ways; vault records `Tx`; a posted write never blocks the pump |
| Desktop shell | `MainWindowTitle "BaudForge"`, engine on a random loopback port, records a vault |

## What is missing

### Blocks a person from using it daily

| Gap | Why it matters | Cost estimate |
| --- | --- | --- |
| Installer, signing (D-74) | today it is a folder with an exe | deferred by you to release |
| Typed command entry (D-64) | the forge takes hex, not fields | 2–3 sessions |
| Live transmit rows (D-79) | a bridge's writes only show in a scrubbed window | 1 session |
| Vault picker in the window (D-78) | the window records to a temp path | half session |
| Hardware soak on the ESP32-C3 (D-14) | hours, not minutes, under load | 1 session of babysitting |

### Polish that the plan promised

| Gap | Note |
| --- | --- |
| WebGL plots at 60 FPS (D-63) | today SVG, one series |
| Virtualized hex viewport | today 120 rows |
| Dissector tree in the inspector (D-69) | today a flat field list |
| Demangling (D-44) | Rust names are unreadable |
| Time-axis scrubbing (D-68) | record ordinals only |

### Scope in the SRS that was never started

| Item | Size |
| --- | --- |
| Lua fault scripts and the sandbox (FR-SCR-01, D-67) | large: a runtime, a sandbox, an API |
| Protobuf and Kaitai front ends | medium each |
| MAVLink dialect table (D-56) | medium, needs a dialect |
| Jitter and latency injection (D-66) | medium |
| Session diff, hardware triggers, MITM at 50 µs | large |

## Against the SRS milestones

These are estimates from the feature lists, not measurements.

| Milestone | State | Estimate |
| --- | --- | --- |
| 1. Iron core (weeks 1–4) | record, replay, hotplug, yield, hot path measured | ~95 % |
| 2. GPU terminal (weeks 5–8) | window, stream, plot, scrubber exist; WebGL and virtualization do not | ~60 % |
| 3. Dissectors (weeks 9–12) | C header, packs, DWARF done; protobuf, kaitai, defmt missing | ~55 % |
| 4. MITM and faults (weeks 13–16) | bridge and fault profiles done; no Lua, no jitter, no triggers | ~35 % |

Weighted by the SRS work breakdown: **about 60 % of the planned scope**.

## Why it feels like it drags

Three reasons, and two are fixable.

1. **The work went in small verified slices.** 48 commits, 30 specs, each with a
   measurement. That is slow by design: every slice re-ran the suite and the CI, and
   two slices were partly spent on browser tooling that stopped working.
2. **The cheap work is done.** What remains is the expensive part: a Lua runtime, a
   WebGL renderer, protobuf, installers. Each of those is a multi-session item with its
   own design, and none can be finished inside one slice.
3. **Scope crept past the first cut.** The plan recommended scope B (35 days) for a
   first release. What was built is closer to scope A: bridge, faults, packs, symbols,
   desktop shell. Good, but it also means the "first cut" is overdue.

## Release pass, 30 October 2026

The freeze was put into practice:

- Two release blockers were found on real data and fixed: `assert` was quadratic on a
  15-minute capture (over ten minutes, now 10 s) and a session truncated an existing
  vault (now refused, with a test).
- The hardware session ran on the ESP32-C3: 327 929 chunks, 164 073 decoded frames,
  3 of 3 checks passed.
- `docs/QUICKSTART.md`, `RELEASE-NOTES.md`, two demo workspaces and a rewritten README
  first screen landed.
- `bforge serve` now seals the vault when it stops, and can serve the built frontend
  (`--ui`) instead of the placeholder page.
- Lua fault scripts landed after the tag: a sandboxed hook on the transmit path
  (spec 0031), which also unblocked the C-compiler problem behind D-35 and D-67.
- **`v0.2.0` is tagged and published**: Lua scripts, typed encoding, enum labels,
  typedef'd enums, nested structs, the typed forge mode.
- **`v0.1.0` is tagged and published** with six binaries (`bforge-linux-x86_64`,
  `bforge-linux-aarch64`, `bforge-macos-x86_64`, `bforge-macos-aarch64`,
  `bforge-windows-x86_64.exe`, `bforge-windows-aarch64.exe`).

## Recommendation: stop adding, cut a release

The product is usable today by someone willing to run two commands. The next valuable
step is not another feature; it is a release candidate.

1. **Freeze features.** No new specs until `v0.1.0` is tagged.
2. **One validation session.** ESP32-C3 on COM8: record 10 minutes with the test
   firmware, tail it live, scrub it, send a command, arm a bit flip, run the bridge
   between two sockets. Record the numbers in `RELEASE-NOTES.md`.
3. **One documentation pass.** README first screen, `docs/QUICKSTART.md` with a demo
   workspace, and a note that says exactly what is and is not in 0.1.
4. **Tag `v0.1.0`.** CI already produces artefacts per target and a Windows desktop
   folder. The installer waits for the release you planned (D-74).

Then decide, with the release in hand, whether the Lua runtime and the WebGL plots are
worth the next month — or whether 0.1 is enough to show people.

Estimated as three to four working sessions, most of it the hardware session.
