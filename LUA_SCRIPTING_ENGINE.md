# BaudForge Lua 5.4 HIL & Protocol Scripting Engine Architecture

**Document Status:** Implemented & Verified (`RFC-002`) — Waves 1–3 complete in working tree (`2026-11-15`)  
**Date:** 2026-11-15  
**Target Codebase:** `crates/bforge-script`, `crates/bforge-core`, `crates/bforge-dissect`, `crates/bforge-storage`, `ui/`  
**Related Specs:** [`PLUGIN_ARCHITECTURE.md`](./PLUGIN_ARCHITECTURE.md) (`Tier 2`), [`specs/0034-script-fields.md`](./specs/0034-script-fields.md), [`specs/ADR & SRS.md`](./specs/ADR%20%26%20SRS.md) (`FR-SCR-01`, `FR-MITM-01`, `FR-FLT-01`), [`docs/PYTHON_VS_LUA_ANALYSIS.md`](./docs/PYTHON_VS_LUA_ANALYSIS.md)  
**Tutorial & Examples:** [`docs/LUA_SCRIPTING_TUTORIAL.md`](./docs/LUA_SCRIPTING_TUTORIAL.md) · [`01_packet_filter_and_metadata.lua`](./examples/tutorials/01_packet_filter_and_metadata.lua)–[`15_fail_closed_safety_interlock_and_budget.lua`](./examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua)

---

## 1. Executive Summary

BaudForge already ships an embedded Lua 5.4 VM (`mlua = "0.10"`, `features = ["lua54", "vendored", "send"]` in `crates/bforge-script/Cargo.toml:12`) behind `ScriptRuntime`, with an instruction watchdog and initial `DissectorIr` field patching. However, inspecting the implementation across `crates/bforge-script` and `crates/bforge-core` shows that the runtime currently operates as an isolated single-hook TX/raw-RX byte filter rather than a full Hardware-in-the-Loop (HIL) and protocol scripting engine.

This specification defines a production-ready **Lua 5.4 HIL & Protocol Scripting Engine** that preserves backwards compatibility with existing `bforge.on_frame(fn)` scripts while transforming Lua into a safe, fast, multi-hook, deterministic automation and workbench scripting layer.

---

## 2. Audit of Current `crates/bforge-script` & `crates/bforge-core` Seams

### 2.1 What Exists Today (Measured in Current Code)
- **VM & Sandbox (`crates/bforge-script/src/runtime.rs:19-23, 76-82, 111-123`)**:
  - Compiles `mlua::Lua::new_with(StdLib::TABLE | StdLib::STRING | StdLib::MATH | StdLib::UTF8, LuaOptions::default())`. No `io`, `os`, `package`, or `debug` standard libraries are loaded.
  - Enforces `INSTRUCTION_BUDGET = 200_000` via `HookTriggers::new().every_nth_instruction(HOOK_TICK)` (`HOOK_TICK = 10_000`, `HOOK_TICKS = 20`), resetting `ticks` before each `run()`.
  - Fail-open verdict handling (`runtime.rs:150-228`): script errors, exceeded instruction budgets, or bad return types increment `failures`, populate `last_error`, and return `FrameVerdict::Send(bytes.to_vec())`.
- **Exposed API (`runtime.rs:236-281`, `frame.rs:52-166`)**:
  - Global table `bforge` with `on_frame(fn)`, `log(msg)`, `unhex(str)`, `hex(tbl)`.
  - `frame` table (when `DissectorIr` is attached via `ScriptRuntime::with_schema`): `frame.hex`, `frame:get(name)`, `frame:set(name, val)`, `frame:recalc_crc(name)` (`"crc8"`, `"crc16_ccitt_false"`, `"crc32c"`), and `frame:bytes()`.
- **Unused Hook Definition (`crates/bforge-script/src/lib.rs:65-72`)**:
  - `ScriptHook` defines `OnMitmFrame { channel, frame }` and `OnAlert { name }`, with `Channel::{ATapA, BTapB, AToB, BToA}`, but neither is wired into `ScriptRuntime` or `Session`.

### 2.2 Seven Concrete Gaps Identified in Current Implementation
1. **Unframed RX Execution (`crates/bforge-core/src/session.rs:1068-1077`)**:
   - `self.rx_script.as_mut()` runs on raw transport slabs (`slab.bytes()`) *before* `stream.feed(meta.timestamp_ns, &payload)` frames the incoming stream at `session.rs:1100`.
   - When a UART read splits one packet across two OS reads or coalesces two packets into one slab, `rx_script` sees partial/merged chunks rather than packet boundaries, breaking `frame:get(name)` and `frame:set(name, val)` on RX.
2. **MITM Bridge Bypasses Scripting (`crates/bforge-core/src/session.rs:1091-1098, 1522-1585`)**:
   - `Session::pump_once` copies `slab.bytes()` straight into `crossed[index]`, and `Session::forward` posts directly to `self.ports[to].pipeline.post(...)` without framing or invoking `ScriptRuntime`. `FR-MITM-01` inline bridge fault injection is therefore unwired.
3. **Single-Schema Limitation (`D-94`, `crates/bforge-core/src/session.rs:476-496`)**:
   - `Session::schema()` (`session.rs:484-486`) returns `self.encoders.iter().find_map(|ir| ir.clone())` — only the first port's C-struct `DissectorIr`.
   - Multi-port sessions with distinct packet formats, built-in protocol packs (`ccsds_tm`, `ccsds_tc`, `csp`, `modbus_rtu`, `mavlink`, `protobuf`), and dynamic `frame:dissect("schema_tag")` calls are unsupported.
