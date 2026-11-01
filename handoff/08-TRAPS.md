# 08 — Traps

Everything here has cost time in this repository. Read it before your first build.

## Build and launch

### T1. A failed build leaves the old binary running

`cargo build -p bforge-gui` fails with `Access is denied` (os error 5) when a window is open,
because Windows locks the running executable. If you then launch the "new" binary, you launch the
old one and debug a feature that is not there.

**Do:** kill the window, wait two seconds, build, check the build line says `Finished`, then
launch. A one-hour detour on the review-mode landing came from exactly this.

### T2. The webview serves the old bundle

The shell appends `v=<millis>` to the URL for this reason. If you add a nonce-free navigation,
a rebuilt `ui/dist` will not appear.

**Do:** rebuild `ui/dist`, and check the built bundle contains your change (`grep -o` for a new
string in `ui/dist/assets/*.js`) before concluding the code is wrong.

### T3. Two listening ports per window

The engine opens two loopback ports. One answers `/api/health`, the other does not. Probe all of
them rather than assuming the first from `netstat`.

### T4. `ps -W` in Git Bash

`ps` is the Windows one, not the Unix one. The PID is column 4 (`ps -W | awk '{print $4}'`), and
`/PID` flags need double slashes in Git Bash: `taskkill //PID 1234 //F`.

## The vault

### T5. `port_table_offset` is written and never read

`format.rs` writes 256 in the header's port-table slot, and nothing writes or reads a table.
Records start at 256, so the field points at the first record. This is a lie in the format that
has not hurt anyone yet.

**If you need a self-describing vault**, this is the designed place for it — and the reader and
writer both assume `HEADER_LEN` for the first record, so it is a real change, not a field write.

The current workaround is the sidecar: `<vault stem>.bforge.toml`, written by both recorders
(`specs/0046`).

### T6. `last_timestamp_ns` is the last record, not the maximum

Timestamps come from one clock in normal operation, so they are monotonic and the two agree. A
vault assembled from more than one source can have a maximum earlier than its tail, and the
timeline span then understates the recording.

### T7. Two read shapes, two costs

`read_at`/`window` seek per record; `for_each` walks. Export used the first and took 12 s for
285,740 records; with the second it takes 5.5 s. Use `for_each` for anything that reads the whole
file.

### T8. Export builds its body in memory

`/api/vault/export` assembles the whole file in a `Vec`. A 285,000-record vault is 76 MB as CSV.
A capture larger than the process memory would fail. Chunked writing is the fix if it ever
matters (D-108 closed, this limit recorded in `specs/0044`).

## Protocols

### T9. MAVLink v2 lays its header out differently from v1

`0xFE len seq sysid compid msgid` against `0xFD len incompat compat seq sysid compid msgid(3)`.
The v2 sequence is at index 4, not 5. The first version of the pack read the system id as the
sequence, and its own test caught it.

### T10. A protobuf field number of zero is invalid, and a group is proto2

Both are refused by name in `packs/protobuf.rs`. A decoder that guesses at them prints nonsense.

### T11. CCSDS and Modbus lengths are in the standard's units

CCSDS carries "data length minus one"; Modbus has no length field at all. Both packs handle this;
copy the pattern rather than re-deriving it.

## Platform

### T12. A socket accepted from a non-blocking listener inherits non-blocking on macOS

Linux does not do this, so a test that passes everywhere else fails on `macos-aarch64` only. Fixed
in `crates/bforge-core/src/control.rs` with an explicit `set_nonblocking(false)`.

### T13. CRLF warnings on commit

The repository stores LF and Git warns about CRLF on Windows. The warnings are noise; do not
"fix" them by changing `core.autocrlf`, and do not commit a whitespace-only reformat.

### T14. The frontend toolchain is not on `PATH`

`node` and `npm` live in `C:\Users\mushii\AppData\Local\pi-node\current`. Export that directory
before `npm run build`.

### T15. Python path confusion

`/tmp` in Git Bash is not `%TEMP%` for native Python. A Python subprocess given `/tmp/x.bflog`
fails with `WinError 2`. Use `os.environ["TEMP"]` or `$TEMP` in the shell.

## Judgement traps

### T16. Reading a number off a downscaled screenshot

A `55.4` was read as `95.4`, and an afternoon went into a span bug that did not exist. Crop,
resize **up**, then read.

### T17. Believing a flake is a flake

The macOS control test failed once and passed on re-run. It was a real platform bug. Run a flaky
test 20 times locally before calling it flaky.

### T18. Trusting the plan documents over the code

`PLAN.md` carried a "next step" from the scaffold era for months; `DEFERRED.md` and `NEXT.md` were
current. Read the code, then the spec, then the plan.

### T19. Adding a dependency for a few lines

The dependency list is short on purpose. `serde_json` for JSONL would have been reasonable, but a
hand-written line was smaller; the hex table replaced a per-byte `format!` and halved an export
time.

### T20. A wall-clock deadline in a test fails on a busy machine

`slow_consumer_overruns_do_not_stop_the_logger` had a five-second budget and failed once while
this machine was building the GUI at the same time. The code was fine; the clock was not. The
budget is thirty seconds now, which still catches a real stall because a stall never recovers.

Before you treat a failure as real, ask what else was running. Before you treat it as a flake, run
it twenty times on an idle machine.

### T21. Measuring nothing and calling it done

The most useful commits here are the ones with a number in them: 14,269 to 3 dropped batches,
12.0 s to 5.5 s, 8,988 frames in 25 s. If a change has a cost or a speed, measure it.
