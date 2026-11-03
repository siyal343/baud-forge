import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from 'solid-js'

export interface HelpModalProps {
  open: boolean
  onClose: () => void
  initialTab?: HelpTabId
  onSelectPreset?: (presetName: string) => void
}

export type HelpTabId = 'workbenches' | 'shortcuts' | 'protocols' | 'dashboards'

interface WorkbenchItem {
  id: string
  title: string
  icon: string
  shortcut: string
  presetName: string
  panels: string[]
  whenToUse: string
  capabilities: string[]
}

const WORKBENCHES: WorkbenchItem[] = [
  {
    id: 'bringup',
    title: 'Bring-up',
    icon: '🔌',
    shortcut: 'Ctrl+1',
    presetName: 'Bring-up',
    panels: ['Hardware Bay', 'Stream', 'Console'],
    whenToUse: 'Use for initial board bring-up, baud rate discovery, and serial UART connection verification.',
    capabilities: [
      'Multi-port USB-to-UART serial transceiver enumeration',
      'Continuous auto-baud rate scanner (1200 to 4,000,000 baud)',
      'Hardware flow control line sequencing (DTR/RTS pulse scripting)',
      '30-second port lease yielding for external flash utilities (esptool)',
    ],
  },
  {
    id: 'debug',
    title: 'Protocol Debug',
    icon: '🔬',
    shortcut: 'Ctrl+2',
    presetName: 'Protocol Debug',
    panels: ['Stream', 'Hex Inspector', 'Dissector Fields', 'Console'],
    whenToUse: 'Use for packet framing diagnostics, checksum validation, and byte-level payload dissection.',
    capabilities: [
      'Synchronized hex dump and printable ASCII inspector',
      'Structural packet decoders compiled from C header files or MAVLink XML',
      'Zero-copy frame boundary detection (COBS, SLIP, length-prefix)',
      'DWARF ELF symbol table lookup for mapped memory buffers',
    ],
  },
  {
    id: 'telemetry',
    title: 'Telemetry & Oscilloscope',
    icon: '📊',
    shortcut: 'Ctrl+3',
    presetName: 'Telemetry & Oscilloscope',
    panels: ['Stream', 'Live Waveform Plot', 'Hardware Bay'],
    whenToUse: 'Use for high-frequency numeric variable plotting, sensor calibration, and analog signal dynamics.',
    capabilities: [
      'Hardware-accelerated WebGL2 multi-channel strip chart plotter',
      'Instantaneous FFT frequency spectrum analysis and sample statistics',
      'Variable-persistence phosphor decay display simulation',
      'Synchronous DVR timeline playback and time-correlated scrubbing',
    ],
  },
  {
    id: 'dashboards',
    title: 'Dashboards',
    icon: '🎛️',
    shortcut: 'Ctrl+4',
    presetName: 'Dashboards',
    panels: ['Declarative XML Dashboard', 'Telemetry', 'Hardware Bay'],
    whenToUse: 'Use to build and operate custom visual test instruments and command-and-control surfaces.',
    capabilities: [
      'Declarative XML user interface layouts (grids, stacks, and cards)',
      'Configurable analog dials, digital displays, and status LEDs',
      'Pratt expression engine for live mathematical transformations',
      'Direct hardware interaction via sliders, toggle switches, and buttons',
    ],
  },
  {
    id: 'hil',
    title: 'HIL & Fault Rig',
    icon: '⚡',
    shortcut: 'Ctrl+5',
    presetName: 'HIL & Fault Rig',
    panels: ['Hardware Bay', 'Fault Controls', 'Stream', 'Console'],
    whenToUse: 'Use for hardware-in-the-loop stress testing, error recovery verification, and physical bus abuse.',
    capabilities: [
      'Real-time pseudo-random bit corruption and CRC manipulation',
      'Controlled byte deletion, frame truncation, and packet drop injection',
      'Microsecond-scale inter-character transmission latency and jitter',
      'One-click instant disarm for safe fail-stop recovery',
    ],
  },
  {
    id: 'diff',
    title: 'Session Diff',
    icon: '⚖️',
    shortcut: 'Ctrl+6',
    presetName: 'Session Diff',
    panels: ['Session Diff View', 'Stream', 'Hex Inspector'],
    whenToUse: 'Use for firmware regression testing and comparative diffs against golden reference captures.',
    capabilities: [
      'Side-by-side session packet comparison and temporal alignment',
      'Automated first-divergence detection across recording streams',
      'Field-level value difference highlighting and delta calculations',
      'Parity tracking for missing, extra, or malformed packets',
    ],
  },
]