4. **Per-Frame Heap Allocation & Repeated Re-Decode (`runtime.rs:165, 284`, `frame.rs:52-166`)**:
   - Without a schema, `runtime.rs:165` runs `hex_of(bytes)` on every frame, allocating per-byte `"XX"` `String`s + `.collect::<Vec<_>>().join(" ")` even if the script drops or passes the frame immediately.
   - With a schema, `frame_table` (`frame.rs:52-166`) allocates a fresh `mlua::Table`, formats `frame.hex`, constructs `Arc<Mutex<FrameState>>`, and allocates 4 Lua closures (`get`, `set`, `recalc_crc`, `bytes`) on *every* frame.
   - `frame:get(name)` (`frame.rs:72-78`) calls `exec::execute(&state.ir, &state.bytes)` from scratch on *every single field lookup* instead of decoding lazily once per frame.
5. **Black-Holed Logging (`runtime.rs:247`)**:
   - `bforge.log(msg)` prints `eprintln!("script: {message}")` without touching `Shared.logs` (`LogRing`), so script diagnostics never appear in `GET /api/logs`, `ActivityLogView`, or `<vault>.activity.jsonl`, and there is no log rate limit.
6. **Missing Sandbox Memory Cap, Deterministic Utilities, and Active Controls**:
   - `Lua::new_with` (`runtime.rs:76-79`) does not call `lua.set_memory_limit(...)`, leaving the host vulnerable to table-allocation OOM before the instruction hook fires.
   - Scripts lack monotonic timestamps (`now_us`/`now_ms`), deterministic seedable PRNG (`seed`/`rand`), timed frame delay (`FrameVerdict::Delay`), active TX injection (`bforge.send`), hardware pin pulsing (`bforge.pulse_pin`), live signal plotting (`bforge.plot`), and test assertions (`bforge.assert`).
7. **No Live HTTP Control Plane or Workbench UI (`serve.rs`, `ui/`)**:
   - Scripts can only be attached via backend config/CLI; `serve.rs` has no `/api/script` endpoints and `ui/` (`FaultRigView.tsx` currently handles only static hardware fault profiles) has no script editor, dry-run packet sandbox, or live metrics view.

---

## 3. Five Core Roles of the Redesigned Lua 5.4 Engine

Rather than limiting Lua to byte-level fault injection, the engine should unify five tightly scoped real-time and interactive roles under one sandbox:

1. **Inline Packet Interceptor & MITM Mutator (`on_rx_frame`, `on_tx_frame`, `on_mitm_frame`, optional `on_raw_chunk`)**:
   - Intercepts packets after framing (and optionally raw transport slabs pre-framer for framing/sync corruption tests).
   - Supports zero-copy `Pass`, payload replacement `Send(Vec<u8>)`, non-blocking timed delivery `Delay { bytes, delay_ms }`, suppression `Drop`, and multi-packet fragmentation/duplication `Burst(Vec<(Vec<u8>, u16)>)`.
2. **Autonomous Virtual Responder / Device Emulator (`bforge.send`)**:
   - Enables Lua to stand in for missing firmware or peer subsystems (e.g., emulating an EPS, battery BMS, or Modbus slave) by inspecting inbound RX frames and enqueueing delayed ACK or telemetry replies (`bforge.send(port, bytes_or_hex, { delay_ms = 5 })`).
3. **Closed-Loop HIL Test & Pin Sequencer (`on_init`, `on_timer`, `on_alert`, `bforge.pulse_pin`, `bforge.assert`)**:
   - Drives reproducible hardware tests: resets DUT via `DTR`/`RTS`, waits for boot banner or heartbeat, injects CRC/dropout/bit-flip faults, verifies protocol recovery via `bforge.assert(cond, label)`, and emits pass/fail telemetry.
4. **Derived Telemetry & Live Signal Generator (`bforge.plot`, `bforge.metric`)**:
   - Pushes synthetic/computed series (`bforge.plot("power_w", v_batt * i_batt, frame.timestamp_us)`) straight into `Session.series` and the `PlotEngine` pipeline (for instant graphing in `PlotForgeView` and `OscilloscopeView`) alongside watch-table scalars (`bforge.metric("crc_errors", count)`).
5. **Rapid Prototype Dissector & Dynamic Command Builder (`on_dissect`, `on_command`)**:
   - Lets engineers decode proprietary/encrypted protocols via `frame:add_field(...)` before promoting hot dissectors to Rust or Tier 3 Wasm, and lets Command Forge invoke Lua payload generators for rolling sequence counters, epoch timestamps, or challenge-response auth.

---

## 4. VM Lifecycle, Hooks & Execution Flow

### 4.1 Hook Pipeline in `Session`

```text
  [Transport Slab]
         │
         ├─(optional)──► script: on_raw_chunk(port, chunk) ──► raw byte glitches / framing stress
         ▼
  [ByteMachine Framer]
         │
         ├──► script: on_rx_frame(port, frame) ──► vault / frames / Dissector / Plot / Series
         │         │
         │         └──(if bridge forwards A->B)──► script: on_mitm_frame(bridge_id, frame)
         │                                                │
         │                                                ▼
         │                                    Port B TX (Delay / Drop / Mutate / Forward)
         │
  [Command / UI / Script TX]
         │
         ├──► FaultInjector (static UI profile)
         │
         └──► script: on_tx_frame(port, frame)  (skipped if frame carries Origin::Script unless opt-in)
                   │
                   ▼
             pipeline.write / pipeline.post_after(delay)
```

