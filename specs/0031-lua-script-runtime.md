# 0031 Lua fault scripts

Status: accepted (30 October 2026). Implements the core of FR-SCR-01.

## Problem

Fault profiles are fixed: a bit flip, a drop, a truncation, at a rate. A real HIL test
says "if the command is a heater-on, flip bit 4 of the setpoint, keep the CRC wrong, and
let it through after 12 ms". That is a program, not a profile.

## Scope

One sandboxed Lua 5.4 hook on the **transmit** path. Not in this stage: field-level
access to a dissected frame, `forward_after_ms`, pin triggers, and any script on the
receive path (D-83, D-84).

## Behavior

1. A workspace may name a script: `script_path = "examples/flip-last-byte.lua"`. The
   session loads it at start; a script that will not load stops the start, because a rig
   whose fault logic silently is not there is worse than one that refuses.
2. The script calls `bforge.on_frame(fn)` once. For every transmitted frame, after the
   fault profile, `fn` receives the bytes as **spaced hex** and returns:
   - spaced hex to send something else,
   - the frame unchanged to pass it through,
   - `nil` to drop it.
3. The sandbox has `table`, `string`, `math` and `utf8`. There is no `io`, `os`,
   `package`, `debug` or clock, and no `bforge` function that touches the outside world
   except `bforge.log`, which writes to stderr.
4. Each call has an instruction budget of 200 000. A script that loops forever costs one
   frame: the call fails, the frame goes out unchanged, and the failure is counted.
5. A failing call never stops the session. Failures, changes and drops are counted, and
   the last error is kept for a report.
6. `bforge.unhex(text)` and `bforge.hex(table)` convert between hex and a table of
   numbers, so a script can do arithmetic without string juggling.

## Data

`ScriptRuntime { path, changed, dropped, failures, last_error }`. Two counters travel
with the session (`script_report()`). Two example scripts ship in `examples/`.

## Measured

`crates/bforge-script` unit tests, 6:

```text
a script flips a byte                    -> the flipped bytes are sent, changed = 1
a script returns nil                     -> the frame is dropped
a script returns 42                      -> the frame passes unchanged, failures = 1
an infinite loop                         -> the frame passes unchanged, failures = 1
io.open is absent                        -> the call fails, the frame still passes
a script without bforge.on_frame         -> loading fails with a message that says so
```

End to end through the HTTP surface, `crates/bforge-core/tests/serve.rs`:

```text
POST /api/send {"hex":"01 02 03"}   -> device received 01 02 FC
```

Correction, 30 October 2026: the first end-to-end run above shows a frame the engine
*posted*; the script sees what the fault profile produced, and the device receives what
the script returned.

## Test

```sh
cargo test -p bforge-script          # the runtime and the sandbox
cargo test -p bforge-core --test serve
```

## A note on the toolchain

This is the first crate in the workspace with a C dependency: mlua vendors Lua 5.4 and
needs a C compiler. That was the reason tree-sitter was dropped (D-35) and the reason
the script runtime was deferred. The MSVC toolchain installed for the desktop shell
provides `cl.exe`, and with it the vendored build works. The GNU toolchain on this
machine still has no C compiler, so local GNU builds now need
`--exclude bforge-script` or the MSVC toolchain; the CI runners all have a compiler.

## Limits, recorded

- Transmit path only: a script cannot change what arrives (D-84).
- Bytes, not fields: there is no `frame:dissect` yet, so a script works in hex (D-83).
- No delay: `forward_after_ms` is part of D-66, not here.
