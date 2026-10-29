# 0024 Symbol badges for addresses in frames

Status: accepted (29 October 2026). Turns the symbolizer into something on screen.

## Problem

A crash usually reaches the host as a number inside a frame: `PC: 0x140001480`. The
project already loaded firmware images and resolved addresses (`bforge-elf`), but
only from a CLI example someone had to run by hand. In the workbench a panic looked
like any other integer.

## Scope

Resolve plausible code addresses in decoded frames when the workspace names an image,
and draw a badge. Not in this stage: demangling Rust names (D-44), reading a file to
show source text (D-70), and crash detection from text frames rather than numeric
fields (D-71).

## Behavior

1. A workspace may name an image: `elf_path = "…/firmware.elf"`. `bforge serve`
   loads it and warns, but does not stop, if the image is missing or unreadable.
2. Every decoded frame is scanned for numbers that could be addresses: finite,
   integral, at least `0x1000`, and inside the image's code span when resolved.
3. At most four addresses per frame are reported, in field order, so a frame full of
   numbers cannot turn into a lookup storm. Each hit carries the field name, the
   address, the function, the file and the line.
4. The badge travels in the frame row, so it works for the live stream and for a
   scrubbed window with no extra route.
5. The workbench shows a `crash` column with `field file:line`, and the inspector
   lists each hit with its address and source. The function name, which may be
   mangled, is in the tooltip.

## Data

`TailRow.symbols: Vec<SymbolHit { field, address, function, file, line }>`. The
resolver is passed in as a function, so the logic is testable without an image.

## Measured

A socket simulator emits `PanicPacket` frames (magic `0xC0DEFEED`, a 64-bit `pc` and
`lr`) carrying real addresses from its own image, with `elf_path` pointing at that
image:

```text
image 8s_device_sim.exe: 2586 function symbols, code span 0x140001000..0x1400adda0
row pc 0x140001480 -> std/src/env.rs:228
row lr 0x1400014c0 -> std/src/env.rs
```

Both arrived as `symbols` in an `event: frames` message, and the workbench drew the
badge and the inspector block. Captured at `docs/screenshots/workbench.png`.

An earlier attempt used a 32-bit field and produced no badge: an image at
`0x140000000` does not fit in four bytes, so the truncated value fell outside the
code span. That is why the demo frame carries 64-bit addresses, and why a truncated
address is reported as nothing rather than as a plausible wrong function.

## Test

```sh
cargo test -p bforge-core --lib symbolize
cargo run -p bforge-elf --example s12_elf -- <image> <name>
```

Four unit tests pin the rule: an in-image address becomes a badge, small numbers and
fractions are not addresses, an address outside the image is skipped so the next one
is tried, and one frame yields at most four badges.

## Limits, recorded

- Rust names arrive mangled (D-44); the badge leads with the source location, which
  is readable regardless.
- The badge resolves numbers, not text: a frame carrying `PC: 0x140001480` as
  characters is not parsed (D-71).
- No source text is fetched; the popover shows the location, not the code (D-70).
