# BaudForge Plugin & Extension System Architecture

**Document Status:** Design & Architecture Specification (`RFC-001`)  
**Date:** 2026-11-15  
**Target Codebase:** `bforge-core`, `bforge-hal`, `bforge-framer`, `bforge-dissect`, `bforge-script`, `bforge-storage`, `bforge-desktop`, `ui/`

---

## 1. Executive Summary & Core Principle: "Right Runtime for the Right Plane"

A serial, bus, and hardware-in-the-loop (HIL) workstation cannot treat all plugins alike. An extension that decodes a custom radar frame inside a **10 kHz – 100 kHz** telemetry stream operates under completely different latency, memory, and safety constraints than a driver bridging a proprietary J-Link RTT probe or a React dock panel visualizing attitude in 3D.

Forcing every plugin through HTTP/RPC would blow the inline framing budget; conversely, loading native `.dll`/`.so` C ABIs directly into `bforge-core` would turn a third-party bug into a process `SIGSEGV` that corrupts an active `.bflog` capture vault.

BaudForge therefore organizes extensibility around **three execution planes** backed by **five composable tiers**, packaged under one unified `.bfplugin` / `plugin.toml` manifest:

| Execution Plane | Throughput & Latency Target | BaudForge Components | Extension Tiers | Primary Constraint |
| :--- | :--- | :--- | :--- | :--- |
| **1. Hot Data Plane** | `10 kHz – 100 kHz+` frames; inline budget $\le 50\ \mu\text{s}$ (`specs/ADR & SRS.md:267`) | `Pipeline` (`64 KiB` slabs × `256` slots), `ByteMachine`, `Decoder`, `ScriptRuntime` | **Tier 1:** Declarative Schemas & CRC packs<br>**Tier 2:** Embedded Lua 5.4 (`mlua`)<br>**Tier 3:** WebAssembly Component Model (`wasmtime` + WIT) | Zero syscalls, bounded CPU fuel/ticks, bounded memory, never panic or stall `Consumer 0` (`logger`) |
| **2. Warm Driver & Storage Plane** | `10 Hz – 1 kHz` I/O & batch streaming | `TransportDriver` (`bforge-hal`), Vault Exporters (`bforge-storage`), Alert Webhooks | **Tier 3:** Wasm Streaming Exporters<br>**Tier 4:** Out-of-Process Sidecars (Length-prefixed binary + JSON-RPC 2.0) | Needs OS USB/CAN/VISA handles, filesystem/network access, and OS process crash isolation |
| **3. Workbench & UI Plane** | `60 fps` (`16.6 ms` frame budget) | Dockview panels (`WorkstationDock.tsx`), Plot Forge (`ui/src/plot/`), Command Forge, Hex/Dissector | **Tier 5:** UI Panels (Sandboxed `<iframe>` or Trusted ESM), Custom Plot DSP Operators, Custom Field Formatters, Payload Wizards | Must never freeze React or starve `requestAnimationFrame`; typed `MessageChannel` / `Float64Array` transfer |

> **Architectural Rule of Thumb:**  
> *Need zero-code protocol parsing?* $\rightarrow$ **Tier 1 (Declarative Schema)**.  
> *Need fast stateful script hooks/fault injection?* $\rightarrow$ **Tier 2 (Lua 5.4)**.  
> *Need native-speed proprietary decompression, decryption, custom framing, or binary export written in Rust/C/C++/Zig/Go?* $\rightarrow$ **Tier 3 (Wasmtime + WIT)**.  
> *Need vendor C SDKs, USB/CAN/SWD/JTAG/BLE hardware access, or Python libraries?* $\rightarrow$ **Tier 4 (Sidecar Process)**.  
> *Need custom dashboards, gauges, command wizards, or DSP math?* $\rightarrow$ **Tier 5 (Workbench UI SDK)**.

---

## 2. Audit of Existing Codebase Seams & Gaps

Inspection of the current workspace reveals strong trait boundaries already in place, alongside hardcoded enum/match tables and partial placeholders left from earlier milestones.

### 2.1 Embedded Scripting Runtime (`crates/bforge-script`)
* **Engine (`crates/bforge-script/Cargo.toml:12`):** Compiles **`mlua 0.10`** with `features = ["lua54", "vendored", "send"]` (note: although the crate description refers to LuaJIT, the active engine is vendored **Lua 5.4**).
* **Sandboxing & Budgets (`crates/bforge-script/src/runtime.rs:19-23, 76-79, 111-123`):**
  * Whitelists only `mlua::StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8` — no `io`, `os`, `package`, `debug`, or wall clock.
  * Enforces `INSTRUCTION_BUDGET = 200_000` via `HookTriggers::new().every_nth_instruction(10_000)` (`20` ticks max, reset before each `run()` at `runtime.rs:161`).
  * Fail-open execution (`runtime.rs:148-228`): errors, timeouts, or bad return types increment `failures`, capture `last_error`, and return `FrameVerdict::Send(bytes.to_vec())`.
* **Exposed API (`runtime.rs:236-281`, `frame.rs:15-166`):**
  * Global `bforge`: `on_frame(fn)`, `log(msg)`, `unhex(str)`, `hex(tbl)`.
  * `frame` userdata/table (when `DissectorIr` is attached): `frame.hex`, `frame:get(name)`, `frame:set(name, val)`, `frame:recalc_crc(name)` (`"crc8"`, `"crc16_ccitt_false"`, `"crc32c"`), `frame:bytes()`.
