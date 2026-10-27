# Architecture Decision Record (ADR) & Software Requirements Specification (SRS)

* **Project Name:** **BAUDFORGE** *(Tagline: "Forge, Frame, Fault-Inject.")*
* **Binary / CLI Name:** `bforge`
* **License:** Dual MIT / Apache-2.0
* **Document Version:** 1.0.0-DRAFT
* **Target Platforms:** Linux (x86_64, aarch64), macOS (Apple Silicon, Intel), Windows (x86_64, ARM64)

---

## PART I: ARCHITECTURE DECISION RECORDS (ADR)

### ADR-001: Core Application Framework & Language Stack

* **Context:** Traditional serial monitors built on Electron + Node.js suffer from high memory overhead, garbage collection pauses during multi-megabaud bursts, and unstable native USB-serial bindings (`node-serialport`). Pure C++/Qt6 builds offer high performance but complicate modern web-grade plugin ecosystems and cross-platform CI packaging.
* **Decision:** Build the core engine in **Rust (2024 Edition)** and the desktop GUI using **Tauri v2** paired with a **SolidJS + WebGPU/Canvas2D** frontend. The core engine (`bforge-core`) will compile as a standalone static library so that the exact same binary powers both the **GUI** and the **Headless CLI** (`bforge-cli`).
* **Consequences:**
* *Positive:* Memory safety without garbage collection; deterministic sub-millisecond latency in the I/O thread; tiny installer footprint (< 15 MB); single codebase for headless Raspberry Pi HIL runners and desktop workstations.
* *Negative:* High-frequency telemetry data must cross the Rust-to-WebView IPC boundary efficiently without JSON serialization bottlenecks (solved in ADR-002).



### ADR-002: Zero-Copy I/O Pipeline & Storage Engine

* **Context:** Rendering incoming bytes directly onto the UI thread causes catastrophic frame drops and dropped UART bytes when an MCU enters an infinite `printf` loop at 4+ Mbaud.Furthermore, filtering data in the UI must never destroy raw historical evidence during hardware validation.
* **Decision:** Implement a **3-Stage Decoupled Ring-Buffer Architecture**:
1. **OS Kernel to Reader Thread:** Dedicated OS real-time priority thread polls hardware ports into pre-allocated 64 KB `BytesMut` slabs.
2. **Lock-Free Fan-Out:** A Wait-Free Single-Producer Multi-Consumer (SPMC) ring buffer (`rtrb` / `crossbeam-channel`) immediately clones slab pointers to two independent consumers: the **Disk Logger** and the **Frame Dissector**.
3. **Memory-Mapped Append-Only Session Vault:** Every session writes raw, hardware-timestamped chunks directly to a memory-mapped `.bflog` binary file (segmented 64 MB pages with `lz4` cold compression) accompanied by a B-Tree timestamp/offset index. The UI never holds the full log in RAM; it queries a **virtualized sliding window** (e.g., the 200 visible rows) over Tauri binary IPC (`ArrayBuffer`).


* **Consequences:**
* *Positive:* 12 Mbaud sustained ingestion with zero dropped bytes; instant scrolling through 50 GB multi-day soak logs with constant < 150 MB RAM usage.



### ADR-003: Declarative Protocol Dissection & ELF Symbolization

* **Context:** Hardcoding protocol parsers requires recompiling the application for every custom project struct. Using external tools like Wireshark for UART requires awkward `extcap` named-pipe bridges.
* **Decision:** Build an internal **Declarative Dissector Engine** that compiles **C Header Packed Structs** (`tree-sitter-c` parser), **Protobuf (`.proto` via `prost-reflect`)**, **Kaitai Structs**, and **Native Aerospace/Industrial Profiles (CCSDS, CSP, MAVLink, Modbus)** into an intermediate bytecode representation (`DissectorIR`) executed at runtime. Pair this with an in-memory **DWARF/ELF Symbolizer (`gimli` + `object` crates)** that watches the firmware `.elf` file for recompilation changes and automatically decodes `defmt`, Pigweed `pw_tokenizer`, and raw hex crash backtraces inline.
* **Consequences:**
* *Positive:* Zero-rebuild protocol adaptation; automatic reload when the user runs `cargo build` or `make` on their firmware project.



### ADR-004: Embedded Scripting & Fault-Injection Runtime

