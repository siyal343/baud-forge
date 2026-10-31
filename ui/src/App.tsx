import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { Telemetry, SERIES_COLOURS } from './components/Telemetry'
import { WindowControls } from './components/WindowControls'
import { createFeed } from './lib/feed'
import { api, inShell, stopSession, toPicker } from './lib/shell'
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



/** A node of the inspector's field tree, built from the dotted field names. */
interface FieldNode {
  name: string
  path: string
  field?: FieldRow
  children: FieldNode[]
}

/** Group `gains.proportional` under `gains`, keeping array siblings distinct. */
function buildTree(fields: FieldRow[]): FieldNode[] {
  const root: FieldNode[] = []
  const seen = new Map<string, number>()
  for (const field of fields) {
    const parts = field.name.split('.')
    let level = root
    let path = ''
    parts.forEach((part, index) => {
      path = path ? `${path}.${part}` : part
      const last = index === parts.length - 1
      let node = level.find((candidate) => candidate.name === part)
      if (!node) {
        // Repeated names are array elements: keep each one addressable.
        const count = seen.get(path) ?? 0
        seen.set(path, count + 1)
        node = { name: count > 0 ? `${part}[${count}]` : part, path, children: [] }
        level.push(node)
      }
      if (last) node.field = field
      level = node.children
    })
  }
  return root
}

