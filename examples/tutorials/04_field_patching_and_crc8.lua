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