* **Context:** Hardware-in-the-loop (HIL) validation and Man-in-the-Middle (MITM) fault injection require programmable state machines, bit-flipping, and timing manipulation. Python has GIL bottlenecks; JavaScript lacks deterministic microsecond sleep accuracy.
* **Decision:** Embed **LuaJIT (`mlua` with Luau/Lua 5.4 sandboxed VM)** directly inside the Rust core pipeline for microsecond-level inline packet interception and fault injection, while exposing a secondary **gRPC / Unix Domain Socket control plane** for external Python (`pytest`) test suites.
* **Consequences:**
* *Positive:* Inline MITM packet mutation executes in < 15 microseconds inside the Rust thread; test engineers can still write high-level CI test assertions in standard `pytest`.



---

## PART II: SYSTEM ARCHITECTURE & WORKSPACE TOPOLOGY

### 2.1 Rust Cargo Workspace Structure

```text
baudforge/
├── Cargo.toml                      # Workspace root
├── crates/
│   ├── bforge-hal/                 # Transport abstraction (UART, RTT, CAN, TCP, MITM Bridge)
│   ├── bforge-storage/             # Memory-mapped .bflog engine, PCAPNG/CSV/Parquet exporters
│   ├── bforge-framer/              # COBS, SLIP, Idle-line, Sync-word, & CRC-8/16/32 engines
│   ├── bforge-dissect/             # C-struct, Protobuf, CCSDS, CSP, MAVLink, Modbus parsers
│   ├── bforge-elf/                 # DWARF addr2line symbolizer, defmt & pw_tokenizer decoder
│   ├── bforge-script/              # Embedded LuaJIT VM, Fault-Injector, & X/Y/ZMODEM state machines
│   ├── bforge-core/                # Central coordinator, workspace config (.bforge.toml), gRPC server
│   ├── bforge-cli/                 # Headless CLI binary for CI/CD & HIL test runners
│   └── bforge-gui/                 # Tauri v2 desktop host
└── ui/                             # SolidJS + TypeScript + WebGPU/Canvas2D Frontend
    ├── src/components/Terminal/    # Virtualized Dual Hex/ASCII/ANSI Canvas viewport
    ├── src/components/Telemetry/   # 60 FPS WebGL Time-Series, FFT, & 3D Orientation widgets
    ├── src/components/Dissector/   # Packet tree inspector & MITM breakpoint editor
    └── src/components/Command/     # Parameterized command builder & DTR/RTS pulse sequencer

```

### 2.2 Internal Core Data Structures (Rust Specification)

```rust
/// Fundamental atomic unit flowing through the BaudForge SPMC pipeline
#[repr(C)]
#[derive(Clone, Debug)]
pub struct RawChunk {
    pub seq_id: u64,                 // Monotonically increasing chunk counter
    pub timestamp_ns: u64,           // Monotonic hardware/OS nanosecond timestamp
    pub port_id: u16,                // Source transport ID (supports up to 64 concurrent ports)
    pub direction: Direction,        // RX, TX, MITM_A_TO_B, MITM_B_TO_A, INJECTED_FAULT
    pub line_state: PinStateFlags,   // Bitmask of CTS, DSR, DCD, RI, BREAK, FRAMING_ERR, PARITY_ERR
    pub payload_offset: u64,         // Byte offset in the memory-mapped .bflog slab
    pub payload_len: u32,            // Length of raw bytes in this chunk
}

/// Output of the Framing & Dissection Stage
#[derive(Clone, Debug, serde::Serialize)]
pub struct DissectedFrame {
    pub frame_id: u64,
    pub start_timestamp_ns: u64,
    pub end_timestamp_ns: u64,
    pub delta_ns: u64,               // Time elapsed since previous frame on same port
    pub raw_bytes: Vec<u8>,
    pub crc_status: CrcValidation,   // Valid, Invalid { expected: u32, actual: u32 }, NotApplicable
    pub protocol_tag: String,        // e.g., "CCSDS_TM", "MODBUS_RTU", "C_STRUCT:ImuPacket"
    pub fields: Vec<DecodedField>,   // Hierarchical tree of unpacked values
    pub elf_annotations: Vec<SourceLocation>, // Resolved file:line from hex pointers
}

```

---

## PART III: SOFTWARE REQUIREMENTS SPECIFICATION (SRS)

### 3.1 Functional Requirements: Transport & Hardware Abstraction (`bforge-hal`)