### 4.2 Structured Hook Registry
Keep `bforge.on_frame(fn)` working identically as shorthand for TX (when loaded on TX) or fallback handler, while supporting scoped registration tables:

- `bforge.on_init(fn(ctx))` — runs once on load/session start; initializes deterministic seed, lookup tables, state machines, and initial metrics.
- `bforge.on_rx_frame(port_or_star, fn(frame))` — runs post-framer per packet on the matching `port` (or `"*"` for all ports).
- `bforge.on_tx_frame(port_or_star, fn(frame))` — runs before wire transmission (`Session::send` / `Session::send_paced`).
- `bforge.on_mitm_frame(bridge_or_star, fn(frame))` — runs inside `Session::forward` for bridging `(a -> b)` and `(b -> a)`, exposing `frame.direction` (`"mitm_a_to_b"` / `"mitm_b_to_a"`), `frame.src_port`, `frame.dst_port`, and `frame.bridge`.
- `bforge.on_raw_chunk(port_or_star, fn(chunk))` — explicit opt-in pre-framer hook preserving today's raw-slab interception capability for testing sync-word loss or partial reads.
- `bforge.on_timer(interval_ms, fn(ctx))` — monotonic tick driven cleanly by `Session::pump_once` (minimum interval clamped e.g. `>= 10 ms`, max 8 registered timers per VM).
- `bforge.on_alert(alert_name, fn(alert))` — invoked when `AlertConfig` (`crates/bforge-core/src/lib.rs:177-184`, e.g., `dead_man_timer`) fires.
- `bforge.on_command(name, fn(args))` — optional Command Forge payload generator returning byte string / hex / patched table.
- `bforge.on_dissect(port_or_star, fn(frame))` — optional custom field emitter (`frame:add_field(name, offset, len, value_str, [value_num])`).

### 4.3 Frame Verdict Algebra
Replace the 2-variant `FrameVerdict` with an explicit verdict algebra (zero-copy when unmodified):

```rust
pub enum FrameVerdict {
    /// Forward original frame untouched (no Vec clone when unmodified).
    Pass,
    /// Forward mutated payload immediately.
    Send(Vec<u8>),
    /// Schedule delivery after delay_ms on the reader thread (`pipeline.post_after`).
    Delay { bytes: Vec<u8>, delay_ms: u16 },
    /// Drop the frame.
    Drop,
    /// Emit zero, one, or multiple timed frames (packet duplication / burst / split).
    Burst(Vec<ScheduledFrame>),
}
```

In Lua:
- `return nil` or `return frame:drop()` -> `FrameVerdict::Drop`
- No return value (function falls off end), `return true`, or untouched `return frame` -> `FrameVerdict::Pass` (fast zero-clone path if `frame` was not mutated)
- `return frame` (when mutated) or mutated spaced hex string -> `FrameVerdict::Send(next)`
- `return frame:delay_ms(12)` -> `FrameVerdict::Delay { bytes, delay_ms: 12 }`
- `return { { frame:clone_bytes(), 0 }, { frame:clone_bytes(), 5 } }` or `bforge.burst(...)` -> `FrameVerdict::Burst(...)`

---

## 5. High-Speed `LuaFrame` (`mlua::UserData`) & Multi-Schema Design

### 5.1 Replacing Per-Frame Tables & Closures with `LuaFrame` `UserData`
To keep inline latency below the **50 µs** MITM budget (`specs/ADR & SRS.md:267`) even at **10 kHz+** packet rates:

1. **Zero Closure Allocation per Frame**: Implement `mlua::UserData` on `LuaFrame` (or hold one pooled `Arc<Mutex<FrameSlot>>` / `LuaFrame` userdata handle) instead of constructing a fresh `Table` + 4 Rust closures + eager `hex_of` string on every frame.
2. **Lazy Hex Formatting**: Computing `"AA 55 01 ..."` is skipped completely unless the script accesses `frame.hex`.
3. **Single-Pass Lazy Decode Cache**: On the first `frame:get(name)` or `frame:fields()` access, run `exec::execute(&ir, &bytes)` *once*, cache the decoded field values inside the frame state for $O(1)$ subsequent reads, and invalidate only when raw bytes change (reading from pending `changed` map first, matching `specs/0034-script-fields.md:28-29`).
4. **Optional Byte-Buffer Mode**: Expose raw binary reads (`frame:u8(off)`) directly against the `Vec<u8>` slice with zero string conversion.

### 5.2 Complete `frame` API Surface
- **Read-Only Metadata Fields (`__index`)**:
  - `frame.port` (`string`): port ID (e.g., `"obc_telemetry"`)
  - `frame.direction` (`string`): `"rx" | "tx" | "mitm_a_to_b" | "mitm_b_to_a"`
  - `frame.seq_id` (`integer`): engine frame sequence ID
  - `frame.timestamp_us` (`number` / `integer`): microsecond capture timestamp
  - `frame.len` (`integer`): byte length of the current payload
  - `frame.bridge` (`string?`): bridge ID if executing inside `on_mitm_frame`
  - `frame.hex` (`string`): lazy spaced uppercase hex string
