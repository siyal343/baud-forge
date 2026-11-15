-- Tutorial 09: Packet Burst Duplication & Fragmented Split
-- Concepts:
--   * Returning FrameVerdict::Burst via bforge.burst({ { payload, delay_ms }, ... })
--   * Capturing an unmodified byte snapshot with frame:clone_bytes()
--   * Spaced hex roundtripping with bforge.unhex / bforge.hex and payload slicing

bforge.on_tx_frame("*", function(frame)
  local original = frame:clone_bytes()
  local dup = bforge.unhex(frame)
  if #dup >= 1 then
    -- Invert the trailing byte on the duplicate to simulate a corrupted retransmission.
    dup[#dup] = dup[#dup] ~ 0xFF
  end
  local dup_hex = bforge.hex(dup)

  local half = math.floor(#original / 2)
  if half >= 1 and #original > half then
    local part1 = frame:slice(0, half)
    local part2 = frame:slice(half, #original - half)
    bforge.metric("burst_count", 4)
    return bforge.burst({
      { original, 0 },
      { dup_hex, 10 },
      { part1, 20 },
      { part2, 25 },
    })
  end

  bforge.metric("burst_count", 2)
  return bforge.burst({
    { original, 0 },
    { dup_hex, 10 },
  })
end)
