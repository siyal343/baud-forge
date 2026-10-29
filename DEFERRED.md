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
| D-01 | Phase 2 GUI: the Tauri shell and the SolidJS workbench | The engine half is done: `bforge serve` publishes the F1.7 contract over loopback HTTP and server-sent events, and a browser draws it (spec 0018). What is left is the shell and the six bands. | The frontend, then a Tauri build (the machine now has MSVC, so this is no longer blocked) | The contract is stable and served; the remaining work is presentation. |
| D-02 | `ui/` frontend | Same as D-01. The design is fixed by `specs/UI-UX-Guide.md`. | D-01 | As above. |
| D-03 | Windows ARM64 and macOS Intel installers | No Tauri build on this machine. CI cross-builds the CLI only. | D-01 plus a release job | Release artefacts for three of six targets do not exist. |
| D-04 | S6b commit `736b1d9` is local, not on origin | Git Credential Manager wants an interactive terminal and there is no SSH key or token in the environment. | `gh auth login`, or `git push` from a normal terminal | The work is safe locally. A lost disk loses one commit. |
| D-05 | Long soaks have not run yet | `specs/0007` measured 60 seconds locally and 512 MiB of vault. A 4 vCPU Linux box is provisioned (`docs/VPS-LAB.md`, `deploy/lab-setup.sh`) for an hour-long run and a 4 GiB read, which is what the numbers need. | Running `deploy/lab-setup.sh` on the VPS, then the soak, then recording the conditions and results in `specs/0007` | The ingestion and memory claims stay short-run until then. |

## 2. Blocked by hardware or by a person

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-06 | Pins polled at 1 kHz (F1.2.3) | Reading CTS, DSR, DCD and RI at 1 kHz needs a device that changes them. The board on the bench is read-only in practice. | A loopback harness that toggles RTS, or a second adapter | Pin state in the UI would update at chunk rate instead of 1 kHz. |
| D-07 | USB tuple binding proved (F1.2.4) | Binding by `vid:pid` and serial needs two identical adapters to prove that order does not decide the match. One board is attached. | A second FTDI or CP210x adapter | A workspace with two identical adapters may bind them by enumeration order. |
| D-08 | Reconnect verified on macOS and Linux | Windows is measured end to end (`specs/0012`: 17 to 47 ms detection, 1 ms reopen, data resumed). The other two platforms need the same unplug test on their own hardware. | A bench with the board on each OS | A platform-specific disconnect classification could be missing. The mapping already covers the common POSIX error kinds. |
| D-48 | The re-enumeration instant is not observed directly | The reader learns the device is back only by opening it, so "within 10 ms of re-enumeration" is derived as poll plus open, both measured, rather than timed end to end. | Polling `available()` during a reconnect and logging the first sighting | The derived figure could hide a slow driver that reports the port before it accepts an open; the 1 ms open call says otherwise. |
| D-49 | A device that returns on a different port number | Reconnect reuses the configured device path. A re-enumerated USB device can come back as COM9 when it was COM8. | Resolving by USB identity inside the reconnect loop, which needs F1.2.4's matcher at run time | A replug into a different hub port needs a new workspace file or a renamed device. |
| D-50 | SIGUSR1 and the GUI hotkey for yield | The control socket works and the CLI is the first client. A signal handler and a key binding are two more clients. | Phase 2, or a user who wants it sooner | Yield needs the CLI today. |
| D-55 | UDP multicast groups are not joined | The socket binds the group address, which some stacks accept and others do not, and no `IP_ADD_MEMBERSHIP` is issued. | A user with a multicast feed | A multicast source may not arrive on Linux. |
| D-51 | The control socket has no authentication | It binds to loopback and accepts one JSON line, so any local process can yield the port or ask for status. For a bench tool that is acceptable; for a shared machine it is a denial-of-service hole. | A token in the endpoint file, or a named pipe with an ACL | A local process can interrupt a recording. |
| D-52 | `tail` does not publish an endpoint | Sessions do; a tail holds a port too. | The same wiring in `Tail::start` | `bforge yield` cannot reach a running `tail`. |
| D-10 | 12 Mbaud sustained on real hardware | The test firmware streams PRBS-31 without pause and was measured at **694 673 B/s** over the ESP32-C3 USB-Serial/JTAG path, which ignores the configured baud rate and tops out below 1.2 MB/s. The 12 Mbaud test needs a real UART bridge (FTDI, CP210x). Since `specs/0016` a socket simulator gives CI a hardware-free path, so only this one number waits for hardware. | A bridge adapter on the bench, or a second board with one | The 0-dropped-bytes figure is proven on a mock source and at 0.69 MB/s over USB, not at 12 Mbaud over a UART. |
| D-11 | MITM latency at 50 µs (F4.2) | Needs two UARTs and a scope. | Phase 4 hardware | Not yet on the critical path. |

