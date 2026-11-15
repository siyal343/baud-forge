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