- **Direct Zero-Offset Binary Accessors (0-based offsets matching Dissector/HexInspector)**:
  - Unsigned / Signed integers (bounds-checked; explicit `_le` / `_be`): `u8`, `i8`, `u16_le`, `u16_be`, `i16_le`, `i16_be`, `u32_le`, `u32_be`, `i32_le`, `i32_be`
  - Floats: `f32_le`, `f32_be`, `f64_le`, `f64_be`
  - Mutators: `set_u8`, `set_u16_le`, `set_u16_be`, `set_u32_le`, `set_u32_be`, `xor_u8`, `xor_bit(byte_off, bit_idx)`, `resize(new_len)`, `slice(off, len)`, `set_bytes(lua_binary_string_or_hex)`
  - Plus native **Lua 5.4** `string.pack` / `string.unpack` / `string.packsize` and native bitwise operators (`&`, `|`, `~`, `<<`, `>>`) — highlighted in UI templates so users get zero-overhead binary packing/unpacking without external bitop libraries.
- **Schema Dissection & Patching (Solving `D-94`)**:
  - `Session` passes `Arc<HashMap<String, DissectorIr>>` (keyed by `"schema:<StructName>"`, `"port:<port_id>"`, and `<StructName>`) plus any port's active `Pack` / `Dissector` into `ScriptRuntime`.
  - `frame:get(dotted_field_name)` / `frame:set(dotted_field_name, value)` — auto-binds to the frame's own port schema instead of the first schema globally (`D-94` fix).
  - `frame:dissect(tag)` — returns a bound `FrameView` using an arbitrary registered schema (`"EpsCommand"`, `"C_STRUCT:EpsCommand"`, `"port:eps_uart"`) on demand, allowing one MITM script to inspect multiple packet formats or nested headers cleanly (`specs/0034-script-fields.md:23, 77`).
  - `frame:fields()` — returns a table of decoded `{ name = value }` entries (for schema-agnostic inspection/plotting scripts).
- **Checksums & Verdicts**:
  - `frame:recalc_crc(algo [, start_off, end_off])` — folds pending `frame:set` changes first (`F-38` rule preserved), supports `crc8`, `crc16_ccitt_false`, `crc16_modbus`, `crc16_xmodem`, `crc32c` (and Tier 1 `[[crc_algorithms]]` once added), with optional custom range override.
  - `frame:corrupt_crc([mask_or_bytes])` — flips LSBs or inverts trailing checksum bytes for one-line error injection.
  - `frame:delay_ms(ms)` / `frame:drop()` / `frame:bytes()` (returns spaced hex) / `frame:raw()` (returns Lua binary string).

---

## 6. `bforge.*` Sandbox Standard Library & Safety Model

### 6.1 Host Functions Available in Lua
| Category | API | Purpose |
| :--- | :--- | :--- |
| **Hooks** | `bforge.on_init`, `on_frame`, `on_rx_frame`, `on_tx_frame`, `on_mitm_frame`, `on_raw_chunk`, `on_timer`, `on_alert`, `on_command`, `on_dissect` | Lifecycle, packet routing, timers, alerts, dissectors |
| **Active I/O** | `bforge.send(port, data, [{ delay_ms, origin }])` | Queue non-reentrant TX frames from RX/timer/alert handlers (`data` accepts hex string, binary string, or byte array) |
| **Hardware Pins** | `bforge.set_pins(port, dtr, rts)`<br>`bforge.pulse_pin(port, pin, ms)` | Drive or pulse `DTR` / `RTS` lines via the reader thread's existing `Pipeline::set_pins` (`PinJob`) |
| **Telemetry & UI** | `bforge.plot(series_name, val [, ts_us])`<br>`bforge.metric(key, val)`<br>`bforge.assert(cond, name)` | Stream synthetic series to Plot Forge/Oscilloscope, publish watch scalars, track pass/fail HIL assertions |
| **Logging** | `bforge.log(msg)`, `log_info`, `log_warn`, `log_error` | Rate-limited output routed into `LogRing` (`ActivityLogView` + Script Console + `.activity.jsonl`) |
| **Time & RNG** | `bforge.now_us()`, `bforge.now_ms()`, `bforge.seed(u64)`, `bforge.rand([min, max])` | Deterministic monotonic session clock and seeded xorshift64*/PCG32 PRNG for reproducible tests (no OS `os.time`/`math.random` wall-clock ambiguity) |
| **Codecs & CRC** | `bforge.hex(tbl_or_str)`, `bforge.unhex(str)`, `bforge.crc(algo, data)` | Fast Rust-backed hex formatting/parsing and standalone CRC calculation |

