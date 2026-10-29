# 0030 A bridge posts, it does not wait

Status: accepted (29 October 2026). Closes D-72.

## Problem

A forwarding bridge wrote inline from the pump thread with a 100 ms budget per
direction. One port that stopped accepting bytes therefore cost every other port up to
200 ms per pump, and the error ended the session instead of being counted.

## Scope

A non-blocking post path with per-port counters and a queue bound. Not in this stage: a
retry policy, ordered delivery guarantees across reconnects, and live transmit rows
(D-79).

## Behavior

1. The bridge **posts** bytes to the destination's reader and never waits. The reader
   writes them when it can.
2. Two counters per port say what happened: bytes posted, bytes the transport settled,
   bytes it refused. A refused write also increments the port's read-error counter, so a
   wedged port is visible in the sidebar.
3. At most 1 MiB may wait for one port. Beyond that the bridge drops the write and adds
   it to the bridge's `dropped` count, which the ribbon shows.
4. The vault still records a `Tx` chunk when the engine is *told* to send: the record
   says what the engine meant to put on the wire, and the refused-byte counter says how
   much did not leave.
5. A person's send still waits for an answer, because a forge that cannot say "sent 7"
   is not a forge. Only the bridge changed.

## Data

`WriteRequest` gained optional `settled`/`failed` counters and an optional reply;
`Pipeline::post` is the new non-blocking entry. `BridgeView` gained `dropped`.

## Measured

`crates/bforge-core/tests/bridge.rs::posting_to_a_slow_port_does_not_block_the_caller`,
against a transport that sleeps 300 ms per write:

```text
five posts returned in < 150 ms   (the old inline path needed 1.5 s)
bytes landed on the port         >= 8
settled counter                  >= 8
```

The whole bridge suite (5 tests, two devices, a vault) passes in ~6 s.

## Test

```sh
cargo test -p bforge-core --test bridge
cargo test --workspace --exclude bforge-gui     # 233 tests, 19 s
```

## Limits, recorded

- Ordering across a reconnect is not guaranteed: a posted write may land after the port
  comes back, or not at all, in which case `failed` counts it.
- The bound is per port, not per bridge, which is the useful unit when one destination is
  wedged and the other is healthy.
