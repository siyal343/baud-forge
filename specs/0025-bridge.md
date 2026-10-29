# 0025 Bridge and tap between two ports

Status: accepted (29 October 2026). Implements most of FR-MITM-01.

## Problem

Two ports could be recorded, but they were strangers: nothing could sit between an
OBC and its payload, and nothing could say "this byte on the bus caused that answer".
The fault injector could only corrupt what a person typed.

## Scope

A configured pair of ports, in two modes. Not in this stage: a merged timeline view
beyond one port column per row (D-72), frame-level rules on the bridge, and a bridge
that survives one side disconnecting for a configured time (D-73).

## Behavior

1. A workspace names pairs:
   ```toml
   [[bridges]]
   id = "link"
   a = "obc"
   b = "eps"
   forward = true
   ```
2. `forward = false` is a **passive tap**: both sides are recorded and decoded, and
   nothing is written.
3. `forward = true` is an **inline bridge**: bytes that arrive on one side are
   written to the other, and the reverse.
4. The vault records the copy with `direction = Tx` on the receiving port, so a
   bridged session is auditable: what arrived is RX, what the engine put on the wire
   is TX.
5. Fault profiles apply to the destination port, so `bit_flip` on `eps` corrupts
   what the bridge writes to `eps`.
6. Validation refuses a bridge that names a missing port, pairs a port with itself,
   reuses a bridge id, or puts a port in two bridges.
7. The contract carries `bridges: [{id, a, b, forward, forwarded}]`, and the ribbon
   shows `tap a↔b` or `bridge a↔b 12 kB`.

## Data

`BridgeConfig { id, a, b, forward }` in the workspace; `BridgeView` in the snapshot.
Counters: bytes forwarded per bridge.

## Measured

`crates/bforge-core/tests/bridge.rs`, two loopback devices:

```text
forward = true   obc received "eps …", eps received "obc …", forwarded > 0
forward = false  nothing was written to either device, forwarded = 0,
                 and both ports still recorded chunks
unknown port     bridges[0].b: "`eps` is not a port in this workspace"
```

## Test

```sh
cargo test -p bforge-core --test bridge
cargo test -p bforge-core --test config_validation
```

## A limit worth stating

A bridge writes from the pump thread with a 100 ms budget per direction. A port that
stops accepting bytes therefore stalls the pump, which is why the write reports a
`SessionError` instead of being retried forever. A production bridge wants a queue
per direction; that is D-72.
