# BaudForge: Visual & UX Designer Handover Specification

Date: 2026-11-03  
Document: Comprehensive Functional Specification for Visual & UX Design  
Status: Authoritative Engineering Specification  
Reference: `specs/ADR & SRS.md`, `crates/bforge-core/src/contract.rs`

---

## 1. Product Purpose & Mental Model

**BaudForge** is a high-performance desktop workstation for embedded systems engineers, firmware developers, and aerospace/robotics test rigs.

### The Hybrid Product Model
BaudForge combines four traditionally separate tools into one integrated screen:
1. **Serial Monitor (like PuTTY / Saleae Logic):** Raw high-speed data stream up to 12 Mbaud with sub-microsecond timestamps and modem line indicators.
2. **Protocol Dissector (like Wireshark):** Real-time breakdown of binary packets into structured fields using C header files or protocol schemas.
3. **Telemetry Oscilloscope (like an Agilent scope / Grafana):** Hardware-triggered real-time waveform plots, logic analyzer bit rails, and measurement cursors.
4. **Hardware Fault Rig (HIL / Man-in-the-Middle):** Physical pin manipulation, bit-error injection, packet fuzzing, and session recording.

### Primary User Personas
* **Embedded Firmware Engineer:** Debugging a microcontroller (e.g. ESP32, STM32, ARM Cortex-M) over UART, JTAG/SWO, or CAN bus.
* **HIL Validation Engineer:** Testing device resilience by injecting corrupted CRCs, dropped packets, and timing jitter into a live link.
* **Aerospace / Robotics Systems Engineer:** Inspecting structured telemetry frames (MAVLink, CCSDS, CSP, Modbus) during hardware qualification runs.

---

## 2. Complete Inventory of Functional Inputs

Functional inputs represent every control, selector, button, input field, and parameter the user can configure or interact with.

### 2.1 Transport & Hardware Connection Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `port_selector` | Dropdown (`ComboBox`) | Dynamic list of scanned ports (e.g., `COM8`, `/dev/ttyUSB0`) | First detected target | Selects the active communications target. |
| `port_rescan` | Icon button (`⟳`) | Action trigger | — | Rescans USB bus and refreshes the port dropdown. |
| `baud_preset_chips` | Quick-fill chips / pills | `9600`, `115.2k`, `230.4k`, `460.8k`, `921.6k`, `2.0M`, `12.0M` | `115200` | Instantly sets standard baud rates. |
| `baud_custom_input` | Numeric text field | Integer (`110` to `12,000,000`) | Hidden until `Custom...` active | Permits arbitrary non-standard integer baud rates. |
| `data_bits_selector` | Dropdown / segmented | `8`, `7`, `6`, `5` | `8` | Configures UART word length. |
| `parity_selector` | Dropdown / segmented | `None`, `Even`, `Odd`, `Mark`, `Space` | `None` | Configures parity verification bit. |
| `stop_bits_selector` | Dropdown / segmented | `1`, `2` | `1` | Configures framing stop bits. |
| `framing_mode_selector`| Dropdown | `Line-Delimited (\n)`, `COBS (0x00)`, `Length-Prefixed (u16)`, `SLIP`, `Raw Binary Stream` | `Line-Delimited (\n)` | Determines how raw byte streams split into discrete frames. |
| `custom_delimiter` | Hex text input | 1 to 4 hex bytes (e.g., `0xAA 0x55` or `0x0D 0x0A`) | `0x0A` | Custom packet delimiter bytes when delimiter mode active. |
| `dtr_line_toggle` | Checkbox / tactile switch | Boolean (`High`/`Low`) | `High` (asserted) | Controls Data Terminal Ready pin (prevents involuntary MCU reboot). |
| `rts_line_toggle` | Checkbox / tactile switch | Boolean (`High`/`Low`) | `Low` (deasserted) | Controls Request To Send pin. |
| `bootloader_pulse_btn` | Action button | Macro action (`DTR=0, RTS=1 -> 50ms -> DTR=1, RTS=0`) | — | Triggers automated microcontroller bootloader entry. |
| `break_condition_btn` | Button with duration | Duration in milliseconds (`1 ms` to `5000 ms`) | `100 ms` | Pulls TX line low to assert a UART BREAK condition. |
| `flash_yield_btn` | High-priority toggle button | Boolean (`Active`/`Idle`) with duration timer (`30s`) | `Idle` | Temporarily releases serial port for external flashing tools (`esptool`). |
| `connect_disconnect` | Primary action button | `Connect Device` / `Disconnect` | `Connect Device` | Starts or stops the hardware reader session thread. |
| `auto_detect_baud` | Assistive action button | Action trigger | — | Probes common baud rates to detect active incoming traffic. |

