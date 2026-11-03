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

## 5. Easy Onboarding Specifications for Every Tool

This section defines the functional onboarding experience for every tool in BaudForge.
Designers must provide helpful empty states, one-click quick-start actions, contextual guidance, and recovery cues.
Do not require physical hardware for a user to explore any tool.

---

### 5.1 Tool 1: Hardware Connection & Target Onboarding
* **Purpose:** Discover physical serial devices, select communication parameters, and establish the data connection.
* **Empty / Disconnected State:**
  * Displays status: `No Target Connected`.
  * Informs the user that no active link exists.
  * Shows auto-detected devices found on the system (e.g. `COM8 - Espressif ESP32-C3`).
* **One-Click Quick-Start (Hardware-less):**
  * Provides a button: `⚡ Launch Simulated Loopback Target`.
  * Starts an internal mock device generating a continuous IMU sensor stream.
  * Lets the user test BaudForge immediately without plugging in a microcontroller.
* **Contextual Helper Hints:**
  * Suggests standard baud rates (`115200` for common microcontrollers, `9600` for GPS/sensors).
  * Explains line control states (`DTR High` keeps target processors out of bootloader reset).
* **Validation & Recovery Actions:**
  * When opening a port fails (e.g. port busy): Displays the exact operating system error.
  * Offers an action button: `Release Port via Flash-Yield` or `Rescan Ports`.
  * When no bytes arrive after connection: Shows an assistive button: `🔍 Auto-Detect Baud & Framing`.

---

### 5.2 Tool 2: Serial Monitor & Hex Inspector
* **Purpose:** Inspect incoming and outgoing bytes in raw hex, ASCII characters, and formatted terminal text.
* **Empty State:**
  * Displays status: `Awaiting Stream Traffic`.
  * Explains that incoming bytes will display as interleaved frames with microsecond timestamps.
* **One-Click Quick-Start:**
  * Provides an action: `Load Sample Capture Stream`.
  * Injects 20 realistic telemetry packets into the view.
  * Demonstrates hex byte highlighting, ANSI colors, and microsecond deltas ($\Delta t$).
* **Contextual Helper Hints:**
  * Explains direction tags (`RX` for received bytes, `TX` for transmitted bytes).
  * Shows keyboard shortcut hints (e.g. `/` to search, `Space` to pause autoscroll).
* **Validation & Recovery Actions:**
  * When invalid non-UTF8 characters arrive in terminal mode: Does not crash or show broken glyphs.
  * Displays an inline cue: `Non-printable binary bytes detected. Switch to Hex View.` with a direct toggle action.

---

### 5.3 Tool 3: Protocol Dissector Lab
* **Purpose:** Break down binary byte arrays into structured C structs, Protobuf messages, or standard aerospace packets.
* **Empty State:**
  * Displays status: `No Protocol Schema Selected`.
  * Explains that binary packets require a schema definition to decode fields.
* **One-Click Quick-Start:**
  * Provides an action: `Load Example C-Struct (ImuPacket.h)`.
  * Loads a bundled aerospace IMU C header and maps it against sample incoming frames.
  * Unpacks acceleration, gyroscope, temperature, and CRC fields instantly.
* **Contextual Helper Hints:**
  * Informs the user that packed structs (`__attribute__((packed))`) prevent alignment padding issues.
  * Displays a preview of struct members upon file selection.
* **Validation & Recovery Actions:**
  * When a C header contains a syntax error: Highlights the invalid line and file path.
  * When packet length does not match struct size: Displays a warning chip: `Frame size (20B) does not match struct size (24B)`.
  * Suggests: `Verify framing delimiter or struct definition`.

---

### 5.4 Tool 4: Telemetry Oscilloscope & Waveform Viewer
* **Purpose:** Plot live numeric fields as continuous waveforms, inspect digital flags, and measure intervals with cursors.
* **Empty State:**
  * Displays status: `No Telemetry Signals Bound`.
  * Explains that users can plot any numeric field from the dissector or raw data stream.
* **One-Click Quick-Start:**
  * Provides an action: `Plot Demo Channels (Voltage, Gyro_Z, Status Flags)`.
  * Instantly binds 3 simulated signals to the oscilloscope.
  * Demonstrates real-time scrolling waveforms, digital logic rails, and cursor measurements.
* **Contextual Helper Hints:**
  * Shows an inline guide: `Right-click any field in the Dissector Tree to add it to the Oscilloscope`.
  * Explains cursor measurement readouts ($\Delta t$ delta time and $1/\Delta t$ frequency).
