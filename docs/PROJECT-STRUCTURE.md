# BaudForge Project Structure

Repository: `https://github.com/siyal343/baud-forge`

## Directory tree

```text
baud-forge/
├── .github/workflows/     # CI: ci.yml, nightly.yml, pages.yml (docs site), release.yml
├── crates/                # Rust workspace — nine crates, bottom-up:
│   ├── bforge-hal/        #   transports: UART, TCP/UDP sockets, modem lines, hotplug, SIL generator
│   ├── bforge-framer/     #   framing: line, COBS, SLIP, length-prefix; CRC-8/16/32
│   ├── bforge-dissect/    #   dissection: C headers, Protobuf, CCSDS, CSP, MAVLink, Modbus RTU
│   ├── bforge-elf/        #   symbols: ELF/DWARF, defmt & pw_tokenizer, backtrace resolution
│   ├── bforge-script/     #   sandboxed Rhai scripts on the send/receive path
│   ├── bforge-storage/    #   .bflog append-only vaults, .bfidx index, format exporters
│   ├── bforge-core/       #   SPMC pipeline, sessions, HIL fault injection, HTTP/SSE contract
│   ├── bforge-cli/        #   headless engine & `bforge` CLI (serve, record, replay, diff, assert, xfer)
│   └── bforge-desktop/    #   Tauri v2 desktop shell hosting the workbench
├── ui/                    # React 19 + TypeScript + Vite + Tailwind + Dockview workbench
│   ├── src/               #   panels, Zustand workstation store, simulation engine
│   ├── scripts/           #   ui-smoke (headless browser), build-docs, activity-live-check
│   └── public/            #   popout-window host
├── specs/                 # numbered feature specs (0001–0057) cited by code, tests and commits
├── docs/
│   ├── src/               # user-documentation markdown sources
│   ├── site/              # built user docs site (deployed to GitHub Pages by pages.yml)
│   ├── PROJECT-STRUCTURE.md  # this document
│   ├── QUICKSTART.md      # getting started & troubleshooting
│   ├── HARDWARE_CHECKLIST.md / HARDWARE_VALIDATION.md  # real-hardware guides
│   ├── SIGNING.md         # release signing (SignPath Foundation)
│   └── VPS-LAB.md         # what the Linux VPS lab can and cannot do
├── examples/              # Rhai transform scripts + .bforge.toml launcher profiles
├── firmware/              # Arduino test firmware streaming demo telemetry
├── scripts/               # real-hardware link validation (Python)
├── dashboards/            # declarative XML dashboard templates
├── schemas/               # dashboard XML schema (XSD)
├── deploy/                # lab setup automation
├── e2e/                   # engine end-to-end drivers (bridge/REC, duration exit, XMODEM)
└── local/                 # gitignored: working design, planning, context & handoff docs
```

## How the pieces fit

- **Data path:** `bforge-hal` pulls bytes from the wire → `bforge-framer` slices
  frames and checks CRCs → `bforge-dissect` decodes fields → `bforge-core` fans the
  packets out over the SPMC pipeline → the workbench consumes them over HTTP/SSE
  (browser) or the Tauri bridge (desktop).
- **Records:** `bforge-storage` writes every session to an append-only `.bflog`
  vault, seeks via the `.bfidx` sidecar, and replays or exports it.
- **Enhancers:** `bforge-elf` feeds symbol names and struct layouts in from the
  firmware image; `bforge-script` sits on the send/receive path for transforms.
- **Entry points:** `bforge-cli` runs headless (soak, CI, the VPS lab);
  `bforge-desktop` is the operator-facing window.

## Notes

- `specs/` is the contract: each feature has a numbered spec, and tests and commit
  messages cite the numbers.
- `local/` is intentionally outside the repository: design-iteration reports,
  planning notes and agent-session context live there, gitignored.
- Rebuild the user docs site with `node scripts/build-docs.mjs` from `ui/`
  (renders `docs/src/*.md` → `docs/site/*.html`).