* **Measured Gaps:**
  1. **No Lua memory cap:** `Lua::new_with(..., LuaOptions::default())` does not call `lua.set_memory_limit(...)`; a hostile or buggy script allocating tables in a loop before hitting 200k VM instructions can balloon host RAM.
  2. **Single global hook:** Requires exactly `bforge.on_frame(fn)` (`runtime.rs:92-109`); `ScriptHook` (`crates/bforge-script/src/lib.rs:65-72`, defining `OnMitmFrame` and `OnAlert`) is unused.
  3. **Single schema across ports (`D-94` at `session.rs:484-486`):** `Session::schema()` grabs only the first `Some(DissectorIr)` from `self.encoders`, preventing multi-port heterogeneous schema access and dynamic `frame:dissect("TAG")` (`specs/0034-script-fields.md:23, 77`).
  4. **Unwired Alert Engine (`crates/bforge-core/src/lib.rs:177-184`):** `AlertConfig { name, condition, actions }` parses from `.bforge.toml` (e.g., `dead_man_timer`, `pulse_pin:RTS:100ms`, `webhook:...`), but no runtime evaluator or plugin action dispatcher executes them.

### 2.2 Hardware Abstraction Layer (`crates/bforge-hal`)
* **Trait Seam (`crates/bforge-hal/src/lib.rs:180-192`):**
  ```rust
  pub trait TransportDriver {
      fn open(&mut self) -> Result<(), TransportError>;
      fn close(&mut self);
      fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError>;
      fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError>;
      fn set_pins(&mut self, pins: PinStateFlags) -> Result<(), TransportError>;
      fn read_pins(&mut self) -> Result<PinStateFlags, TransportError>;
      fn state(&self) -> PortState;
  }
  ```
  This trait is already object-safe (`Box<dyn TransportDriver + Send>` in `SessionPort` and `Pipeline::start`) and uses a zero-allocation caller-owned `&mut [u8]` slab (`DEFAULT_SLAB_BYTES = 64 KiB`).
* **Measured Gap (`crates/bforge-core/src/session.rs:1344-1380`):** `session_ports_from_config` hardcodes a 4-way string match (`"serial" | "tcp-client" | "tcp-server" | "udp"`). Any unknown transport string fails with `SessionError::Settings`. Additionally, `POST /api/quick-connect` (`serve.rs:2964-3056`) cannot hot-add a transport into an active `Session` (`501 Not Implemented`).

### 2.3 Framing Pipeline (`crates/bforge-framer` & `crates/bforge-core/src/pipeline.rs`)
* **Trait Seam (`crates/bforge-framer/src/machine.rs:14-27`):**
  ```rust
  pub trait ByteMachine {
      fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>);
      fn tick(&mut self, _now_ns: u64, _frames: &mut Vec<Vec<u8>>) {}
      fn pending(&self) -> usize;
      fn reset(&mut self);
  }
  ```
  Constructed as `Box<dyn ByteMachine + Send>` in `tail::framing_machine(port)` (`crates/bforge-core/src/tail.rs:518-574`) with `DEFAULT_MAX_FRAME = 64 * 1024`.
* **Ring Interaction (`pipeline.rs:23, 289, 749-764` & `session.rs:1022-1112`):**
  * Reader thread writes `Arc<Slab>` into `rtrb::RingBuffer` (`256` chunks/consumer). Consumer 0 (`logger`) never drops; if the pump thread stalls here, the reader thread sleeps `IDLE_SLEEP` (200 µs) and accumulates `stalls_ns`, risking hardware UART FIFO overrun.
  * When `Session::pump_once` observes a transport `(reconnects, yields)` generation increment (`session.rs:1029-1038`), it automatically invokes `ByteMachine::reset()`.
* **Measured Gap:** `Framing` (`crates/bforge-framer/src/lib.rs:27-46`) is a closed 6-variant enum (`MODE_NAMES = ["delimiter", "cobs", "slip", "intel_hex", "header_length", "idle_gap"]`). Proprietary bit-stuffed, AT-escaped, BLE HCI, HDLC, or length-prefixed-with-CRC framers cannot be added without recompiling Rust.

### 2.4 Protocol Dissector Engine (`crates/bforge-dissect` & `crates/bforge-core/src/tail.rs`)
* **Current Dispatch (`crates/bforge-core/src/tail.rs:25-47`):**
  `Decoder` is a 2-arm enum: `Ir { ir: Box<DissectorIr>, tag: String }` or `Pack(Pack)`. `Pack` (`crates/bforge-dissect/src/packs/mod.rs:25-103`) is a closed 8-variant enum over 6 pack names (`ccsds_tm`, `ccsds_tc`, `csp`, `modbus_rtu`, `protobuf`, `mavlink`).
* **Output Model (`crates/bforge-dissect/src/lib.rs:104-132`, `tail.rs:85-115`):**
  Hierarchical `DecodedField { name, byte_offset, byte_len, value, value_num, children }` flattened to `Vec<FieldRow>` via dot-separated prefixes (`tail::flatten` at `tail.rs:692-713`). Because `HexInspector` (`ui/src/components/HexInspector.tsx`) and `PlotEngine` (`ui/src/plot/engine.ts`) already consume `offset`, `len`, `value`, and `value_num`, **any plugin dissector returning `DecodedField` automatically gains bidirectional Hex highlighting, Packet Stream correlation, Plot Forge graphing, and Oscilloscope triggering**.
* **Measured Gaps:**
  1. `SchemaSource::Kaitai { file, type_name }` is defined (`bforge-dissect/src/lib.rs:25`), but `decoder_from_config` / `decoder_from_text` (`tail.rs:577-690`) has no Kaitai `.ksy` compiler wired.
  2. There is no `Decoder::Custom` / `DissectorPlugin` variant for encrypted, zlib/LZ4-compressed, TLV, CBOR, CAN DBC, or stateful multi-frame protocols.
  3. `DissectorIr` CRC support (`frame.rs:110-145`) hardcodes only `"crc8"`, `"crc16_ccitt_false"`, and `"crc32c"`.

