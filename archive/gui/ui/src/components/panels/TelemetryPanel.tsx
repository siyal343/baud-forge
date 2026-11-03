import { For, Show, createMemo } from 'solid-js'
import { Telemetry, SERIES_COLOURS } from '../Telemetry'
import type { WorkbenchStore } from '../../lib/store'

export function TelemetryPanel(props: { store: WorkbenchStore }) {
  const { store } = props

  const seriesFor = (key: string): number[] => {
    if (store.at() === null) return store.feed.series()[key] ?? []
    const [port, ...rest] = key.split('.')
    const field = rest.join('.')
    return store.rawRows()
      .map((row) =>
        row.port === port ? row.fields.find((leaf) => leaf.name === field)?.value_num : null,
      )
      .filter((value): value is number => value !== null && value !== undefined)
  }

  const traces = createMemo(() =>
    store.plottedKeys().map((entry) => ({
      key: entry.key,
      mode: entry.mode,
      values: seriesFor(entry.key),
    })),
  )

  function plotAllDiscoveredChannels() {
    const discovered = new Set<string>()

    // 1. Scan available series from live feed
    for (const key of store.plotKeys()) {
      discovered.add(key)
    }

    // 2. Scan decoded rows for any numeric fields
    const rows = store.rawRows()
    for (const row of rows) {
      if (row.fields) {
        for (const f of row.fields) {
          if (f.value_num !== null && f.value_num !== undefined) {
            discovered.add(`${row.port}.${f.name}`)
          }
        }
      }
    }

    // 3. Add to plotted fields
    if (discovered.size > 0) {
      for (const key of discovered) {
        store.plotField(key)
      }
    } else {
      // If stream has no numeric fields yet, synthesize nominal telemetry channels
      const ports = store.ports()
      const portId = ports[0]?.id || 'COM1'
      store.plotField(`${portId}.voltage`)
      store.plotField(`${portId}.current`)
      store.plotField(`${portId}.temp`)
    }
  }

  return (
    <div class="panel-content telemetry-panel-content">
      <div class="plot-row">
        <Show when={store.plotKeys().length > 0}>
          <select
            class="plot-select"
            value=""
            onChange={(event) => {
              const key = event.currentTarget.value
              if (key) store.plotField(key)
              event.currentTarget.value = ''
            }}
            aria-label="plot a numeric field"
          >
            <option value="">plot a field… ({store.plotKeys().length})</option>
            <For each={store.plotKeys().filter((key) => !store.plottedKeys().some((entry) => entry.key === key))}>
              {(key) => <option value={key}>{key}</option>}
            </For>
          </select>
        </Show>
        <div class="traces">
          <For each={store.plottedKeys()}>
            {(entry, index) => (
              <span class="trace-chip" style={{ '--trace': SERIES_COLOURS[index() % SERIES_COLOURS.length] }}>
                <span class="swatch" />
                <span class="trace-key">{entry.key}</span>
                <button
                  type="button"
                  class="trace-mode"
                  onClick={() => store.cycleMode(entry.key)}
                  title="switch between line, state lane, and rail per bit"
                >
                  {entry.mode}
                </button>
                <button
                  type="button"
                  class="trace-remove"
                  onClick={() => store.unplotField(entry.key)}
                  title="remove this trace"
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </div>
      <Show
        when={traces().length > 0}
        fallback={
          <div class="telemetry-zero-state">
            <div class="telemetry-zero-card">
              <div class="waveform-graphic" aria-hidden="true">
                <svg width="220" height="70" viewBox="0 0 220 70" fill="none" class="oscilloscope-svg">
                  <defs>
                    <pattern id="scope-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
                    </pattern>
                    <linearGradient id="trace-grad-1" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stop-color="#10b981" stop-opacity="0.2" />
                      <stop offset="70%" stop-color="#10b981" stop-opacity="1" />
                      <stop offset="100%" stop-color="#34d399" stop-opacity="0.9" />
                    </linearGradient>
                    <linearGradient id="trace-grad-2" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.1" />
                      <stop offset="80%" stop-color="#06b6d4" stop-opacity="0.8" />
                      <stop offset="100%" stop-color="#22d3ee" stop-opacity="0.6" />
                    </linearGradient>
                  </defs>
                  <rect width="220" height="70" fill="#0d0f15" rx="6" />
                  <rect width="220" height="70" fill="url(#scope-grid)" rx="6" />
                  <line x1="0" y1="35" x2="220" y2="35" stroke="rgba(255,255,255,0.12)" stroke-dasharray="2 3" stroke-width="1" />
                  <line x1="110" y1="0" x2="110" y2="70" stroke="rgba(255,255,255,0.12)" stroke-dasharray="2 3" stroke-width="1" />
                  <path
                    d="M 10 35 Q 30 10, 50 35 T 90 35 T 130 18 T 170 48 T 210 35"
                    stroke="url(#trace-grad-1)"
                    stroke-width="2"
                    fill="none"
                  />
                  <path
                    d="M 10 50 Q 40 55, 70 30 T 130 50 T 190 25 L 210 30"
                    stroke="url(#trace-grad-2)"
                    stroke-width="1.5"
                    fill="none"
                    stroke-dasharray="4 2"
                  />
                </svg>
              </div>
              <div class="zero-content">
                <span class="zero-badge">OSCILLOSCOPE &amp; MULTI-CHANNEL PLOT</span>
                <h3 class="zero-title">Real-Time Telemetry &amp; Oscilloscope</h3>
                <p class="zero-desc">
                  Extract numeric channels from decoded packets into live time-synchronized waveform plots.
                </p>
                <div class="zero-action-bar">
                  <button
                    type="button"
                    class="btn-action"
                    onClick={plotAllDiscoveredChannels}
                  >
                    Plot All Discovered Channels
                  </button>
                  <Show when={store.plotKeys().length > 0}>
                    <span class="zero-discovered-hint">
                      {store.plotKeys().length} channel{store.plotKeys().length === 1 ? '' : 's'} detected in telemetry stream
                    </span>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        }
      >
        <Telemetry series={traces()} stack={store.stackRows()} onRenderer={store.setRenderer} />
      </Show>
    </div>
  )
}
