-- Tutorial 06: Deterministic Single-Event Upset (SEU) Bit-Flip Fuzzer
-- Concepts:
--   * Initialization lifecycle hook bforge.on_init
--   * Deterministic xorshift64* PRNG via bforge.seed(42) and bforge.rand(min, max)
--   * Fault injection via frame:xor_bit, frame:xor_u8, and frame:corrupt_crc(1)

local seu_events = 0

bforge.on_init(function(ctx)
  bforge.seed(42)
  bforge.metric("fuzzer_seed", 42)
  bforge.log_info("SEU fuzzer armed on " .. tostring(ctx.script))
end)

bforge.on_rx_frame("*", function(frame)
  if frame.len == 0 then
    return frame
  end

  seu_events = seu_events + 1
  local max_payload = math.max(0, frame.len - 2)
  local bit_off = bforge.rand(0, max_payload)
  local bit_idx = bforge.rand(0, 7)
  local byte_mask = bforge.rand(1, 15)

  -- Flip a reproducible single bit inside the payload.
  frame:xor_bit(bit_off, bit_idx)

  -- Flip a reproducible bit-mask in a neighboring payload byte when room permits.
  if frame.len >= 3 then
    local byte_off = (bit_off + 1) % (frame.len - 1)
    frame:xor_u8(byte_off, byte_mask)
    bforge.metric("last_xor_u8_offset", byte_off)
  end

  -- Intentionally corrupt the trailing CRC byte so receiver error handling is exercised.
  if frame.len >= 2 then
    frame:corrupt_crc(1)
  end

  bforge.metric("seu_events", seu_events)
  bforge.metric("last_flip_offset", bit_off)
  bforge.metric("last_flip_bit", bit_idx)
  return frame
end)
