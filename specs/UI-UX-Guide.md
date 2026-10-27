**BaudForge** should look like a hybrid between **Saleae Logic 2** (ultra-clean, high-frame-rate dark mode telemetry), **Wireshark** (structured packet dissection), and **Linear / Zed IDE** (keyboard-first, crisp 1px borders, zero visual bloat).

Rather than hiding controls behind deep modal dialogs like PuTTY or Tera Term, every hardware signal, framing state, and packet field should be **immediately visible and interactive at a glance**.

---

## 1. Visual Design Language ("Precision Avionics Dark")

* **Surface Palette:** Deep obsidian background (`#0B0E14`) with elevated slate panels (`#111621`) and crisp hairline borders (`#1E2638`) so high-contrast telemetry lines and syntax-highlighted hex bytes pop without causing eye strain during 12-hour lab sessions.
* **Semantic Color Encoding:** Color is strictly reserved for hardware/protocol state, never decoration:
* **Emerald (`#10B981`):** Valid CRC, active link, asserted hardware pin (`CTS`/`DSR` High), `RX` nominal stream.
* **Electric Cyan (`#06B6D4`):** Outgoing `TX` commands, highlighted struct fields, active time-scrubber cursor.
* **Amber (`#F59E0B`):** Flash-Yield paused state, timing drift warning ($\Delta t$ exceeded baseline), or MITM active interception.
* **Crimson (`#EF4444`):** Invalid CRC, UART framing/overrun error, injected SEU bit-flip fault, or resolved `HARDFAULT` ELF backtrace.


* **Typography:**
* **Data & Hex Viewport:** Strictly tabular monospace (**JetBrains Mono** or **Berkeley Mono**) with ligatures disabled in the hex grid for exact column alignment.
* **UI Controls & Dissector Labels:** Compact geometric sans-serif (**Inter** at `11px–12px`) with tabular numerals (`font-variant-numeric: tabular-nums`) so fast-updating counters never jitter horizontally.



---

## 2. Spatial Layout Blueprint (5-Zone Tiling Workbench)

The window is organized into a dockable, keyboard-navigable (`Ctrl+1..5`) tiling grid with zero wasted title-bar space:

```text
+--------------------------------------------------------------------------------------------------+
| [⚡ FT2232H:A (OBC) ● 2.0M COBS] [🔌 Yield (Ctrl+Y)]   [PIN: DTR● RTS○ CTS● DSR○]   [MITM: ON ⚠️] | <- 1. Hardware Ribbon
+----------------------+----------------------------------------------------+----------------------+
| 2. LEFT SIDEBAR      | 3A. SYNCHRONIZED TERMINAL & HEX VIEWPORT           | 4. RIGHT INSPECTOR   |
|                      |----------------------------------------------------|                      |
| ▼ Active Ports (2)   | Δt (us)  | Dir | Raw Hex (COBS) | Decoded / ANSI   | ▼ Dissected Packet   |
|  ● COM4 (OBC_MAIN)   | +000124  | RX  | AA 55 04 3D 2C | [TM] ImuPacket   |  ├─ sync: 0xAA55     |
|  ● COM5 (EPS_NODE)   | +000998  | TX  | CAFE 09 03 2C  | [CMD] SafeMode   |  ├─ cmd_id: 0x04     |
|                      | +000042  | ⚡  | 0800412A       | ↳ flight.c:184   |  ├─ v_batt: 8.19 V 📈|
| ▼ Protocol Schema    |----------------------------------------------------|  └─ crc16: 0x9F2A ✓  |
|  📄 telemetry.h      | 3B. 60-FPS WEBGL TELEMETRY & DVR SCRUBBER          |                      |
|  ├─ ImuPacket (24B)  | 8.4V |      /\          | Cursor: T-00:04.120s     | ▼ Fault Injector     |
|  └─ EpsCommand (8B)  | 7.8V |_____/  \_________|________________________  |  [x] Flip Bit 4 (SEU)|
|                      |      +------------------+------------------------  |  [ ] Corrupt CRC16   |
| ▼ Saved Macros       | [◀◀] [⏸ Pause] [DVR Timeline: ========|====] [Live]|  Delay: [ 12 ms   ]  |
+----------------------+----------------------------------------------------+----------------------+
| 5. COMMAND FORGE: [Sync: 0xCAFE] [Op: 0x09 ▼] [Hold: 300s] [CRC16: 0x4A1B (Auto)] [Send (Enter)] |
+--------------------------------------------------------------------------------------------------+
| DISK VAULT: rec_20261027.bflog (1.42 GB | 0 Dropped) | ELF: obc.elf (Synced) | Throughput: 842 KB/s| <- 6. Telemetry Footer
+--------------------------------------------------------------------------------------------------+

```

