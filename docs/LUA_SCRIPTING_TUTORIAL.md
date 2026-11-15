# BaudForge Lua 5.4 Scripting Tutorial Manual

**Targets:** [`examples/tutorials/01_packet_filter_and_metadata.lua`](../examples/tutorials/01_packet_filter_and_metadata.lua) – [`15_fail_closed_safety_interlock_and_budget.lua`](../examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua)  
**Architecture Reference:** [`LUA_SCRIPTING_ENGINE.md`](../LUA_SCRIPTING_ENGINE.md) · [`crates/bforge-script/src/runtime.rs`](../crates/bforge-script/src/runtime.rs) · [`crates/bforge-script/src/frame.rs`](../crates/bforge-script/src/frame.rs) · [`ui/src/services/luaSandboxFallback.ts`](../ui/src/services/luaSandboxFallback.ts)

---

## Introduction

BaudForge embeds Lua 5.4 as a deterministic, bounded Hardware-in-the-Loop (HIL) and protocol scripting engine across RX streams, TX queues, inline MITM bridges, pre-framer byte slabs, periodic timers, watchdog alerts, and custom dissectors/commands. All 15 scripts in [`examples/tutorials/`](../examples/tutorials) form a progressive, self-contained curriculum verified in both the native Rust test suite and the Script Lab TypeScript simulator.

### Dual Execution Paths

1. **Native Rust `mlua` 5.4 Runtime (`crates/bforge-script` & `crates/bforge-core`)**
   - Executes inside the `bforge` engine (`bforge serve` / desktop WebView2 session) using vendored Lua 5.4 (`StdLib::{TABLE, STRING, MATH, UTF8}`, with `io`, `os`, `require`, `dofile`, `loadfile`, and `debug` stripped).
   - Enforces strict resource bounds: `DEFAULT_MEMORY_LIMIT_BYTES = 4 MiB` (`MAX_MEMORY_LIMIT_BYTES = 16 MiB`), `INSTRUCTION_BUDGET = 200,000` VM instructions per callback (`HOOK_TICK = 500`), `MAX_SENDS_PER_CALL = 16`, `MAX_TIMERS = 8`, `MIN_TIMER_INTERVAL_MS = 10`, and token-bucket log rate limiting (`LOG_BURST = 20`, `LOG_RATE_PER_SEC = 50 msg/s`).
   - Uses `DissectorIr` C-header/schema metadata for zero-copy single-pass field decoding (`frame:get`, `frame:set`, `frame:fields`, `frame:dissect`) and wires real serial/CAN hardware pins, timers, MITM bridges, and `POST /api/script`.

2. **Script Lab Offline TypeScript Sandbox (`ui/src/services/luaSandboxFallback.ts`)**
   - Activates automatically in **Simulated Mode** (or when `POST /api/script` is unreachable) so every starter template (`seu_bitflip`, `mitm_glitch`, `virtual_responder`, `telemetry_plot`, `watchdog_pins`) and all 15 tutorial templates (`tutorial_01`–`tutorial_15`) compile and dry-run in the browser with zero backend dependency.
   - Implements the same deterministic `xorshift64*` PRNG, 64-bit bitwise semantics, `string.pack` / `string.unpack`, zero-offset endian readers/writers, CRC helpers (`crc8_atm`, `crc16_ccitt_false`, `crc16_modbus`, `crc16_xmodem`, `crc32c`), `ImuPacket`/`EpsCommand` dissection, Watch metrics, Assertions, and Plot Forge series emission (`STEP_LIMIT = 20,000`).

> [!NOTE]
> **Live Rust vs. Offline Script Lab differences to keep in mind:**
> - **Verdict badges in Script Lab UI:** When a dry-run mutates frame bytes (`mutated == true`) without delaying or bursting (for example Tutorials `04`, `05`, `06`, `08`, `11`), the UI displays a **`MUTATED`** badge even though the JSON report `verdict` is `"send"`. When `verdict == "send"` and `mutated == false` (Tutorial `10`, which queues an out-of-band `bforge.send(...)` reply while passing the RX frame unchanged), the UI displays **`SEND`**.
> - **Secondary lifecycle hooks (`on_timer`, `on_alert`, `on_command`):** Tutorials `12`, `13`, and `14` register these non-frame hooks. In Script Lab, clicking **DRY-RUN PACKET** runs the primary frame callback (`on_dissect` in `12`, `on_rx_frame` in `13` and `14`); `on_timer`, `on_alert`, and `on_command` are compiled and validated in Script Lab, and execute on real timer ticks, alert trips, or Command Forge invocations inside the live Rust session (or via unit tests).
> - **Pre-loaded checksum bytes:** Script Lab's default `DEFAULT_TEST_FRAME_HEX` ends in `5B` (an intentional placeholder), whereas the Rust `ImuPacket` test fixture ends in `7C` (exact CRC-8/ATM of bytes `0..19`). Both are noted in each tutorial's *Try It in Script Lab* section.

---

### Quick Start

#### Option A: Script Lab UI (Interactive Workbench)

1. Open the **LUA SCRIPT LAB** panel (`WorkstationDock` Bottom Subdeck or **Scripts** navigation tab).
2. In the template selector (`[data-testid="script-template-select"]`), scroll to **Tutorial Series (01–15)** and select any script (`Tutorial 01: Packet Filter & Metadata` through `Tutorial 15: Fail-Closed Safety Interlock`).
3. To test specific hex bytes directly, tick **USE MANUAL HEX** above the bottom hex panel and paste the tutorial's test hex; otherwise Script Lab runs against the currently selected packet in Stream Monitor.
4. Select **FAIL-OPEN** or **FAIL-CLOSED** policy and adjust **SEED** if desired, then click **COMPILE** or **DRY-RUN PACKET** (`Ctrl+Enter`).
5. Inspect the header **Verdict** badge, **VM COST** counters, **DECODED FIELD DIFFS**, **WATCH METRICS & ASSERTIONS** tab, **ACTIONS** list (`send`, `plot`, `set_pins`, `pulse_pin`), and **CONSOLE LOGS**.
6. Click **ARM SCRIPT** to attach the script continuously to incoming Simulated Mode or live engine frames.

#### Option B: CLI & Workspace Config (`.bforge.toml`)

Reference any tutorial file directly under `[workspace]` in a TOML configuration (see [`examples/esp32-demo.bforge.toml`](../examples/esp32-demo.bforge.toml) and [`examples/loopback-demo.bforge.toml`](../examples/loopback-demo.bforge.toml)):

```toml
[workspace]
name = "hil-bench"
script_path = "examples/tutorials/07_mitm_directional_latency_glitch.lua"
# Optional dedicated RX hook file when splitting RX and TX scripts:
# rx_script_path = "examples/tutorials/01_packet_filter_and_metadata.lua"
```

Start the engine and point the UI/client at the workspace config:

```sh
bforge serve -c examples/esp32-demo.bforge.toml --addr 127.0.0.1:7717
```

When configured with `[[bridges]]` (for inline MITM scripts `07`–`08`) and `[[alerts]]` named `dead_man_timer` (for alert recovery script `14`), `bforge` dispatches `on_mitm_frame`, `on_timer`, and `on_alert` directly against live transport hardware.

---

### Reference Schemas & Test Hex Frames

All tutorials operate cleanly on the two reference C-struct schemas defined in [`crates/bforge-dissect/tests/fixtures/imu_packet.h`](../crates/bforge-dissect/tests/fixtures/imu_packet.h):

| Schema | Length | Field Layout (`0`-indexed byte offsets) | Checksum |
| :--- | :--- | :--- | :--- |
| **`ImuPacket`** | 19 B (+ 1 B CRC = 20 B) | `0..2`: `sync` (`uint16` `0xAA 0x55`) · `2`: `version` (`uint8`) · `3`: `flags:3` / `channel:5` · `4..8`: `timestamp_us` (`uint32_le`) · `8..10`: `v_batt_mv` (`uint16_be`) · `10..14`: `gyro_z` (`float32_le`) · `14..18`: `samples[4]` (`uint8[4]`) · `18`: `mode` (`uint8`) · `19`: `checksum` (`uint8`) | `crc8_atm` over `0..19` |
| **`EpsCommand`** | 7 B (+ 2 B CRC = 9 B) | `0..2`: `sync` (`uint16` `0xAA 0x55`) · `2`: `opcode` (`uint8`) · `3..7`: `hold_time_s` (`uint32_le`) · `7..9`: `checksum` (`uint16_le`) | `crc16_ccitt_false` over `0..7` |

Copy-pasteable test vectors used throughout this manual:

- **Valid CRC-8 `ImuPacket` (20 B):**  
  `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`  
  (`version = 1`, `flags = 3`, `channel = 2`, `timestamp_us = 123456`, `v_batt_mv = 8180`, `gyro_z = 0.0`, `samples = [0x80, 0x90, 0xA0, 0xB0]`, `mode = 1`, `crc8_atm = 0x7C`)
- **Script Lab Default `ImuPacket` (20 B, placeholder CRC `0x5B`):**  
  `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 5B`
- **Valid CRC-16 `EpsCommand` (9 B):**  
  `AA 55 04 0A 00 00 00 B7 15`  
  (`opcode = 4`, `hold_time_s = 10`, `crc16_ccitt_false = 0x15B7` LE)
- **Malformed Short Frame (3 B):**  
  `FF 01 02`

---

## Quick Reference Matrix

