import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Telemetry, SERIES_COLOURS } from './components/Telemetry'
import type { TraceMode } from './components/Telemetry'
import { WindowControls } from './components/WindowControls'
import { createFeed } from './lib/feed'
import { api, exportVault, inShell, stopSession, toPicker } from './lib/shell'
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

const HEX_WINDOW_SIZE = 512

/** Bytes of a frame as separate spans, bounded to a window so large frames do not slow the DOM. */
function HexDump(props: { row: TailRow; field: FieldRow | null }) {
  const [offset, setOffset] = createSignal(0)
  const bytes = createMemo(() => props.row.hex.split(' ').filter(Boolean))

  createEffect(
    on(
      () => props.row,
      () => setOffset(0),
    ),
  )

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

  return (
    <div class="hex-container">
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
      <div class="hex">
        <For each={slice().items}>
          {(byte, i) => {
            const index = () => slice().baseIndex + i()
            return (
              <span
                class="byte"
                classList={{ hot: inField(index()), warn: props.row.decode_error != null }}
                title={`byte ${index()} = 0x${byte}`}
              >
                {byte}
              </span>
            )
          }}
        </For>
      </div>
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

interface PinStep {
  dtr?: boolean
  rts?: boolean
  wait_ms: number
}

const ESP32_BOOT_STEPS: PinStep[] = [
  { dtr: false, rts: true, wait_ms: 50 },
  { dtr: true, rts: false, wait_ms: 50 },
  { dtr: false, rts: false, wait_ms: 0 },
]

function parsePinSteps(text: string): PinStep[] {
  const trimmed = text.trim()
  if (!trimmed) return ESP32_BOOT_STEPS
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as PinStep[]
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // Fall through to text step parser.
    }
  }
  const segments = trimmed.split(/->|;/).map((s) => s.trim()).filter(Boolean)
  const steps: PinStep[] = []
  for (const seg of segments) {
    const step: PinStep = { wait_ms: 0 }
    const parts = seg.split(',').map((p) => p.trim())
    for (const part of parts) {
      const msMatch = part.match(/^(\d+)\s*(?:ms)?$/i)
      if (msMatch) {
        step.wait_ms = parseInt(msMatch[1], 10)
        continue
      }
      const dtrMatch = part.match(/^dtr\s*=\s*(0|1|true|false)$/i)
      if (dtrMatch) {
        step.dtr = dtrMatch[1] === '1' || dtrMatch[1].toLowerCase() === 'true'
        continue
      }
      const rtsMatch = part.match(/^rts\s*=\s*(0|1|true|false)$/i)
      if (rtsMatch) {
        step.rts = rtsMatch[1] === '1' || rtsMatch[1].toLowerCase() === 'true'
        continue
      }
    }
    steps.push(step)
  }
  return steps.length > 0 ? steps : ESP32_BOOT_STEPS
}

interface FieldDiff {
  frame_index: number
  port: string
  field_name: string
  value_a: string
  value_b: string
}

interface Divergence {
  index: number
  timestamp_us_a: number
  timestamp_us_b: number
  port: string
  reason: string
  field_diffs: FieldDiff[]
}

interface DiffReport {
  records_a: number
  records_b: number
  frames_a: number
  frames_b: number
  identical: boolean
  first_divergence: Divergence | null
  changed_fields: FieldDiff[]
  missing_from_a: number
  missing_from_b: number
}

