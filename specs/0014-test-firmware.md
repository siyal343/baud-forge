# 0014 Test firmware

Status: accepted (28 October 2026). Closes D-09 and gives D-10 a way to run.

## Problem

Two requirements need firmware and had none: a flash tool must take the port while
BaudForge holds it (D-09), and 12 Mbaud must be proven on hardware rather than on a
mock (D-10). A sketch that only prints text cannot serve either, and it cannot
serve the dissector tests either: those need frames with a known layout.

## Scope

`firmware/bforge_test`, its command set and four streaming modes, and the host
configurations that match them. Not in this stage: a 12 Mbaud UART bridge, RTT or
CAN sources, and any fault the host cannot already ask for.

## Behavior

1. The sketch answers line commands at 115 200 baud, and keeps answering while a
   mode streams, so `stop` never blocks behind output.
2. Four modes: text lines, a packed `ImuPacket` frame with CRC-32C inside COBS, a
   sync-word frame with a u16 length and CRC-16, and a PRBS-31 bulk stream.
3. Every mode counts frames. The `imu` samples carry the low sequence bytes, the
   `sync` and `prbs` modes carry the sequence in a field, and the text mode prints
   it, so a host can prove that no frame was lost.
4. `badcrc`, `drop` and `trunc` change the next n frames, which lets a host test its
   error paths against real bytes.
5. `silence` stops output for a while, which is how a dead-man timer or an alert is
   tested without unplugging anything.
6. `rate 0` means as fast as the port allows, which is the only setting that can
   measure a ceiling.

## Measured

Flashing while BaudForge held the port, 28 October 2026:

```text
$ bforge record ... --duration 90s &          # holds COM8
$ bforge yield -c esp32c3.toml --port esp32 --for 60s
{"ok":true,"state":"yielded","port":"esp32","seconds":60}
$ arduino-cli upload -p COM8 --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" firmware/bforge_test
Wrote 298880 bytes (167212 compressed) at 0x00010000 in 1.3 seconds (1790.4 kbit/s).
Verifying written data...
Hash of data verified.
Hard resetting via RTS pin...
New upload port: COM8 (serial)
$ # the recorder reclaimed at the end of the window and sealed 79 chunks
```

That is D-09 closed: `esptool` opened the port, reset the board and wrote the
image while the session reported `yielded`, and the session took the port back
afterwards.

The new firmware, decoded by its own header through `bforge tail --fields`:

```text
     0.000s +      0us imu           23B C_STRUCT:ImuPacket  55 AA 03 11 8B F3 B7 0A 1C F9 96 43 8B 3C 11 00 30 40 01 EB E6 B3 DB
             sync                     +0x00  2B  43605
             version                  +0x02  1B  3
             flags                    +0x03  1B  1
             channel                  +0x03  1B  2
             timestamp_us             +0x04  4B  179827595
             v_batt_mv                +0x08  2B  7417
             gyro_z                   +0x0a  4B  0.017
             mode                     +0x12  1B  1
```

Throughput, `mode prbs 0` for ten seconds into a vault:

```text
sealed target/throughput.bflog: 28912 chunks, 6946726 bytes in 10.00 s (694673 B/s)
```

Two facts follow. The USB-Serial/JTAG path ignores the configured 115 200 baud and
runs at about **0.69 MB/s**, so this board cannot serve the 12 Mbaud test: that
needs a UART bridge. And 28 912 chunks for 6.9 MB means the reader receives
~240-byte chunks, so the 32-byte record header costs 12 percent of the file at this
rate, which is the cost D-14 and the coalescing decision are about.

## Test

The firmware is the test. `firmware/README.md` lists the commands, the payload
values a test can assert on, and the host configuration for each mode. A future
spec that needs real bytes points at this sketch instead of writing another one.
