# 0042 Stacked rows, and a cache that lied

Status: accepted (1 November 2026). Closes D-106 and with it band 3B.

## Problem

Every trace shared one y axis. A battery voltage around 8 V and a gyro rate around 0.5
flattened each other: one trace was a straight line, the other a thin band. The guide's band
3B asks for several rows, each with its own scale, sharing one time axis.

## Scope

Rows for measurements. Lanes and rails keep the strip under the rows, because they are states
and bits, not magnitudes.

## Behavior

1. **`rows: 1` / `rows: stacked`** in the band's header. Stacked gives each measurement its own
   row, up to three, with a 10 px gap.
2. Each row has **its own scale and its own grid**: two or three ticks, its own range, and the
   trace's name in its colour at the top left of the row.
3. The cursor crosses every row, with a dot per trace at that sample, so a moment is read
   across all of them at once.
4. Lanes and rails sit under the rows in a shared strip, since they have no magnitude.
5. `?rows=stack` and `bforge-gui <workspace> --rows stack` open a view already stacked.

## The bug that cost an afternoon

Two captures in a row showed `No numeric fields yet.` while the engine was demonstrably
sending 20 series frames every four seconds. The front end was correct; the **webview was
running a cached bundle**. Tauri serves the frontend from the application bundle by URL, and a
rebuilt `index.html` at the same address is not revalidated, so a new build could be invisible
until the cache was cleared by hand. The navigation URL now carries `&v=<milliseconds>`, a
nonce per launch.

Finding it needed evidence rather than reasoning: a temporary counter in the footer showed
`ser 75` with `series 0`, which separated "the frame never arrived" from "the frame arrived
and did not land". The counter is gone; the lesson is in this spec.

## Measured

```text
window capture, 1440x900, --plot "obc.v_batt_mv,eps.gyro_z,obc.channel:lane" --rows stack
  row 1   v_batt_mv   8263 .. 7336
  row 2   gyro_z       0.86 .. 0.17
  lane    channel      amber blocks under the rows
  header  "rows: stacked" · "webgl" · "plot a field... (18)"
```

`docs/screenshots/workbench.png` is that capture.

## Test

```sh
cd ui && npm run build
cargo build -p bforge-gui
```

Verified by running the application and capturing the window; there is no browser harness for
this band (spec 0029).

## Limits, recorded

- Three rows at most, and no drag to reorder or resize a row.
- Rows are assigned in trace order, not by unit or magnitude.
- The cache nonce fixes staleness for the desktop shell; a browser pointed at `bforge serve`
  still caches normally, which is correct for a server that serves its own files.
