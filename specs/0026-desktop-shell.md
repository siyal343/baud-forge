# 0026 Desktop shell

Status: accepted (29 October 2026). Closes D-62.

## Problem

The workbench ran in a browser against `bforge serve`. That is a fine development
loop and a poor product: two terminals, a URL to remember, and a browser tab among
many. The plan always had a window; the block was the MSVC linker, which this machine
now has.

## Scope

A window that hosts the existing workbench and the existing engine. Not in this
stage: an installer (D-74), recording from the window (D-75), a designed icon set
(D-76), and a verified macOS or Linux shell (D-77).

## Behavior

1. `bforge-gui <workspace.toml>` starts the engine on a thread, bound to
   `127.0.0.1:0`, and opens a Tauri window pointed at that address.
2. The window loads the same `ui/dist` the browser loads. `bforge serve` gained
   `--ui`-style static serving: files under the directory are answered with their
   content type, and any other path falls back to `index.html`, because the app
   routes on the client. Without a directory the built-in placeholder page is served
   as before.
3. The GUI is a host, not a second engine: it builds the session with
   `session_ports_from_config`, enables decoding, bridges and symbols exactly as
   `bforge serve` does, and calls the same `Server::run`.
4. A missing or broken workspace stops the process with a message on stderr; the
   shell does not invent an empty session.
5. `toml` is the only new dependency in the GUI crate; the engine pieces were already
   there.

## Data

No contract change. The window is a webview onto `/`, `/api/snapshot`,
`/api/events`, `/api/send`, `/api/fault`, `/api/vault`.

## Measured

On this machine, MSVC toolchain, debug build:

```text
cargo build -p bforge-gui --release        # builds tauri 2.12.5, wry, webview2-com
bforge-gui C:/…/serve-ui.toml
  bforge-gui: engine http://127.0.0.1:54348/, workspace …/serve-ui.toml
Get-Process bforge-gui → Id 17924, MainWindowTitle "BaudForge"
GET /api/health   → {"ok":true,"service":"bforge-serve","version":"0.1.0","contract":1}
GET /api/snapshot → {"contract":1,…,"chunks":1888,…}   (a simulator on loopback)
GET /               → the built index.html
GET /assets/index-*.js → 200 text/javascript
```

A build fault found on the way: the GUI spawns the server on a thread, which the
session could not do because `Box<dyn ByteMachine>` was not `Send`. Every framing
machine is a plain struct, so the trait object is now `+ Send`; one bound, no
behaviour change.

## Test

```sh
cd ui && npm run build
cargo build -p bforge-gui --release
cargo test --workspace --exclude bforge-gui
```

CI gains a `desktop (windows)` job: it builds the frontend, builds the shell with the
MSVC toolchain the runner already has, stages `bforge-gui.exe` next to `ui/`, and
uploads both as an artefact. The other jobs exclude the crate, because Tauri needs
platform libraries a headless Linux runner does not carry.

## Limits, recorded

- No installer or signing (D-74); the artefact is a folder with the executable and the
  frontend beside it.
- The window does not record: it opens a session without a vault, so the scrubber
  answers 404 (D-75).
- Icons are generated placeholders, one colour with no mark (D-76).
- Only Windows was built and run; macOS and Linux are untested (D-77).