| # | Script | Part | Registered Hooks | `LuaFrame` APIs | `bforge.*` & Lua 5.4 APIs | Checksums / Verdicts |
| :---: | :--- | :---: | :--- | :--- | :--- | :--- |
| **01** | [`01_packet_filter_and_metadata.lua`](../examples/tutorials/01_packet_filter_and_metadata.lua) | I | `on_rx_frame("*")` | `.port`, `.direction`, `.seq_id`, `.timestamp_us`, `.len`, `.hex`, `:u8`, `:drop` | `metric`, `log_warn`, `string.format` | `Pass`, `Drop` |
| **02** | [`02_schema_assertions_and_logging.lua`](../examples/tutorials/02_schema_assertions_and_logging.lua) | I | `on_rx_frame("*")` | `:get`, `:fields` | `assert` (both overloads), `metric`, `log_info`/`warn`/`error`, `math.floor` | `Pass` (+ assertion counts) |
| **03** | [`03_derived_telemetry_plotting.lua`](../examples/tutorials/03_derived_telemetry_plotting.lua) | I | `on_rx_frame("*")` | `.timestamp_us`, `.len`, `:get`, `:u16_be`, `:u8` | `plot(s, v, ts)`, `metric` | `Pass` (3 Plot series) |
| **04** | [`04_field_patching_and_crc8.lua`](../examples/tutorials/04_field_patching_and_crc8.lua) | II | `on_tx_frame("*")` | `.len`, `:get`, `:set`, `:recalc_crc` | `metric` | `crc8`, `Send` (`MUTATED`) |
| **05** | [`05_zero_offset_binary_surgery.lua`](../examples/tutorials/05_zero_offset_binary_surgery.lua) | II | `on_tx_frame("*")` | `.len`, `:u16_le`, `:u16_be`, `:u8`, `:u32_le`, `:i16_be`, `:f32_be`, `:slice`, `:set_u8`, `:set_u32_le`, `:set_u16_be`, `:recalc_crc` | `hex`, `metric`, `log_warn`, `&`, `math.max` | `crc8`, `Send` (`MUTATED`) |
| **06** | [`06_deterministic_seu_bitflip_fuzzer.lua`](../examples/tutorials/06_deterministic_seu_bitflip_fuzzer.lua) | II | `on_init`, `on_rx_frame("*")` | `.len`, `:xor_bit`, `:xor_u8`, `:corrupt_crc` | `seed`, `rand`, `metric`, `log_info`, `tostring` | Corrupted CRC, `Send` (`MUTATED`) |
| **07** | [`07_mitm_directional_latency_glitch.lua`](../examples/tutorials/07_mitm_directional_latency_glitch.lua) | III | `on_mitm_frame("*")` | `.bridge`, `.direction`, `.len`, `:get`, `:set`, `:u16_be`, `:set_u16_be`, `:recalc_crc`, `:delay_ms` | `metric` (get & set), `math.max` | `crc8`, `Delay` (`DELAYED 45 ms`), `Pass` |
| **08** | [`08_multi_schema_dynamic_dissect.lua`](../examples/tutorials/08_multi_schema_dynamic_dissect.lua) | III | `on_mitm_frame("*")` | `.len`, `:dissect`, `:get`, `:set`, `:recalc_crc` | `metric`, `&` | `crc8`, `crc16_ccitt_false`, `Send` (`MUTATED`) |
| **09** | [`09_packet_burst_duplication_and_split.lua`](../examples/tutorials/09_packet_burst_duplication_and_split.lua) | III | `on_tx_frame("*")` | `:clone_bytes`, `:slice` | `unhex`, `hex`, `burst`, `metric`, `#`, `~`, `math.floor` | `Burst` (`BURST (4)`) |
| **10** | [`10_virtual_device_auto_responder.lua`](../examples/tutorials/10_virtual_device_auto_responder.lua) | IV | `on_rx_frame("*")` | `.len`, `.port`, `:raw` | `string.unpack`, `string.pack`, `crc`, `send`, `metric`, `..`, `&`, `|`, `<<`, `>>` | `crc16_modbus`, `Send` (`SEND` action) |
| **11** | [`11_raw_chunk_pre_framer_corruptor.lua`](../examples/tutorials/11_raw_chunk_pre_framer_corruptor.lua) | IV | `on_raw_chunk("*")` | `.len`, `:raw`, `:set_bytes`, `:resize` | `string.pack`, `..`, `metric`, `%`, `math.floor` | Pre-framer `Send` (`MUTATED`) |
| **12** | [`12_custom_dissector_and_command_builder.lua`](../examples/tutorials/12_custom_dissector_and_command_builder.lua) | IV | `on_dissect("*")`, `on_command("set_heater")` | `.len`, `:u16_be`, `:u8`, `:slice`, `:add_field` | `crc`, `metric` (get & set), `string.pack`, `string.format`, `tonumber`, `&` | `crc8`, `crc16_xmodem`, `Pass` / command bytes |
| **13** | [`13_periodic_timer_poller_and_jitter.lua`](../examples/tutorials/13_periodic_timer_poller_and_jitter.lua) | V | `on_timer(100)`, `on_rx_frame("*")` | `.timestamp_us` | `now_ms`, `now_us`, `send`, `crc`, `plot`, `metric`, `string.pack`, `math.abs` | `crc8`, `Pass` / `Send` action |
| **14** | [`14_hardware_pin_reset_and_alert_handler.lua`](../examples/tutorials/14_hardware_pin_reset_and_alert_handler.lua) | V | `on_alert("dead_man_timer")`, `on_rx_frame("*")` | `.seq_id` | `set_pins`, `pulse_pin`, `trigger_pin`, `metric`, `log_warn` | `Pass` + `SetPins` / `PulsePin` actions |
| **15** | [`15_fail_closed_safety_interlock_and_budget.lua`](../examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua) | V | `on_tx_frame("*")` | `.len`, `:get`, `:u16_be`, `:u8`, `:drop` | `assert`, `metric`, `log_error`, short-circuit `and`/`or` | `Pass`, `Drop` (`FailClosed` safe) |

---

## Part I — Telemetry Inspection, Filtering & Plotting (Tutorials 01–03)

### Tutorial 01: Packet Filter & Frame Metadata

**Source:** [`examples/tutorials/01_packet_filter_and_metadata.lua`](../examples/tutorials/01_packet_filter_and_metadata.lua)  
**Template ID:** `tutorial_01`

#### Concepts & Capabilities Covered
- Wildcard RX hook registration via `bforge.on_rx_frame("*", fn(frame, dir))`.
- Zero-allocation `LuaFrame` metadata getters: `frame.port`, `frame.direction`, `frame.seq_id`, `frame.timestamp_us`, `frame.len`, and lazy on-demand `frame.hex`.
- Selective packet dropping with `frame:drop()` and Watch scalar export via `bforge.metric`.

#### Hardware / Protocol Scenario
On a noisy bench UART or RS-485 bus, transceiver turn-around glitches and power-on transients inject short stray bytes ahead of valid telemetry packets. Dropping malformed frames before downstream logging and plotting keeps Plot Forge clean without altering valid payloads or formatting hex strings for healthy traffic.

#### Complete Annotated Lua Script

```lua
-- Tutorial 01: Packet Filter & Frame Metadata
-- Concepts:
--   * bforge.on_rx_frame("*", fn) wildcard RX hook
--   * LuaFrame metadata: port, direction, seq_id, timestamp_us, len, lazy hex
--   * Selective dropping with frame:drop() and scalar tracking with bforge.metric
--
-- Compatible with ImuPacket frames (sync AA 55 at bytes 0..2, 19+ bytes) and raw test frames.

local seen = 0
local passed = 0
local dropped = 0

bforge.on_rx_frame("*", function(frame, dir)
  seen = seen + 1

  -- Inspect metadata exposed directly by LuaFrame without touching payload bytes yet.
  bforge.metric("rx_seen", seen)
  bforge.metric("last_port", frame.port)
  bforge.metric("last_direction", dir or frame.direction)
  bforge.metric("last_seq_id", frame.seq_id)
  bforge.metric("last_timestamp_us", frame.timestamp_us)
  bforge.metric("last_len", frame.len)

  -- Drop truncated frames or frames lacking the 0xAA 0x55 sync preamble.
  if frame.len < 4 or frame:u8(0) ~= 0xAA or frame:u8(1) ~= 0x55 then
    dropped = dropped + 1
    bforge.metric("rx_dropped", dropped)
    -- frame.hex is lazily formatted only when read here.
    bforge.metric("last_dropped_hex", frame.hex)
    bforge.log_warn(string.format("dropped frame seq=%d (%d B): %s", frame.seq_id, frame.len, frame.hex))
    return frame:drop()
  end

  passed = passed + 1
  bforge.metric("rx_passed", passed)
  return frame
end)
```

#### How It Works
1. Lines `9–11` declare persistent Lua upvalues (`seen`, `passed`, `dropped`) retained across frames inside the VM.
2. Line `13` registers an `on_rx_frame` hook targeting `"*"` (every port). Every invocation increments `seen` and exports six frame metadata scalars via `bforge.metric(...)`. Note that `frame.hex` is *not* touched yet, avoiding string allocation on the fast path.
3. Line `25` checks `frame.len < 4` first; Lua's short-circuit `or` prevents `frame:u8(0)` / `frame:u8(1)` from indexing past the end of short frames. Any packet missing the `0xAA 0x55` sync preamble enters the reject branch, formats `frame.hex` lazily for `last_dropped_hex` and `bforge.log_warn`, and returns `frame:drop()`.
4. Healthy frames reach line `34`, increment `rx_passed`, and return `frame` unmodified.

