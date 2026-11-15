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
