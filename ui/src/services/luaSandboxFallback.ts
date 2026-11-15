// Offline Lua 5.4 Sandbox Fallback & Starter Templates
// Used ONLY when the live Rust engine (/api/script) is unreachable (Simulated Mode / offline workbench / smoke).

import {
  DissectedField,
  PacketRow,
  ScriptActionView,
  ScriptAssertionView,
  ScriptDryRunView,
  ScriptFieldDiffView,
} from '../types';
import { crc8Atm, crc16CcittFalse, crc16Modbus, crc16Xmodem, crc32c } from '../utils/checksums';

export type ScriptTemplateId =
  | 'seu_bitflip'
  | 'mitm_glitch'
  | 'virtual_responder'
  | 'telemetry_plot'
  | 'watchdog_pins'
  | 'tutorial_01'
  | 'tutorial_02'
  | 'tutorial_03'
  | 'tutorial_04'
  | 'tutorial_05'
  | 'tutorial_06'
  | 'tutorial_07'
  | 'tutorial_08'
  | 'tutorial_09'
  | 'tutorial_10'
  | 'tutorial_11'
  | 'tutorial_12'
  | 'tutorial_13'
  | 'tutorial_14'
  | 'tutorial_15';

export interface ScriptTemplate {
  id: ScriptTemplateId;
  name: string;
  description: string;
  hook: string;
  source: string;
}

export const DEFAULT_TEST_FRAME_HEX =
  'AA 55 01 13 40 E2 01 00 1F F4 00 00 00 00 80 90 A0 B0 01 5B';

export const SCRIPT_TEMPLATES: Record<ScriptTemplateId, ScriptTemplate> = {
  seu_bitflip: {
    id: 'seu_bitflip',
    name: 'SEU Bit-Flip Injector',
    description: 'Flips a single bit in v_batt_mv via frame:xor_bit to test radiation SEU & CRC handling.',
    hook: 'on_rx_frame',
    source: `-- Single-Event Upset (SEU) Bit-Flip Injector
local hits = 0

bforge.on_rx_frame(function(frame)
  local vbatt = frame:get("v_batt_mv")
  bforge.assert("vbatt_present", vbatt ~= nil, "missing v_batt_mv field")

  hits = hits + 1
  bforge.metric("seu_hits", hits)

  -- Inject a single-bit flip at byte offset 8, bit 2 on frame #1 and every 5th frame
  if hits == 1 or (hits % 5) == 0 then
    frame:xor_bit(8, 2)
    bforge.log("warn", string.format("SEU bit-flip at byte 8 bit 2 (hit #%d)", hits))
    bforge.plot("seu_v_batt_mv", frame:get("v_batt_mv") or 0)
    -- Uncomment to repair trailing CRC after mutation:
    -- frame:recalc_crc("crc8")
    return frame
  end

  if vbatt then
    bforge.plot("seu_v_batt_mv", vbatt)
  end
  return frame
end)
`,
  },
  mitm_glitch: {
    id: 'mitm_glitch',
    name: 'MITM Bus Glitch & Delay',
    description: 'Intercepts MITM frames, lowers v_batt_mv, recalculates CRC, and injects +45 ms latency.',
    hook: 'on_mitm_frame',
    source: `-- Hardware-in-the-Middle (MITM) Voltage Glitch & Bus Latency
local glitched = 0

bforge.on_mitm_frame(function(frame, dir)
  local vbatt = frame:get("v_batt_mv")
  bforge.assert("has_vbatt_field", vbatt ~= nil, "v_batt_mv not found")

  if vbatt and vbatt > 6500 then
    local sag = math.max(5800, vbatt - 1200)
    frame:set("v_batt_mv", sag)
    frame:recalc_crc("crc8")
    frame:delay_ms(45)
    glitched = glitched + 1
    bforge.metric("mitm_glitched", glitched)
    bforge.plot("mitm_vbatt_sag", sag)
    bforge.log("info", string.format("MITM sag %d -> %d mV (+45ms)", vbatt, sag))
    return frame
  end

  return frame
end)
`,
  },
  virtual_responder: {
    id: 'virtual_responder',
    name: 'Virtual Responder (Auto-ACK)',
    description: 'Packs a binary ACK reply with string.pack and queues TX via bforge.send.',
    hook: 'on_rx_frame',
    source: `-- Virtual Hardware Responder (Auto-ACK / Ping Reply)
local replies = 0

bforge.on_rx_frame(function(frame)
  local version = frame:get("version") or 1
  bforge.assert("proto_v1", version == 1, "expected protocol v1")

  -- Pack compact ACK: sync (0xAA55 LE), cmd=0x81, status=0x00, seq_lo
  local ack = string.pack("<I2BBI2", 0xAA55, 0x81, 0x00, replies & 0xFFFF)
  bforge.send(frame.port or "COM8", ack, 5)

  replies = replies + 1
  bforge.metric("ack_sent", replies)
  bforge.log("info", string.format("Virtual responder queued ACK #%d (+5ms)", replies))
  return frame
end)
`,
  },
  telemetry_plot: {
    id: 'telemetry_plot',
    name: 'Telemetry Plot & Assert Monitor',
    description: 'Streams v_batt_mv and gyro_z into Plot Forge series and enforces health assertions.',
    hook: 'on_rx_frame',
    source: `-- Live Telemetry Extractor, Plotter & Health Assertions
local frames = 0

bforge.on_rx_frame(function(frame)
  frames = frames + 1
  local vbatt = frame:get("v_batt_mv") or 0
  local gyroz = frame:get("gyro_z") or 0

  bforge.plot("vbatt_mv", vbatt)
  bforge.plot("gyro_abs", math.abs(gyroz))
  bforge.metric("sampled_frames", frames)
  bforge.metric("last_vbatt_mv", vbatt)

  bforge.assert("vbatt_nominal", vbatt >= 6000 and vbatt <= 9000, "battery out of range")
  bforge.assert("gyro_in_bounds", math.abs(gyroz) < 5.0, "gyro saturation")
  return frame
end)
`,
  },
  watchdog_pins: {
    id: 'watchdog_pins',
    name: 'Watchdog Timer & Pin Pulse',
    description: 'Monitors RX cadence and pulses DTR 50 ms on timeout using bforge.on_timer.',
    hook: 'on_timer',
    source: `-- Telemetry Watchdog & Hardware Reset Pin Sequencer
local missed = 0
local healthy = 0

bforge.on_rx_frame(function(frame)
  missed = 0
  healthy = healthy + 1
  bforge.metric("watchdog_rx", healthy)
  bforge.assert("watchdog_alive", true)
  return frame
end)

bforge.on_timer(250, function()
  missed = missed + 1
  bforge.metric("watchdog_ticks", missed)
  if missed >= 4 then
    bforge.pulse_pin("DTR", 50)
    bforge.log("warn", "Watchdog timeout: pulsed DTR 50ms for target reset")
    missed = 0
  end
end)
`,
  },
  tutorial_01: {
    id: 'tutorial_01',
    name: '01: Packet Filter & Metadata',
    description: 'Inspects frame metadata and drops frames lacking the 0xAA 0x55 sync preamble.',
    hook: 'on_rx_frame',
    source: `-- Tutorial 01: Packet Filter & Frame Metadata
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
end)`,
  },
  tutorial_02: {
    id: 'tutorial_02',
    name: '02: Schema Assertions & Logging',
    description: 'Reads decoded schema fields via frame:get/fields and enforces voltage/mode bounds.',
    hook: 'on_rx_frame',
    source: `-- Tutorial 02: Schema Assertions & Rate-Limited Logging
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
end)`,
  },
  tutorial_03: {
    id: 'tutorial_03',
    name: '03: Derived Telemetry Plotting',
    description: 'Computes stateful EMA and peak-to-peak v_batt_mv and streams Plot Forge curves.',
    hook: 'on_rx_frame',
    source: `-- Tutorial 03: Derived Telemetry Plotting (EMA & Peak-to-Peak)
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
end)`,
  },
  tutorial_04: {
    id: 'tutorial_04',
    name: '04: Field Patching & CRC-8',
    description: 'Intercepts TX frames, offsets v_batt_mv by +100 mV, and repairs trailing CRC-8.',
    hook: 'on_tx_frame',
    source: `-- Tutorial 04: Named Field Patching & Trailing CRC-8 Recalculation
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
end)`,
  },
  tutorial_05: {
    id: 'tutorial_05',
    name: '05: Zero-Offset Binary Surgery',
    description: 'Reads and patches unaligned big/little-endian fields and slices raw bytes with no schema.',
    hook: 'on_tx_frame',
    source: `-- Tutorial 05: Zero-Offset Binary Surgery (No Schema Required)
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
end)`,
  },
  tutorial_06: {
    id: 'tutorial_06',
    name: '06: Deterministic SEU Fuzzer',
    description: 'Uses on_init + bforge.seed/rand to inject reproducible bit flips and corrupt trailing CRC.',
    hook: 'on_rx_frame',
    source: `-- Tutorial 06: Deterministic Single-Event Upset (SEU) Bit-Flip Fuzzer
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
end)`,
  },
  tutorial_07: {
    id: 'tutorial_07',
    name: '07: MITM Latency & Voltage Glitch',
    description: 'Branches on bridge direction, sags A->B battery telemetry, repairs CRC, and delays 45 ms.',
    hook: 'on_mitm_frame',
    source: `-- Tutorial 07: MITM Directional Latency & Voltage Glitch
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
end)`,
  },
  tutorial_08: {
    id: 'tutorial_08',
    name: '08: Multi-Schema Dynamic Dissect',
    description: 'Binds ImuPacket or EpsCommand at runtime with frame:dissect and recalculates per-protocol CRC.',
    hook: 'on_mitm_frame',
    source: `-- Tutorial 08: Multi-Schema Runtime Dissection (D-94)
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
end)`,
  },
  tutorial_09: {
    id: 'tutorial_09',
    name: '09: Burst Duplication & Split',
    description: 'Emits a timed burst (original, corrupted duplicate, and two split halves) via bforge.burst.',
    hook: 'on_tx_frame',
    source: `-- Tutorial 09: Packet Burst Duplication & Fragmented Split
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
end)`,
  },
  tutorial_10: {
    id: 'tutorial_10',
    name: '10: Virtual Device Responder',
    description: 'Unpacks header bits with string.unpack, computes CRC-16/MODBUS, and sends delayed ACK.',
    hook: 'on_rx_frame',
    source: `-- Tutorial 10: Virtual Device Auto-Responder
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
end)`,
  },
  tutorial_11: {
    id: 'tutorial_11',
    name: '11: Raw Chunk Pre-Framer Corruptor',
    description: 'Mutates pre-framer chunks by alternating 2-byte garbage prepends and half-length truncations.',
    hook: 'on_raw_chunk',
    source: `-- Tutorial 11: Raw Chunk Pre-Framer Corruptor
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
end)`,
  },
  tutorial_12: {
    id: 'tutorial_12',
    name: '12: Custom Dissector & Command',
    description: 'Publishes synthetic dissected fields via on_dissect and encodes CRC-16/XMODEM heater commands.',
    hook: 'on_dissect',
    source: `-- Tutorial 12: Custom Dissector & Command Payload Builder
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
end)`,
  },
  tutorial_13: {
    id: 'tutorial_13',
    name: '13: Timer Poller & RX Jitter',
    description: 'Polls periodically on on_timer and plots RX inter-arrival delta and jitter in microseconds.',
    hook: 'on_timer',
    source: `-- Tutorial 13: Periodic Timer Poller & RX Jitter Plotter
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
end)`,
  },
  tutorial_14: {
    id: 'tutorial_14',
    name: '14: Pin Reset & Alert Handler',
    description: 'Subscribes to dead_man_timer alerts and drives a DTR/RTS hardware recovery pulse sequence.',
    hook: 'on_alert',
    source: `-- Tutorial 14: Hardware Pin Reset & Watchdog Alert Handler
-- Concepts:
--   * Alert subscription via bforge.on_alert("dead_man_timer", fn(alert))
--   * Hardware control lines via bforge.set_pins, bforge.pulse_pin, and bforge.trigger_pin
--   * Automated MCU reset / bootloader recovery sequence

local resets = 0

bforge.on_alert("dead_man_timer", function(alert)
  resets = resets + 1
  bforge.log_warn(string.format(
    "recovery #%d on alert \`%s\`: %s",
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
end)`,
  },
  tutorial_15: {
    id: 'tutorial_15',
    name: '15: Fail-Closed Safety Interlock',
    description: 'Maintains a bounded ring buffer and drops unsafe TX frames when safety envelope checks trip.',
    hook: 'on_tx_frame',
    source: `-- Tutorial 15: Fail-Closed Safety Interlock & Resource Budget Guard
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
end)`,
  },
};

export const KNOWN_SCRIPT_HOOKS = [
  'on_init',
  'on_frame',
  'on_rx_frame',
  'on_tx_frame',
  'on_mitm_frame',
  'on_raw_chunk',
  'on_dissect',
  'on_timer',
  'on_alert',
  'on_command',
] as const;

export interface OfflineCompileResult {
  ok: boolean;
  hooks: string[];
  error: string | null;
}

export interface OfflineDryRunResult extends ScriptDryRunView {
  offline: true;
  hooks: string[];
}

export interface OfflineDryRunOptions {
  locals?: Record<string, LuaVal>;
  invocation?: number;
  seed?: number;
  name?: string;
  direction?: string;
  seqId?: number;
  timestampUs?: number;
  bridge?: string;
  hook?: string;
  commandName?: string;
  commandArgs?: Record<string, string>;
  alertName?: string;
  alertDetail?: string;
}

type LuaVal = number | string | boolean | null | LuaTable | LuaBinary | LuaCallable;

interface LuaBinary {
  __kind: 'binary';
  bytes: number[];
}

interface LuaMulti {
  __kind: 'multi';
  values: LuaVal[];
}

type LuaExprResult = LuaVal | LuaMulti;

interface LuaTable {
  __kind: 'table';
  array: LuaVal[];
  map: Record<string, LuaVal>;
  getters?: Record<string, () => LuaVal>;
}

