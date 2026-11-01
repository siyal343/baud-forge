# 0052 Timed pin sequence and paced send

Status: accepted (2 November 2026). Closes D-114.

## Problem

The workbench could drive output pins only as static levels or single pulses. Entering a
hardware bootloader requires a multi-step sequence: hold DTR, wait, release RTS, and wait.
During pulse delays, the reader thread slept without reading, so bootloader banner bytes
were lost before disk capture.

Pasting a large block of bytes sent the entire buffer in one burst. Slow receivers with small
UART FIFOs dropped bytes when bursts exceeded buffer depth.

## Scope

Timed sequences for DTR and RTS on the reader thread. Active read dispatching during wait
periods between steps. Chunked pacing for transmit buffers with active read servicing between
chunks.

Out of scope: hardware GPIOs beyond DTR and RTS, hardware CTS handshaking, and cron schedules.

## Behavior

1. `PinStep` defines `dtr: Option<bool>`, `rts: Option<bool>`, and `wait_ms: u64`.
2. `Pipeline::run_pin_sequence` takes a sequence of `PinStep` items. It applies pin updates in
   order on the reader thread.
3. During `wait_ms` pauses, the reader thread calls `pump_one_slab` repeatedly. Incoming bytes
   are transferred into the logger ring without starvation.
4. `Pipeline::run_pin_sequence` returns the final `pins_out` bitmask as a `Result<u16, String>`.
5. `Session::run_pin_sequence` executes the sequence on the designated port and updates
   `running.info.pins`. It returns `Result<PinsView, SessionError>`.
6. `Pipeline::write_paced` accepts `bytes`, `chunk_size`, `pace` duration, and a timeout. When
   `chunk_size > 0` and `bytes.len() > chunk_size`, the buffer splits into chunks of `chunk_size`.
7. Between chunk writes, the reader thread services incoming reads for `pace` duration. Full-duplex
   echoes and status replies remain intact.
8. `Session::send_paced` integrates fault injection, script evaluation, and paced transport
   writes. It returns `Result<FaultOutcome, SessionError>`.

## Measured

Unit tests against mock transport with rate limiting:

```text
a_pin_sequence_applies_steps_in_order_and_keeps_reading:
- Applied: DTR=false/RTS=true -> 20 ms -> DTR=true/RTS=false -> 20 ms
- Final pins: DTR high, RTS low
- Recorded history matches exact step order: [RTS (0x0100), DTR (0x0080)]
- Slabs captured into logger ring during sequence: > 0 chunks read without stall

paced_write_delivers_all_chunks_without_dropping_reads:
- Input: 250 bytes, chunk size 100, pace 20 ms
- Delivered: 3 chunks (100 bytes, 100 bytes, 50 bytes)
- Verified: Concatenated chunks equal original payload
- Slabs captured into logger ring during pace pauses: > 0 chunks read without drops
```

## Test

Run the pipeline unit tests in `crates/bforge-core`:

```sh
cargo test -p bforge-core --lib pipeline::tests
```

Tests:
- `pipeline::tests::a_pin_sequence_applies_steps_in_order_and_keeps_reading`
- `pipeline::tests::paced_write_delivers_all_chunks_without_dropping_reads`

## Limits, recorded

- Pacing and sequence pauses are bounded by host operating system timer resolution (~1 ms on Windows).
- If the logger ring fills completely because disk logging stalled, the reader thread waits for ring slack before completing subsequent steps.