---

### 2.2 Protocol Dissection & Firmware Intelligence Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `schema_source_type` | Segmented tab | `C Header (.h)`, `Protobuf (.proto)`, `Native Aerospace Pack`, `Raw Hex` | `C Header` | Selects protocol parsing model. |
| `c_header_file_picker`| File browse input | Local path to `.h` file | Empty | Loads packed C struct definitions at runtime. |
| `root_struct_selector`| Dropdown / autocomplete | List of structs found in header (e.g. `ImuPacket`, `TelemetryFrame`) | Empty | Specifies the primary struct to dissect incoming packets against. |
| `native_pack_selector`| Dropdown | `CCSDS Space Packet (PUS)`, `CSP v1/v2`, `MAVLink v1/v2`, `Modbus RTU` | `CCSDS Space Packet` | Selects built-in standard protocol engine. |
| `mavlink_xml_picker` | File browse input | Local path to MAVLink `.xml` dialect | `common.xml` | Loads custom MAVLink message definitions. |
| `elf_binary_picker` | File browse input | Local path to compiled firmware `.elf` file | Empty | Binds firmware symbols for live crash trace decoding. |
| `watch_elf_toggle` | Toggle switch | Boolean (`On`/`Off`) | `On` | Monitors `.elf` file on disk and reloads symbols upon compiler rebuild. |

---

### 2.3 Stream Filter & Search Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `stream_search_input` | Text field (`/` shortcut) | Free text, regex, or field query (e.g. `v_batt > 8.0`) | Empty | Filters frames by content, field values, or symbols. |
| `direction_filter` | Segmented buttons | `All`, `RX Only`, `TX Only`, `MITM Only` | `All` | Filters stream by communication direction. |
| `packet_kind_filter` | Segmented buttons | `All`, `Errors Only (CRC/Frame)`, `Symbols Only`, `Heartbeats` | `All` | Filters stream by packet condition. |
| `port_filter` | Multi-select chips | List of configured ports (e.g., `[x] Port A  [x] Port B`) | All enabled | Isolates traffic to specific physical or virtual channels. |
| `clear_stream_btn` | Icon button | Action trigger | — | Clears currently buffered screen view (preserves disk vault). |
| `autoscroll_toggle` | Toggle icon button | Boolean (`Locked to Bottom`/`Free Scroll`) | `Locked` | Automatically scrolls down as new frames arrive. |

---

### 2.4 Command Forge & Hardware Transmission Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `tx_destination_port` | Dropdown | Available hardware ports | Active port | Designates destination port for transmitted data. |
| `tx_format_mode` | Segmented toggle | `Hex Bytes`, `ASCII String`, `Structured Struct Form` | `Hex Bytes` | Selects format mode for payload builder. |
| `tx_payload_input` | Multi-line text field | Hex string (e.g., `AA 55 04 00 2C`) or ASCII text | Empty | Raw byte payload editor. |
| `tx_line_ending` | Dropdown | `None`, `\n (LF)`, `\r\n (CRLF)`, `\0 (NULL)` | `\n (LF)` | Automatically appends line termination characters. |
| `tx_auto_crc` | Dropdown | `None`, `CRC-8`, `CRC-16-CCITT`, `CRC-16-MODBUS`, `CRC-32C`, `Checksum8` | `None` | Calculates and appends checksum bytes automatically. |
| `tx_parameter_fields`| Dynamic form inputs | Typed numeric inputs mapped from chosen struct definition | Form defaults | Fills struct fields directly without manual hex encoding. |
| `tx_repeat_toggle` | Checkbox | Boolean (`One-shot`/`Periodic Repeat`) | `One-shot` | Enables continuous periodic packet transmission. |
| `tx_repeat_period` | Numeric input + unit | `1 ms` to `60000 ms` | `100 ms` | Interval between repeated transmissions. |
| `tx_send_btn` | Primary button (`Enter`)| Action trigger | — | Transmits the forged packet. |

---