interface LuaFunc {
  __kind: 'func';
  params: string[];
  body: Token[];
  closure: EnvFrame;
}

type LuaNativeFn = (args: LuaVal[], self?: LuaVal) => LuaVal;

interface LuaNative {
  __kind: 'native';
  fn: LuaNativeFn;
}

type LuaCallable = LuaFunc | LuaNative;

interface EnvFrame {
  vars: Record<string, LuaVal>;
  parent: EnvFrame | null;
}

type TokenKind = 'ident' | 'number' | 'string' | 'op' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  numValue?: number;
  line: number;
}

const LUA_KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
]);

const TWO_CHAR_OPS = new Set(['==', '~=', '<=', '>=', '//', '<<', '>>', '..']);

function tokenizeLua(source: string): { tokens: Token[]; error: string | null } {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const len = source.length;

  const matchLongBracket = (pos: number): number => {
    if (source[pos] !== '[') return -1;
    let eq = 0;
    let p = pos + 1;
    while (p < len && source[p] === '=') {
      eq++;
      p++;
    }
    return p < len && source[p] === '[' ? eq : -1;
  };

  const skipLongBracket = (startPos: number, eqCount: number): { endPos: number; text: string } | null => {
    let p = startPos + 2 + eqCount;
    if (source[p] === '\r' && source[p + 1] === '\n') {
      p += 2;
      line++;
    } else if (source[p] === '\n') {
      p++;
      line++;
    }
    const closeSeq = `]${'='.repeat(eqCount)}]`;
    const bodyStart = p;
    while (p < len) {
      if (source.startsWith(closeSeq, p)) {
        const text = source.slice(bodyStart, p);
        return { endPos: p + closeSeq.length, text };
      }
      if (source[p] === '\n') line++;
      p++;
    }
    return null;
  };

  while (i < len) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    // Comments: --[[ ... ]] or -- ...
    if (ch === '-' && source[i + 1] === '-') {
      const commentLine = line;
      const eq = matchLongBracket(i + 2);
      if (eq >= 0) {
        const res = skipLongBracket(i + 2, eq);
        if (!res) return { tokens, error: `line ${commentLine}: unterminated long comment` };
        i = res.endPos;
      } else {
        i += 2;
        while (i < len && source[i] !== '\n') i++;
      }
      continue;
    }

    // Long string [[ ... ]]
    const longEq = matchLongBracket(i);
    if (longEq >= 0) {
      const strLine = line;
      const res = skipLongBracket(i, longEq);
      if (!res) return { tokens, error: `line ${strLine}: unterminated long string` };
      tokens.push({ kind: 'string', value: res.text, line: strLine });
      i = res.endPos;
      continue;
    }

    // Short string '...' or "..."
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const strLine = line;
      i++;
      let out = '';
      let closed = false;
      while (i < len) {
        const c = source[i];
        if (c === '\n' || c === '\r') {
          return { tokens, error: `line ${strLine}: unfinished string` };
        }
        if (c === '\\') {
          i++;
          if (i >= len) return { tokens, error: `line ${strLine}: unfinished string escape` };
          const esc = source[i];
          if (esc === 'n') out += '\n';
          else if (esc === 'r') out += '\r';
          else if (esc === 't') out += '\t';
          else if (esc === '\\' || esc === '"' || esc === "'") out += esc;
          else if (esc === 'x' && /^[0-9a-fA-F]{2}/.test(source.slice(i + 1, i + 3))) {
            out += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16));
            i += 2;
          } else out += esc;
          i++;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        out += c;
        i++;
      }
      if (!closed) return { tokens, error: `line ${strLine}: unfinished string` };
      tokens.push({ kind: 'string', value: out, line: strLine });
      continue;
    }

    // Numbers: hex 0x..., decimal, float
    if ((ch >= '0' && ch <= '9') || (ch === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(source[i])) i++;
        const raw = source.slice(start, i);
        tokens.push({ kind: 'number', value: raw, numValue: parseInt(raw, 16), line });
      } else {
        while (i < len && /[0-9]/.test(source[i])) i++;
        if (source[i] === '.' && source[i + 1] !== '.') {
          i++;
          while (i < len && /[0-9]/.test(source[i])) i++;
        }
        if ((source[i] === 'e' || source[i] === 'E')) {
          i++;
          if (source[i] === '+' || source[i] === '-') i++;
          while (i < len && /[0-9]/.test(source[i])) i++;
        }
        const raw = source.slice(start, i);
        tokens.push({ kind: 'number', value: raw, numValue: Number(raw), line });
      }
      continue;
    }

    // Identifiers and keywords
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[A-Za-z0-9_]/.test(source[i])) i++;
      const word = source.slice(start, i);
      tokens.push({ kind: 'ident', value: word, line });
      continue;
    }

    // Three-char vararg
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'op', value: '...', line });
      i += 3;
      continue;
    }

    // Two-char operators
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ kind: 'op', value: two, line });
      i += 2;
      continue;
    }

    // Single-char punctuation/operators
    if ('+-*/%^#&~|<>=(){}[];:,.'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, line });
      i++;
      continue;
    }

    return { tokens, error: `line ${line}: unexpected character '${ch}'` };
  }

  tokens.push({ kind: 'eof', value: '', line });
  return { tokens, error: null };
}

/**
 * Validates balanced Lua 5.4 blocks (function/if/for/while/do/repeat..end/until)
 * and detects registered `bforge.on_*` hooks.
 */
export function compileLuaScriptOffline(source: string): OfflineCompileResult {
  const { tokens, error: lexError } = tokenizeLua(source);
  if (lexError) {
    return { ok: false, hooks: [], error: lexError };
  }

  const stack: Array<{ kind: string; line: number }> = [];
  let awaitingLoopDo = false;
  const hooks: string[] = [];

  const blockClosers = new Set(['function', 'if', 'for', 'while', 'do']);

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.kind === 'eof') break;

    // Detect `bforge.on_<hook>(`
    if (
      tok.kind === 'ident' &&
      tok.value === 'bforge' &&
      tokens[idx + 1]?.kind === 'op' &&
      tokens[idx + 1].value === '.' &&
      tokens[idx + 2]?.kind === 'ident' &&
      tokens[idx + 3]?.kind === 'op' &&
      tokens[idx + 3].value === '('
    ) {
      const hookName = tokens[idx + 2].value;
      if ((KNOWN_SCRIPT_HOOKS as readonly string[]).includes(hookName) && !hooks.includes(hookName)) {
        hooks.push(hookName);
      }
    }

    if (tok.kind === 'ident') {
      const w = tok.value;
      if (w === 'function' || w === 'if') {
        stack.push({ kind: w, line: tok.line });
      } else if (w === 'for' || w === 'while') {
        stack.push({ kind: w, line: tok.line });
        awaitingLoopDo = true;
      } else if (w === 'do') {
        if (awaitingLoopDo) {
          awaitingLoopDo = false;
        } else {
          stack.push({ kind: 'do', line: tok.line });
        }
      } else if (w === 'repeat') {
        stack.push({ kind: 'repeat', line: tok.line });
      } else if (w === 'else' || w === 'elseif') {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'if') {
          return { ok: false, hooks, error: `line ${tok.line}: unexpected '${w}' outside 'if'` };
        }
      } else if (w === 'until') {
        const top = stack.pop();
        if (!top || top.kind !== 'repeat') {
          return { ok: false, hooks, error: `line ${tok.line}: unexpected 'until' without 'repeat'` };
        }
      } else if (w === 'end') {
        const top = stack.pop();
        if (!top || !blockClosers.has(top.kind)) {
          return { ok: false, hooks, error: `line ${tok.line}: unexpected 'end'` };
        }
      }
    } else if (tok.kind === 'op') {
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        stack.push({ kind: tok.value, line: tok.line });
      } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        const want = tok.value === ')' ? '(' : tok.value === ']' ? '[' : '{';
        const top = stack.pop();
        if (!top || top.kind !== want) {
          return { ok: false, hooks, error: `line ${tok.line}: unmatched '${tok.value}'` };
        }
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    return {
      ok: false,
      hooks,
      error: `line ${unclosed.line}: unclosed '${unclosed.kind}'`,
    };
  }

  if (hooks.length === 0) {
    return {
      ok: false,
      hooks: [],
      error: 'Script must register at least one bforge.on_* hook (e.g. bforge.on_rx_frame)',
    };
  }

  return { ok: true, hooks, error: null };
}

export function formatSpacedHex(bytes: number[]): string {
  return bytes
    .map((b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function parseHexBytes(hex: string): number[] {
  const cleaned = hex.trim();
  if (!cleaned) return [];
  const out: number[] = [];
  for (const part of cleaned.split(/\s+/)) {
    const token = part.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,2}$/.test(token)) continue;
    out.push(parseInt(token, 16) & 0xff);
  }
  return out;
}

function inferImuFieldsFromBytes(bytes: number[]): DissectedField[] {
  if (bytes.length < 19 || bytes[0] !== 0xaa || bytes[1] !== 0x55) return [];
  const view = new DataView(new Uint8Array(bytes).buffer);
  const sync = view.getUint16(0, false);
  const version = bytes[2];
  const flagsByte = bytes[3];
  const flagsBits = flagsByte & 0x07;
  const channel = (flagsByte >> 3) & 0x1f;
  const timestampUs = view.getUint32(4, true);
  const vBattMv = view.getUint16(8, false);
  const gyroZ = parseFloat(view.getFloat32(10, true).toFixed(4));
  const samples = [bytes[14], bytes[15], bytes[16], bytes[17]];
  const mode = bytes[18];

  const fields: DissectedField[] = [
    {
      name: 'sync',
      type: 'uint16',
      offset: 0,
      length: 2,
      rawHex: formatSpacedHex(bytes.slice(0, 2)),
      decodedValue: `0x${sync.toString(16).padStart(4, '0').toUpperCase()}`,
    },
    {
      name: 'version',
      type: 'uint8',
      offset: 2,
      length: 1,
      rawHex: formatSpacedHex([version]),
      decodedValue: version,
    },
    {
      name: 'flags',
      type: 'bitfield (3b)',
      offset: 3,
      length: 1,
      rawHex: formatSpacedHex([flagsByte]),
      decodedValue: `0b${flagsBits.toString(2).padStart(3, '0')}`,
    },
    {
      name: 'channel',
      type: 'bitfield (5b)',
      offset: 3,
      length: 1,
      rawHex: formatSpacedHex([flagsByte]),
      decodedValue: channel,
    },
    {
      name: 'timestamp_us',
      type: 'uint32_le',
      offset: 4,
      length: 4,
      rawHex: formatSpacedHex(bytes.slice(4, 8)),
      decodedValue: timestampUs,
      unit: 'us',
    },
    {
      name: 'v_batt_mv',
      type: 'uint16_be',
      offset: 8,
      length: 2,
      rawHex: formatSpacedHex(bytes.slice(8, 10)),
      decodedValue: vBattMv,
      unit: 'mV',
    },
    {
      name: 'gyro_z',
      type: 'float32_le',
      offset: 10,
      length: 4,
      rawHex: formatSpacedHex(bytes.slice(10, 14)),
      decodedValue: gyroZ,
      unit: 'rad/s',
    },
    {
      name: 'samples',
      type: 'uint8[4]',
      offset: 14,
      length: 4,
      rawHex: formatSpacedHex(samples),
      decodedValue: `[${samples.join(', ')}]`,
    },
    {
      name: 'mode',
      type: 'enum mode_t',
      offset: 18,
      length: 1,
      rawHex: formatSpacedHex([mode]),
      decodedValue: mode,
    },
  ];

  if (bytes.length >= 20) {
    const checksum = bytes[19];
    fields.push({
      name: 'checksum',
      type: 'checksum8',
      offset: 19,
      length: 1,
      rawHex: formatSpacedHex([checksum]),
      decodedValue: `0x${checksum.toString(16).padStart(2, '0').toUpperCase()}`,
    });
  }
  return fields;
}

function inferEpsFieldsFromBytes(bytes: number[]): DissectedField[] {
  if (bytes.length < 7) return [];
  const view = new DataView(new Uint8Array(bytes).buffer);
  const sync = view.getUint16(0, false);
  const opcode = bytes[2];
  const holdTimeS = view.getUint32(3, true);
  const fields: DissectedField[] = [
    {
      name: 'sync',
      type: 'uint16',
      offset: 0,
      length: 2,
      rawHex: formatSpacedHex(bytes.slice(0, 2)),
      decodedValue: `0x${sync.toString(16).padStart(4, '0').toUpperCase()}`,
    },
    {
      name: 'opcode',
      type: 'uint8',
      offset: 2,
      length: 1,
      rawHex: formatSpacedHex([opcode]),
      decodedValue: opcode,
    },
    {
      name: 'hold_time_s',
      type: 'uint32_le',
      offset: 3,
      length: 4,
      rawHex: formatSpacedHex(bytes.slice(3, 7)),
      decodedValue: holdTimeS,
      unit: 's',
    },
  ];
  if (bytes.length >= 9) {
    const checksum = view.getUint16(7, true);
    fields.push({
      name: 'checksum',
      type: 'uint16_le',
      offset: 7,
      length: 2,
      rawHex: formatSpacedHex(bytes.slice(7, 9)),
      decodedValue: checksum,
    });
  }
  return fields;
}

function decodeFieldFromBytes(field: DissectedField, bytes: number[]): string | number | boolean {
  const { offset, length, type, name } = field;
  if (offset < 0 || offset + length > bytes.length) return field.decodedValue;
  const slice = bytes.slice(offset, offset + length);
  const dv = new DataView(new Uint8Array(slice).buffer);

  if (name === 'flags' && length === 1) {
    return `0b${(slice[0] & 0x07).toString(2).padStart(3, '0')}`;
  }
  if (name === 'channel' && length === 1) {
    return (slice[0] >> 3) & 0x1f;
  }
  if (name === 'sync' && length === 2) {
    return `0x${dv.getUint16(0, false).toString(16).padStart(4, '0').toUpperCase()}`;
  }
  if (name === 'checksum' && length === 1) {
    return `0x${slice[0].toString(16).padStart(2, '0').toUpperCase()}`;
  }
  if (type.includes('float32') && length === 4) {
    const little = !type.includes('_be');
    return Number(dv.getFloat32(0, little).toFixed(4));
  }
  if ((type.includes('uint16') || length === 2) && !type.includes('array')) {
    const little = type.includes('_le');
    const raw = dv.getUint16(0, little);
    if (field.unit === 'V' && typeof field.decodedValue === 'string' && Number(field.decodedValue) < 100) {
      return raw;
    }
    return raw;
  }
  if ((type.includes('uint32') || length === 4) && !type.includes('uint8[')) {
    const little = !type.includes('_be');
    return dv.getUint32(0, little);
  }
  if (type.includes('uint8') && length === 1) {
    return slice[0];
  }
  return formatSpacedHex(slice);
}

function normalizedNumericFieldValue(field: DissectedField, bytes: number[]): number | string {
  // Always decode from current bytes when possible so xor_bit / set stay consistent.
  const decoded = decodeFieldFromBytes(field, bytes);
  if (typeof decoded === 'number') return decoded;
  if (field.name.endsWith('_mv') && field.unit === 'V') {
    const parsed = parseFloat(String(field.decodedValue));
    if (Number.isFinite(parsed) && Math.abs(parsed) < 100) {
      return Math.round(parsed * 1000);
    }
  }
  if (typeof field.decodedValue === 'number') return field.decodedValue;
  const match = /-?\d+(?:\.\d+)?/.exec(String(decoded));
  if (match && field.name !== 'sync' && field.name !== 'checksum' && field.name !== 'flags') {
    return parseFloat(match[0]);
  }
  return String(decoded);
}

function patchFieldIntoBytes(field: DissectedField, bytes: number[], value: number | string): boolean {
  const { offset, length, type } = field;
  if (offset < 0 || offset + length > bytes.length) return false;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(num)) return false;

  const buf = new ArrayBuffer(Math.max(4, length));
  const dv = new DataView(buf);
  if (type.includes('float32') && length === 4) {
    dv.setFloat32(0, num, !type.includes('_be'));
  } else if (length === 1) {
    dv.setUint8(0, Math.round(num) & 0xff);
  } else if (length === 2) {
    dv.setUint16(0, Math.round(num) & 0xffff, type.includes('_le'));
  } else if (length === 4) {
    dv.setUint32(0, Math.round(num) >>> 0, !type.includes('_be'));
  } else {
    return false;
  }
  for (let i = 0; i < length; i++) {
    bytes[offset + i] = dv.getUint8(i);
  }
  return true;
}

