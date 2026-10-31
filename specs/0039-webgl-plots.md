# 0039 GPU traces and state lanes

Status: accepted (1 November 2026). Most of D-63.

## Problem

The telemetry band drew with the 2D canvas: every sample was a `lineTo` on the CPU, and
there was no way to show a field that is a *state* rather than a measurement. The UI guide
asks for 60 FPS WebGL plots with state lanes, and names that as band 3B.

## Scope

GPU line strips, a 2D overlay for everything that is not data, and state lanes. Not in this
stage: the DVR timeline with a draggable playhead over wall-clock time (needs the timestamp
index, D-68), and multiple stacked plot rows.

## Behavior

1. **Two canvases, one band.** Traces are drawn by WebGL2 into a lower canvas; the grid,
   axis labels, cursor and lanes are drawn by a 2D context into an overlay above it. A
   canvas owns exactly one context, and drawing text as geometry would be worse than a
   second canvas.
2. **60 FPS by construction.** One `requestAnimationFrame` loop; at most one draw per 16 ms;
   one buffer upload per trace per frame. The data arrives every 50 ms, so most frames
   redraw the same points — that is what keeps the cursor and the autoscale responsive.
3. **A visible fallback.** Without WebGL2 the same traces are drawn with the 2D context. The
   band's header names the renderer it got (`webgl` or `canvas`), so the state is never a
   guess.
4. **State lanes.** A trace whose values are whole numbers with at most eight distinct values
   is not a line: it draws as a strip of blocks, one per change, shaded by level. `mode` and
   `flags` read as states; `gyro_z` still reads as a line.
5. **A shareable selection.** `?plot=port.field,port.field` preselects traces, next to the
   existing `?at=` and `?bridge=` parameters.

## Measured

```text
window capture, loopback demo, 1386x788
  telemetry header reads "webgl"
  trace shape identical to the 2D version, overlay grid and labels on top
  inspector tree on the right, stream with DIR column on the left
```

`docs/screenshots/workbench.png` is that capture.

## Test

```sh
cd ui && npm run build
cargo build -p bforge-gui
```

There is no automated check that WebGL is active: the badge in the header is the evidence,
and it is visible in a capture of the running window.

## Limits, recorded

- The DVR timeline in the guide's 3B is still missing: the scrubber moves by record, not by
  time, and there is no draggable playhead over both the plot and the log (D-68).
- State lanes are implemented and type-checked but not captured: reaching them needs a
  discrete field selected, which the capture cannot click. Recorded as D-104.
- One plot row; the guide's stacked rows and bitfield rails are not built.