### Zone-by-Zone Breakdown

1. **Top Hardware Ribbon (36px height):**
* **Port Pill & Flash-Yield Button:** Shows the hardware-bound device (`FT2232H #FT5X9A1B`), live baud rate, and an amber **`[🔌 Yield for Flash]`** button that blinks when `esptool`/`openocd` temporarily borrows the port.
* **Live Pin Matrix:** Interactive LED pills for `DTR`, `RTS`, `CTS`, `DSR`, `DCD`, and `BREAK`. Clicking `DTR` or `RTS` toggles the physical pin immediately; right-clicking triggers a saved bootloader pulse macro.


2. **Left Sidebar (Workspace & Schema Tree):**
* Lists connected ports, loaded `.h` / `.proto` / CCSDS schemas, and saved command macros.


3. **Center Split Viewport (The Core Canvas):**
* **Top Half (Synchronized Stream & Hex View):** Columns for **Microsecond $\Delta t$**, **Direction Badge** (`RX`, `TX`, `MITM`), **Compact Hex**, and **Decoded ASCII / Inline ELF Badges**. Hovering over a byte in the Hex column highlights the corresponding decoded struct field in the Right Inspector.
* **Bottom Half (WebGL Telemetry & DVR Scrubber):** Live time-series plots and bitfield state lanes. Includes a **DVR Timeline Bar**—dragging the playhead backward freezes both the chart and the terminal at that exact microsecond so you can correlate a voltage drop with the exact UART frame on screen.


4. **Right Inspector (Packet Dissector & Fault Injection Studio):**
* **Top Tab (Dissector Tree):** Unpacks the currently selected binary packet into typed engineering units (`float32`, `uint16_le`, bitfield flags) with a **`[📈 Plot]`** icon next to every numeric field.
* **Bottom Tab (MITM & Fault Injector):** Live toggles to arm a Bit-Error-Rate (BER) generator, corrupt outgoing CRCs, or intercept a specific command ID mid-flight.


5. **Bottom Command Forge (Packet Builder Bar):**
* Replaces the blind text input box with **typed pill inputs** (`[Opcode: u8]`, `[Target_V: float32]`, `[CRC: Auto-CRC32C]`). Shows a live preview of the raw COBS-encoded hex bytes before you press `Enter`.



## 4. Signature Micro-Interactions That Set It Apart

* **Bi-Directional Byte-to-Field Highlighting:** When you hover over `v_bus: 8.19 V` in the Right Inspector, the exact 4 bytes (`3F 51 EB 85`) glow cyan in the Center Hex column, and a tooltip shows the raw binary bits (`00111111 01010001...`), endianness (`Float32 Little-Endian`), and C-struct byte offset (`+0x06`).
* **One-Click "Plot This Field" (`📈`):** Every numeric leaf node in the Dissector Tree has a tiny chart icon next to it. Clicking it immediately spawns a synchronized WebGL trace in the bottom telemetry dock—zero configuration files or regex rules required.
* **Inline ELF Crash Expansion:** When an incoming ASCII line contains a memory pointer like `0x0800412A`, BaudForge renders an inline pill badge (`↳ src/eps_drv.c:184`). Hovering over the badge pops up a 5-line preview of the C/Rust source code around line 184 directly inside the terminal; clicking it opens your IDE.
* **Visual Flash-Yield Countdown:** When you run `cargo embed` or `esptool.py`, the top-left Port Pill smoothly morphs from Emerald (`● Connected`) to pulsing Amber (`🔌 Yielded to PID 4812 (esptool)`), dimming the terminal slightly and drawing a vertical dashed `"--- FIRMWARE FLASH & RESET ---"` marker across both the log and the telemetry graph before reconnecting automatically.