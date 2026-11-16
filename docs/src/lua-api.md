# BaudForge Lua 5.4 Scripting API Reference

**Applies to:** Native Rust `bforge-script` (`mlua` Lua 5.4) and Script Lab Offline Simulator (`ui/src/services/luaSandboxFallback.ts`)  
**Progressive Curriculum:** [`docs/LUA_SCRIPTING_TUTORIAL.md`](lua-tutorials.html) (Tutorials `01`–`15`)  
**Source of Truth:** [`crates/bforge-script/src/runtime.rs`](../crates/bforge-script/src/runtime.rs) · [`crates/bforge-script/src/frame.rs`](../crates/bforge-script/src/frame.rs)

---

## 1. Sandbox & Execution Bounds

BaudForge runs each armed script inside an isolated Lua 5.4 VM with deterministic resource caps:

| Limit / Property | Native Rust (`bforge-script`) | Offline Simulator (`luaSandboxFallback.ts`) |
| :--- | :--- | :--- |
| **Lua Standard Libraries** | `table`, `string`, `math`, `utf8` (`io`, `os`, `package`, `debug`, `require`, `dofile`, `loadfile` stripped) | Subset of `table`, `string`, `math`, `utf8` |
| **Per-Callback Instruction Budget** | `200,000` instructions (`HOOK_TICK = 500`) | `20,000` interpreter steps |
| **VM Heap Memory Limit** | `4 MiB` default (`1 MiB` min, `16 MiB` max configurable) | Estimated in UI (`24 KB + source * 4`) |
| **Timers (`bforge.on_timer`)** | Max `8` timers per VM, min interval `10 ms` | Compiled & listed (fires in live engine) |
| **Side-Effect TX (`bforge.send`)** | Max `16` queued sends per callback invocation | Recorded in Dry-Run `actions` |
| **Log Rate Limit** | Token bucket: `20` burst, `50 msg/s` sustained | Recorded in Dry-Run `actions` & Script Console |
| **Error Policy** | `fail_open` (forward original frame) or `fail_closed` (drop frame) | `fail_open` or `fail_closed` |

---

## 2. `bforge` Global API

### 2.1 Lifecycle & Frame Hooks

| Function | Signature | When It Runs |
| :--- | :--- | :--- |
| **`bforge.on_init`** | `bforge.on_init(fn(ctx))` | Once when the script is armed or loaded. Use to call `bforge.seed(...)` and initialize counters/tables. |
| **`bforge.on_rx_frame`** | `bforge.on_rx_frame([port_or_star], fn(frame, dir))` | Post-framer on every received packet matching `port` (or `"*"` / omitted for all ports). |
| **`bforge.on_tx_frame`** | `bforge.on_tx_frame([port_or_star], fn(frame, dir))` | Before wire transmission on `port` (or `"*"` / omitted). |
| **`bforge.on_mitm_frame`** | `bforge.on_mitm_frame([bridge_or_star], fn(frame, dir))` | Inline inside a dual-port MITM bridge (`frame.direction` is `"mitm_a_to_b"` or `"mitm_b_to_a"`). |
| **`bforge.on_raw_chunk`** | `bforge.on_raw_chunk([port_or_star], fn(chunk, dir))` | Pre-framer on raw transport byte chunks (for sync-word corruption or fragmentation tests). |
| **`bforge.on_dissect`** | `bforge.on_dissect([port_or_star], fn(frame, dir))` | Custom protocol dissector hook; emit decoded fields via `frame:add_field(...)`. |
| **`bforge.on_timer`** | `bforge.on_timer(interval_ms, fn(ctx))` | Periodic monotonic tick (`interval_ms` clamped to `>= 10 ms`, max `8` timers). |
| **`bforge.on_alert`** | `bforge.on_alert([alert_name], fn(alert))` | Fires when a configured workspace alert (e.g., `"dead_man_timer"`) triggers. |
| **`bforge.on_command`** | `bforge.on_command(name, fn(args))` | Named payload generator callable from Command Forge; returns bytes, spaced hex, or a byte array. |
| **`bforge.on_frame`** | `bforge.on_frame(fn(frame_or_hex))` | Legacy single-hook fallback handler. |

### 2.2 Frame Return Values & Verdict Precedence

Inside `on_rx_frame`, `on_tx_frame`, `on_mitm_frame`, and `on_raw_chunk`, return behavior is resolved in this order:

1. **Drop:** Calling `frame:drop()`, returning `nil` explicitly, or returning `false` drops the frame.
2. **Burst:** Returning `bforge.burst({ ... })` replaces the frame with 1 or more timed entries:
   - Each entry may be a `LuaFrame`, spaced hex string, raw byte string, byte array `{0xAA, 0x55}`, or `{ bytes = ..., delay_ms = 20 }`.