* **Validation & Recovery Actions:**
  * When a signal value remains constant (flat line): Displays a subtle informational cue: `Signal static (no change in value)`.
  * Provides an `Auto-Fit Y-Axis` action button to adjust scale to current signal amplitudes.

---

### 5.5 Tool 5: Command Forge & Paced Transmitter
* **Purpose:** Assemble, validate, and transmit binary payloads or text commands to target hardware.
* **Empty State:**
  * Displays status: `Command Builder Ready`.
  * Explains that users can enter hex bytes, ASCII strings, or fill structured struct fields.
* **One-Click Quick-Start:**
  * Provides an action: `Insert Example Ping Command`.
  * Populates a valid test command with automatic CRC calculation enabled.
* **Contextual Helper Hints:**
  * Validates hex string format live (flags odd numbers of characters or invalid hex characters).
  * Shows automatic checksum preview: `Computed CRC: 0x9F2A (appended automatically on send)`.
* **Validation & Recovery Actions:**
  * When transmission target is disconnected: Disables send button and displays: `Connect a port before transmitting`.
  * When transmit buffer overruns: Displays pace warning: `Target busy. Increase repeat period.`

---

### 5.6 Tool 6: Hardware-in-the-Loop (HIL) Fault Injection Rig
* **Purpose:** Simulate physical link degradations, radiation bit-flips (SEUs), packet loss, and latency jitter.
* **Empty State:**
  * Displays status: `Fault Rig Disarmed (Clean Passthrough)`.
  * Explains that fault profiles mutate packets before transmission to test target firmware resilience.
* **One-Click Quick-Start:**
  * Provides an action: `Load Demo Fault Scenario (SEU Bit-Flip on Sensor Data)`.
  * Configures a single-bit flip fault profile with a safe demonstration probability.
  * Displays expected outcome: `Receiver firmware should reject frame via CRC mismatch`.
* **Contextual Helper Hints:**
  * Highlights master safety switch: Faults only execute when the master arm switch is active.
  * Explains BER exponents ($10^{-3}$ simulates heavy interference, $10^{-7}$ simulates rare cosmic ray flips).
* **Validation & Recovery Actions:**
  * While armed: Displays prominent high-visibility indicator so the user does not forget active faulting.
  * Provides an instant `Disarm All Faults` panic button.

---

### 5.7 Tool 7: Man-in-the-Middle (MITM) Active Bridge & Passive Tap
* **Purpose:** Join two physical serial ports to inspect, record, or modify communication passing between two devices.
* **Empty State:**
  * Displays status: `Bridge Topology Not Configured`.
  * Explains the difference between Passive Tap (monitor only) and Active Inline Bridge (inspect and mutate).
* **One-Click Quick-Start:**
  * Provides an action: `Simulate OBC <-> Sensor Node Bridge`.
  * Configures virtual Port A and virtual Port B with simulated bidirectional communication.
  * Shows interleaved packets passing between both endpoints.
* **Contextual Helper Hints:**
  * Recommends matching baud rates and framing modes on both sides of the bridge.
  * Indicates forwarding throughput and dropped byte counters.
* **Validation & Recovery Actions:**
  * When one bridge port disconnects: Displays warning: `Port B disconnected. Forwarding suspended.`
  * Automatically pauses bridge routing to avoid buffer overflow until the port reconnects.

---

### 5.8 Tool 8: DVR Time-Scrubber & Playback Engine
* **Purpose:** Pause live streams, navigate backward in time, step frame-by-frame, and replay historical captures.
* **Empty State:**
  * Displays status: `Live Mode (Streaming Real-Time)`.
  * Informs the user that the stream currently displays live real-time packets.
* **One-Click Quick-Start:**
  * Available whenever data exists in session buffer.
  * Provides a direct hint: `Press Spacebar or drag the timeline to pause and scrub`.
* **Contextual Helper Hints:**
  * Explains transport controls (`1x` original hardware speed, `0.5x` slow motion, `● Live` return to real-time).
  * Shows keyboard shortcut cheatsheet (`Space` to pause, `◀`/`▶` arrows to step frames).
* **Validation & Recovery Actions:**
  * While paused in historical time: Displays a persistent reminder: `PAUSED AT T - 00:12.420s (Click Live Snap to return)`.
  * Prevents user confusion about why new packets do not appear at the bottom.

---