### 2.5 Vault Storage & Exporters (`crates/bforge-storage`)
* **Current Design (`crates/bforge-storage/src/lib.rs:130-137`, `export.rs:18-102`):**
  Single-pass streaming writer `export(reader: &mut LogReader, format: ExportFormat, out: &mut impl Write)` over an enum `{ PcapNg, Csv, Parquet, JsonLines, SaleaeCsv }` (`Parquet` currently returns an error).
* **Measured Gaps:** Exporters receive only raw `LogRecord` (`RawChunk` + raw bytes), not decoded `TailRow` / `DecodedField` columns, and cannot register external formats (e.g., Parquet/Arrow, MATLAB `.mat`, HDF5, ROS2 `.mcap`, MDF4 `.mf4`).

### 2.6 Workbench UI & Host IPC (`ui/src/` & `crates/bforge-core/src/serve.rs`)
* **Dockview Panel Registry (`ui/src/components/WorkstationDock.tsx:43-58, 792-806`, `GlobalRibbon.tsx:32-47`):**
  14 panels are hardcoded across three duplicated tables (`components` map, `titles` map, `PANEL_CATALOG`), plus `CANONICAL_DECK_ORDERS` and `PANEL_ORIGIN_HOMES`.
* **SSE / HTTP Bridge (`crates/bforge-core/src/serve.rs:1016-1292`, `ui/src/services/engineApi.ts:47-443`):**
  Loopback HTTP/1.1 + SSE (`snapshot` at `200 ms`, `frames` at `50 ms` coalesced via single-slot mutex with `sampled` drop notification, `ui` events at `20 ms`). Note that `serve.rs` already emits `event: series` (`Vec<SeriesUpdate>`), though `engineApi.ts` does not yet subscribe to it.
* **Measured Gaps:**
  1. No dynamic plugin panel registration (`id`, `title`, `dockZone`, iframe/ESM loader) in `WorkstationDock.tsx` or `GlobalRibbon.tsx`.
  2. `PlotForge` expression engine (`ui/src/plot/expr.ts`) has built-in unary/binary math functions (`PI`, `E`, `TAU`, `atan2`, `hypot`, `deg`, `rad`, `clamp`, trig), but no registry for user-defined stateful DSP functions (e.g., IIR biquad filters, quaternions-to-Euler, CRC error rate sliding windows, custom engineering unit LUTs).

---

## 3. Unified Packaging & Discovery: `.bfplugin` and `plugin.toml`

Every extension — whether a single `.h` struct pack, a `.lua` fault injector, a `.wasm` COBS-AES framer, a Python J-Link RTT sidecar, or a React WebGL attitude indicator — uses one manifest and distribution unit.

### 3.1 Discovery Hierarchy & Precedence
1. **Workspace-local (Highest Precedence):** `<workspace_dir>/.bforge/plugins/<plugin_id>/` — Allows teams to commit protocol dissectors, custom framers, and project panels alongside `.bforge.toml` in Git.
2. **User-global:**
   - Windows: `%APPDATA%\BaudForge\plugins\<plugin_id>\`
   - macOS: `~/Library/Application Support/BaudForge/plugins/<plugin_id>/`
   - Linux: `$XDG_DATA_HOME/baud-forge/plugins/<plugin_id>/` (fallback `~/.local/share/baud-forge/plugins/<plugin_id>/`)
3. **Packaged Bundle (`.bfplugin`):** A ZIP archive (stored or deflated) unpacked on install into the user or workspace plugin directory, verified by SHA-256 digest (and optional Ed25519 signature via `minisign`-compatible public key).

### 3.2 Canonical `plugin.toml` Manifest Schema
```toml
[plugin]
id = "acme.telemetry-suite"           # Reverse-DNS unique identifier
name = "ACME Orbital Telemetry Suite"
version = "1.2.0"
api_version = 1                       # Matches BaudForge host ABI v1
authors = ["ACME Avionics <eng@acme.example>"]
license = "MIT"
min_bforge_version = "0.8.0"
description = "FEC-wrapped framing, CCSDS AES-GCM dissector, and 3D orbital panel."

[security]
# Principle of least privilege: host denies everything not explicitly requested & approved.
permissions = [
  "frames:read",                      # Subscribe to TailRow / raw frames
  "frames:inject",                    # Allow scripts/panels to transmit packets
  "pins:write",                       # Allow DTR/RTS/CBUS pin control
  "storage:export",                   # Allow custom vault exporter invocation
  "fs:workspace_read",                # Sidecar/Wasm preopen read-only access to workspace dir
  "hardware:usb",                     # Sidecar hardware access (requires user prompt on workspace open)
  "net:loopback",                     # Allow UI iframe -> engineApi loopback bridge
]
sha256_verified = true

# --- Tier 1: Declarative Dissector & CRC Parameter Packs ---
[[dissectors]]
id = "acme-beacon-h"
name = "ACME Beacon C-Struct"
kind = "c_header"                     # "c_header" | "protobuf" | "mavlink" | "kaitai" | "dbc"
entry = "schemas/beacon.h"
root_struct = "BeaconPacket"
default_endian = "little"

[[crc_algorithms]]
id = "crc16_x25_acme"
width = 16
poly = 0x1021
init = 0xFFFF
refin = true
refout = true
xorout = 0xFFFF

# --- Tier 2: Embedded Lua 5.4 Scripts ---
[[scripts]]
id = "acme-auto-ack"
name = "Beacon Auto-Ack & Glitcher"
entry = "scripts/auto_ack.lua"
hooks = ["on_rx_frame", "on_tx_frame", "on_timer:500ms", "on_alert:beacon_loss"]
memory_limit_bytes = 4194304          # 4 MiB hard cap (host enforces <= 8 MiB)
instruction_budget = 200000           # Per invocation

