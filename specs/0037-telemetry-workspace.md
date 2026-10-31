# 0037 The telemetry workspace

Status: accepted (1 November 2026). The plot band becomes the guide's, and the stream
stops lying about how much it shows.

## Problem

The plot drew one series as an SVG polyline recomputed on every sample batch. It could not
follow a cursor, could not show two fields at once, and had no way to start a trace from
the field a person was looking at. The guide calls that last one a signature interaction:
*every numeric leaf has a plot icon*.

Separately, the footer's `sampled` warning — added in 0.5.1 — was reporting thousands of
dropped batches. That was not a rendering problem: the engine broadcast frames every 2 ms
and the event writer slept 500 ms between polls, so most batches were replaced before any
client could read them.

## Scope

A canvas telemetry band with several traces, a hover cursor, and a plot button on every
numeric field. Not in this stage: WebGL, state lanes, bitfield rails, and the DVR timeline
of the guide's band 3B (D-63 stays open for those), and a frameless window (D-100).

## Behavior

1. **One canvas, one animation frame.** The band draws with `requestAnimationFrame` at
   most every 16 ms, at device pixel ratio, with hairline grid lines and axis labels.
2. **Several traces.** The header offers `plot a field…` for every numeric field the
   decoder has seen, and each chosen trace appears as a chip in its own colour. Clicking a
   chip removes it. Six traces at most.
3. **A default trace.** With nothing chosen, the first numeric field is drawn, so the band
   is never empty when data exists.
4. **Hover reads values.** A dashed vertical line, a dot per trace, and the sample count
   show where the cursor is, so a spike can be read, not only seen.
5. **Plot from the inspector.** Every numeric leaf has a `plot` button, which adds
   `<port>.<field>` as a trace. This is the guide's `📈` interaction, in the place a person
   is already looking.
6. **Scrubbing still works.** When the slider leaves `live`, the traces read the window's
   frames instead of the live series, so the plot and the table describe the same moment.
7. **The stream shows the stream.** The engine broadcasts frame batches every 50 ms and the
   event writer polls every 20 ms, so a client receives every frame a browser can draw. A
   batch is still replaced if a client cannot keep up, and `sampled` still says so.

## Data

No contract change: traces are built from the existing `event: series` and from the
`fields` in each frame row. Colours come from a fixed list so a trace keeps its colour when
another is added.

## Measured

Before and after the two fixes, same loopback demo (200 Hz + 150 Hz):

| | Dropped batches | Frames received |
| --- | --- | --- |
| 0.6.0, frames every 2 ms | 14 269 in 60 s | ~200 |
| frame tick 50 ms, writer poll 500 ms | 1 951 in 114 s | 4 180 |
| frame tick 50 ms, writer poll 20 ms | **3 in 25 s** | **8 988 (≈360/s)** |

The window was captured with `PrintWindow` at 1386×788; `docs/screenshots/workbench.png` is
that capture, not a browser screenshot.

## Test

```sh
cd ui && npm run build          # type check, then the bundle
cargo test -p bforge-core --test serve
cargo build -p bforge-gui       # the shell that hosts it
```

## Limits, recorded

- Canvas drawing, not WebGL: several hundred points per trace and six traces are smooth;
  the guide's state lanes and DVR timeline are not here (D-63).
- The event writer polls every 20 ms per client; a condition variable would be cheaper
  (D-101).
- The window keeps the operating system's title bar (D-100).
- The inspector is still a flat list, so a "plot" button exists per leaf but not per tree
  node (D-69).
