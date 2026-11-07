# Desktop Launcher

The launcher is the desktop application's first screen: it is where a session begins — pick a workspace, reopen a recent one, run the demo, review a capture, or quick-connect to a serial port with no workspace file at all.

![The desktop launcher](img/launcher.png)

It appears only inside the desktop shell when no engine session is running; once a workspace starts, the workbench replaces it (the same engine that serves the browser serves the desktop).

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

The fastest path to a live link with no workspace file:

1. The port list shows every serial port the OS reports (with USB identity when known — `COM8 (303a:1001)`).
2. Pick one, press **CONNECT**.
3. BaudForge writes a temporary workspace (delimiter framing at 115200 8N1, no dissector), starts the engine on it and opens the workbench. Frames arrive raw — add a dissector live via [Schema Dialects](schema-dialects.html) or write a proper workspace when the shape of the protocol is clear.

## After the launcher

- The ribbon must read **LINK OPEN** — `SIMULATED` means no engine session is behind this page (see [Troubleshooting](troubleshooting.html)).
- The engine stops with the app; the session's raw capture is sealed automatically on exit (see [REC & Vaults](rec-vaults.html)).
- Only one program on the machine can hold a serial port — if the launcher's session shows the port `closed`, check for another engine (see [Troubleshooting](troubleshooting.html#the-port-will-not-open)).
