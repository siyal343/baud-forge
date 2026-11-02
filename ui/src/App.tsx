import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Telemetry, SERIES_COLOURS } from './components/Telemetry'
import type { TraceMode } from './components/Telemetry'
import { WindowControls } from './components/WindowControls'
import { InspectorPane, sourceOf, shortName } from './components/InspectorPane'
import { CommandPalette } from './components/CommandPalette'
import type { CommandAction } from './components/CommandPalette'
import { createFeed } from './lib/feed'
import { api, exportVault, inShell, stopSession, toPicker } from './lib/shell'
import type { FieldRow, TailRow } from './lib/types'
import './index.css'

const bytes = (value: number) =>
  value < 1000 ? `${value} B` : value < 1e6 ? `${(value / 1e3).toFixed(1)} kB` : `${(value / 1e6).toFixed(1)} MB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clock = (us: number) => `${(us / 1e6).toFixed(4)} s`

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

interface SentEntry {
  id: string
  time: string
  port: string
  bytes: number
  summary: string
  hex: string
  isTyped: boolean
  typedValues?: Record<string, string>
  crc?: string
  chunkSize?: string
  paceMs?: string
}

export default function App() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)
  const [plotted, setPlotted] = createSignal<{ key: string; mode: TraceMode }[]>([])
  const [hex, setHex] = createSignal('AA 55 03')
  const [crc, setCrc] = createSignal('')
  const [chunkSize, setChunkSize] = createSignal('')
  const [paceMs, setPaceMs] = createSignal('')
  const [typed, setTyped] = createSignal(false)
  const [typedValues, setTypedValues] = createSignal<Record<string, string>>({})
  const [answer, setAnswer] = createSignal<string | null>(null)
  const [sentHistory, setSentHistory] = createSignal<SentEntry[]>([])
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

  // Stream Filtering State Signals
  const [portFilter, setPortFilter] = createSignal<string>('all')
  const [dirFilter, setDirFilter] = createSignal<'all' | 'rx' | 'tx'>('all')
  const [kindFilter, setKindFilter] = createSignal<'all' | 'errors' | 'symbols'>('all')
  const [searchQuery, setSearchQuery] = createSignal('')

  // Bottom Workbench Console State Signals
  const [consoleTab, setConsoleTab] = createSignal<'forge' | 'diff' | 'events'>('forge')
  const [consoleCollapsed, setConsoleCollapsed] = createSignal(false)
  const [targetPort, setTargetPort] = createSignal<string>('')
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  // Timeline & Playback
  const [at, setAt] = createSignal<number | null>(null)
  const [windowRows, setWindowRows] = createSignal<TailRow[]>([])
  const [spanMs, setSpanMs] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [rate, setRate] = createSignal(1)
  const [bridge, setBridge] = createSignal<string | null>(null)
  const [renderer, setRenderer] = createSignal<'webgl' | 'canvas'>('canvas')
  const [stackRows, setStackRows] = createSignal(false)
  const [timelineNote, setTimelineNote] = createSignal<string | null>(null)
  const [yieldNote, setYieldNote] = createSignal<string | null>(null)
  const [exportNote, setExportNote] = createSignal<string | null>(null)
  const [pinNote, setPinNote] = createSignal<string | null>(null)
  const [exporting, setExporting] = createSignal(false)

  const bytesOf = (text: string) =>
    text.replace(/0x/gi, '').replace(/[\s:,]/g, '').length / 2

  const session = () => feed.snapshot()?.session
  const ports = () => feed.snapshot()?.ports ?? []
  const bridges = () => feed.snapshot()?.bridges ?? []
  const openPorts = () => ports().filter((port) => port.state === 'open').length

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
  let searchInputRef: HTMLInputElement | undefined

  // Base rows from live feed or vault window
  const rawRows = createMemo(() => {
    const all = at() === null ? feed.frames() : windowRows()
    const pair = bridgePorts()
    const filtered = pair ? all.filter((row) => pair.includes(row.port)) : all
    return pair ? [...filtered].sort((left, right) => left.timestamp_us - right.timestamp_us) : filtered
  })

  // Filtered rows for 10,000-frame buffer stream
  const allRows = createMemo(() => {
    let list = rawRows()
    const pFilter = portFilter()
    if (pFilter !== 'all') {
      list = list.filter((row) => row.port === pFilter)
    }
    const dFilter = dirFilter()
    if (dFilter === 'rx') {
      list = list.filter((row) => row.direction.toLowerCase() === 'rx')
    } else if (dFilter === 'tx') {
      list = list.filter((row) => row.direction.toLowerCase() !== 'rx')
    }
    const kFilter = kindFilter()
    if (kFilter === 'errors') {
      list = list.filter((row) => row.decode_error != null)
    } else if (kFilter === 'symbols') {
      list = list.filter((row) => row.symbols.length > 0)
    }
    const q = searchQuery().trim().toLowerCase()
    if (q) {
      list = list.filter((row) => {
        if (row.hex.toLowerCase().includes(q)) return true
        if (row.text && row.text.toLowerCase().includes(q)) return true
        if (row.protocol && row.protocol.toLowerCase().includes(q)) return true
        if (row.port.toLowerCase().includes(q)) return true
        if (row.decode_error && row.decode_error.toLowerCase().includes(q)) return true
        if (row.fields.some((f) => f.name.toLowerCase().includes(q) || f.value.toLowerCase().includes(q))) return true
        if (
          row.symbols.some(
            (s) =>
              s.field.toLowerCase().includes(q) ||
              s.function.toLowerCase().includes(q) ||
              (s.file && s.file.toLowerCase().includes(q)),
          )
        ) {
          return true
        }
        return false
      })
    }
    return list
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

  let playTimer: ReturnType<typeof setInterval> | undefined
  let playFrom = 0
  let playClock = 0
  let lastFetch = 0

  function stopPlayback() {
    if (playTimer !== undefined) clearInterval(playTimer)
    playTimer = undefined
    setPlaying(false)
  }

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
      if (now - lastFetch >= 300) {
        lastFetch = now
        void loadWindow(next)
      }
    }, 60)
  }

  async function loadWindow(record: number) {
    setAt(record)
    try {
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
    if (params.get('typed') === '1') chooseTyped(true)

    void refreshSpan()
    if (shared !== null) void loadWindow(Number(shared))
    const timer = setInterval(() => {
      if (at() === null) void refreshSpan()
    }, 3000)
    onCleanup(() => clearInterval(timer))

    if (reviewing) {
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
      const save = setTimeout(() => void saveExport(autoExport), 4000)
      onCleanup(() => clearTimeout(save))
    }

    if (autoPlay) {
      const wait = setInterval(() => {
        if (spanMs() < 10_000) return
        clearInterval(wait)
        play()
      }, 200)
      onCleanup(() => clearInterval(wait))
    }
  })

  const detail = () => selected() ?? rows().at(-1) ?? null

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

  async function doSendHex(
    port: string,
    hexVal: string,
    crcVal?: string,
    chunkValStr?: string,
    paceValStr?: string,
  ) {
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
    } = { port, hex: hexVal }
    if (crcVal) body.crc = crcVal
    const chunkVal = parseInt(chunkValStr ?? '', 10)
    if (!isNaN(chunkVal) && chunkVal > 0) body.chunk_size = chunkVal
    const paceVal = parseInt(paceValStr ?? '', 10)
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
        const newEntry: SentEntry = {
          id: Math.random().toString(36).slice(2),
          time: new Date().toLocaleTimeString(),
          port,
          bytes: sentBytes,
          summary: `${hexVal}${paceSuffix}`,
          hex: hexVal,
          isTyped: false,
          crc: crcVal,
          chunkSize: chunkValStr,
          paceMs: paceValStr,
        }
        setSentHistory((current) => [newEntry, ...current].slice(0, 10))
      }
    } catch (error) {
      setAnswer(String(error))
    }
  }

  async function doSendTyped(
    port: string,
    fieldValues: Record<string, string>,
    chunkValStr?: string,
    paceValStr?: string,
  ) {
    if (!port) {
      setAnswer('no port in this workspace')
      return
    }
    const values: Record<string, number | string> = {}
    for (const [name, text] of Object.entries(fieldValues)) {
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
    const chunkVal = parseInt(chunkValStr ?? '', 10)
    if (!isNaN(chunkVal) && chunkVal > 0) body.chunk_size = chunkVal
    const paceVal = parseInt(paceValStr ?? '', 10)
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
        const newEntry: SentEntry = {
          id: Math.random().toString(36).slice(2),
          time: new Date().toLocaleTimeString(),
          port,
          bytes: sentBytes,
          summary: `typed${paceSuffix}`,
          hex: '',
          isTyped: true,
          typedValues: { ...fieldValues },
          chunkSize: chunkValStr,
          paceMs: paceValStr,
        }
        setSentHistory((current) => [newEntry, ...current].slice(0, 10))
      }
    } catch (error) {
      setAnswer(String(error))
    }
  }

  async function forgeSend(event: SubmitEvent) {
    event.preventDefault()
    const port = targetPort() || ports()[0]?.id || ''
    await doSendHex(port, hex(), crc(), chunkSize(), paceMs())
  }

  async function forgeSendTyped(event: SubmitEvent) {
    event.preventDefault()
    const port = targetPort() || ports()[0]?.id || ''
    await doSendTyped(port, typedValues(), chunkSize(), paceMs())
  }

  async function replaySent(entry: SentEntry) {
    setTargetPort(entry.port)
    if (entry.isTyped && entry.typedValues) {
      setTyped(true)
      setTypedValues({ ...entry.typedValues })
      if (entry.chunkSize !== undefined) setChunkSize(entry.chunkSize)
      if (entry.paceMs !== undefined) setPaceMs(entry.paceMs)
      await doSendTyped(entry.port, entry.typedValues, entry.chunkSize, entry.paceMs)
    } else {
      setTyped(false)
      setHex(entry.hex)
      if (entry.crc !== undefined) setCrc(entry.crc)
      if (entry.chunkSize !== undefined) setChunkSize(entry.chunkSize)
      if (entry.paceMs !== undefined) setPaceMs(entry.paceMs)
      await doSendHex(entry.port, entry.hex, entry.crc, entry.chunkSize, entry.paceMs)
    }
  }

  async function armFault(event: SubmitEvent) {
    event.preventDefault()
    const port = targetPort() || ports()[0]?.id || ''
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
    if (faultKind() === 'delay') body.delay_ms = Number.isFinite(value) ? value : 50
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

  async function disarmFaults() {
    const port = targetPort() || ports()[0]?.id || ''
    if (!port) return
    setFaultKind('off')
    try {
      const response = await fetch(api('/api/fault'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, kind: 'off' }),
      })
      setFaultLine(`${response.status} ${await response.text()}`)
    } catch (error) {
      setFaultLine(String(error))
    }
  }

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

  async function saveExport(format: string) {
    if (!format || exporting()) return
    setExporting(true)
    setExportNote('writing…')
    try {
      const path = await exportVault(format)
      setExportNote(path ? `wrote ${path}` : `saving ${format}`)
    } catch (error) {
      setExportNote(String(error))
    } finally {
      setExporting(false)
    }
  }

  async function yieldPort() {
    const port = targetPort() || ports().find((candidate) => candidate.state === 'open')?.id || ports()[0]?.id
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
    const selector = `[data-zone="${zones[index] ?? 'ribbon'}"]`
    document.querySelector<HTMLElement>(selector)?.focus()
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      // Command palette: Ctrl+K or Cmd+K
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((prev) => !prev)
        return
      }

      // Quick filter search focus: "/" when not in input
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const active = document.activeElement
        const isInput =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement
        if (!isInput && searchInputRef) {
          event.preventDefault()
          searchInputRef.focus()
          searchInputRef.select()
          return
        }
      }

      // Stream row selection: ArrowUp / ArrowDown when not in input
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const active = document.activeElement
        const isInput =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement
        if (!isInput && !paletteOpen()) {
          const currentList = allRows()
          if (currentList.length > 0) {
            event.preventDefault()
            const cur = detail()
            const idx = cur
              ? currentList.findIndex(
                  (r) => r === cur || (r.timestamp_us === cur.timestamp_us && r.port === cur.port),
                )
              : -1
            let nextIdx = idx
            if (event.key === 'ArrowUp') {
              nextIdx = idx <= 0 ? currentList.length - 1 : idx - 1
            } else {
              nextIdx = idx === -1 || idx >= currentList.length - 1 ? 0 : idx + 1
            }
            const nextRow = currentList[nextIdx]
            if (nextRow) {
              setSelected(nextRow)
              if (viewportRef) {
                const rowTop = nextIdx * ROW_HEIGHT
                const rowBottom = rowTop + ROW_HEIGHT
                const vTop = viewportRef.scrollTop
                const vBottom = vTop + viewportRef.clientHeight
                if (rowTop < vTop) {
                  viewportRef.scrollTop = rowTop
                } else if (rowBottom > vBottom) {
                  viewportRef.scrollTop = rowBottom - viewportRef.clientHeight
                }
              }
            }
            return
          }
        }
      }

      if (!event.ctrlKey || event.altKey) return
      if (event.key >= '1' && event.key <= '5') {
        event.preventDefault()
        const zoneNum = Number(event.key) - 1
        if (zoneNum === 4) {
          setConsoleCollapsed(false)
          setConsoleTab('forge')
        }
        focusZone(zoneNum)
      }
      if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        void yieldPort()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const paletteActions = createMemo<CommandAction[]>(() => [
    {
      id: 'jump-live',
      label: 'Jump to Live Stream',
      category: 'Stream',
      shortcut: 'L',
      run: () => jumpToLive(),
    },
    {
      id: 'toggle-follow',
      label: follow() ? 'Pause Stream Follow' : 'Follow Live Stream',
      category: 'Stream',
      shortcut: 'F',
      run: () => {
        if (!follow()) jumpToLive()
        else setFollow(false)
      },
    },
    {
      id: 'clear-filters',
      label: 'Clear All Stream Filters',
      category: 'Stream',
      run: () => {
        setPortFilter('all')
        setDirFilter('all')
        setKindFilter('all')
        setSearchQuery('')
      },
    },
    {
      id: 'toggle-stack',
      label: stackRows() ? 'Telemetry: Overlay Mode' : 'Telemetry: Stacked Rows',
      category: 'Telemetry',
      shortcut: 'S',
      run: () => setStackRows(!stackRows()),
    },
    {
      id: 'toggle-typed',
      label: typed() ? 'Switch to Raw Hex Send' : 'Switch to Typed Field Send',
      category: 'Transmit',
      shortcut: 'T',
      run: () => chooseTyped(!typed()),
    },
    {
      id: 'open-forge',
      label: 'Show Command Forge & Faults',
      category: 'Console',
      shortcut: 'Ctrl+5',
      run: () => {
        setConsoleTab('forge')
        setConsoleCollapsed(false)
        focusZone(4)
      },
    },
    {
      id: 'open-diff',
      label: 'Compare Session Vault (Diff)',
      category: 'Console',
      run: () => {
        setConsoleTab('diff')
        setShowDiff(true)
        setConsoleCollapsed(false)
      },
    },
    {
      id: 'open-events',
      label: 'Show System Event Log',
      category: 'Console',
      run: () => {
        setConsoleTab('events')
        setConsoleCollapsed(false)
      },
    },
    {
      id: 'yield-port',
      label: 'Yield Active Port (30s Release)',
      category: 'Hardware',
      shortcut: 'Ctrl+Y',
      run: () => void yieldPort(),
    },
    {
      id: 'disarm-faults',
      label: 'Disarm All Fault Injections',
      category: 'Faults',
      run: () => void disarmFaults(),
    },
    {
      id: 'export-csv',
      label: 'Export Recording as CSV',
      category: 'Export',
      run: () => void saveExport('csv'),
    },
    {
      id: 'export-jsonl',
      label: 'Export Recording as JSON Lines',
      category: 'Export',
      run: () => void saveExport('jsonl'),
    },
    {
      id: 'export-saleae',
      label: 'Export Recording as Saleae CSV',
      category: 'Export',
      run: () => void saveExport('saleae'),
    },
    {
      id: 'export-pcapng',
      label: 'Export Recording as PCAPNG',
      category: 'Export',
      run: () => void saveExport('pcapng'),
    },
  ])

  return (
    <div class="shell" classList={{ 'console-collapsed': consoleCollapsed() }}>
      {/* Zone 1 — 40px Instrument Topbar */}
      <header class="ribbon topbar" data-zone="ribbon" tabindex="-1" data-tauri-drag-region>
        <div class="topbar-left">
          <div class="brand">
            <span
              class="status-led"
              classList={{
                live: feed.link() === 'live' && at() === null,
                warn: at() !== null || feed.link() === 'connecting',
                fault: feed.link() === 'down',
              }}
            />
            <h1>BaudForge</h1>
          </div>
          <span class={`chip ${feed.link()}`}>{feed.link()}</span>
          <span class="chip">{session()?.mode ?? 'idle'}</span>
          <span class="chip">ports {openPorts()}/{ports().length}</span>
          <Show when={faultKind() !== 'off'}>
            <span class="chip down">⚡ fault: {faultKind()}</span>
          </Show>
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
          <For each={feed.snapshot()?.bridges ?? []}>
            {(bridge) => (
              <span class="chip bridge" classList={{ forward: bridge.forward }}>
                {bridge.forward ? 'bridge' : 'tap'} {bridge.a}↔{bridge.b}
                <Show when={bridge.forward}>
                  {' '}
                  {bytes(bridge.forwarded)}
                  <Show when={bridge.dropped > 0}> · dropped {bytes(bridge.dropped)}</Show>
                </Show>
              </span>
            )}
          </For>
        </div>

        {/* Center DVR Scrubber & Transport Pod */}
        <div class="topbar-center dvr-pod">
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
          <input
            type="range"
            class="dvr-slider"
            min="0"
            max={Math.max(spanMs(), 1)}
            step={Math.max(1, Math.round(spanMs() / 2000))}
            value={at() ?? Math.max(spanMs(), 0)}
            onInput={(e) => loadWindow(Number(e.currentTarget.value))}
            aria-label="vault time in milliseconds"
          />
          <button
            type="button"
            class="transport"
            classList={{ active: at() === null }}
            onClick={jumpToLive}
            title="jump to live stream"
          >
            ● live
          </button>
          <span class="hint">
            {timelineNote() ??
              (at() === null
                ? `${(spanMs() / 1000).toFixed(1)} s recorded`
                : `${(Number(at() ?? 0) / 1000).toFixed(3)} s / ${(spanMs() / 1000).toFixed(1)} s`)}
          </span>
        </div>

        {/* Right Toolbar & Chrome */}
        <div class="topbar-right">
          <Show when={yieldNote()}>{(note) => <span class="chip yield-note">{note()}</span>}</Show>
          <Show when={exportNote()}>{(note) => <span class="chip export-note">{note()}</span>}</Show>
          <Show when={pinNote()}>{(note) => <span class="chip pin-note">{note()}</span>}</Show>
          <button
            type="button"
            class="chip action palette-trigger"
            onClick={() => setPaletteOpen(true)}
            title="Command palette (Ctrl+K)"
          >
            ⌘K
          </button>
          <button
            type="button"
            class="chip action yield"
            onClick={yieldPort}
            disabled={ports().length === 0}
            title="release the port so a flash tool can use it (Ctrl+Y)"
          >
            yield
          </button>
          <button
            type="button"
            class="chip action diff-toggle"
            classList={{ on: showDiff() }}
            onClick={() => {
              const next = !showDiff()
              setShowDiff(next)
              if (next) {
                setConsoleTab('diff')
                setConsoleCollapsed(false)
              }
            }}
            title="compare session vault against another recording"
          >
            diff
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
          <span class="chip telemetry-chip">elapsed {session() ? seconds(session()!.elapsed_ms) : '-'}</span>
          <span class="chip telemetry-chip">chunks {session()?.chunks ?? 0}</span>
          <span class="chip telemetry-chip">payload {session() ? bytes(session()!.payload_bytes) : '-'}</span>
          <WindowControls />
        </div>
      </header>

      {/* Zone 2 — Left Hardware Bay */}
      <aside class="sidebar hardware-bay" data-zone="sidebar" tabindex="-1">
        <div class="section-bar">
          <h2>Hardware Ports</h2>
          <span class="hint">{openPorts()} active</span>
        </div>
        <Show when={ports().length > 0} fallback={<p class="empty">No ports in this workspace.</p>}>
          <For each={ports()}>
            {(port) => (
              <article class="port port-card">
                <div class="port-head">
                  <strong>{port.id}</strong>
                  <span class={`state ${port.state}`}>{port.state}</span>
                </div>
                <div class="port-device" title={port.device}>{port.device || '-'}</div>
                <div class="port-kpi-grid">
                  <div class="port-kpi">
                    <span class="kpi-label">Baud / Frame</span>
                    <span class="kpi-val">{port.baud_rate || '-'} · {port.framing}</span>
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

        <Show when={bridges().length > 0}>
          <div class="section-bar">
            <h2>Bridges & Taps</h2>
          </div>
          <For each={bridges()}>
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
      </aside>

      {/* Zone 3 — Center Stage (Stream + Oscilloscope) */}
      <div class="stage" data-zone="stage" tabindex="-1">
        <main class="stream stream-panel">
          <div class="stream-head stream-toolbar">
            <div class="filter-group">
              <h2>Stream</h2>
              <select
                class="port-filter-select"
                value={portFilter()}
                onChange={(e) => setPortFilter(e.currentTarget.value)}
                aria-label="filter by port"
              >
                <option value="all">all ports</option>
                <For each={ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
              </select>
              <div class="dir-filters">
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: dirFilter() === 'all' }}
                  onClick={() => setDirFilter('all')}
                >
                  all
                </button>
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: dirFilter() === 'rx' }}
                  onClick={() => setDirFilter('rx')}
                >
                  rx
                </button>
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: dirFilter() === 'tx' }}
                  onClick={() => setDirFilter('tx')}
                >
                  tx
                </button>
              </div>
              <div class="kind-filters">
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: kindFilter() === 'all' }}
                  onClick={() => setKindFilter('all')}
                >
                  all
                </button>
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: kindFilter() === 'errors' }}
                  onClick={() => setKindFilter('errors')}
                >
                  errors
                </button>
                <button
                  type="button"
                  class="chip action"
                  classList={{ on: kindFilter() === 'symbols' }}
                  onClick={() => setKindFilter('symbols')}
                >
                  symbols
                </button>
              </div>
              <div class="search-wrap">
                <input
                  ref={searchInputRef}
                  class="search-input"
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  placeholder="Filter hex, protocol, text… (/)"
                  aria-label="filter stream"
                />
                <Show when={searchQuery()}>
                  <button
                    type="button"
                    class="search-clear"
                    onClick={() => setSearchQuery('')}
                    title="clear search"
                  >
                    ✕
                  </button>
                </Show>
              </div>
            </div>
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
                <col style={{ width: '50px' }} />
                <col style={{ width: '50px' }} />
                <col style={{ width: '340px' }} />
                <col style={{ width: '85px' }} />
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
                  <tr><td colSpan={8} class="empty">Waiting for frames or no match for current filter.</td></tr>
                </Show>
                <Show when={topSpacer() > 0}>
                  <tr class="spacer" style={{ height: `${topSpacer()}px` }}>
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
                  {(row) => {
                    const isRx = () => row.direction.toLowerCase() === 'rx'
                    return (
                      <tr
                        classList={{ chosen: detail() === row, faulty: row.decode_error != null }}
                        onClick={() => setSelected(row)}
                      >
                        <td>{clock(row.timestamp_us)}</td>
                        <td>{row.delta_us}</td>
                        <td>{row.port}</td>
                        <td>
                          <span class={`dir-badge ${isRx() ? 'rx' : 'tx'}`}>
                            {row.direction.toLowerCase()}
                          </span>
                        </td>
                        <td>{row.len}</td>
                        <td class="hexcell">{row.hex}</td>
                        <td>
                          <span class="proto-badge">
                            {row.protocol ?? (row.text ? 'text' : '-')}
                          </span>
                        </td>
                        <td class="crash">
                          <Show when={row.symbols[0]}>
                            {(hit) => (
                              <span
                                class="symbol-pill"
                                title={`${shortName(hit().function)} @ 0x${hit().address.toString(16)}`}
                              >
                                {hit().field}
                                <Show when={sourceOf(hit())}> {sourceOf(hit())}</Show>
                              </span>
                            )}
                          </Show>
                          <Show when={row.decode_error && !row.symbols[0]}>
                            <span class="error-pill" title={row.decode_error!}>{row.decode_error}</span>
                          </Show>
                        </td>
                      </tr>
                    )
                  }}
                </For>
                <Show when={bottomSpacer() > 0}>
                  <tr class="spacer" style={{ height: `${bottomSpacer()}px` }}>
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
          <div class="stream-head plot-toolbar">
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
          <Show when={traces().length > 0} fallback={<div class="telemetry-empty hint">Select numeric fields above or from the inspector to plot telemetry.</div>}>
            <Telemetry series={traces()} stack={stackRows()} onRenderer={setRenderer} />
          </Show>
        </section>
      </div>

      {/* Zone 4 — Right Packet Dissector */}
      <InspectorPane
        row={detail()}
        hoveredField={hovered()}
        onHoverField={setHovered}
        onPlotField={(key) => plotField(key)}
        plottedKeys={plottedKeys().map((e) => e.key)}
      />

      {/* Zone 5 — Tabbed Bottom Console */}
      <section class="forge console" data-zone="forge" tabindex="-1">
        <div class="console-header">
          <div class="console-tabs">
            <button
              type="button"
              class="console-tab console-tab-btn"
              classList={{ active: consoleTab() === 'forge' }}
              onClick={() => {
                setConsoleTab('forge')
                setConsoleCollapsed(false)
              }}
            >
              Command Forge & Faults
            </button>
            <button
              type="button"
              class="console-tab console-tab-btn"
              classList={{ active: consoleTab() === 'diff' }}
              onClick={() => {
                setConsoleTab('diff')
                setShowDiff(true)
                setConsoleCollapsed(false)
              }}
            >
              Session Diff
            </button>
            <button
              type="button"
              class="console-tab console-tab-btn"
              classList={{ active: consoleTab() === 'events' }}
              onClick={() => {
                setConsoleTab('events')
                setConsoleCollapsed(false)
              }}
            >
              Events ({feed.events().length})
            </button>
          </div>
          <button
            type="button"
            class="chip action console-collapse-btn"
            onClick={() => setConsoleCollapsed(!consoleCollapsed())}
            title={consoleCollapsed() ? 'expand console' : 'collapse console'}
          >
            {consoleCollapsed() ? '▲ expand' : '▼ collapse'}
          </button>
        </div>

        <Show when={!consoleCollapsed()}>
          <div class="console-body">
            <Show when={consoleTab() === 'forge'}>
              <div class="forge-split">
                {/* Command Forge Card */}
                <div class="forge-card command-card">
                  <div class="card-head">
                    <h2>Command forge</h2>
                    <div class="card-controls">
                      <button
                        type="button"
                        class="mode"
                        classList={{ active: typed() }}
                        onClick={() => chooseTyped(!typed())}
                        title="send named fields instead of hex"
                      >
                        {typed() ? 'typed' : 'hex'}
                      </button>
                      <Show when={ports().length > 1}>
                        <select
                          class="port-select"
                          value={targetPort() || ports()[0]?.id || ''}
                          onChange={(e) => setTargetPort(e.currentTarget.value)}
                          aria-label="target port"
                        >
                          <For each={ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
                        </select>
                      </Show>
                    </div>
                  </div>
                  <form onSubmit={typed() ? forgeSendTyped : forgeSend}>
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
                        class="hex-input"
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
                  <Show when={sentHistory().length > 0}>
                    <ol class="sent tx-history">
                      <For each={sentHistory()}>
                        {(entry) => (
                          <li>
                            <button
                              type="button"
                              class="replay-btn"
                              title="replay this transmission"
                              onClick={() => void replaySent(entry)}
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
                    <Show when={faultKind() !== 'off'}>
                      <span class="chip down">ARMED</span>
                    </Show>
                  </div>
                  <form class="fault-form" onSubmit={armFault}>
                    <Show when={ports().length > 1}>
                      <select
                        class="port-select"
                        value={targetPort() || ports()[0]?.id || ''}
                        onChange={(e) => setTargetPort(e.currentTarget.value)}
                        aria-label="target port for fault"
                      >
                        <For each={ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
                      </select>
                    </Show>
                    <select
                      value={faultKind()}
                      onChange={(event) => setFaultKind(event.currentTarget.value)}
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
                      value={faultValue()}
                      onInput={(event) => setFaultValue(event.currentTarget.value)}
                      aria-label="fault amount"
                      title={
                        faultKind() === 'bit_flip'
                          ? 'probability per byte, 0 to 1'
                          : faultKind() === 'delay'
                            ? 'delay in milliseconds'
                            : 'bytes or interval'
                      }
                    />
                    <button type="submit">Arm</button>
                    <Show when={faultKind() !== 'off'}>
                      <button type="button" class="disarm-btn" onClick={() => void disarmFaults()}>Disarm</button>
                    </Show>
                    <span class="hint">
                      {faultKind() === 'bit_flip'
                        ? 'per-byte probability'
                        : faultKind() === 'delay'
                          ? 'delay ms'
                          : 'bytes / interval'}
                    </span>
                  </form>
                  <Show when={faultLine()}>{(line) => <p class="answer">{line()}</p>}</Show>
                </div>
              </div>
            </Show>

            <Show when={consoleTab() === 'diff'}>
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
                      setConsoleTab('forge')
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

            <Show when={consoleTab() === 'events'}>
              <ol class="events">
                <Show when={feed.events().length === 0}>
                  <li class="empty">No events logged in this session yet.</li>
                </Show>
                <For each={feed.events()}>{(event) => <li>{event.text}</li>}</For>
              </ol>
            </Show>
          </div>
        </Show>
      </section>

      {/* Zone 6 — Footer Statusbar */}
      <footer class="footer statusbar">
        <span>vault {session()?.vault || 'not recording'}</span>
        <span>{session() ? bytes(session()!.file_bytes) : '-'} on disk</span>
        <span>elf {session()?.elf ?? 'none'}</span>
        <span>contract {feed.snapshot()?.contract ?? '?'}</span>
        <span class="grow" />
        <span>frames kept {feed.frames().length}</span>
        <span>received {feed.received()}</span>
        <Show when={feed.missed() > 0}>
          <span class="sampled" title="the engine replaced batches this client had not read">
            sampled: {feed.missed()} batch(es) not shown
          </span>
        </Show>
        <span class="shortcut-hint" onClick={() => setPaletteOpen(true)} title="open command palette (Ctrl+K)">
          ⌘K / Ctrl+K
        </span>
      </footer>

      {/* Command Palette Modal */}
      <CommandPalette
        open={paletteOpen()}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions()}
      />
    </div>
  )
}
