# Desktop Launcher

The launcher is the desktop application's first screen: it is where a session begins — pick a workspace, reopen a recent one or a saved profile, run the demo, review a capture, quick-connect, or configure a brand-new session without writing a single line of TOML.

![The desktop launcher with the CONFIGURE SESSION form](img/launcher.png)

It appears only inside the desktop shell when no engine session is running; once a workspace starts, the workbench replaces it. **DISCONNECT in the ribbon stops the session and returns here** — the vault is sealed and the port released, so reconnecting (even after physically replugging a device) is one click.

## CONFIGURE SESSION (no TOML needed)

Every session parameter, exposed:

- **Profile name** — saved for reuse; the session also shows under this name.
- **Port id** — the name the workbench shows for the port (`dev`, `esp`, …).
- **Serial port** — dropdown of detected ports (with USB identity) or a manual device path.
- **Baud rate** — presets (9600 … 2M) or a custom value; data bits, parity, stop bits.
- **Framing** — `delimiter` (with the byte in hex), `cobs`, `slip`, `intel_hex`, `header_length` (sync word, length offset/width), `idle_gap` (µs of silence).
- **Checksum** — `none`, `crc8`, `crc16_ccitt_false`, `crc32c`.
- **Protocol dissector** (optional) — pick a C header file and the root struct name. Frames decode live; change it later in [Schema Dialects](schema-dialects.html).

**START SESSION** starts the engine with this configuration immediately (and saves it as a profile when a name is given). **SAVE PROFILE** stores just the configuration.

## SAVED PROFILES

Every configured session is stored as `<name>.bforge.toml` in the profiles folder (beside the recents list). Each profile is a one-click button on the launcher — the same kind of session never needs configuring twice. `×` deletes a profile.

## OPEN WORKSPACE…

Opens a native file dialog for a `.bforge.toml` workspace. The engine starts **in the same process** — the ports are owned by the app you launched — and the window navigates to the workbench. The workspace is added to the recents list.

A workspace can also be passed on the command line (`bforge-desktop.exe path\to\workspace.bforge.toml`): the engine starts immediately and skips the launcher.

## Recent workspaces

Up to 8 recent workspaces as one-click buttons (path in the subtitle, name in bold). The list lives beside the window-geometry file, so a launch looks like the last one.

## DEMO (loopback, no hardware)

Starts the bundled loopback workspace: two simulated devices (`loopback-a` OBC simulator, `loopback-b` EPS simulator) joined by a forwarding bridge. It needs no board and no configuration — the ideal first look at every panel, and it exercises the full decode path (COBS framing, CRC32C, a 12-field C-struct dissector).

## REVIEW A CAPTURE (.bflog)

Opens a recorded [vault](rec-vaults.html) **read-only**: no ports are opened, nothing records, the file cannot be damaged. Frames decode with the workspace sidecar written beside the capture, so the review shows the same dissection the session had. Use it to inspect a bug-report capture someone else sent you.

## QUICK CONNECT (serial, 115200 8N1)

The fastest path to a live link with no configuration at all:

1. The port list shows every serial port the OS reports (with USB identity when known — `COM8 (303a:1001)`).
2. Pick one, press **CONNECT**.
3. BaudForge writes a temporary workspace (delimiter framing at 115200 8N1, no dissector), starts the engine on it and opens the workbench. Frames arrive raw — add a dissector live via [Schema Dialects](schema-dialects.html) or configure a proper session when the shape of the protocol is clear.

## After the launcher

- The ribbon must read **LINK OPEN** — `SIMULATED` means no engine session is behind this page (see [Troubleshooting](troubleshooting.html)).
- **DISCONNECT** in the ribbon stops the session gracefully (vault sealed) and brings the launcher back — the way to start a different session without closing the application.
- The engine stops with the app; the session's raw capture is sealed automatically on exit (see [REC & Vaults](rec-vaults.html)).
- Only one program on the machine can hold a serial port — if the launcher's session shows the port `closed`, check for another engine (see [Troubleshooting](troubleshooting.html#the-port-will-not-open)).
