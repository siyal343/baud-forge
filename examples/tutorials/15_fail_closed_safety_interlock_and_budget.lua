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