3. **Delay:** Calling `frame:delay_ms(ms)` (or `frame:forward_after_ms(ms)`) schedules delayed forwarding (preserving any byte mutations).
4. **Mutated / Replaced Send:** Returning a `LuaFrame`, spaced hex string, raw byte string, or byte array `{...}` sends the modified bytes.
5. **Pass:** Returning nothing (implicit `nil` with no `frame:drop()` and no mutations) forwards the original frame zero-copy.

### 2.3 Active TX, Bursts & Hardware Pins

| Function | Signature | Description |
| :--- | :--- | :--- |
| **`bforge.send`** | `bforge.send(port, data, [opts])` | Queue an out-of-band frame on `port` (`data` = raw string, spaced hex, byte table, or `LuaFrame`). Optional `opts = { delay_ms = 10 }`. Max `16` per callback. |
| **`bforge.burst`** | `bforge.burst(entries)` | Wrap a table of frame entries (with optional `delay_ms`) to return as a multi-packet burst. |
| **`bforge.set_pins`** | `bforge.set_pins([port], dtr, rts)` | Drive `DTR` and `RTS` modem control lines (`boolean` values). Omits `port` to target `"*"`. |
| **`bforge.pulse_pin`** | `bforge.pulse_pin([port], pin, ms)` | Pulse `"DTR"` or `"RTS"` for `ms` milliseconds. |
| **`bforge.trigger_pin`** | `bforge.trigger_pin(port, spec)` | Trigger a pin sequence from a string spec (e.g., `"DTR:50"`). |

### 2.4 Telemetry, Assertions & Logging

| Function | Signature | Description |
| :--- | :--- | :--- |
| **`bforge.plot`** | `bforge.plot(series, value, [timestamp_us])` | Push a numeric sample to `script:<series>` for `PlotForgeView` and `OscilloscopeView`. |
| **`bforge.metric`** | `bforge.metric(key, [value])` | With `value` (number, string, or boolean): set a Watch scalar. Without `value`: read current metric value (or `nil`). |
| **`bforge.assert`** | `bforge.assert(label, cond, [msg])` or `bforge.assert(cond, label, [msg])` | Record a pass/fail assertion in the `bforge.assert` scoreboard; returns `boolean` `cond`. |
| **`bforge.log`** | `bforge.log(msg)` or `bforge.log(level, msg)` | Rate-limited log (`level`: `"info"`, `"warn"`, `"error"`, `"debug"`). |
| **`bforge.log_info`** | `bforge.log_info(msg)` | Shorthand for `bforge.log("info", msg)`. |
| **`bforge.log_warn`** | `bforge.log_warn(msg)` | Shorthand for `bforge.log("warn", msg)`. |
| **`bforge.log_error`** | `bforge.log_error(msg)` | Shorthand for `bforge.log("error", msg)`. |

### 2.5 Time, Deterministic PRNG, Codecs & Checksums

| Function | Signature | Description |
| :--- | :--- | :--- |
| **`bforge.now_us`** | `bforge.now_us()` | Monotonic session elapsed time in microseconds (`integer`). |
| **`bforge.now_ms`** | `bforge.now_ms()` | Monotonic session elapsed time in milliseconds (`integer`). |
| **`bforge.seed`** | `bforge.seed(n)` | Seed the deterministic `xorshift64*` PRNG. |
| **`bforge.rand`** | `bforge.rand([min, max])` | No args: float in `[0, 1)`. `(n)`: integer in `[1, n]`. `(min, max)`: integer in `[min, max]`. |
| **`bforge.hex`** | `bforge.hex(val)` | Convert a byte table, raw string, or `LuaFrame` to uppercase spaced hex (`"AA 55 01"`). |
| **`bforge.unhex`** | `bforge.unhex(hex_or_frame)` | Convert spaced hex (or `LuaFrame`) to a 1-indexed Lua byte array `{ 0xAA, 0x55, ... }`. |
| **`bforge.crc`** | `bforge.crc(algo, data)` | Compute checksum integer over a raw string, spaced hex, byte table, or `LuaFrame`. |

**Supported `algo` values** (for `bforge.crc` and `frame:recalc_crc`):
- `"crc8"` / `"crc8_atm"` (8-bit, poly `0x07`)
- `"crc16_ccitt_false"` (16-bit, init `0xFFFF`, poly `0x1021`)
- `"crc16_modbus"` (16-bit, init `0xFFFF`, poly `0xA001` reflected)
- `"crc16_xmodem"` (16-bit, init `0x0000`, poly `0x1021`)
- `"crc32c"` (32-bit Castagnoli)

---

## 3. `LuaFrame` UserData API

### 3.1 Metadata Properties (Read-Only)