#### Try It in Script Lab
- **Case A (Valid Frame):** Paste `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (or use `DEFAULT_TEST_FRAME_HEX`) and click **DRY-RUN PACKET**.
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `mutated = false`).
  - **Field Diffs:** None.
  - **Watch Metrics:** `rx_seen = "1"`, `rx_passed = "1"`, `last_port = "COM8"`, `last_direction = "rx"`, `last_len = "20"`, `last_seq_id`, `last_timestamp_us`.
  - **Logs / Actions:** None.
- **Case B (Malformed Short Frame):** Enable **USE MANUAL HEX**, enter `FF 01 02`, and click **DRY-RUN PACKET**.
  - **Verdict badge:** `DROPPED` (`verdict = "drop"`, empty output hex).
  - **Watch Metrics:** `rx_seen = "1"`, `rx_dropped = "1"`, `last_len = "3"`, `last_dropped_hex = "FF 01 02"`.
  - **Console Logs:** `warn`: `dropped frame seq=... (3 B): FF 01 02`.

---

### Tutorial 02: Schema Assertions & Rate-Limited Logging

**Source:** [`examples/tutorials/02_schema_assertions_and_logging.lua`](../examples/tutorials/02_schema_assertions_and_logging.lua)  
**Template ID:** `tutorial_02`

#### Concepts & Capabilities Covered
- Lazy single-pass schema reading via `frame:get("v_batt_mv")` and bulk map export via `frame:fields()`.
- Continuous assertion tracking supporting both `bforge.assert(cond, label)` and `bforge.assert(label, cond, msg)`.
- Token-bucket rate-limited logging via `bforge.log_info`, `bforge.log_warn`, and `bforge.log_error`.

#### Hardware / Protocol Scenario
During battery discharge and mode-transition burn-in tests, engineers need automated pass/fail counters (`v_batt_nominal` within `6000..9000 mV`, `mode_valid` within `0..2`) alongside thresholded console diagnostics without flooding the log ring at high packet rates.

#### Complete Annotated Lua Script

```lua
-- Tutorial 02: Schema Assertions & Rate-Limited Logging
-- Concepts:
--   * Lazy single-pass schema reads via frame:get(...) and frame:fields()
--   * Continuous pass/fail tracking with bforge.assert
--   * Rate-limited logging via bforge.log_info / bforge.log_warn / bforge.log_error
--
-- Expects an ImuPacket schema bound to the port (or Script Lab's default ImuPacket).

bforge.on_rx_frame("*", function(frame)
  local v_batt = frame:get("v_batt_mv")
  local all = frame:fields()

  local has_schema = bforge.assert(v_batt ~= nil, "has_v_batt_mv")
  if not has_schema then
    bforge.log_warn("no ImuPacket schema bound; skipping typed assertions")
    return frame
  end

  local mode = math.floor(all.mode or 0)
  local channel = math.floor(all.channel or 0)

  bforge.assert(v_batt >= 6000 and v_batt <= 9000, "v_batt_nominal")
  bforge.assert("mode_valid", mode <= 2, "operating mode outside 0..2")

  bforge.metric("last_v_batt_mv", v_batt)
  bforge.metric("last_channel", channel)

  if v_batt < 6500 then
    bforge.log_error(string.format("battery critical: %d mV (mode=%d)", math.floor(v_batt), mode))
  elseif v_batt < 7200 then
    bforge.log_warn(string.format("battery low: %d mV (mode=%d)", math.floor(v_batt), mode))
  else
    bforge.log_info(string.format("telemetry nominal: %d mV, ch=%d, mode=%d", math.floor(v_batt), channel, mode))
  end

  return frame
end)
```

#### How It Works
1. Line `10` reads `"v_batt_mv"` and line `11` retrieves the full decoded field table via `frame:fields()`. In Rust, `FrameState` caches decoded fields across calls on the same frame so subsequent lookups do not re-run the dissector.
2. Line `13` checks `v_batt ~= nil` with the 2-argument `(cond, label)` form of `bforge.assert`. If no schema covers the frame, it logs a warning and returns early so raw frames do not raise runtime errors.
3. Lines `19–20` read `all.mode` and `all.channel`, clamping missing keys with `or 0`.
4. Lines `22–23` demonstrate both `bforge.assert` argument orders: `(cond, label)` for `v_batt_nominal` and `(label, cond, msg)` for `mode_valid`.
5. Lines `28–34` classify battery health into `error` (`< 6500 mV`), `warn` (`< 7200 mV`), or `info` (`>= 7200 mV`). The native `LogRing` limiter ensures bursts cannot starve the pump loop.

#### Try It in Script Lab
- **Case A (Nominal Telemetry):** Run with `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (or `DEFAULT_TEST_FRAME_HEX`).
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `mutated = false`).
  - **Assertions (Watch tab):** All 3 assertions show `passed: 1, failed: 0` (`has_v_batt_mv`, `v_batt_nominal`, `mode_valid`).
  - **Watch Metrics:** `last_v_batt_mv = "8180"`, `last_channel = "2"`.
  - **Console Logs:** `info`: `telemetry nominal: 8180 mV, ch=2, mode=1`.
- **Case B (Critical Voltage Fault):** Change bytes `8..9` (`1F F4` = `8180 mV`) to `15 7C` (`5500 mV`): `AA 55 01 13 40 E2 01 00 15 7C 00 00 00 00 80 90 A0 B0 01 7C`.
  - **Assertions:** `v_batt_nominal` reports `failed: 1` while `has_v_batt_mv` and `mode_valid` pass.
  - **Console Logs:** `error`: `battery critical: 5500 mV (mode=1)`.

---

### Tutorial 03: Derived Telemetry Plotting (EMA & Peak-to-Peak)

**Source:** [`examples/tutorials/03_derived_telemetry_plotting.lua`](../examples/tutorials/03_derived_telemetry_plotting.lua)  
**Template ID:** `tutorial_03`

#### Concepts & Capabilities Covered
- Streaming derived time-series curves into Plot Forge via `bforge.plot(series, value, frame.timestamp_us)`.
- Maintaining stateful signal-processing accumulators (Exponential Moving Average and running peak-to-peak envelope) across packets.
- Schema-first reading (`frame:get`) with raw binary fallback (`frame:u16_be(8)` / `frame:u8(0)`).

#### Hardware / Protocol Scenario
Raw battery bus telemetry contains switching-regulator ripple. Firmware engineers want a real-time smoothed voltage trace (`v_batt_ema_mv`, $\alpha = 0.25$) overlaid alongside instantaneous `v_batt_raw_mv` and cumulative ripple envelope `v_batt_p2p_mv` in Plot Forge without recompiling any C or Rust decoder.

#### Complete Annotated Lua Script

```lua
-- Tutorial 03: Derived Telemetry Plotting (EMA & Peak-to-Peak)
-- Concepts:
--   * Streaming live derived curves via bforge.plot(series, value, frame.timestamp_us)
--   * Stateful Lua exponential moving average (EMA) and peak-to-peak tracking across frames
--   * Watch scalar export with bforge.metric
--
-- Reads v_batt_mv via schema when bound, or falls back to big-endian uint16 at offset 8.

local ALPHA = 0.25
local samples = 0
local ema_mv = nil
local min_mv = nil
local max_mv = nil

bforge.on_rx_frame("*", function(frame)
  local v_batt = frame:get("v_batt_mv")
  if v_batt == nil then
    if frame.len >= 10 then
      v_batt = frame:u16_be(8)
    else
      v_batt = frame:u8(0)
    end
  end

  samples = samples + 1
  if ema_mv == nil then
    ema_mv = v_batt
  else
    ema_mv = ALPHA * v_batt + (1.0 - ALPHA) * ema_mv
  end

  if min_mv == nil or v_batt < min_mv then
    min_mv = v_batt
  end
  if max_mv == nil or v_batt > max_mv then
    max_mv = v_batt
  end

  local p2p_mv = max_mv - min_mv

  bforge.plot("v_batt_raw_mv", v_batt, frame.timestamp_us)
  bforge.plot("v_batt_ema_mv", ema_mv, frame.timestamp_us)
  bforge.plot("v_batt_p2p_mv", p2p_mv, frame.timestamp_us)

  bforge.metric("samples", samples)
  bforge.metric("v_batt_ema_mv", ema_mv)
  bforge.metric("v_batt_p2p_mv", p2p_mv)

  return frame
end)
```

#### How It Works
1. Lines `9–13` initialize `ALPHA = 0.25`, `samples = 0`, and `nil` tracking bounds so the first frame seeds `ema_mv`, `min_mv`, and `max_mv` without artificial zero bias.
2. Lines `16–23` attempt `frame:get("v_batt_mv")`; if the port has no schema bound, they gracefully fall back to reading a big-endian 16-bit unsigned integer at offset `8` (`frame:u16_be(8)`), or `frame:u8(0)` for tiny test buffers.
3. Lines `25–39` update the IIR smoothing filter ($y_n = 0.25 x_n + 0.75 y_{n-1}$) and track `max_mv - min_mv`.
4. Lines `41–43` push all three series timestamped by `frame.timestamp_us` (`SeriesSet::push_custom` creates `script:<series>` traces in the live engine and `usePlotStore` streams them in Simulated Mode).

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (or `DEFAULT_TEST_FRAME_HEX`).
- **Verdict badge (single Dry-Run):** `PASS` (`verdict = "pass"`, `mutated = false`).
- **Watch Metrics:** `samples = "1"`, `v_batt_ema_mv = "8180"`, `v_batt_p2p_mv = "0"`.
- **Actions:** Three `plot` actions emitted for `v_batt_raw_mv` (`8180`), `v_batt_ema_mv` (`8180`), and `v_batt_p2p_mv` (`0`). When **ARMED** over frames carrying `[8000, 8400, 8200]` mV, `v_batt_p2p_mv` converges to `"400"`.

