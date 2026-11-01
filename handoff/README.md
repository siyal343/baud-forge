# Handoff

This directory is written for the agent that takes over BaudForge. Read it in order. It tells
you what exists, what is left, how this repository expects work to be done, and where the traps
are.

Written 1 November 2026 at commit `3f061e4`, tag `v0.8.0` published, CI green on nine jobs.

## Reading order

| Order | File | What it gives you |
| --- | --- | --- |
| 1 | [`01-STATE.md`](01-STATE.md) | Where the tree is: versions, numbers, releases, what is proven |
| 2 | [`02-ARCHITECTURE.md`](02-ARCHITECTURE.md) | The nine crates, the data path, the seams to extend |
| 3 | [`03-CONVENTIONS.md`](03-CONVENTIONS.md) | How code, commits, specs and documents are written here |
| 4 | [`04-BUILD-AND-TEST.md`](04-BUILD-AND-TEST.md) | Exact commands on this machine, and what breaks |
| 5 | [`05-REMAINING-WORK.md`](05-REMAINING-WORK.md) | The backlog in priority order, with starting points |
| 6 | [`06-VERIFICATION-PLAYBOOK.md`](06-VERIFICATION-PLAYBOOK.md) | How to prove a change, including live runs and screenshots |
| 7 | [`07-INVARIANTS.md`](07-INVARIANTS.md) | Rules that must not break, and the reason for each |
| 8 | [`08-TRAPS.md`](08-TRAPS.md) | Mistakes that have already cost time here |
| 9 | [`09-FIRST-SESSIONS.md`](09-FIRST-SESSIONS.md) | A concrete plan for your first three sessions |

The project's own documents stay authoritative and are **not** replaced by this directory:

- `README.md` — what the tool is
- `STATUS.md` — current state, numbers and evidence
- `NEXT.md` — the forward plan
- `DEFERRED.md` — every gap with its reason and the condition that brings it back
- `IMPLEMENTATION.md` — the plan of record, including "How we work"
- `specs/NNNN-*.md` — one file per feature, the format is in `specs/README.md`
- `RELEASE-NOTES.md` — one section per release

## In one paragraph

BaudForge is a serial and network protocol workbench in Rust: it records a session to a binary
vault, decodes frames with a C header parser, five native protocol packs and an ELF symbolizer,
injects faults, bridges two ports, exports captures, and shows all of it in a Tauri desktop
window with a WebGL telemetry band. It is 23,487 lines of Rust and 1,854 lines of TypeScript,
299 tests, thirteen releases, and 52 specs. What is
missing is a small, well-defined list in `05-REMAINING-WORK.md`, not a rewrite.

## Rules you inherit

These three are not negotiable, because the repository's credibility rests on them:

1. **A number is a measurement or it is marked as an estimate.** Never present one as the other.
2. **A gap is written down before it is fixed, and closed with a commit.** `DEFERRED.md` holds
   the reason and the condition that brings the item back.
3. **Releases are cut when the user says so.** They are paused right now: do not tag.

Everything else — style, test discipline, spec format — is in `03-CONVENTIONS.md`.
