# 0028 Direction on every frame row

Status: accepted (29 October 2026). First half of D-72.

## Problem

A bridge writes bytes as well as reading them, and the vault records both. The frame
rows did not: every row was implicitly receive, so a bridged session could not say
which frames the engine put on the wire and which it heard. A tap read as two streams
rather than one bus with two directions.

## Scope

A direction on the row, from the record it came from, and a column that shows it. Not
in this stage: a single merged timeline that labels both sides of a pair in one view,
and live transmit rows (D-79).

## Behavior

1. `TailRow` carries `direction` using the pipeline's own `Direction` type: `Rx`,
   `Tx`, `MitmAToB`, `MitmBToA` or `InjectedFault`.
2. A live session's rows are `Rx`: the reader sees what the port sends to the host.
   Bytes the engine forwards are recorded as `Tx` in the vault and appear when a
   window is decoded.
3. A decoded window takes the direction from each record, so one window of a bridged
   session mixes `Rx` and `Tx` per frame.
4. The workbench shows a `dir` column and colours anything that is not receive in the
   transmit colour, which the UI guide reserves for it.

## Data

One additive field on `TailRow`. The contract version stays 1 because the field is
additive and its absence in an old client is not a lie.

## Measured

`crates/bforge-core/tests/bridge.rs::the_vault_records_both_directions_of_a_bridged_pair`,
two loopback devices with `forward = true`:

```text
vault records    Rx > 0 and Tx > 0
decoded window   at least one frame on `eps` decodes as Tx
```

## Test

```sh
cargo test -p bforge-core --test bridge
cd ui && npm run build
```

## Limits, recorded

- Live rows are receive only: a forwarded byte appears in the live stream as nothing
  and in a vault window as `Tx` (D-79).
- A tap still shows one column per port; a merged bus view is the second half of D-72.