---

## Part II — Protocol Patching, Binary Surgery & Fault Injection (Tutorials 04–06)

### Tutorial 04: Named Field Patching & Trailing CRC-8 Recalculation

**Source:** [`examples/tutorials/04_field_patching_and_crc8.lua`](../examples/tutorials/04_field_patching_and_crc8.lua)  
**Template ID:** `tutorial_04`

#### Concepts & Capabilities Covered
- Outgoing TX pipeline interception with `bforge.on_tx_frame("*", fn(frame))`.
- Typed field modification via `frame:set("v_batt_mv", bumped)` without manual byte-offset math.
- Automatic trailing CRC-8/ATM repair via `frame:recalc_crc("crc8")`.

#### Hardware / Protocol Scenario
You want to simulate a +100 mV over-voltage charging event on outgoing flight-computer TX telemetry frames while keeping the trailing CRC-8 valid so the receiving subsystem accepts the modified packet cleanly.

#### Complete Annotated Lua Script

```lua
-- Tutorial 04: Named Field Patching & Trailing CRC-8 Recalculation
-- Concepts:
--   * Outgoing TX interception via bforge.on_tx_frame
--   * Schema-driven field mutation with frame:set("v_batt_mv", ...)
--   * Trailing checksum update via frame:recalc_crc("crc8")
--
-- Designed for 20-byte ImuPacket frames (19-byte ImuPacket + 1-byte CRC-8/ATM).

bforge.on_tx_frame("*", function(frame)
  local v_batt = frame:get("v_batt_mv")
  if v_batt ~= nil then
    local bumped = v_batt + 100
    frame:set("v_batt_mv", bumped)
    bforge.metric("patched_v_batt_mv", bumped)
    -- Only overwrite the trailing CRC byte when the frame includes the 20th CRC byte.
    if frame.len >= 20 then
      frame:recalc_crc("crc8")
    end
  elseif frame.len >= 2 then
    frame:recalc_crc("crc8")
  end

  return frame
end)
```

#### How It Works
1. `bforge.on_tx_frame` attaches exclusively to the TX path (`ScriptHooksMask::TX`), so RX traffic never enters this hook.
2. `frame:get("v_batt_mv")` reads `8180`, line `12` computes `8280`, and `frame:set("v_batt_mv", 8280)` re-encodes bytes `8..9` as big-endian `0x20 0x58`.
3. When `frame.len >= 20`, `frame:recalc_crc("crc8")` computes CRC-8/ATM (poly `0x07`, init `0x00`) over bytes `0..19` and writes byte `19` (`0x86`). For 19-byte schema-only frames without a trailing CRC byte, it avoids overwriting `mode`.

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
- **Verdict badge:** `MUTATED` (`verdict = "send"`, `mutated = true`).
- **Output hex:** `AA 55 01 13 40 E2 01 00 20 58 00 00 00 00 80 90 A0 B0 01 86`.
- **Decoded Field Diffs:** `v_batt_mv`: `8180 -> 8280`; `checksum`: `0x7C -> 0x86` (or `0x5B -> 0x86` on `DEFAULT_TEST_FRAME_HEX`).
- **Watch Metrics:** `patched_v_batt_mv = "8280"`.

---

### Tutorial 05: Zero-Offset Binary Surgery (No Schema Required)

**Source:** [`examples/tutorials/05_zero_offset_binary_surgery.lua`](../examples/tutorials/05_zero_offset_binary_surgery.lua)  
**Template ID:** `tutorial_05`

#### Concepts & Capabilities Covered
- Schema-free 0-based endian readers (`u8`, `u16_le`, `u16_be`, `i16_be`, `u32_le`, `f32_be`).
- Schema-free 0-based endian writers (`set_u8`, `set_u16_be`, `set_u32_le`) combined with 64-bit bitwise masking (`& 0xFF`, `& 0xFFFFFFFF`).
- Arbitrary sub-slice extraction via `frame:slice(14, 4)` + `bforge.hex(...)`.

#### Hardware / Protocol Scenario
When reversing an undocumented proprietary binary frame or working before a C header `.h` dissector is authored, you often mix little-endian timestamps, big-endian ADC readings, and IEEE-754 floats in the same packet. Zero-offset accessors manipulate wire bytes directly without needing any `DissectorIr`.

#### Complete Annotated Lua Script

```lua
-- Tutorial 05: Zero-Offset Binary Surgery (No Schema Required)
-- Concepts:
--   * 0-based endian readers: u8, u16_le, u16_be, i16_be, f32_be
--   * 0-based endian writers: set_u8, set_u16_be, set_u32_le
--   * Raw byte slicing with frame:slice, bforge.hex, and frame:recalc_crc("crc8")
--
-- Byte offsets match ImuPacket + trailing CRC-8 (20 bytes total):
--   0..2 sync, 2 version, 4..8 timestamp_us (LE), 8..10 v_batt_mv (BE),
--   10..14 gyro_z, 14..18 samples[4], 18 mode, 19 crc8.

bforge.on_tx_frame("*", function(frame)
  if frame.len < 20 then
    bforge.log_warn(string.format("expected >=20 bytes for ImuPacket+CRC8, got %d", frame.len))
    return frame
  end

  local sync_le = frame:u16_le(0)
  local sync_be = frame:u16_be(0)
  local version = frame:u8(2)
  local ts_le = frame:u32_le(4)
  local batt_u16 = frame:u16_be(8)
  local batt_i16 = frame:i16_be(8)
  local word_f32_be = frame:f32_be(10)
  local samples_hex = bforge.hex(frame:slice(14, 4))

  bforge.metric("sync_le", sync_le)
  bforge.metric("sync_be", sync_be)
  bforge.metric("batt_i16_be", batt_i16)
  bforge.metric("f32_be_probe", word_f32_be)
  bforge.metric("samples_hex", samples_hex)

  local next_batt = math.max(0, batt_u16 - 50)
  frame:set_u8(2, (version + 1) & 0xFF)
  frame:set_u32_le(4, (ts_le + 1000) & 0xFFFFFFFF)
  frame:set_u16_be(8, next_batt)
  frame:recalc_crc("crc8")

  bforge.metric("patched_batt_mv", next_batt)
  return frame
end)
```

#### How It Works
1. Lines `17–24` showcase reading the same sync bytes (`AA 55`) in opposite byte orders (`u16_le(0) = 21930` vs. `u16_be(0) = 43605`), reading LE `u32` timestamp `123456` at offset `4`, BE `u16`/`i16` voltage `8180` at offset `8`, BE `f32` at offset `10`, and slicing `4` sample bytes starting at offset `14` (`"80 90 A0 B0"`).
2. Lines `32–35` bump `version` (`1 -> 2`), advance `timestamp_us` by `+1000` us (`123456 -> 124456`), and step `v_batt_mv` down by `50 mV` (`8180 -> 8130`), safely wrapping unsigned values with `&`.
3. Line `36` recalculates the trailing CRC-8 (`0xC7`).

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
- **Verdict badge:** `MUTATED` (`verdict = "send"`, `mutated = true`).
- **Output hex:** `AA 55 02 13 28 E6 01 00 1F C2 00 00 00 00 80 90 A0 B0 01 C7`.
- **Decoded Field Diffs:** `version: 1 -> 2`, `timestamp_us: 123456 -> 124456`, `v_batt_mv: 8180 -> 8130`, `checksum: 0x7C -> 0xC7`.
- **Watch Metrics:** `sync_le = "21930"`, `sync_be = "43605"`, `batt_i16_be = "8180"`, `f32_be_probe = "0"`, `samples_hex = "80 90 A0 B0"`, `patched_batt_mv = "8130"`.

---

### Tutorial 06: Deterministic Single-Event Upset (SEU) Bit-Flip Fuzzer

**Source:** [`examples/tutorials/06_deterministic_seu_bitflip_fuzzer.lua`](../examples/tutorials/06_deterministic_seu_bitflip_fuzzer.lua)  
**Template ID:** `tutorial_06`

#### Concepts & Capabilities Covered
- One-time initialization lifecycle hook `bforge.on_init(function(ctx) ... end)`.
- Deterministic 64-bit `xorshift64*` PRNG via `bforge.seed(42)` and bounded integer sampling `bforge.rand(min, max)`.
- Multi-mode fault injection with `frame:xor_bit(off, bit)`, `frame:xor_u8(off, mask)`, and `frame:corrupt_crc(1)`.

#### Hardware / Protocol Scenario
Spacecraft and safety-critical avionics links must verify that receiver ECC/CRC error-detection paths catch corrupted frames reproducibly. Seeding the VM in `on_init` guarantees that every test replay produces the exact same sequence of bit flips and byte masks across machines.

#### Complete Annotated Lua Script