### 2.5 Hardware-in-the-Loop (HIL) Fault Rig & MITM Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `mitm_mode_selector` | Radio / segmented | `Disabled (Direct)`, `Passive Tap (Monitor)`, `Active Inline Bridge` | `Disabled` | Selects Man-in-the-Middle topology. |
| `bridge_port_a` | Dropdown | Hardware port list | Empty | Side A of the inline bridge (e.g., On-Board Computer). |
| `bridge_port_b` | Dropdown | Hardware port list | Empty | Side B of the inline bridge (e.g., Sensor / Radio). |
| `fault_profile_arm` | Master arm toggle switch| Boolean (`Disarmed (Clean)`/`Armed (Faulting)`) | `Disarmed` | Master safety interlock for fault injection. |
| `bit_error_rate_exp` | Stepper / slider | Exponent: $10^{-3}$ (heavy noise) down to $10^{-9}$ (rare SEU) | $10^{-5}$ | Injects single-bit flips randomly across frame bytes. |
| `packet_drop_rate` | Numeric ratio stepper | $1 \text{ in } N$ packets (e.g., drop every 5th frame) | Off ($0$) | Injects controlled packet loss. |
| `crc_corruption_chk` | Checkbox | Boolean (`Corrupt CRC`/`Keep CRC`) | `Off` | Inverts checksum bytes to verify receiver rejection logic. |
| `frame_truncation_chk`| Checkbox | Truncate payload after $N$ bytes (`1` to `256`) | `Off` | Cuts frames short to test incomplete frame timeouts. |
| `latency_jitter_slider`| Range slider with readout| `0 ms` to `5000 ms` | `0 ms` | Injects synthetic bus delay into bridged frames. |
| `script_hook_editor` | Code editor area | Rhai / Lua sandboxed script | Template | Custom conditional fault logic based on packet values. |

---

### 2.6 DVR Time-Scrubber & Playback Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `dvr_timeline_slider`| Full-width scrubber bar| Record index $0$ to total record count | Latest frame | Dragging seeks terminal, inspector, and scope to that microsecond. |
| `playback_play_pause`| Transport button | `▶ Play` / `⏸ Pause` (`Spacebar` shortcut) | `Live` | Toggles historical replay versus live streaming. |
| `playback_step_back` | Transport button (`◀`)| Single frame decrement | — | Steps backward one frame. |
| `playback_step_fwd` | Transport button (`▶`)| Single frame increment | — | Steps forward one frame. |
| `playback_speed` | Segmented pills | `0.25x`, `0.5x`, `1.0x`, `2.0x`, `4.0x`, `Max Speed` | `1.0x` | Controls playback speed relative to original $\Delta t$ timestamp. |
| `live_snap_btn` | Button with indicator | Action trigger | Active in live mode | Jumps scrubber directly to the newest live frame. |

---

### 2.7 Session Recording, Diff & Vault Controls
| Input Identifier | Control Type | Values / Range | Default Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `vault_record_toggle`| Red pill action button | Boolean (`Recording`/`Standby`) | `Standby` | Starts or seals the `.bflog` binary session capture. |
| `vault_file_name_input`| Text field | Valid file name (e.g., `orbit_test_run_01.bflog`) | Auto timestamp | File destination path inside `./vaults/`. |
| `export_format_selector`| Dropdown | `Wireshark (.pcapng)`, `CSV (.csv)`, `Saleae Logic (.csv)`, `JSON Lines (.jsonl)`, `Parquet (.parquet)` | `Wireshark (.pcapng)` | Selects export container format. |
| `export_execute_btn` | Action button | Action trigger | — | Exports recorded session to selected external format. |
| `diff_baseline_picker`| File browse input | Path to golden reference `.bflog` | Empty | Sets reference log for automated timing/field comparison. |
| `diff_target_picker` | File browse input | Path to anomalous test `.bflog` | Empty | Sets comparison log under test. |
| `diff_run_btn` | Action button | Action trigger | — | Executes semantic diff and timing regression analysis. |

---

## 3. Complete Inventory of Functional Outputs

Functional outputs represent every status badge, telemetry readout, tabular metric, chart element, and visual state emitted by the engine.

