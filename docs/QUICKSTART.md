# Quickstart

Five minutes, three ways in. Pick the one that matches what is on your desk.

## Nothing installed yet: the Windows window

1. Open <https://github.com/siyal343/baud-forge/releases/latest>.
2. Download `BaudForge_<version>_x64-setup.exe` and `SHA256SUMS.txt`.
3. Check the download, then run it:

   ```powershell
   Get-FileHash .\BaudForge_*_x64-setup.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
   ```

4. Windows shows *"Windows protected your PC"*. Choose **More info → Run anyway**. The
   binaries are unsigned; signing is deferred, and the checksum is how you know the file is
   the one CI built.
5. The installer puts a **BaudForge** shortcut in the Start menu.
6. Start it from a terminal so it can be given a workspace:

   ```powershell
   & "$env:LOCALAPPDATA\BaudForge\bforge-gui.exe" examples\loopback-demo.toml
   ```

   The window opens, the engine starts, and a vault is written to `%TEMP%`.

The GUI needs a workspace file; without one it says so and exits. The two example workspaces
ship in the repository — download the source zip, or clone it, to get them.

## The command line, no installer

Every release also carries the CLI per platform: `bforge-windows-x86_64.exe`,
`bforge-linux-x86_64`, `bforge-macos-aarch64`, and four more.

```sh
bforge help
bforge ports list          # what is plugged in, and which workspace port it matches
bforge config check my.bforge.toml
```

To record, tail or serve you need a workspace — a small TOML file naming the port and how
to frame it:

```toml
[workspace]
name = "demo"
version = "1.0"

[[ports]]
id = "esp"
device_path = "COM8"
baud_rate = 115200
framing = { mode = "cobs" }
dissector = { type = "c_header", file = "imu_packet.h", root_struct = "ImuPacket" }
```

Then:

```sh
bforge record -c my.bforge.toml -o session.bflog --duration 60s
bforge tail   -c my.bforge.toml --fields
bforge vault info session.bflog
bforge assert session.bflog -r rules.toml
```

## No hardware: two simulators and the browser

```sh
git clone https://github.com/siyal343/baud-forge && cd baud-forge

# terminal 1 and 2: the devices
cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9100 200
cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9101 150

# terminal 3: the frontend, then the engine that serves it
cd ui && npm ci && npm run build && cd ..
bforge serve -c examples/loopback-demo.bforge.toml --vault loop.bflog --ui ui/dist
```

Open <http://127.0.0.1:7717/>. Two ports `open`, a stream of `C_STRUCT:ImuPacket` frames,
the plot moving, and `bus obc↔eps` selected with frames from both sides.

Worth trying:

- Hover a decoded field in the inspector: the bytes it came from light up.
- Drag the scrubber: the stream and the plot switch to the vault.
- Command forge → **hex**: `AA 55 03`, checksum `crc32c`, Send. The answer says how many
  bytes left.
- Command forge → **typed**: pick a field, change it, Send. The engine encodes it with the
  port's own C header.
- Fault injector: kind `bit flip`, amount `1.0`, Arm, then Send again. The answer reports
  `fault_bytes`; the device received corrupted bytes on purpose.
- Fault injector: kind `delay`, amount `300`. The send answers at once with `delay_ms`, and
  the bytes arrive later.

## A real board: ESP32-C3

```sh
arduino-cli upload -p COM8 --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc" firmware/bforge_test
bforge serve -c examples/esp32-demo.bforge.toml --vault demo.bflog --ui ui/dist
```

The firmware starts idle. Make it stream:

```sh
curl -X POST -d '{"port":"esp","hex":"6d 6f 64 65 20 69 6d 75 0a"}' \
  http://127.0.0.1:7717/api/send
```

That is `mode imu\n`. Frames appear as `C_STRUCT:ImuPacket` with a battery voltage, a gyro
rate and a mode. Other firmware commands: `rate <hz>`, `hb`, `id`, `help`, `silence <ms>`,
`badcrc <n>`, `drop <n>`, `trunc <n>`, `stop`.

## Scripts

```toml
[workspace]
script_path = "examples/flip-last-byte.lua"       # transmit
rx_script_path = "examples/uppercase-on-receive.lua"  # receive
```

A script may work in hex, or in fields when its port has a C header:

```lua
bforge.on_frame(function(frame)
  frame:set("v_batt_mv", frame:get("v_batt_mv") + 100)
  frame:recalc_crc("crc32c")
  return frame
end)
```

## When something is wrong

| Symptom | Cause |
| --- | --- |
| port stays `closed` | nothing is listening; the port retries a few seconds, then gives up |
| frames show as text, not fields | the dissector file or `root_struct` does not match the bytes |
| `0 frames` on a socket port | the device is not sending, or the framing mode is wrong |
| the plot is empty | no numeric field yet; pick one from the selector |
| `404` from `/api/vault` | the server was started without `--vault` |
| `webview2` error on start | install the Evergreen runtime, see `docs/GUI-SETUP.md` |
| a send answers `409` | the port refused the write; check the state line in the sidebar |
| Windows warns before running | unsigned build (D-95); check `SHA256SUMS.txt` and run anyway |

## What this release is not

No installer signing (D-95), no macOS signing or notarisation (D-96), no WebGL plots
(D-63), no time-axis scrubbing (D-68), no protobuf/Kaitai/defmt/MAVLink decoder, no C++
demangling. The complete list, with a reason and an unblocking condition for each, is
`DEFERRED.md`.

Status and remaining scope: `STATUS.md`. What changed in each release: `RELEASE-NOTES.md`.
