# baud-forge

Open-source serial monitor written in Rust.

This repository is a fork of [porti-rs](https://github.com/siyal343/porti-rs).
It keeps the telemetry core as legacy code. Every other porti-rs module is
removed.

## Layout

- `src/legacy/core/`: inherited telemetry types. Frame, group, dataset, alarm
  band, ring buffer and running statistics.
- `src/`: new baud-forge code.
- `specs/`: design specifications. Read `specs/README.md` first.

## Build

```
cargo build
cargo run
cargo test
```