/** One field of the tree: name, value, and a plot button on the numerics. */
function FieldNodeRow(props: { node: FieldNode; port: string; onHover: (field: FieldRow | null) => void; onPlot: (key: string) => void }) {
  const [open, setOpen] = createSignal(true)
  const field = () => props.node.field
  return (
    <div class="node">
      <div
        class="field"
        onMouseEnter={() => props.onHover(field() ?? null)}
        onMouseLeave={() => props.onHover(null)}
      >
        <button
          type="button"
          class="twisty"
          classList={{ leaf: props.node.children.length === 0 }}
          onClick={() => setOpen(!open())}
          aria-label={open() ? 'collapse' : 'expand'}
        >
          {props.node.children.length === 0 ? '·' : open() ? '▾' : '▸'}
        </button>
        <span class="name">{props.node.name}</span>
        <Show when={field()}>
          {(leaf) => (
            <>
              <span class="value">{leaf().value}</span>
              <span class="at">@{leaf().offset}+{leaf().len}</span>
              <Show when={leaf().value_num !== null}>
                <button
                  type="button"
                  class="plot-this"
                  title="plot this field"
                  onClick={() => props.onPlot(`${props.port}.${leaf().name}`)}
                >
                  plot
                </button>
              </Show>
            </>
          )}
        </Show>
      </div>
      <Show when={open() && props.node.children.length > 0}>
        <div class="children">
          <For each={props.node.children}>
            {(child) => (
              <FieldNodeRow node={child} port={props.port} onHover={props.onHover} onPlot={props.onPlot} />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default function App() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)
  // The traces on screen, in order. A person chooses them, from the picker or the
  // inspector's plot button (the guide's signature interaction).
  const [plotted, setPlotted] = createSignal<string[]>([])
  const [hex, setHex] = createSignal('AA 55 03')
  const [crc, setCrc] = createSignal('')
  const [typed, setTyped] = createSignal(false)
  const [typedValues, setTypedValues] = createSignal<Record<string, string>>({})
  const [answer, setAnswer] = createSignal<string | null>(null)
  const [sent, setSent] = createSignal<string[]>([])
  const [faultKind, setFaultKind] = createSignal('off')
  const [faultValue, setFaultValue] = createSignal('1.0')
  const [faultLine, setFaultLine] = createSignal<string | null>(null)
  // Scrubbing: null means live. A number is a record ordinal in the vault.
  const [at, setAt] = createSignal<number | null>(null)
  const [windowRows, setWindowRows] = createSignal<TailRow[]>([])
  // The vault's span, in milliseconds: what a timeline drags along.
  const [spanMs, setSpanMs] = createSignal(0)
  // A paired bus: one bridge's two ports, merged by time (spec 0029).
  // `null` follows the workspace: one bridge means one bus, no choice to make.
  const [bridge, setBridge] = createSignal<string | null>(null)
  // Which renderer the band got: WebGL when the machine has it, canvas otherwise.
  const [renderer, setRenderer] = createSignal<'webgl' | 'canvas'>('canvas')
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
  const plottedKeys = createMemo(() => {
    const chosen = plotted().filter((key) => plotKeys().includes(key))
    if (chosen.length > 0) return chosen
    return plotKeys().slice(0, 1)
  })

  function plotField(key: string) {
    setPlotted((current) => (current.includes(key) ? current : [...current, key].slice(-6)))
  }

  function unplotField(key: string) {
    setPlotted((current) => current.filter((item) => item !== key))
  }

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
  const seriesFor = (key: string): number[] => {
    if (at() === null) return feed.series()[key] ?? []
    const [port, ...rest] = key.split('.')
    const field = rest.join('.')
    return windowRows()
      .map((row) =>
        row.port === port ? row.fields.find((leaf) => leaf.name === field)?.value_num : null,
      )
      .filter((value): value is number => value !== null && value !== undefined)
  }

  const traces = createMemo(() => plottedKeys().map((key) => ({ key, values: seriesFor(key) })))

  const [timelineNote, setTimelineNote] = createSignal<string | null>(null)

  async function loadWindow(record: number) {
    setAt(record)
    try {
      // Minutes into the session, in milliseconds: the engine seeks with its index
      // instead of walking records.
      const response = await fetch(api(`/api/vault/frames?t_ms=${Math.round(record)}&count=400`))
      if (!response.ok) {
        setTimelineNote(`${response.status} ${await response.text()}`)
        return
      }
      const body = (await response.json()) as { rows: TailRow[]; records: number; at: number }
      setWindowRows(body.rows)
      setSpanMs((current) => Math.max(current, record))
    } catch (error) {
      setTimelineNote(String(error))
    }
  }

  async function refreshSpan() {
    try {
      const response = await fetch(api('/api/vault'))
      if (!response.ok) return
      const body = (await response.json()) as { records: number; duration_ms?: number }
      setSpanMs(body.duration_ms ?? 0)
    } catch {
      // A session without a vault has nothing to scrub.
    }
  }

  onMount(() => {
    const params = new URLSearchParams(location.search)
    const sharedPlot = params.get('plot')
    if (sharedPlot) setPlotted(sharedPlot.split(',').map((item) => item.trim()).filter(Boolean))
    const shared = params.get('at')
    const sharedBridge = params.get('bridge')
    if (sharedBridge !== null) setBridge(sharedBridge)
    // `?typed=1` opens on the typed form, which is also the only way to capture it
    // with a headless browser.
    if (params.get('typed') === '1') chooseTyped(true)

    void refreshSpan()
    if (shared !== null) void loadWindow(Number(shared))
    // The recording grows while the window is open, so the timeline follows it.
    const timer = setInterval(() => {
      if (at() === null) void refreshSpan()
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })

  const detail = () => selected() ?? rows().at(-1) ?? null
  const openPorts = () => ports().filter((port) => port.state === 'open').length

  // The schema the port decodes with is the schema the form sends with: one table,
  // read and written (spec 0032).
  const schemaFields = createMemo(() => {
    const row = [...rows()].reverse().find((candidate) => candidate.fields.length > 0)
    if (!row) return []
    return row.fields.filter((field) => field.value_num !== null && !field.name.includes('.'))
  })

  function chooseTyped(on: boolean) {
    setTyped(on)
    if (on) {
      const seeded: Record<string, string> = {}
      for (const field of schemaFields()) {
        seeded[field.name] = field.value_num === null ? '' : String(field.value_num)
      }
      setTypedValues(seeded)
    }
  }

  async function forgeSendTyped(event: SubmitEvent) {
    event.preventDefault()
    const port = ports()[0]?.id
    if (!port) {
      setAnswer('no port in this workspace')
      return
    }
    // A number is a number; anything else is an enum label, which the engine
    // resolves against the schema (spec 0032).
    const values: Record<string, number | string> = {}
    for (const [name, text] of Object.entries(typedValues())) {
      const trimmed = text.trim()
      if (trimmed === '') continue
      const value = Number(trimmed)
      values[name] = Number.isFinite(value) && trimmed !== '' ? value : trimmed
    }
    try {
      const response = await fetch(api('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, values }),
      })
      const reply = await response.text()
      setAnswer(`${response.status} ${reply}`)
      if (response.ok) {
        const sentBytes = (JSON.parse(reply) as { sent: number }).sent
        setSent((current) =>
          [`${new Date().toLocaleTimeString()}  ${port}  ${sentBytes} B  typed`]
            .concat(current)
            .slice(0, 6),
        )
      }
    } catch (error) {
      setAnswer(String(error))
    }
  }

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
      const response = await fetch(api('/api/fault'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setFaultLine(`${response.status} ${await response.text()}`)
    } catch (error) {
      setFaultLine(String(error))
    }
  }

  const [yieldNote, setYieldNote] = createSignal<string | null>(null)

  async function yieldPort() {
    const port = ports().find((candidate) => candidate.state === 'open')?.id ?? ports()[0]?.id
    if (!port) {
      setYieldNote('no port to yield')
      return
    }
    try {
      const response = await fetch(api('/api/yield'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, seconds: 30 }),
      })
      const reply = await response.text()
      setYieldNote(response.ok ? `${port} released for 30 s` : `${response.status} ${reply}`)
    } catch (error) {
      setYieldNote(String(error))
    }
  }

  function focusZone(index: number) {
    const zones = ['ribbon', 'sidebar', 'stage', 'inspector', 'forge']
    document.querySelector<HTMLElement>(`[data-zone="${zones[index] ?? 'ribbon'}"]`)?.focus()
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return
      if (event.key >= '1' && event.key <= '5') {
        event.preventDefault()
        focusZone(Number(event.key) - 1)
      }
      if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        void yieldPort()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

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
      const response = await fetch(api('/api/send'), {
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
      <header class="ribbon" data-zone="ribbon" tabindex="-1" data-tauri-drag-region>
        <h1>BaudForge</h1>
        <span class="chip">contract {feed.snapshot()?.contract ?? '?'}</span>
        <span class={`chip ${feed.link()}`}>{feed.link()}</span>
        <span class="chip">{session()?.mode ?? 'idle'}</span>
        <span class="chip">ports {openPorts()}/{ports().length}</span>
        <Show when={inShell()}>
          <button
            type="button"
            class="chip action"
            title="stop this session and choose another workspace"
            onClick={async () => {
              await stopSession()
              toPicker()
            }}
          >
            session: switch
          </button>
          <button
            type="button"
            class="chip action"
            title="stop recording and keep the window open"
            onClick={async () => {
              await stopSession()
              setYieldNote('session stopped')
            }}
          >
            stop
          </button>
        </Show>
        <button
          type="button"
          class="chip action yield"
          onClick={yieldPort}
          disabled={ports().length === 0}
          title="release the port so a flash tool can use it (Ctrl+Y)"
        >
          yield
        </button>
        <Show when={yieldNote()}>{(note) => <span class="chip">{note()}</span>}</Show>
        <For each={feed.snapshot()?.bridges ?? []}>
          {(bridge) => (
            <span class="chip bridge" classList={{ forward: bridge.forward }}>
              {bridge.forward ? 'bridge' : 'tap'} {bridge.a}↔{bridge.b}
              <Show when={bridge.forward}>
                {' '}
                {bridge.forwarded} B
                <Show when={bridge.dropped > 0}> · dropped {bridge.dropped} B</Show>
              </Show>
            </span>
          )}
        </For>
        <span class="grow" />
        <span class="chip">elapsed {session() ? seconds(session()!.elapsed_ms) : '-'}</span>
        <span class="chip">chunks {session()?.chunks ?? 0}</span>
        <span class="chip">payload {session() ? bytes(session()!.payload_bytes) : '-'}</span>
        <WindowControls />
      </header>

      <aside class="sidebar" data-zone="sidebar" tabindex="-1">
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

      <div class="stage" data-zone="stage" tabindex="-1">
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
            <span class="hint" title="which renderer the band is using">{renderer()}</span>
            <Show when={plotKeys().length > 0} fallback={<span class="hint">No numeric fields yet.</span>}>
              <select
                value=""
                onChange={(event) => {
                  if (event.currentTarget.value) plotField(event.currentTarget.value)
                  event.currentTarget.value = ''
                }}
                aria-label="add a trace"
              >
                <option value="">plot a field…</option>
                <For each={plotKeys().filter((key) => !plottedKeys().includes(key))}>
                  {(key) => <option value={key}>{key}</option>}
                </For>
              </select>
            </Show>
            <div class="traces">
              <For each={plottedKeys()}>
                {(key, index) => (
                  <button
                    type="button"
                    class="trace-chip"
                    style={{ '--trace': SERIES_COLOURS[index() % SERIES_COLOURS.length] }}
                    onClick={() => unplotField(key)}
                    title="remove this trace"
                  >
                    <span class="swatch" />
                    {key}
                  </button>
                )}
              </For>
            </div>
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
              max={Math.max(spanMs(), 1)}
              step={Math.max(1, Math.round(spanMs() / 2000))}
              value={at() ?? Math.max(spanMs(), 0)}
              onInput={(event) => loadWindow(Number(event.currentTarget.value))}
              aria-label="vault time in milliseconds"
            />
            <button type="button" onClick={() => { setAt(null); setWindowRows([]) }} classList={{ active: at() === null }}>
              live
            </button>
            <span class="hint">
              {timelineNote() ??
                (at() === null
                  ? `${(spanMs() / 1000).toFixed(1)} s recorded`
                  : `${(Number(at() ?? 0) / 1000).toFixed(3)} s / ${(spanMs() / 1000).toFixed(1)} s`)}
            </span>
          </div>
          <Show when={traces().length > 0} fallback={<span class="hint"></span>}>
            <Telemetry series={traces()} onRenderer={setRenderer} />
          </Show>
        </section>
      </div>

      <section class="inspector" data-zone="inspector" tabindex="-1">
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
              <Show
                when={detail()!.fields.length > 0}
                fallback={<p class="empty">No schema on this port.</p>}
              >
                <div class="fields">
                  <For each={buildTree(detail()!.fields)}>
                    {(node) => (
                      <FieldNodeRow
                        node={node}
                        port={detail()!.port}
                        onHover={setHovered}
                        onPlot={plotField}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </section>

      <section class="forge" data-zone="forge" tabindex="-1">
        <div class="band-head">
          <h2>Command forge</h2>
          <h2>Fault injector</h2>
        </div>
        <form onSubmit={typed() ? forgeSendTyped : forgeSend}>
          <button
            type="button"
            class="mode"
            classList={{ active: typed() }}
            onClick={() => chooseTyped(!typed())}
            title="send named fields instead of hex"
          >
            {typed() ? 'typed' : 'hex'}
          </button>
          <Show
            when={!typed()}
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
                          value={typedValues()[field.name] ?? ''}
                          onInput={(event) =>
                            setTypedValues((current) => ({
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
              value={hex()}
              onInput={(event) => setHex(event.currentTarget.value)}
              placeholder="AA 55 03"
              spellcheck={false}
              aria-label="bytes to send, in hex"
            />
          </Show>
          <Show when={!typed()}>
          <select value={crc()} onChange={(event) => setCrc(event.currentTarget.value)} aria-label="checksum">
            <option value="">no checksum</option>
            <option value="crc32c">crc32c</option>
            <option value="crc16_ccitt_false">crc16</option>
            <option value="crc8">crc8</option>
          </select>
          </Show>
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
        <Show when={feed.missed() > 0}>
          <span class="sampled" title="the engine replaced batches this client had not read">
            sampled: {feed.missed()} batch(es) not shown
          </span>
        </Show>
      </footer>
    </div>
  )
}