interface ShortcutRow {
  combo: string
  action: string
  category: string
  note?: string
}

const SHORTCUTS: ShortcutRow[] = [
  { combo: 'Ctrl+K', action: 'Open Command Palette', category: 'Navigation', note: '0ms fuzzy action switcher' },
  { combo: 'Ctrl+S', action: 'Save Workspace', category: 'General', note: 'Export config as .bforge.toml' },
  { combo: 'Ctrl+N', action: 'New Workspace Wizard', category: 'General', note: 'Reset or configure fresh session' },
  { combo: 'Ctrl+,', action: 'Appearance & Settings', category: 'General', note: 'Configure theme, fonts, columns' },
  { combo: 'Ctrl+H / F1', action: 'Help & Reference', category: 'General', note: 'Toggle this guide dialog' },
  { combo: 'Space', action: 'Pause / Resume Stream', category: 'DVR & Stream', note: 'Toggle live feed playback' },
  { combo: 'End', action: 'Snap to Live Edge', category: 'DVR & Stream', note: 'Jump to latest received frame' },
  { combo: 'L', action: 'Jump to Live Head', category: 'Stream', note: 'Fast-forward stream display' },
  { combo: 'F', action: 'Toggle Auto-Follow', category: 'Stream', note: 'Lock scroll to newest packets' },
  { combo: '/', action: 'Focus Search Filter', category: 'Stream', note: 'Filter packet stream text' },
  { combo: 'Ctrl+1', action: 'Switch to Bring-up', category: 'Workbench', note: 'Hardware Bay, Stream, Console' },
  { combo: 'Ctrl+2', action: 'Switch to Protocol Debug', category: 'Workbench', note: 'Stream, Inspector, Console' },
  { combo: 'Ctrl+3', action: 'Switch to Telemetry', category: 'Workbench', note: 'Stream, Waveform Plot, Bay' },
  { combo: 'Ctrl+4', action: 'Switch to Dashboards', category: 'Workbench', note: 'XML Dashboard, Telemetry, Bay' },
  { combo: 'Ctrl+5', action: 'Switch to HIL & Fault Rig', category: 'Workbench', note: 'Bay, Fault Rig, Stream, Console' },
  { combo: 'Ctrl+6', action: 'Switch to Session Diff', category: 'Workbench', note: 'Diff View, Stream, Inspector' },
  { combo: 'Ctrl+Shift+D', action: 'Toggle Diff Panel', category: 'Panels', note: 'Show / hide session comparator' },
  { combo: 'Esc', action: 'Close Modal / Cancel Rebind', category: 'General', note: 'Dismiss active dialog' },
]

const C_HEADER_EXAMPLE = `// Telemetry struct definition for BaudForge C Dissector
#pragma pack(push, 1)
typedef struct {
    uint16_t sync_word;       // Frame preamble: 0xAA55
    uint8_t  msg_type;        // Packet ID identifier
    uint32_t timestamp_us;    // Monotonic system tick
    int16_t  gyro_raw[3];     // X, Y, Z rate (LSB = 0.01 dps)
    float    v_bus_volts;     // Calibrated rail voltage
    float    temp_celsius;    // On-die thermistor value
    uint16_t crc16_ccitt;     // Standard polynomial 0x1021
} TelemetryFrame_t;
#pragma pack(pop)`

const MAVLINK_EXAMPLE = `<!-- MAVLink dialect definition for BaudForge Dissector -->
<mavlink>
  <messages>
    <message id="147" name="BATTERY_STATUS">
      <description>Real-time power pack metrics.</description>
      <field type="uint8_t" name="id">Battery pack index</field>
      <field type="uint16_t" name="voltage_mv">Total pack voltage in millivolts</field>
      <field type="int16_t" name="current_ma">Current draw (10 mA resolution)</field>
      <field type="int32_t" name="consumed_mah">Total integrated power consumed</field>
      <field type="int8_t" name="battery_remaining">State of charge percentage</field>
    </message>
  </messages>
</mavlink>`

