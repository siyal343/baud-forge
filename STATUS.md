# BaudForge status

Written 31 October 2026 at `v0.5.2`, measured from the repository.

## Where it is

A serial monitor, protocol dissector and fault-injection rig that a stranger can install
today. Engine, command line, workbench in a browser, and a Windows desktop window with an
installer. Ten releases, all published. Signing is deferred by the user (D-95), so the
installer asks for "more info → run anyway" on first launch.

## Numbers

| Figure | Value | How |
| --- | --- | --- |
| Releases | 10 tags, `v0.1.0` … `v0.5.2` | `git tag` |
| Commits | 67 | `git rev-list --count HEAD` |
| Rust | 20 665 lines, 9 crates | `wc -l` over `crates/**/*.rs` |
| Frontend | 1 151 lines, SolidJS + TypeScript | `wc -l` over `ui/src` |
| Tests | 268 passing, ~25 s | `cargo test --workspace --exclude bforge-gui` |
| Feature specs | 35, written before the code | `specs/` |
| CI | 9 jobs green: 5 test targets, lint, UI, desktop+installer, macOS cross-build | GitHub Actions |
| Recorded gaps | 77 entries | `DEFERRED.md` |

## What works, and the evidence

Each line was measured on this machine; the figures are in `RELEASE-NOTES.md`.

| Capability | Evidence |
| --- | --- |
| Pipeline with no gaps | 4 ports × 1.2 MB/s for 60 s: 288 MB, 0 gaps, 11.9 MiB peak |
| Vault with constant memory | 512 MiB read at 21.5 MiB peak (4.2 % of the file) |
| Serial, TCP client/server, UDP | 190+ tests, socket simulator for CI |
| Six framing modes, three checksums | 2000 COBS frames at 156 MB/s, 0 invalid |
| C header dissection | 180 422 frames/s; enums by label, typedefs, nested structs |
| Native packs | CCSDS with PUS, CSP v1, Modbus RTU |
| DWARF symbols, demangled names | address → `std::env::var::<&str>` at `env.rs:228`, 1.2 µs |
| Hotplug | unplug seen in 16.8–47.1 ms, reopened in 1 ms, same session |
| Yield to a flash tool | `arduino-cli upload` wrote 298 880 bytes during a `yielded` window |
| Record, replay, tail, assert, repair | CLI, on hardware and on sockets |
| Type send from fields | `{"v_batt_mv":7400}` → 19 bytes, device read them back |
| Fault profiles | flips, drops, truncation, CRC, delay, jitter, all seeded |
| Lua scripts | sandboxed, fields by name, CRC recompute, transmit and receive |
| Bridge and tap | bytes both ways, vault records `Tx`, sends never block the pump |
| Workbench | stream, fields with byte highlight, plot, scrubber, forge, faults, bus view |
| Desktop | NSIS installer, records a vault, 9/9 CI |

## Against the SRS

Estimates from the requirement lists, not measurements.

| Requirement | State |
| --- | --- |
| FR-FLT-01 fault primitives | **complete** — bit errors, drops, truncation, CRC, latency, jitter, scripted |
| FR-MITM-01 tap and bridge | **complete** — passive tap, forwarding bridge, direction on rows, paired bus view |
| FR-SCR-01 Lua HIL API | **complete** for the SRS example — `on_frame`, fields by name, CRC, log |
| Storage, framing, transports | complete for the first release scope |
| UI bands | six bands present; plots are SVG not WebGL, inspector flat, no time axis |
| Protobuf, Kaitai, defmt, MAVLink | not started |
| Installer and signing | installer ships; signing deferred (D-95) |

## What a person cannot do yet

Recorded in `DEFERRED.md` with a reason each. The ones a user would notice:

- Windows SmartScreen warns on first launch (D-95).
- macOS binaries are neither signed nor notarised (D-96).
- Plots redraw in SVG: one series, fine to a few thousand points, not the 60 FPS lane view
  the UI guide describes (D-63).
- The inspector lists fields flat, without the dissector's tree (D-69).
- The scrubber seeks by record number, not by wall-clock time (D-68).
- A bridge's writes are visible in a scrubbed window, not live (D-79).
- Scripts use one schema for every port (D-94).
- Jitter is uniform, not shaped (D-93).
- No protobuf, Kaitai, defmt or MAVLink decoder.
- No C++ demangling.

## Why the remaining items are not started

Every one is depth on a working feature, not a missing capability. The three requirements
that define the product — inject faults, sit between two devices, script the link — are
done and released. What is left is polish that costs sessions (WebGL, tree inspector, time
axis) or money (signing), and none of it blocks the tool from being used today.

## Next, when someone wants to continue

1. **Signing** — apply to SignPath Foundation (free for OSI projects); the workflow is
   already gated on secrets. A human must submit the form (D-95).
2. **WebGL plots** — the one band that does not meet the UI guide; needs a renderer and a
   downsampling policy (D-63).
3. **Time-axis scrubbing** — a timestamp index in the vault, then a slider in seconds
   (D-68).
4. **Another decoder** — protobuf or MAVLink, whichever a user asks for first.
