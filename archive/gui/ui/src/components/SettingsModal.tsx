import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Component,
} from 'solid-js'
import {
  exportSettingsJson,
  importSettingsJson,
  resetToDefaults,
} from '../lib/settings'
import {
  currentTheme,
  currentDensity,
  currentAccent,
  currentFontSize,
  setTheme,
  setDensity,
  setAccent,
  setFontSize,
} from '../lib/theme'
import {
  allColumns,
  toggleColumnVisibility,
  resizeColumn,
  moveColumnUp,
  moveColumnDown,
  resetColumns,
} from '../lib/columns'
import {
  COMMAND_DEFINITIONS,
  getKeybinding,
  setKeybinding,
  resetKeybindings,
  eventToKeyCombo,
  type CommandDef,
} from '../lib/commands'

export interface SettingsModalProps {
  open: boolean
  onClose: () => void
  initialTab?: 'appearance' | 'columns' | 'shortcuts' | 'backup'
}

type SettingsTab = 'appearance' | 'columns' | 'shortcuts' | 'backup'

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<SettingsTab>(props.initialTab || 'appearance')
  const [rebindingId, setRebindingId] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal<{ text: string; error?: boolean } | null>(null)
  const [showJsonPaste, setShowJsonPaste] = createSignal(false)
  const [pasteText, setPasteText] = createSignal('')

  let fileInputRef: HTMLInputElement | undefined

  // Switch to initial tab if requested when opened
  createEffect(() => {
    if (props.open && props.initialTab) {
      setActiveTab(props.initialTab)
    }
    if (props.open) {
      setRebindingId(null)
      setStatusMessage(null)
      setShowJsonPaste(false)
    }
  })

  // Global escape and key recording listeners
  createEffect(() => {
    if (!props.open) return

    const handleGlobalKey = (e: KeyboardEvent) => {
      // If actively capturing shortcut rebind
      const rebinding = rebindingId()
      if (rebinding) {
        e.preventDefault()
        e.stopPropagation()

        if (e.key === 'Escape') {
          setRebindingId(null)
          return
        }

        const combo = eventToKeyCombo(e)
        if (combo) {
          setKeybinding(rebinding, combo)
          setRebindingId(null)
          showStatus(`Rebound to ${combo}`)
        }
        return
      }

      // Close modal on Escape
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }

    window.addEventListener('keydown', handleGlobalKey, true)
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKey, true))
  })

  function showStatus(text: string, error = false) {
    setStatusMessage({ text, error })
    setTimeout(() => {
      setStatusMessage((cur) => (cur?.text === text ? null : cur))
    }, 3500)
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && !rebindingId()) {
      props.onClose()
    }
  }

  function handleExport() {
    try {
      const json = exportSettingsJson()
      // Copy to clipboard
      navigator.clipboard?.writeText(json)

      // Trigger file download
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `baudforge-settings-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      showStatus('Settings exported & copied to clipboard')
    } catch (err) {
      showStatus('Failed to export settings', true)
    }
  }

  function handleFileImport(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      if (content) {
        const ok = importSettingsJson(content)
        if (ok) {
          showStatus('Settings imported successfully')
        } else {
          showStatus('Invalid settings JSON format', true)
        }
      }
    }
    reader.readAsText(file)
    input.value = ''
  }

  function handlePasteImport() {
    const raw = pasteText().trim()
    if (!raw) return
    const ok = importSettingsJson(raw)
    if (ok) {
      showStatus('Settings imported successfully')
      setShowJsonPaste(false)
      setPasteText('')
    } else {
      showStatus('Invalid JSON configuration', true)
    }
  }

  function handleResetAll() {
    if (confirm('Reset all appearance, column, and shortcut settings to default?')) {
      resetToDefaults()
      resetColumns()
      resetKeybindings()
      showStatus('All settings restored to factory defaults')
    }
  }

  // Group commands by category for clean presentation
  const commandCategories = ['Navigation', 'Stream', 'DVR', 'Panels', 'Presets', 'General'] as const

  return (
    <Show when={props.open}>
      <div class="settings-backdrop" onClick={handleBackdropClick}>
        <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="Workbench Settings">
          {/* Header */}
          <div class="settings-header">
            <div class="settings-header-left">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="settings-icon">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <h2 class="settings-title">Workbench Settings</h2>
            </div>
            <div class="settings-header-right">
              <Show when={statusMessage()}>
                {(msg) => (
                  <span class={`settings-status-pill ${msg().error ? 'error' : 'ok'}`}>
                    {msg().text}
                  </span>
                )}
              </Show>
              <span class="settings-esc-badge" onClick={props.onClose} title="Close Settings">
                ESC
              </span>
            </div>
          </div>

          {/* Tab Navigation */}
          <div class="settings-tab-bar">
            <button
              class={`settings-tab-btn ${activeTab() === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              Appearance
            </button>
            <button
              class={`settings-tab-btn ${activeTab() === 'columns' ? 'active' : ''}`}
              onClick={() => setActiveTab('columns')}
            >
              Stream Columns
            </button>
            <button
              class={`settings-tab-btn ${activeTab() === 'shortcuts' ? 'active' : ''}`}
              onClick={() => setActiveTab('shortcuts')}
            >
              Shortcuts
            </button>
            <button
              class={`settings-tab-btn ${activeTab() === 'backup' ? 'active' : ''}`}
              onClick={() => setActiveTab('backup')}
            >
              Presets & Backup
            </button>
          </div>

          {/* Content Pane */}
          <div class="settings-body">
            {/* 1. Appearance Tab */}
            <Show when={activeTab() === 'appearance'}>
              <div class="settings-section">
                <h3 class="section-heading">Visual Theme</h3>
                <div class="theme-grid">
                  {/* Carbon Dark */}
                  <div
                    class={`theme-card ${currentTheme() === 'carbon-dark' ? 'selected' : ''}`}
                    onClick={() => setTheme('carbon-dark')}
                  >
                    <div class="theme-card-preview carbon-preview">
                      <div class="swatch-bar">
                        <span class="swatch-dot bg-dark-1" />
                        <span class="swatch-dot bg-dark-2" />
                        <span class="swatch-dot bg-cyan" />
                        <span class="swatch-dot bg-emerald" />
                      </div>
                      <div class="preview-mini-table">
                        <div class="preview-row dark">
                          <span class="text-glow-cyan">0xAA55</span>
                          <span class="pill-rx">RX</span>
                          <span class="text-white">115200</span>
                        </div>
                      </div>
                    </div>
                    <div class="theme-card-info">
                      <span class="theme-name">Carbon Dark</span>
                      <span class="theme-desc">Default low-light phosphor instrumentation.</span>
                    </div>
                  </div>

                  {/* Paper Light */}
                  <div
                    class={`theme-card ${currentTheme() === 'paper-light' ? 'selected' : ''}`}
                    onClick={() => setTheme('paper-light')}
                  >
                    <div class="theme-card-preview paper-preview">
                      <div class="swatch-bar">
                        <span class="swatch-dot bg-light-1" />
                        <span class="swatch-dot bg-light-2" />
                        <span class="swatch-dot bg-blue" />
                        <span class="swatch-dot bg-green" />
                      </div>
                      <div class="preview-mini-table">
                        <div class="preview-row light">
                          <span class="text-blue">0xAA55</span>
                          <span class="pill-rx-light">RX</span>
                          <span class="text-dark">115200</span>
                        </div>
                      </div>
                    </div>
                    <div class="theme-card-info">
                      <span class="theme-name">Paper Light</span>
                      <span class="theme-desc">High-illumination lab paper bench setting.</span>
                    </div>
                  </div>

                  {/* High Contrast */}
                  <div
                    class={`theme-card ${currentTheme() === 'high-contrast' ? 'selected' : ''}`}
                    onClick={() => setTheme('high-contrast')}
                  >
                    <div class="theme-card-preview hc-preview">
                      <div class="swatch-bar">
                        <span class="swatch-dot bg-black" />
                        <span class="swatch-dot bg-yellow" />
                        <span class="swatch-dot bg-pure-cyan" />
                        <span class="swatch-dot bg-pure-green" />
                      </div>
                      <div class="preview-mini-table">
                        <div class="preview-row hc">
                          <span class="text-pure-yellow">0xAA55</span>
                          <span class="pill-hc-green">RX</span>
                          <span class="text-pure-cyan">115200</span>
                        </div>
                      </div>
                    </div>
                    <div class="theme-card-info">
                      <span class="theme-name">High Contrast</span>
                      <span class="theme-desc">WCAG AAA compliant pure yellow on obsidian.</span>
                    </div>
                  </div>
                </div>

                {/* Density Tier */}
                <h3 class="section-heading mt-6">Row Density Tier</h3>
                <div class="density-grid">
                  <div
                    class={`density-card ${currentDensity() === 'compact' ? 'selected' : ''}`}
                    onClick={() => setDensity('compact')}
                  >
                    <div class="density-title">Compact</div>
                    <div class="density-badge">22 px / 11 px font</div>
                    <div class="density-desc">Maximum packets visible on dense serial streams.</div>
                  </div>
                  <div
                    class={`density-card ${currentDensity() === 'default' ? 'selected' : ''}`}
                    onClick={() => setDensity('default')}
                  >
                    <div class="density-title">Default</div>
                    <div class="density-badge">26 px / 12 px font</div>
                    <div class="density-desc">Standard balanced desktop workstation density.</div>
                  </div>
                  <div
                    class={`density-card ${currentDensity() === 'spacious' ? 'selected' : ''}`}
                    onClick={() => setDensity('spacious')}
                  >
                    <div class="density-title">Spacious</div>
                    <div class="density-badge">32 px / 13 px font</div>
                    <div class="density-desc">High-DPI monitors, presentations, and touch screens.</div>
                  </div>
                </div>

                {/* Typography Scale */}
                <h3 class="section-heading mt-6">Interface Typography Scale</h3>
                <div class="control-row">
                  <span class="control-label">Base Font Size ({currentFontSize()} px)</span>
                  <div class="slider-wrapper">
                    <span class="slider-val">11px</span>
                    <input
                      type="range"
                      min="11"
                      max="16"
                      step="1"
                      value={currentFontSize()}
                      onInput={(e) => setFontSize(Number(e.currentTarget.value))}
                      class="settings-slider"
                    />
                    <span class="slider-val">16px</span>
                  </div>
                </div>
                <div class="font-preview-box">
                  <span class="font-preview-tag">Preview:</span>
                  <code>000142.8592s  [UART0]  RX  03 AA 55 10 B9  decode: ok  crc: valid</code>
                </div>

                {/* Accent Color */}
                <h3 class="section-heading mt-6">Signal Highlight Accent</h3>
                <div class="accent-picker">
                  <button
                    class={`accent-dot accent-cyan ${currentAccent() === 'cyan' ? 'selected' : ''}`}
                    onClick={() => setAccent('cyan')}
                    title="Cyan Phosphor"
                  />
                  <button
                    class={`accent-dot accent-green ${currentAccent() === 'green' ? 'selected' : ''}`}
                    onClick={() => setAccent('green')}
                    title="Emerald RX"
                  />
                  <button
                    class={`accent-dot accent-amber ${currentAccent() === 'amber' ? 'selected' : ''}`}
                    onClick={() => setAccent('amber')}
                    title="Amber Yield"
                  />
                  <button
                    class={`accent-dot accent-purple ${currentAccent() === 'purple' ? 'selected' : ''}`}
                    onClick={() => setAccent('purple')}
                    title="Violet DWARF"
                  />
                  <span class="accent-current-label">Active: {currentAccent()}</span>
                </div>
              </div>
            </Show>

            {/* 2. Stream Columns Tab */}
            <Show when={activeTab() === 'columns'}>
              <div class="settings-section">
                <div class="section-head-bar">
                  <div>
                    <h3 class="section-heading">Stream Table Columns</h3>
                    <p class="section-subtext">Toggle visibility, adjust cell width, or reorder column layout.</p>
                  </div>
                  <button class="settings-btn-secondary" onClick={() => resetColumns()}>
                    Reset Columns
                  </button>
                </div>

                <div class="columns-table-wrap">
                  <table class="columns-table">
                    <thead>
                      <tr>
                        <th style={{ width: '40px' }}>Vis</th>
                        <th style={{ width: '120px' }}>Column</th>
                        <th style={{ width: '70px' }}>ID</th>
                        <th>Description</th>
                        <th style={{ width: '140px' }}>Width (px)</th>
                        <th style={{ width: '70px', 'text-align': 'center' }}>Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={allColumns()}>
                        {(col, idx) => (
                          <tr class={col.visible ? 'col-row-visible' : 'col-row-hidden'}>
                            <td>
                              <input
                                type="checkbox"
                                checked={col.visible}
                                disabled={col.fixed}
                                onChange={() => toggleColumnVisibility(col.id)}
                                class="settings-checkbox"
                              />
                            </td>
                            <td class="col-name-cell">
                              <span class="col-label">{col.label}</span>
                              <Show when={col.fixed}>
                                <span class="fixed-badge">Fixed</span>
                              </Show>
                            </td>
                            <td>
                              <code class="col-id-code">{col.id}</code>
                            </td>
                            <td class="col-desc-cell">{col.description}</td>
                            <td>
                              <div class="width-control">
                                <button
                                  class="step-btn"
                                  onClick={() => resizeColumn(col.id, col.width - 10)}
                                  title="Decrease width by 10px"
                                >
                                  -
                                </button>
                                <span class="width-readout">{col.width} px</span>
                                <button
                                  class="step-btn"
                                  onClick={() => resizeColumn(col.id, col.width + 10)}
                                  title="Increase width by 10px"
                                >
                                  +
                                </button>
                              </div>
                            </td>
                            <td>
                              <div class="order-btn-group">
                                <button
                                  class="order-btn"
                                  disabled={idx() <= 1}
                                  onClick={() => moveColumnUp(col.id)}
                                  title="Move Up"
                                >
                                  ▲
                                </button>
                                <button
                                  class="order-btn"
                                  disabled={idx() >= allColumns().length - 1}
                                  onClick={() => moveColumnDown(col.id)}
                                  title="Move Down"
                                >
                                  ▼
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </div>
            </Show>

            {/* 3. Shortcuts Tab */}
            <Show when={activeTab() === 'shortcuts'}>
              <div class="settings-section">
                <div class="section-head-bar">
                  <div>
                    <h3 class="section-heading">Keyboard Shortcuts Registry</h3>
                    <p class="section-subtext">Click "Rebind" on any shortcut, then press your preferred key combination.</p>
                  </div>
                  <button class="settings-btn-secondary" onClick={() => resetKeybindings()}>
                    Reset Shortcuts
                  </button>
                </div>

                <div class="shortcuts-list">
                  <For each={commandCategories}>
                    {(cat) => {
                      const cmds = COMMAND_DEFINITIONS.filter((c) => c.category === cat)
                      if (cmds.length === 0) return null
                      return (
                        <div class="shortcut-category-group">
                          <h4 class="category-header">{cat}</h4>
                          <div class="shortcuts-grid">
                            <For each={cmds}>
                              {(cmd: CommandDef) => {
                                const isRebinding = () => rebindingId() === cmd.id
                                const currentKey = () => getKeybinding(cmd.id)

                                return (
                                  <div class="shortcut-row">
                                    <div class="shortcut-info">
                                      <span class="shortcut-label">{cmd.label}</span>
                                      <span class="shortcut-desc">{cmd.description}</span>
                                    </div>
                                    <div class="shortcut-action">
                                      <Show
                                        when={!isRebinding()}
                                        fallback={
                                          <div class="rebinding-pill">
                                            <span class="pulsing-dot" />
                                            <span>Press key combo...</span>
                                            <button
                                              class="cancel-rebind-btn"
                                              onClick={() => setRebindingId(null)}
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        }
                                      >
                                        <kbd class="shortcut-kbd">{currentKey()}</kbd>
                                        <button
                                          class="rebind-btn"
                                          onClick={() => setRebindingId(cmd.id)}
                                        >
                                          Rebind
                                        </button>
                                      </Show>
                                    </div>
                                  </div>
                                )
                              }}
                            </For>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* 4. Presets & Backup Tab */}
            <Show when={activeTab() === 'backup'}>
              <div class="settings-section">
                <h3 class="section-heading">Workbench Layout Presets</h3>
                <div class="preset-cards-grid">
                  <div class="preset-card">
                    <div class="preset-card-top">
                      <span class="preset-name">Bringup Workbench</span>
                      <kbd class="preset-kbd">Alt+1</kbd>
                    </div>
                    <div class="preset-desc">Standard split: Hardware bay, stream viewport, hex inspector.</div>
                  </div>
                  <div class="preset-card">
                    <div class="preset-card-top">
                      <span class="preset-name">Protocol Debug</span>
                      <kbd class="preset-kbd">Alt+2</kbd>
                    </div>
                    <div class="preset-desc">Maximized stream table with full column width and live hex dump.</div>
                  </div>
                  <div class="preset-card">
                    <div class="preset-card-top">
                      <span class="preset-name">Signal Telemetry</span>
                      <kbd class="preset-kbd">Alt+3</kbd>
                    </div>
                    <div class="preset-desc">Multi-channel oscilloscope and logic timeline traces.</div>
                  </div>
                  <div class="preset-card">
                    <div class="preset-card-top">
                      <span class="preset-name">Hardware Logic</span>
                      <kbd class="preset-kbd">Alt+4</kbd>
                    </div>
                    <div class="preset-desc">Dedicated pin step sequencer and hardware fault injector.</div>
                  </div>
                </div>

                <h3 class="section-heading mt-6">Settings Import & Export</h3>
                <p class="section-subtext">Save complete workbench configuration or transfer it between machines.</p>

                <div class="backup-actions-row">
                  <button class="settings-btn-primary" onClick={handleExport}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Export JSON Settings
                  </button>

                  <input
                    type="file"
                    accept=".json"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    onChange={handleFileImport}
                  />
                  <button
                    class="settings-btn-secondary"
                    onClick={() => fileInputRef?.click()}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Import JSON File
                  </button>

                  <button
                    class="settings-btn-secondary"
                    onClick={() => setShowJsonPaste((p) => !p)}
                  >
                    Paste JSON Text
                  </button>
                </div>

                <Show when={showJsonPaste()}>
                  <div class="json-paste-box">
                    <textarea
                      class="json-paste-input"
                      placeholder="Paste BaudForge settings JSON here..."
                      value={pasteText()}
                      onInput={(e) => setPasteText(e.currentTarget.value)}
                      rows={5}
                    />
                    <div class="json-paste-footer">
                      <button class="settings-btn-primary" onClick={handlePasteImport}>
                        Apply JSON Settings
                      </button>
                      <button class="settings-btn-secondary" onClick={() => setShowJsonPaste(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>

                <div class="danger-zone mt-8">
                  <div class="danger-info">
                    <span class="danger-title">Factory Reset</span>
                    <span class="danger-desc">Restore all appearance, density, column, and shortcut settings to default.</span>
                  </div>
                  <button class="settings-btn-danger" onClick={handleResetAll}>
                    Reset All Defaults
                  </button>
                </div>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="settings-footer">
            <span class="footer-build">BaudForge v0.8.0 • Precision Engineering System</span>
            <button class="settings-btn-secondary" onClick={props.onClose}>
              Done
            </button>
          </div>
        </div>

        {/* Local Encapsulated Industrial Styling */}
        <style>{`
          .settings-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(3px);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            font-family: var(--font-sans);
          }
          .settings-dialog {
            width: 100%;
            max-width: 720px;
            max-height: 85vh;
            background: var(--bg-surface-1, #101217);
            border: 1px solid var(--border-strong, #2d3446);
            border-radius: 8px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--border-highlight, rgba(255, 255, 255, 0.06));
            display: flex;
            flex-direction: column;
            overflow: hidden;
            animation: settingsIn 120ms cubic-bezier(0.23, 1, 0.32, 1);
          }
          @keyframes settingsIn {
            from { opacity: 0; transform: scale(0.98) translateY(6px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
          }
          .settings-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 18px;
            background: var(--bg-surface-2, #161920);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .settings-header-left {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .settings-icon {
            color: var(--sig-tx, #06b6d4);
          }
          .settings-title {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
            letter-spacing: -0.01em;
            color: var(--text-primary, #edf0f7);
          }
          .settings-header-right {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .settings-status-pill {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 4px;
            font-family: var(--font-mono);
          }
          .settings-status-pill.ok {
            background: rgba(16, 185, 129, 0.15);
            color: var(--sig-rx, #10b981);
            border: 1px solid rgba(16, 185, 129, 0.3);
          }
          .settings-status-pill.error {
            background: rgba(244, 63, 94, 0.15);
            color: var(--sig-fault, #f43f5e);
            border: 1px solid rgba(244, 63, 94, 0.3);
          }
          .settings-esc-badge {
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
          .settings-esc-badge:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
          }
          .settings-tab-bar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 14px;
            background: var(--bg-surface-2, #161920);
            border-bottom: 1px solid var(--border-hairline, #1f2430);
          }
          .settings-tab-btn {
            background: transparent;
            border: 0;
            border-bottom: 2px solid transparent;
            padding: 8px 12px;
            color: var(--text-secondary, #949eb2);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .settings-tab-btn:hover {
            color: var(--text-primary, #edf0f7);
          }
          .settings-tab-btn.active {
            color: var(--sig-tx, #06b6d4);
            border-bottom-color: var(--sig-tx, #06b6d4);
          }
          .settings-body {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
            max-height: 580px;
          }
          .section-heading {
            margin: 0 0 10px 0;
            font-size: 12.5px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-secondary, #949eb2);
          }
          .section-subtext {
            margin: 0 0 12px 0;
            font-size: 11.5px;
            color: var(--text-muted, #5e677a);
          }
          .section-head-bar {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
          }
          .mt-6 { margin-top: 18px; }
          .mt-8 { margin-top: 24px; }
          .theme-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
          }
          .theme-card {
            border: 1px solid var(--border-hairline, #1f2430);
            background: var(--bg-surface-2, #161920);
            border-radius: 6px;
            cursor: pointer;
            overflow: hidden;
            transition: border-color 140ms ease, box-shadow 140ms ease;
          }
          .theme-card:hover {
            border-color: var(--border-strong, #2d3446);
          }
          .theme-card.selected {
            border-color: var(--sig-tx, #06b6d4);
            box-shadow: 0 0 0 1px var(--sig-tx, #06b6d4);
          }
          .theme-card-preview {
            height: 68px;
            padding: 8px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          .carbon-preview { background: #090a0d; }
          .paper-preview { background: #f4f5f7; }
          .hc-preview { background: #000000; }
          .swatch-bar {
            display: flex;
            gap: 5px;
          }
          .swatch-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
          }
          .bg-dark-1 { background: #101217; border: 1px solid #2d3446; }
          .bg-dark-2 { background: #161920; }
          .bg-cyan { background: #06b6d4; }
          .bg-emerald { background: #10b981; }
          .bg-light-1 { background: #ffffff; border: 1px solid #d0d5dd; }
          .bg-light-2 { background: #ebedf0; }
          .bg-blue { background: #0284c7; }
          .bg-green { background: #059669; }
          .bg-black { background: #121212; border: 1px solid #ffffff; }
          .bg-yellow { background: #ffff00; }
          .bg-pure-cyan { background: #00ffff; }
          .bg-pure-green { background: #00ff00; }
          .preview-mini-table {
            font-family: var(--font-mono);
            font-size: 10px;
          }
          .preview-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 2px 4px;
            border-radius: 3px;
          }
          .preview-row.dark { background: #161920; }
          .preview-row.light { background: #ffffff; border: 1px solid #d0d5dd; }
          .preview-row.hc { background: #121212; border: 1px solid #ffffff; }
          .text-glow-cyan { color: #06b6d4; }
          .text-blue { color: #0284c7; }
          .text-pure-yellow { color: #ffff00; }
          .text-pure-cyan { color: #00ffff; }
          .text-white { color: #edf0f7; }
          .text-dark { color: #0f172a; }
          .pill-rx {
            font-size: 8px;
            padding: 1px 3px;
            border-radius: 2px;
            background: rgba(16, 185, 129, 0.2);
            color: #10b981;
          }
          .pill-rx-light {
            font-size: 8px;
            padding: 1px 3px;
            border-radius: 2px;
            background: rgba(5, 150, 105, 0.15);
            color: #059669;
          }
          .pill-hc-green {
            font-size: 8px;
            padding: 1px 3px;
            border-radius: 2px;
            background: #00ff00;
            color: #000000;
            font-weight: 700;
          }
          .theme-card-info {
            padding: 8px 10px;
            border-top: 1px solid var(--border-hairline, #1f2430);
          }
          .theme-name {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary);
          }
          .theme-desc {
            display: block;
            font-size: 10.5px;
            color: var(--text-muted);
            margin-top: 2px;
            line-height: 1.3;
          }
          .density-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
          }
          .density-card {
            border: 1px solid var(--border-hairline, #1f2430);
            background: var(--bg-surface-2, #161920);
            border-radius: 6px;
            padding: 10px 12px;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .density-card:hover {
            border-color: var(--border-strong, #2d3446);
          }
          .density-card.selected {
            border-color: var(--sig-tx, #06b6d4);
            box-shadow: 0 0 0 1px var(--sig-tx, #06b6d4);
          }
          .density-title {
            font-size: 12.5px;
            font-weight: 600;
            color: var(--text-primary);
          }
          .density-badge {
            font-family: var(--font-mono);
            font-size: 10px;
            color: var(--sig-tx);
            margin: 2px 0 4px 0;
          }
          .density-desc {
            font-size: 11px;
            color: var(--text-muted);
            line-height: 1.35;
          }
          .control-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 10px 14px;
            background: var(--bg-surface-2);
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
          }
          .control-label {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary);
          }
          .slider-wrapper {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            max-width: 280px;
          }
          .slider-val {
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--text-muted);
          }
          .settings-slider {
            flex: 1;
            accent-color: var(--sig-tx, #06b6d4);
            cursor: pointer;
          }
          .font-preview-box {
            margin-top: 8px;
            padding: 8px 12px;
            background: var(--bg-surface-3, #1e222b);
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
            font-family: var(--font-mono);
            font-size: var(--font-ui-size, 12px);
            color: var(--text-secondary);
            display: flex;
            gap: 8px;
            align-items: center;
          }
          .font-preview-tag {
            color: var(--text-muted);
            font-size: 10px;
            text-transform: uppercase;
          }
          .accent-picker {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 14px;
            background: var(--bg-surface-2);
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
          }
          .accent-dot {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid transparent;
            cursor: pointer;
            transition: transform 120ms ease;
          }
          .accent-dot:hover {
            transform: scale(1.1);
          }
          .accent-dot.selected {
            border-color: #ffffff;
            box-shadow: 0 0 8px currentColor;
          }
          .accent-cyan { background: #06b6d4; color: #06b6d4; }
          .accent-green { background: #10b981; color: #10b981; }
          .accent-amber { background: #f59e0b; color: #f59e0b; }
          .accent-purple { background: #a855f7; color: #a855f7; }
          .accent-current-label {
            margin-left: auto;
            font-size: 11px;
            color: var(--text-muted);
            text-transform: capitalize;
            font-family: var(--font-mono);
          }
          .columns-table-wrap {
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
            overflow: hidden;
            background: var(--bg-surface-2);
          }
          .columns-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
          }
          .columns-table th {
            text-align: left;
            padding: 8px 10px;
            background: var(--bg-surface-3);
            border-bottom: 1px solid var(--border-hairline);
            color: var(--text-muted);
            font-weight: 500;
            font-size: 11px;
          }
          .columns-table td {
            padding: 7px 10px;
            border-bottom: 1px solid var(--border-hairline);
            color: var(--text-secondary);
            vertical-align: middle;
          }
          .col-row-hidden {
            opacity: 0.55;
          }
          .settings-checkbox {
            cursor: pointer;
            accent-color: var(--sig-tx, #06b6d4);
          }
          .col-name-cell {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .col-label {
            font-weight: 600;
            color: var(--text-primary);
          }
          .fixed-badge {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-muted);
            text-transform: uppercase;
          }
          .col-id-code {
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--sig-tx);
          }
          .col-desc-cell {
            font-size: 11px;
            color: var(--text-muted);
          }
          .width-control {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .step-btn {
            width: 20px;
            height: 20px;
            border: 1px solid var(--border-hairline);
            background: var(--bg-surface-3);
            color: var(--text-primary);
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
          }
          .step-btn:hover {
            border-color: var(--border-strong);
            background: var(--bg-surface-1);
          }
          .width-readout {
            font-family: var(--font-mono);
            font-size: 11px;
            width: 52px;
            text-align: center;
          }
          .order-btn-group {
            display: flex;
            align-items: center;
            gap: 3px;
            justify-content: center;
          }
          .order-btn {
            border: 1px solid var(--border-hairline);
            background: var(--bg-surface-3);
            color: var(--text-secondary);
            width: 22px;
            height: 20px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 9px;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .order-btn:hover:not(:disabled) {
            color: var(--text-primary);
            border-color: var(--border-strong);
          }
          .order-btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
          }
          .shortcuts-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .shortcut-category-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .category-header {
            margin: 0;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--sig-tx, #06b6d4);
            font-family: var(--font-mono);
          }
          .shortcuts-grid {
            display: flex;
            flex-direction: column;
            gap: 4px;
            background: var(--bg-surface-2);
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
            overflow: hidden;
          }
          .shortcut-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-hairline);
          }
          .shortcut-row:last-child {
            border-bottom: 0;
          }
          .shortcut-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .shortcut-label {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary);
          }
          .shortcut-desc {
            font-size: 10.5px;
            color: var(--text-muted);
          }
          .shortcut-action {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .shortcut-kbd {
            font-family: var(--font-mono);
            font-size: 11px;
            padding: 3px 7px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid var(--border-strong, #2d3446);
            color: var(--text-primary);
            min-width: 60px;
            text-align: center;
          }
          .rebind-btn {
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 4px;
            border: 1px solid var(--border-hairline);
            background: var(--bg-surface-3);
            color: var(--text-secondary);
            cursor: pointer;
          }
          .rebind-btn:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
          }
          .rebinding-pill {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 3px 8px;
            border-radius: 4px;
            background: rgba(6, 182, 212, 0.15);
            border: 1px solid var(--sig-tx);
            color: var(--sig-tx);
            font-size: 11px;
            font-family: var(--font-mono);
          }
          .pulsing-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--sig-tx);
            animation: pulse 1s infinite alternate;
          }
          @keyframes pulse {
            from { opacity: 0.3; }
            to { opacity: 1; }
          }
          .cancel-rebind-btn {
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
          }
          .cancel-rebind-btn:hover {
            color: var(--text-primary);
          }
          .preset-cards-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
          }
          .preset-card {
            padding: 10px 12px;
            background: var(--bg-surface-2);
            border: 1px solid var(--border-hairline);
            border-radius: 6px;
          }
          .preset-card-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
          }
          .preset-name {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-primary);
          }
          .preset-kbd {
            font-family: var(--font-mono);
            font-size: 10px;
            padding: 1px 5px;
            border-radius: 3px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-hairline);
            color: var(--sig-tx);
          }
          .preset-desc {
            font-size: 11px;
            color: var(--text-muted);
            line-height: 1.35;
          }
          .backup-actions-row {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
          }
          .settings-btn-primary {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 5px;
            background: var(--sig-tx, #06b6d4);
            color: #090a0d;
            font-size: 12px;
            font-weight: 600;
            border: 0;
            cursor: pointer;
            transition: opacity 120ms ease;
          }
          .settings-btn-primary:hover {
            opacity: 0.92;
          }
          .settings-btn-secondary {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 5px;
            background: var(--bg-surface-3, #1e222b);
            border: 1px solid var(--border-hairline, #1f2430);
            color: var(--text-primary, #edf0f7);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .settings-btn-secondary:hover {
            border-color: var(--border-strong);
            background: var(--bg-surface-2);
          }
          .settings-btn-danger {
            padding: 6px 12px;
            border-radius: 5px;
            background: rgba(244, 63, 94, 0.15);
            border: 1px solid var(--sig-fault, #f43f5e);
            color: var(--sig-fault, #f43f5e);
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 120ms ease;
          }
          .settings-btn-danger:hover {
            background: var(--sig-fault, #f43f5e);
            color: #ffffff;
          }
          .json-paste-box {
            margin-top: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .json-paste-input {
            width: 100%;
            background: var(--bg-surface-3);
            border: 1px solid var(--border-hairline);
            border-radius: 5px;
            padding: 8px 10px;
            color: var(--text-primary);
            font-family: var(--font-mono);
            font-size: 11px;
            resize: vertical;
          }
          .json-paste-footer {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .danger-zone {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 14px;
            border: 1px solid rgba(244, 63, 94, 0.3);
            border-radius: 6px;
            background: rgba(244, 63, 94, 0.05);
          }
          .danger-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .danger-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--sig-fault);
          }
          .danger-desc {
            font-size: 11px;
            color: var(--text-muted);
          }
          .settings-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 18px;
            background: var(--bg-surface-2, #161920);
            border-top: 1px solid var(--border-hairline, #1f2430);
          }
          .footer-build {
            font-size: 11px;
            color: var(--text-muted, #5e677a);
          }
        `}</style>
      </div>
    </Show>
  )
}
