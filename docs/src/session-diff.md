# Session Diff

The Session Diff compares two recorded vaults and reports exactly where and how they diverge — the regression gate between a golden baseline and today's hardware run.

![A diff between two real hardware captures](img/session-diff.png)

## Running a diff

1. **A: Baseline golden vault** — the capture you trust (`vaults/imu-assert.bflog`).
2. **B: Test comparison vault** — the run under test (`vaults/s6-COM8.bflog`).
3. **RUN DIFF**.

Both vaults are read-only inputs; the engine's semantic diff engine walks them record by record and reports:

| Metric | Meaning |
|---|---|
| **RECORDS (A / B)** | Raw records in each vault. |
| **FRAMES (A / B)** | Decoded frames in each. |
| **MISSING FRAMES** | Frames present in A but absent in B — dropped on the wire. |
| **FIRST DIVERGENCE** | The first record where the two runs differ, with the reason (`payload byte mismatch at offset 3`) and the record index. |
| **① FIELD DIVERGENCE** badge | Lights when decoded fields differ, not just bytes. |
| **Field table** | Per-field: difference count and sample values from each side. |

Presets (e.g. `IMU Assert vs Hardware Run`, `COM8 Run 2 vs Run 4`) fill both paths from your rig's usual comparison pairs.

## What a diff is good for

- **Regression gating**: flash a new build, run the same stimulus, diff against the golden capture — field drift and dropped frames show up instantly instead of in the field.
- **Corruption forensics**: the first-divergence offset points at the exact byte where the runs split — usually where a fault or a firmware change bit you.
- **Two-run A/B**: capture the same stimulus before and after a wiring change; the field table quantifies what moved.

## How decoding applies

Diff decodes with each vault's **sidecar workspace** (`<vault>.bforge.toml`), so frames compare as decoded fields where possible; without a sidecar it compares raw records. The vault writer copies the workspace beside the capture when [REC](rec-vaults.html) starts, which is what makes a reviewed capture decode.

## Tips

- Both paths are engine-relative (where the engine process runs — usually the repo root) or absolute.
- If a vault cannot be opened, the panel shows the engine's actual error — `storage: io: <path>: …` names the file — never a fabricated comparison.
