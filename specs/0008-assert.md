# 0008 `bforge assert`

Status: accepted (28 October 2026). Implements F1.5.5.

## Problem

A recorded session is evidence, and a CI job has to make a claim about it: the
boot banner appeared, the sync bytes appeared, the session holds at least the
expected records. Without a rule file, that claim is a person reading a hex dump.

## Scope

A TOML rule file, four check kinds, the CLI surface, and the exit code that makes
CI useful. Not in this stage: regular expressions (a dependency for a matcher
nobody has asked for yet), timing assertions, and scripting, which arrives with
the Lua runtime in F4.4.

## Behavior

1. `bforge assert <vault> -r <rules>` reads the rule file first. A malformed rule
   fails before the vault is opened, because a typo in a rule must not look like a
   failed expectation.
2. Checks run in one pass over the vault, in windows of 256 records, so memory
   stays bounded on a large file.
3. A text or byte needle that straddles two records is found: the matcher keeps
   the tail of the previous record, so framing boundaries cannot hide a match.
4. Exit code 0 when every check passes, 1 when any fails, 2 for a usage error.
   `--json` prints the whole report for a machine to read.
5. Unknown check kinds are refused with the list of valid kinds.

## Data

```toml
[[checks]]
name = "second stage bootloader"
kind = "contains"          # contains | contains_hex | chunks | bytes
value = "load:0x"          # text for contains, spaced or compact hex for contains_hex

[[checks]]
name = "session recorded"
kind = "chunks"
min = 20                   # chunks and bytes take min, max, or both
max = 100000
```

Report shape, also the `--json` document:

```text
vault, chunks, payload_bytes, checks[]: { name, kind, passed, detail }
```

## Test

```sh
cargo test -p bforge-core assert
cargo test -p bforge-cli --test vault_and_assert
```

Core unit tests: hex parsing in both forms, a needle straddling two records, a
valid rule file, and a bad one that names both problems.

CLI tests build a vault with the storage writer and then: four checks pass with a
JSON report, a missing string and a short count fail with exit 1, a rule typo is
refused before the vault is read, `vault info` reports the persisted index, and
`vault repair` cuts a partial record.

Measured on 28 October 2026 against a two-second ESP32-C3 recording on COM8:

```text
$ bforge assert target/s6-COM8.bflog -r app.rules.toml
target/s6-COM8.bflog: 57 chunks, 1162 bytes
  PASS contains   application telemetry line  `t1008` found, first byte near offset 3
  PASS chunks     session recorded  57 >= 20
  PASS bytes      payload size  1162 <= 100000
3 of 3 checks passed

$ bforge vault info target/s6-COM8.bflog
  records      57
  payload      1162 bytes
  file         3242 bytes
  index        persisted (1)
  damaged tail false

$ cp vault; truncate -20 bytes
$ bforge vault info target/s6-crash.bflog
  records      56
  index        scanned (1)
  damaged tail true
$ bforge vault repair target/s6-crash.bflog
target/s6-crash.bflog: kept 56 records, removed 33 bytes
$ bforge vault info target/s6-crash.bflog
  damaged tail false
```

The first run against an older vault failed two checks with exit 1, which is the
proof that a negative result is reported as a failure rather than a warning.

## Known limit

The matcher scans for one needle per check, so ten checks read the vault once and
run ten scans over the bytes. That is the right trade at 100 MB and would be the
wrong one at 100 GB; an index-backed text search belongs with the dissector work,
which already has to walk the same bytes.