* **FR-HAL-01 (Multi-Transport Unification):** Every transport backend must implement the asynchronous `TransportDriver` trait (`open`, `close`, `read_slab`, `write_frame`, `set_pins`, `read_pins`), allowing all higher-level dissectors, loggers, and plots to operate identically across:
* Physical UART / USB-CDC (`110 bps` to `12,000,000 bps`, custom arbitrary integer baud divisors, `5/6/7/8` data bits, `None/Odd/Even/Mark/Space` parity, `1/1.5/2` stop bits).
* Segger J-Link RTT & CMSIS-DAP SWO (via native `probe-rs` integration).
* SocketCAN / SLCAN / CAN-FD adapters.
* TCP Client/Server, UDP Unicast/Multicast, and WebSockets.


* **FR-HAL-02 (Persistent Hardware Topology Binding):** Ports shall be bound in workspace configurations by matching tuple hierarchy: `(USB_VID, USB_PID, USB_SERIAL_NUMBER, USB_INTERFACE_INDEX, USB_PORT_PATH)` with fallback to OS device path (`/dev/ttyACM0` or `COM4`).
* **FR-HAL-03 (Sub-10ms Hotplug & Flash-Aware Yielding):**
* Upon USB disconnect, the HAL shall transition the port state to `Reconnecting` and poll OS udev/IOKit/SetupAPI events to re-open the port within `10 ms` of re-enumeration.
* The application shall expose a local IPC socket (`bforge yield --port <id> --duration 30s`), an HTTP endpoint, and a global hotkey (`Ctrl+Shift+Y`) that immediately releases the OS file handle so external flash tools (`esptool`, `stm32cubeprogrammer`, `openocd`) can flash the target, automatically reclaiming the port once flashing finishes.


* **FR-HAL-04 (Pin Sequencer & Break Generator):** Users shall be able to manually toggle `DTR` and `RTS`, monitor `CTS`, `DSR`, `DCD`, and `RI` at `1 kHz` polling intervals, and execute JSON-defined pin-pulse state machines (e.g., `SET DTR=0, RTS=1 -> WAIT 50ms -> SET DTR=1, RTS=0` for automated ESP32/STM32 bootloader entry) and precision timed UART `BREAK` assertions (`1 ms` to `5000 ms`).

### 3.2 Functional Requirements: Zero-Drop Storage & Session Replay (`bforge-storage`)

* **FR-STO-01 (Binary `.bflog` Container Format):** All raw bytes must be written to disk prior to framing or UI filtering using the following binary layout:
* **File Header (256 Bytes):** Magic bytes (`BFLG\x01\x00`), session UUID, start Unix epoch (ns), workspace configuration hash, and port descriptor table offset.
* **Data Blocks (64 MB segments):** Sequential `RawChunk` headers followed by raw byte payloads. Completed segments are compressed in a background thread via `LZ4` or `Zstandard`.
* **Sparse Index Block:** Stores `(timestamp_ns, frame_id) -> file_byte_offset` every 1,024 frames for $O(\log N)$ instant seek and time-scrubbing.


* **FR-STO-02 (Deterministic Replay & Export):**
* Users can open any `.bflog` file offline, apply *new* C-struct dissectors or regex filters retroactively, and transmit recorded packets back out over a physical hardware port preserving exact original inter-packet $\Delta t$ timings.
* Built-in exporters for **Wireshark `.pcapng**`, **CSV**, **Apache Parquet**, **JSON Lines (`.jsonl`)**, and **Saleae Logic 2 CSV**.



### 3.3 Functional Requirements: Framing, Dissection & Symbolization (`bforge-framer` & `bforge-dissect`)

* **FR-FRM-01 (Configurable Framing Pipeline):** Each port supports chaining framing algorithms:
1. **Delimiter:** Single or multi-byte sequences (`\n`, `\r\n`, custom hex).
2. **Packet Encodings:** Consistent Overhead Byte Stuffing (**COBS**), **SLIP** (RFC 1055), and **Intel HEX**.
3. **Header + Length:** Sync word (`1–8 bytes`), configurable length field offset (`u8`, `u16_le`, `u16_be`, `u32_le`), header length adjustment, and trailing checksum validation.
4. **Idle-Time Gap:** Frame boundary triggered when bus silence exceeds $N$ bit-periods or microseconds (e.g., $3.5$ character times for Modbus RTU).


* **FR-DIS-01 (C-Struct & Schema Dissector):** Users can point a workspace to a standard `.h` C header file. BaudForge parses `struct __attribute__((packed))` definitions, supports bitfields (`uint8_t mode : 3;`), enums, arrays, and endianness annotations (`__le16`, `__be32`), and unpacks incoming binary frames into live key-value trees.
* **FR-DIS-02 (Aerospace & Robotics Native Packs):** Built-in protocol parsers for:
* **CCSDS Space Packet Protocol (133.0-B-2)** & **ECSS PUS (Packet Utilization Standard)**: Decodes APID, Sequence Flags, Secondary Headers, Service/Subservice types.
* **CubeSat Space Protocol (CSP v1/v2)**: Unpacks Priority, Source, Destination, Destination Port, Source Port, HMAC, and CRC32C.
* **MAVLink v1/v2**: Dynamically loads dialect `.xml` files (`common.xml`, `ardupilotmega.xml`).


