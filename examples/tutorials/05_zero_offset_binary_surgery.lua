-- Tutorial 05: Zero-Offset Binary Surgery (No Schema Required)
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
end)
