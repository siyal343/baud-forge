# Keyboard Shortcuts

Every shortcut works while focus is outside text fields and buttons — typing in the Command Forge or the filter box never triggers the DVR.

## Stream & DVR

| Key | Action |
|---|---|
| `/` | Focus the stream filter box |
| `Esc` | Clear the filter (works while typing in it) |
| `Ctrl+L` | Clear the stream buffer |
| `Space` | Pause / resume the live capture (`PAUSED AT T-x.xxxs`) |
| `←` / `→` | Step one frame back / forward while paused |

## Scope click

| Key | Action |
|---|---|
| Mouse click on the canvas | Snap the playhead + stream selection to the clicked instant ([Workflow B](oscilloscope.html#scope-click-sync-workflow-b)) |

## UI scale

| Key | Action |
|---|---|
| `Ctrl + =` / `Ctrl + +` | Scale the UI up by 5% |
| `Ctrl + -` | Scale the UI down by 5% |
| `Ctrl + 0` | Reset scale to 100% |

## Panels

| Key | Action |
|---|---|
| LAYOUTS & PANELS menu | Open any panel, including ones not in the current preset (Activity Log, Session Diff, Bridge, …) |

The panel layout (dockview) persists per browser: close, reorder and detach panels freely; presets (`Default`, `Dissector`, `Scope`, `HIL`) rebuild standard arrangements, and a saved layout survives reloads.

## Tips

- The scope canvas is a mouse-first instrument: cursor modes (`X1/X2/Y/X-Y`), cursor `SET/SNAP/CLR` and zoom live on the scope ribbon.
- `Esc` always wins over the a11y guard — even inside a text field it clears the filter first.
