# Lua 5.4 Script Lab

**Lua 5.4 Script Lab** is BaudForge's programmable packet-interceptor and hardware-in-the-loop (HIL) scripting workbench. Instead of only inspecting frames or clicking static fault buttons, you can run a sandboxed Lua 5.4 script directly on the RX, TX, MITM bridge, or timer path.

## Dual Execution Modes

- **`ENGINE LUA 5.4`:** Runs in the native Rust `mlua` VM (`200,000` instructions per callback, `4 MiB` default heap) with real serial/CAN hardware pins, timers, and MITM bridges.
- **`SIMULATED PREVIEW`:** Runs in the browser's offline Lua 5.4 sandbox when disconnected so you can test and dry-run templates without hardware.

## 4-Step Workflow

1. **Pick or Write a Hook:** Select one of the 5 starter templates or 15 progressive tutorials from the template dropdown (the summary strip shows what the script does and which hook it registers), or load a `.lua` file under **VM & FILE**.
2. **Dry-Run Safely (`DRY-RUN PACKET` / `Ctrl+Enter`):** Tests the script **once in isolation** against either the selected packet from [Packet Stream](packet-stream.html) (`PACKET STREAM`) or custom hex (`SAMPLE / CUSTOM HEX`). Inspect the **BYTE DIFF GRID**, **DECODED FIELD DIFF**, **EMITTED SIDE-EFFECTS**, and **VM COST** without affecting live traffic.
3. **Arm Live (`ARM ON LIVE BUS`):** Attaches the script to intercept every live RX/TX/MITM frame. The **LIVE INTERCEPTION ACTIVE** banner confirms the active hooks and error policy (`FAIL-OPEN` or `FAIL-CLOSED`).
4. **Watch & Assert (`LIVE VM & WATCH`):** Monitor live `INVOCATIONS`, `CHANGED`, `DROPPED`, `FAILURES`, `bforge.metric` watch values, `bforge.assert` pass/fail counts, and `SCRIPT CONSOLE` logs.

## Next Steps

- Follow the 15-step curriculum: [Lua 5.4 Tutorials (01–15)](lua-tutorials.html)
- Look up every hook and method: [Lua 5.4 API Reference](lua-api.html)
