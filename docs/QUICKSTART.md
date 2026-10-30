# Quickstart

Three ways in, depending on what is on your desk. Each one ends with something on
screen, not with a test passing.

## 1. No hardware: two simulators, one bridge

Two loopback devices, joined by a forwarding bridge, so the bus view has something to
show.

```sh
# terminal 1 and 2: the devices
cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9100 200
cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9101 150

# terminal 3: the engine and the workbench
cd ui && npm install && npm run build && cd ..
bforge serve -c examples/loopback-demo.bforge.toml --vault loop.bflog --ui ui/dist
```

Open <http://127.0.0.1:7717/>. You should see both ports `open`, a stream of
`C_STRUCT:ImuPacket` frames, the telemery plot moving, and `bus obc↔eps` selected with
frames from both sides.

Things worth trying:

- Hover a decoded field in the inspector: the bytes it came from light up.
- Drag the scrubber: the stream and the plot switch to the vault.
- Type `AA 55 03` in the command forge, pick `crc32c`, press Send: the answer says how
  many bytes left.
- Arm a fault: kind `bit flip`, amount `1.0`. Send again; the answer reports
  `fault_bytes`. The devices receive corrupted bytes on purpose.

## 2. With a board: ESP32-C3

```sh
arduino-cli upload -p COM8 --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" firmware/bforge_test
bforge serve -c examples/esp32-demo.bforge.toml --vault demo.bflog --ui ui/dist
```

The firmware starts idle. Make it stream:

```sh
curl -X POST -d '{"port":"esp","hex":"6d 6f 64 65 20 69 6d 75 0a"}' \
  http://127.0.0.1:7717/api/send
```

That is `mode imu\n`. Frames appear as `C_STRUCT:ImuPacket` with a battery voltage, a
gyro rate and a mode. Other firmware commands: `rate <hz>`, `hb`, `id`, `help`,
`silence <ms>`, `badcrc <n>`, `drop <n>`, `trunc <n>`, `stop`.

When the session ends, the vault is sealed. Look at it without hardware:

```sh
bforge vault info demo.bflog
bforge assert demo.bflog -r rules.toml
```

## 3. The desktop window

```sh
cd ui && npm run build && cd ..
cargo build -p bforge-gui --release
./target/release/bforge-gui examples/esp32-demo.toml --vault demo.bflog
```

The window needs WebView2 (Windows 10 and 11 have it) and, to build, the MSVC toolchain:
`docs/GUI-SETUP.md`.

## When something is wrong

| Symptom | Cause |
| --- | --- |
| port stays `closed` | nothing is listening there; the port retries for a few seconds, then gives up |
| frames show as text, not fields | the dissector file or `root_struct` does not match the bytes |
| `0 frames` on a socket port | the device is not sending, or the framing mode is wrong for its format |
| the plot is empty | no numeric field yet; pick one from the selector |
| `404` from `/api/vault` | the server was started without `--vault` |
| `webview2` error on start | install the Evergreen runtime, see `docs/GUI-SETUP.md` |
| a send answers `409` | the port refused the write; check the state line in the sidebar |

## What 0.1 is not

No installer, no Lua scripting, no WebGL plots, no protobuf, no time-axis scrubbing, no
automatic reconnect for a bridge side that disappears. The complete list, with reasons,
is `DEFERRED.md`.
