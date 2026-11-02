# What is next

> **Taking over this project?** Start at [`handoff/README.md`](handoff/README.md). That directory
> maps the code, the conventions, the traps and the remaining work for an agent or a person who
> is new to the tree.

Written 2 November 2026. Both fast-build waves are complete and green:
- **Wave 1:** Semantic session diff (`specs/0050`), virtualized 10,000-frame stream and paged hex dump (`specs/0051`), timed pin sequencer and flow-controlled paced sends (`specs/0052`), and `.proto` schema field naming (`specs/0053`).
- **Wave 2:** MAVLink XML dialect loader with wire reordering and `CRC_EXTRA` validation (`specs/0054`), `defmt` and `pw_tokenizer` ELF token decoding (`specs/0055`), XMODEM/YMODEM file transfers (`bforge xfer`, `specs/0056`), and Workbench UI surfaces for Session Diff, Pin Sequences, and Paced Sends plus Linux/macOS desktop CI (`specs/0057`).

## Where the SRS stands

| Milestone | State |
| --- | --- |
| 1. Iron core | **done** — record, replay, assert, hotplug, yield, vault repair, forward export |
| 2. GPU terminal and plotter | **done** — frameless shell, virtualized stream & hex viewport, WebGL traces with rows/lanes/rails, DVR seek and playback, typed command forge, paced sends |
| 3. Dissectors and ELF | **done** — C header parser, CCSDS/CSP/Modbus, MAVLink (built-in + XML dialects), Protobuf (wire + `.proto`), DWARF symbols with demangling, `defmt` & `pw_tokenizer` decoding, export |
| 4. MITM, faults, scripting | **done** — bridge, all fault primitives, Lua on both directions with fields, semantic session diff (CLI + route + UI), timed pin sequencer (API + UI), XMODEM/YMODEM transfers (`bforge xfer`) |

## Remaining non-code / hardware items

| Item | Why | Action required |
| --- | --- | --- |
| Signed builds (SignPath Foundation) | Free for OSI projects; SignPath and `.pfx` CI hooks are wired in `.github/workflows/release.yml` (`D-95`) | Paste the pre-filled table from `docs/SIGNING.md` into the SignPath form and add `SIGNPATH_API_TOKEN` + `SIGNPATH_ORGANIZATION_ID` |
| Long soak on hardware (`D-05`) | 600 s / 2.90 GB and 1 GiB memory soak verified in CI (`specs/0007`); physical multi-hour hardware soak needs a bench | Plug in the ESP32-C3 or run `deploy/lab-setup.sh` on a Linux VPS (`docs/VPS-LAB.md`) |
| 50 µs MITM latency (`D-11`) | Oscilloscope measurement between physical UART RX and TX pins | Measure with two UART adapters and a scope |