export default function App() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)
  // The traces on screen, in order. A person chooses them, from the picker or the
  // inspector's plot button (the guide's signature interaction).
  // Each trace keeps its own mode: a measurement is a line, a state is a lane, a flags
  // word is a rail per bit.
  const [plotted, setPlotted] = createSignal<{ key: string; mode: TraceMode }[]>([])
  const [hex, setHex] = createSignal('AA 55 03')
  const [crc, setCrc] = createSignal('')
  const [chunkSize, setChunkSize] = createSignal('')
  const [paceMs, setPaceMs] = createSignal('')
  const [typed, setTyped] = createSignal(false)
  const [typedValues, setTypedValues] = createSignal<Record<string, string>>({})
  const [answer, setAnswer] = createSignal<string | null>(null)
  const [sent, setSent] = createSignal<string[]>([])
  const [seqPort, setSeqPort] = createSignal<string | null>(null)
  const [customSeqText, setCustomSeqText] = createSignal('')
  const [showDiff, setShowDiff] = createSignal(false)
  const [diffPathA, setDiffPathA] = createSignal('')
  const [diffPathB, setDiffPathB] = createSignal('')
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [diffError, setDiffError] = createSignal<string | null>(null)
  const [diffReport, setDiffReport] = createSignal<DiffReport | null>(null)
  const [faultKind, setFaultKind] = createSignal('off')
  const [faultValue, setFaultValue] = createSignal('1.0')
  const [faultLine, setFaultLine] = createSignal<string | null>(null)
  // Scrubbing: null means live. A number is a record ordinal in the vault.
  const [at, setAt] = createSignal<number | null>(null)
  const [windowRows, setWindowRows] = createSignal<TailRow[]>([])
  // The vault's span, in milliseconds: what a timeline drags along.
  const [spanMs, setSpanMs] = createSignal(0)
  // Playback: a timeline that advances on its own, at a chosen rate.
  const [playing, setPlaying] = createSignal(false)
  const [rate, setRate] = createSignal(1)
  // A paired bus: one bridge's two ports, merged by time (spec 0029).
  // `null` follows the workspace: one bridge means one bus, no choice to make.
  const [bridge, setBridge] = createSignal<string | null>(null)
  // Which renderer the band got: WebGL when the machine has it, canvas otherwise.
  const [renderer, setRenderer] = createSignal<'webgl' | 'canvas'>('canvas')
  // One row per measurement when a person wants two magnitudes read at once.
  const [stackRows, setStackRows] = createSignal(false)
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
    const chosen = plotted().filter((entry) => plotKeys().includes(entry.key))
    if (chosen.length > 0) return chosen
    return plotKeys().slice(0, 1).map((key) => ({ key, mode: 'line' as TraceMode }))
  })

  function plotField(key: string, mode: TraceMode = 'line') {
    setPlotted((current) =>
      current.some((entry) => entry.key === key)
        ? current
        : [...current, { key, mode }].slice(-6),
    )
  }

  function unplotField(key: string) {
    setPlotted((current) => current.filter((entry) => entry.key !== key))
  }

  /** Cycle a trace between a line, a state lane and a rail per bit. */
  function cycleMode(key: string) {
    const order: TraceMode[] = ['line', 'lane', 'bits']
    setPlotted((current) =>
      current.map((entry) =>
        entry.key === key
          ? { key, mode: order[(order.indexOf(entry.mode) + 1) % order.length] }
          : entry,
      ),
    )
  }

  const ROW_HEIGHT = 26
  const OVERSCAN = 8

  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(500)
  const [follow, setFollow] = createSignal(true)
  let viewportRef: HTMLDivElement | undefined

  const session = () => feed.snapshot()?.session
  const ports = () => feed.snapshot()?.ports ?? []
  const allRows = createMemo(() => {
    const all = at() === null ? feed.frames() : windowRows()
    const pair = bridgePorts()
    const filtered = pair ? all.filter((row) => pair.includes(row.port)) : all
    return pair ? [...filtered].sort((left, right) => left.timestamp_us - right.timestamp_us) : filtered
  })
  const rows = allRows

  const totalRows = createMemo(() => allRows().length)

  const startIndex = createMemo(() => {
    const top = scrollTop()
    const raw = Math.floor(top / ROW_HEIGHT)
    return Math.max(0, raw - OVERSCAN)
  })

  const endIndex = createMemo(() => {
    const top = scrollTop()
    const height = viewportHeight()
    const raw = Math.ceil((top + height) / ROW_HEIGHT)
    return Math.min(totalRows(), raw + OVERSCAN)
  })

  const topSpacer = createMemo(() => startIndex() * ROW_HEIGHT)
  const bottomSpacer = createMemo(() => Math.max(0, (totalRows() - endIndex()) * ROW_HEIGHT))

  const visibleRows = createMemo(() => allRows().slice(startIndex(), endIndex()))

  function jumpToLive() {
    if (at() !== null) {
      stopPlayback()
      setAt(null)
      setWindowRows([])
    }
    setFollow(true)
    if (viewportRef) {
      viewportRef.scrollTop = viewportRef.scrollHeight
    }
  }

  function onViewportScroll() {
    if (!viewportRef) return
    const currentTop = viewportRef.scrollTop
    const currentHeight = viewportRef.clientHeight
    const currentScrollHeight = viewportRef.scrollHeight
    setScrollTop(currentTop)
    setViewportHeight(currentHeight)

    const distanceToBottom = currentScrollHeight - currentTop - currentHeight
    const atBottom = distanceToBottom <= ROW_HEIGHT + 4
    if (atBottom !== follow()) {
      setFollow(atBottom)
    }
  }

  createEffect(
    on(
      totalRows,
      (count) => {
        if (at() === null && follow() && viewportRef && count > 0) {
          requestAnimationFrame(() => {
            if (at() === null && follow() && viewportRef) {
              viewportRef.scrollTop = viewportRef.scrollHeight
            }
          })
        }
      },
      { defer: true },
    ),
  )

  let ro: ResizeObserver | undefined
  onMount(() => {
    if (viewportRef) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setViewportHeight(entry.contentRect.height)
        }
      })
      ro.observe(viewportRef)
      setViewportHeight(viewportRef.clientHeight)
      if (follow()) {
        viewportRef.scrollTop = viewportRef.scrollHeight
      }
    }
  })
  onCleanup(() => {
    ro?.disconnect()
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

  onCleanup(() => stopPlayback())

  const traces = createMemo(() =>
    plottedKeys().map((entry) => ({ key: entry.key, mode: entry.mode, values: seriesFor(entry.key) })),
  )

  const [timelineNote, setTimelineNote] = createSignal<string | null>(null)
  let playTimer: ReturnType<typeof setInterval> | undefined
  let playFrom = 0
  let playClock = 0
  let lastFetch = 0

  function stopPlayback() {
    if (playTimer !== undefined) clearInterval(playTimer)
    playTimer = undefined
    setPlaying(false)
  }

  /** Advance the window through the recording without asking for every frame. */
  function play() {
    if (spanMs() <= 0) {
      setTimelineNote('nothing recorded yet')
      return
    }
    const start = at() ?? 0
    playFrom = start >= spanMs() ? 0 : start
    playClock = performance.now()
    lastFetch = 0
    setPlaying(true)
    setTimelineNote(null)
    playTimer = setInterval(() => {
      const now = performance.now()
      const next = playFrom + (now - playClock) * rate()
      if (next >= spanMs()) {
        stopPlayback()
        void loadWindow(spanMs())
        return
      }
      setAt(next)
      // A window every 300 ms is what a person can read; more would be work for nothing.
      if (now - lastFetch >= 300) {
        lastFetch = now
        void loadWindow(next)
      }
    }, 60)
  }

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
    if (sharedPlot) {
      setPlotted(
        sharedPlot
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            const [key, mode] = item.split(':')
            return { key, mode: (mode as TraceMode) ?? 'line' }
          }),
      )
    }
    const shared = params.get('at')
    if (params.get('rows') === 'stack') setStackRows(true)
    const autoPlay = params.get('play') === '1'
    const autoExport = params.get('export')
    const reviewing = params.get('review') === '1'
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

    if (reviewing) {
      // A finished recording has nowhere to stream to, so open at its end. The duration
      // comes from the vault itself: the three-second poll would land at a stale end.
      void (async () => {
        try {
          const response = await fetch(api('/api/vault'))
          if (!response.ok) return
          const body = (await response.json()) as { duration_ms?: number }
          const end = body.duration_ms ?? 0
          if (end <= 0) return
          setSpanMs(end)
          setAt(end)
          void loadWindow(end)
        } catch {
          // A review of a damaged vault keeps the timeline at zero.
        }
      })()
    }

    if (autoExport) {
      // Record for a moment, then save: `--query "export=csv"` makes one launch a file.
      const save = setTimeout(() => void saveExport(autoExport), 4000)
      onCleanup(() => clearTimeout(save))
    }

    if (autoPlay) {
      // Wait for a span worth playing rather than starting against an empty vault.
      // Ten seconds of recording is the shortest that is worth playing from the start.
      const wait = setInterval(() => {
        if (spanMs() < 10_000) return
        clearInterval(wait)
        play()
      }, 200)
      onCleanup(() => clearInterval(wait))
    }
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
    const body: {
      port: string
      values: Record<string, number | string>
      chunk_size?: number
      pace_ms?: number
    } = { port, values }
    const chunkVal = parseInt(chunkSize(), 10)
    if (!isNaN(chunkVal) && chunkVal > 0) body.chunk_size = chunkVal
    const paceVal = parseInt(paceMs(), 10)
    if (!isNaN(paceVal) && paceVal > 0) body.pace_ms = paceVal
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
        const paceSuffix = body.chunk_size ? ` (paced ${body.chunk_size}B/${body.pace_ms ?? 0}ms)` : ''
        setSent((current) =>
          [`${new Date().toLocaleTimeString()}  ${port}  ${sentBytes} B  typed${paceSuffix}`]
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
  const [exportNote, setExportNote] = createSignal<string | null>(null)
  const [pinNote, setPinNote] = createSignal<string | null>(null)

  async function drivePins(port: string, dtr: boolean, rts: boolean, pulseMs?: number) {
    try {
      const response = await fetch(api('/api/pins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, dtr, rts, pulse_ms: pulseMs ?? null }),
      })
      if (!response.ok) setPinNote(`${response.status} ${await response.text()}`)
      else setPinNote(pulseMs ? `${port} pulsed for ${pulseMs} ms` : `${port} dtr ${dtr ? 'on' : 'off'}`)
    } catch (error) {
      setPinNote(String(error))
    }
  }

  async function drivePinSequence(port: string, steps: PinStep[]) {
    try {
      const response = await fetch(api('/api/pins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, steps }),
      })
      if (!response.ok) {
        setPinNote(`${response.status} ${await response.text()}`)
      } else {
        setPinNote(`${port} seq (${steps.length} steps) done`)
      }
    } catch (error) {
      setPinNote(String(error))
    }
  }

  async function runDiff(event?: SubmitEvent) {
    if (event) event.preventDefault()
    const b = diffPathB().trim()
    if (!b) return
    const a = diffPathA().trim()
    setDiffLoading(true)
    setDiffError(null)
    setDiffReport(null)
    try {
      let url = `/api/diff?b=${encodeURIComponent(b)}`
      if (a) {
        url += `&a=${encodeURIComponent(a)}`
      }
      const response = await fetch(api(url))
      if (!response.ok) {
        const errText = await response.text()
        try {
          const parsed = JSON.parse(errText) as { error?: string }
          setDiffError(parsed.error ?? `${response.status} ${errText}`)
        } catch {
          setDiffError(`${response.status} ${errText}`)
        }
      } else {
        const report = (await response.json()) as DiffReport
        setDiffReport(report)
      }
    } catch (error) {
      setDiffError(String(error))
    } finally {
      setDiffLoading(false)
    }
  }
  const [exporting, setExporting] = createSignal(false)

  async function saveExport(format: string) {
    if (!format || exporting()) return
    setExporting(true)
    setExportNote('writing…')
    try {
      const path = await exportVault(format)
      // The browser saves the file itself and reports nothing here.
      setExportNote(path ? `wrote ${path}` : `saving ${format}`)
    } catch (error) {
      setExportNote(String(error))
    } finally {
      setExporting(false)
    }
  }

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
    const body: {
      port: string
      hex: string
      crc?: string
      chunk_size?: number
      pace_ms?: number
    } = { port, hex: hex() }
    if (crc()) body.crc = crc()
    const chunkVal = parseInt(chunkSize(), 10)
    if (!isNaN(chunkVal) && chunkVal > 0) body.chunk_size = chunkVal
    const paceVal = parseInt(paceMs(), 10)
    if (!isNaN(paceVal) && paceVal > 0) body.pace_ms = paceVal
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
        const paceSuffix = body.chunk_size ? ` (paced ${body.chunk_size}B/${body.pace_ms ?? 0}ms)` : ''
        setSent((current) =>
          [`${new Date().toLocaleTimeString()}  ${port}  ${sentBytes} B  ${hex()}${paceSuffix}`].concat(current).slice(0, 6),
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
        <select
          class="chip action export"
          disabled={exporting() || !session()}
          title="save the vault as a file"
          value=""
          onChange={(event) => {
            const format = event.currentTarget.value
            event.currentTarget.value = ''
            void saveExport(format)
          }}
        >
          <option value="">export…</option>
          <option value="csv">CSV</option>
          <option value="jsonl">JSON Lines</option>
          <option value="saleae">Saleae CSV</option>
          <option value="pcapng">PCAPNG</option>
        </select>
        <button
          type="button"
          class="chip action diff-toggle"
          classList={{ on: showDiff() }}
          title="compare session vault against another recording"
          onClick={() => setShowDiff((cur) => !cur)}
        >
          diff
        </button>
        <Show when={yieldNote()}>{(note) => <span class="chip">{note()}</span>}</Show>
        <Show when={exportNote()}>{(note) => <span class="chip export-note">{note()}</span>}</Show>
        <Show when={pinNote()}>{(note) => <span class="chip">{note()}</span>}</Show>
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
        <Show when={showDiff()}>
          <div class="diff-panel">
            <form class="diff-form" onSubmit={runDiff}>
              <span class="diff-title">diff</span>
              <input
                class="diff-input"
                value={diffPathA()}
                onInput={(event) => setDiffPathA(event.currentTarget.value)}
                placeholder={session()?.vault ? `a: ${session()!.vault}` : 'vault a (defaults to active)'}
                title="vault a path (leave blank to use active session vault)"
              />
              <span class="diff-sep">vs</span>
              <input
                class="diff-input"
                value={diffPathB()}
                onInput={(event) => setDiffPathB(event.currentTarget.value)}
                placeholder="vault b path (required)"
                title="comparison vault b path"
                required
              />
              <button type="submit" class="chip action" disabled={diffLoading() || !diffPathB().trim()}>
                {diffLoading() ? 'comparing…' : 'compare'}
              </button>
              <button
                type="button"
                class="chip action close"
                onClick={() => {
                  setShowDiff(false)
                  setDiffReport(null)
                  setDiffError(null)
                }}
                title="close diff panel"
              >
                ✕
              </button>
            </form>
            <Show when={diffError()}>
              {(err) => <p class="diff-error">diff error: {err()}</p>}
            </Show>
            <Show when={diffReport()}>
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
                      <div class="diff-first-divergence">
                        <strong>first divergence:</strong> record #{div().index} on port {div().port}
                        {' '}(t_a: {clock(div().timestamp_us_a)}, t_b: {clock(div().timestamp_us_b)})
                        <span class="divergence-reason"> — {div().reason}</span>
                      </div>
                    )}
                  </Show>
                  <Show when={report().changed_fields.length > 0}>
                    <div class="diff-table-wrap">
                      <table class="diff-table">
                        <thead>
                          <tr>
                            <th>frame</th>
                            <th>port</th>
                            <th>field</th>
                            <th>value in a</th>
                            <th>value in b</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={report().changed_fields}>
                            {(field) => (
                              <tr>
                                <td>{field.frame_index}</td>
                                <td>{field.port}</td>
                                <td class="field-name">{field.field_name}</td>
                                <td class="val-a">{field.value_a}</td>
                                <td class="val-b">{field.value_b}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
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
                <div class="pins">
                  <button
                    type="button"
                    class="pin"
                    classList={{ on: port.pins.dtr }}
                    title="drive DTR, which resets most boards"
                    onClick={() => drivePins(port.id, !port.pins.dtr, port.pins.rts)}
                  >
                    dtr
                  </button>
                  <button
                    type="button"
                    class="pin"
                    classList={{ on: port.pins.rts }}
                    title="drive RTS"
                    onClick={() => drivePins(port.id, port.pins.dtr, !port.pins.rts)}
                  >
                    rts
                  </button>
                  <button
                    type="button"
                    class="pin pulse"
                    title="pulse DTR for 100 ms: reset the board"
                    onClick={() => drivePins(port.id, true, port.pins.rts, 100)}
                  >
                    pulse
                  </button>
                  <button
                    type="button"
                    class="pin seq"
                    title="run standard ESP32/STM32 bootloader reset sequence"
                    onClick={() => drivePinSequence(port.id, ESP32_BOOT_STEPS)}
                  >
                    boot seq
                  </button>
                  <button
                    type="button"
                    class="pin seq-toggle"
                    classList={{ on: seqPort() === port.id }}
                    title="toggle custom pin sequence editor"
                    onClick={() => setSeqPort(seqPort() === port.id ? null : port.id)}
                  >
                    {seqPort() === port.id ? 'seq ▴' : 'seq ▾'}
                  </button>
                </div>
                <Show when={seqPort() === port.id}>
                  <div class="pin-seq-form">
                    <input
                      class="pin-seq-input"
                      value={customSeqText()}
                      onInput={(e) => setCustomSeqText(e.currentTarget.value)}
                      placeholder="DTR=0,RTS=1,50ms -> DTR=1,RTS=0,50ms -> DTR=0,RTS=0"
                      aria-label="custom pin sequence"
                      title="Sequence steps: DTR=0,RTS=1,50ms -> DTR=1,RTS=0,50ms or JSON array"
                    />
                    <button
                      type="button"
                      class="pin pulse"
                      title="execute custom pin sequence"
                      onClick={() => drivePinSequence(port.id, parsePinSteps(customSeqText()))}
                    >
                      run
                    </button>
                  </div>
                </Show>
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
            <div class="stream-actions">
              <span class="hint">
                {totalRows() === 0
                  ? '0 frames'
                  : `rows ${startIndex() + 1}–${Math.min(endIndex(), totalRows())} of ${totalRows()} (${feed.received()} rx)`}
              </span>
              <button
                type="button"
                class="chip action"
                classList={{ on: follow() }}
                onClick={() => {
                  if (!follow()) jumpToLive()
                  else setFollow(false)
                }}
                title={follow() ? 'following live stream (click to pause)' : 'stream paused (click to follow live)'}
              >
                {follow() ? '● follow' : 'jump to live'}
              </button>
            </div>
          </div>
          <div class="stream-viewport" ref={viewportRef} onScroll={onViewportScroll}>
            <table>
              <colgroup>
                <col style={{ width: '85px' }} />
                <col style={{ width: '65px' }} />
                <col style={{ width: '65px' }} />
                <col style={{ width: '45px' }} />
                <col style={{ width: '50px' }} />
                <col style={{ width: '340px' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: 'auto' }} />
              </colgroup>
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
                <Show when={totalRows() === 0}>
                  <tr><td colSpan={8} class="empty">Waiting for frames.</td></tr>
                </Show>
                <Show when={topSpacer() > 0}>
                  <tr
                    class="spacer"
                    style={{
                      height: `${topSpacer()}px`,
                    }}
                  >
                    <td
                      colSpan={8}
                      style={{
                        height: `${topSpacer()}px`,
                        padding: '0',
                        border: '0',
                        margin: '0',
                        'line-height': '0',
                        'font-size': '0',
                      }}
                    />
                  </tr>
                </Show>
                <For each={visibleRows()}>
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
                <Show when={bottomSpacer() > 0}>
                  <tr
                    class="spacer"
                    style={{
                      height: `${bottomSpacer()}px`,
                    }}
                  >
                    <td
                      colSpan={8}
                      style={{
                        height: `${bottomSpacer()}px`,
                        padding: '0',
                        border: '0',
                        margin: '0',
                        'line-height': '0',
                        'font-size': '0',
                      }}
                    />
                  </tr>
                </Show>
              </tbody>
            </table>
          </div>
        </main>

        <section class="plot-band">
          <div class="stream-head">
            <h2>Telemetry</h2>
            <button
              type="button"
              class="chip action"
              classList={{ on: stackRows() }}
              onClick={() => setStackRows(!stackRows())}
              title="one row per measurement, each with its own scale"
            >
              {stackRows() ? 'rows: stacked' : 'rows: 1'}
            </button>
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
                <option value="">plot a field… ({plotKeys().length})</option>
                <For each={plotKeys().filter((key) => !plottedKeys().some((entry) => entry.key === key))}>
                  {(key) => <option value={key}>{key}</option>}
                </For>
              </select>
            </Show>
            <div class="traces">
              <For each={plottedKeys()}>
                {(entry, index) => (
                  <span class="trace-chip" style={{ '--trace': SERIES_COLOURS[index() % SERIES_COLOURS.length] }}>
                    <span class="swatch" />
                    <span class="trace-key">{entry.key}</span>
                    <button
                      type="button"
                      class="trace-mode"
                      onClick={() => cycleMode(entry.key)}
                      title="switch between a line, a state lane and a rail per bit"
                    >
                      {entry.mode}
                    </button>
                    <button
                      type="button"
                      class="trace-remove"
                      onClick={() => unplotField(entry.key)}
                      title="remove this trace"
                    >
                      ×
                    </button>
                  </span>
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
            <button
              type="button"
              class="transport"
              onClick={() => (playing() ? stopPlayback() : play())}
              title={playing() ? 'pause the recording' : 'play the recording'}
            >
              {playing() ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              class="transport"
              onClick={() => {
                setRate(rate() === 1 ? 2 : rate() === 2 ? 4 : 1)
                if (playing()) {
                  playFrom = at() ?? 0
                  playClock = performance.now()
                }
              }}
              title="playback rate"
            >
              {rate()}x
            </button>
            <button type="button" onClick={() => { stopPlayback(); setAt(null); setWindowRows([]); jumpToLive() }} classList={{ active: at() === null }}>
              live
            </button>
            <button
              type="button"
              class="transport diff-transport"
              classList={{ active: showDiff() }}
              title="compare session vault with another recording"
              onClick={() => setShowDiff((cur) => !cur)}
            >
              diff
            </button>
            <span class="hint">
              {timelineNote() ??
                (at() === null
                  ? `${(spanMs() / 1000).toFixed(1)} s recorded`
                  : `${(Number(at() ?? 0) / 1000).toFixed(3)} s / ${(spanMs() / 1000).toFixed(1)} s`)}
            </span>
          </div>
          <Show when={traces().length > 0} fallback={<span class="hint"></span>}>
            <Telemetry series={traces()} stack={stackRows()} onRenderer={setRenderer} />
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
                        onPlot={(key) => plotField(key)}
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
          <input
            class="narrow"
            value={chunkSize()}
            onInput={(event) => setChunkSize(event.currentTarget.value)}
            placeholder="chunk B"
            aria-label="chunk size in bytes"
            title="chunk size in bytes for paced send"
          />
          <input
            class="narrow"
            value={paceMs()}
            onInput={(event) => setPaceMs(event.currentTarget.value)}
            placeholder="pace ms"
            aria-label="delay between chunks in milliseconds"
            title="delay between chunks in milliseconds"
          />
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