```lua
-- Tutorial 06: Deterministic Single-Event Upset (SEU) Bit-Flip Fuzzer
-- Concepts:
--   * Initialization lifecycle hook bforge.on_init
--   * Deterministic xorshift64* PRNG via bforge.seed(42) and bforge.rand(min, max)
--   * Fault injection via frame:xor_bit, frame:xor_u8, and frame:corrupt_crc(1)

local seu_events = 0

bforge.on_init(function(ctx)
  bforge.seed(42)
  bforge.metric("fuzzer_seed", 42)
  bforge.log_info("SEU fuzzer armed on " .. tostring(ctx.script))
end)

bforge.on_rx_frame("*", function(frame)
  if frame.len == 0 then
    return frame
  end

  seu_events = seu_events + 1
  local max_payload = math.max(0, frame.len - 2)
  local bit_off = bforge.rand(0, max_payload)
  local bit_idx = bforge.rand(0, 7)
  local byte_mask = bforge.rand(1, 15)

  -- Flip a reproducible single bit inside the payload.
  frame:xor_bit(bit_off, bit_idx)

  -- Flip a reproducible bit-mask in a neighboring payload byte when room permits.
  if frame.len >= 3 then
    local byte_off = (bit_off + 1) % (frame.len - 1)
    frame:xor_u8(byte_off, byte_mask)
    bforge.metric("last_xor_u8_offset", byte_off)
  end

  -- Intentionally corrupt the trailing CRC byte so receiver error handling is exercised.
  if frame.len >= 2 then
    frame:corrupt_crc(1)
  end

  bforge.metric("seu_events", seu_events)
  bforge.metric("last_flip_offset", bit_off)
  bforge.metric("last_flip_bit", bit_idx)
  return frame
end)
```

#### How It Works
1. `bforge.on_init` runs once immediately after script compilation, pinning the VM's `xorshift64*` state with `bforge.seed(42)` and emitting an info log naming `ctx.script`.
2. On a 20-byte frame (`max_payload = 18`), `bforge.rand` draws `bit_off = 6`, `bit_idx = 6`, and `byte_mask` deterministically.
3. `frame:xor_bit(6, 6)` flips bit `6` (`0x01 -> 0x41`) in byte `6`, `frame:xor_u8(7, mask)` flips nibble bits in byte `7` (`0x00 -> 0x0C`), and `frame:corrupt_crc(1)` XORs the final CRC byte (`0x7C ^ 0xFF = 0x83`).

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
- **Verdict badge:** `MUTATED` (`verdict = "send"`, `mutated = true`).
- **Output hex:** `AA 55 01 13 40 E2 41 0C 1F F4 00 00 00 00 80 90 A0 B0 01 83` (identical across repeated cold runs!).
- **Decoded Field Diffs:** `timestamp_us: 123456 -> 205644352`, `checksum: 0x7C -> 0x83`.
- **Watch Metrics:** `fuzzer_seed = "42"`, `seu_events = "1"`, `last_flip_offset = "6"`, `last_flip_bit = "6"`, `last_xor_u8_offset = "7"`.
- **Console Logs:** `info`: `SEU fuzzer armed on tutorial_06.lua`.

---

## Part III — Inline MITM Bridges, Multi-Schema Routing & Burst Shaping (Tutorials 07–09)

### Tutorial 07: MITM Directional Latency & Voltage Glitch

**Source:** [`examples/tutorials/07_mitm_directional_latency_glitch.lua`](../examples/tutorials/07_mitm_directional_latency_glitch.lua)  
**Template ID:** `tutorial_07`

#### Concepts & Capabilities Covered
- Inline hardware bridge interception via `bforge.on_mitm_frame("*", fn(frame, dir))`.
- Direction and bridge inspection (`"mitm_a_to_b"` vs. `"mitm_b_to_a"`, `frame.bridge`).
- Bidirectional scalar counters using read/write `bforge.metric(key)` and scheduled wire latency `frame:delay_ms(45)`.

#### Hardware / Protocol Scenario
Sitting inline between an On-Board Computer (`Port A`) and an Electrical Power Subsystem (`Port B`), you want telemetry traveling `A -> B` to suffer a realistic -250 mV brownout reading, a repaired CRC-8, and +45 ms link delay while replies on `B -> A` pass instantaneously untouched.

#### Complete Annotated Lua Script

```lua
-- Tutorial 07: MITM Directional Latency & Voltage Glitch
-- Concepts:
--   * Inline bridge hook bforge.on_mitm_frame(fn(frame, dir))
--   * Direction and bridge inspection: frame.direction ("mitm_a_to_b" vs "mitm_b_to_a"), frame.bridge
--   * Synthetic wire latency with frame:delay_ms(45) + directional patching and CRC repair

bforge.on_mitm_frame("*", function(frame, dir)
  local direction = dir or frame.direction
  bforge.metric("last_bridge", frame.bridge or "unassigned")
  bforge.metric("last_direction", direction)

  if direction == "mitm_a_to_b" then
    local v_batt = frame:get("v_batt_mv")
    if v_batt ~= nil then
      frame:set("v_batt_mv", math.max(0, v_batt - 250))
    elseif frame.len >= 10 then
      frame:set_u16_be(8, math.max(0, frame:u16_be(8) - 250))
    end

    if frame.len >= 20 then
      frame:recalc_crc("crc8")
    end

    bforge.metric("a_to_b_glitched", (bforge.metric("a_to_b_glitched") or 0) + 1)
    return frame:delay_ms(45)
  end

  bforge.metric("b_to_a_forwarded", (bforge.metric("b_to_a_forwarded") or 0) + 1)
  return frame
end)
```

#### How It Works
1. Both `dir` and `frame.direction` carry `"mitm_a_to_b"` or `"mitm_b_to_a"`. `frame.bridge` names the active `[[bridges]]` entry (or `nil` in standalone dry-runs, defaulted to `"unassigned"`).
2. In `"mitm_a_to_b"`, lines `13–18` decrement `v_batt_mv` by `250 mV` (`8180 -> 7930`), preferring the schema setter and falling back to `set_u16_be(8, ...)` when schema-less.
3. Line `24` reads the current metric with 1-arg `bforge.metric("a_to_b_glitched")`, increments it, and `return frame:delay_ms(45)` returns the frame handle with a 45 ms delay verdict.
4. Reverse direction `"mitm_b_to_a"` increments `b_to_a_forwarded` and returns `frame` immediately (`delay_ms = 0`).

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`. (Script Lab dry-run enters the `"mitm_a_to_b"` branch automatically.)
- **Verdict badge:** `DELAYED 45 ms` (`verdict = "delay"`, `delay_ms = 45`, `mutated = true`).
- **Output hex:** `AA 55 01 13 40 E2 01 00 1E FA 00 00 00 00 80 90 A0 B0 01 5D`.
- **Decoded Field Diffs:** `v_batt_mv: 8180 -> 7930`, `checksum: 0x7C -> 0x5D`.
- **Watch Metrics:** `last_bridge = "unassigned"` (or bridge name in live MITM), `last_direction = "mitm_a_to_b"`, `a_to_b_glitched = "1"`.

---

### Tutorial 08: Multi-Schema Runtime Dissection (D-94)

**Source:** [`examples/tutorials/08_multi_schema_dynamic_dissect.lua`](../examples/tutorials/08_multi_schema_dynamic_dissect.lua)  
**Template ID:** `tutorial_08`

#### Concepts & Capabilities Covered
- Dynamic runtime schema switching via `frame:dissect("ImuPacket")` and `frame:dissect("EpsCommand")`.
- Heterogenous `get`/`set` field manipulation across multiple message formats on a single wire.
- Protocol-specific checksum updates: `crc8` for `ImuPacket` vs. `crc16_ccitt_false` for `EpsCommand`.

#### Hardware / Protocol Scenario
Prior to BaudForge's multi-schema upgrade (`D-94`), a single port or bridge was locked to one dissector. Multiplexed aerospace buses carry long `ImuPacket` telemetry frames alongside short `EpsCommand` control packets on the same UART wire; `frame:dissect(tag)` switches the active `DissectorIr` per packet dynamically.

#### Complete Annotated Lua Script

```lua
-- Tutorial 08: Multi-Schema Runtime Dissection (D-94)
-- Concepts:
--   * Dynamic runtime schema binding via frame:dissect("EpsCommand") and frame:dissect("ImuPacket")
--   * Cross-schema get/set on a single MITM link carrying multiple message types
--   * Per-protocol checksum recalculation: crc8 for ImuPacket vs crc16_ccitt_false for EpsCommand

bforge.on_mitm_frame("*", function(frame)
  if frame.len >= 19 then
    local imu = frame:dissect("ImuPacket")
    if imu ~= nil then
      local ver = imu:get("version") or 0
      local v_batt = imu:get("v_batt_mv") or 0
      imu:set("version", (ver + 1) & 0xFF)
      if imu.len >= 20 then
        imu:recalc_crc("crc8")
      end
      bforge.metric("active_schema", "ImuPacket")
      bforge.metric("imu_v_batt_mv", v_batt)
      return imu
    end
  elseif frame.len >= 7 then
    local eps = frame:dissect("EpsCommand")
    if eps ~= nil then
      local hold = eps:get("hold_time_s") or 0
      local opcode = eps:get("opcode") or 0
      eps:set("hold_time_s", hold + 15)
      if eps.len >= 9 then
        eps:recalc_crc("crc16_ccitt_false")
      end
      bforge.metric("active_schema", "EpsCommand")
      bforge.metric("eps_opcode", opcode)
      return eps
    end
  end

  return frame
end)
```

#### How It Works
1. Lines `8–20` match frames `>= 19 B`, bind `ImuPacket` via `frame:dissect("ImuPacket")`, increment `version` (`1 -> 2`), and recompute 1-byte `crc8`.
2. Lines `21–34` match shorter `7..18 B` frames, bind `EpsCommand`, read `opcode` and `hold_time_s`, extend `hold_time_s` by `+15 s`, and recompute trailing 2-byte little-endian `crc16_ccitt_false`.
3. If an unrecognized schema tag is supplied, `dissect` returns `nil`, keeping the script guarded.

#### Try It in Script Lab
- **Case A (`ImuPacket` 20 B):** Paste `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
  - **Verdict badge:** `MUTATED` (`verdict = "send"`, `mutated = true`).
  - **Output hex:** `AA 55 02 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 6E`.
  - **Decoded Field Diffs:** `version: 1 -> 2`, `checksum: 0x7C -> 0x6E`.
  - **Watch Metrics:** `active_schema = "ImuPacket"`, `imu_v_batt_mv = "8180"`.
