# 0029 Paired bus view

Status: accepted (29 October 2026). Closes the view half of D-72.

## Problem

A bridge is a pair of ports, but the workbench drew every port in one table with no
notion of a pair. A tap therefore read as two interleaved streams: a person could not
say "this byte arrived on the OBC and that answer left for the EPS" without reading the
port column on every row.

## Scope

Choose a bridge and read its two ports as one time-ordered sequence, with a direction
on each row and one plot over the pair. Not in this stage: a per-direction queue (the
other half of D-72), live transmit rows (D-79), and a latency measurement between the
two sides.

## Behavior

1. When the workspace has bridges, the telemetry band shows a selector: `all ports` or
   `bus <a>↔<b>` per bridge.
2. A workspace with exactly one bridge opens on that bus, because there is no choice
   worth making.
3. Rows are filtered to the bridge's two ports and **sorted by their chunk timestamp**,
   so the table reads top to bottom in time order rather than in arrival order.
4. The field selector only offers series from the bridge's ports, so one plot covers
   the pair.
5. The stream header says which bus is shown.
6. `?bridge=<id>` in the page address opens the workbench on that bus.

## Data

No engine change: the rows already carried `port` (spec 0025) and `direction`
(spec 0028), which is exactly what a bus view needs.

## Measured

Live, two simulators on loopback (`127.0.0.1:9100` at 200 Hz, `127.0.0.1:9101` at
150 Hz), bridge `link` with `forward = true`:

```text
GET /api/snapshot
  ports    [("obc", 3137 chunks), ("eps", 2346 chunks)]
  bridges  [{"id":"link","a":"obc","b":"eps","forward":true,"forwarded":136550}]
```

The merged view is client-side; the build type-checks, and the runtime check found one
real fault before it shipped:

```text
Vite client error: ReferenceError: Cannot access 'bridgePorts' before initialization
```

A memo used the memo declared below it. Reordered, and the page renders again.

**No screenshot for this slice.** Headless Edge stopped producing output in this
session: the same flags that captured `docs/screenshots/workbench.png` now return an
empty DOM or no file, for the engine's page and the dev server alike. The API evidence
above is what was measured; the picture is not, and it is not claimed.

## Test

```sh
cd ui && npm run build      # type check and bundle
bforge serve -c <workspace with a bridge> --vault s.bflog --ui ui/dist
```

## Limits, recorded

- A bus shows frames, not causality: there is no match between a request and its
  answer, and no latency figure between the two sides.
- Live transmit rows still do not exist (D-79), so a bridge's writes appear only in a
  scrubbed window.
