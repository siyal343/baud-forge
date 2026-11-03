# 07 — Invariants

These are the rules the codebase holds today. Each one exists because breaking it caused, or would
cause, a specific kind of damage. If a task seems to require breaking one, stop and say so.

## Data safety

### I1. Never truncate a vault that has content

`Session::start` refuses a vault path with bytes in it (`SessionError::VaultExists`). A monitor
that silently overwrites yesterday's capture is a data-loss bug, not a convenience.

**Consequence for you:** any new path that opens a vault for writing must keep that check. Review
mode opens a vault with **no writer** for this reason.

### I2. One writer per transport

The reader thread owns the `TransportDriver`. Bytes, pin changes and yields are requests over
channels. A second writer on a serial port corrupts frames and the failure looks like a protocol
bug.

**Reached by:** `Pipeline::write`, `Pipeline::post`, `Pipeline::set_pins`,
`Session::yield_port`.

### I3. A killed session must be repairable

`bforge vault repair` truncates to the last complete record and drops the stale index. Every
record is written with its header before its payload, and the writer flushes so a scrubber in
another thread sees the bytes.

### I4. The vault is the truth

The live stream is a sample: a batch a client did not read is replaced and counted
(`Shared::sampled`), and the UI says "sampled". Any feature that needs every frame must read the
vault, not the stream.

## Engine behaviour

### I5. The pump never waits on a client

`Session::pump_once` moves at most `PUMP_BUDGET` chunks per port per call, and the serve loop
drops frames for a client that is behind. A slow browser must not stall recording.

### I6. Events are hints, the snapshot is state

`UiEvent` is published on change and can be missed. Clients reconcile against `/api/snapshot`.
Do not encode state that only exists in an event.

### I7. Decoding never blocks the read path

Framing and decoding happen in `pump_once` on the pump thread, not in the reader thread. A pack
that is slow costs frames, not bytes; the vault is written before decoding.

### I8. A pack never lies about coverage

A pack reports what the bytes prove and says when it cannot. A length mismatch, a bad CRC or an
unknown message id becomes a field with a sentence in it. Guessing prints confident numbers from
the wrong bits, which is worse than an unparsed payload.

## Window and contract

### I9. One contract, two clients

`crates/bforge-core/src/contract.rs` is the only description of what a client sees. The desktop window
and the served page load the same frontend. Adding a field means updating `tests/contract.rs`.

### I10. The window never blocks on the engine

Every fetch in `ui/src/lib/feed.ts` and `App.tsx` tolerates a failure: the page shows the last
state and keeps polling. An engine that restarts must not leave a blank window.

### I11. A user-visible state is in the window

`IMPLEMENTATION.md` rule 5: every subfeature names its GUI surface, or its spec says why it has
none. This project has kept that rule; keep it.

## Honesty

### I12. Numbers are measured or marked

Every figure in a spec, a commit or a release note is either a measurement with its method, or it
says "estimate". No rounded-up claims, no "should be fast".

### I13. Gaps are recorded, not hidden

A gap you created goes into `DEFERRED.md` in the same commit, with a reason, the condition that
brings it back, and the consequence. A gap you closed moves to Closed with the spec that closed
it.

### I14. Platform and hardware claims name their evidence

"A test with a mock, because this machine has no serial port" is the correct sentence. "Works on
hardware" without a run is not.

## Process

### I15. One purpose per commit

A commit does one thing, with a message that explains why. If a task grows, say so in the message
and in the spec, and consider splitting.

### I16. Tests are written against the specification, not the implementation

Fixtures are hand-built from the standard (`08 96 01` is field 1 varint 150; a v1 HEARTBEAT is
nine payload bytes). A pack tested against its own encoder proves nothing.

### I17. Releases are the user's decision

Tags are cut when the user says so. The tree can be ahead of the last release; that is normal
here.

### I18. No background processes left behind

Kill by PID. Do not leave a dev server, a simulator or a window running after a session ends. The
user shares this machine.
