# PLAN

Setup record and status of the BaudForge project. The design source is
[`specs/ADR & SRS.md`](specs/ADR%20%26%20SRS.md). This file tracks progress; the
specification does not change.

## What the setup did

1. Turned the single crate into a Cargo workspace with the nine crates from
   SRS section 2.1.
2. Kept the root crate `baud-forge` and all code in `src/legacy/` unchanged, so
   the telemetry core from porti-rs still builds.
3. Added the shared types from the specification: `RawChunk`, `DissectedFrame`,
   `TransportDriver`, `FaultProfile`, `ProjectConfig`.
4. Added the `.bforge.toml` schema and one sample workspace file.
5. Added the `bforge` CLI with the `help` and `version` commands.

## What is not implemented

Every crate compiles and holds types only. No crate runs an algorithm yet.

| Crate | Missing work | Milestone |
| --- | --- | --- |
| `bforge-hal` | UART, RTT, CAN and TCP drivers; USB hotplug watch; port yield IPC | 1 |
| `bforge-storage` | Memory-mapped writer, 64 MB segmentation, LZ4 compression, index writer, exporters | 1 |
| `bforge-framer` | Delimiter, COBS, SLIP, Intel HEX, sync-word and idle-gap framers; checksum engines | 1 |
| `bforge-core` | Config validation, port registry, pipeline coordinator, gRPC control plane | 1 |
| `bforge-cli` | `record`, `replay`, `assert`, `yield` | 1 |
| `bforge-gui` | Tauri v2 host, window, binary IPC channel | 2 |
| `ui/` | SolidJS frontend, terminal viewport, plots, packet tree | 2 |
| `bforge-dissect` | C struct parser, Protobuf, Kaitai, native packs, IR executor | 3 |
| `bforge-elf` | ELF load, DWARF lookup, file watch, defmt and pw_tokenizer decode | 3 |
| `bforge-script` | Fault engine, MITM bridge, Lua VM, pin triggers, session diff | 4 |
| `legacy` | None. Frozen. | — |

## Decisions still open

- Checksum library: write the CRC engines by hand, or use a crate.
- Fan-out primitive: `rtrb` or `crossbeam-channel`. The ADR names both.
- Async model of `TransportDriver`. The trait is synchronous today, which keeps
  it object safe. A real async driver may force a change to the trait.
- Lua binding: `mlua` with Lua 5.4 or Luau. The ADR names both.
- `ConfigError` shape for semantic validation. Duplicate port IDs, baud limits
  and unknown references are unchecked today.
- License files. `LICENSE-MIT` and `LICENSE-APACHE` are not in the tree yet.

## Verified

- `cargo build --workspace` succeeds, no warnings.
- `cargo test --workspace` passes, one test: the sample `.bforge.toml` parses
  into `ProjectConfig`.
- `bforge version` prints `bforge 0.1.0`.

Toolchain used for the check: `stable-x86_64-pc-windows-gnu` on Windows, because
this machine has no MSVC linker. The project itself does not depend on that
toolchain.

## Next step

Write the implementation plan for Milestone 1. Start with `bforge-hal` and
`bforge-storage`, because the ring buffer, the port match and the `.bflog`
writer are the base of every later feature.