### 6.2 Five Mandatory Sandbox & Stability Guardrails
1. **Memory Limit (`lua.set_memory_limit`)**: Default `4 MiB` (`4 * 1024 * 1024`, configurable up to `16 MiB` max in workspace/plugin config) set at `Lua` creation time so table allocation bombs fail cleanly at allocation instead of stalling or crashing the host.
2. **Per-Call Instruction Budget & Microsecond Profiler**: Retain `INSTRUCTION_BUDGET = 200_000` (configurable for `on_init`/offline batch), resetting the counter before every hook call and recording `last_instructions`, `last_exec_us`, and `max_exec_us` so engineers can see immediately if a script approaches the `50 µs` inline budget.
3. **Anti-Feedback Loop Guard on `bforge.send`**:
   - Frames enqueued by `bforge.send(...)` carry `Origin::Script` and bypass `on_tx_frame` by default (opt-in `{ run_tx_hooks = true }` bounded by `MAX_REENTRY_DEPTH = 1`).
   - Enqueueing is capped at `MAX_SCRIPT_SENDS_PER_PUMP = 16` into `Session`'s non-blocking outbox so a buggy `on_rx_frame` cannot infinite-loop the TX ring.
4. **Rate-Limited Diagnostics into `LogRing`**: Token bucket (`50 msgs/sec`, burst `20`) routes script logs with `LogSource::Engine` / `"script:*"` event tags into `Shared.logs`, incrementing `logs_suppressed` if flooded instead of spamming stderr or locking the UI.
5. **Configurable Fault Policy (`FailOpen` vs `FailClosed`)**:
   - **Fail-Open (default)**: Matches current contract (`runtime.rs:150-152`) — errors forward original bytes untouched so a typo in a passive observer never drops live flight traffic.
   - **Fail-Closed (optional per-script)**: Drops mutated/MITM frames if a safety-critical script faults or times out, preventing invalid unpatched commands from reaching hardware.

---

## 7. Concrete Examples Across All Use Cases

### Example 1: MITM SEU Bit-Flip + Scope Trigger Pulse (`FR-SCR-01`)
```lua
bforge.seed(42)

bforge.on_mitm_frame("obc_to_eps", function(frame)
    local pkt = frame:dissect("EpsCommand")
    if pkt and pkt:get("cmd_id") == 0x04 then
        pkt:set("target_temp_c", pkt:get("target_temp_c") ~ 0x0010)
        pkt:recalc_crc("crc16_ccitt_false")
        bforge.pulse_pin("ftdi_aux", "RTS", 2) -- Pulse hardware pin for external logic trigger
        bforge.metric("seu_injected", (bforge.metric("seu_injected") or 0) + 1)
        return pkt:delay_ms(12)
    end
end)
```

### Example 2: Virtual Device Responder (`bforge.send`)
```lua
local rx_count = 0

bforge.on_rx_frame("fc_uart", function(frame)
    if frame:u8(0) == 0xAA and frame:u8(1) == 0x55 then
        local cmd = frame:u8(2)
        rx_count = rx_count + 1
        bforge.metric("ack_sent", rx_count)
        local ack = string.pack("<BBBBI2", 0xAA, 0x55, 0x80, cmd, rx_count & 0xFFFF)
        local c = bforge.crc("crc16_ccitt_false", ack)
        bforge.send("fc_uart", ack .. string.pack("<I2", c), { delay_ms = 3 })
    end
end)
```

### Example 3: Derived Telemetry Plotter + Closed-Loop Assertion
```lua
bforge.on_rx_frame("obc_telemetry", function(frame)
    local v_mv = frame:get("v_batt_mv")
    local i_ma = frame:get("i_batt_ma")
    if v_mv and i_ma then
        local watts = (v_mv * i_ma) / 1e6
        bforge.plot("power_w", watts, frame.timestamp_us)
        bforge.assert(v_mv >= 6400 and v_mv <= 8400, "v_batt_in_range")
    end
end)
```

---

## 8. Control Plane (`serve.rs`) & Workbench UI (**Script Lab**)

### 8.1 Engine HTTP Endpoints & Snapshot State
- **Extend `UiSnapshot` (`crates/bforge-core/src/contract.rs`)** with optional `script: Option<ScriptStatusView>`:
  - `armed: bool`, `name: String`, `hooks: Vec<String>`, `policy: "fail_open" | "fail_closed"`
  - Counters: `invocations`, `changed`, `dropped`, `delayed`, `injected_tx`, `failures`, `logs_suppressed`, `assertions_passed`, `assertions_failed`
  - Resource stats: `memory_bytes`, `memory_limit_bytes`, `last_exec_us`, `max_exec_us`, `last_instructions`, `last_error`
  - Live maps: `metrics: BTreeMap<String, f64 | String>`, `assertions: Vec<AssertionSummary>`
- **`POST /api/script` Actions**:
  - `compile` (`{ source, name }`): validates syntax and hook registrations without disturbing an armed session; returns discovered hooks + memory estimate.
  - `test_frame` (`{ source, name, port, direction, hex, custom_schema? }`): runs the script in an isolated temporary `ScriptRuntime` against any captured packet (or manual hex), returning `{ verdict, output_hex, delay_ms, field_diff, instructions, exec_us, logs, plots, emitted_sends, error }`.
  - `arm` (`{ source, name, policy, memory_limit_bytes, seed }`): swaps the live script atomically on the session pump loop (`ScriptJob`).
  - `disarm` (`{}`): detaches active runtime cleanly.
  - `reset_stats` (`{}`): zeroes counters and metrics without reloading VM state (or reloads via `arm`).
- **`GET /api/script`**: returns current script source/metadata + status snapshot so reconnecting or popout UI windows stay synchronized.