- **Case B (`EpsCommand` 9 B):** Enable **USE MANUAL HEX** and paste `AA 55 04 0A 00 00 00 B7 15`.
  - **Verdict badge:** `MUTATED` (`verdict = "send"`, `mutated = true`).
  - **Output hex:** `AA 55 04 19 00 00 00 CC 95`.
  - **Decoded Field Diffs:** `hold_time_s: 10 -> 25`, `checksum: 5559 -> 38348`.
  - **Watch Metrics:** `active_schema = "EpsCommand"`, `eps_opcode = "4"`.

---

### Tutorial 09: Packet Burst Duplication & Fragmented Split

**Source:** [`examples/tutorials/09_packet_burst_duplication_and_split.lua`](../examples/tutorials/09_packet_burst_duplication_and_split.lua)  
**Template ID:** `tutorial_09`

#### Concepts & Capabilities Covered
- Timed multi-frame output (`FrameVerdict::Burst`) via `bforge.burst({ { payload, delay_ms }, ... })`.
- Taking an unmodified binary snapshot with `frame:clone_bytes()` and byte-table roundtripping via `bforge.unhex(frame)` / `bforge.hex(tbl)`.
- Mid-frame slicing with `frame:slice(off, len)` and Lua bitwise XOR (`~`).

#### Hardware / Protocol Scenario
Target parsers must withstand duplicate frames, corrupted retransmissions, and back-to-back fragmented writes separated by inter-frame gaps. Tutorial `09` replaces each TX frame with a 4-frame timed sequence: original at `t + 0 ms`, bit-inverted duplicate at `t + 10 ms`, first half at `t + 20 ms`, and second half at `t + 25 ms`.

#### Complete Annotated Lua Script

```lua
-- Tutorial 09: Packet Burst Duplication & Fragmented Split
-- Concepts:
--   * Returning FrameVerdict::Burst via bforge.burst({ { payload, delay_ms }, ... })
--   * Capturing an unmodified byte snapshot with frame:clone_bytes()
--   * Spaced hex roundtripping with bforge.unhex / bforge.hex and payload slicing

bforge.on_tx_frame("*", function(frame)
  local original = frame:clone_bytes()
  local dup = bforge.unhex(frame)
  if #dup >= 1 then
    -- Invert the trailing byte on the duplicate to simulate a corrupted retransmission.
    dup[#dup] = dup[#dup] ~ 0xFF
  end
  local dup_hex = bforge.hex(dup)

  local half = math.floor(#original / 2)
  if half >= 1 and #original > half then
    local part1 = frame:slice(0, half)
    local part2 = frame:slice(half, #original - half)
    bforge.metric("burst_count", 4)
    return bforge.burst({
      { original, 0 },
      { dup_hex, 10 },
      { part1, 20 },
      { part2, 25 },
    })
  end

  bforge.metric("burst_count", 2)
  return bforge.burst({
    { original, 0 },
    { dup_hex, 10 },
  })
end)
```

#### How It Works
1. `frame:clone_bytes()` returns a Lua binary string of all current bytes, whereas `bforge.unhex(frame)` returns a 1-indexed Lua integer array `{ byte1, byte2, ... }` so individual 1-based bytes can be mutated (`dup[#dup] = dup[#dup] ~ 0xFF`) and formatted back to spaced hex via `bforge.hex(dup)`.
2. For frames `>= 2 B`, lines `16–27` split `original` cleanly into `part1 = frame:slice(0, half)` and `part2 = frame:slice(half, #original - half)` (`bforge.burst` accepts both raw Lua binary strings and spaced hex strings seamlessly).
3. Returning `bforge.burst(...)` emits `FrameVerdict::Burst`, queuing four scheduled frame transmissions.

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
- **Verdict badge:** `BURST (4)` (`verdict = "burst"`, `mutated = true`).
- **Burst Schedule (`burst_frames`):**
  1. `+0 ms`: `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (20 B original)
  2. `+10 ms`: `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 83` (20 B, last byte XOR `0xFF`)
  3. `+20 ms`: `AA 55 01 13 40 E2 01 00 1F F4` (10 B first half)
  4. `+25 ms`: `00 00 00 00 80 90 A0 B0 01 7C` (10 B second half)
- **Watch Metrics:** `burst_count = "4"`.

---

## Part IV — Emulation, Pre-Framer Faults & Custom Dissectors (Tutorials 10–12)

### Tutorial 10: Virtual Device Auto-Responder

**Source:** [`examples/tutorials/10_virtual_device_auto_responder.lua`](../examples/tutorials/10_virtual_device_auto_responder.lua)  
**Template ID:** `tutorial_10`

#### Concepts & Capabilities Covered
- Lua 5.4 `string.unpack` / `string.pack` binary codecs combined with bitwise bitfield operators (`&`, `|`, `>>`, `<<`).
- Standalone checksum computation via `bforge.crc("crc16_modbus", data)`.
- Non-reentrant delayed TX emission via `bforge.send(port, packet, { delay_ms = 4, run_tx_hooks = false })`.

#### Hardware / Protocol Scenario
While waiting for physical PCB delivery, firmware teams use BaudForge as an autonomous virtual peripheral: whenever the flight controller transmits a frame, the virtual responder unpacks its header bitfields (`flags` and `channel`), constructs a protocol ACK with bit `7` of `version` asserted (`0x81`), appends a CRC-16/MODBUS trailer, and queues it back on the wire 4 ms later.

#### Complete Annotated Lua Script

```lua
-- Tutorial 10: Virtual Device Auto-Responder
-- Concepts:
--   * Lua 5.4 binary codecs string.pack / string.unpack and bitwise operators (&, |, >>, <<)
--   * Standalone checksum calculation via bforge.crc("crc16_modbus", data)
--   * Non-reentrant delayed TX emission via bforge.send(port, packet, { delay_ms = 4 })

bforge.on_rx_frame("*", function(frame)
  if frame.len < 4 then
    return frame
  end

  local sync, version, meta_byte = string.unpack("<HBB", frame:raw())
  local flags = meta_byte & 0x07
  local channel = (meta_byte >> 3) & 0x1F

  -- Echo channel/flags back with MSB set in version to signify an ACK reply.
  local ack_meta = ((channel & 0x1F) << 3) | (flags & 0x07)
  local reply_ver = 0x80 | (version & 0x7F)
  local body = string.pack("<HBB", sync, reply_ver, ack_meta)
  local crc = bforge.crc("crc16_modbus", body)
  local packet = body .. string.pack("<H", crc)

  local target_port = (frame.port ~= "" and frame.port) or "*"
  bforge.send(target_port, packet, { delay_ms = 4, run_tx_hooks = false })

  bforge.metric("rx_flags", flags)
  bforge.metric("rx_channel", channel)
  bforge.metric("ack_crc16", string.format("0x%04X", crc))
  return frame
end)
```

#### How It Works
1. `string.unpack("<HBB", frame:raw())` decodes the first four raw bytes (`AA 55 01 13`) in little-endian order into `sync = 0x55AA`, `version = 0x01`, and `meta_byte = 0x13`.
2. Lines `13–14` extract the lower 3 bits (`flags = 3`) and upper 5 bits (`channel = 2`).
3. Lines `17–21` pack a 4-byte ACK header (`AA 55 81 13`), compute `crc16_modbus` (`0x7110`), and concatenate its 2-byte LE encoding (`10 71`) using `..`.
4. Line `24` queues the 6-byte reply (`AA 55 81 13 10 71`) at `delay_ms = 4` with `run_tx_hooks = false` (non-reentrant `Origin::Script`, capped at `16` sends per call), while returning the incoming `frame` untouched (`mutated = false`).

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (or `DEFAULT_TEST_FRAME_HEX`).
- **Verdict badge:** `SEND` (`verdict = "send"`, `mutated = false`).
- **Output hex:** Unchanged incoming frame (`20 B`).
- **Actions:** `send`: port `"COM8"`, delay `4 ms`, hex `AA 55 81 13 10 71`.
- **Watch Metrics:** `rx_flags = "3"`, `rx_channel = "2"`, `ack_crc16 = "0x7110"`.

---

### Tutorial 11: Raw Chunk Pre-Framer Corruptor

**Source:** [`examples/tutorials/11_raw_chunk_pre_framer_corruptor.lua`](../examples/tutorials/11_raw_chunk_pre_framer_corruptor.lua)  
**Template ID:** `tutorial_11`

#### Concepts & Capabilities Covered
- Pre-framer byte stream interception using `bforge.on_raw_chunk("*", fn(chunk))`.
- Unframed byte manipulation with `chunk:raw()`, `chunk:set_bytes(...)`, and `chunk:resize(...)`.
- Alternation state across consecutive USB/serial read slabs.

#### Hardware / Protocol Scenario
Frame parsers only get tested on malformed wire alignment if faults occur *before* the framer (`SyncFrame`, SLIP, COBS, or delimiter state machines). `on_raw_chunk` intercepts raw OS read chunks ahead of `stream.feed`, allowing you to prepend garbage noise before sync words and chop chunks across partial boundaries.

#### Complete Annotated Lua Script

```lua
-- Tutorial 11: Raw Chunk Pre-Framer Corruptor
-- Concepts:
--   * Pre-framer stream interception with bforge.on_raw_chunk("*", fn)
--   * Reading and rewriting unframed chunks via chunk:raw(), chunk:set_bytes(...), chunk:resize(...)
--   * Stress-testing sync-word acquisition and partial-frame reassembly