## 3. Deliberately later in the plan

| ID | Item | Why deferred | Unblocked by | Risk if delayed |
| --- | --- | --- | --- | --- |
| D-12 | Segment compression, LZ4 or zstd (F1.3.4) | Gate G2 kept plain files. A compressed format should follow a write-throughput measurement and a decision on where the index points. | The measurement from `specs/0007`, then G2 revisit | Vaults are larger than they need to be; 1.2 MB/s of UART data compresses well. |
| D-13 | `memmap2` for the vault (G2 alternative) | Constant memory already comes from seek plus a bounded window, measured at 21.5 MiB peak for a 512 MiB file. | A measurement that shows seek cost dominating | None today. |
| D-53 | The record header costs 12 percent of the file at 0.69 MB/s | 28 912 chunks carried 6.9 MB, so the average chunk was 240 bytes and each carries a 32-byte header. Coalescing short reads would cut the file by a tenth. At 12 Mbaud a read returns a full slab and the cost disappears, so this is a low-rate problem. | The idle-coalescing decision, which belongs with F1.4.5 and the framing consumer | A slow port produces a vault a fifth larger than the data, and more records to index. |
| D-14 | Sequential cursor API for the reader | The reader scans at 25 MiB/s because it seeks twice per record. A window is fast enough; a full 100 GB scan would take about 68 minutes. | F2.3, where the viewport scrolls and needs a forward cursor | Large soaks stay impractical. Full-scan `bforge assert` on 100 GB would be slow. |
| D-16 | Idle-gap framing needs its clock from the caller | `ByteMachine::tick` exists and is tested, but nothing in the read path calls it with a chunk timestamp. | D-15 | A port configured for `idle_gap` produces nothing until then. |
| D-18 | Dissector UI, real tree, field-to-hex highlight | Phase 3, after the GUI. | D-01 | None; the engine side is what S11 builds. |
| D-19 | Telemetry series in the contract | Contract v1 has no time-series field; plots need one. | Phase 2, with the DVR | The GUI cannot plot from the contract yet. |
| D-20 | DTR and RTS in the pin view | The view carries inputs only; the outputs are write-only in the transport. | F1.2.3, which needs the same plumbing | The ribbon cannot show the output state it just set. |
| D-21 | Command forge, script editor, fault studio, session diff view | Phases 2 and 4. | Their phases | None. |

## 4. Deliberate limits in shipped code

