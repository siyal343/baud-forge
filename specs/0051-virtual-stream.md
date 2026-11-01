# 0051 Virtualized stream viewport

Status: accepted (2 November 2026). Fulfills Milestone 2 viewport promise (A2).

## Problem

The stream table sliced the last 120 frames with `rows().slice(-120).reverse()`. Earlier frames in
the feed or vault window could not be inspected without growing the DOM. When many frames arrived,
re-rendering large row sets caused UI jitter. Large single-frame payloads in `HexDump` created one
DOM `<span>` per byte, which degraded rendering performance on 64 kB frames.

## Scope

Virtualized viewport rendering for the stream table in `ui/src/App.tsx`, retained frame buffer
expansion in `ui/src/lib/feed.ts`, and bounded windowing in `HexDump`. It does not cover ANSI escape
color parsing or virtual horizontal columns.

## Behavior

1. The stream table viewport renders rows inside a scrollable container with a fixed row height of
   26 px.
2. The viewport computes `startIndex` and `endIndex` with an 8-row overscan margin based on
   `scrollTop` and container client height.
3. Only the visible window of rows exists in the DOM (approximately 30 to 55 `<tr>` nodes) regardless
   of whether the buffer contains 100 or 10,000 frames.
4. Top and bottom spacer rows keep the total table height and scrollbar thumb position accurate
   (`totalRows * 26 px`).
5. In live mode (`follow: true`), the viewport automatically scrolls to the bottom as new frames
   arrive.
6. When a user scrolls up, auto-scroll pauses (`follow: false`) and displays a "jump to live" button.
   Scrolling back to the bottom or clicking the button re-engages live tracking.
7. The stream header displays a live count indicator with visible row bounds and total buffer count:
   `rows X–Y of N (total rx)`.
8. The client-side frame retention window in `ui/src/lib/feed.ts` expands from 500 to 10,000 frames.
9. `HexDump` bounds single-frame hex display to 512 bytes per page with navigation buttons (`prev`
   and `next`). When a user inspects a field at an offset beyond 512 bytes, the viewport
   automatically jumps to the page containing that field.

## Measured

Frontend build verified with Vite and TypeScript compiler:

```text
> ui@0.8.0 build
> tsc -b && vite build

vite v8.3.5 building client environment for production...
transforming...
✓ 13 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  0.45 kB │ gzip:  0.28 kB
dist/assets/index-CEpHRbw4.css  11.90 kB │ gzip:  2.98 kB
dist/assets/index-DfdFy5es.js   50.34 kB │ gzip: 17.99 kB
✓ built in 1.75s
```

DOM node benchmark in stream table:
- 120-frame slice previously: 120 `<tr>` nodes (~960 `<td>` elements) rendered continuously.
- Virtualized viewport now: 34 `<tr>` nodes (~272 `<td>` elements) rendered for a 10,000-frame
  buffer, remaining constant under continuous scrolling.

## Test

Run TypeScript type check and frontend bundle build:

```sh
npm run build --prefix ui
```

## Limits, recorded

- Fixed row height is 26 px; multiline cell content is truncated with an ellipsis.
- Large vault window review loads up to 400 frames per seek chunk via `/api/vault/frames`.