* **FR-SYM-01 (Live ELF Symbolization & Token Decoding):**
* Watches a configured firmware `.elf` file via OS filesystem notifications (`notify` crate).
* Automatically scans incoming ASCII text for 32-bit/64-bit code pointers (e.g., `0x0800412a` or `PC: 0x400d1234`) and appends clickable `[src/flight_ctrl.c:184 (pid_update)]` badges that launch VS Code (`code --goto <file>:<line>`) or CLion on click.
* Decodes **Rust `defmt**` and **Pigweed `pw_tokenizer**` binary frames directly using the `.elf` symbol table.



### 3.4 Functional Requirements: MITM Bridge, Fault Injection & HIL Scripting (`bforge-script`)

* **FR-MITM-01 (Dual-Port Active Proxy & Passive Sniffer):**
* **Passive Tap Mode:** Combines two RX-only UART ports (`Tap_A`, `Tap_B`) into a single chronological sequence diagram and interleaved terminal view with sub-microsecond directional tagging.
* **Active Inline Bridge Mode:** Routes bytes bidirectionally between `Port_A` (e.g., OBC) and `Port_B` (e.g., EPS/Radio) through the LuaJIT Fault-Injection Engine.


* **FR-FLT-01 (Built-In Fault-Injection Primitives):** Without writing code, users can enable fault profiles on any TX or MITM channel:
* **Bit-Error Rate (BER) Generator:** Injects random single-bit flips or burst errors at configurable probabilities ($10^{-3}$ to $10^{-9}$) to simulate radiation Single-Event Upsets (SEUs) or noisy RF links.
* **Protocol Fuzzing:** Drops every $N$-th byte, truncates frames mid-transmission, corrupts valid CRC bytes to verify receiver error-handling, or injects synthetic jitter/latency (`0 ms` to `5000 ms`).


* **FR-SCR-01 (LuaJIT HIL API):** Scripts have access to the sandboxed `bforge` global table:
```lua
-- Example MITM Fault-Injection Script in BaudForge
bforge.on_mitm_frame("OBC_TO_EPS", function(frame)
    local pkt = frame:dissect("C_STRUCT:EpsCommand")
    if pkt.fields.cmd_id == 0x04 then -- Battery Heater ON command
        bforge.log_warn("Intercepted Heater Command! Injecting SEU bit-flip in setpoint.")
        pkt.fields.target_temp_c = pkt.fields.target_temp_c ~ 0x0010 -- Flip bit 4
        frame:repack_and_recalc_crc(pkt) -- Or intentionally skip CRC recalc to test fault rejection
        bforge.trigger_pin("FTDI_CBUS0", "PULSE_HIGH_100US") -- Trigger oscilloscope!
    end
    return frame:forward_after_ms(12) -- Inject 12ms synthetic bus delay
end)

```



### 3.5 Functional Requirements: Real-Time Telemetry & UI Ergonomics (`ui`)

* **FR-UI-01 (Virtualized Multi-Representation Terminal):**
* Supports simultaneous split-pane or inline rendering of **ANSI Terminal**, **Hex Dump**, **Binary**, and **Dissected Packet Tree**.
* Selecting a field in the Dissected Packet Tree (e.g., `gyro_z = -0.042 rad/s`) highlights the exact 4 constituent bytes (`0x3D 0x2C 0x08 0xBD`) in the Hex pane and plots the field on the Telemetry canvas upon right-click.


* **FR-UI-02 (Synchronized DVR Time-Scrubber):**
* Dragging the crosshair across any time-series chart, FFT waterfall, or logic-state timeline immediately scrolls the terminal and packet panes to the exact frame captured at that microsecond timestamp.


* **FR-UI-03 (Semantic Log Diffing Engine):**
* Compares two recorded `.bflog` sessions side-by-side. Strips timestamps and masked dynamic fields (like sequence counters or memory addresses) and generates a timing regression report flagging any state transition whose $\Delta t$ deviated by more than $X\%$ from the golden baseline.



---

## PART IV: WORKSPACE CONFIGURATION SPECIFICATION (`.bforge.toml`)

