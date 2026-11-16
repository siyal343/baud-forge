# Workflows & User Flows

BaudForge combines 15 specialized panels around a 4-panel daily core. Use the **3 Recipe Flows** below to see which panels work together for common engineering tasks, or browse the individual panel flows.

---

## Recipe Flows (Goal-Oriented)

### Recipe A: MCU Bring-Up & Firmware Flash
```mermaid
flowchart LR
    A["Pin Sequencer (Bootloader DTR/RTS)"] --> B{"Flash Method?"}
    B -->|"In-App"| C["X/YMODEM Transfer (.bin)"]
    B -->|"External Programmer"| D["Flash Yield (Release Port)"]
    D --> E["Run External Flasher"]
    E --> F["Re-Attach Port"]
    C --> G["Pin Sequencer (Reset)"]
    F --> G
    G --> H["Packet Stream (Verify Boot Banner)"]
```

### Recipe B: Binary Telemetry & Signal Debug
```mermaid
flowchart LR
    A["Schema Dialects (Load .h / .proto / MAVLink)"] --> B["Packet Stream (Live Decoded Frames)"]
    B --> C["Click Packet -> Protocol Dissector"]
    C --> D["Bind Numeric Field to Plot"]
    D --> E["Oscilloscope (Live DSO) or Plot Forge (FFT / Math)"]
    E --> F["Scrub DVR Timeline on Glitch"]
```

### Recipe C: HIL Fault Injection & Crash Triage
```mermaid
flowchart LR
    A["Connect Port A + Port B (MITM Bridge)"] --> B{"Fault Type?"}
    B -->|"Static TX Fault"| C["HIL Fault Rig (Bit Flip / Drop / CRC)"]
    B -->|"Programmable Logic"| D["Lua 5.4 Script Lab (Dry-Run -> Arm)"]
    C --> E["Observe DUT Recovery in Packet Stream"]
    D --> E
    E -->|"Crash PC Logged"| F["ELF Symbols (Load .elf -> Resolve Line)"]
```

---

## Master Session Lifecycle

```mermaid
flowchart LR
    A["Open BaudForge (Launcher)"] --> B{"Target Mode?"}
    B -->|"Hardware Port"| C["Select Serial Port + Baud/8N1"]
    B -->|"No Hardware"| D["Start Simulated Mode"]
    B -->|"Replay File"| E["Open .bflog Vault"]
    C --> F["Connect -> Core 4-Panel Workbench"]
    D --> F
    E --> G["Scrub DVR Timeline & Inspect"]
    F --> L["Toggle REC -> Write .bflog Vault"]
    L --> M["Export (PCAPNG / CSV / JSONL / Saleae)"]
```

---

## Core Daily Workbench

### [Packet Stream](packet-stream.html)
```mermaid
flowchart LR
    A["Live RX/TX Bytes"] --> B["Framer (COBS / SLIP / Delimiter / Fixed)"]
    B --> C["Virtualized Packet List"]
    C --> D["Filter by Port / Direction / Search"]
    C --> E["Click Packet Row"]
    E --> F["Updates Protocol Dissector"]
    E --> G["Toggle HEX PANE (Inline Hex+ASCII)"]
    G -->|"Optional"| H["Pop Out to Hex Inspector Tab"]
```

### [Protocol Dissector](protocol-dissector.html)
```mermaid
flowchart LR
    A["Select Packet in Packet Stream"] --> B{"Schema Loaded?"}
    B -->|"No"| C["Open Schema Dialects (.h / .proto / MAVLink)"]
    C --> D["Decoded Field Tree"]
    B -->|"Yes"| D
    D --> E["Inspect Field Values & Bitfields"]
    D --> F["Click Plot / Bind on Numeric Field"]
    F --> G["Streams Field to Oscilloscope / Plot Forge"]
```

### [Telemetry Oscilloscope](oscilloscope.html) & Plot Forge
```mermaid
flowchart LR
    A["Bind Numeric Fields or script:series"] --> B{"Analysis Need?"}
    B -->|"Live Edge Trigger / Scope"| C["Oscilloscope (Time-Domain DSO)"]
    B -->|"FFT / XY / Math Expr"| D["Plot Forge (Multi-Chart Studio)"]
    C <-->|"1-Click Switch"| D
```

### [Command Forge](command-forge.html)
```mermaid
flowchart LR
    A["Choose Input Mode"] --> B["Preset Macro Button"]
    A --> C["Raw ASCII / Spaced Hex"]
    A --> D["Struct-Aware Field Form"]
    B --> E["Optional Checksum / Delimiter Append"]
    C --> E
    D --> E
    E --> F["Send TX (Single or Repeat Interval)"]
    F --> G["Appears in Packet Stream & .bflog"]
```

---

## Telemetry, Hex & Symbols

- **[Canonical Hex & ASCII](hex-inspector.html):** Pop out from Packet Stream `HEX PANE` -> click any byte offset -> inspect `u8`/`u16`/`u32`/`f32` interpretations.
- **[Schema Dialects](schema-dialects.html):** Choose `.h` / `.proto` / MAVLink / Kaitai -> load or paste -> compile to Dissector IR -> auto-decodes Packet Stream, Dissector, and Lua `frame:get()`.
- **[ELF Symbols](elf-symbols.html):** Load firmware `.elf` -> paste hex crash PC -> resolve function name and `file:line`.
- **[Session Diff](session-diff.html):** Pick golden `.bflog` + candidate `.bflog` -> compare frame counts, payload diffs, and timing jitter.

---

## HIL, Scripting & Specialist

### [Lua 5.4 Script Lab](script-lab.html)
```mermaid
flowchart LR
    A["Pick Template/Tutorial or Load .lua"] --> B["Read Summary Strip (Hook + Purpose)"]
    B --> C["Select Target (Packet Stream Row or Custom Hex)"]
    C --> D["Click DRY-RUN PACKET (Ctrl+Enter)"]
    D --> E["Inspect Verdict, Byte Diff Grid, Field Diff & VM Cost"]
    E -->|"Logic Wrong"| A
    E -->|"Looks Good"| F["Open VM & FILE (Policy, Seed)"]
    F --> G["Click ARM ON LIVE BUS"]
    G --> H["Monitor LIVE VM & WATCH (Counters, Metrics, Assertions, Logs)"]
    H --> I["Click DISARM when Done"]
```

### [HIL Fault Injection Rig](fault-rig.html)
```mermaid
flowchart LR
    A["Flip Master Safety Interlock (SAFE -> ARMED)"] --> B["Pick Fault Profile (Bit Flip / Drop / Corrupt CRC / Truncate / Delay)"]
    B --> C["Click Apply Live Mutation"]
    C --> D["All Outgoing TX / Bridge Frames Corrupted"]
    D --> E["Observe DUT Recovery in Packet Stream"]
    E --> F["Disarm Faults to Restore Clean Link"]
```

### [Pin Sequencer](pin-sequencer.html), [X/YMODEM](file-transfer.html), [MITM Bridge](mitm-bridge.html) & [Activity Log](activity-log.html)
- **Pin Sequencer:** Click `Reset` / `Bootloader` macro or build timed `DTR`/`RTS` sequence -> pulses serial adapter lines.
- **X/YMODEM Transfer:** Enter bootloader -> select `.bin` -> choose XMODEM/YMODEM -> watch block progress -> reset MCU.
- **MITM Bridge:** Connect Port A + Port B -> enable bridge -> frames forward `A <-> B` live (optionally attach Lua `on_mitm_frame` or Fault Rig).
- **Activity Log:** Filter structured engine/UI/script/fault events by severity or source to diagnose disconnects or script errors.
