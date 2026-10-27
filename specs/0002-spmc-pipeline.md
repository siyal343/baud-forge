# 0002 In-memory pipeline

Status: accepted (28 October 2026). Implements stage S1, features F1.1.1 to
F1.1.6.

## Problem

A UART at 12 Mbaud delivers about 1.2 MB/s per port. If the reader, the disk
logger and the frame dissector share one thread, one slow stage stalls the port
and the operating system drops bytes. A shared queue with a lock adds an
unbounded wait to the reader, and a full queue with a drop policy loses
evidence. The project needs a byte path whose loss is countable and whose
memory use is fixed.

## Scope

This spec covers the in-memory path from a transport to consumer ends:

- the slab pool, the reader loop, the fan-out rings, the counters and the mock
  source.

It does not cover the `.bflog` write, framing, dissection, the configuration
file or the CLI. Those stages read from the same rings later.

## Behavior

1. One reader thread exists per port. The thread opens the transport itself, so
   the caller cannot forget to.
2. The reader takes a 64 KB buffer from the pool, reads into it, and wraps the
   result in an `Arc<Slab>` with a 32-byte metadata header.
3. The reader gives the same `Arc<Slab>` to one ring per consumer. There is no
   copy of the payload.
4. Consumer 0 is the disk logger. When its ring is full, the reader waits for a
   free slot and counts the wait in `stalls_ns`. It never drops a slab for this
   consumer.
5. Every other consumer may fall behind. When its ring is full, the reader
   counts one `overruns` and moves on. Bytes for the logger are unaffected.
6. The chunk carries `seq_id`, starting at 0, and `timestamp_ns`, measured from
   the moment the reader loop starts. Both are monotonic.
7. The buffer returns to the pool when the last `Arc<Slab>` drops. After the
   first lap the read loop allocates nothing.
8. `stop` clears a flag and joins the reader. A slab that is still waiting for
   the logger ring at that moment is abandoned, because no consumer remains.

## Data

`ChunkMeta`, `bforge-core::slab`: `seq_id`, `timestamp_ns`, `port_id`,
`direction`, `line_state`, `len`.

`Slab`: the metadata, the payload, and a handle to the pool that owns the
buffer.

`PipelineConfig`: `port_id`, `slab_bytes` (default 65 536), `queue_chunks`
(default 256), `consumers` (default 2).

`PipelineStats`: `chunks`, `bytes`, `overruns`, `stalls_ns`, `read_errors`.

## Gate G0: fan-out primitive

Measured on 28 October 2026, Windows, `--release`, one producer to two
consumers, 2 048 blocks of 64 KiB, ring depth 16, logger flush of 200 µs every
eight blocks.

| Primitive | MiB/s | Producer stall, max | Producer stall, total |
| --- | --- | --- | --- |
| rtrb, two rings | 660, 679, 759 | 0.25 to 0.33 ms | 112 to 114 ms |
| crossbeam-channel, bounded | 673, 692, 714 | 0.20 to 0.31 ms | 103 to 112 ms |
| std `sync_channel` | 689, 694, 712 | 0.26 to 0.32 ms | 108 to 116 ms |

The spread between runs is larger than the spread between primitives. All three
carry about 550 times the 1.2 MB/s target, and the stall figure follows the
simulated flush, not the queue.

**Decision:** two `rtrb` rings, one per consumer. The measurement gives no
performance reason to prefer one primitive, so the decision follows ADR-002:
`rtrb` hands off wait-free, needs no lock, and its capacity is fixed at
construction, which keeps the memory ceiling honest. Reproduce with:

```sh
cargo run -p bforge-core --release --example g0_fanout
```

`crossbeam-channel` stays a dev-dependency for that example only.

## Test

```sh
cargo test -p bforge-core -p bforge-hal
cargo run -p bforge-core --release --example s1_pipeline
```

Unit tests, `bforge-hal`:

- `sequence_is_deterministic_for_a_seed` and
  `the_sequence_does_not_lock_up_or_flatten`: the PRBS-31 source repeats for a
  seed, differs across seeds, and never flattens.
- `block_carries_its_sequence_in_the_first_eight_bytes`: the mock writes a
  little-endian chunk counter, so a lost block is visible in the payload.
- `paced_transport_delivers_the_configured_rate`: bytes delivered match
  `rate × elapsed` within 20 percent.
- `reads_require_an_open_port`.

Integration tests, `bforge-core`:

- `slab_pool_allocates_once_and_then_recycles`: 200 slabs from a pool of 4 cost
  one allocation.
- `truncated_slab_returns_a_full_buffer_to_the_pool`.
- `logger_receives_every_chunk_in_order`: 50 chunks arrive with no gap, the
  payload sequence matches `seq_id`, and the port id is carried through.
- `slow_consumer_overruns_do_not_stop_the_logger`: with a dead second consumer
  and a ring of four, 500 chunks still reach the logger and `overruns` is above
  zero.
- `a_slow_logger_stalls_the_reader_instead_of_dropping`: an undrained logger
  stops the reader at the ring depth, `stalls_ns` rises, and no chunk is lost
  once draining starts.
- `stats_report_a_rate`: the byte counter and the rate agree with the traffic.

S1 demonstration, measured on 28 October 2026: four mock ports at 1.2 MB/s for
three seconds.

```text
port     chunks       MiB      MB/s    stalled  overruns  gaps
0           804      3.43      1.20     0.00ms         0     0
1           804      3.43      1.20     0.00ms         0     0
2           803      3.43      1.20     0.00ms         0     0
3           803      3.43      1.20     0.00ms         0     0

14.40 MB in 3.00 s, target 14.40 MB at 4 x 1.2 MB/s
logger gaps: 0 -> 0 dropped bytes
```

This is a mock source, not hardware. The hardware run belongs to F1.6.1, after
the UART driver lands in S2.