### 3.1 Hardware Link & Connection Status Indicators
| Output Element | Display Format | States / Dynamic Range | Description |
| :--- | :--- | :--- | :--- |
| `port_connection_badge`| Pill badge with colored dot | `TARGET DETECTED` (Emerald), `PORT READY` (Muted), `RECONNECTING` (Amber), `CLOSED` (Muted) | Current state of the physical hardware interface. |
| `device_vid_pid_badge` | Monospace chip text | e.g., `303A:1001 (Espressif ESP32-C3)` | USB Vendor ID and Product ID detected from OS USB descriptor. |
| `baud_indicator` | Monospace text | e.g., `115200 bps (8N1)` | Active communication speed and UART framing parameters. |
| `modem_pin_cts` | Circular LED indicator | `High` (Asserted Emerald) / `Low` (Deasserted Dim) | Clear To Send hardware line status from target MCU. |
| `modem_pin_dsr` | Circular LED indicator | `High` (Asserted Emerald) / `Low` (Deasserted Dim) | Data Set Ready hardware line status. |
| `modem_pin_dcd` | Circular LED indicator | `High` (Asserted Emerald) / `Low` (Deasserted Dim) | Data Carrier Detect line status. |
| `modem_pin_ri` | Circular LED indicator | `High` (Asserted Amber) / `Low` (Deasserted Dim) | Ring Indicator line status. |
| `modem_pin_dtr` | State indicator chip | `DTR HIGH` (Active Cyan) / `DTR LOW` | Output state of DTR pin driven by BaudForge. |
| `modem_pin_rts` | State indicator chip | `RTS HIGH` (Active Cyan) / `RTS LOW` | Output state of RTS pin driven by BaudForge. |
| `flash_yield_indicator`| Pulsing warning banner | `FLASH YIELD ACTIVE (18s remaining)` | Warns user that port is released for external flashing. |
| `diagnostic_warning_box`| Amber / Emerald framed card| Success or error message (e.g. `⚠ No incoming traffic detected`) | Visual diagnostic feedback from port auto-probing. |

---

### 3.2 Synchronized Terminal & Raw Hex Stream Outputs
| Output Element | Display Format | Values / Units | Description |
| :--- | :--- | :--- | :--- |
| `frame_sequence_id` | Tabular monospace counter | Integer (`#0000001` to `#9999999`) | Monotonically increasing sequence number for every frame. |
| `relative_timestamp` | Monospace signed readout | e.g., `+000124 us` ($\Delta t$ from previous frame) | Inter-packet microsecond arrival delta. |
| `absolute_timestamp` | Monospace timestamp | e.g., `15:02:45.120488` (UTC or local) | Wall-clock reception timestamp. |
| `direction_tag` | Colored badge | `RX` (Emerald), `TX` (Cyan), `A->B` (Amber), `B->A` (Amber), `FAULT` (Crimson) | Directional origin of the byte chunk. |
| `canonical_hex_grid` | 16-byte monospace grid | 2-character hex pairs: `AA 55 04 00 2C 08 ...` | Raw hex payload view with 4-byte spacing groups. |
| `ascii_representation` | Monospace character gutter | Printable characters (`.`, `A`, `z`, `$`), dots for non-printable | ASCII decoded gutter alongside hex dump. |
| `ansi_terminal_viewport`| VT100 / ANSI color terminal | Formatted ANSI text from target firmware `printf` | Terminal emulation showing firmware boot messages. |
| `hex_byte_highlight` | Background color box | Specific color mapped to dissected field | Constituent bytes highlighted when user selects field in tree. |

---

### 3.3 Dissected Protocol Tree Outputs
| Output Element | Display Format | Example Content | Description |
| :--- | :--- | :--- | :--- |
| `protocol_tag_badge` | Monospace header pill | `[TM] ImuPacket (24B)` / `[CCSDS] APID: 0x0120` | Identified protocol and root struct container name. |
| `crc_status_badge` | Status pill with icon | `CRC VALID ✓` (Emerald) / `CRC MISMATCH ⚠` (Crimson) | Checksum verification outcome. |
| `crc_delta_readout` | Small monospace callout | `Expected: 0x9F2A, Got: 0x9F2B` | Specific mismatch details when CRC verification fails. |
| `field_tree_nodes` | Collapsible tree grid | Hierarchical struct fields with indentation levels | Visual layout of nested structs, bitfields, and arrays. |
| `field_name_label` | Monospace text | `gyro_z`, `v_batt`, `seq_count` | Exact identifier names from C header or schema. |
| `field_raw_hex_value` | Monospace hex text | `0x3D 0x2C` | Raw byte value extracted from payload. |
| `field_decoded_value` | Monospace formatted value | `-0.042`, `8.19`, `1013.25` | Scaled, endian-corrected numerical value. |
| `field_unit_label` | Muted unit text | `rad/s`, `V`, `hPa`, `mA`, `degC` | Engineering units parsed from struct comments or schemas. |
| `enum_variant_label` | Tag pill | `SAFE_MODE (0x02)`, `ARMED (0x01)` | Human-readable enumeration variant name. |
| `bitfield_flag_switches`| Multi-bit binary display | `[0][1][0] (Bit 0..2: Mode=2)` | Visual breakdown of packed bitfield integers. |

