import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Component,
} from 'solid-js'
import {
  FRAMING_MODES,
  synthesizeWorkspaceToml,
  triggerFileDownload,
  type WizardPortInput,
  type WizardBridgeInput,
} from '../lib/workspace'
import { api, inShell } from '../lib/shell'

export interface NewWorkspaceModalProps {
  open: boolean
  onClose: () => void
  onLaunched?: (workspaceName: string) => void
}

export type WizardPreset = 'single-mcu' | 'hil-bridge' | 'tcp-stream' | 'custom'
export type WizardTab = 'presets' | 'form' | 'preview'

export interface WizardPortItem {
  id: string
  transport: 'serial' | 'tcp-client' | 'tcp-server' | 'udp'
  deviceOrAddress: string
  baudRate: number
  framing: string
  dissectorFile: string
  dissectorStruct: string
  showDissector: boolean
}

export interface WizardBridgeItem {
  id: string
  portA: string
  portB: string
  forward: boolean
}

export const BAUD_RATES = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000,
]

export const NewWorkspaceModal: Component<NewWorkspaceModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<WizardTab>('presets')
  const [selectedPreset, setSelectedPreset] = createSignal<WizardPreset>('single-mcu')
  const [workspaceName, setWorkspaceName] = createSignal('my-workspace')

  // Port state
  const [ports, setPorts] = createSignal<WizardPortItem[]>([
    {
      id: 'mcu',
      transport: 'serial',
      deviceOrAddress: 'COM3',
      baudRate: 115200,
      framing: 'delimiter',
      dissectorFile: '',
      dissectorStruct: '',
      showDissector: false,
    },
  ])

  // Bridges state
  const [enableBridge, setEnableBridge] = createSignal(false)
  const [bridges, setBridges] = createSignal<WizardBridgeItem[]>([
    {
      id: 'hil_bridge',
      portA: 'obc',
      portB: 'sensor',
      forward: true,
    },
  ])

  // Discovered hardware serial devices
  const [availableDevices, setAvailableDevices] = createSignal<string[]>([])
  const [scanningDevices, setScanningDevices] = createSignal(false)
  const [statusMessage, setStatusMessage] = createSignal<{ text: string; error?: boolean } | null>(null)
  const [launching, setLaunching] = createSignal(false)
  const [copiedToml, setCopiedToml] = createSignal(false)

  // Scan hardware devices when modal opens
  createEffect(() => {
    if (props.open) {
      void scanSerialDevices()
      setStatusMessage(null)
      setLaunching(false)
    }
  })

  // Keyboard shortcut listener (ESC to close)
  createEffect(() => {
    if (!props.open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  async function scanSerialDevices() {
    setScanningDevices(true)
    try {
      let detected: string[] = []
      if (inShell()) {
        const tauri = (globalThis as { __TAURI__?: { core?: { invoke<T>(cmd: string, args?: any): Promise<T> } } })
          .__TAURI__
        if (tauri?.core) {
          const list = await tauri.core.invoke<{ device_path: string }[]>('list_serial_ports')
          if (Array.isArray(list)) {
            detected = list.map((item) => (typeof item === 'string' ? item : item.device_path)).filter(Boolean)
          }
        }
      }

      if (detected.length === 0) {
        const res = await fetch(api('/api/devices'))
        if (res.ok) {
          const json = await res.json()
          if (Array.isArray(json)) {
            detected = json.map((d) => (typeof d === 'string' ? d : d.device_path)).filter(Boolean)
          }
        }
      }

      setAvailableDevices(detected)
      // Auto-populate default port device if COM3 isn't available but another port is
      if (detected.length > 0) {
        setPorts((prev) =>
          prev.map((p, idx) => {
            if (idx === 0 && p.transport === 'serial' && (!p.deviceOrAddress || p.deviceOrAddress === 'COM3')) {
              return { ...p, deviceOrAddress: detected[0] }
            }
            return p
          }),
        )
      }
    } catch {
      // Hardware scan unavailable or offline
    } finally {
      setScanningDevices(false)
    }
  }

  function applyPreset(preset: WizardPreset) {
    setSelectedPreset(preset)
    const firstDev = availableDevices()[0] || 'COM3'
    const secondDev = availableDevices()[1] || (firstDev === 'COM3' ? 'COM4' : firstDev)

    switch (preset) {
      case 'single-mcu':
        setWorkspaceName('mcu-telemetry')
        setPorts([
          {
            id: 'mcu',
            transport: 'serial',
            deviceOrAddress: firstDev,
            baudRate: 115200,
            framing: 'delimiter',
            dissectorFile: '',
            dissectorStruct: '',
            showDissector: false,
          },
        ])
        setEnableBridge(false)
        break

      case 'hil-bridge':
        setWorkspaceName('hil-bridge-setup')
        setPorts([
          {
            id: 'obc',
            transport: 'serial',
            deviceOrAddress: firstDev,
            baudRate: 115200,
            framing: 'delimiter',
            dissectorFile: '',
            dissectorStruct: '',
            showDissector: false,
          },
          {
            id: 'sensor',
            transport: 'serial',
            deviceOrAddress: secondDev,
            baudRate: 115200,
            framing: 'delimiter',
            dissectorFile: '',
            dissectorStruct: '',
            showDissector: false,
          },
        ])
        setEnableBridge(true)
        setBridges([
          {
            id: 'hil_bridge',
            portA: 'obc',
            portB: 'sensor',
            forward: true,
          },
        ])
        break

      case 'tcp-stream':
        setWorkspaceName('tcp-telemetry')
        setPorts([
          {
            id: 'telemetry',
            transport: 'tcp-client',
            deviceOrAddress: '127.0.0.1:9100',
            baudRate: 115200,
            framing: 'cobs',
            dissectorFile: '',
            dissectorStruct: '',
            showDissector: false,
          },
        ])
        setEnableBridge(false)
        break

      case 'custom':
        setWorkspaceName('my-workspace')
        setPorts([
          {
            id: 'port0',
            transport: 'serial',
            deviceOrAddress: firstDev,
            baudRate: 115200,
            framing: 'cobs',
            dissectorFile: '',
            dissectorStruct: '',
            showDissector: false,
          },
        ])
        setEnableBridge(false)
        break
    }
  }

  function addPort() {
    const nextIdx = ports().length
    const fallbackDev = availableDevices()[nextIdx] || (nextIdx === 0 ? 'COM3' : `COM${3 + nextIdx}`)
    setPorts((prev) => [
      ...prev,
      {
        id: `port${nextIdx}`,
        transport: 'serial',
        deviceOrAddress: fallbackDev,
        baudRate: 115200,
        framing: 'delimiter',
        dissectorFile: '',
        dissectorStruct: '',
        showDissector: false,
      },
    ])
    setSelectedPreset('custom')
  }

  function removePort(index: number) {
    if (ports().length <= 1) {
      showStatus('At least one port is required in a workspace', true)
      return
    }
    const removedId = ports()[index].id
    setPorts((prev) => prev.filter((_, idx) => idx !== index))
    // Clean up bridges referencing the removed port
    setBridges((prev) => prev.filter((b) => b.portA !== removedId && b.portB !== removedId))
    setSelectedPreset('custom')
  }

  function updatePort(index: number, patch: Partial<WizardPortItem>) {
    setPorts((prev) =>
      prev.map((port, idx) => (idx === index ? { ...port, ...patch } : port)),
    )
    setSelectedPreset('custom')
  }

  function addBridge() {
    const portList = ports()
    const pA = portList[0]?.id || 'port0'
    const pB = portList[1]?.id || portList[0]?.id || 'port1'
    const nextIdx = bridges().length
    setBridges((prev) => [
      ...prev,
      {
        id: `bridge${nextIdx}`,
        portA: pA,
        portB: pB,
        forward: true,
      },
    ])
  }

  function removeBridge(index: number) {
    setBridges((prev) => prev.filter((_, idx) => idx !== index))
  }

  function updateBridge(index: number, patch: Partial<WizardBridgeItem>) {
    setBridges((prev) =>
      prev.map((b, idx) => (idx === index ? { ...b, ...patch } : b)),
    )
  }

  function showStatus(text: string, error = false) {
    setStatusMessage({ text, error })
    setTimeout(() => {
      setStatusMessage((current) => (current?.text === text ? null : current))
    }, 4000)
  }

  // Synthesize TOML memo
  const generatedToml = createMemo(() => {
    const wizardPorts: WizardPortInput[] = ports().map((p) => ({
      id: p.id,
      transport: p.transport,
      device: p.transport === 'serial' ? p.deviceOrAddress : undefined,
      address: p.transport !== 'serial' ? p.deviceOrAddress : undefined,
      baud_rate: p.baudRate,
      framing: p.framing,
      dissector_file: p.dissectorFile || undefined,
      dissector_struct: p.dissectorStruct || undefined,
    }))

    const wizardBridges: WizardBridgeInput[] = enableBridge()
      ? bridges().map((b) => ({
          id: b.id,
          a: b.portA,
          b: b.portB,
          forward: b.forward,
        }))
      : []

    return synthesizeWorkspaceToml(wizardPorts, wizardBridges, {
      name: workspaceName().trim() || 'my-workspace',
    })
  })

  function handleDownloadToml() {
    try {
      const name = (workspaceName().trim() || 'my-workspace') + '.bforge.toml'
      triggerFileDownload(name, generatedToml())
      showStatus(`Saved ${name}`)
    } catch {
      showStatus('Failed to download configuration', true)
    }
  }

  async function handleCopyToml() {
    try {
      await navigator.clipboard.writeText(generatedToml())
      setCopiedToml(true)
      showStatus('Copied .bforge.toml to clipboard')
      setTimeout(() => setCopiedToml(false), 2000)
    } catch {
      showStatus('Failed to copy to clipboard', true)
    }
  }

  async function handleLaunchWorkspace() {
    const name = workspaceName().trim()
    if (!name) {
      showStatus('Workspace name is required', true)
      setActiveTab('form')
      return
    }

    const portList = ports()
    if (portList.length === 0) {
      showStatus('Add at least one port', true)
      setActiveTab('form')
      return
    }

    // Validate port IDs and addresses
    for (const p of portList) {
      if (!p.id.trim()) {
        showStatus('All ports must have a valid Port ID', true)
        setActiveTab('form')
        return
      }
      if (!p.deviceOrAddress.trim()) {
        showStatus(`Port '${p.id}' requires a device path or address`, true)
        setActiveTab('form')
        return
      }
    }

    setLaunching(true)
    showStatus('Synthesizing workspace & connecting...')

    try {
      const primary = portList[0]

      // 1. If in Tauri desktop shell
      if (inShell()) {
        const tauri = (globalThis as { __TAURI__?: { core?: { invoke<T>(cmd: string, args?: any): Promise<T> } } })
          .__TAURI__
        if (tauri?.core) {
          try {
            const url = await tauri.core.invoke<string>('quick_connect', {
              device: primary.deviceOrAddress,
              baudRate: primary.baudRate,
              framing: primary.framing,
            })
            if (url) {
              showStatus('Session started successfully')
              props.onLaunched?.(name)
              setTimeout(() => {
                props.onClose()
                if (url.startsWith('http://') || url.startsWith('https://')) {
                  window.location.href = url
                }
              }, 400)
              return
            }
          } catch (tErr) {
            console.warn('Tauri quick_connect fallback:', tErr)
          }
        }
      }

      // 2. Web HTTP mode: POST /api/quick-connect
      const res = await fetch(api('/api/quick-connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: primary.deviceOrAddress,
          baud_rate: primary.baudRate,
          framing: primary.framing,
        }),
      })

      if (res.ok) {
        showStatus('Workspace launched successfully!')
        props.onLaunched?.(name)
        setTimeout(() => props.onClose(), 600)
      } else {
        // Multi-port or server quick-connect limitation: download TOML for user
        handleDownloadToml()
        showStatus('Configuration saved. Use: bforge run ' + name + '.bforge.toml')
      }
    } catch {
      handleDownloadToml()
      showStatus('Configuration downloaded. Launch engine using: bforge run')
    } finally {
      setLaunching(false)
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      props.onClose()
    }
  }

  return (
    <Show when={props.open}>
      <div class="new-ws-backdrop" onClick={handleBackdropClick}>
        <div class="new-ws-dialog" role="dialog" aria-modal="true" aria-label="Create New Workspace">
          {/* Header */}
          <div class="new-ws-header">
            <div class="new-ws-header-left">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="new-ws-icon">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <line x1="12" y1="7" x2="12" y2="13" />
                <line x1="9" y1="10" x2="15" y2="10" />
              </svg>
              <div>
                <h2 class="new-ws-title">Create New Workspace</h2>
                <span class="new-ws-subtitle">Interactive Multi-Port &amp; Hardware-in-the-Loop Setup Wizard</span>
              </div>
            </div>
            <div class="new-ws-header-right">
              <Show when={statusMessage()}>
                {(msg) => (
                  <span class={`new-ws-status-pill ${msg().error ? 'error' : 'ok'}`}>
                    {msg().text}
                  </span>
                )}
              </Show>
              <button
                type="button"
                class="new-ws-esc-badge"
                onClick={props.onClose}
                title="Close Wizard (Esc)"
              >
                ESC
              </button>
            </div>
          </div>

          {/* Wizard Step / Mode Navigation */}
          <div class="new-ws-tab-bar">
            <button
              type="button"
              class={`new-ws-tab-btn ${activeTab() === 'presets' ? 'active' : ''}`}
              onClick={() => setActiveTab('presets')}
            >
              <span class="tab-num">1</span>
              <span>Quick Presets</span>
            </button>
            <button
              type="button"
              class={`new-ws-tab-btn ${activeTab() === 'form' ? 'active' : ''}`}
              onClick={() => setActiveTab('form')}
            >
              <span class="tab-num">2</span>
              <span>Ports &amp; Bridges ({ports().length})</span>
            </button>
            <button
              type="button"
              class={`new-ws-tab-btn ${activeTab() === 'preview' ? 'active' : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              <span class="tab-num">3</span>
              <span>.bforge.toml Preview</span>
            </button>
          </div>

          {/* Modal Content Body */}
          <div class="new-ws-body">
            {/* Step 1: Quick Setup Presets */}
            <Show when={activeTab() === 'presets'}>
              <div class="new-ws-section">
                <div class="section-title-wrap">
                  <h3 class="section-heading">Select Instrumentation Template</h3>
                  <span class="section-hint">Choose a pre-configured architecture or configure custom ports.</span>
                </div>

                <div class="preset-cards-grid">
                  {/* Preset 1: Single Microcontroller */}
                  <div
                    class={`preset-card ${selectedPreset() === 'single-mcu' ? 'selected' : ''}`}
                    onClick={() => {
                      applyPreset('single-mcu')
                    }}
                  >
                    <div class="preset-card-top">
                      <span class="preset-badge">SERIAL · DELIMITER</span>
                      <Show when={selectedPreset() === 'single-mcu'}>
                        <span class="preset-active-check">✓ Active</span>
                      </Show>
                    </div>
                    <div class="preset-card-name">Single Microcontroller</div>
                    <p class="preset-card-desc">
                      Standard bring-up for single dev boards (STM32, ESP32, RP2040, Arduino) with newline-delimited ASCII or binary framing.
                    </p>
                    <div class="preset-card-meta">
                      <span>1 Port (UART @ 115200)</span>
                      <span>Delimiter Framing</span>
                    </div>
                  </div>

                  {/* Preset 2: Dual-Port Bridge (HIL) */}
                  <div
                    class={`preset-card ${selectedPreset() === 'hil-bridge' ? 'selected' : ''}`}
                    onClick={() => {
                      applyPreset('hil-bridge')
                    }}
                  >
                    <div class="preset-card-top">
                      <span class="preset-badge hil">HIL · DUAL-PORT</span>
                      <Show when={selectedPreset() === 'hil-bridge'}>
                        <span class="preset-active-check">✓ Active</span>
                      </Show>
                    </div>
                    <div class="preset-card-name">Dual-Port Bridge (HIL)</div>
                    <p class="preset-card-desc">
                      Hardware-in-the-Loop bridge coupling flight computer (OBC) and payload/sensor with active bidirectional packet forwarding.
                    </p>
                    <div class="preset-card-meta">
                      <span>2 Ports (OBC &amp; Sensor)</span>
                      <span>Forwarding Bridge Active</span>
                    </div>
                  </div>

                  {/* Preset 3: TCP Telemetry Stream */}
                  <div
                    class={`preset-card ${selectedPreset() === 'tcp-stream' ? 'selected' : ''}`}
                    onClick={() => {
                      applyPreset('tcp-stream')
                    }}
                  >
                    <div class="preset-card-top">
                      <span class="preset-badge network">TCP · COBS</span>
                      <Show when={selectedPreset() === 'tcp-stream'}>
                        <span class="preset-active-check">✓ Active</span>
                      </Show>
                    </div>
                    <div class="preset-card-name">TCP Telemetry Stream</div>
                    <p class="preset-card-desc">
                      High-throughput socket stream connecting to a network telemetry daemon, SITL simulator, or emulator with COBS framing.
                    </p>
                    <div class="preset-card-meta">
                      <span>TCP Client (127.0.0.1:9100)</span>
                      <span>COBS Encoding</span>
                    </div>
                  </div>

                  {/* Preset 4: Custom Setup */}
                  <div
                    class={`preset-card ${selectedPreset() === 'custom' ? 'selected' : ''}`}
                    onClick={() => {
                      applyPreset('custom')
                    }}
                  >
                    <div class="preset-card-top">
                      <span class="preset-badge custom">MODULAR · HIL</span>
                      <Show when={selectedPreset() === 'custom'}>
                        <span class="preset-active-check">✓ Active</span>
                      </Show>
                    </div>
                    <div class="preset-card-name">Custom Setup</div>
                    <p class="preset-card-desc">
                      Build an arbitrary multi-port test bench with granular UART, TCP client/server, UDP sockets, and custom dissectors.
                    </p>
                    <div class="preset-card-meta">
                      <span>Fully Configurable</span>
                      <span>Bridges &amp; Dissectors</span>
                    </div>
                  </div>
                </div>

                <div class="preset-action-row">
                  <span class="preset-selected-note">
                    Selected Template: <strong>{selectedPreset()}</strong> ({workspaceName()})
                  </span>
                  <button
                    type="button"
                    class="btn-secondary"
                    onClick={() => setActiveTab('form')}
                  >
                    Customize Ports &amp; Bridges →
                  </button>
                </div>
              </div>
            </Show>

            {/* Step 2: Configuration Form */}
            <Show when={activeTab() === 'form'}>
              <div class="new-ws-section">
                {/* Workspace Name Input */}
                <div class="form-group workspace-name-group">
                  <label for="ws-name-input" class="form-label">
                    Workspace Name:
                  </label>
                  <div class="input-with-ext">
                    <input
                      id="ws-name-input"
                      type="text"
                      class="form-input text-mono"
                      value={workspaceName()}
                      onInput={(e) => setWorkspaceName(e.currentTarget.value.trim().replace(/\s+/g, '-'))}
                      placeholder="my-workspace"
                    />
                    <span class="ext-badge">.bforge.toml</span>
                  </div>
                  <span class="form-hint">Filename and identifier for the synthesized workspace.</span>
                </div>

                {/* Ports Section Header */}
                <div class="section-title-wrap horizontal-split">
                  <div>
                    <h3 class="section-heading">Configured Hardware Ports ({ports().length})</h3>
                    <span class="section-hint">Each port maps to a physical UART, TCP socket, or UDP datagram stream.</span>
                  </div>
                  <div class="section-actions">
                    <button
                      type="button"
                      class="btn-icon-label"
                      onClick={() => void scanSerialDevices()}
                      disabled={scanningDevices()}
                      title="Scan for connected USB/Serial devices"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                      {scanningDevices() ? 'Scanning...' : 'Scan Ports'}
                    </button>
                    <button
                      type="button"
                      class="btn-primary-sm"
                      onClick={addPort}
                      title="Add a new hardware port"
                    >
                      + Add Port
                    </button>
                  </div>
                </div>

                {/* Ports List */}
                <div class="ports-list">
                  <For each={ports()}>
                    {(port, index) => (
                      <div class="port-card">
                        <div class="port-card-header">
                          <div class="port-header-left">
                            <span class="port-badge-idx">#{index() + 1}</span>
                            <span class="port-header-title text-mono">{port.id || 'unnamed'}</span>
                            <span class={`transport-pill ${port.transport}`}>{port.transport}</span>
                          </div>
                          <div class="port-header-right">
                            <button
                              type="button"
                              class="btn-icon-subtle"
                              onClick={() => removePort(index())}
                              title={`Remove port ${port.id}`}
                              disabled={ports().length <= 1}
                            >
                              ✕ Remove
                            </button>
                          </div>
                        </div>

                        <div class="port-form-grid">
                          {/* Port ID */}
                          <div class="form-field">
                            <label class="field-label">Port ID</label>
                            <input
                              type="text"
                              class="form-input text-mono"
                              value={port.id}
                              onInput={(e) => updatePort(index(), { id: e.currentTarget.value.trim() })}
                              placeholder="e.g. obc, eps, mcu"
                            />
                          </div>

                          {/* Transport */}
                          <div class="form-field">
                            <label class="field-label">Transport</label>
                            <select
                              class="form-select"
                              value={port.transport}
                              onChange={(e) => {
                                const tr = e.currentTarget.value as WizardPortItem['transport']
                                const defaultAddr = tr === 'serial' ? (availableDevices()[0] || 'COM3') : '127.0.0.1:9100'
                                updatePort(index(), { transport: tr, deviceOrAddress: defaultAddr })
                              }}
                            >
                              <option value="serial">Serial UART</option>
                              <option value="tcp-client">TCP Client</option>
                              <option value="tcp-server">TCP Server</option>
                              <option value="udp">UDP Datagram</option>
                            </select>
                          </div>

                          {/* Device / Address */}
                          <div class="form-field">
                            <label class="field-label">
                              {port.transport === 'serial' ? 'Device Path (COM / tty)' : 'Socket Address (IP:Port)'}
                            </label>
                            <div class="input-with-dropdown">
                              <input
                                type="text"
                                class="form-input text-mono"
                                list={`dev-list-${index()}`}
                                value={port.deviceOrAddress}
                                onInput={(e) => updatePort(index(), { deviceOrAddress: e.currentTarget.value.trim() })}
                                placeholder={port.transport === 'serial' ? 'COM3 or /dev/ttyUSB0' : '127.0.0.1:9100'}
                              />
                              <Show when={port.transport === 'serial' && availableDevices().length > 0}>
                                <datalist id={`dev-list-${index()}`}>
                                  <For each={availableDevices()}>
                                    {(dev) => <option value={dev} />}
                                  </For>
                                </datalist>
                              </Show>
                            </div>
                          </div>

                          {/* Baud Rate */}
                          <div class="form-field">
                            <label class="field-label">Baud Rate</label>
                            <select
                              class="form-select text-mono"
                              value={port.baudRate}
                              onChange={(e) => updatePort(index(), { baudRate: parseInt(e.currentTarget.value, 10) })}
                            >
                              <For each={BAUD_RATES}>
                                {(rate) => <option value={rate}>{rate}</option>}
                              </For>
                            </select>
                          </div>

                          {/* Framing */}
                          <div class="form-field">
                            <label class="field-label">Framing Protocol</label>
                            <select
                              class="form-select"
                              value={port.framing}
                              onChange={(e) => updatePort(index(), { framing: e.currentTarget.value })}
                            >
                              <For each={FRAMING_MODES}>
                                {(mode) => <option value={mode.id}>{mode.label}</option>}
                              </For>
                            </select>
                          </div>
                        </div>

                        {/* Optional Dissector toggle */}
                        <div class="dissector-section">
                          <button
                            type="button"
                            class="dissector-toggle-btn"
                            onClick={() => updatePort(index(), { showDissector: !port.showDissector })}
                          >
                            <span>{port.showDissector ? '▼' : '▶'}</span>
                            <span>C Header Protocol Dissector (Optional)</span>
                            <Show when={port.dissectorFile}>
                              <span class="dissector-active-pill text-mono">{port.dissectorFile}</span>
                            </Show>
                          </button>

                          <Show when={port.showDissector}>
                            <div class="dissector-fields-grid">
                              <div class="form-field">
                                <label class="field-label">C Header File Path</label>
                                <input
                                  type="text"
                                  class="form-input text-mono"
                                  value={port.dissectorFile}
                                  onInput={(e) => updatePort(index(), { dissectorFile: e.currentTarget.value })}
                                  placeholder="e.g. include/telemetry.h"
                                />
                              </div>
                              <div class="form-field">
                                <label class="field-label">Root Struct Name</label>
                                <input
                                  type="text"
                                  class="form-input text-mono"
                                  value={port.dissectorStruct}
                                  onInput={(e) => updatePort(index(), { dissectorStruct: e.currentTarget.value })}
                                  placeholder="e.g. TelemetryPkt or obc_status_t"
                                />
                              </div>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>

                {/* Bridges Section */}
                <div class="bridge-config-container">
                  <div class="bridge-enable-row">
                    <label class="checkbox-container">
                      <input
                        type="checkbox"
                        checked={enableBridge()}
                        onChange={(e) => {
                          setEnableBridge(e.currentTarget.checked)
                          if (e.currentTarget.checked && bridges().length === 0) {
                            addBridge()
                          }
                        }}
                      />
                      <span class="checkbox-custom" />
                      <span class="checkbox-label">
                        <strong>Enable Hardware-in-the-Loop (HIL) Bridge / Packet Forwarding</strong>
                        <span class="checkbox-sublabel">Couples two ports together to tap or forward packets in real-time.</span>
                      </span>
                    </label>
                    <Show when={enableBridge()}>
                      <button
                        type="button"
                        class="btn-primary-sm"
                        onClick={addBridge}
                      >
                        + Add Bridge Pair
                      </button>
                    </Show>
                  </div>

                  <Show when={enableBridge()}>
                    <div class="bridges-list">
                      <For each={bridges()}>
                        {(bridge, bIndex) => (
                          <div class="bridge-card">
                            <div class="bridge-form-grid">
                              <div class="form-field">
                                <label class="field-label">Bridge ID</label>
                                <input
                                  type="text"
                                  class="form-input text-mono"
                                  value={bridge.id}
                                  onInput={(e) => updateBridge(bIndex(), { id: e.currentTarget.value.trim() })}
                                  placeholder="hil_bridge"
                                />
                              </div>

                              <div class="form-field">
                                <label class="field-label">Port A</label>
                                <select
                                  class="form-select text-mono"
                                  value={bridge.portA}
                                  onChange={(e) => updateBridge(bIndex(), { portA: e.currentTarget.value })}
                                >
                                  <For each={ports()}>
                                    {(p) => <option value={p.id}>{p.id} ({p.transport})</option>}
                                  </For>
                                </select>
                              </div>

                              <div class="form-field">
                                <label class="field-label">Port B</label>
                                <select
                                  class="form-select text-mono"
                                  value={bridge.portB}
                                  onChange={(e) => updateBridge(bIndex(), { portB: e.currentTarget.value })}
                                >
                                  <For each={ports()}>
                                    {(p) => <option value={p.id}>{p.id} ({p.transport})</option>}
                                  </For>
                                </select>
                              </div>

                              <div class="form-field checkbox-field">
                                <label class="field-label">Live Forwarding</label>
                                <label class="toggle-switch">
                                  <input
                                    type="checkbox"
                                    checked={bridge.forward}
                                    onChange={(e) => updateBridge(bIndex(), { forward: e.currentTarget.checked })}
                                  />
                                  <span class="toggle-slider" />
                                  <span class="toggle-text">{bridge.forward ? 'Forward Active' : 'Passive Tap'}</span>
                                </label>
                              </div>

                              <div class="form-field bridge-remove-field">
                                <label class="field-label">&nbsp;</label>
                                <button
                                  type="button"
                                  class="btn-icon-subtle"
                                  onClick={() => removeBridge(bIndex())}
                                  title="Remove bridge"
                                >
                                  ✕ Remove
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Step 3: TOML Preview */}
            <Show when={activeTab() === 'preview'}>
              <div class="new-ws-section">
                <div class="section-title-wrap horizontal-split">
                  <div>
                    <h3 class="section-heading">Synthesized Configuration (.bforge.toml)</h3>
                    <span class="section-hint">Clean, reproducible declarative specification ready for version control.</span>
                  </div>
                  <button
                    type="button"
                    class="btn-secondary-sm"
                    onClick={() => void handleCopyToml()}
                  >
                    {copiedToml() ? '✓ Copied' : 'Copy TOML'}
                  </button>
                </div>

                <div class="toml-preview-card">
                  <pre class="toml-code text-mono">{generatedToml()}</pre>
                </div>
              </div>
            </Show>
          </div>

          {/* Footer Action Bar */}
          <div class="new-ws-footer">
            <div class="new-ws-footer-left">
              <Show when={availableDevices().length > 0}>
                <span class="device-scan-badge" title={availableDevices().join(', ')}>
                  ● {availableDevices().length} Hardware Port{availableDevices().length > 1 ? 's' : ''} Detected
                </span>
              </Show>
            </div>

            <div class="new-ws-footer-right">
              <button
                type="button"
                class="btn-ghost"
                onClick={props.onClose}
              >
                Cancel
              </button>

              <button
                type="button"
                class="btn-secondary"
                onClick={handleDownloadToml}
                title="Download .bforge.toml to commit to your project repository"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download .bforge.toml
              </button>

              <button
                type="button"
                class="btn-primary"
                onClick={() => void handleLaunchWorkspace()}
                disabled={launching()}
                title="Synthesize and connect to workspace immediately"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {launching() ? 'Launching...' : 'Launch Workspace'}
              </button>
            </div>
          </div>
        </div>

        {/* Modal Scoped Styles */}
        <style>{`
          .new-ws-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.72);
            backdrop-filter: blur(5px);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
          }
          .new-ws-dialog {
            width: 100%;
            max-width: 820px;
            max-height: 88vh;
            background: var(--bg-surface-1, #101217);
            border: 1px solid var(--border-strong, #2d3446);
            border-radius: 8px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75), 0 0 0 1px var(--border-highlight, rgba(255, 255, 255, 0.08));
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: wizardIn 140ms cubic-bezier(0.23, 1, 0.32, 1);
          }
          @keyframes wizardIn {
            from { opacity: 0; transform: scale(0.97) translateY(8px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          .new-ws-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 20px;
            background: var(--bg-surface-2, #161920);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .new-ws-header-left {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .new-ws-icon {
            color: var(--sig-tx, #06b6d4);
          }
          .new-ws-title {
            margin: 0;
            font-size: 15px;
            font-weight: 600;
            letter-spacing: -0.01em;
            color: var(--text-primary, #edf0f7);
          }
          .new-ws-subtitle {
            font-size: 11px;
            color: var(--text-muted, #717d96);
          }
          .new-ws-header-right {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .new-ws-status-pill {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            background: rgba(6, 182, 212, 0.15);
            color: var(--sig-tx, #06b6d4);
            border: 1px solid rgba(6, 182, 212, 0.3);
          }
          .new-ws-status-pill.error {
            background: rgba(244, 63, 94, 0.15);
            color: var(--sig-fault, #f43f5e);
            border-color: rgba(244, 63, 94, 0.3);
          }
          .new-ws-esc-badge {
            font-size: 10px;
            font-family: var(--font-mono, monospace);
            padding: 2px 6px;
            background: var(--bg-surface-3, #1f2430);
            color: var(--text-muted, #717d96);
            border: 1px solid var(--border-hairline, #2d3446);
            border-radius: 4px;
            cursor: pointer;
            transition: color 120ms ease, border-color 120ms ease;
          }
          .new-ws-esc-badge:hover {
            color: var(--text-primary, #edf0f7);
            border-color: var(--border-strong, #475569);
          }
          .new-ws-tab-bar {
            display: flex;
            background: var(--bg-surface-2, #14171f);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
            padding: 0 16px;
            gap: 8px;
          }
          .new-ws-tab-btn {
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 10px 14px;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-muted, #717d96);
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: color 120ms ease, border-color 120ms ease;
          }
          .new-ws-tab-btn:hover {
            color: var(--text-primary, #edf0f7);
          }
          .new-ws-tab-btn.active {
            color: var(--sig-tx, #06b6d4);
            border-bottom-color: var(--sig-tx, #06b6d4);
          }
          .tab-num {
            font-size: 10px;
            font-family: var(--font-mono, monospace);
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
          }
          .new-ws-tab-btn.active .tab-num {
            background: rgba(6, 182, 212, 0.15);
            border-color: rgba(6, 182, 212, 0.3);
            color: var(--sig-tx, #06b6d4);
          }
          .new-ws-body {
            padding: 18px 20px;
            overflow-y: auto;
            max-height: calc(88vh - 125px);
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .new-ws-section {
            display: flex;
            flex-direction: column;
            gap: 14px;
          }
          .section-title-wrap {
            margin-bottom: 2px;
          }
          .section-title-wrap.horizontal-split {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .section-heading {
            margin: 0;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .section-hint {
            font-size: 11px;
            color: var(--text-muted, #717d96);
          }
          .section-actions {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          /* Presets Grid */
          .preset-cards-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
          }
          @media (max-width: 640px) {
            .preset-cards-grid {
              grid-template-columns: 1fr;
            }
          }
          .preset-card {
            background: var(--bg-surface-2, #151821);
            border: 1px solid var(--border-hairline, #232938);
            border-radius: 6px;
            padding: 14px;
            cursor: pointer;
            transition: all 140ms ease;
            display: flex;
            flex-direction: column;
            gap: 8px;
            position: relative;
          }
          .preset-card:hover {
            border-color: var(--border-strong, #3b455b);
            background: var(--bg-surface-3, #1a1e2a);
          }
          .preset-card.selected {
            border-color: var(--sig-tx, #06b6d4);
            background: rgba(6, 182, 212, 0.05);
            box-shadow: 0 0 0 1px var(--sig-tx, #06b6d4);
          }
          .preset-card-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .preset-badge {
            font-size: 9.5px;
            font-family: var(--font-mono, monospace);
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--bg-surface-3, #1f2430);
            color: var(--text-muted, #94a3b8);
            border: 1px solid var(--border-hairline, #2d3446);
          }
          .preset-badge.hil {
            color: var(--sig-rx, #10b981);
            border-color: rgba(16, 185, 129, 0.3);
            background: rgba(16, 185, 129, 0.1);
          }
          .preset-badge.network {
            color: #38bdf8;
            border-color: rgba(56, 189, 248, 0.3);
            background: rgba(56, 189, 248, 0.1);
          }
          .preset-badge.custom {
            color: #fbbf24;
            border-color: rgba(251, 191, 36, 0.3);
            background: rgba(251, 191, 36, 0.1);
          }
          .preset-active-check {
            font-size: 11px;
            font-weight: 600;
            color: var(--sig-tx, #06b6d4);
          }
          .preset-card-name {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .preset-card-desc {
            margin: 0;
            font-size: 11px;
            line-height: 1.45;
            color: var(--text-muted, #8a99ad);
            flex: 1;
          }
          .preset-card-meta {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 10px;
            font-family: var(--font-mono, monospace);
            color: var(--text-muted, #717d96);
            padding-top: 6px;
            border-top: 1px solid var(--border-hairline, #232938);
          }
          .preset-action-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            background: var(--bg-surface-2, #141720);
            border: 1px solid var(--border-hairline, #232938);
            border-radius: 6px;
          }
          .preset-selected-note {
            font-size: 12px;
            color: var(--text-muted, #8a99ad);
          }
          .preset-selected-note strong {
            color: var(--text-primary, #edf0f7);
          }
          /* Form Controls */
          .form-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .form-label {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary, #edf0f7);
          }
          .form-hint {
            font-size: 10.5px;
            color: var(--text-muted, #717d96);
          }
          .input-with-ext {
            display: flex;
            align-items: center;
          }
          .input-with-ext .form-input {
            border-top-right-radius: 0;
            border-bottom-right-radius: 0;
          }
          .ext-badge {
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
            border-left: none;
            padding: 6px 10px;
            font-size: 11px;
            font-family: var(--font-mono, monospace);
            color: var(--text-muted, #717d96);
            border-top-right-radius: 4px;
            border-bottom-right-radius: 4px;
          }
          .form-input, .form-select {
            background: var(--bg-surface-3, #1a1e28);
            border: 1px solid var(--border-hairline, #2b3345);
            border-radius: 4px;
            color: var(--text-primary, #edf0f7);
            font-size: 12px;
            padding: 6px 10px;
            outline: none;
            transition: border-color 120ms ease;
            width: 100%;
            box-sizing: border-box;
          }
          .form-input:focus, .form-select:focus {
            border-color: var(--sig-tx, #06b6d4);
          }
          .text-mono {
            font-family: var(--font-mono, monospace);
          }
          /* Ports Section */
          .ports-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .port-card {
            background: var(--bg-surface-2, #141720);
            border: 1px solid var(--border-hairline, #232938);
            border-radius: 6px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .port-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .port-header-left {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .port-badge-idx {
            font-size: 10px;
            font-weight: 600;
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
            border-radius: 3px;
            padding: 1px 5px;
            color: var(--sig-tx, #06b6d4);
          }
          .port-header-title {
            font-size: 12.5px;
            font-weight: 600;
            color: var(--text-primary, #edf0f7);
          }
          .transport-pill {
            font-size: 9.5px;
            font-family: var(--font-mono, monospace);
            padding: 1px 6px;
            border-radius: 10px;
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
            color: var(--text-muted, #94a3b8);
          }
          .port-form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1.4fr 1fr 1.2fr;
            gap: 10px;
          }
          @media (max-width: 700px) {
            .port-form-grid {
              grid-template-columns: 1fr 1fr;
            }
          }
          .form-field {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }
          .field-label {
            font-size: 10.5px;
            color: var(--text-muted, #8a99ad);
          }
          /* Dissector */
          .dissector-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-top: 4px;
          }
          .dissector-toggle-btn {
            background: transparent;
            border: none;
            padding: 0;
            color: var(--text-muted, #717d96);
            font-size: 11px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            text-align: left;
            transition: color 120ms ease;
          }
          .dissector-toggle-btn:hover {
            color: var(--sig-tx, #06b6d4);
          }
          .dissector-active-pill {
            font-size: 10px;
            padding: 1px 6px;
            background: rgba(6, 182, 212, 0.1);
            color: var(--sig-tx, #06b6d4);
            border: 1px solid rgba(6, 182, 212, 0.25);
            border-radius: 3px;
          }
          .dissector-fields-grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 10px;
            padding: 8px 10px;
            background: var(--bg-surface-3, #191d27);
            border: 1px solid var(--border-hairline, #232938);
            border-radius: 4px;
          }
          /* Bridges */
          .bridge-config-container {
            margin-top: 6px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px 14px;
            background: var(--bg-surface-2, #141720);
            border: 1px solid var(--border-hairline, #232938);
            border-radius: 6px;
          }
          .bridge-enable-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .checkbox-container {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            cursor: pointer;
          }
          .checkbox-container input[type="checkbox"] {
            display: none;
          }
          .checkbox-custom {
            width: 16px;
            height: 16px;
            border: 1px solid var(--border-strong, #3b455b);
            border-radius: 3px;
            background: var(--bg-surface-3, #1f2430);
            display: inline-block;
            position: relative;
            margin-top: 2px;
            flex-shrink: 0;
            transition: all 120ms ease;
          }
          .checkbox-container input[type="checkbox"]:checked + .checkbox-custom {
            background: var(--sig-tx, #06b6d4);
            border-color: var(--sig-tx, #06b6d4);
          }
          .checkbox-container input[type="checkbox"]:checked + .checkbox-custom::after {
            content: '';
            position: absolute;
            left: 5px;
            top: 2px;
            width: 4px;
            height: 8px;
            border: solid #000;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
          }
          .checkbox-label {
            display: flex;
            flex-direction: column;
            font-size: 12px;
            color: var(--text-primary, #edf0f7);
          }
          .checkbox-sublabel {
            font-size: 10.5px;
            color: var(--text-muted, #717d96);
          }
          .bridges-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 4px;
          }
          .bridge-card {
            background: var(--bg-surface-3, #191d27);
            border: 1px solid var(--border-hairline, #262c3b);
            border-radius: 5px;
            padding: 10px;
          }
          .bridge-form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr 1.2fr auto;
            gap: 10px;
            align-items: center;
          }
          .toggle-switch {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
          }
          .toggle-switch input {
            display: none;
          }
          .toggle-slider {
            width: 28px;
            height: 16px;
            background: var(--bg-surface-1, #101217);
            border: 1px solid var(--border-strong, #3b455b);
            border-radius: 9px;
            position: relative;
            transition: background 120ms ease;
          }
          .toggle-slider::after {
            content: '';
            position: absolute;
            top: 1px;
            left: 1px;
            width: 12px;
            height: 12px;
            background: var(--text-muted, #717d96);
            border-radius: 50%;
            transition: transform 120ms ease, background 120ms ease;
          }
          .toggle-switch input:checked + .toggle-slider {
            background: rgba(16, 185, 129, 0.25);
            border-color: var(--sig-rx, #10b981);
          }
          .toggle-switch input:checked + .toggle-slider::after {
            transform: translateX(12px);
            background: var(--sig-rx, #10b981);
          }
          .toggle-text {
            font-size: 11px;
            color: var(--text-primary, #edf0f7);
          }
          /* Preview Section */
          .toml-preview-card {
            background: var(--bg-surface-2, #0d0f14);
            border: 1px solid var(--border-hairline, #1f2430);
            border-radius: 6px;
            padding: 14px;
            overflow-x: auto;
          }
          .toml-code {
            margin: 0;
            font-size: 12px;
            line-height: 1.5;
            color: #38bdf8;
            tab-size: 2;
          }
          /* Footer */
          .new-ws-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            background: var(--bg-surface-2, #161920);
            border-top: 1px solid var(--border-hairline, #1f2430);
          }
          .new-ws-footer-left {
            display: flex;
            align-items: center;
          }
          .device-scan-badge {
            font-size: 10.5px;
            color: var(--sig-rx, #10b981);
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.25);
            padding: 2px 8px;
            border-radius: 10px;
          }
          .new-ws-footer-right {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          /* Buttons */
          .btn-ghost {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-muted, #717d96);
            font-size: 12px;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            transition: color 120ms ease;
          }
          .btn-ghost:hover {
            color: var(--text-primary, #edf0f7);
          }
          .btn-secondary {
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
            color: var(--text-primary, #edf0f7);
            font-size: 12px;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: border-color 120ms ease, background 120ms ease;
          }
          .btn-secondary:hover {
            border-color: var(--border-strong, #475569);
            background: #252b3a;
          }
          .btn-secondary-sm {
            background: var(--bg-surface-3, #1f2430);
            border: 1px solid var(--border-hairline, #2d3446);
            color: var(--text-primary, #edf0f7);
            font-size: 11px;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
          }
          .btn-primary {
            background: var(--sig-tx, #06b6d4);
            border: 1px solid rgba(6, 182, 212, 0.8);
            color: #000;
            font-weight: 600;
            font-size: 12px;
            padding: 6px 14px;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: filter 120ms ease, opacity 120ms ease;
          }
          .btn-primary:hover:not(:disabled) {
            filter: brightness(1.1);
          }
          .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }
          .btn-primary-sm {
            background: rgba(6, 182, 212, 0.15);
            border: 1px solid rgba(6, 182, 212, 0.4);
            color: var(--sig-tx, #06b6d4);
            font-size: 11px;
            font-weight: 500;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: background 120ms ease;
          }
          .btn-primary-sm:hover {
            background: rgba(6, 182, 212, 0.25);
          }
          .btn-icon-label {
            background: var(--bg-surface-3, #1a1e28);
            border: 1px solid var(--border-hairline, #2b3345);
            color: var(--text-muted, #8a99ad);
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 5px;
          }
          .btn-icon-label:hover {
            color: var(--text-primary, #edf0f7);
            border-color: var(--border-strong, #475569);
          }
          .btn-icon-subtle {
            background: transparent;
            border: none;
            color: var(--text-muted, #717d96);
            font-size: 10.5px;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
          }
          .btn-icon-subtle:hover:not(:disabled) {
            color: var(--sig-fault, #f43f5e);
            background: rgba(244, 63, 94, 0.1);
          }
          .btn-icon-subtle:disabled {
            opacity: 0.3;
            cursor: not-allowed;
          }
        `}</style>
      </div>
    </Show>
  )
}
