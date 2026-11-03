import { For, Show, createSignal } from 'solid-js'
import type { WorkbenchStore } from '../../lib/store'
import { ESP32_BOOT_STEPS, parsePinSteps } from '../../lib/store'
import { FRAMING_MODES } from '../../lib/workspace'

const bytes = (value: number) =>
  value < 1000 ? `${value} B` : value < 1e6 ? `${(value / 1e3).toFixed(1)} kB` : `${(value / 1e6).toFixed(1)} MB`

export function HardwareBayPanel(props: { store: WorkbenchStore }) {
  const { store } = props
  const [framingPort, setFramingPort] = createSignal<string | null>(null)

  return (
    <div class="panel-content hardware-bay-content">
      <div class="section-bar">
        <h2>Hardware Ports</h2>
        <span class="hint">{store.openPorts()} active</span>
      </div>
      <Show when={store.ports().length > 0} fallback={<p class="empty">No ports in this workspace.</p>}>
        <For each={store.ports()}>
          {(port) => (
            <article class="port port-card">
              <div class="port-head">
                <strong>{port.id}</strong>
                <span class={`state ${port.state}`}>{port.state}</span>
              </div>
              <div class="port-device" title={port.device}>{port.device || '-'}</div>
              <div class="port-kpi-grid">
                <div class="port-kpi port-kpi-framing">
                  <div class="kpi-label-row">
                    <span class="kpi-label">Baud / Frame</span>
                    <button
                      type="button"
                      class="framing-toggle-btn"
                      title="Configure framing mode"
                      onClick={() => setFramingPort(framingPort() === port.id ? null : port.id)}
                    >
                      Framing ▾
                    </button>
                  </div>
                  <div class="kpi-val kpi-val-framing">
                    <span>{port.baud_rate || '-'} · </span>
                    <button
                      type="button"
                      class="framing-interactive-badge"
                      title="Click to select framing mode"
                      onClick={() => setFramingPort(framingPort() === port.id ? null : port.id)}
                    >
                      {port.framing}
                    </button>
                  </div>
                </div>
                <div class="port-kpi">
                  <span class="kpi-label">Traffic</span>
                  <span class="kpi-val">{bytes(port.bytes)}</span>
                </div>
                <div class="port-kpi">
                  <span class="kpi-label">Chunks</span>
                  <span class="kpi-val">{port.chunks}</span>
                </div>
                <div class="port-kpi">
                  <span class="kpi-label">Overruns / Stall</span>
                  <span class="kpi-val" classList={{ bad: port.overruns > 0 }}>
                    {port.overruns} ovr · {port.stalls_ms.toFixed(1)} ms
                  </span>
                </div>
              </div>
              <Show when={framingPort() === port.id}>
                <div class="framing-popover-panel">
                  <div class="framing-popover-head">
                    <span class="framing-popover-title">Framing Mode for {port.id}</span>
                    <button
                      type="button"
                      class="framing-close-btn"
                      title="Close framing selector"
                      onClick={() => setFramingPort(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div class="framing-options-list">
                    <For each={FRAMING_MODES}>
                      {(mode) => (
                        <button
                          type="button"
                          class="framing-option-btn"
                          classList={{ active: port.framing === mode.id }}
                          onClick={() => {
                            void store.setPortFraming(port.id, mode.id)
                            setFramingPort(null)
                          }}
                        >
                          <div class="framing-option-head">
                            <span class="mode-name">{mode.id}</span>
                            <Show when={port.framing === mode.id}>
                              <span class="mode-badge">active</span>
                            </Show>
                          </div>
                          <div class="mode-label">{mode.label}</div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
              <div class="line-leds">
                <span class="line-led" classList={{ on: port.pins.cts }} title="Clear To Send">CTS</span>
                <span class="line-led" classList={{ on: port.pins.dsr }} title="Data Set Ready">DSR</span>
                <span class="line-led" classList={{ on: port.pins.dcd }} title="Data Carrier Detect">DCD</span>
                <span class="line-led" classList={{ on: port.pins.ri }} title="Ring Indicator">RI</span>
                <span class="line-led" classList={{ err: port.pins.break_state }} title="Break State">BRK</span>
                <span class="line-led" classList={{ err: port.pins.framing_error }} title="Framing Error">FRM</span>
                <span class="line-led" classList={{ err: port.pins.parity_error }} title="Parity Error">PAR</span>
              </div>
              <div class="pins pin-strip">
                <button
                  type="button"
                  class="pin"
                  classList={{ on: port.pins.dtr }}
                  title="drive DTR, which resets most boards"
                  onClick={() => store.setDtr(port.id, !port.pins.dtr)}
                >
                  dtr
                </button>
                <button
                  type="button"
                  class="pin"
                  classList={{ on: port.pins.rts }}
                  title="drive RTS"
                  onClick={() => store.setRts(port.id, !port.pins.rts)}
                >
                  rts
                </button>
                <button
                  type="button"
                  class="pin pulse"
                  title="pulse DTR for 100 ms: reset the board"
                  onClick={() => store.pulsePin(port.id, 'dtr', 100)}
                >
                  pulse
                </button>
                <button
                  type="button"
                  class="pin seq"
                  title="run standard ESP32/STM32 bootloader reset sequence"
                  onClick={() => store.sendSequence(port.id, ESP32_BOOT_STEPS)}
                >
                  boot seq
                </button>
                <button
                  type="button"
                  class="pin yield"
                  title="Yield port for 30s so external flasher (esptool, cargo flash) can upload"
                  onClick={() => void store.yieldPort(port.id, 30)}
                >
                  yield 30s
                </button>
                <button
                  type="button"
                  class="pin seq-toggle"
                  classList={{ on: store.seqPort() === port.id }}
                  title="toggle custom pin sequence editor"
                  onClick={() => store.setSeqPort(store.seqPort() === port.id ? null : port.id)}
                >
                  {store.seqPort() === port.id ? 'seq ▴' : 'seq ▾'}
                </button>
              </div>
              <Show when={store.seqPort() === port.id}>
                <div class="pin-seq-form">
                  <input
                    class="pin-seq-input"
                    value={store.customSeqText()}
                    onInput={(e) => store.setCustomSeqText(e.currentTarget.value)}
                    placeholder="DTR=0,RTS=1,50ms -> DTR=1,RTS=0,50ms -> DTR=0,RTS=0"
                    aria-label="custom pin sequence"
                    title="Sequence steps: DTR=0,RTS=1,50ms -> DTR=1,RTS=0,50ms or JSON array"
                  />
                  <button
                    type="button"
                    class="pin pulse"
                    title="execute custom pin sequence"
                    onClick={() => store.sendSequence(port.id, parsePinSteps(store.customSeqText()))}
                  >
                    run
                  </button>
                </div>
              </Show>
            </article>
          )}
        </For>
      </Show>

      <Show when={store.bridges().length > 0}>
        <div class="section-bar">
          <h2>Bridges & Taps</h2>
        </div>
        <For each={store.bridges()}>
          {(b) => (
            <article class="port port-card bridge-card">
              <div class="port-head">
                <strong>{b.forward ? 'bridge' : 'tap'}: {b.a} ↔ {b.b}</strong>
                <span class="state" classList={{ open: b.forward }}>{b.forward ? 'active' : 'monitor'}</span>
              </div>
              <div class="port-kpi-grid">
                <div class="port-kpi">
                  <span class="kpi-label">Forwarded</span>
                  <span class="kpi-val">{bytes(b.forwarded)}</span>
                </div>
                <div class="port-kpi">
                  <span class="kpi-label">Dropped</span>
                  <span class="kpi-val" classList={{ bad: b.dropped > 0 }}>{bytes(b.dropped)}</span>
                </div>
              </div>
            </article>
          )}
        </For>
      </Show>
    </div>
  )
}