### 8.2 Workbench UI Integration (`ScriptLabView.tsx` or `FaultRigView.tsx` + Dockview)
Adding a dedicated **Script Lab** panel (or upgrading `FaultRigView.tsx` with `[FAULT PRIMITIVES | LUA SCRIPT LAB]` tabs alongside `BridgePanel` MITM status) makes scripting immediately usable without restarting CLI sessions:
1. **Starter Templates Toolbar**: One-click snippets for *(1) Bit-Flip / Bad CRC Fault*, *(2) Timed MITM Delay*, *(3) Virtual Auto-ACK Responder*, *(4) Derived `bforge.plot` Channel*, and *(5) Watchdog / Pin Reset Sequencer*.
2. **Code Editor & Arm Controls**: Compact monospace Lua editor with `COMPILE`, `DRY-RUN PACKET`, `ARM SCRIPT` / `DISARM` safety interlock, and `FAIL-OPEN` / `FAIL-CLOSED` selector.
3. **"Dry-Run on Selected Packet" Tester**: Pulls the packet currently selected in `PacketStreamView` / `HexInspector`, executes `/api/script` (`action: "test_frame"`), and displays side-by-side Before/After hex diff, decoded field changes, Verdict badge (`PASS` / `MUTATED` / `DELAY 12ms` / `DROP` / `BURST`), instruction count (`e.g., 1,420 / 200,000`), and execution time (`e.g., 8.4 µs`).
4. **Live Telemetry & Scoreboard Drawer**: Displays live `bforge.metric(...)` values, assertion pass/fail chips, VM memory bar (`e.g., 184 KiB / 4 MiB`), and script-filtered console entries from `LogRing`.

---

## 9. Phased Implementation Roadmap

### Wave 1 — `crates/bforge-script`: Core VM, `UserData`, & Safety Hardening
- Keep `mlua = "0.10"` (`lua54`) and maintain full backwards compatibility with `bforge.on_frame(fn)`.
- Replace per-frame `frame_table` + eager `hex_of` + per-read `exec::execute` with `LuaFrame` `mlua::UserData` featuring lazy hex, lazy single-pass decode cache, zero-offset binary accessors (`u8..f64`, `set_*`, `xor_bit`, `raw`), and `recalc_crc` across all built-in checksums.
- Add `lua.set_memory_limit(4 MiB)`, deterministic `seed`/`rand` + `now_us`/`now_ms`, instruction/timing instrumentation, expanded `FrameVerdict` (`Pass`/`Send`/`Delay`/`Drop`/`Burst`), and multi-hook registration (`on_init`, `on_rx_frame`, `on_tx_frame`, `on_mitm_frame`, `on_raw_chunk`, `on_timer`, `on_alert`).
- Implement `ScriptRuntime::dry_run(...)` returning structured diff, logs, plots, emitted sends, instructions, and execution latency.
- **Verification**: expand `crates/bforge-script` unit tests covering memory-limit OOM recovery, instruction-budget watchdog, multi-schema `frame:dissect`, lazy-cache correctness on `set` -> `get` -> `recalc_crc`, `Delay`/`Burst`, binary accessors, and deterministic PRNG.

### Wave 2 — `crates/bforge-core`: Framed Pipeline, MITM Bridge, Multi-Schema (`D-94`), & `/api/script`
- Move packet RX hook (`on_rx_frame`) directly post-`stream.feed(...)` while keeping optional `on_raw_chunk` pre-framer.
- Wire `on_mitm_frame` inside `Session::forward` (`session.rs:1522-1585`), routing `FrameVerdict::Delay` through `pipeline.post_after`.
- Build port/struct `Arc<HashMap<String, DissectorIr>>` in `Session` (`D-94` fix) and share it with `ScriptRuntime` for `frame:dissect(tag)` and per-port auto-binding.
- Drain `ScriptAction` side effects per pump (`send` non-reentrant outbox, `pulse_pin`, `plot` into `Session.series`, rate-limited `log` into `Shared.logs` `LogRing`), plus `AlertConfig` evaluation driving `on_alert`.
- Expose `GET/POST /api/script` and `UiSnapshot.script` in `serve.rs` + `contract.rs`.
- **Verification**: integration tests in `crates/bforge-core` proving post-framer split-chunk assembly before `on_rx_frame`, inline MITM mutation/delay between two bridged ports, multi-schema `frame:dissect`, anti-loop guard on `bforge.send`, and `/api/script` `test_frame` + live `arm`/`disarm`.

### Wave 3 — `ui/`: **Script Lab** Workbench & Packet Stream Dry-Run
- Extend `ui/src/services/engineApi.ts` and `useWorkstationStore.ts` for `/api/script` and `UiSnapshot.script`.
- Build `ScriptLabView.tsx` (registered in `WorkstationDock.tsx` + `GlobalRibbon.tsx`, or integrated tab in `FaultRigView.tsx`) with Lua templates, selected-packet dry-run diff tester, live `bforge.metric` watch table, assertions view, and VM latency/memory budget telemetry.
- Ensure headless smoke coverage (`ui/scripts/ui-smoke.mjs`) verifies template loading, compile/dry-run UI feedback, and clean rendering.

---

## 10. Implementation & Verification Record (2026-11-15)

