# Lua Script Lab — What It Is, How It Works & Revamp Plan

**Date:** 2026-11-16  
**Scope:** `ui/src/components/ScriptLabView.tsx` (`LUA 5.4 SCRIPT LAB`), `ui/src/services/luaSandboxFallback.ts`, `crates/bforge-script/`

---

## 1. What Lua Script Lab Is

**Lua Script Lab** (`ScriptLabView.tsx`, registered in `WorkstationDock.tsx` as `scriptLab` / `LUA SCRIPT LAB`) is BaudForge's **programmable packet-interceptor and hardware-in-the-loop (HIL) scripting workbench**.

Instead of only viewing serial packets (`PacketStreamView`) or manually clicking buttons (`CommandForge`, `FaultRigView`), Lua Script Lab lets you run a **sandboxed Lua 5.4 script** inline on the serial/bridge data path:

- **When connected to the Rust engine (`ENGINE LUA 5.4`):** Scripts run in `crates/bforge-script` (`mlua` Lua 5.4 VM) with a 200,000-instruction budget per frame and configurable memory cap.
- **When disconnected / in browser preview (`SIMULATED PREVIEW`):** Scripts run in `ui/src/services/luaSandboxFallback.ts` (a TypeScript Lua 5.4 interpreter) so you can test and dry-run scripts offline.

### What Scripts Can Do
1. **Virtual Device / Auto-ACK (`bforge.on_rx_frame` + `bforge.send`):** Respond to incoming commands automatically when real hardware is not connected or you are simulating a sensor/MCU.
2. **In-Flight Packet Mutation (`bforge.on_rx_frame` / `on_tx_frame` / `on_mitm_frame`):** Modify bytes or decoded schema fields (e.g., patch a field and call `frame:recalc_crc()`), delay frames (`frame:delay_ms(ms)`), split frames (`bforge.burst`), or drop frames (return `nil` / `frame:drop()`).
3. **Fault Injection & Fuzzing (`frame:xor_bit`, `frame:corrupt_crc`, `bforge.rand`):** Deterministically corrupt bits, drop every Nth frame, or inject jitter using a repeatable `SEED`.
4. **Live Telemetry & Automated Checks (`bforge.plot`, `bforge.metric`, `bforge.assert`, `bforge.pulse_pin`):** Extract derived values into `PlotForgeView` / `OscilloscopeView`, track live counters, assert protocol invariants, or toggle `DTR`/`RTS` pins.

---

## 2. How It Is Supposed to Be Used (Intended Workflow)

1. **Choose or write a script (Left Pane):**
   - Pick a starting point from the template dropdown (5 starter templates or 15 numbered tutorials `01`–`15`), or load a `.lua` file.
   - Define at least one hook, such as `bforge.on_rx_frame(function(frame) ... end)`.
2. **Check syntax (`COMPILE`):**
   - Compiles the script and shows which hooks were registered (e.g., `on_rx_frame`, `on_timer`) in the editor sub-header.
3. **Test safely on one frame (`DRY-RUN PACKET` / `Ctrl+Enter`, Right Pane -> `DRY-RUN DIFF`):**
   - Runs the script **once in isolation** against either the currently selected packet from `PacketStreamView` or manual hex typed in the `TEST TARGET` box.
   - Shows **VM COST** (instructions + µs), **BYTE DIFF GRID** (before vs. after bytes), **DECODED FIELD DIFF**, and **EMITTED SIDE-EFFECTS** (`send`, `plot`, `pin`, `log`) without touching live traffic or live counters.
4. **Go live (`ARM SCRIPT`, Right Pane -> `LIVE VM & WATCH`):**
   - Arms the script on the active session so **every live RX/TX/MITM frame** passes through the Lua VM.
   - Monitor live `INVOCATIONS`, `CHANGED`, `DROPPED`, `DELAYED`, `INJECTED TX`, `FAILURES`, `bforge.metric` watch values, `bforge.assert` pass/fail counts, and `bforge.log` output in `LIVE VM & WATCH`.
   - Click `DISARM` when finished.

---

