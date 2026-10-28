# 0020 Numeric series for the telemetry band

Status: accepted (29 October 2026). Opens F1.7.4 and the plot half of band 3B.

## Problem

The workbench showed frames, but a person watching a sensor wants the shape of a
value over time, not a hundred hex rows. A plot cannot be drawn from the frame
stream: it needs numbers, at a steady rate, with a bounded cost.

## Scope

Numeric sampling of decoded fields, and a line plot of one series. Not in this
stage: WebGL, 60 FPS targets, multiple overlaid series, state lanes or the time
scrubber (D-63).

## Behavior

1. Every numeric leaf of a decoded frame is sampled into a ring keyed by port and
   flattened field name (`sim.v_batt_mv`, `sim.channel`).
2. At most 32 series exist at once. A 33rd field is counted in `ignored` and not
   sampled, so a wide schema cannot grow the process.
3. Each ring holds 600 samples. At 500 Hz that is 1.2 s; at 4 kHz it is 150 ms. The
   ring drops the oldest sample, never the newest.
4. Only new samples travel: a series with nothing new since the last tick costs
   nothing on the wire.
5. The frontend draws one series at a time with a field selector, scaled to the
   values' own minimum and maximum, with last, min and max read out.
6. Text fields produce no series. A field that stops appearing simply stops growing.

## Data

`SeriesUpdate { port, field, values }` travels as `event: series`, a JSON array of
updates, at the snapshot tick (200 ms). `FieldRow` gained `value_num` so a client
can tell a numeric leaf from a label.

## A fault this stage found

The first live run with 8000 frames per second froze the session: the snapshot
stopped advancing while the port stayed `open`. `Session::pump_once` drained each
port's ring until it was empty, so a source faster than the pump kept it inside that
loop and nothing else in the session — snapshot, events, vault position — was ever
published. Two threads sat at 100 % CPU.

The fix is a budget: one pump call moves at most 1024 chunks per port. The ring
stays bounded, the next call continues where this one stopped, and no byte is lost.

A second fault: frames and snapshots shared one queue per client, so a client that
could not keep up with frames lost the snapshots too. Frames now travel separately
and an unread frame batch is replaced rather than queued, while control frames keep
their own bounded queue.

## Measured

8000 Hz socket simulator, `ImuPacket` header, 209 s session:

| Figure | Value |
| --- | --- |
| Chunks | 98 880, 41.8 MB, 0 overruns |
| Frames | 4096 received by the client, 500 kept in view |
| Series | `sim.channel` drawn, 600 samples, min 0, max 31 |
| Stalls | 164 227 ms cumulative reader wait for a logger slot |

The stall figure is honest and large: the reader waits whenever the ring is full,
and at 8000 Hz the 2 ms pump cadence is the bottleneck. No chunk was dropped; the
cost is latency in the stalled path, which the plot band and the vault both absorb.

Captured in Edge at 1440×900: `docs/screenshots/workbench.png`.

## Test

```sh
cargo test -p bforge-core --lib series        # 5 tests: rings, caps, new-only
cargo test -p bforge-core --test serve        # a client receives event: series
cd ui && npm run build
```

The series tests cover: numeric leaves sampled and text leaves skipped, only new
samples travelling, the ring keeping the newest, the 32-series cap counting what it
refuses, and per-port rings staying apart.