---

### 3.4 Firmware ELF Symbol & Backtrace Outputs
| Output Element | Display Format | Example Content | Description |
| :--- | :--- | :--- | :--- |
| `symbol_badge` | Clickable pill badge | `[flight_ctrl.c:184 (pid_update)]` | Resolved source file, line number, and function name from hex pointer. |
| `demangled_name_label` | Monospace tooltip | `motor::bms::calculate_soc()` | Full demangled C++ or Rust symbol string. |
| `crash_backtrace_card` | Framed crimson card | Stack frame list with resolved line numbers | Formatted call stack displayed during firmware `HardFault` or panic. |
| `elf_sync_status` | Status pill | `ELF Synced (obc.elf)` / `Symbols Outdated` | Indicates whether in-memory debug symbols match binary on disk. |

---

### 3.5 Real-Time Telemetry Oscilloscope & Waveform Outputs
| Output Element | Display Format | Dynamic Range / Values | Description |
| :--- | :--- | :--- | :--- |
| `analog_signal_trace` | Multi-line vector plot | Continuous lines with anti-aliasing (60 FPS) | Real-time voltage, current, temperature, or sensor plots. |
| `digital_logic_rail` | High/Low square wave rails | 0 (Low) / 1 (High) per bit channel | Logic analyzer representation of boolean flags and interrupt lines. |
| `time_graticule_axis` | Dashed time grid | Sub-millisecond tick labels ($10\ \mu\text{s}$, $1\text{ ms}$, $10\text{ ms}$) | Synchronized horizontal time baseline. |
| `measurement_cursor_1` | Vertical dashed cyan line | Positioned at timestamp $T_1$ | Primary measurement crosshair cursor. |
| `measurement_cursor_2` | Vertical dashed amber line| Positioned at timestamp $T_2$ | Secondary measurement crosshair cursor. |
| `cursor_delta_readout` | Floating HUD panel | $\Delta t = T_2 - T_1$, Frequency $= 1/\Delta t$, $\Delta V$ | Instant time and amplitude measurement between cursors. |
| `live_signal_statistics`| Numerical tabular panel | `Min`, `Max`, `Mean`, `Pk-Pk`, `RMS`, `StdDev` | Mathematical summary of visible telemetry samples. |
| `fft_spectrum_waterfall`| Heatmap / frequency plot | Frequency bins ($0\text{ Hz}$ to Nyquist frequency) | Spectral analysis for vibration, noise, and ripple analysis. |

---

### 3.6 Session Telemetry, Buffer & Throughput Outputs
| Output Element | Display Format | Example Values | Description |
| :--- | :--- | :--- | :--- |
| `rx_bytes_counter` | Tabular numeric readout | `14.2 MB` / `14,891,200 B` | Total bytes ingested during active session. |
| `tx_bytes_counter` | Tabular numeric readout | `412 KB` / `421,888 B` | Total bytes transmitted to target hardware. |
| `packet_rate_indicator` | Real-time counter | `840 pkt/s` | Current packet frequency. |
| `bandwidth_throughput` | Real-time bandwidth gauge| `1.18 MB/s` / `9.44 Mbps` | Continuous data ingestion rate. |
| `buffer_overrun_counter`| Warning counter (Red) | `0 Overruns` (Nominal) / `3 Overruns` (Drop) | Indicates if host computer thread fell behind incoming hardware stream. |
| `uart_framing_error_cnt`| Warning counter (Amber)| `0 Errors` / `12 Errors` | Hardware framing/baud mismatch errors reported by USB-UART controller. |
| `vault_file_size_readout`| Disk usage indicator | `1.42 GB` / `84.1 MB` | Cumulative file size written to append-only disk storage. |

