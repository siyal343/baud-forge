import { For, Show, createMemo, createSignal } from 'solid-js'
import { createFeed } from './lib/feed'
import type { FieldRow, TailRow } from './lib/types'
import './index.css'

const bytes = (value: number) =>
  value < 1000 ? `${value} B` : value < 1e6 ? `${(value / 1e3).toFixed(1)} kB` : `${(value / 1e6).toFixed(1)} MB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clock = (us: number) => `${(us / 1e6).toFixed(4)} s`

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

export default function App() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)

  const session = () => feed.snapshot()?.session
  const ports = () => feed.snapshot()?.ports ?? []
  const shown = createMemo(() => feed.frames().slice(-120).reverse())
  const detail = () => selected() ?? feed.frames().at(-1) ?? null
  const openPorts = () => ports().filter((port) => port.state === 'open').length

  return (
    <div class="shell">
      <header class="ribbon">
        <h1>BaudForge</h1>
        <span class="chip">contract {feed.snapshot()?.contract ?? '?'}</span>
        <span class={`chip ${feed.link()}`}>{feed.link()}</span>
        <span class="chip">{session()?.mode ?? 'idle'}</span>
        <span class="chip">ports {openPorts()}/{ports().length}</span>
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
              <th>len</th>
              <th>hex</th>
              <th>protocol</th>
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
                  <td>{row.len}</td>
                  <td class="hexcell">{row.hex}</td>
                  <td>{row.protocol ?? (row.text ? 'text' : '-')}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </main>

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
