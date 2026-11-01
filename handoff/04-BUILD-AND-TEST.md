# 04 — Build and test

Everything here was run on this machine (Windows 11, no serial hardware attached). Copy the
commands literally; the paths are real.

## Tools and where they are

| Tool | Command | Note |
| --- | --- | --- |
| Cargo | `export PATH="$PATH:/c/Users/mushii/.cargo/bin"` | Not on `PATH` in a fresh shell |
| Node | `export PATH="$PATH:/c/Users/mushii/AppData/Local/pi-node/current"` | Same |
| Python | `python --version` → 3.14.6 | Already on `PATH`; used for image crops and quick parsers |
| GitHub CLI | `export PATH="$PATH:/c/Program Files/GitHub CLI"` | For `gh run list`, `gh release view` |
| PowerShell | `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` | For screenshots |

Toolchains installed: `stable-x86_64-pc-windows-gnu` and `stable-x86_64-pc-windows-msvc`
(default). The GUI needs **MSVC**; the rest builds with either.

## The build that must stay green

```sh
export PATH="$PATH:/c/Users/mushii/.cargo/bin"
cd /f/Datapack/Personal/Programa/baud-forge     # or F:/Datapack/Personal/Programa/baud-forge

cargo fmt --all
cargo clippy --workspace --exclude bforge-gui --all-targets -- -D warnings
cargo test --workspace --exclude bforge-gui
```

The GUI crate is excluded from tests because Tauri needs a display and a long build; CI builds it
as the `desktop (windows)` job instead.

## Build directories

Two target directories are used on purpose:

| Path | Purpose | Why |
| --- | --- | --- |
| `CARGO_TARGET_DIR=/tmp/bf-msvc` | Debug builds of everything, MSVC toolchain | Keeps `target/` clean and lets the GUI build |
| `/tmp/bf-target` | Release builds of the examples | The simulators run from here, e.g. `/tmp/bf-target/release/examples/s8_device_sim.exe` |

Commands:

```sh
# everything except the GUI, MSVC, with a separate target dir
CARGO_TARGET_DIR=/tmp/bf-msvc cargo +stable-x86_64-pc-windows-msvc build -p bforge-cli

# the desktop window
CARGO_TARGET_DIR=/tmp/bf-msvc cargo +stable-x86_64-pc-windows-msvc build -p bforge-gui

# the simulators, release, so they keep up with the demo rates
CARGO_TARGET_DIR=/tmp/bf-target cargo +stable-x86_64-pc-windows-msvc build --release -p bforge-core --example s8_device_sim
```

The binary lands at `/tmp/bf-msvc/debug/bforge.exe`, `/tmp/bf-msvc/debug/bforge-gui.exe`.

## The frontend

```sh
export PATH="$PATH:/c/Users/mushii/AppData/Local/pi-node/current"
cd ui && npm run build        # vite build into ui/dist, which the engine serves
```

`npm run dev` proxies the engine with hot reload, but the desktop window always serves
`ui/dist`. **Rebuild `ui/dist` before you judge a UI change**, then launch the window: it appends
a per-launch nonce to the URL, so a rebuilt bundle is picked up. Without the nonce the webview
serves the old bundle and you will debug a feature that already works. That has happened here.

## Run a live session

The demo needs two simulators, because its ports are TCP clients:

```sh
/tmp/bf-target/release/examples/s8_device_sim.exe 127.0.0.1:9100 200 &
/tmp/bf-target/release/examples/s8_device_sim.exe 127.0.0.1:9101 150 &
sleep 2
/tmp/bf-msvc/debug/bforge-gui.exe examples/loopback-demo.bforge.toml --plot "obc.v_batt_mv,eps.gyro_z"
```

Useful flags, all of which exist today:

```text
--plot "obc.v_batt_mv,eps.gyro_z:lane"   traces, with a mode per trace
--rows stack                             stacked rows with their own scales
--vault /tmp/demo.bflog                  where this session records
--query "play=1"                         start playback once ten seconds exist
--query "export=saleae"                  record four seconds, then save a file
--query "typed=1"                        open the command forge on the typed form
bforge-gui --review --vault /tmp/demo.bflog   read a finished capture, read-only
bforge-gui /tmp/demo.bflog                    the same thing, by extension
```

The engine listens on a loopback port; find it with:

```sh
pid=$(ps -W | grep -i bforge-gui | awk '{print $4}' | head -1)
netstat -ano | grep LISTENING | grep -w "$pid"
curl -s http://127.0.0.1:<port>/api/health
```

The GUI opens two ports; only one answers `/api/health`.

## Screenshots

`handoff/tools/shot.ps1` captures the window with `PrintWindow`, which works for the frameless
Tauri window even when it is not focused:

```sh
cd /tmp
powershell -NoProfile -ExecutionPolicy Bypass -File /f/Datapack/Personal/Programa/baud-forge/handoff/tools/shot.ps1 \
   -Process bforge-gui -Title BaudForge -Out "$TEMP/window.png"
```

Then crop with Python, which is how every screenshot in `docs/screenshots` was produced:

```sh
python -c "
from PIL import Image
image = Image.open(r'C:\Users\mushii\AppData\Local\Temp\window.png')
image.crop((265, 425, 1115, 455)).resize((1700, 60)).save(r'C:\Users\mushii\Temp\tl.png')
"
```

Two habits that save time:

1. **Zoom before you read a number off a screenshot.** A 55 was once read as 95 at a downscale,
   and a fine bug hunt followed a bug that did not exist.
2. **Delete the captures when you are done**, so the next crop is not a stale file.

## Killing what you started

Always kill by PID, never by image name. A blanket `taskkill /IM explorer.exe` closed the user's
desktop once.

```sh
ps -W | grep -iE "bforge-gui|s8_device_sim" | awk '{print $4}' | while read p; do taskkill //PID $p //F >/dev/null 2>&1; done
```

`taskkill /PID <n> /T` kills the process tree when the simulator has children.

## When the build says "Access is denied"

A running `bforge-gui.exe` holds the output file. Kill it, wait two seconds, build again. If the
build fails this way and you then launch the old binary, you will be looking at the previous
build — which is exactly how an hour was lost on the review-mode landing.

## CI

```sh
export PATH="$PATH:/c/Program Files/GitHub CLI"
gh run list --limit 3 --json name,conclusion,headSha --jq '.[]|"\(.name) \(.conclusion // .status) \(.headSha[0:7])"'
gh run view <run-id> --log-failed | head -40
```

Nine jobs: `format and lints`, five native `test (...)` runners (windows/linux/macos,
x86_64 and aarch64), `ui (build)`, `desktop (windows)`, and a macos x86_64 cross-build.

A green run takes about nine minutes. Poll it with `sleep 400` once, or check the last commit's
status with `gh api repos/siyal343/baud-forge/commits/<sha>/check-runs`.

## Nightly

`.github/workflows/nightly.yml` runs a soak at 03:00 UTC and on demand. It is the only place
long-running behaviour is exercised:

```sh
gh workflow run nightly.yml -f seconds=600 -f size_mb=256
```
