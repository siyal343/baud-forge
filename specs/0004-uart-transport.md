# 0004 UART transport

Status: accepted (28 October 2026). Implements F1.2.2, and the transport half of
F1.2.7.

## Problem

The core must read a serial port without losing bytes, and the same trait must
cover a socket. The crate that wraps the platform API decides what is possible
later: arbitrary baud, data bits, parity, stop bits, the four modem inputs and
the two outputs.

## Scope

`UartTransport` and `TcpTransport`, both behind `TransportDriver`. Not in this
stage: port binding by USB tuple (F1.2.4), hotplug and reconnect (F1.2.5), port
yield (F1.2.6), UDP and multicast.

## Gate G1: driver base

**Decision:** the `serialport` crate, with a platform shim kept possible.

What the crate covers on Windows, measured on 28 October 2026:

| FR-HAL-01 item | State |
| --- | --- |
| Baud rate, 110 to 12 000 000 | works; the value is passed as an integer |
| Data bits 5, 6, 7, 8 | works |
| Parity none, odd, even | works |
| Parity mark, space | no variant in the crate; returns `Unsupported` |
| Stop bits 1 and 2 | works |
| Stop bits 1.5 | no variant in the crate; returns `Unsupported` |
| DTR and RTS output | works |
| CTS, DSR, DCD, RI input | works |
| USB vid, pid and serial number | works; required by F1.2.4 |

So F1.2.2 is complete except two parity modes and 1.5 stop bits. Both return
`TransportError::Unsupported` with the feature id, and neither blocks S2.
F1.2.1 carries them: a per-platform shim is required only if a user needs them,
which is why the trait stays object safe and the crate stays behind it.

`read_pins` takes `&mut self` because the platform calls behind it do. The trait
changed for that reason; every implementation follows it.

## Behavior

1. `open` maps the line settings and returns `Unsupported` for a setting the
   platform cannot express. It never silently substitutes another setting.
2. `read_slab` returns 0 on a read timeout and passes every other error up. A
   timeout is idle time, not a fault.
3. `read_pins` samples CTS, DSR, DCD and RI, and reports what it read.
4. `set_pins` drives DTR and RTS only. Nothing else is touched.
5. `pulse_rts` asserts RTS, holds it, then releases both outputs. On boards that
   wire RTS to EN this restarts the target.
6. `available` lists every serial port with its USB identity when the platform
   exposes one. A port that is not USB reports `None`, not a guess.
7. A TCP transport has no control lines: `set_pins` returns `Unsupported`,
   `read_pins` returns an empty bitmask, and a closed peer returns
   `Disconnected`.

## Data

`UartConfig`: `device`, `line` (`LineConfig` from the ADR: baud, data bits,
parity, stop bits), and `read_timeout`, default 50 ms.

## Test

```sh
cargo test -p bforge-hal
```

- `client_round_trips_against_a_plain_listener`: a client writes and reads an
  echo, and reports its local and remote addresses.
- `a_closed_peer_is_reported_as_disconnected`.
- `pins_are_not_supported_on_a_socket`.

Hardware run, 28 October 2026, ESP32-C3 on `COM8`, 115 200 baud, three seconds,
`cargo run -p bforge-core --release --example s2_uart -- COM8 115200 3`:

```text
serial ports the operating system reports:
  COM8     vid:pid 303a:1001  serial 30:ED:A0:5B:0C:84
  COM4     vid:pid         -  serial -
  COM3     vid:pid         -  serial -

opened COM8 at 115200 baud
modem pins: CTS false DSR false DCD false RI false
RTS pulsed: the target should restart
first 512 bytes after reset:
  0000  74 31 30 30 38 30 46 32 39 45 33 31 42 37 39 38  |t10080F29E31B798|
  ...
  0030  30 45 30 30 30 32 46 46 45 36 46 45 30 30 0d 54  |0E0002FFE6FE00.T|

recorded 62 chunks, 977 bytes in 3.00 s (326 B/s), read errors 0
reader: 62 chunks, damaged tail false

record 0 at 96 us, 55 bytes
  0000  6c 6f 61 64 3a 30 78 34 30 33 63 62 66 31 30 2c  |load:0x403cbf10,|
  0010  6c 65 6e 3a 30 78 39 66 34 0d 0a 6c 6f 61 64 3a  |len:0x9f4..load:|
  0020  30 78 34 30 33 63 65 37 31 30 2c 6c 65 6e 3a 30  |0x403ce710,len:0|
  0030  78 32 65 39 34 0d 0a                             |x2e94..|
```

The ROM boot log after the RTS pulse is the proof that open, read and pin
control work on real hardware: `load:0x403cbf10,len:0x9f4` is the second-stage
bootloader loading the application image.

## Findings

- **The port named by a user may not be the board.** In this run `COM3` and
  `COM4` were Bluetooth serial links with no USB identity; the ESP32-C3 was on
  `COM8` (`303a:1001`). F1.2.4 exists because of exactly this.
- **Real UART reads fragment.** 977 bytes arrived as 62 chunks, 15.8 bytes each.
  The 32-byte record header then costs three times the payload. The driver
  returns as soon as any byte is present, which is correct for latency. A short
  idle-coalescing window in the reader, or idle-gap framing in F1.4.5, removes
  the cost. Not changed in S2: it does not affect the 12 Mbaud target, where a
  read returns a full slab.
- **Throughput was not measured on hardware.** The target needs a firmware that
  streams without pause; that is F1.6.1. This run proves the path, not the rate.
