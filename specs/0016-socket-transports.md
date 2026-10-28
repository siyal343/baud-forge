# 0016 Socket transports

Status: accepted (28 October 2026). Completes the transport half of F1.2.7 and
gives CI a hardware-free path.

## Problem

`TransportDriver` had UART, TCP and no way to configure a socket port: the
workspace schema could only name a device. Every test therefore needed a board, the
12 Mbaud target cannot run without one, and a team whose telemetry arrives over a
radio link or a simulator had no way in.

## Scope

`transport` and `address` in a port, TCP client, TCP server and UDP, and a device
simulator that speaks the firmware's frame format over TCP. Not in this stage:
multicast group join (the socket binds the group address today), WebSockets, and
TLS.

## Behavior

1. A port names its transport: `serial` (default), `tcp-client`, `tcp-server` or
   `udp`. A socket port names an `address` as `host:port`.
2. Validation names what is missing: a socket port without an address, an address
   without a port, an unknown transport name, and a serial port with no binding.
   A serial port keeps the binding rules from before.
3. `tcp-client` connects on open, `tcp-server` listens and accepts one connection,
   and `udp` binds and treats each datagram as one read. A UDP write goes to the
   configured peer, or back to the last sender when no peer is set.
4. A socket has no control lines: `set_pins` reports that it is unsupported and
   `read_pins` returns an empty bitmask, so a workspace fails the same way on every
   transport instead of pretending.
5. A closed TCP peer is a disconnect, which the reader already reconnects on
   (`specs/0012`): a device that restarts is picked up the same way as a cable that
   moves.
6. `examples/s8_device_sim` serves the firmware's 19-byte `ImuPacket` frames, COBS
   encoded, to one client at a time and keeps listening. It is the device that CI
   can use.

## Data

```toml
[[ports]]
id = "sim"
transport = "tcp-client"          # or tcp-server, udp, serial
address = "127.0.0.1:9100"
baud_rate = 115200                # still required, still unused by a socket
framing = { mode = "cobs", crc = "crc32c" }
dissector = { type = "c_header", file = "…/imu_packet.h", root_struct = "ImuPacket" }
```

## Measured

28 October 2026, no hardware attached:

```text
$ cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9100 20 &
simulator listening on 127.0.0.1:9100 at 20 Hz

$ bforge tail -c sim.toml --duration 2s --fields
     0.000s +      0us sim           23B C_STRUCT:ImuPacket   55 AA 03 00 00 00 00 00 1C E8 00 00 00 00 00 00 30 40 01 E3 A8 30 75
             sync                     +0x00  2B  43605
             version                  +0x02  1B  3
             v_batt_mv                +0x08  2B  7400
             gyro_z                   +0x0a  4B  0.0

$ bforge record -c sim.toml -o target/sim.bflog --duration 3s
sealed target/sim.bflog: 60 chunks, 1500 bytes in 3.00 s (500 B/s)

$ bforge assert target/sim.bflog -c sim.toml -r sim.rules.toml
target/sim.bflog: 60 chunks, 1500 bytes, 60 decoded frame(s)
  PASS field      sync  60 of 60 `sync` value(s) equal `43605`
  PASS field      battery window  `v_batt_mv` ranges over 7400 to 7459 across 60 value(s)
  PASS protocol   schema matched  all 60 frame(s) are C_Struct:ImuPacket
3 of 3 checks passed
```

That is the whole chain — transport, framing, dissection, storage, assertion —
running in three processes with no board: which is what a CI job can do.

## A bug the demo found first

The simulator accepted one client and then dropped its listener, so `tail` worked
and the `record` that followed recorded nothing. It now loops over clients. The
run also showed the value of the checks in `assert`: with an empty vault the
report said "no decoded frames" three times instead of passing on nothing.

## Test

```sh
cargo test -p bforge-hal
cargo test -p bforge-core --test transports
cargo test -p bforge-core --test config_validation
```

`bforge-hal` gains three UDP tests: a datagram arrives whole and is answered to the
last sender, pins are unsupported, and a config keeps its peer. `transports` adds
two tests over real loopback sockets: a session records from a TCP device, and
`tail` decodes frames from one. `config_validation` adds three: a socket port needs
an address, an unknown transport is named, and a serial port still needs a binding.