# --- Tier 3: WebAssembly Component Model (Hot/Warm Plane) ---
[[framers]]
id = "acme-fec-framer"
name = "ACME RS(255,223) Sync Framer"
runtime = "wasm"
entry = "wasm/fec_framer.wasm"
world = "bforge:plugin/framer@0.1.0"
max_frame_bytes = 65536
fuel_per_call = 500000

[[dissectors]]
id = "acme-aes-gcm"
name = "ACME Encrypted TM Dissector"
kind = "wasm"
entry = "wasm/aes_dissector.wasm"
world = "bforge:plugin/dissector@0.1.0"
fuel_per_call = 400000
memory_limit_bytes = 16777216         # 16 MiB

[[exporters]]
id = "parquet-arrow"
name = "Apache Parquet (.parquet)"
extension = "parquet"
runtime = "wasm"
entry = "wasm/parquet_exporter.wasm"
world = "bforge:plugin/exporter@0.1.0"
mode = "dissected"                    # "raw" | "dissected"

# --- Tier 4: Out-of-Process Hardware / Protocol Sidecar ---
[[transports]]
id = "jlink-rtt"
name = "SEGGER J-Link RTT"
runtime = "sidecar"
protocol = "bforge-hal-rpc/v1"
command = ["${PLUGIN_DIR}/bin/bforge-jlink-rtt${EXE_SUFFIX}", "--rpc-stdio"]
capabilities = ["stream_rw", "pins_virtual", "target_reset"]

[transports.config_schema]
device = { type = "string", title = "Target MCU", default = "STM32H743VI" }
channel = { type = "integer", title = "RTT Up Channel", default = 0 }
speed_khz = { type = "integer", title = "SWD Clock (kHz)", default = 4000 }

# --- Tier 5: Workbench UI & DSP Extensions ---
[[ui.panels]]
id = "acme.attitude-3d"
title = "ATTITUDE 3D"
icon = "compass"
default_zone = "right"                # "left" | "center" | "right" | "bottom"
entry = "ui/attitude_panel.html"
isolation = "iframe_sandbox"          # "iframe_sandbox" (default) | "trusted_esm" (workspace/signed only)
subscriptions = ["frames", "series", "selection"]

[[ui.plot_transforms]]
id = "q_pitch_deg"
name = "Quaternion -> Pitch (deg)"
runtime = "js_worker"
entry = "ui/dsp/attitude_math.js"
args = ["q0", "q1", "q2", "q3"]
```

### 3.3 Binding Plugins in `.bforge.toml`
Workspaces remain portable and declarative by referencing plugin IDs directly in port, dissector, and bridge blocks in `.bforge.toml`:
```toml
[plugins]
enabled = ["acme.telemetry-suite"]

[[ports]]
name = "obc_rtt"
transport = "plugin:acme.telemetry-suite/jlink-rtt"
transport_config = { device = "STM32H743VI", channel = 0, speed_khz = 12000 }
framing = "plugin:acme.telemetry-suite/acme-fec-framer"