### Resolved Design Decisions
- **UI Placement**: Standalone Dockview panel `scriptLab` (`ui/src/components/ScriptLabView.tsx`, title `LUA SCRIPT LAB`) placed in the Bottom Subdeck, paired with `OPEN IN SCRIPT LAB →` quick-launch buttons in `FaultRigView.tsx` and `BridgePanel.tsx`.
- **Default Fault Policy**: `FailOpen` (`"fail_open"`) across `TX`, `RX`, and `MITM` hooks (script errors increment `failures` and pass original bytes through), with an explicit UI selector for `FailClosed` (`"fail_closed"`, drops frames on error).
- **Offline Fallback Boundary**: `ScriptLabView.tsx` targets `/api/script` when the Rust engine is reachable and activates `ui/src/services/luaSandboxFallback.ts` (`SIMULATED SANDBOX` badge) strictly on network/5xx failures; HTTP 4xx compile/runtime errors from Rust are surfaced without masking.

### Implemented Files & Symbols

#### Wave 1 — `crates/bforge-script/`
- `crates/bforge-script/src/lib.rs`: Re-exports `FrameState`, `LuaFrame`, `CustomFieldEntry`, `crc16_modbus`, `FrameVerdict`, `FaultPolicy`, `HookKind`, `FrameMeta`, `ScriptAction`, `AssertionRecord`, `ScriptMetricValue`, `FieldDiffRecord`, `DryRunReport`, `ScriptSnapshot`, `DEFAULT_MEMORY_LIMIT_BYTES`, `MAX_MEMORY_LIMIT_BYTES`, `ScriptRuntime`, `ScriptError`, `hex_of`, and `parse_hex`.
- `crates/bforge-script/src/frame.rs`: Updated `FrameState` with `ir: Option<DissectorIr>`, `schemas: Arc<BTreeMap<String, DissectorIr>>`, `meta: FrameMeta`, lazy `decoded_cache: Option<Vec<bforge_dissect::DecodedField>>`, `custom_fields`, `drop_requested`, and `delay_ms`. Implemented `mlua::UserData` on `LuaFrame` (lazy `hex`, `port`, `direction`, `seq_id`, `timestamp_us`, `len`, `bridge`, `get`/`set`/`fields`/`dissect`/`add_field`, zero-offset bounds-checked `u8`..`f64` readers/writers, `slice`/`raw`/`clone_bytes`/`bytes`/`xor_u8`/`xor_bit`, `recalc_crc` supporting `crc8`/`crc8_atm`/`crc16_ccitt_false`/`crc16_modbus`/`crc16_xmodem`/`crc32c`, `corrupt_crc`, and `delay_ms`/`forward_after_ms`/`drop`).
- `crates/bforge-script/src/runtime.rs`: Implemented `FrameVerdict::{Send, Delay, Drop, Burst}`, `FaultPolicy`, `HookKind`, `DEFAULT_MEMORY_LIMIT_BYTES` (`4 MiB`), `MAX_MEMORY_LIMIT_BYTES` (`16 MiB`), `INSTRUCTION_BUDGET` (`200_000`), `HOOK_TICK` (`500`), `MAX_SENDS_PER_CALL` (`16`), `MAX_TIMERS` (`8`), `MIN_TIMER_INTERVAL_MS` (`10`), `LOG_BURST` (`20.0`), `LOG_RATE_PER_SEC` (`50.0`), multi-hooks (`on_frame`, `on_init`, `on_rx_frame`, `on_tx_frame`, `on_mitm_frame`, `on_raw_chunk`, `on_timer`, `on_alert`, `on_dissect`, `on_command`), deterministic xorshift64* `seed`/`rand`, monotonic `now_us`/`now_ms`, `send`, `set_pins`, `pulse_pin`, `trigger_pin`, `plot`, `metric`, `assert`, `crc`, `burst`, `compile_with_options`, `run_with_meta`, `tick_timers`, `trigger_alert`, `invoke_command`, `drain_actions`, `snapshot`, and `ScriptRuntime::dry_run` (retaining backward compatibility for `bforge.on_frame(fn)` without schema).

#### Wave 2 — `crates/bforge-core/`
- `crates/bforge-core/src/contract.rs`: Added `#[serde(default)] pub script: Option<ScriptStatusView>` on `UiSnapshot`, alongside `ScriptAssertionView`, `ScriptStatusView`, `ScriptFieldDiffView`, `ScriptActionView`, `ScriptBurstFrameView`, and `ScriptDryRunView`.
- `crates/bforge-core/src/series.rs`: Added `SeriesSet::push_custom` (max 32 series, max 600 samples, skips non-finite values) and unit test `push_custom_records_and_ignores_non_finite_values`.
- `crates/bforge-core/src/tail.rs`: Added `#[serde(skip)] pub raw: Vec<u8>` on `TailRow` and `Stream::redecode_row` to re-decode post-framer mutated frames.
- `crates/bforge-core/src/session.rs`: Added `rebuild_schema_map` (`D-94` multi-schema fix synced to script runtime), `HookKind::RawChunk` pre-framer and `HookKind::Rx` post-framer execution using `ScriptHooksMask` (preventing legacy TX `on_frame` scripts from firing on RX), `HookKind::Mitm` in `Session::forward` (`Drop`/`Send`/`Delay`/`Burst` via `pipeline.post_after`), TX `Delay`/`Burst`, non-reentrant `send_from_script` (`MAX_SCRIPT_SENDS_PER_PUMP = 16`), `tick_timers` + `apply_script_actions`, and `arm_script_source`/`disarm_script`/`reset_script_stats`/`script_status`/`script_source`/`dry_run_script`/`take_script_logs`.
- `crates/bforge-core/src/serve.rs`: Added `ScriptJob` pump handler, drained `script_logs` into `Shared.logs`, and added `GET /api/script` + `POST /api/script` (`compile`, `test_frame`, `arm`, `disarm`, `reset_stats`).
- `crates/bforge-core/tests/serve.rs`: Added `script_http_lifecycle_compile_dry_run_arm_reset_disarm_and_snapshot`, `framed_rx_hook_redecodes_and_emits_script_plot_series_over_sse`, and `mitm_bridge_and_tx_delay_hooks_work_end_to_end`.

