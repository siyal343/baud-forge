# 0057 Workbench diff, pins, and desktop CI

Status: accepted (2 November 2026). Closes D-77.

## Problem

The backend provided semantic session diff, multi-step pin sequences, and paced
transmit buffers. The web workbench UI had no visual controls to invoke these
capabilities. Users could not compare recorded vaults from the browser ribbon.
Users could not trigger board bootloader sequences from port cards. Transmit
buffers sent without pacing in the command forge. Furthermore, CI verified the
desktop GUI shell on Windows only (`D-77`). Linux and macOS desktop builds were
not tested in CI.

## Scope

- Interactive session diff panel in the workbench ribbon and timeline scrubber.
- Hardware pin boot sequence button and custom sequence editor in the port card.
- Flow-controlled paced send inputs in the command forge.
- Cross-platform desktop CI matrix for Linux and macOS (`desktop-unix`).

Out of scope:
- Standalone diff visualizer window outside the workbench shell.
- Hardware GPIO lines beyond DTR and RTS.
- Package bundling installers on Linux or macOS.

## Behavior

1. The ribbon and timeline scrubber contain a `diff` toggle button.
2. Clicking `diff` reveals a comparison input panel.
3. The diff panel accepts comparison vault path `b` and optional source vault path `a`.
4. Leaving vault path `a` empty compares against the active session recording.
5. Submitting the diff form sends a `GET /api/diff?b=<path>` or `?a=<pathA>&b=<pathB>` request.
6. When vaults match, the panel renders an `identical` chip badge with chunk and frame counts.
7. When vaults diverge, the panel renders a `diverged` chip badge and the first divergence details.
8. The diff panel renders a table of `changed_fields` showing `frame`, `port`, `field`, `value in a`, and `value in b`.
9. The port card includes a `boot seq` button that triggers the standard ESP32/STM32 bootloader sequence.
10. The port card includes a sequence toggle button (`seq ▾`) that reveals a custom transition input.
11. The sequence parser accepts either a JSON array or arrow-delimited transitions (`DTR=0,RTS=1,50ms -> DTR=1,RTS=0`).
12. Running a pin sequence posts `steps` to `POST /api/pins`.
13. The command forge includes compact inputs for chunk size (`chunk B`) and pace interval (`pace ms`).
14. When chunk size is greater than zero, `POST /api/send` includes `chunk_size` and `pace_ms`.
15. GitHub Actions workflow `.github/workflows/ci.yml` runs a `desktop-unix` matrix job on `ubuntu-latest` and `macos-latest`.
16. The Linux runner installs required WebKit and serial libraries before building `bforge-gui`.
17. The job verifies `cargo check -p bforge-gui --locked` and `cargo build -p bforge-gui --locked` on Linux and macOS.

## Measured

- Frontend production bundle build (`npm run build`):
  TypeScript compilation and Vite bundle pass in 1.26 s.
  Assets generated: `dist/index.html` (0.45 kB), `dist/assets/index-*.css` (14.08 kB), `dist/assets/index-*.js` (57.29 kB).
- Tauri desktop host compilation (`cargo check -p bforge-gui`):
  Compiles cleanly with zero warnings or errors in 11.12 s.

## Test

Run the frontend build and type checks:
```sh
cd ui
npm run build
```

Run the desktop shell check:
```sh
cargo check -p bforge-gui --locked
```

## Limits, recorded

- Large diff reports: `changed_fields` displays up to 64 differences due to the backend response cap.
- Desktop packaging: CI verifies `cargo build -p bforge-gui` on Unix runners; full `.deb`/`.dmg` packaging remains deferred to release workflows.
