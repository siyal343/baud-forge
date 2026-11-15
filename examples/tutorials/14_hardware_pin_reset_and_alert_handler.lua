-- Tutorial 14: Hardware Pin Reset & Watchdog Alert Handler
-- Concepts:
--   * Alert subscription via bforge.on_alert("dead_man_timer", fn(alert))
--   * Hardware control lines via bforge.set_pins, bforge.pulse_pin, and bforge.trigger_pin
--   * Automated MCU reset / bootloader recovery sequence

local resets = 0

bforge.on_alert("dead_man_timer", function(alert)
  resets = resets + 1
  bforge.log_warn(string.format(
    "recovery #%d on alert `%s`: %s",
    resets,
    tostring(alert.name),
    tostring(alert.detail)
  ))

  -- Assert DTR (boot/hold), pulse RTS to reset target MCU, then release DTR/RTS low.
  bforge.set_pins(true, false)
  bforge.pulse_pin("RTS", 25)
  bforge.trigger_pin("*", "DTR_LOW")

  bforge.metric("mcu_resets", resets)
  bforge.metric("last_alert_ts_us", alert.timestamp_us or 0)
end)

bforge.on_rx_frame("*", function(frame)
  bforge.metric("last_rx_seq", frame.seq_id)
  return frame
end)
