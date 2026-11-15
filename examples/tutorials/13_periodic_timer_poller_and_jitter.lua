-- Tutorial 13: Periodic Timer Poller & RX Jitter Plotter
-- Concepts:
--   * Periodic timer callback via bforge.on_timer(100, fn(ctx))
--   * Monotonic clocks bforge.now_us() / bforge.now_ms() and active polling with bforge.send
--   * RX inter-arrival delta and jitter plotting via bforge.plot

local poll_seq = 0
local last_rx_us = nil
local prev_dt_us = nil

bforge.on_timer(100, function(ctx)
  poll_seq = poll_seq + 1
  local now_ms = ctx.now_ms or bforge.now_ms()

  local header = string.pack("<HBB", 0x55AA, 0x01, poll_seq & 0xFF)
  local crc = bforge.crc("crc8", header)
  local pkt = header .. string.pack("<B", crc)

  bforge.send("*", pkt, { delay_ms = 0, run_tx_hooks = false })
  bforge.metric("polls_sent", poll_seq)
  bforge.metric("last_poll_ms", now_ms)
end)

bforge.on_rx_frame("*", function(frame)
  local rx_us = (frame.timestamp_us and frame.timestamp_us > 0) and frame.timestamp_us or bforge.now_us()

  if last_rx_us ~= nil then
    local dt_us = rx_us - last_rx_us
    bforge.plot("rx_interval_us", dt_us, rx_us)
    if prev_dt_us ~= nil then
      local jitter_us = math.abs(dt_us - prev_dt_us)
      bforge.plot("rx_jitter_us", jitter_us, rx_us)
      bforge.metric("last_jitter_us", jitter_us)
    end
    prev_dt_us = dt_us
  end

  last_rx_us = rx_us
  return frame
end)
