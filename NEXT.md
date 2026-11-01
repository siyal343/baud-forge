# What is next

> **Taking over this project?** Start at [`handoff/README.md`](handoff/README.md). That directory
> maps the code, the conventions, the traps and the remaining work for an agent or a person who
> is new to the tree.

Written 2 November 2026. The tree is at `v0.8.0` plus the fast-build wave: session diff (`specs/0050`), virtualized stream and paged hex dump (`specs/0051`), timed pin sequencer and flow-controlled paced sends (`specs/0052`), and `.proto` schema field naming (`specs/0053`).

## Where the SRS stands

| Milestone | State |
| --- | --- |
| 1. Iron core | **done** — record, replay, assert, hotplug, yield, vault repair, forward export |
| 2. GPU terminal and plotter | **done** — frameless shell, virtualized stream & hex viewport, WebGL traces with rows/lanes/rails, DVR seek and playback, typed command forge, paced sends |
| 3. Dissectors and ELF | **done for core packs** — C header parser, CCSDS/CSP/Modbus/MAVLink, Protobuf wire + `.proto` schema, DWARF symbols with demangling, export. Optional depth: MAVLink XML dialect loader (`D-56`), `defmt`/`pw_tokenizer` (`D-42`) |
| 4. MITM, faults, scripting | **done for core features** — bridge, all fault primitives, Lua on both directions with fields, semantic session diff (`specs/0050`), timed pin sequencer (`specs/0052`). Optional depth: X/Y/ZMODEM, 50 µs hardware scope rig (`D-11`) |

## Remaining optional items, by value

| Item | Why | Estimate |
| --- | --- | --- |
| Signed builds (SignPath Foundation) | Free for OSI projects; the pipeline is ready, the application is a human step (`D-95`) | a form, then a CI secret |
| macOS and Linux shells (`D-77`) | Only Windows is built and run locally; CI builds the Windows shell | 1 session on a Mac/Linux runner |
| MAVLink dialect XML loader (`D-56`) | Decode arbitrary dialect messages beyond the common four (`specs/0048`) | 1 session once dialect XML is chosen |
| Long soak on hardware (`D-05`) | Multi-hour hardware soak on a physical bench | a day of hardware soak |
| X/Y/ZMODEM | File transfer state machine | 2–3 sessions |