| ID | Item | Why | What it would take | Risk |
| --- | --- | --- | --- | --- |
| D-22 | `bforge assert` scans the vault once per check | One pass per needle is simple and measured fine at 100 MB. At 100 GB it is the wrong shape. | An index-backed text search beside the dissector work | Ten checks on a 100 GB vault read it ten times. |
| D-23 | Assert has no regex or timing checks | A regex engine is a dependency for a matcher nobody asked for. Timing assertions need a definition of "late". Field and protocol checks exist now, so the pressure is lower. | A decision, then the Lua runtime in F4.4 | Some expectations cannot be written yet. |
| D-54 | Nothing frames while recording | The vault stays raw on purpose, and `assert` decodes at question time (`specs/0015`). A live recording therefore cannot warn about a bad frame while it happens. | The framing consumer in the record path, which is the other half of D-15 | A user sees frame errors only after the session, by running `tail` or `assert`. |
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
| D-56 | MAVLink v1 and v2 | A MAVLink pack is not a header layout: it needs the dialect XML, a message table and the CRC extra per message. Faking it without a dialect would decode the wrong message at the wrong length. | A dialect file from a real project, which is also the fixture | Drone teams decode MAVLink as raw bytes for now. |
| D-57 | CCSDS packet time codes and segmentation | A PUS time field is optional and its width depends on the time reference status, and a segmented packet needs reassembly. Both are decisions about state, not layout. | A capture with a time code, or a user who needs the timestamp | Service and subservice show, the time does not. |
| D-59 | `bforge serve` has no authentication and answers only on loopback | Any local process can read the stream, and the surface is read-only by design. That is acceptable for a monitor on a development machine and wrong for a shared host. | Serving a non-loopback address, which is also when TLS and a token become necessary | A second user on the same machine can read the capture. |
| D-68 | The scrubber seeks by record ordinal, not wall-clock time, and does not play back | A slider over records is the smallest thing that works and needs no extra index. Seeking by time needs a timestamp index in the vault; playback needs a scheduler and a rate; re-transmitting a window needs the send path with pacing. | A timestamp index in `.bflog`, then a playback loop | A person translates a clock time into a record by hand, and cannot replay a slice at speed. |
| D-69 | The inspector shows a flat field list, not the dissector tree | Every leaf is listed with its offset and width, and hovering marks its bytes. Arrays and nested structs arrive already flattened, so the tree structure that the UI guide draws is not there. | Keeping the parent chain in `DecodedField` and drawing it | Deep structures read as a long flat list. |
| D-66 | No jitter or latency in the fault injector | FR-FLT-01 asks for 0 to 5000 ms of synthetic delay. A delayed write needs a queue with deadlines served by the reader; blocking the reader would stop the receive path, which is the opposite of what a monitor is for. | A scheduling slice in the reader loop | A test that needs a late frame cannot make one. |
| D-67 | No scripted faults | The injector sits on a port's transmit path; the bridge forwards between two ports (spec 0025). FR-SCR-01 runs a sandboxed Lua function per frame, which is a runtime and a sandbox, not a fault profile. | The Lua runtime in `bforge-script` | Faults are per-port and static, not conditional on frame content. |
| D-73 | A bridge does not survive one side being away | The session keeps pumping; a destination that is reconnecting drops the forwarded write with an error. FR-MITM-01 does not specify the behaviour, and a queue with a deadline is the honest answer. | The per-direction queue in D-72 | A cable pull on one side ends the bridge instead of buffering. |
| D-74 | No installer, no signing, no update channel | The desktop artefact is a folder with `bforge-gui.exe` and `ui/` beside it. Bundling needs WiX or NSIS, an icon set and a signing certificate before anyone should run it. **Deferred by the user until the project is near a proper release** (29 October 2026), so the work is not spent before the surface settles. | A release decision: certificates and a bundle target | A person must unzip and run, and Windows will warn about an unsigned binary. |
| D-76 | Placeholder icons | The icons are generated single-colour PNGs and an ICO, made to satisfy the Windows resource step. They say nothing about the product. | A designed mark | The taskbar shows a green square. |
| D-80 | A posted write has no delivery guarantee | The bridge does not wait, so bytes it posted may land later or be refused after a reconnect; `settled` and `failed` count both. FR-MITM-01 does not ask for a retry policy, and inventing one without a deadline would be worse than counting. | A retry queue with deadlines, if a user needs guaranteed delivery | A bridge can lose a write while reporting it as posted. |
| D-79 | Live transmit rows do not exist | A forwarded byte is written by the engine and recorded as `Tx` in the vault, but the live stream carries only what the reader received, so the workbench shows a bridge's writes only when a window is scrubbed. | Feeding the forwarded bytes through a transmit stream, which doubles the decode path | A bridged session looks receive-only while it runs. |
| D-78 | No vault picker in the window | The window records to `--vault` or to a file in the temporary directory. Choosing a file needs a native dialog, which is a Tauri plugin and a question of where sessions live. | A sessions directory setting and the dialog plugin | A person must pass a path or find the file in `%TEMP%`. |
| D-77 | The shell is verified on Windows only | Tauri builds on macOS and Linux, but neither was run here; the CI job builds Windows because that is the platform with the toolchain in place. | A macOS or Linux machine, or a runner with the webkit packages | A Linux user has no artefact. |
| D-70 | No source text in the crash badge | The badge shows the function, the file and the line; reading the file and showing a few lines around it needs a source root in the workspace and a path mapping from build machine to this one. | A source root setting, plus the file read behind a request | A person copies the path into their editor by hand. |
| D-71 | Crash addresses are found in numeric fields only | A firmware that prints `HardFault: PC: 0x140001480` as text has its address in characters. `scan_pointers` reads such text, but it is not wired into the frame path. | Decoding text frames, or a per-port `symbolize_text` flag | A text crash line shows as text with no badge. |
| D-64 | Sends are hex bytes, not typed fields | Band 5 in the UI guide is field pills with a live encoded preview: pick `battery_mv`, type 7400, see the bytes. That needs an encoder that walks the dissector IR in reverse, including bitfields and CRCs, and a schema that says how to lay a frame out. Hex is honest and works today. | An encoder slice over the same IR the decoder reads, with fixtures that round-trip | A person must assemble frame bytes by hand and add their own checksum. |
| D-65 | Sends are not in the UI contract | A send is an action, not session state, and the workbench keeps its own log of the last six. A second client cannot see what the first sent, and a vault does not record it. | A `sent` event in the contract, plus a vault record type for transmit chunks | Two people watching one session cannot see each other's writes. |
| D-63 | The plot band is SVG, not WebGL; one series, no state lanes | A line plot of 600 samples is cheap in SVG and a plot library would be a dependency for one chart. The UI guide's 60 FPS multi-series lane view needs a renderer and a downsampling policy. | A request for overlaid series or long history | A 60 Hz redraw of several thousand points would drop frames. |
| D-60 | The served page is a placeholder, not the six-band workbench | The page exists to prove that the contract reaches a screen with live numbers. The UI guide describes bands, panels and interaction that a single HTML file cannot carry honestly. | The SolidJS frontend from `specs/UI-UX-Guide.md` | The GUI surface matrix stays unmet for the bands; the session, ports and events are visible. |
| D-58 | Modbus functions beyond coils and registers | 0x0F, 0x10 and the diagnostic functions have their own layouts and their own error cases. | Demand from a Modbus user | An uncommon function shows address, function and CRC only. |
| D-41 | Checksum status comes out as `NotApplicable` | The schema does not say where the checksum sits or which engine it uses. | A schema field for the checksum, plus F1.4.6 wiring | The CRC chip in the inspector will stay empty until then. |
| D-42 | `defmt` and `pw_tokenizer` frame decoding (F3.6) | Both wire formats are versioned and interned, and there is no firmware image or captured frame on this machine to verify a decoder against. A decoder that is wrong is worse than none: it prints confident nonsense. | A captured `defmt` or `pw_tokenizer` frame from real firmware, plus the exact crate version that produced it | A Rust or Pigweed team sees hex instead of log text. |
| D-43 | Watching the `.elf` for changes (F3.5 second half) | `notify` is a runtime loop with per-OS backends, and nothing in the pipeline consumes a reload yet. | The live decode path (D-45) | A rebuild needs a manual reload. |
| D-44 | Demangling Rust symbol names | A demangler is another dependency, and the badge works with the mangled name today. | Demand from a Rust firmware user | Badges show `_RINvNtNt...` for generic frames. |
| D-45 | Badges in the live stream, source popover, editor launch (F3.8) | Needs the GUI to render the badge and to decide what a click does when the editor is absent. | D-01 | Symbolization exists only in tests and the example. |
| D-47 | Frame timestamps have slab resolution | A frame inherits the timestamp of the read that completed it, so a burst inside one slab shows `+0us` for every frame. Per-byte timing needs the baud rate, a byte counter and interpolation. | A decision on whether the UI needs sub-slab timing | A timing regression inside one burst is invisible; the DVR scrubber would show a flat delta. |
| D-46 | No firmware image to symbolize | The board runs a sketch whose `.elf` we do not have, and the ARM toolchain is not installed. The demo uses our own debug binary, which exercises the same code path. | A `.elf` from the user's build, or `arduino-cli compile --output-dir` on a sketch | The feature is proven on a PE/DWARF host binary, not on ARM firmware. |

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
| — | Framing and dissection wired into a read path (tail) | `specs/0011` |
| — | Framing settings expressible in `.bforge.toml` (was D-17) | `specs/0011` |
| — | ELF symbolizer (S12) | `specs/0010` |
| — | Hotplug and reconnect on Windows (D-08, F1.2.5) | `specs/0012` |
| — | Port yield over a local control socket (F1.2.6, F1.5.6) | `specs/0013` |
| — | Flash while the port is yielded (D-09) | `specs/0014`, `firmware/bforge_test` |
| — | Assert on decoded fields (D-15, useful half) | `specs/0015` |
| — | TCP, UDP and a device simulator in the config (F1.2.7) | `specs/0016` |
| — | CCSDS with PUS, CSP and Modbus RTU (most of F3.4) | `specs/0017` |
| — | The UI contract over loopback HTTP with server-sent events (F1.7.2) | `specs/0018` |
| — | The SolidJS workbench drawing the live stream and decoded fields | `specs/0019` |
| — | Numeric series and the telemetry plot | `specs/0020` |
| — | `POST /api/send`: bytes from the browser to the port, written by the reader thread | `specs/0021` |
| — | Fault profiles on the transmit path, with a reproducible seed | `specs/0022` |
| — | Scrubber: a decoded window of a vault, read while it is being written | `specs/0023` |
| — | Address badges: code addresses in frames resolved to a function and a line | `specs/0024` |
| — | Bridge and tap between two ports, with forwarded bytes recorded as transmit | `specs/0025` |
| — | Desktop shell: the workbench in a Tauri window, over the same HTTP surface | `specs/0026` |
| — | The window records, and the first open now waits for the device | `specs/0027` |
| — | Direction on every frame row, from the record it came from | `specs/0028` |
| — | Paired bus view: one bridge's two ports in one time-ordered table | `specs/0029` |
| — | A bridge posts instead of waiting, with counters and a queue bound | `specs/0030` |
