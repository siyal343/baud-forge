# 0003 `.bflog` container

Status: accepted (28 October 2026). Implements F1.3.1, F1.3.2, F1.3.3 (plain)
and F1.3.6.

## Problem

A session must survive the tool that recorded it. Filters, dissectors and
crashes must not change what the hardware said. The file also has to be readable
without loading it: a soak test can reach 100 GB, and the viewer keeps a 150 MB
ceiling.

## Scope

Header, chunk record, writer, reader. Not in this stage: compression (F1.3.4),
the persisted index (F1.3.5), full crash recovery (F1.3.7), and the exporters
(FR-STO-02).

## Behavior

1. One file holds one session: a 256-byte header, then chunk records back to
   back. Payload follows its record header with no padding and no alignment.
2. The writer appends in arrival order. It never rewrites a byte it has written.
3. A record is self-describing: the reader learns the next record position from
   `payload_len`, so a damaged record can only hide the records after it.
4. The writer flushes and calls `sync_data` when it crosses a 64 MB segment
   boundary, and always on `seal`. A lost tail is therefore at most one segment
   of data, never a corrupted middle.
5. The reader scans record headers once on open and keeps one index entry per
   1024 records. A window read seeks to the nearest entry, then walks forward.
6. The seek key is the record ordinal, counted from zero in file order. The
   chunk sequence in a record is the port's own counter, so two ports both
   produce sequence 0. A reader that seeks by sequence reads the wrong record
   for the second port; `records_from_two_ports_keep_their_own_sequences` holds
   that line.
7. A file that ends in a partial record opens successfully. `damaged_tail`
   reports it and the reader stops at the last complete record.

## Data

Header, offsets from the start of the file:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 6 | magic `BFLG\x01\x00` |
| 6 | 16 | session id, u128, little endian |
| 22 | 8 | session start, Unix epoch nanoseconds, u64 |
| 30 | 8 | workspace configuration hash, u64 |
| 38 | 8 | port descriptor table offset, u64 |
| 46 | 210 | zero, reserved |

Record header, 32 bytes:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | chunk sequence, u64 |
| 8 | 8 | timestamp, nanoseconds since session start, u64 |
| 16 | 2 | port id, u16 |
| 18 | 1 | direction: 0 RX, 1 TX, 2 MITM A to B, 3 MITM B to A, 4 injected fault |
| 19 | 2 | line state bitmask, u16 |
| 21 | 3 | zero, reserved |
| 24 | 4 | payload length, u32 |
| 28 | 4 | zero, reserved |

File size after a session: `256 + Σ (32 + payload_len)`. The tests assert this
identity, so a format change cannot slip through unnoticed.

## Gate G2: vault storage

The ADR names a memory-mapped file with LZ4-compressed segments. This stage
writes plain files instead.

- Constant memory comes from `seek` plus a bounded window, not from mapping. A
  mapped 100 GB file on 32-bit or low-memory targets is a liability, and the
  reader still needs the index either way.
- Compression needs the segment sealer, which is F1.3.4. Compressing now would
  fix a file layout before the first measurement of write throughput.
- A plain file is inspectable with `od` and has no unsafe code.

Revisit at F1.3.4 with `lz4_flex`, and only add `memmap2` if the write path
measures below the 12 Mbaud target.

## Test

```sh
cargo test -p bforge-storage
```

- `header_roundtrip_and_foreign_file`: encode and decode, plus rejection of a
  foreign magic and a short header.
- `a_session_reads_back_byte_for_byte`: five records, payload and metadata
  equal, payload offsets exact, file size matches the identity above.
- `a_window_seeks_into_a_long_session`: 5 000 records, index entries at chunks 0,
  1024, 2048, 3072 and 4096, and a window that crosses an index entry.
- `a_truncated_tail_is_reported_not_fatal`: the last five bytes are cut; two
  complete records remain and `damaged_tail` is true.
- `chunks_carry_every_direction`: all five direction codes survive the round
  trip.

Measured on 28 October 2026 through the S2 demo, mock source at 1.20 MB/s:
454 chunks, 2 393 966 payload bytes, file 2 408 750 bytes, one segment, index
one entry, window of 10 contiguous records read back.
