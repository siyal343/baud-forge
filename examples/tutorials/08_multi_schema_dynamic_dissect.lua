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
