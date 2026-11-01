# 0045 Live transmit rows

Status: accepted (1 November 2026). Closes D-79.

## Problem

A bridge's writes were recorded in the vault as `Tx` and visible when a window was scrubbed,
but the live stream carried only what a reader received. On a tap or an inline forward, half the
traffic was missing until the session stopped, which made a bridged session look receive-only.

## Scope

A forwarded chunk produces one transmit row in the live frame queue, beside the receive rows.
Not in this stage: decoding a forwarded frame, so a transmit row carries bytes and no fields.

## Behavior

1. When the bridge posts bytes to the other side, it also builds a row with `direction: Tx`, the
   destination port's id, the same timestamp, and the bytes as hex and text.
2. The row enters the same queue as receive rows, so the frame cap and the dropped count apply
   to it in the same way.
3. Its delta is zero: there is no previous transmit row on that port to measure against, and
   inventing one would put a number in the column that means nothing.
4. Transmit rows are not decoded and are not sampled into the telemetry series: the engine
   wrote those bytes, so there is nothing to decode.

## Measured

The loopback demo with `forward = true`, captured from the window:

```text
19.2265 s   0     obc   tx   25   08 55 AA 03 44 A0 01 2C ...
19.2265 s   0     eps   tx   25   08 55 AA 03 05 88 AB 3A ...
19.2252 s   6833  eps   rx   23   55 AA 03 44 A0 01 2C 00 ...
19.2250 s   4792  obc   rx   23   55 AA 03 05 88 AB 3A 00 ...
```

Both ports show what left them, interleaved with what arrived. The transmit rows are 25 bytes
and the receive rows 23, because a forward posts the framed bytes (COBS plus delimiter) while
the receive row shows the decoded frame.

## Test

`crates/bforge-core/tests/bridge.rs`, in `a_forwarding_bridge_carries_bytes_both_ways`: after
the pump, at least one row has `direction == Tx`, names a port of the pair, and carries bytes.

```sh
cargo test -p bforge-core --test bridge
```

## Limits, recorded

- A transmit row is not decoded: no fields, no protocol tag, no symbols.
- Only a bridge produces one. A typed send from the command forge does not appear as a live
  row for the same reason a forward did not before this stage: nothing feeds it into the frame
  queue. That is the natural next step and it is not done.
- The delta column reads zero on every transmit row.
