# 0013 Port yield

Status: accepted (28 October 2026). Implements F1.2.6 and F1.5.6.

## Problem

A flash tool cannot open a port that BaudForge holds, and holding a port is most of
what BaudForge does. Closing the recorder by hand before every flash, then starting
it again after, is the workflow this exists to remove. The request must reach the
process that owns the handle, not a second process that cannot see it.

## Scope

A local control plane, the yield window, the CLI command, and the state the
snapshot reports. Not in this stage: SIGUSR1 and the GUI hotkey (D-50), the socket
has no authentication (D-51), and `tail` does not publish an endpoint (D-52).

## Behavior

1. A session binds a control listener on `127.0.0.1:0` and publishes the address in
   one small file per device: `<temp>/bforge-<device>.endpoint`. The file is how a
   client finds the process that owns the port, with no daemon and no registry.
2. `bforge yield -c <workspace> --port <id> --for 15s` resolves the device from the
   workspace, reads the endpoint file, sends one JSON line, and prints one reply.
3. The reader takes a yield request between reads, closes the handle, publishes
   `yielded`, and counts it.
4. During the window the reader does not touch the port. An earlier version polled
   every 50 ms and raced the flash tool for the handle: the measurement showed the
   port still busy for a second `bforge tail` while the session reported `yielded`.
   The window is now the contract: the flasher owns the port until it ends.
5. After the window the reader reopens with the normal reconnect patience. If it
   cannot, the state becomes `reconnecting`, so a flasher that hangs cannot leave
   the tool stuck in `yielded` forever.
6. The endpoint file is removed when the session ends, and a stale file is ignored
   once it no longer points at a live listener.

## Data

Endpoint file: one line, `127.0.0.1:<port>`.

Request and reply, one JSON object per line:

```text
{"cmd":"yield","port":"esp32","seconds":15}
{"ok":true,"state":"yielded","port":"esp32","seconds":15}

{"cmd":"status"}
{"ok":true,"vault":"target/run.bflog","ports":1,"elapsed_ms":4200}
```

An unknown port answers `{"ok":false,"error":"port `x` is not in this session"}`.

## Measured

28 October 2026, ESP32-C3 on COM8, 115 200 baud. Two BaudForge processes: a
recorder that holds the port, and a `tail` that tries to open the same port. No
flashing, so nothing on the board changed.

```text
$ bforge record ... --duration 120s &        # holds COM8
$ bforge tail -c esp32c3.toml --duration 2s
0 frame(s) in 2.0 s (0.0 frames/s)           # the port is held, as expected

$ bforge yield -c esp32c3.toml --port esp32 --for 15s
{"ok":true,"state":"yielded","port":"esp32","seconds":15}

$ bforge tail -c esp32c3.toml --duration 4s
     3.903s + 100125us esp32         21B                      t10085D1D0C1E50800000
98 frame(s) in 4.0 s (24.5 frames/s)         # the port is free

$ sleep 12; bforge tail -c esp32c3.toml --duration 2s
0 frame(s) in 2.0 s (0.0 frames/s)           # the recorder took it back
```

The recorder kept its session through the yield and continued afterwards: 264
chunks at 24 s, 290 at 25 s, and the vault sealed cleanly at the end.

## Test

```sh
cargo test -p bforge-core --lib control
cargo test -p bforge-core --test reconnect
cargo test -p bforge-cli
```

Control, 5 tests: a request reaches the target with its window, an unknown port and
a bad request are refused, status is passed through, the endpoint file is keyed by
device, and a session publishes its address and removes the file on drop.

Pipeline, 1 test: a port held by another program is released, the state shows
`yielded`, and the reader takes it back by itself once the window ends.

CLI, 2 tests: a missing `-c` is refused, and a device with no session is named in
the error.