[ports.dissector]
kind = "plugin"
name = "acme.telemetry-suite/acme-aes-gcm"
```

---

## 4. Deep Dive into the Five Extension Tiers (Tech Stack & Integration)

### Tier 1: Declarative Schema, Kaitai & Custom CRC Packs
**Tech Stack:** Existing `bforge-dissect` bytecode (`DissectorIr`) + `kaitai-struct` compiler/YAML parser + parameterized CRC table engine.

* **Completing Existing Contracts:**
  * Implement the compiler for `SchemaSource::Kaitai` (`crates/bforge-dissect/src/lib.rs:25`) by lowering `.ksy` definitions into `DissectorIr` ops (`UInt`, `Int`, `Float`, `Bitfield`, `Array`, `Enum`, `Label`), plus an optional `Scale { factor, offset, unit }` / `VarLength` / `CheckCrc` op so scaling happens inside `bforge-dissect` rather than needing custom code.
  * Add CAN **`.dbc`** signal packs (29-bit/11-bit arbitration ID router + Intel/Motorola bit-start scaling).
* **Parameterized CRC Engine:**
  * Replace the hardcoded match in `crates/bforge-script/src/frame.rs:110-145` (`"crc8"`, `"crc16_ccitt_false"`, `"crc32c"`) and `bforge-dissect` with a data-driven **Rocksoft CRC engine** (`crc` crate or a 60-line generic width-8/16/32 table builder parameterized by `(width, poly, init, refin, refout, xorout)` loaded from `[[crc_algorithms]]`).
* **Why Tier 1 First:** Zero sandboxing overhead, sub-microsecond execution in Rust, editable live via `POST /api/schema`, and works identically during live streaming (`Stream::feed`) and historical `.bflog` vault scrubbing (`decode_vault` / `decode_window`).

---

### Tier 2: Embedded Lua 5.4 (`bforge-script` Hardened & Expanded)
**Tech Stack:** Existing **`mlua = "0.10"` (`lua54`, `vendored`, `send`)** in `crates/bforge-script`. Keep Lua 5.4 (do **not** swap in LuaJIT or Rhai right now): `mlua` 0.10 already cross-compiles cleanly to all 6 CI targets (`windows/linux/macos` x `x86_64/aarch64`) and integrates directly with `bforge-dissect`.

* **Required Sandbox Hardening:**
  1. Call `lua.set_memory_limit(config.memory_limit_bytes.min(8 * 1024 * 1024))` during `ScriptRuntime::compile` (`crates/bforge-script/src/runtime.rs:76`) to prevent table-allocation OOM bombs.
  2. Guard `bforge.log(...)` with rate limiting (`<= 50 messages/sec` into `LogRing`) so a noisy script cannot flood `GET /api/logs` or stderr.
* **Wiring `ScriptHook` & `AlertConfig` (`crates/bforge-script/src/lib.rs:65-72`, `crates/bforge-core/src/lib.rs:177-184`):**
  Expand `bforge` globals while retaining full backwards compatibility with single-function `bforge.on_frame(fn)`:
  ```lua
  -- 1. RX / TX / MITM directional hooks with channel filter
  bforge.on_rx_frame("fc_uart", function(frame) ... end)
  bforge.on_tx_frame("fc_uart", function(frame) ... end)
  bforge.on_mitm_frame("OBC_TO_EPS", function(frame)
      local pkt = frame:dissect("C_STRUCT:EpsCommand") -- fixes D-94 single-schema limit
      if pkt and pkt:get("opcode") == 0x42 then
          pkt:set("voltage_mv", 3150)
          pkt:recalc_crc("crc16_x25_acme")
          return pkt:delay_ms(12) -- returns FrameVerdict::Delay { bytes, delay_ms }
      end
      return frame
  end)

  -- 2. Periodic timer & dead-man alert hooks (requires permission: frames:inject / pins:write)
  bforge.on_timer(500, function(ctx)
      ctx.send("fc_uart", bforge.unhex("AA 55 01 00"))
  end)

  bforge.on_alert("obc_telemetry_lost", function(alert)
      bforge.log_warn("Telemetry timeout on " .. alert.port)
      bforge.pulse_pin("fc_uart", "RTS", 100) -- triggers PinJob from Session pump
  end)
  ```
* **Architectural Fix in `Session` (`crates/bforge-core/src/session.rs:484-486`):**
  Pass a shared map `HashMap<String, Arc<DissectorIr>>` of **all** loaded port schemas and plugin `Ir` tags into `ScriptRuntime`, enabling `frame:dissect("schema_tag")` cleanly across multi-port MITM sessions (`specs/0034-script-fields.md:23`).

---

### Tier 3: WebAssembly Component Model (`wasmtime` + WIT) — The High-Speed Native Plugin Core
**Tech Stack:** **`wasmtime` (v26+ with Component Model enabled)** + **WIT (`wit-bindgen`)** inside a new crate `crates/bforge-plugin-wasm`.

Why Wasmtime + WIT instead of C dynamic libraries (`.dll`/`.so`) or Python plugins for data-plane logic?
1. **Safety & `.bflog` integrity:** A bad pointer in a C `.dll` segfaults the whole workstation and truncates the active capture vault. A trap inside Wasmtime cleanly unwinds the guest frame call and degrades gracefully without corrupting memory or disk.
2. **Speed near native Rust/C:** With **AOT `.cwasm` compilation cache** (keyed by module SHA-256 + host Wasmtime version in `%APPDATA%\BaudForge\wasm-cache\`), module instantiation takes `< 50 µs` and raw frame parsing/COBS/AES/Reed-Solomon runs at **1.2x–1.8x native C/Rust speed** — orders of magnitude faster than Lua/JS/IPC.
3. **Language freedom:** Plugin authors write in **Rust, C/C++, Zig, TinyGo, or AssemblyScript** and distribute a single `.wasm` component binary across Windows, macOS, and Linux (`x86_64` & `aarch64`) without per-OS CI matrices.
4. **Zero-ambient-authority capability sandbox:** `WasiCtx` is configured with **zero preopened directories and zero network sockets** for framers and dissectors (`std::fs::read` doesn't even link/succeed unless the manifest specifically grants storage/export stream pipes).

#### 3.1 Canonical WIT Contract (`wit/bforge-plugin.wit`)
```wit
package bforge:plugin@0.1.0;

interface types {
    record kv-pair {
        key: string,
        val: string,
    }

    variant field-value {
        unsigned(u64),
        signed(s64),
        floating(f64),
        text(string),
        bytes(list<u8>),
        none,
    }

    record decoded-field {
        name: string,
        byte-offset: u32,
        byte-len: u32,
        display: string,
        numeric: option<f64>,
        children: list<decoded-field>,
    }

    enum crc-status {
        valid,
        invalid,
        absent,
    }

    record dissect-result {
        protocol-tag: string,
        crc: crc-status,
        fields: list<decoded-field>,
        error: option<string>,
    }
}

interface host-log {
    log: func(level: u8, message: string);
}

interface framer {
    /// Configure framer from JSON/TOML parameters supplied in .bforge.toml
    init: func(config-json: string, max-frame-bytes: u32) -> result<_, string>;
    /// Consume incoming bytes and return zero or more completed frames
    feed: func(chunk: list<u8>) -> list<list<u8>>;
    /// Advance nanosecond monotonic clock (for time-gap framers)
    tick: func(now-ns: u64) -> list<list<u8>>;
    /// Number of bytes buffered awaiting frame completion
    pending: func() -> u32;
    /// Clear partial buffer after transport disconnect/yield
    reset: func();
}

interface dissector {
    use types.{dissect-result};

    init: func(config-json: string) -> result<_, string>;
    decode: func(frame: list<u8>, port-name: string, timestamp-ns: u64) -> dissect-result;
}

interface exporter {
    record log-entry {
        timestamp-ns: u64,
        port: string,
        direction: u8,
        payload: list<u8>,
        decoded-json: option<string>,
    }

    begin: func(meta-json: string) -> result<list<u8>, string>;
    write-batch: func(entries: list<log-entry>) -> result<list<u8>, string>;
    finish: func() -> result<list<u8>, string>;
}

world framer-plugin {
    import host-log;
    export framer;
}

world dissector-plugin {
    import host-log;
    export dissector;
}