---

### 3.7 Semantic Diff & Timing Regression Outputs
| Output Element | Display Format | Example Content | Description |
| :--- | :--- | :--- | :--- |
| `diff_split_view` | Dual-column stream viewport| Baseline Golden Run vs Test Run | Parallel visual comparison of two recorded sessions. |
| `divergent_field_marker`| Yellow/Red highlight box | `v_batt: 8.19 V vs 7.42 V (-9.4%)` | Highlights values that differ between sessions. |
| `timing_jitter_alert` | Warning badge with $\Delta t$| `Δt drift: +4.2ms (Baseline: 10.0ms)` | Flags execution sequences that violate timing baselines. |
| `missing_packet_notice` | Red placeholder row | `MISSING FRAME #0042 (EpsHeartbeat)` | Indicates that expected packet was dropped in test run. |

---

## 4. Interaction Choreography & Signature Workflows

A great visual designer needs to understand the signature micro-interactions that make BaudForge feel responsive and intuitive.

### Workflow 1: The Dissector-to-Hex Cross-Highlight
* **Trigger:** User hovers or clicks on a field node in the **Dissected Packet Tree** (e.g. `gyro_z = -0.042`).
* **Visual Response:**
  1. The 4 bytes belonging to that field illuminate with an electric cyan border and background in the **Canonical Hex Dump**.
  2. The byte offset callout (`Offset: 0x0C..0x0F (4 bytes)`) displays near the cursor.
  3. Right-clicking the field shows an action menu item: `📈 Add gyro_z to Telemetry Oscilloscope`.

### Workflow 2: The Scope-to-Frame DVR Synchronization
* **Trigger:** User clicks on an anomaly spike on the **Telemetry Oscilloscope** waveform.
* **Visual Response:**
  1. The measurement cursor snaps to that exact point in time.
  2. The **Stream Viewport** and **Raw Hex Viewport** instantly scroll to the exact frame captured at that microsecond timestamp.
  3. The frame row pulses with an amber glow to indicate focus.

### Workflow 3: The Flash-Yield Transition
* **Trigger:** User presses `Ctrl+Shift+Y` or clicks `⚡ Yield for Flash`.
* **Visual Response:**
  1. The port status changes from `CONNECTED` to `YIELDED (30s)`.
  2. An amber striped countdown banner appears above the terminal.
  3. The serial port file handle is safely surrendered so `esptool.py` or an IDE can flash target firmware.
  4. When the external tool completes, the banner turns green, and BaudForge automatically reclaims the port in $< 10\text{ ms}$.

### Workflow 4: The HIL Fault-Injection Drilldown
* **Trigger:** User flips the `Fault Profile` master switch to `ARMED`.
* **Visual Response:**
  1. The UI topbar gains a glowing red/amber accent border indicating active fault injection.
  2. Injected frames appear in the stream with a distinct `FAULT` badge.
  3. The packet tree displays the exact mutated bit or corrupted CRC byte in high-contrast red, with the original baseline value shown as strikethrough text (e.g. `CRC: ~0x9F2A~ 0x0000`).

---

## 5. Visual Hierarchy & Spatial Layout Guidelines

For visual designers building Figma components and screen layouts:

