# 0007 Measurement harnesses

Status: accepted (28 October 2026). Implements F1.6.1, F1.6.2 and the reporting
half of F1.6.3.

## Problem

Two numbers decide whether the architecture holds: 12 Mbaud per port without a
lost byte, and 150 MiB of resident memory whatever the session size. Neither can
be argued. They have to be produced by a harness that a reviewer can run, on a
machine that is not the author's, and they have to fail loudly when they regress.

## Scope

The stress harness, the memory harness, the resident-memory reader, and the
nightly job that publishes both. Not in this stage: hardware loopback with a
real PRBS generator (needs the UART streaming firmware), the 100 GB fixture, and
the MITM latency measurement (F4.2).

## Method

Ingestion (F1.6.1):

- Four `MockTransport` sources at 1.2 MB/s each, paced by wall clock.
- Every block carries its own sequence in the first eight payload bytes, so a
  lost block shows up in the vault, not only in a counter.
- The harness runs the real path: pipeline, session, writer, segment rotation.
- After sealing, it reads the vault back, groups records by port, and checks that
  each port's sequence is dense. A gap is a dropped block; there is no other
  place for one to hide.
- Resident memory is sampled every pass, and the peak is compared with 150 MiB.

Memory (F1.6.2):

- Build a vault of a chosen size with 64 KiB records.
- Open it, which scans every record header and builds the sparse index.
- Read the whole file in windows of 256 records, sampling resident memory.
- Compare peak resident memory with 150 MiB, and the bytes read with the bytes
  the writer reported.

Both harnesses print `RESULT: PASS` or `RESULT: FAIL` and exit 1 on failure, so a
CI step fails on regression without a parser.

Resident memory is read from the operating system and never estimated:

| Platform | Source |
| --- | --- |
| Linux | `VmRSS` and `VmHWM` in `/proc/self/status` |
| Windows | `GetProcessMemoryInfo`, working set and peak working set |
| macOS | `ps -o rss=` for the current process |

## Measured

Machine: this workstation, Windows, `--release`, one developer.

Stress, 4 ports, 12 Mbaud each, 60 seconds:

```text
vault target/s5-soak.bflog: 290.0 MB, 5 segment(s)
resident: baseline 4.1 MiB, peak 11.9 MiB (ceiling 150.0 MiB)

    port   chunks      bytes   gaps
  port 0    15730   71997999      0
  port 1    15738   71997965      0
  port 2    15722   71996614      0
  port 3    15737   71998713      0

total 62927 chunks, 287991291 bytes of frame payload, 0 sequence gap(s)

RESULT: PASS - 0 dropped bytes
```

That is 288 MB in 60 s, 4.8 MB/s across the four ports, 5 segment rotations, and
zero gaps.

Nightly stress, 4 ports, 12 Mbaud each, 600 seconds (Linux `ubuntu-latest`, GitHub Actions run `41297037316`):

```text
recorded 683104 chunks, 2879993903 bytes in 600.0 s, 4.80 MB/s
vault target/nightly-stress.bflog: 2901.9 MB, 44 segment(s)
resident: baseline 2.6 MiB, peak 5.6 MiB (ceiling 150.0 MiB)

    port   chunks      bytes   gaps
  port 0   170774  719999301      0
  port 1   170772  719999247      0
  port 2   170771  719995922      0
  port 3   170787  719999433      0

total 683104 chunks, 2879993903 bytes of frame payload, 0 sequence gap(s)
```

That is 2.90 GB in 600 s (10 minutes), 4.80 MB/s across four ports, 44 segment
rotations, 5.6 MiB peak resident memory, and zero sequence gaps. Note: run
`41297037316` exposed a post-loop accounting bug in `s5_stress.rs` where
`session.snapshot()` was called before `session.seal()`, and `seal()` drained one
additional chunk (`683104` vs `683103`) while `nightly.yml` masked the exit code
behind `| tee`. Both `s5_stress.rs` (now comparing `report.chunks` from the
forward `for_each` cursor against `written.chunks`) and `nightly.yml`
(`set -euo pipefail`) are fixed.

Memory, 512 MiB vault (Windows):

```text
built 512.3 MiB in 1.76 s (292 MiB/s), file 537133312 bytes
resident before open: 5.4 MiB
opened in 0.05 s: 8192 records, 8 index entries (0.2 KiB)
read 8192 records, 512.0 MiB of payload in 20.47 s (25 MiB/s)
resident: baseline 5.4 MiB, peak 21.5 MiB, growth 16.1 MiB
file is 512.3 MiB, so the peak is 4.20% of the file
estimate: a 100 GB file holds 1638400 records and needs 1600 index entries, about 37.5 KiB

RESULT: PASS - flat memory over the whole file
```

Memory, 1024 MiB (1 GiB) vault after `for_each` cursor (`0044`, Linux `ubuntu-latest`, GitHub Actions run `41297037316`):

```text
built 1024.5 MiB in 2.36 s (434 MiB/s), file 1074266368 bytes
resident before open: 2.2 MiB
opened in 0.00 s: 16384 records, 16 index entries (0.4 KiB)
read 16384 records, 1024.0 MiB of payload in 0.78 s (1311 MiB/s)
resident: baseline 2.2 MiB, peak 18.2 MiB, growth 16.0 MiB
file is 1024.5 MiB, so the peak is 1.78% of the file
estimate: a 100 GB file holds 1638400 records and needs 1600 index entries, about 37.5 KiB

RESULT: PASS - flat memory over the whole file
```

The 100 GB figure is an **estimate from the index stride**, not a measurement. It
is printed with the word estimate for that reason.

## Against the targets

| Requirement | Target | Measured | State |
| --- | --- | --- | --- |
| Sustained ingestion | 12 Mbaud, 4 ports, 0 dropped | 4.80 MB/s, 0 gaps, 600 s (2.90 GB, 5.6 MiB RSS) | met on the mock source |
| Resident memory | 150 MiB with a 100 GB file | 18.2 MiB peak with a 1024 MiB file (1.78% of file) | met at 1/100 of the target size |
| Segment rotation | 64 MB segments | 44 segments in a 2.90 GB vault | met |
| Reader speed | not specified | 1311 MiB/s (after `0044` cursor) | met |

## Findings

1. **Rotation works**: 2.90 GB produced 44 segments, and the seal synced the tail.
2. **The forward cursor (`0044`) solved reader throughput.** Read speed rose from
   25 MiB/s (seeking twice per record) to 1,311 MiB/s on a 1 GiB vault (0.78 s
   total scan time).
3. **The index is small enough to stop worrying about.** One entry per 1024
   records at 24 bytes is 37.5 KiB for 100 GB of 64 KiB records.
4. **Hardware throughput is still unmeasured.** The stress source is the mock
   transport. A real 12 Mbaud loopback needs a firmware that streams PRBS without
   pause; the ESP32-C3 on the bench prints a boot log, not a saturated line.

## Test

```sh
cargo test -p bforge-core --lib mem
cargo run -p bforge-core --release --example s5_stress -- --ports 4 --seconds 60
cargo run -p bforge-core --release --example s5_memory -- --size-mb 512
```

The unit test checks that this platform reports a plausible resident size, which
catches a broken binding without asserting a number. The two harnesses are the
test: they fail on any gap, any short read and any peak above the ceiling.

Nightly: `.github/workflows/nightly.yml` runs the stress for 600 seconds and the
memory harness on a 1 GiB vault, then writes both reports into the job summary.
Both durations are inputs on a manual dispatch, so a longer soak needs no code
change.