local chunks = 0

bforge.on_raw_chunk("*", function(chunk)
  chunks = chunks + 1
  bforge.metric("raw_chunks", chunks)

  local raw = chunk:raw()
  if (chunks % 2) == 1 then
    -- Odd chunks: inject two garbage bytes ahead of the sync preamble.
    chunk:set_bytes(string.pack("<BB", 0x00, 0xFF) .. raw)
    bforge.metric("last_fault", "prepend_garbage")
  else
    -- Even chunks: truncate to half length to exercise partial-read buffering.
    local half = math.max(1, math.floor(chunk.len / 2))
    chunk:resize(half)
    bforge.metric("last_fault", "truncate_half")
  end

  return chunk
end)
```

#### How It Works
1. Unlike `on_rx_frame` (which sees complete, framed packets), `on_raw_chunk` runs inside the session reader immediately before framing.
2. On odd read chunks (`chunks = 1, 3, ...`), `chunk:set_bytes(string.pack("<BB", 0x00, 0xFF) .. raw)` prepends `00 FF` in front of the chunk, growing a 20-byte chunk to 22 bytes so sync-hunting logic must skip garbage.
3. On even chunks (`chunks = 2, 4, ...`), `chunk:resize(half)` cuts the buffer cleanly in half (to 10 bytes), exercising multi-read partial reassembly.

#### Try It in Script Lab
- **Input hex:** `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
- **Verdict badge (Dry-Run #1):** `MUTATED` (`verdict = "send"`, `mutated = true`).
- **Output hex:** `00 FF AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` (22 B).
- **Watch Metrics:** `raw_chunks = "1"`, `last_fault = "prepend_garbage"`.
- **When ARMED over multiple frames:** Frame #2 alternates to `last_fault = "truncate_half"` (`10 B` output).

---

### Tutorial 12: Custom Dissector & Command Payload Builder

**Source:** [`examples/tutorials/12_custom_dissector_and_command_builder.lua`](../examples/tutorials/12_custom_dissector_and_command_builder.lua)  
**Template ID:** `tutorial_12`

#### Concepts & Capabilities Covered
- Synthetic dissector annotation via `bforge.on_dissect("*", fn(frame))` and `frame:add_field(name, offset, len, display, numeric)`.
- Parameterized packet synthesis via `bforge.on_command("set_heater", fn(args))`.
- Standalone CRC-8/ATM and CRC-16/XMODEM computation (`bforge.crc("crc16_xmodem", body)`).

#### Hardware / Protocol Scenario
You want Stream Monitor to show engineering-unit decoded fields (`wire_sync`, `batt_volts` formatted as `"8.180 V"`, and `tail_crc8` showing `"CRC_OK"` vs. `"CRC_ERR(0x..)"`) and simultaneously define a `set_heater` command generator for Command Forge (`zone`, `duty`, `enable` args) sealed with a CRC-16/XMODEM checksum.

#### Complete Annotated Lua Script

```lua
-- Tutorial 12: Custom Dissector & Command Payload Builder
-- Concepts:
--   * Annotated field extraction via bforge.on_dissect("*", fn) and frame:add_field(...)
--   * Named command payload builder via bforge.on_command("set_heater", fn(args))
--   * Standalone CRC-16/XMODEM calculation via bforge.crc("crc16_xmodem", data)

bforge.on_dissect("*", function(frame)
  if frame.len >= 2 then
    local sync = frame:u16_be(0)
    frame:add_field("wire_sync", 0, 2, string.format("0x%04X", sync), sync)
  end

  if frame.len >= 10 then
    local v_batt_mv = frame:u16_be(8)
    frame:add_field("batt_volts", 8, 2, string.format("%.3f V", v_batt_mv / 1000.0), v_batt_mv / 1000.0)
  end

  if frame.len >= 20 then
    local actual = frame:u8(19)
    local expected = bforge.crc("crc8", frame:slice(0, 19))
    local label = (actual == expected) and "CRC_OK" or string.format("CRC_ERR(0x%02X)", actual)
    frame:add_field("tail_crc8", 19, 1, label, actual)
  end

  bforge.metric("custom_dissected", (bforge.metric("custom_dissected") or 0) + 1)
  return frame
end)

bforge.on_command("set_heater", function(args)
  local zone = math.floor(tonumber(args.zone) or 1) & 0xFF
  local duty = math.max(0, math.min(100, math.floor(tonumber(args.duty or args.power) or 50)))
  local enable = (args.enable == "false" or args.enable == "0") and 0 or 1

  local body = string.pack("<HBBBB", 0x55AA, 0x31, zone, enable, duty)
  local crc = bforge.crc("crc16_xmodem", body)
  return body .. string.pack("<H", crc)
end)
```

#### How It Works
1. In `bforge.on_dissect`, `frame:add_field(name, offset, len, display, num)` publishes custom decoded columns (`"wire_sync"`, `"batt_volts"`, `"tail_crc8"`) without mutating wire bytes. Note line `21` uses Lua's short-circuit ternary `(actual == expected) and "CRC_OK" or string.format(...)` so valid packets display `"CRC_OK"` and mismatched packets surface the raw hex byte (`CRC_ERR(0x5B)`).
2. In `bforge.on_command("set_heater", fn(args))`, the script parses string table arguments, clamps `duty` to `0..100`, packs a 6-byte header (`AA 55 31 <zone> <enable> <duty>`), computes `crc16_xmodem` (poly `0x1021`, init `0x0000`), and returns an 8-byte binary command packet (`AA 55 31 02 01 4B EC AF` for `zone=2, duty=75, enable=1`).

#### Try It in Script Lab
- **Case A (Valid CRC-8 `ImuPacket`):** Paste `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C` and click **DRY-RUN PACKET**.
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `mutated = false`).
  - **Decoded Field Diffs:** Shows the 3 synthetic fields added (`before: —`): `wire_sync = "0xAA55"`, `batt_volts = "8.180 V"`, `tail_crc8 = "CRC_OK"`.
  - **Watch Metrics:** `custom_dissected = "1"`.
- **Case B (Default Script Lab Hex with invalid `0x5B` byte):** Run with `DEFAULT_TEST_FRAME_HEX` (`... 01 5B`).
  - **Decoded Field Diffs:** `tail_crc8 = "CRC_ERR(0x5B)"` immediately exposes the checksum mismatch!
- **Command Builder (`on_command`):** Compiled cleanly (`hooks: ["on_dissect", "on_command"]`). Live `ScriptRuntime::invoke_command("set_heater", { zone="2", duty="75", enable="1" })` produces `AA 55 31 02 01 4B EC AF`.

---

## Part V — Active Timers, Watchdog Pin Recovery & Safety Interlocks (Tutorials 13–15)

### Tutorial 13: Periodic Timer Poller & RX Jitter Plotter

**Source:** [`examples/tutorials/13_periodic_timer_poller_and_jitter.lua`](../examples/tutorials/13_periodic_timer_poller_and_jitter.lua)  
**Template ID:** `tutorial_13`

#### Concepts & Capabilities Covered
- Periodic background callbacks via `bforge.on_timer(100, fn(ctx))` (with `ctx.now_ms`).
- Monotonic timing (`bforge.now_us()`, `bforge.now_ms()`) and active TX command polling (`bforge.send`).
- Inter-arrival period (`dt_us`) and second-difference jitter (`|dt_us - prev_dt_us|`) plotting via `bforge.plot`.

#### Hardware / Protocol Scenario
Master-slave field buses require the workbench to issue periodic poll requests every 100 ms while simultaneously measuring jitter in the slave's RX telemetry cadence (`10 ms`, `10.5 ms`, `9.5 ms` -> `1000 us` jitter) inside Plot Forge.

#### Complete Annotated Lua Script

```lua
-- Tutorial 13: Periodic Timer Poller & RX Jitter Plotter
-- Concepts:
--   * Periodic timer callback via bforge.on_timer(100, fn(ctx))
--   * Monotonic clocks bforge.now_us() / bforge.now_ms() and active polling with bforge.send
--   * RX inter-arrival delta and jitter plotting via bforge.plot

local poll_seq = 0
local last_rx_us = nil
local prev_dt_us = nil

bforge.on_timer(100, function(ctx)
  poll_seq = poll_seq + 1
  local now_ms = ctx.now_ms or bforge.now_ms()

  local header = string.pack("<HBB", 0x55AA, 0x01, poll_seq & 0xFF)
  local crc = bforge.crc("crc8", header)
  local pkt = header .. string.pack("<B", crc)

  bforge.send("*", pkt, { delay_ms = 0, run_tx_hooks = false })
  bforge.metric("polls_sent", poll_seq)
  bforge.metric("last_poll_ms", now_ms)
end)

bforge.on_rx_frame("*", function(frame)
  local rx_us = (frame.timestamp_us and frame.timestamp_us > 0) and frame.timestamp_us or bforge.now_us()

  if last_rx_us ~= nil then
    local dt_us = rx_us - last_rx_us
    bforge.plot("rx_interval_us", dt_us, rx_us)
    if prev_dt_us ~= nil then
      local jitter_us = math.abs(dt_us - prev_dt_us)
      bforge.plot("rx_jitter_us", jitter_us, rx_us)
      bforge.metric("last_jitter_us", jitter_us)
    end
    prev_dt_us = dt_us
  end

  last_rx_us = rx_us
  return frame
end)
```