## 3. Why It Currently Feels Confusing (Observed UX Issues in `ScriptLabView.tsx`)

1. **No orientation or workflow hierarchy:**
   - The header toolbar (`ScriptLabView.tsx:525-694`) packs **12 controls** into one wrapping row (`Template` select, `FAIL-OPEN/FAIL-CLOSED` select, `SEED` input, `COMPILE`, `DRY-RUN PACKET`, `ARM SCRIPT`, `RESET`, `LOAD`, `SAVE`, `QUICK FAULTS`).
   - Nothing explains *what "Arm" means* (live bus interception), *what "Dry-Run" tests against*, or *what `FAIL-OPEN` / `SEED` do*.
2. **Mixed mental models (`QUICK FAULTS` bolted onto the Lua IDE):**
   - `QUICK FAULTS` (`ScriptLabView.tsx:696-773`) injects static hardware faults (`Bit Flip`, `Drop Every 5th Frame`, `1-SHOT BAD CRC`) outside the Lua VM. Having a non-Lua fault bar inside the Lua Script Lab blurs the boundary between `FaultRigView` and programmable Lua scripting.
3. **20 templates hidden in one flat `<select>`:**
   - `SCRIPT_TEMPLATES` has 5 starters + 15 tutorials, but the `<select>` shows only names (`Template: ...`, `Tutorial 01: ...`) with no description, expected packet/schema, or learning path.
4. **Subtle state & target feedback:**
   - Users cannot easily tell whether `DRY-RUN` is using a packet from `PacketStreamView` or the hardcoded `DEFAULT_TEST_FRAME_HEX`, or what happens when `ARM SCRIPT` is active while switching tabs/panels.
   - The editor is a plain `<textarea>` with a manual line-number gutter (`ScriptLabView.tsx:853-877`) and a compact `API REF` drawer (`max-h-36`) that truncates descriptions.

---

## 4. Proposed Revamp Plan

### Goal
Make Lua Script Lab immediately understandable to someone opening it for the first time, without losing any `bforge-script` capabilities.

### Concrete Changes
1. **Clean 3-Part Header + Live Interception Banner:**
   - **Primary actions only:** `Test (Dry-Run)` (`Ctrl+Enter`) and `Arm on Live Bus` / `Disarm` (with a clear active banner: *"ARMED — Intercepting live RX/TX frames on COMx"*).
   - **Secondary/advanced controls** (`Policy: Fail-Open / Fail-Closed`, `PRNG Seed`, `Reset VM`, `Load .lua`, `Save .lua`) moved into a compact **VM Settings / File** popover or secondary menu so they don't compete with the main workflow.
   - Remove `COMPILE` as a mandatory mental step (compile automatically on `Dry-Run` / `Arm`, or keep a subtle status indicator: `Syntax OK · 1 hook`).
2. **Guided Empty / Starter State & Template Drawer:**
   - Replace the crammed `<select>` with a **Templates & Tutorials** button/drawer that groups scripts by use case (*Auto-Reply / Virtual Device*, *Modify & Patch CRC*, *Fault Injection*, *Telemetry & Assertions*, *15-Step Tutorial*) with a 1-line summary of what each script does.
3. **Clearer `TEST (DRY-RUN)` vs `LIVE BUS` Right Pane:**
   - Show a visible source pill on the test input (`From Packet #42` vs `Custom Hex`, with a quick `Reset to Sample` button).
   - Auto-switch or clearly badge `LIVE VM & WATCH` when the user clicks `Arm on Live Bus` so they immediately see live counters and logs moving.
4. **Decouple or Demote `QUICK FAULTS`:**
   - Either remove the inline `QUICK FAULTS` strip from `ScriptLabView` (keeping a single `Fault Rig ↗` link) or tuck it behind a clearly labeled non-Lua link, so `ScriptLabView` stays focused on Lua scripting.
5. **Better Editor & API Reference:**
   - Keep `API REF` searchable/categorized (`Hooks`, `Frame Bytes`, `Schema Fields`, `CRC & Faults`, `Plot & Pins`) with click-to-insert snippets.
   - (Optional) Highlight compile/runtime error lines in the line-number gutter.