| Property | Type | Description |
| :--- | :--- | :--- |
| `frame.port` | `string` | Port name (e.g., `"COM8"` or `"ttyUSB0"`). |
| `frame.direction` | `string` | `"RX"`, `"TX"`, `"mitm_a_to_b"`, `"mitm_b_to_a"`, or `"RAW"`. |
| `frame.seq_id` | `integer` | Monotonic frame sequence number. |
| `frame.timestamp_us` | `integer` | Frame capture timestamp in microseconds. |
| `frame.len` | `integer` | Current byte length of the frame. |
| `frame.hex` | `string` | Lazy uppercase spaced-hex representation (`"AA 55 ..."`). |
| `frame.bridge` | `string \| nil` | MITM bridge identifier when inside `on_mitm_frame`, else `nil`. |

### 3.2 Schema Dissection Methods

| Method | Signature | Description |
| :--- | :--- | :--- |
| `frame:get` | `frame:get(name)` | Decode and return field `name` from the active schema (or `nil` if missing). |
| `frame:set` | `frame:set(name, value)` | Patch schema field `name` in-place. Returns `frame` for chaining. |
| `frame:fields` | `frame:fields()` | Return a Lua table mapping all decoded field names to their values. |
| `frame:dissect` | `frame:dissect(schema_tag)` | Switch active schema on this frame (e.g., `"ImuPacket"`, `"EpsCommand"`). Returns `boolean`. |
| `frame:add_field` | `frame:add_field(name, off, len, val_str, [val_num])` | Emit a custom dissected field (used in `on_dissect`). |

### 3.3 Zero-Offset Binary Readers

All offsets are **0-indexed** from the start of the frame:

| Method | Width | Signed / Endian |
| :--- | :--- | :--- |
| `frame:u8(off)` / `frame:i8(off)` | 1 byte | Unsigned / Signed |
| `frame:u16_le(off)` / `frame:u16_be(off)` | 2 bytes | Unsigned LE / BE |
| `frame:i16_le(off)` / `frame:i16_be(off)` | 2 bytes | Signed LE / BE |
| `frame:u32_le(off)` / `frame:u32_be(off)` | 4 bytes | Unsigned LE / BE |
| `frame:i32_le(off)` / `frame:i32_be(off)` | 4 bytes | Signed LE / BE |
| `frame:f32_le(off)` / `frame:f32_be(off)` | 4 bytes | IEEE-754 float LE / BE |
| `frame:f64_le(off)` / `frame:f64_be(off)` | 8 bytes | IEEE-754 double LE / BE |
| `frame:slice(off, len)` | `len` bytes | Returns raw Lua binary string (`string.unpack` compatible). |
| `frame:raw()` | full frame | Returns full frame as a raw Lua binary string. |
| `frame:clone_bytes()` / `frame:bytes()` | full frame | Returns a 1-indexed Lua byte array `{ b1, b2, ... }`. |

### 3.4 Zero-Offset Binary Writers & Fault Mutators

| Method | Signature | Description |
| :--- | :--- | :--- |
| `frame:set_u8` | `frame:set_u8(off, val)` | Write 1 unsigned byte at `off`. Returns `frame`. |
| `frame:set_u16_le` / `set_u16_be` | `frame:set_u16_le(off, val)` | Write 2-byte unsigned integer at `off`. Returns `frame`. |
| `frame:set_u32_le` / `set_u32_be` | `frame:set_u32_le(off, val)` | Write 4-byte unsigned integer at `off`. Returns `frame`. |
| `frame:xor_u8` | `frame:xor_u8(off, mask)` | XOR byte at `off` with `mask`. Returns `frame`. |
| `frame:xor_bit` | `frame:xor_bit(off, bit)` | Flip bit `bit` (`0..7`) at byte `off`. Returns `frame`. |
| `frame:set_bytes` | `frame:set_bytes(data)` | Replace entire frame payload from raw string, spaced hex, or byte table. Returns `frame`. |
| `frame:resize` | `frame:resize(new_len)` | Truncate or zero-pad frame to `new_len` bytes. Returns `frame`. |

### 3.5 Checksums & Verdict Controls

| Method | Signature | Description |
| :--- | :--- | :--- |
| `frame:recalc_crc` | `frame:recalc_crc(algo, [start_off, end_off])` | Recompute trailing checksum (`1`, `2`, or `4` bytes at end of frame) over `start_off..end_off` (default `0..len-width`). Returns `frame`. |
| `frame:corrupt_crc` | `frame:corrupt_crc([count])` | XOR the trailing `count` bytes (`1..4`, default `1`) with `0xFF`. Returns `frame`. |
| `frame:delay_ms` / `forward_after_ms` | `frame:delay_ms(ms)` | Delay frame forwarding by `ms` milliseconds. Returns `frame`. |
| `frame:drop` | `frame:drop()` | Mark frame to be dropped. Returns `frame`. |