const KAITAI_EXAMPLE = `# Kaitai Struct YAML format definition for BaudForge
meta:
  id: sensor_packet
  endian: le
seq:
  - id: magic
    contents: [0x55, 0xaa]
  - id: sequence_id
    type: u2
  - id: pressure_pa
    type: f4
  - id: temperature_c
    type: s2
  - id: fault_mask
    type: u1
  - id: checksum
    type: u2`

const XML_DASHBOARD_EXAMPLE = `<bforge-dashboard title="Propulsion Test Bench" refresh-ms="50">
  <grid columns="2" gap="12">
    <card title="Electrical Telemetry">
      <stack direction="vertical" gap="10">
        <gauge label="Bus Voltage" source="telemetry.v_bus_volts" min="0" max="36" unit="V"
               zone-low="10.8" zone-high="32.0" warn-color="#f59e0b" fault-color="#f43f5e" />
        <numeric-display label="Instantaneous Current" source="telemetry.current_ma / 1000.0" unit="A" precision="2" />
        <chart label="Power Profile" source="telemetry.v_bus_volts * (telemetry.current_ma / 1000.0)" height="120" color="#06b6d4" />
      </stack>
    </card>

    <card title="Actuator Control">
      <stack direction="vertical" gap="10">
        <led label="Motor Armed" source="telemetry.fault_mask == 0" on-color="#10b981" off-color="#334155" />
        <slider label="Throttle Setpoint" target="actuator.throttle" min="0" max="100" step="1" />
        <switch label="Igniter Safety Lock" target="actuator.igniter_safe" on-value="1" off-value="0" />
        <button label="Emergency Cutoff" command="actuator.abort" variant="danger" />
      </stack>
    </card>
  </grid>
</bforge-dashboard>`

