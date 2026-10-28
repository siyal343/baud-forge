# Test firmware

`bforge_test` is a serial test instrument for BaudForge. It is not a product
sketch: it exists so host tests can ask real firmware for a known byte stream, and
it runs on an ESP32-C3 over the built-in USB serial port.

## Build and flash

```sh
arduino-cli core install esp32:esp32
arduino-cli compile --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" firmware/bforge_test
arduino-cli upload  --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" -p COM8 firmware/bforge_test
```

`CDCOnBoot=cdc` is required: it maps `Serial` to the USB port, which is the one
that appears as a COM port.

To flash while BaudForge holds the port, yield it first:

```sh
bforge yield -c esp32c3.toml --port esp32 --for 60s
arduino-cli upload --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" -p COM8 firmware/bforge_test
```

## Commands

One line each, ended by `\n`. Replies start with `OK` or `ERR`. Commands work while
a mode streams, so `stop` always answers. `Ctrl-C` (0x03) also stops.

| Command | Effect |
| --- | --- |
| `id` | `OK id bforge_test 1.0.0 ESP32-C3 160000000` |
| `help` | The command list |
| `hb on` / `hb off` | Heartbeat line `HB <ms> <seq>` every second |
| `mode text [hz]` | Printable lines, LF terminated |
| `mode imu [hz]` | 19-byte packed frame plus CRC-32C, COBS encoded, zero delimited |
| `mode sync [hz]` | Sync word `AA 55`, u16 big-endian length, payload, CRC-16/CCITT-FALSE |
| `mode prbs [hz]` | PRBS-31 bulk bytes with a 256-byte block header |
| `rate <hz>` | Change the rate. `0` means as fast as the port allows |
| `stop` | Back to idle, `OK stop <frames emitted>` |
| `silence <ms>` | Emit nothing for that long, to test a dead-man timer |
| `badcrc <n>` | Corrupt the checksum of the next n frames |
| `drop <n>` | Do not emit the next n frames |
| `trunc <n>` | Shorten the next n frames by five bytes |

Every mode counts frames, so a host can see a gap. The `badcrc`, `drop` and
`trunc` commands are how host-side error paths meet real bytes instead of a mock.

## Host configuration that matches each mode

```toml
# mode text
framing = { mode = "delimiter", delimiter = 0x0A }

# mode imu, dissected with the fixture header
framing = { mode = "cobs", crc = "crc32c" }
dissector = { type = "c_header", file = "crates/bforge-dissect/tests/fixtures/imu_packet.h", root_struct = "ImuPacket" }

# mode sync
framing = { mode = "header_length", sync = "AA 55", length_offset = 2, length_width = "u16_be", length_adjust = 4 }
```

## Payloads a test can assert on

`mode imu` writes the 19 bytes the fixture header describes:

| Field | Value |
| --- | --- |
| `sync` | `0xAA55` little endian on the wire |
| `version` | 3 |
| `flags` | `seq & 7` |
| `channel` | `(seq >> 3) & 0x1F` |
| `timestamp_us` | `micros()` |
| `v_batt_mv` | `7400 + seq % 800`, big endian |
| `gyro_z` | `0.001 * (seq % 1000)` |
| `samples` | low sequence bytes, `0x30`, `0x40` |
| `mode` | 1 |

A 4-byte CRC-32C follows the struct, so the frame is 23 bytes before COBS.

`mode text` writes `T <ms> <seq> <value> crc=<crc8>`.
`mode prbs` writes blocks of 256 bytes: `AA 55`, `seq` as u32 little endian, `0xC3`,
a xor of the sequence bytes, then PRBS-31 bytes.

## Measured

28 October 2026, ESP32-C3 on COM8, USB-Serial/JTAG:

- `mode imu` decodes through its own header in `bforge tail --fields`.
- `mode prbs 0` sustains **694 673 B/s** (about 0.69 MB/s) into a `.bflog`: the USB
  path ignores the configured 115 200 baud, and it tops out below the 1.2 MB/s that
  12 Mbaud needs. A UART bridge is required for that test.
- 28 912 chunks for 6.9 MB shows the reader receiving ~240-byte chunks, so the
  32-byte record header costs 12 percent of the file at this rate.
