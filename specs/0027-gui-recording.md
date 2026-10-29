# 0027 The window records, and a port that is not there yet waits

Status: accepted (29 October 2026). Closes D-75.

## Problem

The desktop shell opened a session without a vault, so its scrubber answered 404: the
window could watch a live stream and nothing else. Separately, a session that started
before its device existed gave up at once, which is the normal order of events when a
person opens an application and then plugs in a board.

## Scope

Recording from the window, and patience on the first open. Not in this stage: an
installer (D-74, deferred to release), a vault picker in the window, and a bridge that
buffers while one side is away (D-73).

## Behavior

1. `bforge-gui <workspace> [--vault <path>]` records by default. Without `--vault` the
   session goes to `%TEMP%/bforge-gui-<unix-seconds>.bflog`, and the path is printed on
   startup.
2. The vault is handed to the server, so `/api/vault` and `/api/vault/frames` work in
   the window exactly as they do under `bforge serve --vault`.
3. A port that fails its first open now enters `reconnecting` and spends the same
   attempt budget a later disconnect gets, instead of closing for good. A window opened
   before the board is plugged in recovers on its own.
4. When the budget runs out the port still closes, and the state says so.

## Measured

```text
bforge-gui …/serve-ui.toml --vault %TEMP%/gui-vault.bflog
  engine http://127.0.0.1:58824/, window "BaudForge"
GET /api/vault          → {"records":2308,"bytes":57900,"damaged_tail":false}
GET /api/vault/frames?at=0&count=20 → 20 decoded ImuPacket rows
```

Before the first-open change, the same run showed `state: closed`, `chunks: 0`,
`read_errors: 1` after 74 s, because the simulator took longer to bind than the window
took to start. That is a measurement, not a guess: the port never recovered.

## Test

```sh
cargo test --workspace --exclude bforge-gui    # 231 tests, including the pipeline
cargo build -p bforge-gui && bforge-gui <workspace> --vault /tmp/s.bflog
```

The pipeline tests already cover a reconnect after a disconnect; the first-open path
now reuses the same code, so there is no second implementation to test apart from the
GUI flow above.

## Limits, recorded

- No vault picker: the window records to a path it chose or was given (D-75 kept the
  picker open, closed the recording gap).
- A bridge still does not buffer while one side is away (D-73).
