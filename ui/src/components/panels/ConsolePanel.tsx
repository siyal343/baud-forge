import { For, Show, createMemo, createSignal } from 'solid-js'
import type { WorkbenchStore } from '../../lib/store'

const bytesOf = (text: string) =>
  text.replace(/0x/gi, '').replace(/[\s:,]/g, '').length / 2

export function ConsolePanel(props: { store: WorkbenchStore }) {
  const { store } = props

  const [txInput, setTxInput] = createSignal('')
  const [txMode, setTxMode] = createSignal<'crlf' | 'lf' | 'cr' | 'none' | 'hex'>('crlf')
  const [txPort, setTxPort] = createSignal<string>('')
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal<number>(-1)
  let draftInput = ''

  const defaultPort = () => {
    const open = store.ports().find((p) => p.state === 'open')
    if (open) return open.id
    const obcOrSerial0 = store.ports().find((p) => p.id === 'obc' || p.id === 'serial0')
    if (obcOrSerial0) return obcOrSerial0.id
    return store.ports()[0]?.id || ''
  }

  const effectivePort = () => txPort() || defaultPort()

  async function handleSend() {
    const text = txInput()
    const mode = txMode()
    if (!text && (mode === 'none' || mode === 'hex')) return

    const port = effectivePort()
    if (!port) return

    const ok = await store.sendTx(port, text, mode)
    if (ok) {
      if (text) {
        setHistory((prev) => (prev[prev.length - 1] === text ? prev : [...prev, text]))
      }
      setHistoryIndex(-1)
      draftInput = ''
      setTxInput('')
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSend()
    } else if (e.key === 'ArrowUp') {
      const list = history()
      if (list.length === 0) return
      e.preventDefault()
      const current = historyIndex()
      if (current === -1) {
        draftInput = txInput()
        const next = list.length - 1
        setHistoryIndex(next)
        setTxInput(list[next])
      } else if (current > 0) {
        const next = current - 1
        setHistoryIndex(next)
        setTxInput(list[next])
      }
    } else if (e.key === 'ArrowDown') {
      const list = history()
      if (list.length === 0) return
      e.preventDefault()
      const current = historyIndex()
      if (current !== -1) {
        if (current < list.length - 1) {
          const next = current + 1
          setHistoryIndex(next)
          setTxInput(list[next])
        } else {
          setHistoryIndex(-1)
          setTxInput(draftInput)
        }
      }
    }
  }

  const schemaFields = createMemo(() => {
    const port = store.targetPort() || (store.ports().length > 0 ? store.ports()[0].id : '')
    const row = store.rawRows().find((r) => r.port === port && r.fields && r.fields.length > 0)
    return row ? row.fields : []
  })

  function forgeSend(e: Event) {
    e.preventDefault()
    void store.sendHex()
  }

  function forgeSendTyped(e: Event) {
    e.preventDefault()
    void store.sendHex()
  }

  function armFault(e: Event) {
    e.preventDefault()
    void store.injectFault()
  }

  function handleDiff(e: Event) {
    e.preventDefault()
    void store.runDiff()
  }

  return (
    <div class="panel-content console-panel-content">
      <div class="console-header">
        <div class="console-tabs">
          <button
            type="button"
            class="console-tab console-tab-btn"
            classList={{ active: store.consoleTab() === 'forge' }}
            onClick={() => {
              store.setConsoleTab('forge')
              store.setConsoleCollapsed(false)
            }}
          >
            Command Forge & Faults
          </button>
          <button
            type="button"
            class="console-tab console-tab-btn"
            classList={{ active: store.consoleTab() === 'diff' }}
            onClick={() => {
              store.setConsoleTab('diff')
              store.setShowDiff(true)
              store.setConsoleCollapsed(false)
            }}
          >
            Session Diff
          </button>
          <button
            type="button"
            class="console-tab console-tab-btn"
            classList={{ active: store.consoleTab() === 'events' }}
            onClick={() => {
              store.setConsoleTab('events')
              store.setConsoleCollapsed(false)
            }}
          >
            Events ({store.feed.events().length})
          </button>
        </div>
      </div>

      <div class="console-body">
        <Show when={store.consoleTab() === 'forge'}>
          <div class="forge-split">
            {/* Command Forge Card */}
            <div class="forge-card command-card">
              <div class="card-head">
                <h2>Command forge</h2>
                <div class="card-controls">
                  <button
                    type="button"
                    class="mode"
                    classList={{ active: store.typed() }}
                    onClick={() => store.setTyped(!store.typed())}
                    title="send named fields instead of hex"
                  >
                    {store.typed() ? 'typed' : 'hex'}
                  </button>
                  <Show when={store.ports().length > 1}>
                    <select
                      class="port-select"
                      value={store.targetPort() || store.ports()[0]?.id || ''}
                      onChange={(e) => store.setTargetPort(e.currentTarget.value)}
                      aria-label="target port"
                    >
                      <For each={store.ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
                    </select>
                  </Show>
                </div>
              </div>
              <form onSubmit={store.typed() ? forgeSendTyped : forgeSend}>
                <Show
                  when={!store.typed()}
                  fallback={
                    <div class="typed">
                      <Show
                        when={schemaFields().length > 0}
                        fallback={<span class="hint">No decoded frame yet: this port has no schema to fill.</span>}
                      >
                        <For each={schemaFields()}>
                          {(field) => (
                            <label>
                              <span>{field.name}</span>
                              <input
                                value={store.typedValues()[field.name] ?? ''}
                                onInput={(event) =>
                                  store.setTypedValues((current) => ({
                                    ...current,
                                    [field.name]: event.currentTarget.value,
                                  }))
                                }
                                aria-label={field.name}
                              />
                            </label>
                          )}
                        </For>
                      </Show>
                    </div>
                  }
                >
                  <input
                    class="hex-input"
                    value={store.hex()}
                    onInput={(event) => store.setHex(event.currentTarget.value)}
                    placeholder="AA 55 03"
                    spellcheck={false}
                    aria-label="bytes to send, in hex"
                  />
                </Show>
                <Show when={!store.typed()}>
                  <select
                    value={store.crc()}
                    onChange={(event) => store.setCrc(event.currentTarget.value)}
                    aria-label="checksum"
                  >
                    <option value="">no checksum</option>
                    <option value="crc32c">crc32c</option>
                    <option value="crc16_ccitt_false">crc16</option>
                    <option value="crc8">crc8</option>
                  </select>
                </Show>
                <input
                  class="narrow"
                  value={store.chunkSize()}
                  onInput={(event) => store.setChunkSize(event.currentTarget.value)}
                  placeholder="chunk B"
                  aria-label="chunk size in bytes"
                  title="chunk size in bytes for paced send"
                />
                <input
                  class="narrow"
                  value={store.paceMs()}
                  onInput={(event) => store.setPaceMs(event.currentTarget.value)}
                  placeholder="pace ms"
                  aria-label="delay between chunks in milliseconds"
                  title="delay between chunks in milliseconds"
                />
                <button type="submit" disabled={store.ports().length === 0}>Send</button>
                <span class="hint">{Number.isFinite(bytesOf(store.hex())) ? bytesOf(store.hex()) : 0} B</span>
              </form>
              <Show when={store.answer()}>{(line) => <p class="answer">{line()}</p>}</Show>
              <Show when={store.sentHistory().length > 0}>
                <ol class="sent tx-history">
                  <For each={store.sentHistory()}>
                    {(entry) => (
                      <li>
                        <button
                          type="button"
                          class="replay-btn"
                          title="replay this transmission"
                          onClick={() => void store.replaySent(entry)}
                        >
                          ↻
                        </button>
                        <span class="tx-time">{entry.time}</span>
                        <span class="tx-port">{entry.port}</span>
                        <span class="tx-bytes">{entry.bytes} B</span>
                        <span class="tx-payload">{entry.summary}</span>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </div>

            {/* Fault Injector Card */}
            <div class="forge-card fault-card">
              <div class="card-head">
                <h2>Fault injector</h2>
                <Show when={store.faultKind() !== 'off'}>
                  <span class="chip down">ARMED</span>
                </Show>
              </div>
              <form class="fault-form" onSubmit={armFault}>
                <Show when={store.ports().length > 1}>
                  <select
                    class="port-select"
                    value={store.targetPort() || store.ports()[0]?.id || ''}
                    onChange={(e) => store.setTargetPort(e.currentTarget.value)}
                    aria-label="target port for fault"
                  >
                    <For each={store.ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
                  </select>
                </Show>
                <select
                  value={store.faultKind()}
                  onChange={(event) => store.setFaultKind(event.currentTarget.value)}
                  aria-label="fault kind"
                >
                  <option value="off">off</option>
                  <option value="bit_flip">bit flip</option>
                  <option value="drop">drop bytes</option>
                  <option value="truncate">truncate</option>
                  <option value="corrupt_crc">corrupt CRC</option>
                  <option value="delay">delay / jitter</option>
                </select>
                <input
                  class="narrow"
                  value={store.faultValue()}
                  onInput={(event) => store.setFaultValue(event.currentTarget.value)}
                  aria-label="fault amount"
                  title={
                    store.faultKind() === 'bit_flip'
                      ? 'probability per byte, 0 to 1'
                      : store.faultKind() === 'delay'
                        ? 'delay in milliseconds'
                        : 'bytes or interval'
                  }
                />
                <button type="submit">Arm</button>
                <Show when={store.faultKind() !== 'off'}>
                  <button type="button" class="disarm-btn" onClick={() => void store.disarmFault()}>Disarm</button>
                </Show>
                <span class="hint">
                  {store.faultKind() === 'bit_flip'
                    ? 'per-byte probability'
                    : store.faultKind() === 'delay'
                      ? 'delay ms'
                      : 'bytes / interval'}
                </span>
              </form>
              <Show when={store.faultLine()}>{(line) => <p class="answer">{line()}</p>}</Show>
            </div>
          </div>
        </Show>

        <Show when={store.consoleTab() === 'diff'}>
          <div class="diff-panel">
            <form class="diff-form" onSubmit={handleDiff}>
              <span class="diff-title">diff</span>
              <input
                class="diff-input"
                value={store.diffPathA()}
                onInput={(event) => store.setDiffPathA(event.currentTarget.value)}
                placeholder={store.session()?.vault ? `a: ${store.session()!.vault}` : 'vault a (defaults to active)'}
                title="vault a path (leave blank to use active session vault)"
              />
              <span class="diff-sep">vs</span>
              <input
                class="diff-input"
                value={store.diffPathB()}
                onInput={(event) => store.setDiffPathB(event.currentTarget.value)}
                placeholder="vault b path (required)"
                title="comparison vault b path"
                required
              />
              <button type="submit" class="chip action" disabled={store.diffLoading() || !store.diffPathB().trim()}>
                {store.diffLoading() ? 'comparing…' : 'compare'}
              </button>
            </form>
            <Show when={store.diffError()}>
              {(err) => <p class="diff-error">diff error: {err()}</p>}
            </Show>
            <Show when={store.diffReport()}>
              {(report) => (
                <div class="diff-report">
                  <div class="diff-summary">
                    <Show
                      when={report().identical}
                      fallback={<span class="chip fault">diverged</span>}
                    >
                      <span class="chip live">identical</span>
                    </Show>
                    <span class="hint">
                      records: {report().records_a} vs {report().records_b} · frames: {report().frames_a} vs {report().frames_b}
                      <Show when={report().missing_from_a > 0}>
                        {` · missing in a: ${report().missing_from_a}`}
                      </Show>
                      <Show when={report().missing_from_b > 0}>
                        {` · missing in b: ${report().missing_from_b}`}
                      </Show>
                    </span>
                  </div>
                  <Show when={!report().identical && report().first_divergence}>
                    {(div) => (
                      <div class="divergence-banner">
                        <span class="div-index">Frame #{div().index}</span>
                        <span class="div-reason">{div().reason}</span>
                        <span class="div-time">
                          Δt: {((div().timestamp_us_b - div().timestamp_us_a) / 1000).toFixed(2)} ms
                        </span>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={store.consoleTab() === 'events'}>
          <div class="events-log">
            <Show when={store.feed.events().length === 0} fallback={
              <ol class="events-list">
                <For each={store.feed.events()}>
                  {(ev) => (
                    <li class="event-item">
                      <span class="event-time">+{ev.at} ms</span>
                      <span class="event-name">{ev.text}</span>
                    </li>
                  )}
                </For>
              </ol>
            }>
              <span class="hint">No events received yet.</span>
            </Show>
          </div>
        </Show>
      </div>

      <div class="console-tx-bar">
        <Show when={store.ports().length > 1}>
          <select
            class="tx-port-select"
            value={effectivePort()}
            onChange={(e) => setTxPort(e.currentTarget.value)}
            aria-label="TX target port"
          >
            <For each={store.ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
          </select>
        </Show>
        <Show when={store.ports().length === 1}>
          <span class="tx-port-badge" title="Active target port">{effectivePort()}</span>
        </Show>
        <input
          class="tx-input"
          value={txInput()}
          onInput={(e) => {
            setTxInput(e.currentTarget.value)
            if (historyIndex() !== -1) setHistoryIndex(-1)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type command to transmit... (Enter to send, ↑↓ history)"
          spellcheck={false}
          aria-label="Type command to transmit"
        />
        <select
          class="tx-mode-select"
          value={txMode()}
          onChange={(e) => setTxMode(e.currentTarget.value as any)}
          aria-label="Line Ending"
        >
          <option value="crlf">CRLF (\r\n)</option>
          <option value="lf">LF (\n)</option>
          <option value="cr">CR (\r)</option>
          <option value="none">None</option>
          <option value="hex">HEX</option>
        </select>
        <button
          type="button"
          class="tx-send-btn"
          disabled={store.ports().length === 0 || !effectivePort()}
          onClick={() => void handleSend()}
          title="Transmit command (Enter)"
        >
          Send
        </button>
      </div>
    </div>
  )
}
