# 09 — Your first sessions

A plan for the first three sessions. Each ends at a green tree with a commit; none depends on
hardware.

## Session 1 — Read, verify, and touch nothing

Goal: know the state of the tree from evidence, not from documents.

1. **Read, in order:** `handoff/README.md`, `handoff/01-STATE.md`, `handoff/02-ARCHITECTURE.md`,
   `STATUS.md`, `NEXT.md`, and the last ten commit messages
   (`git log --oneline -10` and `git log -3 --format=%B`).
2. **Verify the numbers yourself:**

```sh
export PATH="$PATH:/c/Users/mushii/.cargo/bin"
cargo test --workspace --exclude bforge-gui 2>&1 | grep -oE "test result: ok\. [0-9]+ passed" | awk '{s+=$4} END {print s" passed"}'
cargo clippy --workspace --exclude bforge-gui --all-targets -- -D warnings | tail -1
git tag | tail -3
```

Do the counts match `01-STATE.md`? If not, the document is stale and you have found your first
task.

3. **Run the application.** Start the simulators and the window (`handoff/04-BUILD-AND-TEST.md`),
   screenshot it, and confirm the stream fills, the telemetry band draws, and the timeline seeks.
   This is your baseline.
4. **Read one spec end to end** — `specs/0044-export.md` is a good one, because it contains a
   measurement, two bugs, and a list of limits.

**Deliverable:** a short note in your reply naming anything that disagreed with the documents.
Do not change code in this session.

## Session 2 — One item from `05-REMAINING-WORK.md`, end to end

Take **A1 session diff** unless the user names something else. It needs no hardware, it reuses
existing code, and it is the largest gap a person would notice.

Suggested shape, one commit per step if it grows:

1. `specs/0050-session-diff.md` with Problem, Scope, Behavior, Test, Limits.
2. A library function in `crates/bforge-core` that takes two vault paths and returns a diff
   report: first divergence (record index, timestamp, field), missing records, and changed
   fields. Reuse `tail::decode_window` for decoding and the `assert` issue types for the shape.
3. Tests: two hand-built vaults that differ in one field; two identical vaults; a shorter vault.
4. `bforge diff <a> <b>` in the CLI, with the usage line and an integration test.
5. A route `/api/diff?a=..&b=..` if the window should show it; otherwise say in the spec why not.
6. `DEFERRED.md`: no new entry if the work is complete; an entry for anything you left out.

**Deliverable:** green CI, a commit with a measured or tested claim, and the spec.

## Session 3 — Prove something nobody has proven

Pick one, based on what the user cares about:

| Choice | What you produce |
| --- | --- |
| **B1 macOS/Linux build** | A CI job that builds the shell, or a documented human run in `docs/GUI-SETUP.md` |
| **B2 signing** | The SignPath application drafted; the CI step behind a flag |
| **A4 timed pin sequence** | A sequence on the reader thread, with a mock test; needs hardware to be useful |
| **C1 MAVLink bodies** | Ask the user for a dialect XML first; without it, do not start |

**Deliverable:** a spec that says what was measured and what is still inferred.

## What to check before you call anything done

- [ ] `cargo fmt --all` silent, clippy clean, tests green.
- [ ] The spec exists and matches the code.
- [ ] `DEFERRED.md` reflects reality: closed entries moved, new gaps recorded with reasons.
- [ ] `NEXT.md` no longer lists the finished item.
- [ ] The commit message says what was wrong, what changed, and how it was shown.
- [ ] No process, window or simulator left running.
- [ ] If a number appears anywhere, it is measured or marked as an estimate.

## How to talk to the user

They have been steering this project by stage and expect:

- A short summary of what changed, with the evidence.
- The paths of the documents you wrote or updated.
- An honest list of what is still not true, with the deferred ids.
- A clear question when a decision is theirs: which item next, whether to release, whether to
  spend a session on hardware.

They read the numbers. They notice when a claim has no measurement behind it.
