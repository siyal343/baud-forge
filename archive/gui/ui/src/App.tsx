import { Show, createSignal, createMemo, onMount, onCleanup } from 'solid-js'
import { WindowControls } from './components/WindowControls'
import { CommandPalette } from './components/CommandPalette'
import type { CommandAction } from './components/CommandPalette'
import { SettingsModal } from './components/SettingsModal'
import { NewWorkspaceModal } from './components/NewWorkspaceModal'
import { HelpModal } from './components/HelpModal'
import { DockContainer } from './components/dock/DockContainer'
import { BUILTIN_PANELS, getDefaultLayout, normalizePresetName } from './lib/dock/presets'
import type { DockNode } from './lib/dock/types'
import { loadSettings, saveSettings } from './lib/settings'
import { initCommandRouter, registerCommandHandler } from './lib/commands'
import { createWorkbenchStore } from './lib/store'
import {
  HardwareBayPanel,
  StreamPanel,
  InspectorPanel,
  TelemetryPanel,
  ConsolePanel,
  DashboardPanel,
  SessionDiffPanel,
} from './components/panels'
import './index.css'

const bytes = (value: number) =>
  value < 1000 ? `${value} B` : value < 1e6 ? `${(value / 1e3).toFixed(1)} kB` : `${(value / 1e6).toFixed(1)} MB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clock = (us: number) => `${(us / 1e6).toFixed(4)} s`

export default function App() {
  const store = createWorkbenchStore()

  // Layout Management
  const initialSettings = loadSettings()
  const urlParams = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const urlPreset = urlParams.get('preset')
  const initialPreset = urlPreset ? normalizePresetName(urlPreset) : (initialSettings.activePreset || 'Bring-up')
  const initialTree =
    !urlPreset && initialPreset === 'Custom' && initialSettings.customPresets?.Custom
      ? (initialSettings.customPresets.Custom as DockNode)
      : getDefaultLayout(initialPreset)

  const [dockLayout, setDockLayout] = createSignal<DockNode>(initialTree)
  const [activePreset, setActivePreset] = createSignal<string>(initialPreset)
  const [showHelp, setShowHelp] = createSignal(false)

  function applyPreset(name: string) {
    const nextTree = getDefaultLayout(name)
    setDockLayout(nextTree)
    setActivePreset(name)
    const s = loadSettings()
    s.activePreset = name
    saveSettings(s)
  }

  function handleTreeChange(newTree: DockNode) {
    setDockLayout(newTree)
    setActivePreset('Custom')
    const s = loadSettings()
    s.activePreset = 'Custom'
    s.customPresets = { ...(s.customPresets || {}), Custom: newTree }
    saveSettings(s)
  }

  function handlePopout(panelId: string) {
    const url = `?popout=${encodeURIComponent(panelId)}`
    window.open(url, `bforge-${panelId}`, 'width=960,height=640,menubar=no,toolbar=no')
  }

  // Panel Dispatcher
  function renderPanel(panelId: string) {
    switch (panelId) {
      case 'hardware':
        return <HardwareBayPanel store={store} />
      case 'stream':
        return <StreamPanel store={store} />
      case 'inspector':
        return <InspectorPanel store={store} />
      case 'telemetry':
        return <TelemetryPanel store={store} />
      case 'console':
        return <ConsolePanel store={store} />
      case 'dashboard':
        return <DashboardPanel store={store} />
      case 'diff':
        return <SessionDiffPanel store={store} />
      default:
        return <div class="empty hint" style={{ padding: '24px' }}>Unknown panel: {panelId}</div>
    }
  }

  // Popout Standalone View
  const popoutTarget = urlParams.get('popout')
  if (popoutTarget) {
    return (
      <div class="popout-standalone">
        <header class="popout-header" data-tauri-drag-region>
          <div class="popout-title">
            <span class="status-led live" />
            <span>{BUILTIN_PANELS[popoutTarget]?.title ?? popoutTarget} — BaudForge</span>
          </div>
          <WindowControls />
        </header>
        <div class="popout-body">
          {renderPanel(popoutTarget)}
        </div>
      </div>
    )
  }

  // Command Registry & Hotkeys
  onMount(() => {
    const cleanupRouter = initCommandRouter()
    const cleanups = [
      cleanupRouter,
      registerCommandHandler('palette.open', () => store.setPaletteOpen(true)),
      registerCommandHandler('settings.open', () => store.setSettingsOpen(true)),
      registerCommandHandler('workspace.new', () => store.setShowNewWorkspaceModal(true)),
      registerCommandHandler('workspace.save', () => void store.saveWorkspace()),
      registerCommandHandler('dvr.toggle_play', () => store.togglePlay()),
      registerCommandHandler('dvr.snap_live', () => store.snapLive()),
      registerCommandHandler('diff.toggle', () => store.setShowDiff(!store.showDiff())),
      registerCommandHandler('preset.bringup', () => applyPreset('Bring-up')),
      registerCommandHandler('preset.debug', () => applyPreset('Protocol Debug')),
      registerCommandHandler('preset.telemetry', () => applyPreset('Telemetry & Oscilloscope')),
      registerCommandHandler('preset.dashboards', () => applyPreset('Dashboards')),
      registerCommandHandler('preset.hil', () => applyPreset('HIL & Fault Rig')),
      registerCommandHandler('preset.diff', () => applyPreset('Session Diff')),
      registerCommandHandler('help.open', () => setShowHelp(true)),
    ]

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void store.saveWorkspace()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        store.setShowNewWorkspaceModal(true)
        return
      }
      if (((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) || e.key === 'F1') {
        e.preventDefault()
        setShowHelp((prev) => !prev)
        return
      }
      if ((e.ctrlKey || e.metaKey || e.altKey) && !isInput) {
        const presets = [
          'Bring-up',
          'Protocol Debug',
          'Telemetry & Oscilloscope',
          'Dashboards',
          'HIL & Fault Rig',
          'Session Diff',
        ]
        const num = parseInt(e.key, 10)
        if (num >= 1 && num <= 6) {
          e.preventDefault()
          applyPreset(presets[num - 1])
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown))

    onCleanup(() => {
      cleanups.forEach((fn) => fn())
    })
  })

  // Command Palette Actions
  const paletteActions = createMemo<CommandAction[]>(() => [
    {
      id: 'open-help',
      label: 'Open Workbench Guide & Quick Reference',
      category: 'General',
      shortcut: 'Ctrl+H / F1',
      run: () => setShowHelp(true),
    },
    {
      id: 'new-workspace',
      label: 'Create New Workspace (Visual Wizard)',
      category: 'General',
      shortcut: 'Ctrl+N',
      run: () => store.setShowNewWorkspaceModal(true),
    },
    {
      id: 'open-settings',
      label: 'Open Workbench Settings & Appearance',
      category: 'General',
      shortcut: 'Ctrl+,',
      run: () => store.setSettingsOpen(true),
    },
    {
      id: 'save-workspace',
      label: 'Save Workspace Configuration (.bforge.toml)',
      category: 'General',
      shortcut: 'Ctrl+S',
      run: () => void store.saveWorkspace(),
    },
    {
      id: 'preset-bringup',
      label: 'Layout Preset: Hardware Bring-up',
      category: 'Layout',
      shortcut: 'Ctrl+1',
      run: () => applyPreset('Bring-up'),
    },
    {
      id: 'preset-debug',
      label: 'Layout Preset: Protocol Debug',
      category: 'Layout',
      shortcut: 'Ctrl+2',
      run: () => applyPreset('Protocol Debug'),
    },
    {
      id: 'preset-telemetry',
      label: 'Layout Preset: Telemetry & Oscilloscope',
      category: 'Layout',
      shortcut: 'Ctrl+3',
      run: () => applyPreset('Telemetry & Oscilloscope'),
    },
    {
      id: 'preset-dashboards',
      label: 'Layout Preset: Interactive Dashboards',
      category: 'Layout',
      shortcut: 'Ctrl+4',
      run: () => applyPreset('Dashboards'),
    },
    {
      id: 'preset-hil',
      label: 'Layout Preset: HIL & Fault Rig',
      category: 'Layout',
      shortcut: 'Ctrl+5',
      run: () => applyPreset('HIL & Fault Rig'),
    },
    {
      id: 'preset-diff',
      label: 'Layout Preset: Session Diff',
      category: 'Layout',
      shortcut: 'Ctrl+6',
      run: () => applyPreset('Session Diff'),
    },
    {
      id: 'preset-minimal',
      label: 'Layout Preset: Minimal Stream',
      category: 'Layout',
      shortcut: 'Alt+M',
      run: () => applyPreset('Minimal Stream'),
    },
    {
      id: 'dvr-play-pause',
      label: store.playing() ? 'DVR: Pause Playback' : 'DVR: Start Playback',
      category: 'DVR',
      shortcut: 'Space',
      run: () => store.togglePlay(),
    },
    {
      id: 'dvr-snap-live',
      label: 'DVR: Snap to Live Edge',
      category: 'DVR',
      shortcut: 'End',
      run: () => store.snapLive(),
    },
    {
      id: 'toggle-diff',
      label: 'Toggle Session Diff Panel',
      category: 'Panels',
      shortcut: 'Ctrl+Shift+D',
      run: () => store.setShowDiff(!store.showDiff()),
    },
    {
      id: 'yield-port',
      label: 'Yield Active Port (30s Release)',
      category: 'Hardware',
      run: () => {
        const p = store.ports().find((c) => c.state === 'open') || store.ports()[0]
        if (p) void store.yieldPort(p)
      },
    },
    {
      id: 'disarm-faults',
      label: 'Disarm All Fault Injections',
      category: 'Faults',
      run: () => void store.disarmFault(),
    },
    {
      id: 'export-csv',
      label: 'Export Recording as CSV',
      category: 'Export',
      run: () => void store.saveExport('csv'),
    },
    {
      id: 'export-jsonl',
      label: 'Export Recording as JSON Lines',
      category: 'Export',
      run: () => void store.saveExport('jsonl'),
    },
    {
      id: 'export-saleae',
      label: 'Export Recording as Saleae CSV',
      category: 'Export',
      run: () => void store.saveExport('saleae'),
    },
    {
      id: 'export-pcapng',
      label: 'Export Recording as PCAPNG',
      category: 'Export',
      run: () => void store.saveExport('pcapng'),
    },
  ])

  return (
    <div class="shell workbench-reconfigurable-shell">
      {/* Zone 1 — Precision Instrument Topbar */}
      <header class="ribbon topbar" data-zone="ribbon" tabindex="-1" data-tauri-drag-region>
        <div class="topbar-left">
          <div class="brand">
            <span
              class="status-led"
              classList={{
                live: store.feed.link() === 'live' && store.at() === null,
                warn: store.at() !== null || store.feed.link() === 'connecting',
                fault: store.feed.link() === 'down',
              }}
            />
            <h1>BaudForge</h1>
          </div>
          <span class={`chip ${store.feed.link()}`}>{store.feed.link()}</span>
          <span class="chip">{store.session()?.mode ?? 'idle'}</span>
          <span class="chip">ports {store.openPorts()}/{store.ports().length}</span>
          <Show when={store.faultKind() !== 'off'}>
            <span class="chip down">⚡ fault: {store.faultKind()}</span>
          </Show>

          {/* Active Hardware Indicator */}
          <Show
            when={store.ports().find((p) => p.state === 'open') || store.ports()[0]}
            fallback={<span class="chip hardware-indicator idle"><span class="status-led micro-led idle" />[No Ports]</span>}
          >
            {(activePort) => (
              <span
                class="chip hardware-indicator"
                classList={{
                  live: activePort().state === 'open',
                  warn: activePort().state === 'reconnecting' || activePort().state === 'yielded',
                  closed: activePort().state === 'closed',
                }}
                title={`Active port: ${activePort().id} (${activePort().device || 'unspecified'}) - ${activePort().state}`}
              >
                <span
                  class="status-led micro-led"
                  classList={{
                    live: activePort().state === 'open',
                    warn: activePort().state === 'reconnecting' || activePort().state === 'yielded',
                    idle: activePort().state === 'closed',
                  }}
                />
                [{activePort().device || activePort().id} @ {activePort().baud_rate || 115200} 8N1 · {activePort().framing}]
              </span>
            )}
          </Show>

          {/* Preset Selector Dropdown */}
          <div class="preset-dropdown-wrap">
            <select
              class="chip action preset-selector"
              value={activePreset()}
              onChange={(e) => applyPreset(e.currentTarget.value)}
              title="Layout Preset (Ctrl+1..6)"
              aria-label="select layout preset"
            >
              <option value="Bring-up">🔌 Bring-up</option>
              <option value="Protocol Debug">🔬 Protocol Debug</option>
              <option value="Telemetry & Oscilloscope">📊 Telemetry &amp; Oscilloscope</option>
              <option value="Dashboards">🎛️ Dashboards</option>
              <option value="HIL & Fault Rig">⚡ HIL &amp; Fault Rig</option>
              <option value="Session Diff">⚖️ Session Diff</option>
              <option value="Minimal Stream">Minimal Stream</option>
              <option value="Custom" disabled>Custom</option>
            </select>
          </div>

          <button
            type="button"
            class="tb-btn"
            title="Create New Workspace (Ctrl+N)"
            onClick={() => store.setShowNewWorkspaceModal(true)}
          >
            + New Workspace
          </button>
          <button
            type="button"
            class="tb-btn"
            title="Save current session as .bforge.toml (Ctrl+S)"
            onClick={() => void store.saveWorkspace()}
          >
            💾 Save Workspace
          </button>
        </div>

        {/* Center DVR Scrubber & Transport Pod */}
        <div class="topbar-center">
          <div class="dvr-pod">
            <button
              type="button"
              class="dvr-btn"
              onClick={() => store.togglePlay()}
              title={store.playing() ? 'pause playback (Space)' : 'play recorded stream (Space)'}
            >
              {store.playing() ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              class="dvr-rate-btn"
              onClick={() => store.setRate(store.rate() === 1 ? 2 : store.rate() === 2 ? 4 : 1)}
              title="toggle playback rate (1x / 2x / 4x)"
            >
              {store.rate()}x
            </button>
            <input
              type="range"
              class="dvr-slider"
              min="0"
              max={store.spanMs() || 1000}
              value={store.at() ?? store.spanMs()}
              onInput={(e) => store.scrub(Number(e.currentTarget.value) * 1000)}
              aria-label="DVR scrubber position"
            />
            <span class="dvr-time-readout">
              {store.at() !== null ? clock(store.at()! * 1000) : 'LIVE'}
            </span>
            <button
              type="button"
              class="chip action live-snap-btn"
              classList={{ on: store.at() === null }}
              onClick={() => store.snapLive()}
              title="jump to live head (End)"
            >
              ● live
            </button>
          </div>
        </div>

        {/* Right Toolbar & Action Buttons */}
        <div class="topbar-right">
          <Show when={store.yieldNote()}>{(note) => <span class="chip yield-note">{note()}</span>}</Show>
          <Show when={store.exportNote()}>{(note) => <span class="chip export-note">{note()}</span>}</Show>
          <Show when={store.pinNote()}>{(note) => <span class="chip pin-note">{note()}</span>}</Show>
          <button
            type="button"
            class="chip action palette-trigger"
            onClick={() => store.setPaletteOpen(true)}
            title="Command palette (Ctrl+K)"
          >
            ⌘K
          </button>
          <button
            type="button"
            class="chip action settings-trigger"
            onClick={() => store.setSettingsOpen(true)}
            title="Workbench Settings (Ctrl+,)"
          >
            ⚙ Settings
          </button>
          <button
            type="button"
            class="tb-btn tb-icon-btn"
            title="Help & Quick Reference (Ctrl+H / F1)"
            onClick={() => setShowHelp(true)}
          >
            ?
          </button>
          <select
            class="chip action export"
            disabled={store.exporting() || !store.session()}
            title="save the vault as a file"
            value=""
            onChange={(event) => {
              const format = event.currentTarget.value
              event.currentTarget.value = ''
              void store.saveExport(format)
            }}
          >
            <option value="">export…</option>
            <option value="csv">CSV</option>
            <option value="jsonl">JSON Lines</option>
            <option value="saleae">Saleae CSV</option>
            <option value="pcapng">PCAPNG</option>
          </select>
          <span class="chip telemetry-chip">elapsed {store.session() ? seconds(store.session()!.elapsed_ms) : '-'}</span>
          <span class="chip telemetry-chip">chunks {store.session()?.chunks ?? 0}</span>
          <span class="chip telemetry-chip">payload {store.session() ? bytes(store.session()!.payload_bytes) : '-'}</span>
          <WindowControls />
        </div>
      </header>

      {/* Center Reconfigurable Docking Canvas */}
      <main class="workbench-dock-stage">
        <DockContainer
          tree={dockLayout()}
          renderPanel={renderPanel}
          panelDefs={BUILTIN_PANELS}
          onTreeChange={handleTreeChange}
          onPopoutPanel={handlePopout}
        />
      </main>

      {/* Precision Status Bar Footer */}
      <footer class="footer status-bar" data-zone="footer" tabindex="-1">
        <span>vault {store.session()?.vault || 'not recording'}</span>
        <span>{store.session() ? bytes(store.session()!.file_bytes) : '-'} on disk</span>
        <span>elf {store.session()?.elf ?? 'none'}</span>
        <span>contract {store.feed.snapshot()?.contract ?? '?'}</span>
        <span class="grow" />
        <span>layout: {activePreset()}</span>
        <span>frames {store.feed.frames().length}</span>
        <span>rx {store.feed.received()}</span>
        <span class="shortcut-hint" onClick={() => store.setPaletteOpen(true)} title="open command palette (Ctrl+K)">
          ⌘K
        </span>
        <span class="shortcut-hint" onClick={() => store.setSettingsOpen(true)} title="open settings dialog (Ctrl+,)">
          ⚙ Ctrl+,
        </span>
        <span class="shortcut-hint" onClick={() => setShowHelp(true)} title="open help & reference (Ctrl+H / F1)">
          ? F1
        </span>
      </footer>

      {/* Command Palette Modal */}
      <CommandPalette
        open={store.paletteOpen()}
        onClose={() => store.setPaletteOpen(false)}
        actions={paletteActions()}
      />

      {/* Settings & Appearance Modal */}
      <SettingsModal
        open={store.settingsOpen()}
        onClose={() => store.setSettingsOpen(false)}
      />

      {/* New Workspace Wizard Modal */}
      <NewWorkspaceModal
        open={store.showNewWorkspaceModal()}
        onClose={() => store.setShowNewWorkspaceModal(false)}
      />

      {/* Help & Cheatsheet Modal */}
      <HelpModal
        open={showHelp()}
        onClose={() => setShowHelp(false)}
        onSelectPreset={(presetName) => applyPreset(presetName)}
      />
    </div>
  )
}
