import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js'
import type { FieldRow, SymbolHit, TailRow } from '../lib/types'

export interface InspectorPaneProps {
  row: TailRow | null
  hoveredField: FieldRow | null
  onHoverField: (field: FieldRow | null) => void
  onPlotField: (key: string) => void
  plottedKeys?: string[]
}

export interface HexDumpProps {
  row: TailRow
  field: FieldRow | null
}

/** A node of the inspector's field tree, built from dotted field names. */
export interface FieldNode {
  name: string
  path: string
  field?: FieldRow
  children: FieldNode[]
}

/** Formats a symbol hit to its source file and line (last two path segments). */
export function sourceOf(hit: { file: string | null; line: number | null }): string {
  if (!hit.file) return ''
  const parts = hit.file.replaceAll(String.fromCharCode(92), '/').split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return hit.line ? `${tail}:${hit.line}` : tail
}

/** Extracts the last '::' segment of a symbol name, truncated at 28 chars. */
export function shortName(symbol: string): string {
  const tail = symbol.split('::').filter(Boolean).pop() ?? symbol
  return tail.length > 28 ? `${tail.slice(0, 25)}...` : tail
}

/** Groups dotted field names like 'gains.proportional' under 'gains', keeping array siblings distinct. */
export function buildTree(fields: FieldRow[]): FieldNode[] {
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

export interface FieldNodeRowProps {
  node: FieldNode
  port: string
  onHover: (field: FieldRow | null) => void
  onPlot: (key: string) => void
  plottedKeys?: string[]
}

/** One field of the dissector tree: expandable twisty, name, value, byte offset, and plot trigger. */
export function FieldNodeRow(props: FieldNodeRowProps) {
  const [open, setOpen] = createSignal(true)
  const field = () => props.node.field
  const isPlotted = () => {
    const f = field()
    if (!f || !props.plottedKeys) return false
    const key = `${props.port}.${f.name}`
    return props.plottedKeys.includes(key)
  }

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
        <span class="name" title={props.node.name}>{props.node.name}</span>
        <Show when={field()}>
          {(leaf) => (
            <>
              <span class="value" title={leaf().value}>{leaf().value}</span>
              <span class="at">@{leaf().offset}+{leaf().len}</span>
              <Show when={leaf().value_num !== null}>
                <button
                  type="button"
                  class="plot-this"
                  classList={{ plotted: isPlotted() }}
                  title={isPlotted() ? 'already plotted' : 'plot this field in oscilloscope'}
                  onClick={() => props.onPlot(`${props.port}.${leaf().name}`)}
                >
                  {isPlotted() ? 'plotted' : 'plot'}
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
              <FieldNodeRow
                node={child}
                port={props.port}
                onHover={props.onHover}
                onPlot={props.onPlot}
                plottedKeys={props.plottedKeys}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const HEX_WINDOW_SIZE = 512

/** Canonical 16-Byte Engineering Hex & ASCII Dump with live byte inspection and synchronized field highlight. */
export function HexDump(props: HexDumpProps) {
  const [offset, setOffset] = createSignal(0)
  const [inspectedByte, setInspectedByte] = createSignal<{ index: number; hex: string; val: number } | null>(null)

  const bytes = createMemo(() => (props.row?.hex ? props.row.hex.split(' ').filter(Boolean) : []))

  // Reset offset to 0 when row changes
  createEffect(
    on(
      () => props.row,
      () => {
        setOffset(0)
        setInspectedByte(null)
      },
    ),
  )

  // Automatically snap window to hovered field
  createEffect(
    on(
      () => props.field,
      (field) => {
        if (field != null) {
          const o = field.offset
          const cur = offset()
          if (o < cur || o >= cur + HEX_WINDOW_SIZE) {
            setOffset(Math.floor(o / HEX_WINDOW_SIZE) * HEX_WINDOW_SIZE)
          }
        }
      },
    ),
  )

  const slice = createMemo(() => {
    const all = bytes()
    if (all.length <= HEX_WINDOW_SIZE) {
      return { items: all, baseIndex: 0, total: all.length }
    }
    const start = Math.min(offset(), Math.max(0, all.length - HEX_WINDOW_SIZE))
    const end = Math.min(start + HEX_WINDOW_SIZE, all.length)
    return { items: all.slice(start, end), baseIndex: start, total: all.length }
  })

  const inField = (index: number) =>
    props.field != null && index >= props.field.offset && index < props.field.offset + props.field.len

  // Group items into canonical 16-byte rows
  const rows = createMemo(() => {
    const s = slice()
    const result: { rowOffset: number; cells: { byte: string; index: number; val: number }[] }[] = []
    const count = s.items.length
    for (let i = 0; i < count; i += 16) {
      const rowOffset = s.baseIndex + i
      const chunk = s.items.slice(i, i + 16)
      const cells = chunk.map((b, ci) => {
        const idx = rowOffset + ci
        const val = parseInt(b, 16)
        return { byte: b, index: idx, val: isNaN(val) ? 0 : val }
      })
      result.push({ rowOffset, cells })
    }
    return result
  })

  return (
    <div class="hex-container" onMouseLeave={() => setInspectedByte(null)}>
      <Show when={bytes().length > HEX_WINDOW_SIZE}>
        <div class="hex-nav">
          <button
            type="button"
            class="chip action"
            disabled={slice().baseIndex === 0}
            onClick={() => setOffset((o) => Math.max(0, o - HEX_WINDOW_SIZE))}
            title="show previous 512 bytes"
          >
            ◀ prev
          </button>
          <span class="hint">
            bytes {slice().baseIndex}–{slice().baseIndex + slice().items.length} of {bytes().length}
          </span>
          <button
            type="button"
            class="chip action"
            disabled={slice().baseIndex + slice().items.length >= bytes().length}
            onClick={() => setOffset((o) => o + HEX_WINDOW_SIZE)}
            title="show next 512 bytes"
          >
            next ▶
          </button>
        </div>
      </Show>

      <div class="hex-table hex">
        <For each={rows()}>
          {(r) => (
            <div class="hex-row">
              <span class="hex-offset">
                {r.rowOffset.toString(16).toUpperCase().padStart(4, '0')}
              </span>
              <div class="hex-bytes">
                <For each={Array.from({ length: 16 })}>
                  {(_, ci) => {
                    const cell = r.cells[ci()]
                    if (!cell) {
                      return <span class="byte empty-byte">  </span>
                    }
                    const isHot = () => inField(cell.index) || inspectedByte()?.index === cell.index
                    return (
                      <span
                        class="byte"
                        classList={{
                          hot: isHot(),
                          zero: cell.byte === '00',
                          warn: props.row.decode_error != null,
                        }}
                        onMouseEnter={() => setInspectedByte({ index: cell.index, hex: cell.byte, val: cell.val })}
                        title={`Offset 0x${cell.index.toString(16).toUpperCase()} (${cell.index}) = 0x${cell.byte}`}
                      >
                        {cell.byte}
                      </span>
                    )
                  }}
                </For>
              </div>
              <div class="hex-ascii">
                <For each={Array.from({ length: 16 })}>
                  {(_, ci) => {
                    const cell = r.cells[ci()]
                    if (!cell) {
                      return <span class="ascii-char empty-byte"> </span>
                    }
                    const isPrintable = cell.val >= 32 && cell.val <= 126
                    const char = isPrintable ? String.fromCharCode(cell.val) : '·'
                    const isHot = () => inField(cell.index) || inspectedByte()?.index === cell.index
                    return (
                      <span
                        class="ascii-char"
                        classList={{
                          hot: isHot(),
                          printable: isPrintable,
                        }}
                        onMouseEnter={() => setInspectedByte({ index: cell.index, hex: cell.byte, val: cell.val })}
                        title={`Offset 0x${cell.index.toString(16).toUpperCase()} (${cell.index}) = '${char}'`}
                      >
                        {char}
                      </span>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="byte-inspector-bar">
        <Show
          when={inspectedByte()}
          fallback={
            <Show
              when={props.field}
              fallback={
                <span class="inspect-text">Payload: {bytes().length} bytes  ·  Hover a field or byte to inspect</span>
              }
            >
              {(f) => (
                <span class="inspect-text">
                  Field {f().name}  ·  @{f().offset}+{f().len} B  ·  Value: {f().value}
                </span>
              )}
            </Show>
          }
        >
          {(inspected) => {
            const idx = inspected().index
            const idxHex = idx.toString(16).toUpperCase().padStart(4, '0')
            const hex = inspected().hex.toUpperCase().padStart(2, '0')
            const val = inspected().val
            const bin = val.toString(2).padStart(8, '0')
            const asciiLabel = val >= 32 && val <= 126 ? `'${String.fromCharCode(val)}'` : '·'
            return (
              <span class="inspect-text">
                Offset 0x{idxHex} ({idx})  ·  Hex 0x{hex}  ·  Dec {val}  ·  Bin 0b{bin}  ·  ASCII {asciiLabel}
              </span>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

/** Precision Engineering Packet Dissector and Canonical 16-Byte Hex/ASCII Inspector Pane. */
export function InspectorPane(props: InspectorPaneProps) {
  const row = () => props.row

  return (
    <section class="inspector" data-zone="inspector" tabindex="-1">
      <style>{`
        .inspector {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
          background: var(--bg-surface-1, var(--panel, #111621));
          color: var(--text-primary, var(--text, #edf0f7));
          font-family: var(--font-sans, inherit);
        }
        .inspector .section-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
          background: var(--bg-surface-1, var(--panel, #111621));
          flex-shrink: 0;
        }
        .inspector .section-bar h2 {
          margin: 0;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted, var(--dim, #7c879c));
        }
        .inspector .frame-badge {
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          padding: 2px 7px;
          border-radius: 4px;
          background: var(--bg-surface-2, var(--panel-2, #151b28));
          border: 1px solid var(--border-hairline, var(--line, #1e2638));
          color: var(--text-secondary, var(--dim, #949eb2));
          font-variant-numeric: tabular-nums;
        }
        .inspector .inspector-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 0;
          display: flex;
          flex-direction: column;
        }
        .inspector .frame-summary-card {
          padding: 10px 12px;
          background: var(--bg-surface-2, var(--panel-2, #151b28));
          border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
        }
        .inspector .frame-meta-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px 10px;
        }
        .inspector .meta-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .inspector .meta-label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, var(--dim, #7c879c));
        }
        .inspector .meta-value {
          font-family: var(--font-mono, monospace);
          font-size: 11.5px;
          color: var(--text-primary, var(--text, #edf0f7));
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .inspector .dir-badge {
          display: inline-block;
          font-family: var(--font-mono, monospace);
          font-size: 10.5px;
          font-weight: 600;
          text-transform: uppercase;
          padding: 1px 5px;
          border-radius: 3px;
          width: fit-content;
        }
        .inspector .dir-badge.rx {
          color: var(--sig-rx, var(--valid, #10b981));
          background: var(--sig-rx-dim, rgba(16, 185, 129, 0.12));
        }
        .inspector .dir-badge.tx {
          color: var(--sig-tx, var(--tx, #06b6d4));
          background: var(--sig-tx-dim, rgba(6, 182, 212, 0.14));
        }
        .inspector .decode-error-banner {
          margin: 0;
          padding: 8px 12px;
          color: var(--sig-fault, var(--fault, #ef4444));
          background: var(--sig-fault-dim, rgba(244, 63, 94, 0.12));
          border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
          font-size: 11.5px;
        }
        .inspector .dissector-section, .inspector .hex-section {
          display: flex;
          flex-direction: column;
        }
        .inspector .dissector-section h2, .inspector .hex-section h2 {
          margin: 0;
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted, var(--dim, #7c879c));
          background: var(--bg-surface-1, var(--panel, #111621));
          border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
        }
        .inspector .symbol-callout {
          border-left: 3px solid var(--sig-symbol, #a855f7);
        }
        .inspector .hex-table {
          display: flex;
          flex-direction: column;
          gap: 1px;
          padding: 8px 10px;
          font-family: var(--font-mono, monospace);
          font-size: 11.5px;
          line-height: 1.4;
          background: var(--bg-canvas, var(--bg, #0b0e14));
          user-select: text;
          border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
        }
        .inspector .hex-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 1px 2px;
          border-radius: 2px;
        }
        .inspector .hex-row:hover {
          background: rgba(255, 255, 255, 0.03);
        }
        .inspector .hex-offset {
          color: var(--text-muted, var(--dim, #7c879c));
          font-size: 10.5px;
          user-select: none;
          min-width: 32px;
        }
        .inspector .hex-bytes {
          display: flex;
          gap: 3px;
          align-items: center;
        }
        .inspector .hex-bytes .byte:nth-child(8) {
          margin-right: 6px;
        }
        .inspector .hex-bytes .byte {
          width: 20px;
          text-align: center;
          padding: 1px 0;
          border-radius: 2px;
          color: var(--text-secondary, var(--dim, #949eb2));
          background: var(--bg-surface-2, var(--panel-2, #151b28));
          cursor: pointer;
          transition: background-color 100ms ease, color 100ms ease;
        }
        .inspector .hex-bytes .byte.zero {
          opacity: 0.45;
        }
        .inspector .hex-bytes .byte:hover, .inspector .hex-bytes .byte.hot {
          color: #04121f;
          background: var(--sig-tx, var(--tx, #06b6d4));
          font-weight: 600;
          opacity: 1;
        }
        .inspector .hex-bytes .byte.warn {
          outline: 1px solid var(--sig-fault, var(--fault, #ef4444));
        }
        .inspector .hex-bytes .byte.empty-byte {
          background: transparent;
          cursor: default;
        }
        .inspector .hex-ascii {
          display: flex;
          gap: 1px;
          margin-left: 6px;
          padding-left: 8px;
          border-left: 1px solid var(--border-hairline, var(--line, #1e2638));
          align-items: center;
        }
        .inspector .hex-ascii .ascii-char:nth-child(8) {
          margin-right: 4px;
        }
        .inspector .hex-ascii .ascii-char {
          width: 9px;
          text-align: center;
          color: var(--text-muted, var(--dim, #7c879c));
          cursor: pointer;
          border-radius: 2px;
          user-select: none;
        }
        .inspector .hex-ascii .ascii-char.printable {
          color: var(--text-primary, var(--text, #d5dceb));
        }
        .inspector .hex-ascii .ascii-char:hover, .inspector .hex-ascii .ascii-char.hot {
          color: #04121f;
          background: var(--sig-tx, var(--tx, #06b6d4));
          font-weight: 600;
        }
        .inspector .hex-ascii .ascii-char.empty-byte {
          cursor: default;
        }
        .inspector .byte-inspector-bar {
          padding: 6px 12px;
          font-family: var(--font-mono, monospace);
          font-size: 11px;
          background: var(--bg-surface-2, var(--panel-2, #151b28));
          border-top: 1px solid var(--border-hairline, var(--line, #1e2638));
          color: var(--text-secondary, var(--dim, #949eb2));
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-height: 28px;
          display: flex;
          align-items: center;
        }
        .inspector .plot-this:active {
          transform: scale(0.97);
        }
        .inspector .plot-this.plotted {
          background: var(--sig-rx, var(--valid, #10b981));
          color: #04121f;
          font-weight: 600;
        }
      `}</style>

      <div class="section-bar">
        <h2>Inspector</h2>
        <Show when={row()}>
          {(r) => (
            <span class="frame-badge">
              {r().port} · {r().direction.toLowerCase()} · {r().len} B
            </span>
          )}
        </Show>
      </div>

      <div class="inspector-scroll">
        <Show
          when={row()}
          fallback={
            <p class="empty">Select a frame in the stream to inspect its dissected fields and raw bytes.</p>
          }
        >
          {(r) => (
            <>
              <div class="frame-summary-card">
                <div class="frame-meta-grid">
                  <div class="meta-item">
                    <span class="meta-label">Port</span>
                    <span class="meta-value">{r().port}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Dir</span>
                    <span
                      class="dir-badge"
                      classList={{ rx: r().direction === 'Rx', tx: r().direction !== 'Rx' }}
                    >
                      {r().direction.toLowerCase()}
                    </span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Time</span>
                    <span class="meta-value">{(r().timestamp_us / 1e6).toFixed(4)} s</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Δt</span>
                    <span class="meta-value">{r().delta_us} µs</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Length</span>
                    <span class="meta-value">{r().len} B</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Protocol</span>
                    <span class="meta-value">{r().protocol ?? (r().text ? 'text' : 'raw')}</span>
                  </div>
                </div>
              </div>

              <Show when={r().decode_error}>
                {(error) => <p class="error decode-error-banner">{error()}</p>}
              </Show>

              <Show when={r().text}>
                {(text) => <p class="text">{text()}</p>}
              </Show>

              <Show when={r().symbols.length > 0}>
                <div class="symbols symbol-callout">
                  <dl>
                    <For each={r().symbols}>
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
                </div>
              </Show>

              <div class="dissector-section">
                <h2>Dissected Fields</h2>
                <Show
                  when={r().fields.length > 0}
                  fallback={<p class="empty">No schema on this port.</p>}
                >
                  <div class="fields">
                    <For each={buildTree(r().fields)}>
                      {(node) => (
                        <FieldNodeRow
                          node={node}
                          port={r().port}
                          onHover={props.onHoverField}
                          onPlot={props.onPlotField}
                          plottedKeys={props.plottedKeys}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="hex-section">
                <h2>Hex & ASCII</h2>
                <HexDump row={r()} field={props.hoveredField} />
              </div>
            </>
          )}
        </Show>
      </div>
    </section>
  )
}

export default InspectorPane
