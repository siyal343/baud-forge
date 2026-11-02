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
        fallback={<div class="telemetry-empty hint">Select numeric fields above or from the inspector to plot telemetry.</div>}
      >
        <Telemetry series={traces()} stack={store.stackRows()} onRenderer={store.setRenderer} />
      </Show>
    </div>
  )
}
