-- Tutorial 01: Packet Filter & Frame Metadata
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
end)
