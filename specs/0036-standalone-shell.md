# 0036 A standalone shell

Status: accepted (1 November 2026). The window stops needing a terminal.

## Problem

The desktop app was a wrapper around a command line. It required a workspace path as its
first argument, started the engine before the window existed, and gave no way to change
workspace or stop a session without closing it. That is not an application; it is a
shortcut for a command.

## Scope

The shell owns the engine's lifetime: a picker at launch, start and stop from the window,
a recent list, and a native file dialog. Not in this stage: window size and position
remembered across launches (D-98), a session menu inside the workbench (D-99), and
multiple simultaneous sessions.

## Behavior

1. Started with no arguments, the window shows a picker: **Open workspace…**, **Try a demo**,
   and the last eight workspaces used on this machine.
2. **Open workspace…** is a native file dialog filtered to `.bforge.toml`.
3. Choosing a workspace starts the engine **in this process** and moves the window to the
   workbench the engine serves, so the workbench keeps using relative `/api` paths.
4. The last eight workspaces are kept in `%APPDATA%/BaudForge/recent.json` (`XDG_CONFIG_HOME`
   or `HOME` elsewhere), newest first, deduplicated.
5. **Try a demo** opens `examples/loopback-demo.bforge.toml` when it sits beside the
   application, and says so plainly when it does not.
6. A workspace path on the command line still works and skips the picker, which is what a
   shortcut with an argument or a script does.
7. Starting a session while one runs stops the old one first, and waits for it to seal the
   vault before the next session begins.

## A route the ribbon needed

The guide puts a **Yield for flash** button in the ribbon, and there was no way to yield
from the window. `POST /api/yield {"port":"obc","seconds":30}` releases a port through the
same control path the CLI uses, answers `{"yielded_seconds":30}`, and `404` for a port that
cannot be yielded. The ribbon shows a `yield` action bound to that route and to `Ctrl+Y`.

## Visual alignment with the UI guide

The palette now uses the guide's own values — obsidian `#0B0E14`, slate `#111621`,
hairline `#1E2638`, emerald `#10B981`, cyan `#06B6D4`, amber `#F59E0B`, crimson
`#EF4444` — with tabular numerals, a 38 px ribbon and a 28 px footer. `Ctrl+1..5` focuses
the five zones, which the guide calls for and the workbench did not have.

## Data

Commands exposed to the picker page: `pick_workspace`, `recent_workspaces`,
`demo_workspace`, `start_workspace`, `stop_workspace`, `engine_state`. The window loads
`desktop.html` from the app bundle (`withGlobalTauri`), then navigates to the engine URL.

## Measured

```text
bforge-gui                          -> window "BaudForge", no engine, picker page
bforge-gui examples/loopback-demo.toml
  engine on http://127.0.0.1:51891/
  ports [('obc','open',13568), ('eps','open',10182)], 1 bridge
  POST /api/yield {"port":"obc","seconds":5} -> {"port":"obc","yielded_seconds":5}
  GET /  -> the built workbench (assets/index-*.js)
```

## Test

```sh
cargo test -p bforge-core --test serve   # including a_yield_request_releases_the_port
cd ui && npm run build
cargo build -p bforge-gui
```

## Limits, recorded

- Window geometry is not remembered (D-98).
- The picker is a page outside the workbench; the session menu the guide sketches inside
  the ribbon is not built (D-99).
- One session at a time.
- `rfd` adds a native dialog dependency; the GUI crate is Windows-built in CI, so the
  GTK side of that crate is never exercised here.
