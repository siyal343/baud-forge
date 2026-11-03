# BaudForge Project Structure & Architecture

Date: 2026-11-03  
Status: Active Headless Core Engine  
Repository: `https://github.com/siyal343/baud-forge`

---

## 1. Directory Tree Overview

```text
baud-forge/
├── .github/                      # CI/CD workflows (build, test, release, nightly)
├── archive/                      # Local archive (git-ignored, excluded from repository commits)
│   └── gui/                      # Preserved GUI codebases, tests & documentation
├── crates/                       # Active headless Rust workspace
│   ├── bforge-hal/               # Physical & virtual transport drivers
│   ├── bforge-framer/            # Delimiter, COBS, SLIP, length-prefix framing
│   ├── bforge-dissect/           # C-struct, Protobuf, CCSDS, MAVLink parsers
│   ├── bforge-elf/               # DWARF & ELF symbol table extractors
│   ├── bforge-script/            # Sandboxed Rhai scripting & XYModem engine
│   ├── bforge-storage/           # Append-only .bflog vault & format exporters
│   ├── bforge-core/              # Pipeline coordinator & streaming hub
│   └── bforge-cli/               # Production command-line interface
├── dashboards/                   # Declarative XML dashboard templates
├── deploy/                       # Linux VPS & lab deployment automation
├── docs/                         # Core project documentation
│   ├── handbook/                 # Apollo-style engineering manual
│   ├── PROJECT-STRUCTURE.md      # This document
│   ├── QUICKSTART.md             # CLI quickstart guide
│   ├── RUN-REPORT.md             # Build verification report
│   ├── SIGNING.md                # Binary signing specification
│   └── VPS-LAB.md                # VPS test soak procedures
├── examples/                     # TOML configs, mock devices, C headers
├── firmware/                     # Microcontroller test firmware (ESP32-C3)
├── handoff/                      # Engineering transition documents
├── schemas/                      # JSON schemas for configs and vaults
├── specs/                        # Architectural RFC specifications (0001-0007)
├── vaults/                       # Recorded .bflog session archives
├── Cargo.lock
├── Cargo.toml                    # Root workspace manifest (8 active crates)
└── README.md                     # Project introduction
```

---

## 2. Active Crate Architecture & Responsibilities

The active codebase consists of eight headless crates organized into layers:

### Layer 1: Hardware Abstraction & Formats (Lowest Level)
* **[`crates/bforge-hal`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-hal):**
  * Provides non-blocking abstractions for UART, RTT (SEGGER J-Link), CAN bus, TCP client/server, and UDP sockets.
  * Controls modem lines (`DTR`, `RTS`) to prevent or trigger microcontroller bootloader resets.
  * Implements a deterministic software-in-the-loop (SIL) mock stream generator.
* **[`crates/bforge-framer`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-framer):**
  * Slices raw byte streams into discrete frame buffers.
  * Supports Line-delimited (`\n`, `\r\n`), COBS (Consistent Overhead Byte Stuffing), SLIP, and 16-bit length-prefixed framing.
  * Calculates CRC checksums (CRC-8, CRC-16-CCITT, CRC-32-IEEE).
* **[`crates/bforge-storage`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-storage):**
  * Manages the `.bflog` binary capture format.
  * Features append-only zero-copy disk writes with adjacent `.bfidx` index files for instant time-seeking.
  * Exports session recordings to CSV, JSON Lines, PCAP-NG, and Saleae Logic formats.

### Layer 2: Analysis & Embedded Intelligence
* **[`crates/bforge-dissect`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-dissect):**
  * Dissects binary byte payloads into structured fields.
  * Parses raw C header files (`.h`) at runtime to extract struct layouts with accurate alignment and padding.
  * Decodes Protobuf wire formats, CCSDS space packets, CSP (CubeSat Protocol), MAVLink, and Modbus RTU.
* **[`crates/bforge-elf`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-elf):**
  * Analyzes ELF firmware binaries and DWARF debug info.
  * Extracts RAM variable addresses, struct definitions, and memory layouts for live microcontroller inspection.
* **[`crates/bforge-script`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-script):**
  * Runs Rhai scripts in an isolated sandbox with memory and instruction caps.
  * Enables runtime frame mutation, custom CRC generation, and automated XYModem firmware flashing.

### Layer 3: System Orchestration
* **[`crates/bforge-core`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-core):**
  * The central coordinator. Connects transport (`bforge-hal`), framing (`bforge-framer`), and dissection (`bforge-dissect`).
  * Houses the hardware-in-the-loop (HIL) fault injection engine (bit flips, packet dropping, jitter injection, truncation).
  * Manages ring buffers (`rtrb`) for low-latency streaming between hardware threads and consumers.
  * Provides session diffing between golden baseline logs and anomalous test runs.
  * Exposes an HTTP and WebSocket streaming endpoint for external UI consumers.

### Layer 4: User Entry Point
* **[`crates/bforge-cli`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-cli):**
  * The production CLI binary (`bforge`).
  * Commands:
    * `bforge record`: Capture live data to a `.bflog` vault.
    * `bforge replay`: Transmit recorded vaults back to physical or virtual hardware.
    * `bforge dissect`: Decode stream packets live against schemas or C headers.
    * `bforge assert`: Validate packet sequences against strict regression rules.
    * `bforge ports`: Scan and auto-detect USB serial targets.
    * `bforge diff`: Compare two vault recordings to isolate regressions.

---

## 3. UI Designer Integration Boundary

Because the entire functional engine is headless:
1. **Figma / UX Designers:** Can design interfaces without interacting with serial ports or Rust code. You provide the required inputs (ports, bauds, framing) and visualization targets (oscilloscopes, struct tables).
2. **Frontend Developers (Web / React / Vue):** Can connect to `bforge-core` via its local HTTP/WebSocket server or Tauri bridge.
3. **Rust GUI Developers (egui / Slint):** Can call `bforge-core` and `bforge-hal` directly as pure library crates.
4. **Historical Reference:** The complete previous desktop application and web UI remain archived in [`archive/gui/`](file:///f:/Datapack/Personal/Programa/baud-forge/archive/gui) as reference implementations.