#### How It Works
1. Lines `11–22` register a 100 ms periodic timer. Each tick increments an 8-bit wrapping `poll_seq`, builds a 5-byte query packet (`AA 55 01 <seq> <crc8>`), and broadcasts it via `bforge.send("*", pkt, ...)`.
2. Lines `24–40` measure incoming RX timing: frame #1 establishes `last_rx_us`; frame #2 plots `rx_interval_us` and sets `prev_dt_us`; frame #3 onward plots both `rx_interval_us` and `rx_jitter_us` (`|dt_us - prev_dt_us|`).

#### Try It in Script Lab
- **Dry-Run Packet:** Click **DRY-RUN PACKET** on `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `mutated = false`; `hooks: ["on_timer", "on_rx_frame"]`).
- **ARMED Stream Behavior:** When ARMED over successive packets (e.g. Simulated Mode RX stream or live serial device), `rx_interval_us` and `rx_jitter_us` populate automatically from the 2nd and 3rd frames onward.
- **Timer Hook Behavior (`tick_timers(100)` in live runtime):** Every 100 ms emits `send` (`AA 55 01 01 95` on tick #1) and updates `polls_sent` and `last_poll_ms`.

---

### Tutorial 14: Hardware Pin Reset & Watchdog Alert Handler

**Source:** [`examples/tutorials/14_hardware_pin_reset_and_alert_handler.lua`](../examples/tutorials/14_hardware_pin_reset_and_alert_handler.lua)  
**Template ID:** `tutorial_14`

#### Concepts & Capabilities Covered
- Alert event subscription via `bforge.on_alert("dead_man_timer", fn(alert))`.
- Hardware UART modem-control signaling via `bforge.set_pins(dtr, rts)`, `bforge.pulse_pin("RTS", 25)`, and `bforge.trigger_pin("*", "DTR_LOW")`.
- Automated MCU reset / bootloader recovery automation triggered by silence watchdogs.

#### Hardware / Protocol Scenario
When a Device Under Test firmware deadlocks and triggers BaudForge's `dead_man_timer` watchdog alert (`silence > 2000ms`), manual lab intervention breaks overnight endurance runs. Subscribing to `dead_man_timer` in Lua automatically holds `DTR` high, pulses `RTS` for 25 ms to hardware-reset the MCU, and releases `DTR` low afterward.

#### Complete Annotated Lua Script

```lua
-- Tutorial 14: Hardware Pin Reset & Watchdog Alert Handler
-- Concepts:
--   * Alert subscription via bforge.on_alert("dead_man_timer", fn(alert))
--   * Hardware control lines via bforge.set_pins, bforge.pulse_pin, and bforge.trigger_pin
--   * Automated MCU reset / bootloader recovery sequence

local resets = 0

bforge.on_alert("dead_man_timer", function(alert)
  resets = resets + 1
  bforge.log_warn(string.format(
    "recovery #%d on alert `%s`: %s",
    resets,
    tostring(alert.name),
    tostring(alert.detail)
  ))

  -- Assert DTR (boot/hold), pulse RTS to reset target MCU, then release DTR/RTS low.
  bforge.set_pins(true, false)
  bforge.pulse_pin("RTS", 25)
  bforge.trigger_pin("*", "DTR_LOW")

  bforge.metric("mcu_resets", resets)
  bforge.metric("last_alert_ts_us", alert.timestamp_us or 0)
end)

bforge.on_rx_frame("*", function(frame)
  bforge.metric("last_rx_seq", frame.seq_id)
  return frame
end)
```

#### How It Works
1. Lines `9–25` bind specifically to `"dead_man_timer"` alerts (pass `"*"` to catch all alerts). When fired, `alert` supplies `alert.name`, `alert.detail`, and `alert.timestamp_us`.
2. Lines `19–21` execute the three-step hardware pin recovery sequence using all three pin APIs (`set_pins` 2-arg global form, `pulse_pin` 25 ms, and string-spec `trigger_pin("*", "DTR_LOW")`).
3. Lines `27–30` track `last_rx_seq` on healthy incoming traffic.

#### Try It in Script Lab
- **Dry-Run Packet:** Click **DRY-RUN PACKET** on `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`.
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `hooks: ["on_alert", "on_rx_frame"]`).
  - **Watch Metrics:** `last_rx_seq` matches the selected packet sequence ID (`1` in manual hex mode, or selected stream packet `seqId`).
- **Alert Trigger Behavior (`trigger_alert("dead_man_timer", ...)` in live runtime):** Increments `mcu_resets`, emits a `warn` console log, and schedules `SetPins(dtr=true, rts=false)`, `PulsePin(RTS, 25 ms)`, and `SetPins(dtr=false, rts=false)`.

---

### Tutorial 15: Fail-Closed Safety Interlock & Resource Budget Guard

**Source:** [`examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua`](../examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua)  
**Template ID:** `tutorial_15`

#### Concepts & Capabilities Covered
- **`FaultPolicy::FailClosed`** safety interlock: invalid frames, tripped safety assertions, or script errors drop TX frames instead of passing unsafe commands to hardware.
- Multi-field safety envelope checks (`sync_valid`, `v_batt_envelope` `6000..9000 mV`, `mode_valid` `<= 2`).
- Fixed-capacity 16-entry circular buffer ensuring O(1) memory (`<< 4 MiB`) and tiny per-frame instruction counts (`<< 200k`).

#### Hardware / Protocol Scenario
On a high-energy battery rig or actuator bus, passing an out-of-envelope TX frame during a workbench glitch can trip relays or damage hardware. Tutorial `15` acts as a last-chance software interlock: every TX packet is checked against voltage, sync, and mode bounds using short-circuit safe expressions and pre-allocated storage, dropping any anomalous frame with `interlock_state = "TRIPPED"`.

#### Complete Annotated Lua Script

```lua
-- Tutorial 15: Fail-Closed Safety Interlock & Resource Budget Guard
-- Concepts:
--   * FaultPolicy::FailClosed safety envelope pattern (drops on error or assertion trip)
--   * Multi-field validation with bforge.assert
--   * Fixed-size Lua ring buffer keeping VM heap (< 4 MiB) and instructions (< 200k) strictly bounded

local RING_CAP = 16
local ring = {}
local ring_head = 0
local ring_len = 0

for i = 1, RING_CAP do
  ring[i] = 0
end

local function push_ring(value)
  ring_head = (ring_head % RING_CAP) + 1
  ring[ring_head] = value
  if ring_len < RING_CAP then
    ring_len = ring_len + 1
  end
end

bforge.on_tx_frame("*", function(frame)
  local v_batt = frame:get("v_batt_mv")
  if v_batt == nil then
    v_batt = frame.len >= 10 and frame:u16_be(8) or 0
  end

  local mode = frame:get("mode")
  if mode == nil then
    mode = frame.len >= 19 and frame:u8(18) or 0
  end

  local sync_raw = frame:get("sync")
  local sync_matches = (sync_raw == 0x55AA)
    or (sync_raw == "0xAA55")
    or (frame.len >= 2 and frame:u8(0) == 0xAA and frame:u8(1) == 0x55)

  local sync_ok = bforge.assert("sync_valid", sync_matches, "unexpected sync header")
  local batt_ok = bforge.assert("v_batt_envelope", v_batt >= 6000 and v_batt <= 9000, "battery outside 6000..9000 mV")
  local mode_ok = bforge.assert("mode_valid", mode <= 2, "mode outside 0..2")

  push_ring(v_batt)
  local sum = 0
  for i = 1, ring_len do
    sum = sum + ring[i]
  end

  bforge.metric("ring_fill", ring_len)
  bforge.metric("ring_avg_mv", sum / ring_len)

  if not (sync_ok and batt_ok and mode_ok) then
    bforge.metric("interlock_state", "TRIPPED")
    bforge.log_error("fail-closed safety interlock tripped; dropping frame")
    return frame:drop()
  end

  bforge.metric("interlock_state", "OK")
  return frame
end)
```

#### How It Works
1. Lines `7–14` pre-allocate all 16 ring-buffer slots at load time so hot TX calls never trigger garbage-collector growth or dynamic table allocation.
2. Lines `25–38` read `v_batt_mv`, `mode`, and `sync` defensively. Notice `frame.len >= 10 and frame:u16_be(8) or 0` relies on short-circuit evaluation so truncated frames safely yield `0` rather than raising an out-of-bounds error.
3. Lines `40–42` capture the boolean return value of all three `bforge.assert` calls so *all* violations are tallied on every frame before checking `not (sync_ok and batt_ok and mode_ok)` at line `53`.
4. Setting Script Lab's policy dropdown to **FAIL-CLOSED** backs up the script-level check: even an unexpected exception drops the frame rather than forwarding it.

#### Try It in Script Lab
- **Case A (Safe Frame):** Set policy selector to **FAIL-CLOSED**, paste `AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 7C`, and click **DRY-RUN PACKET**.
  - **Verdict badge:** `PASS` (`verdict = "pass"`, `mutated = false`).
  - **Assertions:** `sync_valid`, `v_batt_envelope`, `mode_valid` all show `passed: 1, failed: 0`.
  - **Watch Metrics:** `ring_fill = "1"`, `ring_avg_mv = "8180"`, `interlock_state = "OK"`.
- **Case B (Unsafe / Truncated Frame):** Enable **USE MANUAL HEX**, enter `01 02` (or set `v_batt_mv` bytes `8..9` to `2E E0` = `12000 mV`), and click **DRY-RUN PACKET**.
  - **Verdict badge:** `DROPPED` (`verdict = "drop"`, empty output hex).
  - **Watch Metrics:** `interlock_state = "TRIPPED"`.
  - **Console Logs:** `error`: `fail-closed safety interlock tripped; dropping frame`.
