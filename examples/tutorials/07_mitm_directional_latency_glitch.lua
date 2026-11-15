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
