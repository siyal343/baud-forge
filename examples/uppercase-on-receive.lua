-- Receive-side example: the host sees every arriving byte uppercased. Two uses:
-- prove a decoder rejects what it should, and watch how a device's text output
-- would read if its case were wrong.
--
--   [workspace]
--   rx_script_path = "examples/uppercase-on-receive.lua"

bforge.on_frame(function(frame)
  local bytes = bforge.unhex(frame)
  for index = 1, #bytes do
    -- ASCII lower case to upper case, everything else untouched.
    if bytes[index] >= 97 and bytes[index] <= 122 then
      bytes[index] = bytes[index] - 32
    end
  end
  return bforge.hex(bytes)
end)