```text
+-------------------------------------------------------------------------------------------------------------+
| BAUDFORGE v0.8.0  [Workspace: CubeSat_OBC]  [Ports: COM8 ● 115.2k]  [Vault: REC ● 1.4 MB]   [⌘K Command Pod]|
+-------------------------------------------------------------------------------------------------------------+
| [ZONE 1: HARDWARE & CONNECTION BAY] | [ZONE 2: INTERLEAVED STREAM & TERMINAL] | [ZONE 3: PACKET DISSECTOR]  |
| • Port Selector & ⟳ Refresh         | • Sequence Counter & Relative Δt (μs)   | • Collapsible Packet Tree   |
| • Baud Chips + Custom Input         | • Direction Badges (RX, TX, MITM)       | • Field Name, Value & Unit  |
| • UART 8N1 Framing Dropdowns        | • Canonical 16-Byte Hex Dump            | • CRC Verification Chip     |
| • DTR / RTS Line Controls           | • ASCII Representation Gutter           | • Live ELF Symbol Badges    |
| • Connect / Disconnect Button       | • ANSI Colored Terminal Text            |                             |
| • Auto-Detect Baud Button           | • Stream Search & Filter Toolbar        |                             |
+-------------------------------------+-----------------------------------------+-----------------------------+
| [ZONE 4: 60-FPS TELEMETRY OSCILLOSCOPE & LOGIC RAILS]                                                       |
| • Multi-Channel Continuous Waveforms (Voltage, Current, Sensor Readings)                                   |
| • Digital Logic State Rails (Bits / Flags / Interrupt States)                                               |
| • Synchronized Dashed Time Graticule with Measurement Cursors (T1, T2, Δt)                                  |
+-------------------------------------------------------------------------------------------------------------+
| [ZONE 5: TRANSPORT DVR & COMMAND FORGE]                                                                     |
| • Scrubber: [◀◀] [⏸] [▶] [1x/2x/4x]  [Timeline: ==================|=================]  [● Live Snap]        |
| • Forge:    [Destination Port v] [Hex/ASCII/Struct v] [Payload Input...] [Auto-CRC v] [🚀 SEND (Enter)]    |
+-------------------------------------------------------------------------------------------------------------+
| STATUS: RUNNING | INGEST: 1.18 MB/s | PACKETS: 840 pkt/s | OVERRUNS: 0 | VAULT: ./vaults/session_01.bflog   |
+-------------------------------------------------------------------------------------------------------------+
```

---

## 6. Easy Onboarding & Zero-State UX for Each Workspace

Hardware tools often fail user onboarding by displaying empty, unconfigured black voids. BaudForge requires **active zero-state guidance** for every workspace preset. When a workspace opens without active hardware or files, it must provide instant one-click starter actions.

### 6.1 Onboarding Design Principles
1. **Never Show an Empty Void:** If no data exists, present interactive cards with sample data generators.
2. **One-Click Hardwareless Demonstration:** Every workspace must provide a sample action that works without physical hardware plugged into the workstation.
3. **Visual Dataflow Diagrams:** Show simple block diagrams so the engineer understands data direction at a glance.
4. **Contextual Action Chips:** Show dynamic action chips when upstream data becomes available (e.g. suggesting traces when struct fields exist).

---

### 6.2 Workspace 1: Hardware Setup & Welcome Onboarding
* **Scenario:** The user opens BaudForge for the first time or connects a new microcontroller board.
* **Left Column Onboarding (Physical Hardware Target):**
  * Display detected USB device details in a monospace badge: `303A:1001 (Espressif ESP32-C3)`.
  * Display the `🔍 Auto-Detect Baud & Framing` button as an assistive action.
  * Default `DTR (High)` to checked to protect the microcontroller from continuous bootloader resets.
  * Provide inline diagnostic status cards (Amber border on probe failure, Emerald border on lock).
* **Right Column Onboarding (Simulation & Session Vault):**
  * **Interactive Demo Card:** `⚡ Launch IMU Loopback Demo (Simulated HIL)` with visual dataflow:
    `[Mock IMU] ──▶ [FIFO Loopback] ──▶ [Dissector]`.
  * **Recent Session Vault List:** Quick-access list of recent `.bflog` files with file sizes and one-click `Load & Replay` buttons.
  * **Direct Vault Folder Access:** `📂 Open Vault Directory` button to open the operating system file manager.

---

### 6.3 Workspace 2: Protocol Dissector Lab Onboarding
* **Scenario:** The user receives raw byte packets but has not yet attached a protocol schema.
* **Zero-State Card (Schema Selector):**
  * **Option A (Bundled Sample):** `📄 Load Sample C Header (telemetry_packets.h)`.
    * Instantly unpacks sample binary packets into `ImuPacket` with acceleration, gyro, and temperature.
  * **Option B (Aerospace Pack):** `🛰 Load Standard Aerospace Pack` (Select CCSDS, CSP, or MAVLink).
  * **Option C (Custom Header):** `📂 Browse C Header (.h) or Protobuf (.proto)`.
* **Visual Structural Guide:**
  * Render an illustrated packet layout showing how struct definitions map to byte offsets:
    `[uint16_t sync (2B)] [uint8_t id (1B)] [float32 val (4B)] [uint16_t crc (2B)]`.
* **Contextual Hint Banner:**
  * "Click any frame row in the stream to inspect fields. Click any field in the tree to highlight its raw bytes in the hex viewer."

