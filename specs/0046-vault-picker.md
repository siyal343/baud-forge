# 0046 Vault picker and review mode

Status: accepted (1 November 2026). Closes D-78.

## Problem

The window recorded to a file it chose in `%TEMP%`, and it could only ever show a session it was
running. A person who wanted yesterday's capture had nowhere to go, and a person who wanted the
file somewhere findable had to pass `--vault` on a shortcut.

## Scope

Two actions on the picker page, and a read-only way to run the engine over a finished vault.

## Behavior

1. **Vault…** opens a save dialog filtered to `.bflog` and remembers the choice for the next
   start in this page. **Temporary** clears it, which is the behaviour before this stage.
2. **Open a vault…** opens a `.bflog` read-only. The session starts with **no writer**, so the
   file cannot be truncated: `Session::review()` has no ports and no vault, and the vault is
   registered with the server instead.
3. A review opens at the **end** of the recording. The duration comes from the vault itself
   rather than the three-second poll, which would land at a stale end.
4. With no workspace there is no schema, so each record becomes one row: port `port N`, the
   bytes as hex, the direction, no fields. Nothing is guessed about framing.
5. `bforge-gui --review --vault file.bflog` does the same from a command line. A path that is
   not a `.toml` is treated as a vault, so a `.bflog` on the command line opens for review.

## Measured

Captured from the window with `--review --vault bforge-gui-1793520598.bflog`:

```text
mode review · ports 0/0 · 55.379 s / 55.4 s · vault not recording · 0 B on disk
55.3796 s   port 0   tx   25   08 55 AA 03 73 38 C1 7E 10 1E 1B 18 2F 9D ...
```

The scrubber sits at the end of a 55.4 s recording, the row is the last record, and the
inspector says `No schema on this port.` rather than inventing fields.

## Test

`crates/bforge-core/tests/serve.rs`, `a_vault_without_a_workspace_reads_as_records`: a session
with no ports and no writer serves `/api/vault/frames` as one row per record, with
`"fields":[]`.

```sh
cargo test -p bforge-core --test serve
```

## Limits, recorded

- A review shows undecoded rows. Pairing a vault with its workspace would decode it, and the
  vault does not store the configuration, so that needs a sidecar file (not built).
- The picker's chosen vault applies to sessions started from that page; there is no per-workspace
  memory of where its captures go.
- The port strip says "No ports in this workspace" in review, which is true but reads oddly.
