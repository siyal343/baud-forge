# Fast-Build Analysis and Acceleration Plan

Written 2 November 2026 at commit `93ce5d8`. All measurements below were run on this machine; estimates are explicitly labeled.

## 1. Diagnosis: Why the Project Is Dragging

The engine and workbench are already 85% complete (`v0.8.0` tagged, 23,487 lines of Rust, 1,854 lines of TypeScript, 299 tests passing). The project feels slow not because the architecture is broken, but because of **five friction points**:

### 1.1 Ceremony Overhead exceeds Code Size (Measured)
- **8-step serial loop** (`handoff/06-VERIFICATION-PLAYBOOK.md`): Every small change updates up to 5 markdown files (`specs/NNNN-*.md`, `DEFERRED.md`, `NEXT.md`, `STATUS.md`, `PLAN.md`), runs a full workspace test pass, launches two simulators and the GUI window, captures screenshots via PowerShell + Python PIL, and waits ~9 minutes for 9 CI jobs.
- **Document drift** (Measured):
  - `STATUS.md` is stuck at `v0.5.2` (claims 268 tests, 35 specs, SVG plots, flat inspector).
  - `PLAN.md` claims Phase 2, 3, and 4 are "not started" at the top, followed by 44 completed stage rows in reverse order.
  - `DEFERRED.md` has **79 open rows**, including items that are already shipped (`D-01` Tauri shell, `D-02` `ui/` frontend, `D-04` local commit, `D-14` sequential cursor, `D-18` tree inspector, `D-19` telemetry series, `D-60` placeholder page, `D-64` typed sends, `D-97` license file).
  - Maintaining four overlapping status ledgers (`PLAN.md`, `STATUS.md`, `NEXT.md`, `DEFERRED.md`) plus `handoff/` wastes half of every session.

### 1.2 Test Suite Wall-Clock Drag (Measured: 36.7 s)
- Compiling tests with `--no-run` takes **13.9 s** (measured).
- Running `cargo test --workspace --exclude bforge-gui` takes **36.7 s** (measured) for 299 tests, and compiles **35 separate test binaries** across the workspace.
- **69% of test execution time (23.9 s)** sits in 4 integration test binaries that sleep on wall-clock timers:
  - `crates/bforge-core/tests/serve.rs`: **9.43 s** (15 tests)
  - `crates/bforge-cli/tests/cli.rs`: **6.34 s** (14 tests)
  - `crates/bforge-core/tests/reconnect.rs`: **3.11 s** (7 tests)
  - `crates/bforge-core/tests/pipeline.rs`: **3.06 s** (5 tests)
  - `crates/bforge-core/tests/session.rs`: **2.01 s** (4 tests)
- All unit tests across `bforge-dissect`, `bforge-framer`, `bforge-storage`, `bforge-elf`, and `bforge-script` finish in **< 0.35 s total**.

### 1.3 Target Directory and Legacy Root Clutter (Measured)
- The root `Cargo.toml` defines a dummy binary `baud-forge` (`src/main.rs`, 68 bytes) and dead `src/legacy/` code (`porti-rs` leftovers: `frame.rs`, `ring_buffer.rs`, `stats.rs`, ~9.7 KB) that is not used by any of the 9 workspace crates.
- `handoff/04-BUILD-AND-TEST.md` splits builds across three target directories (`target/`, `/tmp/bf-msvc`, `/tmp/bf-target`), destroying incremental Rust compilation cache between CLI, simulator, and GUI runs.

### 1.4 Monolithic Bottleneck Files (Measured)
Parallel work is blocked because every feature edits the same three files:
- `crates/bforge-core/src/serve.rs` (**47.6 KB**, 1,347 lines) — HTTP parsing, SSE broadcast, and all route handlers in one file.
- `crates/bforge-core/src/session.rs` (**43.2 KB**, 1,141 lines) — port binding, pump loop, bridge forwarding, fault injection, and replay in one file.
- `ui/src/App.tsx` (**40.5 KB**, 1,044 lines) — stream table, hex dump, field tree inspector, command forge, fault controls, and ribbon in one component.

### 1.5 Scope Dilution Across 79 Deferred Items
- Treating hardware-blocked items, nice-to-have protocol packs, and core product gaps equally makes the backlog look endless.
- In reality, **only 4 features** stand between the current tree and a complete 4-milestone SRS product (`v1.0.0`).

---

## 2. Structural & Workflow Fixes to Move 3x Faster

### 2.1 Cut the Ceremony in Half
1. **Single source of truth for backlog and status**: Keep `NEXT.md` (active plan) and `DEFERRED.md` (pruned to real open gaps). Freeze `PLAN.md` and `STATUS.md` as historical records or update `STATUS.md` only at release cuts.
2. **Batch specs and docs per feature, not per micro-step**: Write one spec per feature, verify with targeted tests during development, and run the full gate once at commit time.
3. **Stop manual GUI screenshot crops on backend/CLI tasks**: Only run `shot.ps1` when modifying `ui/` layout or WebGL rendering.

