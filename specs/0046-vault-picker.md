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
5. `bforge-gui --review --vault file.bflog` does the same from a command line, and
   `bforge-gui capture.bflog` reviews that file: a vault alone is a capture, `--vault` beside a
   workspace is where that session records.
6. **A session copies its workspace beside the vault** as `<vault stem>.bforge.toml`, and a
   review reads that copy when it exists. With it the capture decodes: port ids, schema, fields.
   Without it the review falls back to raw records.

## Measured

Captured from the window with `--review --vault bforge-gui-1793520598.bflog`:

Without a sidecar, from a vault recorded before this stage:

```text
mode review · 55.379 s / 55.4 s · vault not recording
55.3796 s   port 0   tx   25   08 55 AA 03 73 38 C1 7E 10 1E 1B 18 2F 9D ...
inspector: No schema on this port.
```

With a sidecar, from a vault recorded after it:

```text
mode review · 43.818 s / 43.8 s
43.8182 s   eps   tx   23   55 AA 03 AA 10 40 64 00 1D 92 86 EB 11 3F AA 19 30 40 ...   C_STRUCT:ImuPacket
43.8182 s   obc   tx   23   55 AA 03 AA 10 40 64 00 1D 92 86 EB 11 3F AA 19 30 40 ...   C_STRUCT:ImuPacket
```

The scrubber sits at the end of the recording, the rows carry their port ids, and the pack
decodes them, because the workspace travelled with the vault.

## Test

`crates/bforge-core/tests/serve.rs`, `a_vault_without_a_workspace_reads_as_records`: a session
with no ports and no writer serves `/api/vault/frames` as one row per record, with
`"fields":[]`.

```sh
cargo test -p bforge-core --test serve
```

## Limits, recorded

- The sidecar is a copy of the workspace file, so a review of a capture whose `.bforge.toml`
  has since changed decodes with the old copy. That is the point, but it means editing the
  workspace does not change how an old capture reads.
- `bforge record` on the command line does not write a sidecar yet (D-113).
- The picker's chosen vault applies to sessions started from that page; there is no per-workspace
  memory of where its captures go.
- The port strip says "No ports in this workspace" in review, which is true but reads oddly.