function luaTruthy(v: LuaVal): boolean {
  return v !== null && v !== false && v !== undefined;
}

function luaNum(v: LuaVal, label = 'number'): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new Error(`expected ${label}`);
}

function luaFormat(fmt: string, args: LuaVal[]): string {
  let argIdx = 0;
  return fmt.replace(/%([+\-# 0]*)(\d*)(?:\.(\d+))?([diuxXofcs%])/g, (_m, flags: string, widthStr: string, precStr: string | undefined, conv: string) => {
    if (conv === '%') return '%';
    const raw = args[argIdx++];
    const width = widthStr ? Number(widthStr) : 0;
    const padChar = flags.includes('0') && !flags.includes('-') ? '0' : ' ';
    const leftAlign = flags.includes('-');
    const pad = (str: string) => {
      if (width <= str.length) return str;
      const fill = padChar.repeat(width - str.length);
      return leftAlign ? str + ' '.repeat(width - str.length) : fill + str;
    };

    if (conv === 's') {
      const s = raw === null || raw === undefined ? 'nil' : String(raw);
      const clipped = precStr !== undefined ? s.slice(0, Number(precStr)) : s;
      return pad(clipped);
    }
    if (conv === 'c') return pad(String.fromCharCode(Number(raw) || 0));
    const n = Number(raw ?? 0);
    if (conv === 'd' || conv === 'i') {
      const trunc = Math.trunc(n);
      const sign = trunc < 0 ? '-' : '';
      const digits = String(Math.abs(trunc));
      if (padChar === '0' && sign) {
        return width > digits.length + 1 ? sign + '0'.repeat(width - digits.length - 1) + digits : sign + digits;
      }
      return pad(sign + digits);
    }
    if (conv === 'u') return pad(String(Math.trunc(n) >>> 0));
    if (conv === 'x') return pad((Math.trunc(n) >>> 0).toString(16));
    if (conv === 'X') return pad((Math.trunc(n) >>> 0).toString(16).toUpperCase());
    if (conv === 'o') return pad((Math.trunc(n) >>> 0).toString(8));
    if (conv === 'f') {
      const prec = precStr !== undefined ? Number(precStr) : 6;
      return pad(n.toFixed(prec));
    }
    return String(raw ?? '');
  });
}

function luaPack(fmt: string, args: LuaVal[]): LuaBinary {
  let little = true;
  let argIdx = 0;
  const out: number[] = [];

  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '<') {
      little = true;
      continue;
    }
    if (ch === '>') {
      little = false;
      continue;
    }
    if (ch === ' ' || ch === '=') continue;
    let size = 1;
    const kind = ch;
    if ((ch === 'i' || ch === 'I') && i + 1 < fmt.length && /[1-8]/.test(fmt[i + 1])) {
      size = Number(fmt[++i]);
    } else if (ch === 'h' || ch === 'H') {
      size = 2;
    } else if (ch === 'f') {
      size = 4;
    } else if (ch === 'd') {
      size = 8;
    } else if (ch === 'i' || ch === 'I') {
      size = 4;
    }

    const val = Number(args[argIdx++] ?? 0);
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    if (kind === 'b') dv.setInt8(0, Math.trunc(val));
    else if (kind === 'B') dv.setUint8(0, Math.trunc(val) & 0xff);
    else if (kind === 'h') dv.setInt16(0, Math.trunc(val), little);
    else if (kind === 'H') dv.setUint16(0, Math.trunc(val) & 0xffff, little);
    else if (kind === 'f') dv.setFloat32(0, val, little);
    else if (kind === 'd') dv.setFloat64(0, val, little);
    else if (size === 1) dv.setUint8(0, Math.trunc(val) & 0xff);
    else if (size === 2) dv.setUint16(0, Math.trunc(val) & 0xffff, little);
    else if (size === 4) dv.setUint32(0, Math.trunc(val) >>> 0, little);
    else if (size === 8) dv.setBigUint64(0, BigInt(Math.trunc(val)), little);

    for (let k = 0; k < size; k++) out.push(dv.getUint8(k));
  }

  return { __kind: 'binary', bytes: out };
}

function luaRawBytesOf(v: LuaVal): number[] {
  if (v && typeof v === 'object' && v.__kind === 'binary') return [...v.bytes];
  if (typeof v === 'string') return Array.from(v, (c) => c.charCodeAt(0) & 0xff);
  if (typeof v === 'number') return Array.from(String(v), (c) => c.charCodeAt(0) & 0xff);
  throw new Error('expected binary string');
}

function luaUnpack(fmt: string, data: LuaVal, startPos = 1): LuaMulti {
  const bytes = luaRawBytesOf(data);
  let little = true;
  let offset = startPos < 0 ? Math.max(0, bytes.length + startPos) : Math.max(0, Math.trunc(startPos) - 1);
  const results: LuaVal[] = [];

  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '<') {
      little = true;
      continue;
    }
    if (ch === '>') {
      little = false;
      continue;
    }
    if (ch === ' ' || ch === '=') continue;
    let size = 1;
    const kind = ch;
    if ((ch === 'i' || ch === 'I') && i + 1 < fmt.length && /[1-8]/.test(fmt[i + 1])) {
      size = Number(fmt[++i]);
    } else if (ch === 'h' || ch === 'H') {
      size = 2;
    } else if (ch === 'f') {
      size = 4;
    } else if (ch === 'd') {
      size = 8;
    } else if (ch === 'i' || ch === 'I') {
      size = 4;
    }
    if (offset + size > bytes.length) {
      throw new Error(`string.unpack data string too short at offset ${offset}`);
    }
    const dv = new DataView(new Uint8Array(bytes.slice(offset, offset + size)).buffer);
    let val: number;
    if (kind === 'b') val = dv.getInt8(0);
    else if (kind === 'B') val = dv.getUint8(0);
    else if (kind === 'h') val = dv.getInt16(0, little);
    else if (kind === 'H') val = dv.getUint16(0, little);
    else if (kind === 'f') val = dv.getFloat32(0, little);
    else if (kind === 'd') val = dv.getFloat64(0, little);
    else if (kind === 'i') {
      if (size === 1) val = dv.getInt8(0);
      else if (size === 2) val = dv.getInt16(0, little);
      else if (size === 4) val = dv.getInt32(0, little);
      else {
        let acc = 0n;
        for (let k = 0; k < size; k++) {
          const byte = BigInt(dv.getUint8(little ? k : size - 1 - k));
          acc |= byte << BigInt(k * 8);
        }
        val = Number(BigInt.asIntN(size * 8, acc));
      }
    } else {
      if (size === 1) val = dv.getUint8(0);
      else if (size === 2) val = dv.getUint16(0, little);
      else if (size === 4) val = dv.getUint32(0, little);
      else {
        let acc = 0n;
        for (let k = 0; k < size; k++) {
          const byte = BigInt(dv.getUint8(little ? k : size - 1 - k));
          acc |= byte << BigInt(k * 8);
        }
        val = Number(acc);
      }
    }
    results.push(val);
    offset += size;
  }

  results.push(offset + 1);
  return { __kind: 'multi', values: results };
}

function luaPacksize(fmt: string): number {
  let total = 0;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '<' || ch === '>' || ch === ' ' || ch === '=') continue;
    if ((ch === 'i' || ch === 'I') && i + 1 < fmt.length && /[1-8]/.test(fmt[i + 1])) {
      total += Number(fmt[++i]);
    } else if (ch === 'h' || ch === 'H') total += 2;
    else if (ch === 'f' || ch === 'i' || ch === 'I') total += 4;
    else if (ch === 'd') total += 8;
    else total += 1;
  }
  return total;
}

function unwrapSingle(v: LuaExprResult): LuaVal {
  if (v && typeof v === 'object' && v.__kind === 'multi') {
    return v.values[0] ?? null;
  }
  return v;
}

function expandMultiList(vals: LuaExprResult[]): LuaVal[] {
  if (vals.length === 0) return [];
  const out: LuaVal[] = [];
  for (let i = 0; i < vals.length - 1; i++) {
    out.push(unwrapSingle(vals[i]));
  }
  const last = vals[vals.length - 1];
  if (last && typeof last === 'object' && last.__kind === 'multi') {
    out.push(...last.values);
  } else {
    out.push(last);
  }
  return out;
}

function luaShift(left: number, right: number, direction: '<<' | '>>'): number {
  const l = BigInt(Math.trunc(left));
  const r = Math.trunc(right);
  if (r === 0) return Number(BigInt.asIntN(64, l));
  const goLeft = (direction === '<<' && r > 0) || (direction === '>>' && r < 0);
  const mag = BigInt(Math.abs(r));
  if (mag >= 64n) return 0;
  const u = BigInt.asUintN(64, l);
  const res = goLeft ? BigInt.asIntN(64, u << mag) : BigInt.asIntN(64, u >> mag);
  return Number(res);
}

const DEFAULT_RNG_SEED = 0x5eedba0df09e0001n;

function normalizeSeed(seedVal: number): bigint {
  if (!Number.isFinite(seedVal)) return DEFAULT_RNG_SEED;
  const s = BigInt.asUintN(64, BigInt(Math.trunc(seedVal)));
  return s === 0n ? DEFAULT_RNG_SEED : s;
}

function parseLuaBytesInput(val: LuaVal): number[] {
  if (val && typeof val === 'object') {
    if (val.__kind === 'binary') return [...val.bytes];
    if (val.__kind === 'table') {
      if (val.getters?.hex) {
        return parseHexBytes(String(val.getters.hex() ?? ''));
      }
      if (typeof val.map.hex === 'string') {
        return parseHexBytes(val.map.hex);
      }
      const bytes: number[] = [];
      for (let i = 1; i < val.array.length; i++) {
        if (val.array[i] !== undefined) bytes.push(Number(val.array[i]) & 0xff);
      }
      return bytes;
    }
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2})*$/.test(trimmed)) {
      return parseHexBytes(trimmed);
    }
    return Array.from(val, (c) => c.charCodeAt(0) & 0xff);
  }
  throw new Error('expected bytes, spaced hex, or byte table');
}

function computeCrcByName(algo: string, payload: number[]): { width: 1 | 2 | 4; value: number } {
  const kind = algo.toLowerCase();
  if (kind === 'crc8' || kind === 'crc8_atm') {
    return { width: 1, value: crc8Atm(payload) & 0xff };
  }
  if (kind === 'sum8') {
    return { width: 1, value: payload.reduce((a, b) => (a + b) & 0xff, 0) };
  }
  if (kind === 'crc16' || kind === 'crc16_ccitt_false') {
    return { width: 2, value: crc16CcittFalse(payload) & 0xffff };
  }
  if (kind === 'crc16_modbus') {
    return { width: 2, value: crc16Modbus(payload) & 0xffff };
  }
  if (kind === 'crc16_xmodem') {
    return { width: 2, value: crc16Xmodem(payload) & 0xffff };
  }
  if (kind === 'crc32c') {
    return { width: 4, value: crc32c(payload) >>> 0 };
  }
  throw new Error(
    `\`${algo}\` is not a supported checksum; use crc8, crc16_ccitt_false, crc16_modbus, crc16_xmodem or crc32c`
  );
}

class ReturnSignal {
  constructor(
    public readonly value: LuaExprResult,
    public readonly hasValue = true
  ) {}
}

class BreakSignal {}

const FORBIDDEN_GLOBALS = new Set(['io', 'os', 'require', 'dofile', 'loadfile', 'debug']);

/**
 * Runs a lightweight deterministic TypeScript simulation of the Lua 5.4 script
 * on a PacketRow or spaced hex string when the engine is offline.
 */
