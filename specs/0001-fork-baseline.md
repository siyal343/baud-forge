# 0001 Fork baseline

Status: accepted (2026-10-27)

## Problem

The baud-forge repository starts from porti-rs. A new session must know what
came from porti-rs and what must stay unchanged.

## Scope

This spec covers the repository content at the first baud-forge commit.
It does not cover the serial monitor features.

## Behavior

- `main` has one commit. The tree derives from porti-rs commit `67a5f10`.
- The porti-rs history is not part of this repository.
- The working tree contains the telemetry core only. Every other porti-rs
  module, document and asset is removed.
- The core is legacy code. New work belongs at the crate root. Change the
  core only when a later spec gives the reason.
- `specs/` holds the design specifications.

## Data

Legacy types in `baud_forge::legacy::core`:

- `Frame`, `Group`, `Dataset`, `AlarmBand`, `AlarmSeverity` and `WidgetType`
  from `src/legacy/core/frame.rs`.
- `RingBuffer` from `src/legacy/core/ring_buffer.rs`.
- `RunningStats` from `src/legacy/core/stats.rs`.

The core depends on `serde` only.

## Test

1. Run `cargo build` and `cargo test`.
2. Run `cargo run`. The output is `baud-forge 0.1.0`.

Measured: the default MSVC toolchain cannot link on the build machine because
no Visual Studio linker is installed. Use
`cargo +stable-x86_64-pc-windows-gnu build` there.
