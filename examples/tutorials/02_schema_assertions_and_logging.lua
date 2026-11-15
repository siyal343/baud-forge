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