### 5.9 Tool 9: Session Vault & Multi-Format Exporter
* **Purpose:** Record complete raw communication sessions to disk (`.bflog`) and export to external analysis tools.
* **Empty State:**
  * Displays status: `Session Recording Standby`.
  * Shows recently recorded vault sessions with timestamps and file sizes.
* **One-Click Quick-Start:**
  * Provides an action: `Open Sample Vault File (orbit_telemetry.bflog)`.
  * Loads a pre-recorded test vault with 10,000 frames for immediate offline analysis.
* **Contextual Helper Hints:**
  * Recommends export formats based on destination tool:
    * `Wireshark`: Export as `.pcapng`.
    * `Spreadsheets / Python`: Export as `.csv` or `.jsonl`.
    * `Saleae Logic`: Export as `.saleae.csv`.
* **Validation & Recovery Actions:**
  * If a vault file is damaged or truncated (e.g. unexpected power loss):
    * Detects damaged tail record.
    * Displays recovery action: `Repair Vault (Recover valid records up to failure point)`.

---

### 5.10 Tool 10: Firmware Symbol Resolver & Crash Inspector
* **Purpose:** Resolve hex memory addresses to function names and source code lines using compiled `.elf` firmware files.
* **Empty State:**
  * Displays status: `No Firmware ELF Binary Attached`.
  * Explains that loading a `.elf` binary enables automatic translation of crash addresses to source lines.
* **One-Click Quick-Start:**
  * Provides an action: `Load Demo Firmware Symbols (esp32c3_firmware.elf)`.
  * Loads sample DWARF symbol tables.
  * Demonstrates an address pointer (`0x40081234`) resolving to `[main.c:42 (sensor_read)]`.
* **Contextual Helper Hints:**
  * Explains that symbol lookup uses local DWARF data without modifying firmware execution.
  * Informs the user that clicking a symbol badge can open their local code editor (`VS Code`, `CLion`).
* **Validation & Recovery Actions:**
  * When selected `.elf` file contains no DWARF debug info: Displays warning: `Binary stripped of debug symbols. Compile with -g flag.`
  * When address is outside binary memory map: Displays hex address without failing.

---

### 5.11 Tool 11: Semantic Session Diff Engine
* **Purpose:** Compare two recorded session runs to identify protocol regressions, field value differences, and timing jitter.
* **Empty State:**
  * Displays status: `No Diff Sessions Selected`.
  * Explains that the diff engine compares a baseline golden run against a new test run.
* **One-Click Quick-Start:**
  * Provides an action: `Run Example Diff (Golden Baseline vs Injected Fault Run)`.
  * Loads two bundled sample vaults and performs automated semantic comparison.
  * Shows highlighted field differences and timing jitter flags.
* **Contextual Helper Hints:**
  * Informs the user that dynamic fields (e.g. sequence counters or timestamps) can be masked out during diff.
* **Validation & Recovery Actions:**
  * When comparing sessions with incompatible protocol schemas:
    * Displays message: `Schemas differ between sessions. Align struct definitions before diffing.`

---

### 5.12 Tool 12: Flash-Aware Port Yielder
* **Purpose:** Temporarily surrender serial port access to external flashing tools without closing BaudForge.
* **Empty State:**
  * Displays status: `Port Yield Idle`.
  * Explains that yielding releases the serial COM port so tools like `esptool` or `arduino-cli` can upload new firmware.
* **One-Click Quick-Start:**
  * Provides a test button: `Simulate 10s Flash-Yield Cycle`.
  * Simulates release, countdown, and sub-10ms automatic port reclamation.
* **Contextual Helper Hints:**
  * Displays the global keyboard shortcut: `Ctrl+Shift+Y`.
  * Explains that session recording automatically pauses during yield and resumes once the port reconnects.
* **Validation & Recovery Actions:**
  * When external flashing tool finishes early: User can click `Reclaim Port Immediately` to resume capture without waiting for timeout.
  * When target does not re-enumerate after flashing: Enters reconnecting state with guidance: `Waiting for target USB enumeration`.

---

## 6. Verification & Implementation Reference

* **Engine Communication Layer:** All inputs and outputs map to JSON structs defined in [`crates/bforge-core/src/contract.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-core/src/contract.rs) and the HTTP/WebSocket streaming endpoint in `crates/bforge-core/src/serve.rs`.
* **Zero Overhead Constraint:** Telemetry waveforms and terminal grids must accommodate continuous ingestion at 12 Mbaud without layout shifts.
