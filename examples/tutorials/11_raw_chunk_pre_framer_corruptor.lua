-- Tutorial 11: Raw Chunk Pre-Framer Corruptor
-- Concepts:
--   * Pre-framer stream interception with bforge.on_raw_chunk("*", fn)
--   * Reading and rewriting unframed chunks via chunk:raw(), chunk:set_bytes(...), chunk:resize(...)
--   * Stress-testing sync-word acquisition and partial-frame reassembly

local chunks = 0

bforge.on_raw_chunk("*", function(chunk)
  chunks = chunks + 1
  bforge.metric("raw_chunks", chunks)

  local raw = chunk:raw()
  if (chunks % 2) == 1 then
    -- Odd chunks: inject two garbage bytes ahead of the sync preamble.
    chunk:set_bytes(string.pack("<BB", 0x00, 0xFF) .. raw)
    bforge.metric("last_fault", "prepend_garbage")
  else
    -- Even chunks: truncate to half length to exercise partial-read buffering.
    local half = math.max(1, math.floor(chunk.len / 2))
    chunk:resize(half)
    bforge.metric("last_fault", "truncate_half")
  end

  return chunk
end)
