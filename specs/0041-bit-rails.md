# 0041 Bit rails, and a mode per trace

Status: accepted (1 November 2026). The last of band 3B except stacked rows.

## Problem

A flags word drawn as a line is a number, not four switches. The band could show a state
lane for a small integer, but it could not show *which bits* were set over time, which is
what a protocol engineer asks first. And a trace's presentation was fixed by heuristics: a
value that happened to be discrete became a lane whether the person wanted that or not.

## Scope

A mode per trace — line, lane, bits — chosen by the person, carried in the URL, and drawn
accordingly. Not in this stage: several stacked plot rows sharing one time axis (D-106).

## Behavior

1. Each trace has a **mode**: `line` (a measurement), `lane` (a state, one block per change),
   or `bits` (a rail per bit of a flags word). The default is `line`.
2. The trace chip shows its mode and cycles it on click: `line → lane → bits → line`. The `×`
   removes the trace. Clicking a chip no longer removes it, which was too easy to do by
   accident.
3. `?plot=key:mode,key:mode` opens a view with those traces and modes, so a view is
   shareable and a capture can reach a mode without a click. `?plot=key` still means a line.
4. `bforge-gui <workspace> --plot "obc.flags:bits,eps.channel:lane"` does the same from a
   shortcut.
5. A bit rail draws one row per bit, up to 16, filled where the bit is set in the sample. The
   row count comes from the largest value seen, so a three-bit flags word gets three rows.
6. Lanes are only drawn for traces asked to be lanes; a discrete value plotted as a line stays
   a line, because the person chose.

## Layout fix found on the way

At 640×480 — the guide's minimum size — the narrow tier gave the stage a fixed 420 px and
the plot band fell off the window. The shell now scrolls the shell itself in that tier, so
every band stays reachable. That is the guide's rule: collapse, never remove.

## Measured

```text
window capture, 1440x900, --plot "obc.flags:bits,eps.channel:lane"
  chips read  "obc.flags bits ×"  and  "eps.channel lane ×"
  the band draws the 8-bit flags rail as rows of filled blocks
  the band names its renderer: webgl
```

`docs/screenshots/workbench.png` is that capture.

## Test

```sh
cd ui && npm run build
cargo build -p bforge-gui
```

The modes are verified by running the application with a `--plot` argument and capturing the
window; there is no browser harness for pointer interaction (spec 0029).

## Limits, recorded

- One plot row: several traces share one y axis, and stacked rows with their own scales are
  D-106.
- Bit rails are capped at 16 bits, which is a display choice, not a limit of the data.
- A rail with a full byte set and 200 Hz data is dense; zooming is not available, so the
  useful view is a window, not the whole recording.
