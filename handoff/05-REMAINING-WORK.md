# 05 — Remaining work

The list is ordered by value per session, not by difficulty. Every item names its starting point
so you do not begin by searching.

Estimates are **estimates**, one agent working day each, and they are marked as such where they
appear.

## Tier A — product completeness

### A1. Session diff (Milestone 4; D-21 names the view, the engine half has no entry)

**What.** Compare two vaults: decoded fields that changed, frames that appeared or vanished, and
the first record where the two diverge. The SRS calls this semantic session diffing.

**Why it matters.** It is the feature that turns a capture into evidence: "this run was different
from the last good one" is the question every failure investigation asks.

**Start at.** `crates/bforge-core/src/tail.rs` (`decode_window`, `raw_window`) for decoding a
range, `crates/bforge-core/src/assert.rs` for the existing rule/issue machinery that a diff can
reuse, `crates/bforge-core/src/serve.rs` for a `/api/diff` route, `crates/bforge-cli/src/main.rs`
for `bforge diff a.bflog b.bflog`.

**Acceptance.** `bforge diff a.bflog b.bflog` prints the first divergence with record numbers and
field names; a route serves the same; a test builds two small vaults with one changed field and
asserts the diff names it.

**Estimate.** 1–2 sessions.

### A2. A virtualized hex viewport (Milestone 2's remaining promise)

**What.** The stream shows 120 rows from a slice. The SRS asks for a virtualized hex/ANSI
terminal that scrolls a large capture without growing the DOM.

**Why.** Reviewing a 300,000-record capture in the window is the common case now that review mode
exists.

**Start at.** `ui/src/App.tsx` (the stream table and `shown()`), `ui/src/lib/feed.ts` for the
window fetch, `crates/bforge-core/src/serve.rs::vault_frames`.

**Acceptance.** Scrolling a 300 MB vault stays smooth; a measurement of frame time at 60 Hz on
this machine, written into the spec.

### A3. Flow-controlled paste (Milestone 2)

**What.** Paste a block of bytes and let the engine pace it against the port's flow control
instead of writing it in one burst.

**Start at.** `crates/bforge-core/src/session.rs::send`, `crates/bforge-core/src/pipeline.rs::write`,
`ui/src/App.tsx` (the forge).

### A4. A timed pin sequence (D-114)

**What.** A pin cannot be pulsed on a schedule today. A boot-loader entry or a reset loop needs a
sequence: hold DTR, wait, release, wait, set RTS.

**Start at.** `crates/bforge-core/src/pipeline.rs::set_pins_one` (already holds the reader for a
pulse), `session.rs::set_pins`, the `/api/pins` route.

**Acceptance.** A sequence runs on the reader thread without starving reads between steps; a test
with the mock transport proves the order and the gaps.

**Estimate.** 1 session. Needs hardware to be worth doing.

## Tier B — reach and trust

### B1. macOS and Linux desktop builds (D-77)

**What.** The window is built and run on Windows only. CI compiles the shell on Windows.

**Why.** Every note in `docs/GUI-SETUP.md` about platform behaviour is untested for two of the
three platforms.

**Start at.** `.github/workflows/ci.yml` (the `desktop (windows)` job), `crates/bforge-gui/src-tauri/tauri.conf.json`,
`crates/bforge-gui/src-tauri/src/main.rs` (`restore_geometry`, `ui_directory`).

**Acceptance.** A macOS job that launches the app headless and screenshots it, or a human run
recorded in `docs/GUI-SETUP.md` with the numbers.

### B2. Signing (D-95, D-96)

**What.** Binaries are unsigned and macOS builds are not notarised. The pipeline is ready; the
certificate is a human step (SignPath Foundation is free for OSI projects).

**Start at.** `.github/workflows/release.yml`, `docs/SIGNING.md`.

### B3. Long soak on hardware (D-14)

**What.** Nobody has left this running for hours against a real device. The nightly workflow
soaks the mock.

**Acceptance.** A recorded run with the numbers: memory, dropped frames, reconnect count.

## Tier C — protocol coverage

### C1. MAVLink bodies from a dialect (D-56)

The envelope and four bodies decode (spec 0048). The rest need a dialect XML: parse it at build
time or at load time, generate a field table, and keep one fixture per message. **Ask the user
for their dialect** before starting; guessing offsets is how a decoder prints confident nonsense.

### C2. defmt and pw_tokenizer (D-42)

Rust firmware logging. `defmt` needs the format table embedded in the ELF, which
`crates/bforge-elf` can read; `pw_tokenizer` needs the token database. Both are ELF-adjacent, so
they belong beside the symbolizer.

### C3. Protobuf with a `.proto` (D-112)

Fields are `field_7` today. A `.proto` parser plus a workspace setting turns them into names. A
minimal parser handles `syntax`, `message`, `field` with numbers and types; that is enough for
naming.

### C4. `defmt`, CCSDS time codes, Modbus coverage, X/Y/ZMODEM

D-57, D-58, D-42. Each is self-contained behind an existing seam. X/Y/ZMODEM is the largest:
2–3 sessions.

## Tier D — engine refinements

| Item | Deferred | What it takes |
| --- | --- | --- |
| A bridge survives one side away (D-73) | D-72 queue | A per-direction queue with a deadline |
| Frames survive a reconnect (D-92) | — | Decide whether a held frame is flushed or dropped, then do it |
| Live frame delivery guarantee (D-81) | — | The batch is replaced today; a client that needs every frame needs a queue policy |
| A posted write has no delivery guarantee (D-80) | — | The counter exists; the report does not |
| Auth for `bforge serve` (D-59) | — | A token, and a decision about remote access |
| One schema per port in a script (D-94) | — | Scripts assume one schema |
| Crash badge source text (D-70) | — | A source root setting and a file read behind a route |
| Enums are four bytes, arrays of structs unexpanded (D-89, D-90) | — | Schema work in the C header parser |
| Rows are assigned in trace order (D-107) | — | A row model a person can edit |
| `bforge status` is a probe, not a daemon (D-27) | — | A daemon mode |
| Contract test covers 25 fields (D-30) | — | Extend `tests/contract.rs` |

## Explicitly not worth doing now

- **Parquet export** (D-109): a large dependency, nobody has asked, CSV carries the columns.
- **`tree-sitter-c`** (D-35): the hand-written parser works; revisit only if it fails on real
  headers.
- **A light theme and a phone layout** (D-34): desktop lab software, and the UI guide says so.
- **Segment compression** (D-item): the vault is 12% overhead at 0.69 MB/s; compression buys
  little for the complexity.

## How to choose

If the user gives no direction, take **A1 session diff**: it is the largest missing feature a
person would notice, it needs no hardware, and it reuses machinery that exists.

If the user is a drone team, ask for the dialect and take **C1**.

If the user wants to ship, take **B1** and **B2** together: a desktop application that only runs
on one platform and is unsigned cannot honestly be called released.
