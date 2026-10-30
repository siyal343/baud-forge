-- Example HIL script: corrupt the last byte of every transmitted frame, which is
-- where a checksum usually lives. The receiver should reject these frames, and
-- that rejection is the thing under test.
--
--   [workspace]
--   script_path = "examples/flip-last-byte.lua"

bforge.on_frame(function(frame)
  local bytes = bforge.unhex(frame)
  bytes[#bytes] = bytes[#bytes] ~ 0xFF
  bforge.log("flipped " .. #bytes .. " bytes")
  return bforge.hex(bytes)
end)
