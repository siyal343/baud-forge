import { For, Show, createMemo, createSignal, onMount } from 'solid-js'
import { createFeed } from './lib/feed'
import type { FieldRow, SymbolHit, TailRow } from './lib/types'
import './index.css'

const bytes = (value: number) =>
  value < 1000 ? `${value} B` : value < 1e6 ? `${(value / 1e3).toFixed(1)} kB` : `${(value / 1e6).toFixed(1)} MB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clock = (us: number) => `${(us / 1e6).toFixed(4)} s`

/** Rust symbols arrive mangled (D-44), so the badge leads with where, not what. */
function sourceOf(hit: { file: string | null; line: number | null }): string {
  if (!hit.file) return ''
  // Toolchain paths are long and mixed: the last two segments are what a person
  // recognises, on either separator.
  const parts = hit.file.replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return hit.line ? `${tail}:${hit.line}` : tail
}

function shortName(symbol: string): string {
  const tail = symbol.split('::').filter(Boolean).pop() ?? symbol
  return tail.length > 26 ? `${tail.slice(0, 23)}...` : tail
}

/** Bytes of a frame as separate spans, so a field can point at its own bytes. */
function HexDump(props: { row: TailRow; field: FieldRow | null }) {
  const bytes = createMemo(() => props.row.hex.split(' ').filter(Boolean))
  const inField = (index: number) =>
    props.field != null && index >= props.field.offset && index < props.field.offset + props.field.len
  return (
    <div class="hex">
      <For each={bytes()}>
        {(byte, index) => (
          <span
            class="byte"
            classList={{ hot: inField(index()), warn: props.row.decode_error != null }}
            title={`byte ${index()} = 0x${byte}`}
          >
            {byte}
          </span>
        )}
      </For>
    </div>
  )
}


/** A line plot of one series. Scales to its own min and max, like a scope. */
function Plot(props: { values: number[] }) {
  const box = { width: 1000, height: 100 }
  const shape = createMemo(() => {
    const values = props.values
    if (values.length < 2) return ''
    const low = Math.min(...values)
    const high = Math.max(...values)
    const span = high - low || 1
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * box.width
        const y = box.height - ((value - low) / span) * box.height
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')
  })
  const readout = createMemo(() => {
    const values = props.values
    if (values.length === 0) return { last: 0, low: 0, high: 0 }
    return {
      last: values[values.length - 1],
      low: Math.min(...values),
      high: Math.max(...values),
    }
  })
  const number = (value: number) =>
    Math.abs(value) >= 1000 || (Math.abs(value) < 0.01 && value !== 0)
      ? value.toExponential(3)
      : value.toFixed(3)

  return (
    <div class="plot">
      <svg viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none" role="img" aria-label="series plot">
        <line x1="0" y1={box.height / 2} x2={box.width} y2={box.height / 2} class="grid" />
        <path d={shape()} class="trace" />
      </svg>
      <div class="plot-readout">
        <span>last <b>{number(readout().last)}</b></span>
        <span>min <b>{number(readout().low)}</b></span>
        <span>max <b>{number(readout().high)}</b></span>
        <span>{props.values.length} samples</span>
      </div>
    </div>
  )
}

export default function App() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)
  const [plotKey, setPlotKey] = createSignal<string | null>(null)
  const [hex, setHex] = createSignal('AA 55 03')
  const [crc, setCrc] = createSignal('')
  const [answer, setAnswer] = createSignal<string | null>(null)
  const [sent, setSent] = createSignal<string[]>([])
  const [faultKind, setFaultKind] = createSignal('off')
  const [faultValue, setFaultValue] = createSignal('1.0')
  const [faultLine, setFaultLine] = createSignal<string | null>(null)
  // Scrubbing: null means live. A number is a record ordinal in the vault.
  const [at, setAt] = createSignal<number | null>(null)
  const [windowRows, setWindowRows] = createSignal<TailRow[]>([])
  const [records, setRecords] = createSignal(0)
  const [scrubNote, setScrubNote] = createSignal<string | null>(null)
  // A paired bus: one bridge's two ports, merged by time (spec 0029).
  // `null` follows the workspace: one bridge means one bus, no choice to make.
  const [bridge, setBridge] = createSignal<string | null>(null)
  const bytesOf = (text: string) =>
    text.replace(/0x/gi, '').replace(/[\s:,]/g, '').length / 2
  const bridges = () => feed.snapshot()?.bridges ?? []
  const activeBridge = createMemo(() => {
    const chosen = bridge()
    if (chosen === 'all') return null
    if (chosen !== null) return chosen
    return bridges().length === 1 ? bridges()[0].id : null
  })
  const bridgePorts = createMemo(() => {
    const found = bridges().find((item) => item.id === activeBridge())
    return found ? [found.a, found.b] : null
  })
  const plotKeys = createMemo(() => {
    const keys = Object.keys(feed.series()).sort()
    const pair = bridgePorts()
    return pair ? keys.filter((key) => pair.includes(key.split('.')[0])) : keys
  })
  const activePlot = createMemo(() => plotKey() ?? plotKeys()[0] ?? null)

  const session = () => feed.snapshot()?.session
  const ports = () => feed.snapshot()?.ports ?? []
  const rows = createMemo(() => {
    const all = at() === null ? feed.frames() : windowRows()
    const pair = bridgePorts()
    return pair ? all.filter((row) => pair.includes(row.port)) : all
  })
  // One sequence for the pair: the table reads top to bottom in time order.
  const shown = createMemo(() => {
    const window = rows().slice(-120).reverse()
    return bridgePorts() ? [...window].sort((left, right) => right.timestamp_us - left.timestamp_us) : window
  })
  const plotValues = createMemo(() => {
    const key = activePlot()
    if (key === null) return []
    if (at() === null) return feed.series()[key] ?? []
    const [port, ...rest] = key.split('.')
    const field = rest.join('.')
    return windowRows()
      .map((row) => (row.port === port ? row.fields.find((leaf) => leaf.name === field)?.value_num : null))
      .filter((value): value is number => value !== null && value !== undefined)
  })

  async function loadWindow(record: number) {
    setAt(record)
    try {
      const response = await fetch(`/api/vault/frames?at=${record}&count=400`)
      if (!response.ok) {
        setScrubNote(`${response.status} ${await response.text()}`)
        return
      }
      const body = (await response.json()) as { rows: TailRow[]; records: number; at: number }
      setRecords(body.records)
      setWindowRows(body.rows)
      setScrubNote(`${body.rows.length} frames from record ${body.at}`)
    } catch (error) {
      setScrubNote(String(error))
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(location.search)
    const shared = params.get('at')
    const sharedBridge = params.get('bridge')
    if (sharedBridge !== null) setBridge(sharedBridge)
    try {
      const response = await fetch('/api/vault')
      if (response.ok) {
        const body = (await response.json()) as { records: number }
        setRecords(body.records)
        if (shared !== null) await loadWindow(Number(shared))
      }
    } catch {
      // A session without a vault simply has nothing to scrub.
    }
  })
  const detail = () => selected() ?? rows().at(-1) ?? null
  const openPorts = () => ports().filter((port) => port.state === 'open').length

  async function armFault(event: SubmitEvent) {
    event.preventDefault()
    const port = ports()[0]?.id
    if (!port) {
      setFaultLine('no port in this workspace')
      return
    }
    const body: Record<string, number | string> = { port, kind: faultKind() }
    const value = Number(faultValue())
    if (faultKind() === 'bit_flip') body.flip_rate = Number.isFinite(value) ? value : 1
    if (faultKind() === 'drop') body.drop_every = Number.isFinite(value) ? value : 2
    if (faultKind() === 'truncate') body.truncate = Number.isFinite(value) ? value : 2
    if (faultKind() === 'corrupt_crc') body.corrupt_crc = Number.isFinite(value) ? value : 4
    try {
      const response = await fetch('/api/fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setFaultLine(`${response.status} ${await response.text()}`)
    } catch (error) {
      setFaultLine(String(error))
    }
  }

  async function forgeSend(event: SubmitEvent) {
    event.preventDefault()
    const port = ports()[0]?.id
    if (!port) {
      setAnswer('no port in this workspace')
      return
    }
    const body: { port: string; hex: string; crc?: string } = { port, hex: hex() }
    if (crc()) body.crc = crc()
    try {
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const reply = await response.text()
      setAnswer(`${response.status} ${reply}`)
      if (response.ok) {
        const sentBytes = (JSON.parse(reply) as { sent: number }).sent
        setSent((current) =>
          [`${new Date().toLocaleTimeString()}  ${port}  ${sentBytes} B  ${hex()}`].concat(current).slice(0, 6),
        )
      }
    } catch (error) {
      setAnswer(String(error))
    }
  }

  return (
    <div class="shell">
      <header class="ribbon">
        <h1>BaudForge</h1>
        <span class="chip">contract {feed.snapshot()?.contract ?? '?'}</span>
        <span class={`chip ${feed.link()}`}>{feed.link()}</span>
        <span class="chip">{session()?.mode ?? 'idle'}</span>
        <span class="chip">ports {openPorts()}/{ports().length}</span>
        <For each={feed.snapshot()?.bridges ?? []}>
          {(bridge) => (
            <span class="chip bridge" classList={{ forward: bridge.forward }}>
              {bridge.forward ? 'bridge' : 'tap'} {bridge.a}↔{bridge.b}
              <Show when={bridge.forward}> {bridge.forwarded} B</Show>
            </span>
          )}
        </For>
        <span class="grow" />
        <span class="chip">elapsed {session() ? seconds(session()!.elapsed_ms) : '-'}</span>
        <span class="chip">chunks {session()?.chunks ?? 0}</span>
        <span class="chip">payload {session() ? bytes(session()!.payload_bytes) : '-'}</span>
      </header>

      <aside class="sidebar">
        <h2>Ports</h2>
        <Show when={ports().length > 0} fallback={<p class="empty">No ports in this workspace.</p>}>
          <For each={ports()}>
            {(port) => (
              <article class="port">
                <div class="port-head">
                  <strong>{port.id}</strong>
                  <span class={`state ${port.state}`}>{port.state}</span>
                </div>
                <dl>
                  <dt>device</dt>
                  <dd title={port.device}>{port.device || '-'}</dd>
                  <dt>baud</dt>
                  <dd>{port.baud_rate || '-'}</dd>
                  <dt>framing</dt>
                  <dd>{port.framing}</dd>
                  <dt>chunks</dt>
                  <dd>{port.chunks}</dd>
                  <dt>bytes</dt>
                  <dd>{bytes(port.bytes)}</dd>
                  <dt>overruns</dt>
                  <dd classList={{ bad: port.overruns > 0 }}>{port.overruns}</dd>
                  <dt>stall</dt>
                  <dd>{port.stalls_ms.toFixed(1)} ms</dd>
                </dl>
              </article>
            )}
          </For>
        </Show>

        <h2>Events</h2>
        <ol class="events">
          <For each={feed.events()}>{(event) => <li>{event.text}</li>}</For>
        </ol>
      </aside>

      <div class="stage">
        <main class="stream">
        <div class="stream-head">
          <h2>Stream</h2>
          <span class="hint">{shown().length} of {feed.received()} frames</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>t</th>
              <th>Δt µs</th>
              <th>port</th>
              <th>dir</th>
              <th>len</th>
              <th>hex</th>
              <th>protocol</th>
              <th>crash</th>
            </tr>
          </thead>
          <tbody>
            <For each={shown()} fallback={<tr><td colSpan={6} class="empty">Waiting for frames.</td></tr>}>
              {(row) => (
                <tr
                  classList={{ chosen: detail() === row, faulty: row.decode_error != null }}
                  onClick={() => setSelected(row)}
                >
                  <td>{clock(row.timestamp_us)}</td>
                  <td>{row.delta_us}</td>
                  <td>{row.port}</td>
                  <td classList={{ tx: row.direction !== 'Rx' }}>{row.direction.toLowerCase()}</td>
                  <td>{row.len}</td>
                  <td class="hexcell">{row.hex}</td>
                  <td>{row.protocol ?? (row.text ? 'text' : '-')}</td>
                  <td class="crash">
                    <Show when={row.symbols[0]}>
                      {(hit) => (
                        <span title={`${shortName(hit().function)} @ 0x${hit().address.toString(16)}`}>
                          {hit().field}
                          <Show when={sourceOf(hit())}> {sourceOf(hit())}</Show>
                        </span>
                      )}
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        </main>

        <section class="plot-band">
          <div class="stream-head">
            <h2>Telemetry</h2>
            <Show when={plotKeys().length > 0} fallback={<span class="hint">No numeric fields yet.</span>}>
              <select value={activePlot() ?? ''} onChange={(event) => setPlotKey(event.currentTarget.value)}>
                <For each={plotKeys()}>{(key) => <option value={key}>{key}</option>}</For>
              </select>
            </Show>
          </div>
          <div class="scrubber">
            <Show when={(feed.snapshot()?.bridges ?? []).length > 0}>
              <select
                value={activeBridge() ?? 'all'}
                onChange={(event) => setBridge(event.currentTarget.value)}
                aria-label="bridge"
              >
                <option value="all">all ports</option>
                <For each={bridges()}>
                  {(item) => <option value={item.id}>{`bus ${item.a}↔${item.b}`}</option>}
                </For>
              </select>
            </Show>
            <input
              type="range"
              min="0"
              max={Math.max(records() - 1, 0)}
              value={at() ?? Math.max(records() - 1, 0)}
              onInput={(event) => loadWindow(Number(event.currentTarget.value))}
              aria-label="vault position"
            />
            <button type="button" onClick={() => { setAt(null); setWindowRows([]) }} classList={{ active: at() === null }}>
              live
            </button>
            <span class="hint">{at() === null ? `record ${records()}` : scrubNote() ?? `record ${at()}`}</span>
          </div>
          <Show when={plotValues().length > 1}>
            <Plot values={plotValues()} />
          </Show>
        </section>
      </div>

      <section class="inspector">
        <h2>Inspector</h2>
        <Show when={detail()} fallback={<p class="empty">Select a frame to read its bytes.</p>}>
          {(row) => (
            <>
              <HexDump row={row()} field={hovered()} />
              <Show when={row().decode_error}>
                {(error) => <p class="error">{error()}</p>}
              </Show>
              <Show when={row().text}>
                {(text) => <p class="text">{text()}</p>}
              </Show>
              <Show when={row().symbols.length > 0}>
                <dl class="symbols">
                  <For each={row().symbols}>
                    {(hit: SymbolHit) => (
                      <div class="field">
                        <dt>{hit.field}</dt>
                        <dd>
                          <span class="value">0x{hit.address.toString(16)}</span>
                          <span class="at" title={hit.function}>
                            {sourceOf(hit) || shortName(hit.function)}
                          </span>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </Show>
              <dl class="fields">
                <For each={row().fields} fallback={<p class="empty">No schema on this port.</p>}>
                  {(field) => (
                    <div
                      class="field"
                      onMouseEnter={() => setHovered(field)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <dt>{field.name}</dt>
                      <dd>
                        <span class="value">{field.value}</span>
                        <span class="at">@{field.offset}+{field.len}</span>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </>
          )}
        </Show>
      </section>

      <section class="forge">
        <div class="band-head">
          <h2>Command forge</h2>
          <h2>Fault injector</h2>
        </div>
        <form onSubmit={forgeSend}>
          <input
            value={hex()}
            onInput={(event) => setHex(event.currentTarget.value)}
            placeholder="AA 55 03"
            spellcheck={false}
            aria-label="bytes to send, in hex"
          />
          <select value={crc()} onChange={(event) => setCrc(event.currentTarget.value)} aria-label="checksum">
            <option value="">no checksum</option>
            <option value="crc32c">crc32c</option>
            <option value="crc16_ccitt_false">crc16</option>
            <option value="crc8">crc8</option>
          </select>
          <button type="submit" disabled={ports().length === 0}>Send</button>
          <span class="hint">{Number.isFinite(bytesOf(hex())) ? bytesOf(hex()) : 0} B</span>
        </form>
        <Show when={answer()}>{(line) => <p class="answer">{line()}</p>}</Show>
        <form class="fault-form" onSubmit={armFault}>
          <select value={faultKind()} onChange={(event) => setFaultKind(event.currentTarget.value)} aria-label="fault kind">
            <option value="off">off</option>
            <option value="bit_flip">bit flip</option>
            <option value="drop">drop bytes</option>
            <option value="truncate">truncate</option>
            <option value="corrupt_crc">corrupt CRC</option>
          </select>
          <input
            class="narrow"
            value={faultValue()}
            onInput={(event) => setFaultValue(event.currentTarget.value)}
            aria-label="fault amount"
            title={faultKind() === 'bit_flip' ? 'probability per byte, 0 to 1' : 'bytes or interval'}
          />
          <button type="submit">Arm</button>
          <span class="hint">
            {faultKind() === 'bit_flip' ? 'per-byte probability' : 'bytes / interval'}
          </span>
        </form>
        <Show when={faultLine()}>{(line) => <p class="answer">{line()}</p>}</Show>
        <ol class="sent">
          <For each={sent()}>{(line) => <li>{line}</li>}</For>
        </ol>
      </section>

      <footer class="footer">
        <span>vault {session()?.vault || 'not recording'}</span>
        <span>{session() ? bytes(session()!.file_bytes) : '-'} on disk</span>
        <span>elf {session()?.elf ?? 'none'}</span>
        <span class="grow" />
        <span>frames kept {feed.frames().length}</span>
        <span>received {feed.received()}</span>
      </footer>
    </div>
  )
}