export const HelpModal: Component<HelpModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<HelpTabId>(props.initialTab || 'workbenches')
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null)
  const [shortcutFilter, setShortcutFilter] = createSignal('')

  createEffect(() => {
    if (props.open && props.initialTab) {
      setActiveTab(props.initialTab)
    }
    if (props.open) {
      setCopiedKey(null)
    }
  })

  // Global Escape handler
  createEffect(() => {
    if (!props.open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  function copyText(key: string, text: string) {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur))
      }, 2000)
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      props.onClose()
    }
  }

  const filteredShortcuts = () => {
    const q = shortcutFilter().trim().toLowerCase()
    if (!q) return SHORTCUTS
    return SHORTCUTS.filter(
      (s) =>
        s.combo.toLowerCase().includes(q) ||
        s.action.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        (s.note && s.note.toLowerCase().includes(q)),
    )
  }

  return (
    <Show when={props.open}>
      <div class="help-backdrop" onClick={handleBackdropClick}>
        <div class="help-dialog" role="dialog" aria-modal="true" aria-label="BaudForge Workbench Guide & Reference">
          {/* Header */}
          <div class="help-header">
            <div class="help-header-left">
              <span class="help-icon">💡</span>
              <h2 class="help-title">BaudForge Workbench Guide &amp; Reference</h2>
            </div>
            <div class="help-header-right">
              <span class="help-esc-badge" onClick={props.onClose} title="Close Help Dialog (Esc)">
                ESC
              </span>
            </div>
          </div>

          {/* Tab Navigation Bar */}
          <div class="help-tab-bar">
            <button
              class={`help-tab-btn ${activeTab() === 'workbenches' ? 'active' : ''}`}
              onClick={() => setActiveTab('workbenches')}
            >
              🏢 Workbenches Guide
            </button>
            <button
              class={`help-tab-btn ${activeTab() === 'shortcuts' ? 'active' : ''}`}
              onClick={() => setActiveTab('shortcuts')}
            >
              ⌨️ Keyboard Shortcuts
            </button>
            <button
              class={`help-tab-btn ${activeTab() === 'protocols' ? 'active' : ''}`}
              onClick={() => setActiveTab('protocols')}
            >
              🔬 Protocol &amp; Dissection
            </button>
            <button
              class={`help-tab-btn ${activeTab() === 'dashboards' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboards')}
            >
              🎛️ XML Dashboards
            </button>
          </div>

          {/* Modal Body */}
          <div class="help-body">
            {/* Tab 1: Workbenches Guide */}
            <Show when={activeTab() === 'workbenches'}>
              <div class="help-section">
                <div class="section-lead">
                  BaudForge provides 6 mission-tailored workbench layouts. Switch quickly with{' '}
                  <kbd class="help-kbd">Ctrl+1</kbd> through <kbd class="help-kbd">Ctrl+6</kbd> or the topbar preset switcher.
                </div>

                <div class="workbench-grid">
                  <For each={WORKBENCHES}>
                    {(wb) => (
                      <div class="wb-card">
                        <div class="wb-card-header">
                          <div class="wb-card-title-group">
                            <span class="wb-icon">{wb.icon}</span>
                            <h3 class="wb-card-title">{wb.title}</h3>
                          </div>
                          <div class="wb-card-badges">
                            <span class="wb-shortcut-chip">{wb.shortcut}</span>
                            <Show when={props.onSelectPreset}>
                              <button
                                type="button"
                                class="wb-apply-btn"
                                onClick={() => {
                                  props.onSelectPreset?.(wb.presetName)
                                  props.onClose()
                                }}
                                title={`Apply ${wb.title} preset`}
                              >
                                Apply
                              </button>
                            </Show>
                          </div>
                        </div>

                        <div class="wb-panels-row">
                          <For each={wb.panels}>
                            {(p) => <span class="wb-panel-chip">{p}</span>}
                          </For>
                        </div>

                        <p class="wb-when-text">{wb.whenToUse}</p>

                        <div class="wb-features">
                          <div class="wb-features-title">Core Instrument Capabilities:</div>
                          <ul class="wb-features-list">
                            <For each={wb.capabilities}>
                              {(cap) => <li>{cap}</li>}
                            </For>
                          </ul>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Tab 2: Keyboard Shortcuts */}
            <Show when={activeTab() === 'shortcuts'}>
              <div class="help-section">
                <div class="section-header-row">
                  <div class="section-lead">
                    Fast keyboard navigation for precision instrumentation without leaving the terminal.
                  </div>
                  <input
                    type="text"
                    class="help-search-input"
                    placeholder="Filter shortcuts (e.g. preset, dvr, ctrl)..."
                    value={shortcutFilter()}
                    onInput={(e) => setShortcutFilter(e.currentTarget.value)}
                  />
                </div>

                <div class="shortcuts-table-container">
                  <table class="shortcuts-table">
                    <thead>
                      <tr>
                        <th style={{ width: '160px' }}>Key Combination</th>
                        <th style={{ width: '110px' }}>Category</th>
                        <th>Action</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={filteredShortcuts()}>
                        {(sc) => (
                          <tr>
                            <td>
                              <kbd class="help-kbd">{sc.combo}</kbd>
                            </td>
                            <td>
                              <span class="category-chip">{sc.category}</span>
                            </td>
                            <td class="action-cell">{sc.action}</td>
                            <td class="note-cell">{sc.note || '—'}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </div>
            </Show>

            {/* Tab 3: Protocol & Dissection */}
            <Show when={activeTab() === 'protocols'}>
              <div class="help-section">
                <div class="section-lead">
                  Load firmware struct layouts directly. BaudForge compiles binary dissectors into zero-copy IR with bounds-checked execution.
                </div>

                {/* C Headers */}
                <div class="format-card">
                  <div class="format-card-header">
                    <div class="format-header-title">
                      <span class="format-badge c-badge">C HEADER</span>
                      <h4>C Structs &amp; Attributes</h4>
                    </div>
                    <button
                      type="button"
                      class="copy-snippet-btn"
                      onClick={() => copyText('c_header', C_HEADER_EXAMPLE)}
                    >
                      {copiedKey() === 'c_header' ? '✓ Copied' : 'Copy Struct'}
                    </button>
                  </div>
                  <pre class="code-box">
                    <code>{C_HEADER_EXAMPLE}</code>
                  </pre>
                  <div class="format-notes">
                    <div class="format-notes-title">Supported Constructs:</div>
                    <ul>
                      <li>Packing pragmas: <code>#pragma pack(push, 1)</code> and <code>__attribute__((packed))</code></li>
                      <li>Standard integer types: <code>uint8_t</code> through <code>uint64_t</code>, <code>int8_t</code> through <code>int64_t</code>, <code>bool</code></li>
                      <li>Floating point: <code>float</code> (32-bit IEEE-754) and <code>double</code> (64-bit)</li>
                      <li>Explicit endianness aliases: <code>__le16</code>, <code>__be16</code>, <code>__le32</code>, <code>__be32</code></li>
                      <li>Fixed-size arrays and bitfield declarations within packed structs</li>
                    </ul>
                  </div>
                </div>

                {/* MAVLink XML */}
                <div class="format-card">
                  <div class="format-card-header">
                    <div class="format-header-title">
                      <span class="format-badge mavlink-badge">MAVLINK XML</span>
                      <h4>MAVLink Dialect Definitions</h4>
                    </div>
                    <button
                      type="button"
                      class="copy-snippet-btn"
                      onClick={() => copyText('mavlink', MAVLINK_EXAMPLE)}
                    >
                      {copiedKey() === 'mavlink' ? '✓ Copied' : 'Copy MAVLink'}
                    </button>
                  </div>
                  <pre class="code-box">
                    <code>{MAVLINK_EXAMPLE}</code>
                  </pre>
                  <div class="format-notes">
                    <div class="format-notes-title">Dialect Features:</div>
                    <ul>
                      <li>Message identifier mappings with automatic CRC extra computation</li>
                      <li>Dynamic byte offset calculation based on protocol specifications</li>
                      <li>Field types: <code>uint8_t</code>–<code>uint64_t</code>, <code>float</code>, <code>char[N]</code>, and array fields</li>
                    </ul>
                  </div>
                </div>

                {/* Kaitai Struct */}
                <div class="format-card">
                  <div class="format-card-header">
                    <div class="format-header-title">
                      <span class="format-badge kaitai-badge">KAITAI YAML</span>
                      <h4>Kaitai Struct Binary Formats (.ksy)</h4>
                    </div>
                    <button
                      type="button"
                      class="copy-snippet-btn"
                      onClick={() => copyText('kaitai', KAITAI_EXAMPLE)}
                    >
                      {copiedKey() === 'kaitai' ? '✓ Copied' : 'Copy Kaitai'}
                    </button>
                  </div>
                  <pre class="code-box">
                    <code>{KAITAI_EXAMPLE}</code>
                  </pre>
                  <div class="format-notes">
                    <div class="format-notes-title">Format Capabilities:</div>
                    <ul>
                      <li>Sequence parsing with magic bytes: <code>contents: [0x55, 0xAA]</code></li>
                      <li>Primitives: <code>u1</code>, <code>u2</code>, <code>u4</code>, <code>u8</code>, <code>s1</code>, <code>s2</code>, <code>s4</code>, <code>s8</code>, <code>f4</code>, <code>f8</code></li>
                      <li>Little-endian and big-endian specification per meta declaration</li>
                    </ul>
                  </div>
                </div>
              </div>
            </Show>

            {/* Tab 4: XML Dashboards */}
            <Show when={activeTab() === 'dashboards'}>
              <div class="help-section">
                <div class="section-lead">
                  Create custom telemetry instruments with declarative XML. BaudForge evaluates data expressions in real time using a Pratt parser without eval().
                </div>

                {/* Elements Reference Table */}
                <div class="dashboard-elements-container">
                  <h4 class="subheading">Supported XML Dashboard Elements</h4>
                  <table class="shortcuts-table">
                    <thead>
                      <tr>
                        <th style={{ width: '160px' }}>Element</th>
                        <th style={{ width: '220px' }}>Attributes</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><code>&lt;gauge&gt;</code></td>
                        <td><code>source, min, max, unit, label, zone-low, zone-high, warn-color, fault-color</code></td>
                        <td>Radial circular meter for voltages, temperatures, and pressures with threshold colors.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;numeric-display&gt;</code></td>
                        <td><code>source, label, unit, precision</code></td>
                        <td>Digital seven-segment style numeric display with precision rounding.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;chart&gt;</code></td>
                        <td><code>source, min, max, color, height, duration-ms</code></td>
                        <td>Continuous rolling time-series strip chart with auto-scaling.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;led&gt;</code></td>
                        <td><code>source, label, on-color, off-color, pulse</code></td>
                        <td>Discrete status indicator light for boolean conditions.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;switch&gt;</code></td>
                        <td><code>target, label, on-value, off-value</code></td>
                        <td>Bistable toggle switch for hardware GPIOs and power lines.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;slider&gt;</code></td>
                        <td><code>target, min, max, step, label</code></td>
                        <td>Analog control slider for PWM duty cycles and motor setpoints.</td>
                      </tr>
                      <tr>
                        <td><code>&lt;button&gt;</code></td>
                        <td><code>label, command, param, variant</code></td>
                        <td>Trigger button for system commands (variant: primary, danger, ghost).</td>
                      </tr>
                      <tr>
                        <td><code>&lt;grid&gt; / &lt;stack&gt;</code></td>
                        <td><code>columns, gap, direction, title</code></td>
                        <td>Responsive layout containers for arranging dashboard cards and controls.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Pratt Expression Reference */}
                <div class="pratt-expr-container">
                  <h4 class="subheading">Pratt Expression Engine Reference</h4>
                  <div class="pratt-grid">
                    <div class="pratt-card">
                      <div class="pratt-card-title">Arithmetic &amp; Bitwise Operators</div>
                      <p>
                        Supports <code>+</code>, <code>-</code>, <code>*</code>, <code>/</code>, <code>%</code> (modulo),{' '}
                        <code>&amp;</code> (bitwise AND), <code>|</code> (bitwise OR), <code>^</code> (XOR), <code>~</code> (NOT),{' '}
                        <code>&lt;&lt;</code>, <code>&gt;&gt;</code> (shifts).
                      </p>
                      <div class="pratt-example"><code>telemetry.raw_adc * (3.3 / 4095.0)</code></div>
                    </div>
                    <div class="pratt-card">
                      <div class="pratt-card-title">Relational &amp; Boolean Logic</div>
                      <p>
                        Short-circuit logical evaluation: <code>==</code>, <code>!=</code>, <code>&lt;</code>, <code>&lt;=</code>,{' '}
                        <code>&gt;</code>, <code>&gt;=</code>, <code>&amp;&amp;</code>, <code>||</code>, <code>!</code>.
                      </p>
                      <div class="pratt-example"><code>telemetry.v_batt &gt; 11.1 &amp;&amp; status.locked</code></div>
                    </div>
                    <div class="pratt-card">
                      <div class="pratt-card-title">Numeric Literals</div>
                      <p>
                        Decimal floats, integers, hexadecimal (<code>0xAA55</code>), and binary (<code>0b10110010</code>).
                      </p>
                      <div class="pratt-example"><code>(telemetry.status &amp; 0x80) != 0</code></div>
                    </div>
                    <div class="pratt-card">
                      <div class="pratt-card-title">Built-in Functions</div>
                      <p>
                        Math helpers: <code>clamp(val, min, max)</code>, <code>min(a, b)</code>, <code>max(a, b)</code>,{' '}
                        <code>abs(x)</code>, <code>round(x, n)</code>, <code>sqrt(x)</code>, <code>floor(x)</code>, <code>ceil(x)</code>.
                      </p>
                      <div class="pratt-example"><code>clamp(round(telemetry.rpm / 100) * 100, 0, 8000)</code></div>
                    </div>
                  </div>
                </div>

                {/* Complete XML Example */}
                <div class="format-card" style={{ 'margin-top': '16px' }}>
                  <div class="format-card-header">
                    <div class="format-header-title">
                      <span class="format-badge xml-badge">XML DASHBOARD</span>
                      <h4>Complete Dashboard Template</h4>
                    </div>
                    <button
                      type="button"
                      class="copy-snippet-btn"
                      onClick={() => copyText('xml_dash', XML_DASHBOARD_EXAMPLE)}
                    >
                      {copiedKey() === 'xml_dash' ? '✓ Copied' : 'Copy Dashboard XML'}
                    </button>
                  </div>
                  <pre class="code-box">
                    <code>{XML_DASHBOARD_EXAMPLE}</code>
                  </pre>
                </div>
              </div>
            </Show>
          </div>
        </div>

        {/* Scoped Modal Styles */}
        <style>{`
          .help-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(4px);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            font-family: var(--font-sans);
          }
          .help-dialog {
            width: 100%;
            max-width: 860px;
            max-height: 88vh;
            background: var(--bg-surface-1, #101217);
            border: 1px solid var(--border-strong, #2d3446);
            border-radius: 8px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px var(--border-highlight, rgba(255, 255, 255, 0.06));
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: helpFadeIn 120ms cubic-bezier(0.23, 1, 0.32, 1);
          }
          @keyframes helpFadeIn {
            from { opacity: 0; transform: scale(0.985) translateY(6px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          .help-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 18px;
            background: var(--bg-surface-2, #161920);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .help-header-left {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .help-icon {
            font-size: 16px;
          }
          .help-title {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
            letter-spacing: -0.01em;
            color: var(--text-primary, #edf0f7);
          }
          .help-header-right {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .help-esc-badge {
            font-family: var(--font-mono);
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-hairline, #1f2430);
            color: var(--text-muted, #7c879c);
            cursor: pointer;
            user-select: none;
          }
          .help-esc-badge:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
          }
          .help-tab-bar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 14px;
            background: var(--bg-surface-2, #161920);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .help-tab-btn {
            background: transparent;
            border: 0;
            border-bottom: 2px solid transparent;
            padding: 9px 13px;
            color: var(--text-secondary, #949eb2);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 120ms ease;
            white-space: nowrap;
          }
          .help-tab-btn:hover {
            color: var(--text-primary, #edf0f7);
          }
          .help-tab-btn.active {
            color: var(--sig-tx, #06b6d4);
            border-bottom-color: var(--sig-tx, #06b6d4);
            font-weight: 600;
          }
          .help-body {
            flex: 1;
            overflow-y: auto;
            padding: 18px 20px 24px;
            background: var(--bg-canvas, #090a0d);
          }
          .help-section {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .section-lead {
            font-size: 12px;
            line-height: 1.5;
            color: var(--text-secondary, #949eb2);
          }
          .section-header-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
          }
          .help-search-input {
            width: 240px;
            background: var(--bg-surface-2, #161920);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 4px;
            padding: 4px 10px;
            font-size: 11px;
            color: var(--text-primary, #edf0f7);
            outline: none;
          }
          .help-search-input:focus {
            border-color: var(--sig-tx, #06b6d4);
          }
          .help-kbd {
            display: inline-block;
            font-family: var(--font-mono);
            font-size: 11px;
            padding: 2px 6px;
            background: var(--bg-surface-2, #161920);
            border: 1px solid var(--border-strong, #2d3446);
            border-radius: 4px;
            color: var(--sig-tx, #06b6d4);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
            white-space: nowrap;
          }

          /* Workbench Cards */
          .workbench-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
          }
          @media (max-width: 680px) {
            .workbench-grid {
              grid-template-columns: 1fr;
            }
          }
          .wb-card {
            background: var(--bg-surface-2, #161920);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 6px;
            padding: 12px 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            transition: border-color 120ms ease;
          }
          .wb-card:hover {
            border-color: var(--border-strong, #2d3446);
          }
          .wb-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
          }
          .wb-card-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .wb-icon {
            font-size: 14px;
          }
          .wb-card-title {
            margin: 0;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .wb-card-badges {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .wb-shortcut-chip {
            font-family: var(--font-mono);
            font-size: 10px;
            padding: 2px 5px;
            background: var(--bg-surface-3, #1e222b);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 3px;
            color: var(--text-muted, #7c879c);
          }
          .wb-apply-btn {
            background: rgba(6, 182, 212, 0.12);
            border: 1px solid rgba(6, 182, 212, 0.3);
            color: var(--sig-tx, #06b6d4);
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            padding: 2px 7px;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .wb-apply-btn:hover {
            background: var(--sig-tx, #06b6d4);
            color: #000;
          }
          .wb-panels-row {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
          }
          .wb-panel-chip {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--text-secondary, #949eb2);
          }
          .wb-when-text {
            margin: 0;
            font-size: 11px;
            line-height: 1.45;
            color: var(--text-secondary, #949eb2);
          }
          .wb-features {
            margin-top: 2px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            padding-top: 6px;
          }
          .wb-features-title {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: var(--text-muted, #5e677a);
            margin-bottom: 4px;
          }
          .wb-features-list {
            margin: 0;
            padding-left: 14px;
            font-size: 11px;
            color: var(--text-secondary, #949eb2);
            line-height: 1.45;
          }

          /* Shortcuts Table */
          .shortcuts-table-container {
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 6px;
            overflow: hidden;
            background: var(--bg-surface-2, #161920);
          }
          .shortcuts-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
            text-align: left;
          }
          .shortcuts-table th {
            background: var(--bg-surface-3, #1e222b);
            color: var(--text-muted, #5e677a);
            font-weight: 600;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.04em;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .shortcuts-table td {
            padding: 7px 12px;
            border-bottom: 1px solid var(--border-hairline, #1f2430);
            color: var(--text-secondary, #949eb2);
          }
          .shortcuts-table tr:last-child td {
            border-bottom: 0;
          }
          .shortcuts-table tr:hover td {
            background: rgba(255, 255, 255, 0.02);
          }
          .category-chip {
            display: inline-block;
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--bg-surface-3, #1e222b);
            color: var(--text-muted, #7c879c);
          }
          .action-cell {
            color: var(--text-primary, #edf0f7);
            font-weight: 500;
          }
          .note-cell {
            font-size: 10.5px;
            color: var(--text-muted, #7c879c);
          }

          /* Format & Code Cards */
          .format-card {
            background: var(--bg-surface-2, #161920);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 6px;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .format-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .format-header-title {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .format-header-title h4 {
            margin: 0;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .format-badge {
            font-family: var(--font-mono);
            font-size: 9px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 3px;
            letter-spacing: 0.05em;
          }
          .format-badge.c-badge {
            background: rgba(16, 185, 129, 0.15);
            color: var(--sig-rx, #10b981);
            border: 1px solid rgba(16, 185, 129, 0.3);
          }
          .format-badge.mavlink-badge {
            background: rgba(6, 182, 212, 0.15);
            color: var(--sig-tx, #06b6d4);
            border: 1px solid rgba(6, 182, 212, 0.3);
          }
          .format-badge.kaitai-badge {
            background: rgba(168, 85, 247, 0.15);
            color: var(--sig-symbol, #a855f7);
            border: 1px solid rgba(168, 85, 247, 0.3);
          }
          .format-badge.xml-badge {
            background: rgba(245, 158, 11, 0.15);
            color: var(--sig-warn, #f59e0b);
            border: 1px solid rgba(245, 158, 11, 0.3);
          }
          .copy-snippet-btn {
            background: var(--bg-surface-3, #1e222b);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 4px;
            color: var(--text-secondary, #949eb2);
            font-size: 11px;
            padding: 3px 9px;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .copy-snippet-btn:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
          }
          .code-box {
            margin: 0;
            padding: 10px 12px;
            background: var(--bg-canvas, #090a0d);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 5px;
            overflow-x: auto;
            font-family: var(--font-mono);
            font-size: 11px;
            line-height: 1.5;
            color: var(--text-primary, #edf0f7);
          }
          .format-notes {
            font-size: 11px;
            color: var(--text-secondary, #949eb2);
          }
          .format-notes-title {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: var(--text-muted, #5e677a);
            margin-bottom: 4px;
          }
          .format-notes ul {
            margin: 0;
            padding-left: 16px;
            line-height: 1.45;
          }
          .format-notes code {
            font-family: var(--font-mono);
            color: var(--sig-tx, #06b6d4);
            font-size: 10.5px;
          }

          /* Dashboard Reference */
          .subheading {
            margin: 8px 0 6px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
            letter-spacing: -0.01em;
          }
          .dashboard-elements-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .dashboard-elements-container code {
            font-family: var(--font-mono);
            color: var(--sig-tx, #06b6d4);
            font-size: 11px;
          }
          .pratt-expr-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
          }
          .pratt-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
          @media (max-width: 680px) {
            .pratt-grid {
              grid-template-columns: 1fr;
            }
          }
          .pratt-card {
            background: var(--bg-surface-2, #161920);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 6px;
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .pratt-card-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .pratt-card p {
            margin: 0;
            font-size: 11px;
            color: var(--text-secondary, #949eb2);
            line-height: 1.4;
          }
          .pratt-card code {
            font-family: var(--font-mono);
            color: var(--sig-tx, #06b6d4);
            font-size: 10.5px;
          }
          .pratt-example {
            margin-top: auto;
            padding: 4px 8px;
            background: var(--bg-canvas, #090a0d);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 4px;
            font-family: var(--font-mono);
            font-size: 10.5px;
            color: var(--sig-rx, #10b981);
            overflow-x: auto;
          }
        `}</style>
      </div>
    </Show>
  )
}