#### Wave 3 — `ui/`
- **Created**:
  - [`docs/LUA_SCRIPTING_TUTORIAL.md`](./docs/LUA_SCRIPTING_TUTORIAL.md) (5-Part manual with Quick Reference Matrix and walkthroughs covering all 15 scripts in [`01_packet_filter_and_metadata.lua`](./examples/tutorials/01_packet_filter_and_metadata.lua)–[`15_fail_closed_safety_interlock_and_budget.lua`](./examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua))
  - `ui/src/utils/checksums.ts` (including `crc16Xmodem`)
  - `ui/src/services/luaSandboxFallback.ts` (`SCRIPT_TEMPLATES`: 5 starter templates `seu_bitflip`, `mitm_glitch`, `virtual_responder`, `telemetry_plot`, `watchdog_pins` plus `tutorial_01`–`tutorial_15`, `compileLuaScriptOffline`, `dryRunLuaScriptOffline`)
  - `ui/src/services/luaSandboxFallback.test.ts` (starter + `luaSandboxFallback.tutorialSeries01to15` dry-run suite)
  - `ui/src/services/engineApi.test.ts`
  - `ui/src/components/ScriptLabView.tsx` (grouped `<optgroup>` template selector for Starter Templates and Tutorial Series `01–15`)
- **Modified**:
  - `ui/src/types.ts`, `ui/src/components/CommandForge.tsx`, `ui/src/services/engineApi.ts` (`scriptTestFrame` fallback forwards frame metadata), `ui/src/plot/engine.ts` (`isStarted`, `pushScriptMetric`), `ui/src/store/useWorkstationStore.ts`, `ui/src/App.tsx`, `ui/src/store/useWorkstationStore.test.ts`
  - `ui/src/components/WorkstationDock.tsx` (`scriptLab` registered in `components`, `CANONICAL_DECK_ORDERS`, `PANEL_ORIGIN_HOMES`, `fallbacks`, `buildDefaultLayout`, `buildHilLayout`, `titles`), `ui/src/components/GlobalRibbon.tsx` (`PANEL_CATALOG`), `ui/src/components/FaultRigView.tsx` (`OPEN IN SCRIPT LAB →`), `ui/src/components/BridgePanel.tsx` (`OPEN IN SCRIPT LAB →`)
  - `ui/scripts/ui-smoke.mjs` (`T15`)

### Measured Verification, CI & Windows Artifacts
Committed and pushed on `main` at `d1c0122` (following architecture commit `51ddcf0`); GitHub Actions CI run `43721247956` passed **10/10 jobs**.
- **UI unit tests** (`Set-Location ui; pnpm test` via `vitest run`): **16 passed (16)** files, **187 passed (187)** tests.
- **UI typecheck & production build** (`Set-Location ui; pnpm exec tsc --noEmit; pnpm run build` during Wave B & CI `ui unit, build and headless smoke`): passed (`2114` modules; `dist/index.html` `1.51 kB`, `dist/assets/index-DbwjnwII.css` `209.60 kB`, `dist/assets/index-DHpNpOy1.js` `1,247.68 kB`).
- **Headless browser smoke gate** (`node scripts/smoke-gate.mjs` via `chrome-headless-shell`): **41/41 checks passed** (including `T15`: Lua 5.4 Script Lab opens, compiles template, and renders dry-run verdict & diffs).
- **Rust formatting, lint & workspace tests**:
  - `cargo fmt --all --check`: passed.
  - `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed (`0` warnings).
  - `cargo test --workspace --locked`: passed (`33` test summary lines: `targets=33 passed=401`, `0 failed`, `0 ignored`), including `bforge_script` (`35` unit tests covering `multi_form_api_overloads_work` and `all_fifteen_tutorial_scripts_compile_and_execute_cleanly`), `bforge_core` (`62` unit tests + `20` tests in `tests/serve.rs` + `9` in `tests/session.rs` including `wildcard_and_empty_port_actions_target_primary_port`), `bforge_dissect` (`76` + `38` + `27` + `15` + `6` + `4`), `bforge_cli` (`12 + 4 + 5`), and `bforge_storage` (`3 + 6 + 14`).
- **Downloaded Windows CI Binaries (`run 43721247956`)**:
  - Desktop bundle (`bforge-desktop-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\desktop-x86_64\bforge-desktop.exe` (`13,241,344` bytes + `ui/`), also copied to `target\release\bforge-desktop.exe` (+ `target\release\ui\`).
  - CLI (`bforge-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\cli-x86_64\bforge-windows-x86_64.exe` (`4,813,312` bytes, verified `bforge 0.8.0` via `--version`).
- **Not verified live**: Launching `bforge-desktop.exe` (WebView2 desktop GUI) against physical USB serial/CAN hardware executing live `/api/script` traffic.
