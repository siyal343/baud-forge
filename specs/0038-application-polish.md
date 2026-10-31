# 0038 An application, not a window around one

Status: accepted (1 November 2026). Closes D-98, D-99, D-100 and the inspector half of D-69.

## Problem

After 0.7.0 the shell had a picker, but the window still wore the operating system's title
bar, forgot its size on every launch, had no way to stop or change a session without
restarting the app, and the inspector listed decoded fields flat — no groups, and no way to
see that `samples` was one field repeated four times.

## Scope

Window geometry, a session menu, a frameless window whose ribbon is the title bar, four
layout tiers instead of one, and a field tree in the inspector. Not in this stage: drag-to-
dock panels, per-tier layout persistence (the guide asks for it; one geometry is what exists),
and moving the tree into the engine — the tree is built from the dotted field names the
decoder already emits.

## Behavior

### Geometry

1. On close, move and resize, the window writes `x`, `y`, `width`, `height` to
   `%APPDATA%/BaudForge/window.json` (at most once a second).
2. On launch it restores that size and position, clamped to the guide's 640×480 minimum.

### Session menu

3. Inside the shell, the ribbon offers **session: switch** (stop this session, go back to
   the picker) and **stop** (stop recording, keep the window).
4. The workbench is now served from the application bundle, not by the engine, and the
   engine is only its API: the shell navigates to `index.html?api=http://127.0.0.1:PORT`.
5. The engine answers `OPTIONS` with the CORS preflight headers, because a page from the
   application bundle is another origin from the engine.
6. A browser pointing at `bforge serve` still works: with no `api` parameter every request
   is relative, exactly as before.

### Frameless window

7. `decorations: false`. The ribbon is the drag region and carries **– □ ×** at its end; the
   picker has its own 32 px title bar with the same three controls.
8. Controls inside the ribbon are marked `no-drag`, so a button press is a button press.

### Layout tiers

9. Four tiers, as the guide specifies: 1440 and wider full, 1200–1439 dense, 960–1199 with a
   narrower rail, below 960 two columns with the stream and plot at 60/40 and the furniture
   underneath. The ribbon wraps instead of pushing the window controls out of the window.

### Field tree

10. The inspector groups dotted field names into a tree: `samples` becomes a parent with its
    four elements as children, each with its own value, offset, length and `plot` button.
11. Repeated names become `samples[1]`, `samples[2]` so each element stays addressable.
12. Hovering a node still highlights its bytes in the hex row.

## Measured

```text
geometry       save -> {"x":120,"y":90,"width":1100,"height":700}
               restore -> window at 120,90 size 1116x739 (client 1100x700 plus borders)
frameless      window 1386x788 with no OS title bar; ribbon carries the three controls
picker         title bar "BAUDFORGE", Open workspace…, Try a demo, one recent workspace
session menu   "session: switch" and "stop" render only inside the shell
tree           samples (parent) > samples (child) with @17+1 and a plot button
```

Captures: `docs/screenshots/workbench.png`, `docs/screenshots/picker.png`.

## A false alarm worth recording

The first frameless capture looked scrambled — plot above stream, port cards at the bottom.
The cause was not the layout code: the window was 1116 physical pixels on a 125 % display,
which is **893 CSS pixels**, and the old single breakpoint at 1100 px put it in the narrow
tier. The fix was to implement the guide's four tiers and to make the narrow tier sane, not
to move a number.

## Test

```sh
cd ui && npm run build
cargo test --workspace --exclude bforge-gui
cargo build -p bforge-gui
```

Layout, geometry and the tree are verified by running the application and capturing the
window; there is no browser harness for them (see spec 0029 on headless Edge).

## Limits, recorded

- One geometry, not one per width tier (the guide asks for per-tier persistence).
- The tree is built in the front end from dotted names; the engine's field list stays flat.
- `session: switch` and `stop` are not covered by an automated test: clicking a native
  window is outside what this project can drive today.
