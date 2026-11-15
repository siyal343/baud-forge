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