---

### 6.4 Workspace 3: Telemetry Oscilloscope Onboarding
* **Scenario:** The user opens the oscilloscope, but no signal traces are added yet.
* **Zero-State Card (Signal Discovery & Test Generator):**
  * **Automatic Trace Suggestions:** If a dissector is active, show one-click suggestion chips:
    `Suggested Traces: [+ Add v_batt]  [+ Add gyro_z]  [+ Add current_ma]`.
  * **Synthetic Waveform Generator:** `⚡ Add Synthetic Test Traces (Sine, Triangle, Square)` so the user can verify plot controls, zoom levels, and cursors without physical inputs.
* **Interactive Tooling Guide:**
  * Display a compact card explaining measurement cursors:
    * `Cursor T1 (Cyan)` and `Cursor T2 (Amber)`: Drag across the canvas to measure $\Delta t$ and frequency ($1/\Delta t$).
    * `Hardware Trigger`: Configure rising edge (`↗`) or falling edge (`↘`) on any digital bit.

---

### 6.5 Workspace 4: HIL Fault Injection Rig Onboarding
* **Scenario:** The engineer wants to validate fault tolerance without writing complex test scripts.
* **Safety Interlock Banner:**
  * Prominent dual-state banner: `DISARMED (CLEAN BYPASS)` (Muted Grey) vs `ARMED (INJECTING FAULTS)` (High-Contrast Red Accent).
* **One-Click Pre-Packaged Fault Scenarios:**
  * **Card 1: Radiation Single-Event Upset (SEU):** Injects random single-bit flips at $10^{-5}$ probability.
  * **Card 2: Lossy RF Link / Channel Noise:** Drops 1 in every 10 packets.
  * **Card 3: Checksum Rejection Test:** Inverts CRC-16 checksum bytes to verify target discard logic.
  * **Card 4: Bus Congestion & Jitter:** Injects $50\text{ ms}$ synthetic latency jitter into bridged packets.
* **Visual Topology Block Diagram:**
  * Illustrates the physical or virtual bridge flow:
    `[Port A: OBC] ──▶ [BaudForge Interceptor] ──(Injected Faults)──▶ [Port B: Radio]`.

---

### 6.6 Workspace 5: Session Diff & Vault Analysis Onboarding
* **Scenario:** The user wants to compare two test runs to isolate firmware timing regressions.
* **Dual Drop-Zone Zero-State:**
  * **Left Card:** `📁 Drop Golden Baseline (.bflog) here or [Browse]`.
  * **Right Card:** `📁 Drop Test Run (.bflog) here or [Browse]`.
* **One-Click Sample Comparison:**
  * `⚡ Load Sample Pass/Fail Pair (nominal_run.bflog vs fault_run.bflog)`.
  * Instantly loads a side-by-side view highlighting timing regressions and corrupted fields.
* **Regression Metric Callouts:**
  * Shows four key indicators ready to populate: `Matched Frames`, `Timing Regressions (>5% Δt)`, `Corrupted Values`, and `Missing Frames`.

---

### 6.7 New Workspace Wizard & Quick-Start Templates
When the user clicks `+ New Workspace`, display a modal dialog with five domain-specific templates:
1. **Microcontroller Firmware Debugger:** Preconfigures UART serial (`115200 8N1`), bootloader pulse buttons, and line-delimited terminal.
2. **Aerospace & Drone Rig:** Preconfigures MAVLink / CCSDS protocol dissectors, APID filters, and telemetry charts.
3. **Industrial Bus Sniffer:** Preconfigures Modbus RTU / RS-485 with idle-gap framing ($3.5$ char times) and hex inspector.
4. **HIL Fault & Stress Rig:** Preconfigures dual-port active bridge, master fault safety switch, and packet drop counters.
5. **Pure Simulation Lab:** Preconfigures virtual mock IMU stream for software-only development.

---

## 7. Verification & Implementation Reference

* **Engine Communication Layer:** All inputs and outputs map to JSON structs defined in [`crates/bforge-core/src/contract.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-core/src/contract.rs) and the HTTP/WebSocket streaming endpoint in `crates/bforge-core/src/serve.rs`.
* **Zero Overhead Constraint:** Telemetry waveforms and terminal grids must be designed to accommodate continuous ingestion at 12 Mbaud without layout shifts.
