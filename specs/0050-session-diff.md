# 0050 Session diff

Status: accepted (2 November 2026). Closes D-21.

## Problem

Engineers capture serial sessions to investigate faults: "this run was different
from the last good one" is the central question in failure investigations.
Before this feature, comparing two session vaults required manual inspection or
external scripts. Raw byte comparison failed because serial framing, packet chunking,
and timestamps vary between runs even when the decoded packets are identical.

## Scope

Semantic diffing of two `.bflog` session vaults:
- Decoded frame and field comparison when a workspace configuration is available.
- Raw record comparison (`port_id`, `direction`, payload bytes) when no workspace configuration exists.
- Automatic sidecar discovery (`<stem>.bforge.toml`) next to either vault file.
- Command-line tool `bforge diff <vault-a> <vault-b> [--config <file>] [--json]`.

## Behavior

1. `bforge diff <a.bflog> <b.bflog>` compares two vaults.
2. If `--config` is omitted, the tool searches for `<stem>.bforge.toml` next to
   the first vault, then next to the second vault.
3. When workspace configuration is found, the tool decodes frames using the framing
   machine and dissector configured for each port.
4. When no workspace configuration is found, the tool compares raw records
   sequentially by port identifier, direction, and payload bytes.
5. Decoded frames are compared by port, direction, decoded field values, and payload
   bytes.
6. The `DiffReport` contains:
   - `records_a` and `records_b`: raw chunk totals.
   - `frames_a` and `frames_b`: decoded frame totals.
   - `identical`: boolean flag indicating whether the vaults match.
   - `first_divergence`: the index, timestamps, port, reason, and field diffs of the
     first point of difference.
   - `changed_fields`: list of field differences, capped at 64 entries to bound memory.
   - `missing_from_a` and `missing_from_b`: counts of trailing extra frames or records.
7. The CLI prints a human-readable summary by default or JSON when `--json` is passed.
8. The CLI exits with code 0 when vaults are identical, code 1 when they differ,
   and code 2 on read or configuration errors.

## Test

Unit tests in `crates/bforge-core/src/diff.rs`:
- `two_identical_vaults_report_no_divergence`: verifies matching vaults report identical status.
- `changed_field_names_the_record_and_field`: verifies field-level differences report the exact field and values.
- `shorter_vault_reports_missing_records`: verifies shorter captures report missing record and frame counts.

Integration tests in `crates/bforge-cli/tests/cli.rs`:
- `diff_without_arguments_is_refused`: verifies CLI rejects missing positional arguments with code 1.
- `diff_missing_vault_reports_error`: verifies CLI exits with code 2 when vault files do not exist.

Commands:
```sh
cargo test -p bforge-core diff
cargo test -p bforge-cli diff
```

## Limits, recorded

- Sequential matching: frames are compared in arrival order. Interleaved frames
  from independent asynchronous ports must arrive in the same order across runs.
- Memory cap: `changed_fields` retains at most 64 field diff entries to keep
  diff reports bounded on large multi-gigabyte vaults.