export function dryRunLuaScriptOffline(
  source: string,
  packetOrHex: PacketRow | string,
  port = 'COM8',
  _policy: 'fail_open' | 'fail_closed' = 'fail_open',
  opts: OfflineDryRunOptions = {}
): OfflineDryRunResult {
  const pkt = typeof packetOrHex === 'string' ? null : packetOrHex;
  const beforeBytes = pkt ? [...pkt.rawBytes] : parseHexBytes(packetOrHex as string);
  const inputHex = formatSpacedHex(beforeBytes);
  const timestampUs = opts.timestampUs ?? pkt?.timestampUs ?? Date.now() * 1000;
  const seqId = opts.seqId ?? pkt?.seqId ?? 1;
  const activePort = pkt?.port || port;
  const bridgeName = opts.bridge ?? null;
  const memBytes = 24_576 + source.length * 4;

  const compile = compileLuaScriptOffline(source);
  if (!compile.ok) {
    return {
      ok: false,
      verdict: 'error',
      mutated: false,
      input_hex: inputHex,
      output_hex: inputHex,
      delay_ms: 0,
      burst_frames: [],
      field_diffs: [],
      instructions: 0,
      exec_us: 0,
      memory_bytes: memBytes,
      actions: [],
      metrics: {},
      assertions: [],
      error: compile.error,
      offline: true,
      hooks: compile.hooks,
    };
  }

  const { tokens } = tokenizeLua(source);
  let activeFields: DissectedField[] =
    pkt && pkt.dissectedFields?.length > 0
      ? pkt.dissectedFields
      : inferImuFieldsFromBytes(beforeBytes);

  const afterBytes = [...beforeBytes];
  const patchedFieldValues = new Map<string, number | string>();
  const initialFieldSnapshots = new Map<string, string>();
  const snapshotInitialFields = (fields: DissectedField[]) => {
    for (const f of fields) {
      if (!initialFieldSnapshots.has(f.name)) {
        initialFieldSnapshots.set(f.name, String(normalizedNumericFieldValue(f, beforeBytes)));
      }
    }
  };
  snapshotInitialFields(activeFields);

  const customFields: Array<{
    name: string;
    offset: number;
    length: number;
    display: string;
    num: number | null;
  }> = [];

  const actions: ScriptActionView[] = [];
  const metrics: Record<string, string> = {};
  const metricValues = new Map<string, number | string>();
  const assertionMap = new Map<string, ScriptAssertionView>();
  const burstFrames: Array<{ hex: string; delay_ms: number }> = [];
  let isBurstReturn = false;
  let delayMs = 0;
  let dropped = false;
  let steps = 0;
  const STEP_LIMIT = 20_000;
  let rngState = normalizeSeed(opts.seed ?? 0);
  const simStartMs = Date.now();
  let simClockUs = 10_000;

  interface RegisteredHook {
    target: string;
    fn: LuaFunc;
    intervalMs?: number;
  }
  const hooksByName = new Map<string, RegisteredHook[]>();
  const pushHook = (hookName: string, entry: RegisteredHook) => {
    const list = hooksByName.get(hookName) ?? [];
    list.push(entry);
    hooksByName.set(hookName, list);
  };
  let activeDirection = opts.direction ?? pkt?.direction?.toLowerCase() ?? 'rx';

  const stepTick = () => {
    steps++;
    if (steps > STEP_LIMIT) {
      throw new Error('instruction budget exceeded');
    }
  };

  const makeTable = (
    map: Record<string, LuaVal> = {},
    array: LuaVal[] = [],
    getters?: Record<string, () => LuaVal>
  ): LuaTable => ({
    __kind: 'table',
    array,
    map,
    ...(getters ? { getters } : {}),
  });

  const readDataView = (offArg: LuaVal, size: number, label: string): DataView => {
    const off = Math.trunc(luaNum(offArg, 'offset'));
    if (off < 0 || off + size > afterBytes.length) {
      throw new Error(`${label} offset ${off}..${off + size} out of bounds (len ${afterBytes.length})`);
    }
    return new DataView(new Uint8Array(afterBytes.slice(off, off + size)).buffer);
  };

  const writeDataView = (offArg: LuaVal, size: number, label: string, writer: (dv: DataView) => void) => {
    const off = Math.trunc(luaNum(offArg, 'offset'));
    if (off < 0 || off + size > afterBytes.length) {
      throw new Error(`${label} offset ${off}..${off + size} out of bounds (len ${afterBytes.length})`);
    }
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    writer(dv);
    for (let k = 0; k < size; k++) {
      afterBytes[off + k] = dv.getUint8(k);
    }
  };

  const getFieldValue = (name: string): LuaVal => {
    if (patchedFieldValues.has(name)) {
      return patchedFieldValues.get(name)!;
    }
    const custom = customFields.find((c) => c.name === name);
    if (custom) {
      return custom.num !== null ? custom.num : custom.display;
    }
    const f = activeFields.find((fld) => fld.name === name);
    if (!f) return null;
    return normalizedNumericFieldValue(f, afterBytes);
  };

  const frameTable: LuaTable = makeTable(
    {
      get: {
        __kind: 'native',
        fn: (args) => getFieldValue(String(args[0] ?? '')),
      },
      set: {
        __kind: 'native',
        fn: (args) => {
          const name = String(args[0] ?? '');
          const val = args[1];
          if (typeof val !== 'number' && typeof val !== 'string') {
            throw new Error(`\`${name}\` needs a number or a label`);
          }
          const f = activeFields.find((fld) => fld.name === name);
          if (f && patchFieldIntoBytes(f, afterBytes, val)) {
            patchedFieldValues.delete(name);
          } else {
            patchedFieldValues.set(name, val);
          }
          return null;
        },
      },
      fields: {
        __kind: 'native',
        fn: () => {
          const tbl = makeTable();
          for (const f of activeFields) {
            tbl.map[f.name] = normalizedNumericFieldValue(f, afterBytes);
          }
          for (const [k, v] of patchedFieldValues.entries()) {
            tbl.map[k] = v;
          }
          for (const c of customFields) {
            tbl.map[c.name] = c.num !== null ? c.num : c.display;
          }
          return tbl;
        },
      },
      dissect: {
        __kind: 'native',
        fn: (args) => {
          const rawTag = String(args[0] ?? '');
          const tag = rawTag.replace(/^(?:C_STRUCT|schema):/i, '');
          if (tag === 'ImuPacket' && afterBytes.length >= 19) {
            activeFields = inferImuFieldsFromBytes([0xaa, 0x55, ...afterBytes.slice(2)]);
            snapshotInitialFields(activeFields);
            return frameTable;
          }
          if (tag === 'EpsCommand' && afterBytes.length >= 7) {
            activeFields = inferEpsFieldsFromBytes(afterBytes);
            snapshotInitialFields(activeFields);
            return frameTable;
          }
          return null;
        },
      },
      add_field: {
        __kind: 'native',
        fn: (args) => {
          const name = String(args[0] ?? '');
          const offset = Math.max(0, Math.trunc(luaNum(args[1], 'offset')));
          const length = Math.max(0, Math.trunc(luaNum(args[2], 'len')));
          const display = String(args[3] ?? '');
          const num = typeof args[4] === 'number' && Number.isFinite(args[4]) ? args[4] : null;
          customFields.push({ name, offset, length, display, num });
          return null;
        },
      },
      u8: { __kind: 'native', fn: (args) => readDataView(args[0], 1, 'u8').getUint8(0) },
      i8: { __kind: 'native', fn: (args) => readDataView(args[0], 1, 'i8').getInt8(0) },
      u16_le: { __kind: 'native', fn: (args) => readDataView(args[0], 2, 'u16_le').getUint16(0, true) },
      u16_be: { __kind: 'native', fn: (args) => readDataView(args[0], 2, 'u16_be').getUint16(0, false) },
      i16_le: { __kind: 'native', fn: (args) => readDataView(args[0], 2, 'i16_le').getInt16(0, true) },
      i16_be: { __kind: 'native', fn: (args) => readDataView(args[0], 2, 'i16_be').getInt16(0, false) },
      u32_le: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'u32_le').getUint32(0, true) },
      u32_be: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'u32_be').getUint32(0, false) },
      i32_le: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'i32_le').getInt32(0, true) },
      i32_be: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'i32_be').getInt32(0, false) },
      f32_le: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'f32_le').getFloat32(0, true) },
      f32_be: { __kind: 'native', fn: (args) => readDataView(args[0], 4, 'f32_be').getFloat32(0, false) },
      f64_le: { __kind: 'native', fn: (args) => readDataView(args[0], 8, 'f64_le').getFloat64(0, true) },
      f64_be: { __kind: 'native', fn: (args) => readDataView(args[0], 8, 'f64_be').getFloat64(0, false) },
      set_u8: {
        __kind: 'native',
        fn: (args) => {
          const v = Math.trunc(luaNum(args[1], 'u8')) & 0xff;
          writeDataView(args[0], 1, 'set_u8', (dv) => dv.setUint8(0, v));
          return null;
        },
      },
      set_u16_le: {
        __kind: 'native',
        fn: (args) => {
          const v = Math.trunc(luaNum(args[1], 'u16')) & 0xffff;
          writeDataView(args[0], 2, 'set_u16_le', (dv) => dv.setUint16(0, v, true));
          return null;
        },
      },
      set_u16_be: {
        __kind: 'native',
        fn: (args) => {
          const v = Math.trunc(luaNum(args[1], 'u16')) & 0xffff;
          writeDataView(args[0], 2, 'set_u16_be', (dv) => dv.setUint16(0, v, false));
          return null;
        },
      },
      set_u32_le: {
        __kind: 'native',
        fn: (args) => {
          const v = Math.trunc(luaNum(args[1], 'u32')) >>> 0;
          writeDataView(args[0], 4, 'set_u32_le', (dv) => dv.setUint32(0, v, true));
          return null;
        },
      },
      set_u32_be: {
        __kind: 'native',
        fn: (args) => {
          const v = Math.trunc(luaNum(args[1], 'u32')) >>> 0;
          writeDataView(args[0], 4, 'set_u32_be', (dv) => dv.setUint32(0, v, false));
          return null;
        },
      },
      xor_u8: {
        __kind: 'native',
        fn: (args) => {
          const off = Math.trunc(luaNum(args[0], 'byte offset'));
          const mask = Math.trunc(luaNum(args[1], 'xor mask')) & 0xff;
          if (off < 0 || off >= afterBytes.length) {
            throw new Error(`xor_u8 offset ${off} out of bounds (len ${afterBytes.length})`);
          }
          afterBytes[off] = (afterBytes[off] ^ mask) & 0xff;
          return null;
        },
      },
      xor_bit: {
        __kind: 'native',
        fn: (args) => {
          const off = Math.trunc(luaNum(args[0], 'byte offset'));
          const bit = Math.trunc(luaNum(args[1], 'bit index'));
          if (off < 0 || off >= afterBytes.length) {
            throw new Error(`xor_bit offset ${off} out of range (0..${afterBytes.length - 1})`);
          }
          if (bit < 0 || bit > 7) {
            throw new Error(`xor_bit bit ${bit} out of range (0..7)`);
          }
          afterBytes[off] = (afterBytes[off] ^ (1 << bit)) & 0xff;
          return null;
        },
      },
      slice: {
        __kind: 'native',
        fn: (args) => {
          const off = Math.trunc(luaNum(args[0], 'slice offset'));
          const len = Math.trunc(luaNum(args[1], 'slice length'));
          if (off < 0 || len < 0 || off + len > afterBytes.length) {
            throw new Error(`slice ${off}..${off + len} out of bounds (len ${afterBytes.length})`);
          }
          return { __kind: 'binary', bytes: afterBytes.slice(off, off + len) };
        },
      },
      raw: {
        __kind: 'native',
        fn: () => ({ __kind: 'binary', bytes: [...afterBytes] }),
      },
      clone_bytes: {
        __kind: 'native',
        fn: () => ({ __kind: 'binary', bytes: [...afterBytes] }),
      },
      set_bytes: {
        __kind: 'native',
        fn: (args) => {
          const next = parseLuaBytesInput(args[0]);
          afterBytes.splice(0, afterBytes.length, ...next);
          return null;
        },
      },
      resize: {
        __kind: 'native',
        fn: (args) => {
          const nextLen = Math.max(0, Math.min(65_536, Math.trunc(luaNum(args[0], 'resize length'))));
          if (nextLen < afterBytes.length) {
            afterBytes.length = nextLen;
          } else {
            while (afterBytes.length < nextLen) afterBytes.push(0);
          }
          return null;
        },
      },
      recalc_crc: {
        __kind: 'native',
        fn: (args) => {
          const algo = String(args[0] ?? 'crc8');
          const probe = computeCrcByName(algo, []);
          if (afterBytes.length < probe.width) {
            throw new Error('the frame is shorter than its checksum');
          }
          const split = afterBytes.length - probe.width;
          const start = args[1] != null ? Math.trunc(luaNum(args[1], 'start')) : 0;
          const end = args[2] != null ? Math.trunc(luaNum(args[2], 'end')) : split;
          if (start < 0 || start > end || end > split) {
            throw new Error(`recalc_crc range ${start}..${end} invalid for payload split ${split}`);
          }
          const { width, value } = computeCrcByName(algo, afterBytes.slice(start, end));
          if (width === 1) {
            afterBytes[split] = value & 0xff;
          } else if (width === 2) {
            afterBytes[split] = value & 0xff;
            afterBytes[split + 1] = (value >> 8) & 0xff;
          } else {
            afterBytes[split] = value & 0xff;
            afterBytes[split + 1] = (value >> 8) & 0xff;
            afterBytes[split + 2] = (value >> 16) & 0xff;
            afterBytes[split + 3] = (value >>> 24) & 0xff;
          }
          return frameTable;
        },
      },
      corrupt_crc: {
        __kind: 'native',
        fn: (args) => {
          const countRaw = args[0] != null ? Math.trunc(luaNum(args[0], 'count')) : 1;
          const count = Math.max(1, Math.min(4, countRaw));
          if (afterBytes.length < count) {
            throw new Error(`frame length ${afterBytes.length} is shorter than corrupt_crc count ${count}`);
          }
          const start = afterBytes.length - count;
          for (let i = start; i < afterBytes.length; i++) {
            afterBytes[i] = (afterBytes[i] ^ 0xff) & 0xff;
          }
          return frameTable;
        },
      },
      delay_ms: {
        __kind: 'native',
        fn: (args) => {
          delayMs = Math.max(0, Math.round(luaNum(args[0], 'delay_ms')));
          return frameTable;
        },
      },
      forward_after_ms: {
        __kind: 'native',
        fn: (args) => {
          delayMs = Math.max(0, Math.round(luaNum(args[0], 'delay_ms')));
          return frameTable;
        },
      },
      drop: {
        __kind: 'native',
        fn: () => {
          dropped = true;
          return frameTable;
        },
      },
      bytes: {
        __kind: 'native',
        fn: () => formatSpacedHex(afterBytes),
      },
    },
    [],
    {
      hex: () => formatSpacedHex(afterBytes),
      len: () => afterBytes.length,
      port: () => activePort,
      direction: () => activeDirection,
      seq_id: () => seqId,
      timestamp_us: () => timestampUs,
      bridge: () => bridgeName,
    }
  );

  const makeScopedHookReg = (hookName: string): LuaNative => ({
    __kind: 'native',
    fn: (args) => {
      if (args[0] && typeof args[0] === 'object' && args[0].__kind === 'func') {
        pushHook(hookName, { target: '*', fn: args[0] });
      } else if (typeof args[0] === 'string' && args[1] && typeof args[1] === 'object' && args[1].__kind === 'func') {
        pushHook(hookName, { target: args[0], fn: args[1] });
      } else {
        throw new Error(`\`bforge.${hookName}\` expects \`(fn)\` or \`(target, fn)\``);
      }
      return null;
    },
  });

  const makeSingleHookReg = (hookName: string): LuaNative => ({
    __kind: 'native',
    fn: (args) => {
      const cb = args[1] && typeof args[1] === 'object' && args[1].__kind === 'func' ? args[1] : args[0];
      if (!cb || typeof cb !== 'object' || cb.__kind !== 'func') {
        throw new Error(`\`bforge.${hookName}\` expects a callback function`);
      }
      pushHook(hookName, { target: '*', fn: cb });
      return null;
    },
  });

  const bforgeTable = makeTable({
    on_init: makeSingleHookReg('on_init'),
    on_frame: makeSingleHookReg('on_frame'),
    on_rx_frame: makeScopedHookReg('on_rx_frame'),
    on_tx_frame: makeScopedHookReg('on_tx_frame'),
    on_mitm_frame: makeScopedHookReg('on_mitm_frame'),
    on_raw_chunk: makeScopedHookReg('on_raw_chunk'),
    on_dissect: makeScopedHookReg('on_dissect'),
    on_alert: makeScopedHookReg('on_alert'),
    on_command: {
      __kind: 'native',
      fn: (args) => {
        if (typeof args[0] !== 'string' || !args[1] || typeof args[1] !== 'object' || args[1].__kind !== 'func') {
          throw new Error('`bforge.on_command` expects `(name, fn)`');
        }
        pushHook('on_command', { target: args[0], fn: args[1] });
        return null;
      },
    },
    on_timer: {
      __kind: 'native',
      fn: (args) => {
        const arg0 = args[0];
        const intervalMs = typeof arg0 === 'number' ? Math.max(1, Math.round(arg0)) : 100;
        const cb = typeof arg0 === 'number' ? args[1] : arg0;
        if (!cb || typeof cb !== 'object' || cb.__kind !== 'func') {
          throw new Error('`bforge.on_timer` expects `(interval_ms, fn)`');
        }
        pushHook('on_timer', { target: '*', fn: cb, intervalMs });
        return null;
      },
    },
    metric: {
      __kind: 'native',
      fn: (args) => {
        const key = String(args[0] ?? '');
        if (args.length < 2 || args[1] === undefined || args[1] === null) {
          return metricValues.get(key) ?? null;
        }
        const val = args[1];
        if (typeof val === 'number' || typeof val === 'string') {
          metricValues.set(key, val);
          metrics[key] = String(val);
        } else if (typeof val === 'boolean') {
          metricValues.set(key, String(val));
          metrics[key] = String(val);
        } else {
          throw new Error(`metric \`${key}\` cannot store non-scalar value`);
        }
        return null;
      },
    },
    plot: {
      __kind: 'native',
      fn: (args) => {
        const series = String(args[0] ?? '');
        const val = Number(args[1]);
        const ts = typeof args[2] === 'number' && Number.isFinite(args[2]) ? Math.trunc(args[2]) : timestampUs;
        if (series && Number.isFinite(val)) {
          actions.push({ kind: 'plot', series, value: val, timestamp_us: ts });
        }
        return null;
      },
    },
    assert: {
      __kind: 'native',
      fn: (args) => {
        const arg1 = args[0] ?? null;
        const arg2 = args[1];
        const arg3 = args[2] != null ? String(args[2]) : null;
        let cond: LuaVal;
        let label: string;
        if (
          typeof arg1 === 'string' &&
          (arg3 !== null || typeof arg2 === 'boolean' || arg2 === null)
        ) {
          label = arg1;
          cond = arg2 ?? null;
        } else {
          cond = arg1;
          label = arg2 != null ? String(arg2) : 'assertion';
        }
        const passed = luaTruthy(cond);
        const prev = assertionMap.get(label) ?? { name: label, passed: 0, failed: 0, last_error: null };
        if (passed) {
          prev.passed += 1;
        } else {
          prev.failed += 1;
          prev.last_error = arg3 ?? `assertion \`${label}\` failed`;
        }
        assertionMap.set(label, prev);
        return passed;
      },
    },
    log: {
      __kind: 'native',
      fn: (args) => {
        const hasLevel = args.length >= 2 && args[1] !== undefined && args[1] !== null;
        const rawLevel = hasLevel ? String(args[0]).toLowerCase() : 'info';
        const level = ['info', 'warn', 'error', 'debug'].includes(rawLevel) ? rawLevel : 'info';
        const message = hasLevel ? String(args[1] ?? '') : String(args[0] ?? '');
        actions.push({ kind: 'log', level, message, timestamp_us: timestampUs });
        return null;
      },
    },
    log_info: {
      __kind: 'native',
      fn: (args) => {
        actions.push({ kind: 'log', level: 'info', message: String(args[0] ?? ''), timestamp_us: timestampUs });
        return null;
      },
    },
    log_warn: {
      __kind: 'native',
      fn: (args) => {
        actions.push({ kind: 'log', level: 'warn', message: String(args[0] ?? ''), timestamp_us: timestampUs });
        return null;
      },
    },
    log_error: {
      __kind: 'native',
      fn: (args) => {
        actions.push({ kind: 'log', level: 'error', message: String(args[0] ?? ''), timestamp_us: timestampUs });
        return null;
      },
    },
    now_us: {
      __kind: 'native',
      fn: () => {
        simClockUs += 250;
        return Math.max(0, simClockUs + (Date.now() - simStartMs) * 1000);
      },
    },
    now_ms: {
      __kind: 'native',
      fn: () => Math.floor((simClockUs + (Date.now() - simStartMs) * 1000) / 1000),
    },
    seed: {
      __kind: 'native',
      fn: (args) => {
        rngState = normalizeSeed(luaNum(args[0], 'seed'));
        return null;
      },
    },
    rand: {
      __kind: 'native',
      fn: (args) => {
        const nextU64 = (): bigint => {
          let x = rngState;
          x ^= x >> 12n;
          x = BigInt.asUintN(64, x ^ (x << 25n));
          x ^= x >> 27n;
          rngState = x;
          return BigInt.asUintN(64, x * 0x2545f4914f6cdd1dn);
        };
        if (args.length === 0 || (args[0] == null && args[1] == null)) {
          return Number(nextU64() >> 11n) * (1 / 2 ** 53);
        }
        if (args[1] == null) {
          const upper = Math.trunc(luaNum(args[0], 'upper bound'));
          if (upper < 1) throw new Error('bforge.rand(n) requires upper bound >= 1');
          return Number((nextU64() * BigInt(upper)) >> 64n) + 1;
        }
        const min = Math.trunc(luaNum(args[0], 'min'));
        const max = Math.trunc(luaNum(args[1], 'max'));
        if (min > max) throw new Error('bforge.rand(min, max) requires min <= max');
        const span = BigInt(max - min) + 1n;
        const offset = (nextU64() * span) >> 64n;
        return min + Number(offset);
      },
    },
    send: {
      __kind: 'native',
      fn: (args) => {
        const targetPort = String(args[0] ?? activePort);
        const bytes = parseLuaBytesInput(args[1]);
        const hex = formatSpacedHex(bytes);
        let sendDelay = 0;
        if (typeof args[2] === 'number') {
          sendDelay = Math.max(0, Math.round(args[2]));
        } else if (args[2] && typeof args[2] === 'object' && args[2].__kind === 'table') {
          sendDelay = Math.max(0, Math.round(Number(args[2].map.delay_ms ?? 0)));
        }
        actions.push({ kind: 'send', port: targetPort, hex, delay_ms: sendDelay });
        return null;
      },
    },
    pulse_pin: {
      __kind: 'native',
      fn: (args) => {
        const threeArg = args.length >= 3 || (typeof args[1] === 'string' && typeof args[2] === 'number');
        const targetPort = threeArg ? String(args[0] ?? activePort) : '*';
        const pin = String(threeArg ? args[1] ?? 'DTR' : args[0] ?? 'DTR').toUpperCase();
        const ms = Math.max(0, Math.round(Number(threeArg ? args[2] ?? 50 : args[1] ?? 50)));
        actions.push({ kind: 'pulse_pin', pin, delay_ms: ms, port: targetPort });
        return null;
      },
    },
    set_pins: {
      __kind: 'native',
      fn: (args) => {
        const hasPort = typeof args[0] === 'string';
        const targetPort = hasPort ? String(args[0]) : '*';
        const dtr = luaTruthy(hasPort ? args[1] ?? false : args[0] ?? false);
        const rts = luaTruthy(hasPort ? args[2] ?? false : args[1] ?? false);
        actions.push({ kind: 'set_pins', port: targetPort, dtr, rts });
        return null;
      },
    },
    trigger_pin: {
      __kind: 'native',
      fn: (args) => {
        const targetPort = args.length >= 2 ? String(args[0] ?? activePort) : '*';
        const spec = String(args.length >= 2 ? args[1] ?? '' : args[0] ?? '').trim();
        if (!spec) throw new Error('trigger_pin spec cannot be empty');
        const upper = spec.toUpperCase();
        const pin = upper.includes('DTR') ? 'DTR' : 'RTS';
        const durMatch = /(\d+)\s*(MS|US)/.exec(upper);
        if (durMatch) {
          const rawNum = Number(durMatch[1]);
          const ms = durMatch[2] === 'US' ? Math.max(1, Math.ceil(rawNum / 1000)) : Math.max(1, rawNum);
          actions.push({ kind: 'pulse_pin', port: targetPort, pin, delay_ms: ms });
        } else if (upper.includes('PULSE')) {
          actions.push({ kind: 'pulse_pin', port: targetPort, pin, delay_ms: 1 });
        } else if (upper.endsWith('_HIGH') || upper === 'HIGH') {
          actions.push({ kind: 'set_pins', port: targetPort, dtr: pin === 'DTR', rts: pin === 'RTS' });
        } else if (upper.endsWith('_LOW') || upper === 'LOW') {
          actions.push({ kind: 'set_pins', port: targetPort, dtr: false, rts: false });
        } else {
          throw new Error(`unrecognized trigger_pin spec \`${spec}\``);
        }
        return null;
      },
    },
    unhex: {
      __kind: 'native',
      fn: (args) => {
        const arg0 = args[0];
        let src = '';
        if (arg0 && typeof arg0 === 'object' && arg0.__kind === 'table') {
          src = arg0.getters?.hex ? String(arg0.getters.hex() ?? '') : String(arg0.map.hex ?? '');
        } else {
          src = String(arg0 ?? '');
        }
        const bytes = parseHexBytes(src);
        const tbl = makeTable({}, []);
        for (let i = 0; i < bytes.length; i++) tbl.array[i + 1] = bytes[i];
        return tbl;
      },
    },
    hex: {
      __kind: 'native',
      fn: (args) => {
        const arg0 = args[0];
        if (arg0 && typeof arg0 === 'object') {
          if (arg0.__kind === 'binary') return formatSpacedHex(arg0.bytes);
          if (arg0.__kind === 'table') {
            if (arg0.getters?.hex) return String(arg0.getters.hex() ?? '');
            const bytes: number[] = [];
            for (let i = 1; i < arg0.array.length; i++) {
              if (arg0.array[i] !== undefined) bytes.push(Number(arg0.array[i]) & 0xff);
            }
            return formatSpacedHex(bytes);
          }
        }
        if (typeof arg0 === 'string') {
          return formatSpacedHex(Array.from(arg0, (c) => c.charCodeAt(0) & 0xff));
        }
        return '';
      },
    },
    crc: {
      __kind: 'native',
      fn: (args) => {
        const algo = String(args[0] ?? 'crc8');
        const bytes = parseLuaBytesInput(args[1]);
        return computeCrcByName(algo, bytes).value;
      },
    },
    burst: {
      __kind: 'native',
      fn: (args) => {
        const tbl = args[0];
        if (!tbl || typeof tbl !== 'object' || tbl.__kind !== 'table') {
          throw new Error('bforge.burst expects a table of {payload, delay_ms} entries');
        }
        return tbl;
      },
    },
  });

  const stringTable = makeTable({
    format: { __kind: 'native', fn: (args) => luaFormat(String(args[0] ?? ''), args.slice(1)) },
    pack: { __kind: 'native', fn: (args) => luaPack(String(args[0] ?? ''), args.slice(1)) },
    unpack: {
      __kind: 'native',
      fn: (args) =>
        luaUnpack(
          String(args[0] ?? ''),
          args[1] ?? null,
          args[2] != null ? luaNum(args[2], 'unpack offset') : 1
        ) as unknown as LuaVal,
    },
    packsize: { __kind: 'native', fn: (args) => luaPacksize(String(args[0] ?? '')) },
    len: {
      __kind: 'native',
      fn: (args) => {
        const a = args[0];
        if (a && typeof a === 'object' && a.__kind === 'binary') return a.bytes.length;
        return String(a ?? '').length;
      },
    },
    sub: {
      __kind: 'native',
      fn: (args) => {
        const src = args[0];
        const iArg = Math.trunc(luaNum(args[1] ?? 1, 'sub start'));
        const jArg = args[2] != null ? Math.trunc(luaNum(args[2], 'sub end')) : -1;
        if (src && typeof src === 'object' && src.__kind === 'binary') {
          const len = src.bytes.length;
          const start = Math.max(0, (iArg < 0 ? len + iArg : iArg - 1));
          const end = Math.min(len, (jArg < 0 ? len + jArg + 1 : jArg));
          return { __kind: 'binary', bytes: start < end ? src.bytes.slice(start, end) : [] };
        }
        const s = String(src ?? '');
        const len = s.length;
        const start = Math.max(0, (iArg < 0 ? len + iArg : iArg - 1));
        const end = Math.min(len, (jArg < 0 ? len + jArg + 1 : jArg));
        return start < end ? s.slice(start, end) : '';
      },
    },
    byte: {
      __kind: 'native',
      fn: (args) => {
        const bytes = luaRawBytesOf(args[0] ?? '');
        const iArg = Math.trunc(luaNum(args[1] ?? 1, 'byte start'));
        const start = Math.max(0, (iArg < 0 ? bytes.length + iArg : iArg - 1));
        const endArg = args[2] != null ? Math.trunc(luaNum(args[2], 'byte end')) : iArg;
        const end = Math.min(bytes.length, (endArg < 0 ? bytes.length + endArg + 1 : endArg));
        if (start >= end) return null;
        if (end - start === 1) return bytes[start];
        return { __kind: 'multi', values: bytes.slice(start, end) } as unknown as LuaVal;
      },
    },
    char: {
      __kind: 'native',
      fn: (args) => ({ __kind: 'binary', bytes: args.map((a) => Math.trunc(luaNum(a, 'char')) & 0xff) }),
    },
    rep: {
      __kind: 'native',
      fn: (args) => {
        const s = String(args[0] ?? '');
        const n = Math.max(0, Math.trunc(luaNum(args[1] ?? 0, 'rep')));
        const sep = args[2] != null ? String(args[2]) : '';
        if (n === 0) return '';
        return Array.from({ length: n }, () => s).join(sep);
      },
    },
    upper: { __kind: 'native', fn: (args) => String(args[0] ?? '').toUpperCase() },
    lower: { __kind: 'native', fn: (args) => String(args[0] ?? '').toLowerCase() },
  });

  const tableStdlib = makeTable({
    insert: {
      __kind: 'native',
      fn: (args) => {
        const tbl = args[0];
        if (!tbl || typeof tbl !== 'object' || tbl.__kind !== 'table') return null;
        if (args.length === 2) {
          const idx = Math.max(1, tbl.array.length);
          tbl.array[idx] = args[1];
        } else if (args.length >= 3) {
          const pos = Math.max(1, Math.trunc(luaNum(args[1], 'table.insert pos')));
          tbl.array.splice(pos, 0, args[2]);
        }
        return null;
      },
    },
    remove: {
      __kind: 'native',
      fn: (args) => {
        const tbl = args[0];
        if (!tbl || typeof tbl !== 'object' || tbl.__kind !== 'table') return null;
        const len = Math.max(0, tbl.array.length - 1);
        if (len === 0) return null;
        const pos = args[1] != null ? Math.trunc(luaNum(args[1], 'table.remove pos')) : len;
        if (pos < 1 || pos > len) return null;
        const [removed] = tbl.array.splice(pos, 1);
        return removed ?? null;
      },
    },
    concat: {
      __kind: 'native',
      fn: (args) => {
        const tbl = args[0];
        if (!tbl || typeof tbl !== 'object' || tbl.__kind !== 'table') return '';
        const sep = args[1] != null ? String(args[1]) : '';
        const iStart = args[2] != null ? Math.trunc(luaNum(args[2])) : 1;
        const iEnd = args[3] != null ? Math.trunc(luaNum(args[3])) : Math.max(0, tbl.array.length - 1);
        const parts: string[] = [];
        for (let i = iStart; i <= iEnd; i++) {
          parts.push(String(tbl.array[i] ?? ''));
        }
        return parts.join(sep);
      },
    },
  });

  const mathTable = makeTable({
    pi: Math.PI,
    abs: { __kind: 'native', fn: (args) => Math.abs(luaNum(args[0])) },
    max: { __kind: 'native', fn: (args) => Math.max(...args.map((a) => luaNum(a))) },
    min: { __kind: 'native', fn: (args) => Math.min(...args.map((a) => luaNum(a))) },
    floor: { __kind: 'native', fn: (args) => Math.floor(luaNum(args[0])) },
    ceil: { __kind: 'native', fn: (args) => Math.ceil(luaNum(args[0])) },
    sin: { __kind: 'native', fn: (args) => Math.sin(luaNum(args[0])) },
    cos: { __kind: 'native', fn: (args) => Math.cos(luaNum(args[0])) },
    sqrt: { __kind: 'native', fn: (args) => Math.sqrt(luaNum(args[0])) },
  });

  const rootEnv: EnvFrame = {
    parent: null,
    vars: {
      bforge: bforgeTable,
      string: stringTable,
      table: tableStdlib,
      math: mathTable,
      tonumber: {
        __kind: 'native',
        fn: (args) => {
          const v = args[0];
          if (typeof v === 'number') return Number.isFinite(v) ? v : null;
          if (typeof v === 'string') {
            const base = args[1] != null ? Math.trunc(luaNum(args[1], 'base')) : undefined;
            if (base !== undefined) {
              const n = parseInt(v.trim(), base);
              return Number.isFinite(n) ? n : null;
            }
            const n = Number(v.trim());
            return v.trim() !== '' && Number.isFinite(n) ? n : null;
          }
          return null;
        },
      },
      tostring: {
        __kind: 'native',
        fn: (args) => {
          const v = args[0];
          if (v === null || v === undefined) return 'nil';
          if (typeof v === 'object' && v.__kind === 'binary') {
            return formatSpacedHex(v.bytes);
          }
          return String(v);
        },
      },
      type: {
        __kind: 'native',
        fn: (args) => {
          const v = args[0];
          if (v === null || v === undefined) return 'nil';
          if (typeof v === 'number') return 'number';
          if (typeof v === 'string') return 'string';
          if (typeof v === 'boolean') return 'boolean';
          if (v.__kind === 'binary') return 'string';
          if (v.__kind === 'table') return 'table';
          return 'function';
        },
      },
      pairs: {
        __kind: 'native',
        fn: (args) => args[0] ?? null,
      },
      ipairs: {
        __kind: 'native',
        fn: (args) => args[0] ?? null,
      },
      pcall: {
        __kind: 'native',
        fn: (args) => {
          const fn = args[0];
          try {
            const res = callLuaRaw(fn, args.slice(1));
            const out =
              res && typeof res === 'object' && res.__kind === 'multi'
                ? [true, ...res.values]
                : [true, res];
            return { __kind: 'multi', values: out } as unknown as LuaVal;
          } catch (err) {
            return {
              __kind: 'multi',
              values: [false, err instanceof Error ? err.message : String(err)],
            } as unknown as LuaVal;
          }
        },
      },
      error: {
        __kind: 'native',
        fn: (args) => {
          throw new Error(String(args[0] ?? 'script error'));
        },
      },
    },
  };

  const resolveVar = (env: EnvFrame, name: string): LuaVal => {
    if (FORBIDDEN_GLOBALS.has(name)) {
      throw new Error(`sandbox violation: '${name}' is disabled`);
    }
    let cur: EnvFrame | null = env;
    while (cur) {
      if (Object.prototype.hasOwnProperty.call(cur.vars, name)) {
        return cur.vars[name];
      }
      cur = cur.parent;
    }
    return null;
  };

  const assignVar = (env: EnvFrame, name: string, val: LuaVal) => {
    let cur: EnvFrame | null = env;
    while (cur) {
      if (Object.prototype.hasOwnProperty.call(cur.vars, name)) {
        cur.vars[name] = val;
        return;
      }
      cur = cur.parent;
    }
    env.vars[name] = val;
  };

  // Token cursor + recursive descent evaluator
  class Evaluator {
    private pos = 0;
    private drySkip = 0;
    constructor(private readonly toks: Token[]) {}

    private peek(offset = 0): Token {
      return this.toks[Math.min(this.toks.length - 1, this.pos + offset)];
    }

    private next(): Token {
      const t = this.peek();
      if (this.pos < this.toks.length - 1) this.pos++;
      return t;
    }

    private isIdent(word: string, offset = 0): boolean {
      const t = this.peek(offset);
      return t.kind === 'ident' && t.value === word;
    }

    private isOp(op: string, offset = 0): boolean {
      const t = this.peek(offset);
      return t.kind === 'op' && t.value === op;
    }

    private eatOp(op: string): boolean {
      if (this.isOp(op)) {
        this.next();
        return true;
      }
      return false;
    }

    private eatIdent(word: string): boolean {
      if (this.isIdent(word)) {
        this.next();
        return true;
      }
      return false;
    }

    private skipBlockTokens(stopWords: Set<string>): Token[] {
      const body: Token[] = [];
      let depth = 0;
      while (this.peek().kind !== 'eof') {
        const t = this.peek();
        if (t.kind === 'ident') {
          if (t.value === 'function' || t.value === 'if' || t.value === 'for' || t.value === 'while' || t.value === 'repeat') {
            depth++;
          } else if (t.value === 'do') {
            const prevHasLoop = this.hasUnclosedLoopDo(body);
            if (!prevHasLoop) depth++;
          } else if (depth === 0 && stopWords.has(t.value)) {
            break;
          } else if (t.value === 'end' || t.value === 'until') {
            depth = Math.max(0, depth - 1);
          }
        }
        body.push(this.next());
      }
      body.push({ kind: 'eof', value: '', line: this.peek().line });
      return body;
    }

    private hasUnclosedLoopDo(collected: Token[]): boolean {
      let d = 0;
      for (let i = collected.length - 1; i >= 0; i--) {
        const t = collected[i];
        if (t.kind !== 'ident') continue;
        if (t.value === 'end') d++;
        else if (d === 0 && (t.value === 'for' || t.value === 'while')) return true;
        else if (d === 0 && t.value === 'do') return false;
        else if (t.value === 'function' || t.value === 'if' || t.value === 'do') d = Math.max(0, d - 1);
      }
      return false;
    }

    execBlock(env: EnvFrame, stopWords: Set<string>): void {
      while (this.peek().kind !== 'eof') {
        if (this.peek().kind === 'ident' && stopWords.has(this.peek().value)) break;
        if (this.eatOp(';')) continue;
        this.execStmt(env);
      }
    }

    private execStmt(env: EnvFrame): void {
      stepTick();
      const t = this.peek();
      if (t.kind === 'ident') {
        if (t.value === 'local') {
          this.next();
          if (this.eatIdent('function')) {
            const name = this.next().value;
            const fn = this.parseFunctionBody(env);
            env.vars[name] = fn;
            return;
          }
          const names: string[] = [this.next().value];
          while (this.eatOp(',')) names.push(this.next().value);
          const exprVals: LuaExprResult[] = [];
          if (this.eatOp('=')) {
            exprVals.push(this.evalExprRaw(env));
            while (this.eatOp(',')) exprVals.push(this.evalExprRaw(env));
          }
          const vals = expandMultiList(exprVals);
          for (let i = 0; i < names.length; i++) {
            env.vars[names[i]] = vals[i] ?? null;
          }
          return;
        }

        if (t.value === 'function') {
          this.next();
          const name = this.next().value;
          const fn = this.parseFunctionBody(env);
          assignVar(env, name, fn);
          return;
        }

        if (t.value === 'if') {
          this.next();
          const branches: Array<{ cond: () => LuaVal; body: Token[] }> = [];
          let elseBody: Token[] | null = null;

          const parseCondAndBody = () => {
            const condStart = this.pos;
            while (this.peek().kind !== 'eof' && !this.isIdent('then')) this.next();
            const condToks = this.toks.slice(condStart, this.pos);
            condToks.push({ kind: 'eof', value: '', line: this.peek().line });
            this.eatIdent('then');
            const body = this.skipBlockTokens(new Set(['elseif', 'else', 'end']));
            return {
              cond: () => new Evaluator(condToks).evalExpr(env),
              body,
            };
          };

          branches.push(parseCondAndBody());
          while (this.eatIdent('elseif')) {
            branches.push(parseCondAndBody());
          }
          if (this.eatIdent('else')) {
            elseBody = this.skipBlockTokens(new Set(['end']));
          }
          this.eatIdent('end');

          for (const br of branches) {
            if (luaTruthy(br.cond())) {
              new Evaluator(br.body).execBlock({ vars: {}, parent: env }, new Set());
              return;
            }
          }
          if (elseBody) {
            new Evaluator(elseBody).execBlock({ vars: {}, parent: env }, new Set());
          }
          return;
        }

        if (t.value === 'while') {
          this.next();
          const condStart = this.pos;
          while (this.peek().kind !== 'eof' && !this.isIdent('do')) this.next();
          const condToks = this.toks.slice(condStart, this.pos);
          condToks.push({ kind: 'eof', value: '', line: this.peek().line });
          this.eatIdent('do');
          const body = this.skipBlockTokens(new Set(['end']));
          this.eatIdent('end');

          while (luaTruthy(new Evaluator(condToks).evalExpr(env))) {
            stepTick();
            try {
              new Evaluator(body).execBlock({ vars: {}, parent: env }, new Set());
            } catch (err) {
              if (err instanceof BreakSignal) break;
              throw err;
            }
          }
          return;
        }

        if (t.value === 'for') {
          this.next();
          const varName = this.next().value;
          if (this.eatOp('=')) {
            const start = luaNum(this.evalExpr(env));
            this.eatOp(',');
            const stop = luaNum(this.evalExpr(env));
            const step = this.eatOp(',') ? luaNum(this.evalExpr(env)) : 1;
            this.eatIdent('do');
            const body = this.skipBlockTokens(new Set(['end']));
            this.eatIdent('end');
            for (let v = start; step >= 0 ? v <= stop : v >= stop; v += step) {
              stepTick();
              const loopEnv: EnvFrame = { vars: { [varName]: v }, parent: env };
              try {
                new Evaluator(body).execBlock(loopEnv, new Set());
              } catch (err) {
                if (err instanceof BreakSignal) break;
                throw err;
              }
            }
            return;
          }
          const varNames = [varName];
          while (this.eatOp(',')) varNames.push(this.next().value);
          this.eatIdent('in');
          const iterStart = this.pos;
          while (this.peek().kind !== 'eof' && !this.isIdent('do')) this.next();
          const iterToks = this.toks.slice(iterStart, this.pos);
          iterToks.push({ kind: 'eof', value: '', line: t.line });
          this.eatIdent('do');
          const body = this.skipBlockTokens(new Set(['end']));
          this.eatIdent('end');

          const isIpairs = iterToks[0]?.kind === 'ident' && iterToks[0].value === 'ipairs';
          const iterVal = new Evaluator(iterToks).evalExpr(env);
          if (iterVal && typeof iterVal === 'object' && iterVal.__kind === 'table') {
            const entries: Array<[LuaVal, LuaVal]> = [];
            for (let i = 1; i < iterVal.array.length; i++) {
              const v = iterVal.array[i];
              if (v === undefined || v === null) {
                if (isIpairs) break;
                continue;
              }
              entries.push([i, v]);
            }
            if (!isIpairs) {
              for (const [k, v] of Object.entries(iterVal.map)) {
                if (v !== null && v !== undefined) entries.push([k, v]);
              }
            }
            for (const [k, v] of entries) {
              stepTick();
              const vars: Record<string, LuaVal> = { [varNames[0]]: k };
              if (varNames[1]) vars[varNames[1]] = v;
              try {
                new Evaluator(body).execBlock({ vars, parent: env }, new Set());
              } catch (err) {
                if (err instanceof BreakSignal) break;
                throw err;
              }
            }
          }
          return;
        }

        if (t.value === 'do') {
          this.next();
          const body = this.skipBlockTokens(new Set(['end']));
          this.eatIdent('end');
          new Evaluator(body).execBlock({ vars: {}, parent: env }, new Set());
          return;
        }

        if (t.value === 'repeat') {
          this.next();
          const body = this.skipBlockTokens(new Set(['until']));
          this.eatIdent('until');
          const condStart = this.pos;
          this.evalExpr(env);
          const condToks = this.toks.slice(condStart, this.pos);
          condToks.push({ kind: 'eof', value: '', line: t.line });
          do {
            stepTick();
            const loopEnv: EnvFrame = { vars: {}, parent: env };
            try {
              new Evaluator(body).execBlock(loopEnv, new Set());
            } catch (err) {
              if (err instanceof BreakSignal) break;
              throw err;
            }
            if (luaTruthy(new Evaluator(condToks).evalExpr(loopEnv))) break;
          } while (true);
          return;
        }

        if (t.value === 'return') {
          this.next();
          if (
            this.peek().kind === 'eof' ||
            this.isOp(';') ||
            (this.peek().kind === 'ident' &&
              ['end', 'else', 'elseif', 'until'].includes(this.peek().value))
          ) {
            throw new ReturnSignal(null, false);
          }
          const exprs: LuaExprResult[] = [this.evalExprRaw(env)];
          while (this.eatOp(',')) exprs.push(this.evalExprRaw(env));
          const vals = expandMultiList(exprs);
          const retVal: LuaExprResult =
            vals.length <= 1 ? (vals[0] ?? null) : { __kind: 'multi', values: vals };
          throw new ReturnSignal(retVal, true);
        }

        if (t.value === 'break') {
          this.next();
          throw new BreakSignal();
        }
      }

      // Assignment or call expression
      const lhs = this.parseSuffixedTarget(env);
      if (this.eatOp('=')) {
        const rhs = this.evalExpr(env);
        lhs.set(rhs);
        return;
      }
      if (this.eatOp(',')) {
        const targets = [lhs];
        while (true) {
          targets.push(this.parseSuffixedTarget(env));
          if (!this.eatOp(',')) break;
        }
        this.eatOp('=');
        const exprVals = [this.evalExprRaw(env)];
        while (this.eatOp(',')) exprVals.push(this.evalExprRaw(env));
        const vals = expandMultiList(exprVals);
        targets.forEach((tgt, idx) => tgt.set(vals[idx] ?? null));
        return;
      }
    }

    private parseFunctionBody(env: EnvFrame): LuaFunc {
      this.eatOp('(');
      const params: string[] = [];
      while (this.peek().kind !== 'eof' && !this.isOp(')')) {
        const p = this.next();
        if (p.kind === 'ident') params.push(p.value);
        this.eatOp(',');
      }
      this.eatOp(')');
      const body = this.skipBlockTokens(new Set(['end']));
      this.eatIdent('end');
      return { __kind: 'func', params, body, closure: env };
    }

    private parseSuffixedTarget(env: EnvFrame): { val: LuaExprResult; set: (v: LuaVal) => void } {
      let curVal: LuaExprResult;
      let setter: (v: LuaVal) => void = () => {};

      const t = this.peek();
      if (t.kind === 'ident' && !LUA_KEYWORDS.has(t.value)) {
        this.next();
        const name = t.value;
        curVal = this.drySkip > 0 ? null : resolveVar(env, name);
        setter = (v) => {
          if (this.drySkip === 0) assignVar(env, name, v);
        };
      } else if (this.eatOp('(')) {
        curVal = this.evalExpr(env);
        this.eatOp(')');
      } else {
        curVal = this.evalPrimary(env);
      }

      while (true) {
        if (this.eatOp('.')) {
          const prop = this.next().value;
          const parentTbl = unwrapSingle(curVal);
          if (this.drySkip > 0) {
            curVal = null;
          } else if (parentTbl && typeof parentTbl === 'object' && parentTbl.__kind === 'table') {
            curVal =
              parentTbl.getters && Object.prototype.hasOwnProperty.call(parentTbl.getters, prop)
                ? parentTbl.getters[prop]()
                : parentTbl.map[prop] ?? null;
          } else {
            curVal = null;
          }
          setter = (v) => {
            if (this.drySkip === 0 && parentTbl && typeof parentTbl === 'object' && parentTbl.__kind === 'table') {
              parentTbl.map[prop] = v;
            }
          };
        } else if (this.eatOp('[')) {
          const key = this.evalExpr(env);
          this.eatOp(']');
          const parentTbl = unwrapSingle(curVal);
          if (this.drySkip > 0) {
            curVal = null;
          } else if (parentTbl && typeof parentTbl === 'object' && parentTbl.__kind === 'table') {
            if (typeof key === 'number') {
              curVal = parentTbl.array[Math.trunc(key)] ?? null;
            } else {
              const k = String(key);
              curVal =
                parentTbl.getters && Object.prototype.hasOwnProperty.call(parentTbl.getters, k)
                  ? parentTbl.getters[k]()
                  : parentTbl.map[k] ?? null;
            }
          } else {
            curVal = null;
          }
          setter = (v) => {
            if (this.drySkip === 0 && parentTbl && typeof parentTbl === 'object' && parentTbl.__kind === 'table') {
              if (typeof key === 'number') parentTbl.array[Math.trunc(key)] = v;
              else parentTbl.map[String(key)] = v;
            }
          };
        } else if (this.eatOp(':')) {
          const method = this.next().value;
          const selfVal = unwrapSingle(curVal);
          const fn =
            selfVal && typeof selfVal === 'object' && selfVal.__kind === 'table'
              ? selfVal.map[method] ?? null
              : null;
          const args = this.parseCallArgs(env);
          curVal = this.drySkip > 0 ? null : callLuaRaw(fn, args, selfVal);
          setter = () => {};
        } else if (this.isOp('(') || this.isOp('{') || this.peek().kind === 'string') {
          const args = this.parseCallArgs(env);
          curVal = this.drySkip > 0 ? null : callLuaRaw(unwrapSingle(curVal), args);
          setter = () => {};
        } else {
          break;
        }
      }

      return { val: curVal, set: setter };
    }

    private parseCallArgs(env: EnvFrame): LuaVal[] {
      if (this.eatOp('(')) {
        const rawArgs: LuaExprResult[] = [];
        while (this.peek().kind !== 'eof' && !this.isOp(')')) {
          rawArgs.push(this.evalExprRaw(env));
          if (!this.eatOp(',')) break;
        }
        this.eatOp(')');
        return this.drySkip > 0 ? [] : expandMultiList(rawArgs);
      }
      if (this.peek().kind === 'string') {
        return [this.next().value];
      }
      if (this.isOp('{')) {
        return [this.parseTableLiteral(env)];
      }
      return [];
    }

    private parseTableLiteral(env: EnvFrame): LuaTable {
      this.eatOp('{');
      const tbl = makeTable();
      let arrIdx = 1;
      while (this.peek().kind !== 'eof' && !this.isOp('}')) {
        if (this.eatOp('[')) {
          const k = this.evalExpr(env);
          this.eatOp(']');
          this.eatOp('=');
          const v = this.evalExpr(env);
          if (this.drySkip === 0) {
            if (typeof k === 'number') tbl.array[Math.trunc(k)] = v;
            else tbl.map[String(k)] = v;
          }
        } else if (this.peek().kind === 'ident' && this.isOp('=', 1)) {
          const k = this.next().value;
          this.eatOp('=');
          const v = this.evalExpr(env);
          if (this.drySkip === 0) tbl.map[k] = v;
        } else {
          const expr = this.evalExprRaw(env);
          if (this.drySkip === 0) {
            if (expr && typeof expr === 'object' && expr.__kind === 'multi') {
              for (const item of expr.values) tbl.array[arrIdx++] = item;
            } else {
              tbl.array[arrIdx++] = expr;
            }
          }
        }
        if (!this.eatOp(',') && !this.eatOp(';')) break;
      }
      this.eatOp('}');
      return tbl;
    }

    evalExprRaw(env: EnvFrame): LuaExprResult {
      return this.evalOr(env);
    }

    evalExpr(env: EnvFrame): LuaVal {
      return unwrapSingle(this.evalOr(env));
    }

    private evalOr(env: EnvFrame): LuaExprResult {
      let left = this.evalAnd(env);
      while (this.eatIdent('or')) {
        const single = unwrapSingle(left);
        if (this.drySkip > 0 || luaTruthy(single)) {
          this.drySkip++;
          try {
            this.evalAnd(env);
          } finally {
            this.drySkip--;
          }
          left = single;
        } else {
          left = this.evalAnd(env);
        }
      }
      return left;
    }

    private evalAnd(env: EnvFrame): LuaExprResult {
      let left = this.evalCmp(env);
      while (this.eatIdent('and')) {
        const single = unwrapSingle(left);
        if (this.drySkip > 0 || !luaTruthy(single)) {
          this.drySkip++;
          try {
            this.evalCmp(env);
          } finally {
            this.drySkip--;
          }
          left = single;
        } else {
          left = this.evalCmp(env);
        }
      }
      return left;
    }

    private evalCmp(env: EnvFrame): LuaExprResult {
      let left = this.evalBitOr(env);
      while (
        this.isOp('==') ||
        this.isOp('~=') ||
        this.isOp('<') ||
        this.isOp('<=') ||
        this.isOp('>') ||
        this.isOp('>=')
      ) {
        const op = this.next().value;
        const right = this.evalBitOr(env);
        if (this.drySkip > 0) {
          left = false;
          continue;
        }
        const l = unwrapSingle(left);
        const r = unwrapSingle(right);
        if (op === '==') left = l === r;
        else if (op === '~=') left = l !== r;
        else if (op === '<') left = Number(l) < Number(r);
        else if (op === '<=') left = Number(l) <= Number(r);
        else if (op === '>') left = Number(l) > Number(r);
        else left = Number(l) >= Number(r);
      }
      return left;
    }

    private evalBitOr(env: EnvFrame): LuaExprResult {
      let left = this.evalBitXor(env);
      while (this.eatOp('|')) {
        const right = this.evalBitXor(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        const res = BigInt(Math.trunc(luaNum(unwrapSingle(left)))) | BigInt(Math.trunc(luaNum(unwrapSingle(right))));
        left = Number(BigInt.asIntN(64, res));
      }
      return left;
    }

    private evalBitXor(env: EnvFrame): LuaExprResult {
      let left = this.evalBitAnd(env);
      while (this.eatOp('~')) {
        const right = this.evalBitAnd(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        const res = BigInt(Math.trunc(luaNum(unwrapSingle(left)))) ^ BigInt(Math.trunc(luaNum(unwrapSingle(right))));
        left = Number(BigInt.asIntN(64, res));
      }
      return left;
    }

    private evalBitAnd(env: EnvFrame): LuaExprResult {
      let left = this.evalShift(env);
      while (this.eatOp('&')) {
        const right = this.evalShift(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        const res = BigInt(Math.trunc(luaNum(unwrapSingle(left)))) & BigInt(Math.trunc(luaNum(unwrapSingle(right))));
        left = Number(BigInt.asIntN(64, res));
      }
      return left;
    }

    private evalShift(env: EnvFrame): LuaExprResult {
      let left = this.evalConcat(env);
      while (this.isOp('<<') || this.isOp('>>')) {
        const op = this.next().value as '<<' | '>>';
        const right = this.evalConcat(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        left = luaShift(luaNum(unwrapSingle(left)), luaNum(unwrapSingle(right)), op);
      }
      return left;
    }

    private evalConcat(env: EnvFrame): LuaExprResult {
      const left = this.evalAdd(env);
      if (this.eatOp('..')) {
        const right = this.evalConcat(env);
        if (this.drySkip > 0) return '';
        const l = unwrapSingle(left);
        const r = unwrapSingle(right);
        const lBin = l && typeof l === 'object' && l.__kind === 'binary';
        const rBin = r && typeof r === 'object' && r.__kind === 'binary';
        if (lBin || rBin) {
          return {
            __kind: 'binary',
            bytes: [...luaRawBytesOf(l ?? ''), ...luaRawBytesOf(r ?? '')],
          };
        }
        return `${l ?? ''}${r ?? ''}`;
      }
      return left;
    }

    private evalAdd(env: EnvFrame): LuaExprResult {
      let left = this.evalMul(env);
      while (this.isOp('+') || this.isOp('-')) {
        const op = this.next().value;
        const right = this.evalMul(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        const l = luaNum(unwrapSingle(left));
        const r = luaNum(unwrapSingle(right));
        left = op === '+' ? l + r : l - r;
      }
      return left;
    }

    private evalMul(env: EnvFrame): LuaExprResult {
      let left = this.evalUnary(env);
      while (this.isOp('*') || this.isOp('/') || this.isOp('//') || this.isOp('%')) {
        const op = this.next().value;
        const right = this.evalUnary(env);
        if (this.drySkip > 0) {
          left = 0;
          continue;
        }
        const l = luaNum(unwrapSingle(left));
        const r = luaNum(unwrapSingle(right));
        if (op === '*') left = l * r;
        else if (op === '/') left = l / r;
        else if (op === '//') left = Math.floor(l / r);
        else left = l - Math.floor(l / r) * r;
      }
      return left;
    }

    private evalUnary(env: EnvFrame): LuaExprResult {
      if (this.eatIdent('not')) {
        const v = this.evalUnary(env);
        return this.drySkip > 0 ? false : !luaTruthy(unwrapSingle(v));
      }
      if (this.eatOp('-')) {
        const v = this.evalUnary(env);
        return this.drySkip > 0 ? 0 : -luaNum(unwrapSingle(v));
      }
      if (this.eatOp('~')) {
        const v = this.evalUnary(env);
        return this.drySkip > 0 ? 0 : Number(BigInt.asIntN(64, ~BigInt(Math.trunc(luaNum(unwrapSingle(v))))));
      }
      if (this.eatOp('#')) {
        const raw = this.evalUnary(env);
        if (this.drySkip > 0) return 0;
        const v = unwrapSingle(raw);
        if (typeof v === 'string') return v.length;
        if (v && typeof v === 'object' && v.__kind === 'binary') return v.bytes.length;
        if (v && typeof v === 'object' && v.__kind === 'table') {
          return Math.max(0, v.array.length - 1);
        }
        return 0;
      }
      return this.evalPow(env);
    }

    private evalPow(env: EnvFrame): LuaExprResult {
      const left = this.evalPrimary(env);
      if (this.eatOp('^')) {
        const right = this.evalUnary(env);
        if (this.drySkip > 0) return 0;
        return Math.pow(luaNum(unwrapSingle(left)), luaNum(unwrapSingle(right)));
      }
      return left;
    }

    private evalPrimary(env: EnvFrame): LuaExprResult {
      const t = this.peek();
      if (t.kind === 'number') {
        this.next();
        return t.numValue ?? 0;
      }
      if (t.kind === 'string') {
        this.next();
        return t.value;
      }
      if (t.kind === 'ident') {
        if (t.value === 'nil') {
          this.next();
          return null;
        }
        if (t.value === 'true') {
          this.next();
          return true;
        }
        if (t.value === 'false') {
          this.next();
          return false;
        }
        if (t.value === 'function') {
          this.next();
          return this.parseFunctionBody(env);
        }
      }
      if (this.isOp('{')) {
        return this.parseTableLiteral(env);
      }
      return this.parseSuffixedTarget(env).val;
    }
  }

  const callLuaWithReturn = (
    callable: LuaVal,
    args: LuaVal[],
    self?: LuaVal
  ): { value: LuaExprResult; returned: boolean } => {
    if (!callable || typeof callable !== 'object') {
      throw new Error('attempt to call a nil value');
    }
    if (callable.__kind === 'native') {
      return { value: callable.fn(args, self), returned: true };
    }
    if (callable.__kind === 'func') {
      const fnEnv: EnvFrame = { vars: {}, parent: callable.closure };
      callable.params.forEach((p, idx) => {
        fnEnv.vars[p] = args[idx] ?? null;
      });
      try {
        new Evaluator(callable.body).execBlock(fnEnv, new Set());
      } catch (sig) {
        if (sig instanceof ReturnSignal) return { value: sig.value, returned: sig.hasValue };
        throw sig;
      }
      return { value: null, returned: false };
    }
    throw new Error('attempt to call non-callable value');
  };

  const callLuaRaw = (callable: LuaVal, args: LuaVal[], self?: LuaVal): LuaExprResult =>
    callLuaWithReturn(callable, args, self).value;

  const callLua = (callable: LuaVal, args: LuaVal[], self?: LuaVal): LuaVal =>
    unwrapSingle(callLuaRaw(callable, args, self));

  let hookReturn: LuaVal = frameTable;
  try {
    // Execute top-level declarations & hook registrations
    new Evaluator(tokens).execBlock(rootEnv, new Set());

    // Invoke bforge.on_init callbacks before restoring caller locals
    for (const entry of hooksByName.get('on_init') ?? []) {
      callLua(entry.fn, [makeTable({ script: opts.name ?? 'script.lua' })]);
    }

    // Restore persistent locals across simulated frames when provided
    if (opts.locals) {
      for (const [k, v] of Object.entries(opts.locals)) {
        if (Object.prototype.hasOwnProperty.call(rootEnv.vars, k)) {
          rootEnv.vars[k] = v;
        }
      }
    } else if (opts.invocation && opts.invocation > 1) {
      for (const [k, v] of Object.entries(rootEnv.vars)) {
        if (typeof v === 'number' && v === 0) {
          rootEnv.vars[k] = opts.invocation - 1;
        }
      }
    }

    const filterHooks = (hookName: string, target: string): RegisteredHook[] =>
      (hooksByName.get(hookName) ?? []).filter((h) => h.target === '*' || h.target === target);

    const applyHookReturn = (res: LuaVal) => {
      hookReturn = res;
      if (res === null) {
        dropped = true;
        return;
      }
      if (typeof res === 'string') {
        const parsed = parseHexBytes(res);
        if (parsed.length === 0) {
          throw new Error('the hook returned something that is not spaced hex');
        }
        afterBytes.splice(0, afterBytes.length, ...parsed);
        return;
      }
      if (res && typeof res === 'object' && res.__kind === 'binary') {
        afterBytes.splice(0, afterBytes.length, ...res.bytes);
        return;
      }
      if (res && typeof res === 'object' && res.__kind === 'table' && res !== frameTable) {
        if (res.array.length > 1) {
          isBurstReturn = true;
          burstFrames.length = 0;
          for (let i = 1; i < res.array.length; i++) {
            const item = res.array[i];
            if (!item || typeof item !== 'object' || item.__kind !== 'table') continue;
            const entryBytes = parseLuaBytesInput(item.array[1] ?? null);
            const entryDelay = Math.max(0, Math.round(Number(item.array[2] ?? 0)));
            burstFrames.push({ hex: formatSpacedHex(entryBytes), delay_ms: entryDelay });
          }
          if (burstFrames.length > 0) {
            const firstBytes = parseHexBytes(burstFrames[0].hex);
            afterBytes.splice(0, afterBytes.length, ...firstBytes);
            delayMs = burstFrames[0].delay_ms;
          }
        }
      }
    };

    if (opts.hook === 'on_command') {
      const cmdName = opts.commandName ?? 'set_heater';
      const cmdEntry = (hooksByName.get('on_command') ?? []).find((h) => h.target === cmdName);
      if (!cmdEntry) throw new Error(`no on_command handler registered for \`${cmdName}\``);
      const argTbl = makeTable({ ...(opts.commandArgs ?? {}) });
      const { value, returned } = callLuaWithReturn(cmdEntry.fn, [argTbl]);
      if (returned) {
        const cmdBytes = parseLuaBytesInput(unwrapSingle(value));
        afterBytes.splice(0, afterBytes.length, ...cmdBytes);
        hookReturn = { __kind: 'binary', bytes: cmdBytes };
      }
    } else if (opts.hook === 'on_alert') {
      const alertName = opts.alertName ?? 'dead_man_timer';
      const matches = filterHooks('on_alert', alertName);
      for (const entry of matches) {
        callLua(entry.fn, [
          makeTable({
            name: alertName,
            detail: opts.alertDetail ?? 'simulated alert',
            timestamp_us: timestampUs,
          }),
        ]);
      }
    } else if (opts.hook === 'on_timer') {
      for (const entry of hooksByName.get('on_timer') ?? []) {
        callLua(entry.fn, [
          makeTable({
            now_ms: opts.timestampUs != null ? Math.floor(opts.timestampUs / 1000) : Math.floor(timestampUs / 1000),
            interval_ms: entry.intervalMs ?? 100,
          }),
        ]);
      }
    } else {
      const hookOrder = [
        'on_rx_frame',
        'on_frame',
        'on_dissect',
        'on_mitm_frame',
        'on_tx_frame',
        'on_raw_chunk',
        'on_timer',
        'on_alert',
      ];
      const chosenHookName = hookOrder.find((h) => (hooksByName.get(h)?.length ?? 0) > 0);
      if (chosenHookName === 'on_timer') {
        for (const entry of hooksByName.get('on_timer') ?? []) {
          callLua(entry.fn, [
            makeTable({
              now_ms: opts.timestampUs != null ? Math.floor(opts.timestampUs / 1000) : Math.floor(timestampUs / 1000),
              interval_ms: entry.intervalMs ?? 100,
            }),
          ]);
        }
      } else if (chosenHookName === 'on_alert') {
        const alertEntry = (hooksByName.get('on_alert') ?? [])[0];
        if (alertEntry) {
          callLua(alertEntry.fn, [
            makeTable({
              name: alertEntry.target === '*' ? 'dead_man_timer' : alertEntry.target,
              detail: opts.alertDetail ?? 'simulated alert',
              timestamp_us: timestampUs,
            }),
          ]);
        }
      } else if (chosenHookName) {
        const target =
          chosenHookName === 'on_mitm_frame' ? opts.bridge ?? activePort : activePort;
        if (chosenHookName === 'on_mitm_frame') {
          activeDirection =
            opts.direction === 'mitm_b_to_a' ||
            opts.direction === 'B->A' ||
            pkt?.direction === 'B->A'
              ? 'mitm_b_to_a'
              : 'mitm_a_to_b';
        } else if (chosenHookName === 'on_tx_frame' && !opts.direction && !pkt?.direction) {
          activeDirection = 'tx';
        }

        const chain = [
          ...filterHooks(chosenHookName, target),
          ...(chosenHookName === 'on_rx_frame' ? filterHooks('on_dissect', activePort) : []),
        ];
        for (const entry of chain) {
          const { value, returned } = callLuaWithReturn(entry.fn, [frameTable, activeDirection]);
          if (returned) {
            applyHookReturn(unwrapSingle(value));
          }
          if (dropped || isBurstReturn) break;
        }
      }
    }

    if (opts.locals) {
      for (const [k, v] of Object.entries(rootEnv.vars)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null) {
          opts.locals[k] = v;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      verdict: 'error',
      mutated: false,
      input_hex: inputHex,
      output_hex: inputHex,
      delay_ms: 0,
      burst_frames: [],
      field_diffs: [],
      instructions: Math.max(20, steps * 14),
      exec_us: Math.max(8, steps * 2),
      memory_bytes: memBytes,
      actions,
      metrics,
      assertions: Array.from(assertionMap.values()),
      error: msg,
      offline: true,
      hooks: compile.hooks,
    };
  }

  const outputHex = dropped ? '' : formatSpacedHex(afterBytes);
  const mutated =
    !dropped &&
    (isBurstReturn
      ? burstFrames.length !== 1 || outputHex !== inputHex
      : beforeBytes.length !== afterBytes.length ||
        beforeBytes.some((b, idx) => b !== afterBytes[idx]));

  const fieldDiffs: ScriptFieldDiffView[] = [];
  if (!dropped) {
    for (const f of activeFields) {
      const beforeStr = initialFieldSnapshots.get(f.name) ?? null;
      const afterVal = patchedFieldValues.has(f.name)
        ? String(patchedFieldValues.get(f.name))
        : String(normalizedNumericFieldValue(f, afterBytes));
      const byteOverlapMutated =
        mutated &&
        Array.from({ length: f.length }, (_, idx) => f.offset + idx).some(
          (pos) => beforeBytes[pos] !== afterBytes[pos]
        );
      if (beforeStr !== afterVal || byteOverlapMutated) {
        fieldDiffs.push({
          name: f.name,
          before: beforeStr,
          after: afterVal,
        });
      }
    }
    for (const [k, v] of patchedFieldValues.entries()) {
      if (!activeFields.some((f) => f.name === k)) {
        fieldDiffs.push({ name: k, before: null, after: String(v) });
      }
    }
    for (const c of customFields) {
      if (!activeFields.some((f) => f.name === c.name) && !patchedFieldValues.has(c.name)) {
        fieldDiffs.push({ name: c.name, before: null, after: c.display });
      }
    }
  }

  let verdict: ScriptDryRunView['verdict'] = 'pass';
  if (dropped) verdict = 'drop';
  else if (isBurstReturn) verdict = 'burst';
  else if (delayMs > 0) verdict = 'delay';
  else if (mutated || actions.some((a) => a.kind === 'send') || typeof hookReturn === 'string') {
    verdict = 'send';
  }

  const instructions = Math.max(32, steps * 14 + 18);
  const execUs = Math.max(9, Math.round(instructions / 12));

  return {
    ok: true,
    verdict,
    mutated,
    input_hex: inputHex,
    output_hex: outputHex,
    delay_ms: delayMs,
    burst_frames: burstFrames,
    field_diffs: fieldDiffs,
    instructions,
    exec_us: execUs,
    memory_bytes: memBytes,
    actions,
    metrics,
    assertions: Array.from(assertionMap.values()),
    error: null,
    offline: true,
    hooks: compile.hooks,
  };
}
