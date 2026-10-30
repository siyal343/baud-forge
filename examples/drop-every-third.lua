-- Example HIL script: drop every third frame, to see how a receiver handles a gap.
-- Returning nil drops the frame.

local seen = 0

bforge.on_frame(function(frame)
  seen = seen + 1
  if seen % 3 == 0 then
    return nil
  end
  return frame
end)