world exporter-plugin {
    import host-log;
    export exporter;
}
```

#### 3.2 Rust Host Adapters (Dropping Seamlessly into Existing `bforge-core` Loops)
1. **`WasmByteMachine` implementing `bforge_framer::machine::ByteMachine`:**
   - Lives behind `tail::framing_machine(port)` (`crates/bforge-core/src/tail.rs:518`).
   - Reuses the existing `Stream` contract: when `Session::pump_once` detects transport reconnect/yield (`session.rs:1029-1038`), `stream.reset_machine()` calls `WasmByteMachine::reset()`.
   - Zero changes required inside `Pipeline::start` or `SlabPool`!
2. **`Decoder::Wasm(WasmDissector)` added alongside `Decoder::Ir` and `Decoder::Pack` (`crates/bforge-core/src/tail.rs:25-47`):**
   - Translates WIT `decoded-field` recursively to `bforge_dissect::DecodedField`, keeping identical offsets, lengths, and `value_num` semantics for `HexInspector`, `PacketStreamView`, and `PlotEngine`.
3. **Deterministic Budgeting & Recovery in `Wasmtime`:**
   - **Fuel metering:** Before every `feed` or `decode` call, set `store.set_fuel(config.fuel_per_call)` (default `500_000` fuel $\approx$ `100–250 µs` worst-case cap, `~5–20 µs` typical).
   - **Memory cap:** Attach `StoreLimitsBuilder::new().memory_size(16 * 1024 * 1024).instances(4).build()` to `store.limiter(...)`.
   - **Epoch interruption:** A lightweight 10 ms ticker thread increments `engine.increment_epoch()` so an unresponsive plugin cannot block shutdown.
   - **Fault handling:** If a Wasm dissector traps or runs out of fuel: capture the trap message in `TailRow.decode_error` (preserving the raw bytes in the `.bflog` vault!), increment `plugin_traps`, and automatically **re-instantiate** the `Store` if the guest poisoned its internal state (never dropping packets from the `.bflog` logger).

---

### Tier 4: Out-of-Process Hardware & Protocol Sidecars (`bforge-hal` `SidecarTransport` + Control Plane)
**Tech Stack:** Child OS process spawned and supervised by `crates/bforge-hal/src/sidecar.rs` speaking **length-prefixed binary frames + JSON-RPC 2.0 control messages** over `stdin`/`stdout` (with optional Named Pipe on Windows / Unix Domain Socket on POSIX for high-throughput bulk streams).

Why out-of-process instead of Wasm for hardware transports?
Vendor hardware SDKs — **SEGGER J-Link SDK**, **Saleae Logic / SocketCAN / PEAK PCAN**, **FTDI D2XX MPSSE**, **National Instruments VISA / GPIB**, **Bleak / WinRT BLE GATT**, or **STM32CubeProgrammer DFU** — ship closed-source C shared libraries, kernel ioctls, or Python/Node bindings that cannot compile to Wasm.

#### 4.1 Wire Protocol (`bforge-hal-rpc/v1`)
A simple, language-agnostic framed packet format over `stdin`/`stdout` (implemented cleanly in 150 lines of Rust, C, or Python):

```
+---------------+---------------+-----------------------------------+
| Magic (2B)    | Kind (1B)     | Payload Length (u32 LE, 4B)       |
| 0x42 0x46     | 0x01..0x04    | <= 65536                          |
+---------------+---------------+-----------------------------------+
| Payload (Payload Length bytes)                                    |
+-------------------------------------------------------------------+
```
* **Frame Kinds:**
  * `0x01 CONTROL_RPC` (UTF-8 JSON-RPC 2.0): `open(config)`, `close()`, `set_pins(u16)`, `read_pins() -> u16`, `state() -> PortState`, `heartbeat()`, `capabilities()`, `error(code, msg)`.
  * `0x02 RX_DATA` (Raw binary, **zero JSON/base64 encoding overhead!**): `[u64 timestamp_ns LE][raw bytes...]` — sidecar pushes incoming hardware bytes asynchronously; `SidecarTransport::read_slab(&mut self, out: &mut [u8])` drains an internal lock-free/mutex ring buffer fed by a dedicated stdout reader thread.
  * `0x03 TX_DATA` (Raw binary): `[raw bytes...]` — maps `TransportDriver::write_frame`.
  * `0x04 PIN_EVENT` (Binary 10B): `[u64 timestamp_ns LE][u16 pin_flags LE]` — hardware edge notifications.

#### 4.2 Integration into `bforge-hal` & `bforge-core`
1. `SidecarTransport` implements `TransportDriver` (`crates/bforge-hal/src/lib.rs:180-192`) directly, fitting straight into `Pipeline::start` (`Box<dyn TransportDriver + Send>`).
2. **`session_ports_from_config` (`crates/bforge-core/src/session.rs:1344`):** Add `"plugin:<plugin_id>/<transport_id>"` resolution alongside `"serial" | "tcp-client" | "tcp-server" | "udp"`.
3. **Process Supervision & Crash Isolation:**
   * If a vendor DLL (e.g., USB driver crash on hot-unplug) kills the sidecar child process, `SidecarTransport::state()` transitions cleanly to `PortState::Reconnecting`, `Session` keeps the `.bflog` vault open and flushes buffered packets, emits `UiEvent::PortStateChanged`, and restarts the sidecar with exponential backoff (`250 ms` $\to$ `500 ms` $\to$ `2 s`).
   * On `Session::stop()` or host exit, the sidecar receives `close` + `EOF` (followed by OS job-object / `PR_SET_PDEATHSIG` cleanup on crash so no orphaned sidecar processes ever remain running — enforcing clean lifecycle management).
4. **Live Port Discovery (`GET /api/devices`):** Sidecars can optionally expose `--list-devices` JSON so `useSerialPortScanner` in `Launcher.tsx` surfaces connected J-Link probes, CAN adapters, or VISA instruments right inside the Workspace Loader alongside COM ports!

---

### Tier 5: Workbench UI & DSP Extensions (`ui/src/plugins/`)
**Tech Stack:** TypeScript Host SDK (`@baudforge/plugin-sdk` generated from `engineApi.ts` DTOs), **Sandboxed `<iframe sandbox="allow-scripts">` + `MessageChannel`** (default for third-party community UI panels), **Trusted ESM / Web Component** (opt-in for verified/built-in plugins), and **isolated Web Worker JS transforms** for Plot Forge DSP expressions.

#### 5.1 Central Dynamic Panel & Extension Registry (`usePluginStore.ts`)
Replace the static duplication in `ui/src/components/WorkstationDock.tsx:43-58, 792-806` and `ui/src/components/GlobalRibbon.tsx:32-47`:
* Merge built-in panels (`14` today) and active plugin `[[ui.panels]]` into a single registry queried by both `<DockviewReact components={...} />`, `titles`, and `GlobalRibbon`'s `Re-open Closed Panel` menu.
* Add a generic `PluginDockPanel` wrapper inside `components` (`WorkstationDock.tsx:43`) that renders either:
  * **Sandboxed `<iframe>` (`sandbox="allow-scripts"`, no `allow-same-origin`):** Shares BaudForge CSS theme variables via an initial theme snapshot message, then opens a dedicated **`MessageChannel` (`port2`)** for low-overhead streaming.
  * **Zero-copy Data Delivery:** `App.tsx` / `useWorkstationStore` posts `selectedPacket`, filtered `frames` batches, or downsampled `Float64Array` (`Transferable`) waveform slices over `port1` only for the panel's declared `subscriptions` (avoiding copying the full 500k-sample rings).
  * **Reverse Actions (`iframe -> host`):** Gate actions by `[security].permissions` from `plugin.toml` (`host.selectTimestamp(us)`, `host.selectPacket(seqId)`, `host.sendPayload(port, bytes)` [only if `frames:inject` granted]).

#### 5.2 Extensible UI Touchpoints Beyond Dock Panels
1. **Plot Forge DSP Functions (`ui/src/plot/expr.ts` + `PlotEngine`):**
   Allow `[[ui.plot_transforms]]` to register stateful per-channel transforms in a Web Worker / compiled closure (e.g., `lowpass(x, fc)`, `notch50(x)`, `q_pitch(w,x,y,z)`, `rolling_rms(x, n)`), surfaced cleanly in `PlotForgeView`'s field/math picker alongside `atan2`, `hypot`, `clamp`, etc.
2. **Command Forge Payload Encoders (`ui/src/components/CommandForge.tsx`):**
   Register custom TX encoder tabs (e.g., AT command builder, SCPI/MODBUS coil matrix, Firmware DFU chunker) that output raw `Uint8Array` bytes or typed field maps into the existing Command Forge `RAW` / `BYTE CELLS` pipeline.
3. **Inline Field Renderers (`ProtocolDissector.tsx` & `PacketStreamView.tsx`):**
   Small declarative/JSON transform mappings or sparkline/status badge formatters (e.g., rendering a raw `u32` bitmask as semantic flag pills `ARMED | GPS_3D | EK_OK`, or `lat_e7 / 1e7` as `37.7749° N`).

#### 5.3 Backend Discovery Endpoint (`crates/bforge-core/src/serve.rs`)
Expose plugin inventory & assets on the existing loopback HTTP/Tauri bridge:
* `GET /api/plugins` $\rightarrow$ list of discovered plugins, enabled state, capabilities, permission warnings, and runtime health (`wasm_traps`, `lua_failures`, `sidecar_restarts`).
* `POST /api/plugins/<id>/toggle` $\rightarrow$ enable/disable plugin in workspace config (with live reload for Tier 1/2/3/5 and clear restart prompt for Tier 4 session transports).
* `GET /api/plugins/assets/<id>/<path>` $\rightarrow$ serves bundled `ui/*.html` / `ui/*.js` over `127.0.0.1` with strict `Content-Security-Policy` headers so Tauri/WebView never exposes `file://` origin paths to third-party scripts.

---

## 5. Security, Sandboxing & Fault-Isolation Summary

Because embedded engineers load captures and dissectors shared by third-party hardware vendors or teammates, BaudForge must make dangerous capabilities **explicit and fail-safe**:

| Tier | Execution Boundary | Memory Limit | CPU / Time Limit | Filesystem / Network / Hardware Access | On Fault / Panic |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (Schemas)** | Pure data (`DissectorIr`) in Rust | Bounded by `MAX_FRAME = 64 KiB` | `O(ops.len())`, bounded depth | None (compile-time file load only) | Sets `TailRow.decode_error`; raw frame still saved in `.bflog` |
| **Tier 2 (Lua 5.4)** | `mlua` VM, stdlib whitelist (`TABLE\|STRING\|MATH\|UTF8`) | `4 MiB` default (`<= 8 MiB` hard cap via `lua.set_memory_limit`) | `200,000` instructions/frame via hook | None directly; TX/Pin APIs gated by `permissions` | Increments `failures`; fail-open returns original bytes |
| **Tier 3 (Wasmtime)** | Wasm Component linear memory isolation | `16 MiB` (`StoreLimits`), `<= 4` instances | `500,000` fuel/call + `10 ms` epoch interrupt | Zero WASI `fs`/`net` for framers & dissectors; stream I/O only for exporters | Re-instantiates guest `Store` on trap; preserves raw frame in `.bflog` |
| **Tier 4 (Sidecar)** | Separate OS child process + Job Object / cgroup | Monitored RSS (`256 MiB` soft warning) | `50 ms` RPC call timeout; `1 s` heartbeat | Full OS access (gated by user trust prompt on `hardware:usb` / `net`) | Crash isolated from `bforge-core`; port transitions to `Reconnecting`, vault untouched |
| **Tier 5 (UI Panel)** | `<iframe sandbox="allow-scripts">` (opaque origin) | Browser isolate | Async `MessageChannel`; throttled batches | Zero direct DOM/Tauri IPC; gated through `EngineApiClient` permission check | Error boundary displays crashed plugin notice; Dockview & engine stay at 60 fps |

**Trust UX Policy (Workspace Opening):**  
When opening an unfamiliar `.bforge.toml` workspace that enables workspace-local **Tier 4 (Sidecar)** or **Trusted ESM UI** plugins (or requests `frames:inject` / `pins:write`), the Workspace Loader displays a concise **"Workspace Plugin Permissions"** approval modal (similar to VS Code Workspace Trust). Tier 1 declarative schemas, sandboxed Tier 2 Lua (`frames:read`-only), Tier 3 Wasm, and Tier 5 sandboxed iframes run automatically with zero prompt friction.

---

## 6. Phased Implementation Roadmap (Incremental Delivery)

Instead of a big-bang rewrite, the system fits cleanly onto BaudForge's existing crates in four focused waves:

### Wave 1 — Foundation: Plugin Registry, Lua Hardening & Dynamic Dock Panels
1. **New Crate `crates/bforge-plugin`:** `plugin.toml` serde manifest parser, discovery scanner (`workspace/.bforge/plugins` + OS plugin dir), permission model, and `.bfplugin` ZIP unpacker/verifier.
2. **Harden `crates/bforge-script`:** Add `lua.set_memory_limit(4 * 1024 * 1024)` in `runtime.rs:76`, rate-limit `bforge.log`, wire `ScriptHook::OnMitmFrame` + `OnAlert`, and inject a multi-schema `HashMap<String, Arc<DissectorIr>>` into `Session` to close `D-94` (`frame:dissect("TAG")`).
3. **Dynamic UI Registry (`ui/src/store/usePluginStore.ts`, `WorkstationDock.tsx`, `GlobalRibbon.tsx`):** Unify the duplicated 14-panel `components`/`titles`/`PANEL_CATALOG` tables into one dynamic registry supporting `iframe_sandbox` plugin panels + `GET /api/plugins` in `serve.rs`.

### Wave 2 — High-Speed Data Plane: Wasmtime Component Host (`crates/bforge-plugin-wasm`)
1. Define `wit/bforge-plugin.wit` (`framer`, `dissector`, `exporter` worlds).
2. Implement `WasmByteMachine` (`impl ByteMachine` wired into `tail::framing_machine`) and `Decoder::Wasm(WasmDissector)` (wired into `tail::decoder_from_config`).
3. Add fuel + epoch interruption + `StoreLimits` + `.cwasm` AOT cache keyed by SHA-256.
4. Publish an official minimal Rust & C starter template (`examples/plugins/cobs-crc-wasm/`) so plugin authors can compile `.wasm` modules in 1 command.

### Wave 3 — Hardware & Protocol Sidecars (`crates/bforge-hal/src/sidecar.rs`)
1. Implement `SidecarTransport` (`impl TransportDriver`) using the `0x42 0x46` binary/JSON-RPC wire protocol over child process stdio.
2. Wire `"plugin:<id>/<transport>"` into `session_ports_from_config` (`crates/bforge-core/src/session.rs:1344`), device enumeration (`GET /api/devices`), and OS job-object child teardown.
3. Ship an official Python/Rust example sidecar (e.g., SocketCAN or SEGGER J-Link RTT bridge).

### Wave 4 — Declarative & Workbench Polish
1. Wire `SchemaSource::Kaitai` (`.ksy`) and `.dbc` compilation into `bforge-dissect`, plus custom Rocksoft CRC definitions (`[[crc_algorithms]]`).
2. Expose Wasm/Sidecar custom exporters alongside `ExportFormat` (`crates/bforge-storage/src/export.rs`), including an official Parquet/Arrow plugin.
3. Add `[[ui.plot_transforms]]` registration in `ui/src/plot/expr.ts` / `PlotEngine`, Command Forge encoder tabs, and a **Plugin Manager** view inside Settings / Launcher.

---

## 7. Quick-Reference Decision Matrix for Plugin Authors

| I want to build… | Best Tier | Language(s) | Typical Latency | User Trust Prompt Needed? |
| :--- | :--- | :--- | :--- | :--- |
| A C-struct, Protobuf, MAVLink, Kaitai, or CAN DBC parser | **Tier 1** | Declarative (`.h`/`.proto`/`.xml`/`.ksy`/`.dbc`) | `< 1 µs` | No |
| A checksum fixer, TX/RX/MITM fault script, or auto-responder | **Tier 2** | Lua 5.4 | `3 – 25 µs` | Only if `frames:inject` / `pins:write` |
| A custom binary framer, encrypted/compressed dissector, or Parquet exporter | **Tier 3** | Rust, C, C++, Zig, TinyGo (`wasm32-wasip2`) | `2 – 30 µs` (JIT/AOT) | No (unless workspace FS export) |
| A J-Link RTT, Saleae, SocketCAN, BLE GATT, or NI-VISA driver | **Tier 4** | Rust, C++, Python, Go (Native binary) | `50 – 500 µs` | Yes (native OS process / HW access) |
| A 3D attitude gauge, motor-control dashboard, custom Plot DSP, or field badge | **Tier 5** | TypeScript / React / Canvas / WebGL | `16 ms` (`60 fps` UI) | No (for `iframe_sandbox`) |