Every project can commit a single `.bforge.toml` file to version control so all hardware engineers share identical dissectors, commands, and dashboards:

```toml
[workspace]
name = "CubeSat-OBC-Validation"
version = "1.0"
elf_path = "./firmware/build/obc_flight_sw.elf"
watch_elf = true

[[ports]]
id = "obc_telemetry"
match_vid_pid = "0403:6010"         # FTDI FT2232H
match_serial = "FT5X9A1B"
baud_rate = 2000000                 # 2 Mbaud
framing = { mode = "cobs", delimiter = 0x00, crc = "crc32c" }
dissector = { type = "c_header", file = "./firmware/include/telemetry_packets.h", root_struct = "ObcTelemetryFrame" }
yield_on_sigusr1 = true

[[commands]]
name = "Inject Safe-Mode Transition"
hotkey = "Ctrl+Shift+S"
port = "obc_telemetry"
append_crc = "crc16_ccitt_false"
fields = [
  { name = "sync", type = "u16_be", default = 0xCAFE },
  { name = "opcode", type = "u8", default = 0x09 },
  { name = "reason_code", type = "enum", options = { MANUAL = 1, THERMAL_FAULT = 2, RAD_SEU = 3 } },
  { name = "hold_time_sec", type = "u32_le", default = 300 }
]

[[alerts]]
name = "Watchdog Starvation Detector"
condition = "dead_man_timer('obc_telemetry', 2500)" # Trigger if silent > 2.5s
actions = ["pulse_pin:RTS:100ms", "webhook:https://hooks.slack.com/services/..."]

```

---

## PART V: NON-FUNCTIONAL REQUIREMENTS & BENCHMARKS

| Metric | Target Requirement | Verification Method |
| --- | --- | --- |
| **Sustained Ingestion Rate** | $\ge 12\text{ Mbaud}$ ($1.2\text{ MB/s}$) continuous across 4 ports simultaneously with **0 dropped bytes**. | Hardware loopback stressor generating PRBS-31 pseudorandom streams verified via sequence counters. |
| **Memory Footprint** | $\le 150\text{ MB}$ RSS RAM even when viewing a $100\text{ GB}$ `.bflog` session file. | 72-hour soak test with Valgrind / `heaptrack` and memory-mapped sliding window assertions. |
| **MITM Inline Latency** | $\le 50\ \mu\text{s}$ pass-through overhead when bridging two UART ports via LuaJIT inspector. | Oscilloscope delta measurement between RX pin of Port A and TX pin of Port B. |
| **UI Frame Time** | $\le 16.6\text{ ms}$ ($60\text{ FPS}$) while rendering 20 live telemetry signals at $1\text{ kHz}$ sample rate. | WebGPU/Canvas frame-time profiler during peak burst ingestion. |
| **Cold Boot Time** | $\le 400\text{ ms}$ to interactive window on Linux, macOS, and Windows. | Automated CI startup timer. |

---

## PART VI: PHASED IMPLEMENTATION BLUEPRINT

1. **Milestone 1 — The Iron Core (`Weeks 1–4`):**
* Scaffold Cargo workspace (`bforge-hal`, `bforge-storage`, `bforge-framer`, `bforge-cli`).
* Implement SPMC lock-free ring buffer, `.bflog` memory-mapped writer, USB VID:PID hotplug matcher, and Flash-Aware Yielding IPC.
* Deliver headless `bforge` CLI capable of recording, replaying, and asserting serial outputs in CI.


2. **Milestone 2 — The GPU Terminal & Quick-Plotter (`Weeks 5–8`):**
* Integrate Tauri v2 + SolidJS UI.
* Build virtualized Canvas2D dual Hex/ANSI terminal and 60 FPS WebGL time-series plotter with synchronized DVR time-scrubbing.
* Add parameterized Command Builder with automatic CRC-8/16/32 calculation and smart flow-controlled paste.


3. **Milestone 3 — Dissectors & ELF Intelligence (`Weeks 9–12`):**
* Implement `tree-sitter-c` packed struct parser, Protobuf dissector, and native CCSDS/CSP/MAVLink/Modbus packs.
* Integrate `gimli` DWARF ELF symbolizer for live crash backtrace resolution and `defmt`/`pw_tokenizer` decoding.


4. **Milestone 4 — MITM, Fault Injection & Lab Sync (`Weeks 13–16`):**
* Implement Dual-Port Active MITM Bridge, BER bit-flipper, LuaJIT runtime, X/Y/ZMODEM file transfers, semantic session diffing, and hardware trigger outputs.
