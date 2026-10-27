# Handbook page: implementation sequence

One A4 page in the style of an Apollo Operations Handbook "Systems Data" sheet.
It presents the implementation plan as a 1969 program document.

## Files

| File | Use |
| --- | --- |
| `baudforge-plan.pdf` | Print file, A4, one page, pure black and white |
| `baudforge-plan.png` | Screen preview at 2x |
| `baudforge-plan.html` | Source, millimetre coordinates, no build step |
| `fonts/` | Routed Gothic and Letter Gothic, licences included |

## What the page explains

The plan is sixteen stages, eight decision gates and four release cuts. Each
stage ends with a program that runs on a real board. Three work tracks run in
parallel after the measurement stage. Figure 2.1-1 is the schedule, figure
2.1-2 is the effort estimate against the SRS slot, and table 2.1-1 is the gate
list.

## Numbers checked against

All figures come from [`../../IMPLEMENTATION.md`](../../IMPLEMENTATION.md):

- sixteen stages, eight gates, four cuts, and the S13 merge point
- 88 days for phase 1A, 37 for cut 1B, 155 for phase 2, 74 for cut 2B
- 20 days per milestone in the SRS
- gate answers G0 to G7, and the next ten days of work

Phase 3 (34 days) and phase 4 (43 days) are derived from the unit sizes with
S 1, M 2.5 and L 4.5 days per unit. The chart legend says so.

## Regenerate

Any Chromium browser works. On Windows without Chrome, Edge does the job:

```sh
CH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
BASE="docs/handbook/baudforge-plan"
"$CH" --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=4500 --window-size=794,1123 --no-pdf-header-footer \
  --print-to-pdf="$BASE.pdf" "file:///$(pwd)/$BASE.html"
"$CH" --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=4500 --window-size=794,1123 --hide-scrollbars \
  --force-device-scale-factor=2 --screenshot="$BASE.png" "file:///$(pwd)/$BASE.html"
```

Check the result:

```sh
uv run --no-project --with pymupdf python <nasa-handbook>/scripts/check.py \
  "$(pwd)/$BASE.pdf"
```

The checker must report one page and two colours. Measure the gap above the
footer with:

```sh
"$CH" --headless=new --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=5000 --dump-dom "file:///$(pwd)/$BASE.html" \
  | grep -o 'data-fit="[^"]*"'
```

The page currently reports 8.5 mm free. Keep it between 4 and 10 mm. To make
room, cut words or a table row, not the type size.
