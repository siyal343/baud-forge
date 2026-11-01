# What is next

Written 1 November 2026. The tree is at `v0.7.0` plus the work since, all pushed and green
(271 tests, CI 9/9): the standalone shell, geometry, session menu, field tree, GPU band, time
seek, bit rails, stacked rows and playback. Releases are paused by the user, so `v0.8.0` is
waiting rather than missing.

This file replaces the stale tail of `PLAN.md` as the forward plan. It is a plan, not a
record: `STATUS.md` holds the state, `DEFERRED.md` holds the gaps with reasons.

## Where the SRS stands

| Milestone | State |
| --- | --- |
| 1. Iron core | **done** — record, replay, assert, hotplug, yield, vault repair |
| 2. GPU terminal and plotter | **mostly done** — frameless shell, WebGL traces with rows, lanes, rails, DVR seek and playback, command builder with CRCs. Missing: a virtualized hex viewport, flow-controlled paste |
| 3. Dissectors and ELF | **partial** — C header parser, CCSDS/CSP/Modbus, DWARF symbols with demangling. Missing: protobuf, MAVLink, defmt/pw_tokenizer, ELF watching, **export** |
| 4. MITM, faults, scripting | **partial** — bridge, all fault primitives, Lua on both directions with fields. Missing: session diff, hardware triggers, X/Y/ZMODEM, 50 µs MITM |

## The three things worth doing next, in order

### 1. More MAVLink messages, from a dialect

The envelope and four bodies decode now (spec 0048). The rest of the common set needs the
dialect XML: parse it, generate the field table, and keep a fixture per message.

Export is done on all three paths (spec 0044): CLI, engine route, ribbon control, and now in
half the time, because a whole-file pass walks the file forward instead of seeking per payload
(D-110 closed).

The vault picker and review mode are done too (spec 0046): the window opens a finished `.bflog`
read-only, lands at its end, and decodes it, because a session copies its workspace beside the
vault (D-111 closed).

Live transmit rows are done too (spec 0045): a forwarding bridge's writes appear as `tx` rows
as they leave. A typed send from the forge does not, which is the small next step if anyone
notices.

## Then, by value

| Item | Why | Estimate |
| --- | --- | --- |
| Hardware triggers (DTR/RTS pulses, the ribbon pin matrix) | Milestone 4, and the guide's band 1 promises it | 1 session |
| Session diff | Milestone 4; compare two vaults by decoded field | 1–2 sessions |
| Signed builds (SignPath Foundation) | Free for OSI projects; the pipeline is ready, the application is a human step (D-95) | a form, then a CI change |
| macOS and Linux shells (D-77) | Only Windows is built and run; CI builds the Windows shell | 1 session on a Mac |
| Long soak on hardware (D-14) | Hours under load is a claim nobody has made yet | a day of babysitting |
| Virtualized hex viewport, flow-controlled paste | Milestone 2's remaining promises | 1 session each |
| X/Y/ZMODEM | Milestone 4; a file transfer protocol is its own small project | 2–3 sessions |
| 50 µs MITM latency (F4.2) | Needs a measurement rig more than code | unknown |

## Not worth doing now

- **Parquet**: a large dependency for a format nobody has asked for; CSV covers analysis.
- **tree-sitter** (D-35): the hand-written C parser works, and the seam is local if it ever
  stops being enough.
- **A light theme and a phone layout**: this is desktop lab software, and the guide says so.
- **Row drag-and-drop** (D-107): assignment by trace order is adequate until someone complains.

## Release

`v0.8.0` carries everything since `v0.7.0`. Cut it when the user says so; then export becomes
the headline of `v0.9.0`.