### 2.2 Speed Up the Build and Test Loop (36.7 s → < 2 s inner loop)
1. **Remove root `baud-forge` dummy package and `src/legacy/`**: Convert the root `Cargo.toml` into a pure virtual workspace manifest (`[workspace]`). This removes 3 useless test binaries and dead code.
2. **Unify `CARGO_TARGET_DIR`**: Use the workspace `target/` directory with `stable-x86_64-pc-windows-msvc` everywhere (already the default toolchain on this machine) so `cargo test`, `bforge-cli`, and `bforge-gui` share compiled dependencies.
3. **Targeted test runs during coding**: Run `cargo test -p <crate> --lib` (< 0.5 s) while iterating; run the slow socket/reconnect integration tests only before committing.

### 2.3 Split the Contended Files So Subagents Do Not Collide
If we run subagents in parallel, they must touch separate files:
- Extract new core features into dedicated modules (`crates/bforge-core/src/diff.rs` for session diff) rather than piling more code into `session.rs`.
- Extract new UI views into `ui/src/components/` (`VirtualStream.tsx`, `DiffView.tsx`) instead of growing `App.tsx`.

---

## 3. Focused "Finish the Product" Scope (`v1.0.0` Cut)

Instead of nibbling at 79 deferred items one session at a time, we can finish the four remaining high-value deliverables in **one parallel wave**:

| Track | Deliverable | Scope | Files Touched | Estimate |
| --- | --- | --- | --- | --- |
| **Track 1: Session Diff (A1)** | Milestone 4 headline feature: compare two `.bflog` vaults (`bforge diff a.bflog b.bflog`, `/api/diff`, and UI diff report). | New `crates/bforge-core/src/diff.rs`, CLI subcommand, `/api/diff` route, spec `0050`. | `bforge-core/src/diff.rs`, `bforge-cli/src/main.rs`, `serve.rs` | ~20 mins with subagent |
| **Track 2: Virtualized Stream & Flow-Controlled Paste (A2 + A3)** | Close Milestone 2: virtualize the stream/hex viewport in `ui/` so scrolling 300k records stays at 60 FPS, plus paced chunk sending in `send`. | Virtual scroll window in `ui/src/App.tsx`, `pace_ms` / chunked write in `session.rs`. | `ui/src/App.tsx`, `session.rs`, spec `0051` | ~20 mins with subagent |
| **Track 3: Timed Pin Sequencer (A4)** | Close FR-HAL-04 (`D-114`): execute a multi-step pin sequence (`DTR`/`RTS`/`wait_ms`) on the reader thread for bootloader entry. | Extend `PinJob` / `set_pins` in `pipeline.rs` and `/api/pins` to accept a step slice; mock transport test. | `pipeline.rs`, `session.rs`, `serve.rs`, spec `0052` | ~15 mins with subagent |
| **Track 4: Repo Cleanup & Doc Consolidation** | Prune stale `DEFERRED.md` entries that are already done, update `STATUS.md` to `v0.8.0+`, remove dead `src/legacy/` dummy root package, and add Linux/macOS desktop build check to CI (`B1`). | `Cargo.toml`, delete `src/`, update `DEFERRED.md`, `STATUS.md`, `.github/workflows/ci.yml`. | Root docs, `Cargo.toml`, `ci.yml` | ~15 mins |

*(Note: If you also want `C1` MAVLink XML dialect loading or `C3` `.proto` file naming in this wave, a fourth subagent can build `bforge-dissect` packs in complete isolation inside `crates/bforge-dissect/`.)*

---

## 4. Subagent Orchestration Plan

Because Tracks 1, 2, 3, and 4 touch mostly distinct crates or modules, we can execute all of them right now in parallel using isolated `branch` workspaces:

1. **Subagent 1 (`Engine Diff`)** — Builds `crates/bforge-core/src/diff.rs` + `bforge diff` CLI + unit tests.
2. **Subagent 2 (`Frontend & Paste`)** — Virtualizes the stream list in `ui/src/App.tsx` and adds paced send support.
3. **Subagent 3 (`HAL Pin Sequencer`)** — Implements multi-step timed `DTR`/`RTS` sequences in `pipeline.rs` with mock tests.
4. **Main Agent (Coordinator)** — Cleans up `src/legacy/`, prunes `DEFERRED.md` & `STATUS.md`, merges the subagent branches, wires the `/api/diff` and `/api/pins` routes in `serve.rs`, runs the verification gate once, and commits cleanly.
