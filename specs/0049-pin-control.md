# 0049 Pin control

Status: accepted (1 November 2026). Closes D-20.

## Problem

The workbench showed the input lines a port reported and could not touch the outputs. A board
that resets on DTR had to be reset with a finger, a terminal program, or the flash tool, and the
pin view could not say what state the session had driven.

## Scope

DTR and RTS per port: set them, clear them, or pulse them. Not in this stage: a pulse schedule,
a pin on a hardware trigger pin, or driving the outputs from a script.

## Behavior

1. `POST /api/pins {"port":"obc","dtr":true,"rts":false}` drives both lines and answers with
   what it set.
2. `pulse_ms` holds the pins and then clears them: `{"port":"obc","dtr":true,"pulse_ms":100}` is
   a reset pulse. A pulse is clamped to 500 ms because it holds the reader thread, which is also
   what makes it a real pulse: the line is held, not scheduled.
3. The request goes to the reader thread, which owns the transport, exactly as a write does. A
   serial port with a second writer is the race the reader exists to prevent.
4. The snapshot reports `pins.dtr` and `pins.rts` as **this session drove them**, so the pin view
   stops being write-only.
5. Each port card carries `DTR`, `RTS` and `PULSE` buttons. `PULSE` sends `dtr` high for 100 ms.
6. A transport without control lines says so: a TCP port answers `409` with
   `control pins on a TCP port is not supported by this transport`, and an unknown port says it
   is not in the session.

## Measured

Against the running window with the loopback demo, whose ports are TCP:

```text
POST /api/pins {"port":"obc","dtr":true}          -> control pins on a TCP port is not supported
POST /api/pins {"port":"nope","dtr":true}         -> port `nope` is not in this session
```

The refusal is the transport's own, which shows the request reached it. The success path is
covered by the pipeline test below, because this machine has no serial port to drive.

## Test

`crates/bforge-core/tests/pipeline.rs`, `pins_reach_the_transport_and_a_pulse_lets_go`: a mock
transport with a shared pin word proves that `DTR` arrives, that a 100 ms pulse takes at least
100 ms, and that it clears what it set. The mock gained `pins_handle()` for this.

```sh
cargo test -p bforge-core --test pipeline pins_reach
```

## Limits, recorded

- A pulse holds the reader for its length, so frames that arrive during a pulse are read after
  it. 500 ms is the cap, and a shorter pulse is what a reset needs.
- The state shown is what this session drove. A far end that changes its own pins is not
  reflected, and after a reconnect the drive state resets to unknown rather than being replayed.
- No scheduling: a pin cannot be pulsed every N seconds yet.
