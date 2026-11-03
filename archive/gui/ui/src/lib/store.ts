import { createSignal, createMemo } from 'solid-js'
import { createFeed } from './feed'
import { api, exportVault } from './shell'
import { exportWorkspace } from './workspace'
import type { FieldRow, TailRow, PortView } from './types'
import type { TraceMode } from '../components/Telemetry'

export interface PinStep {
  dtr?: boolean
  rts?: boolean
  wait_ms: number
}

export const ESP32_BOOT_STEPS: PinStep[] = [
  { dtr: false, rts: true, wait_ms: 50 },
  { dtr: true, rts: false, wait_ms: 50 },
  { dtr: false, rts: false, wait_ms: 0 },
]

export function parsePinSteps(text: string): PinStep[] {
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

export interface FieldDiff {
  frame_index: number
  port: string
  field_name: string
  value_a: string
  value_b: string
}

export interface Divergence {
  index: number
  timestamp_us_a: number
  timestamp_us_b: number
  port: string
  reason: string
  field_diffs: FieldDiff[]
}

export interface DiffReport {
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

export interface SentEntry {
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

export function createWorkbenchStore() {
  const feed = createFeed()
  const [selected, setSelected] = createSignal<TailRow | null>(null)
  const [hovered, setHovered] = createSignal<FieldRow | null>(null)
  const [plotted, setPlotted] = createSignal<{ key: string; mode: TraceMode }[]>([])
  
  // Forge & Transmit State
  const [hex, setHex] = createSignal('AA 55 03')
  const [crc, setCrc] = createSignal('')
  const [chunkSize, setChunkSize] = createSignal('')
  const [paceMs, setPaceMs] = createSignal('')
  const [typed, setTyped] = createSignal(false)
  const [typedValues, setTypedValues] = createSignal<Record<string, string>>({})
  const [answer, setAnswer] = createSignal<string | null>(null)
  const [sentHistory, setSentHistory] = createSignal<SentEntry[]>([])
  const [targetPort, setTargetPort] = createSignal<string>('')

  // Pin Control State
  const [seqPort, setSeqPort] = createSignal<string | null>(null)
  const [customSeqText, setCustomSeqText] = createSignal('')
  const [pinNote, setPinNote] = createSignal<string | null>(null)

  // Session Diff State
  const [showDiff, setShowDiff] = createSignal(false)
  const [diffPathA, setDiffPathA] = createSignal('')
  const [diffPathB, setDiffPathB] = createSignal('')
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [diffError, setDiffError] = createSignal<string | null>(null)
  const [diffReport, setDiffReport] = createSignal<DiffReport | null>(null)

  // Fault Injector State
  const [faultKind, setFaultKind] = createSignal('off')
  const [faultValue, setFaultValue] = createSignal('1.0')
  const [faultLine, setFaultLine] = createSignal<string | null>(null)

  // Stream Filtering State
  const [portFilter, setPortFilter] = createSignal<string>('all')
  const [dirFilter, setDirFilter] = createSignal<'all' | 'rx' | 'tx'>('all')
  const [kindFilter, setKindFilter] = createSignal<'all' | 'errors' | 'symbols'>('all')
  const [searchQuery, setSearchQuery] = createSignal('')

  // Bottom Workbench Console State
  const [consoleTab, setConsoleTab] = createSignal<'forge' | 'diff' | 'events'>('forge')
  const [consoleCollapsed, setConsoleCollapsed] = createSignal(false)

  // Dialog & Modal State
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [showNewWorkspaceModal, setShowNewWorkspaceModal] = createSignal(false)

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
  const [exporting, setExporting] = createSignal(false)

  // Stream Table Scrolling & Virtualization State
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(500)
  const [follow, setFollow] = createSignal(true)

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
    return plotted().filter((entry) => plotKeys().includes(entry.key))
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
      list = list.filter((row) => row.symbols && row.symbols.length > 0)
    }
    const q = searchQuery().trim().toLowerCase()
    if (q) {
      list = list.filter(
        (row) =>
          row.hex.toLowerCase().includes(q) ||
          row.text.toLowerCase().includes(q) ||
          (row.protocol && row.protocol.toLowerCase().includes(q)) ||
          row.fields.some(
            (f) =>
              f.name.toLowerCase().includes(q) ||
              f.value.toLowerCase().includes(q) ||
              (f.value_num !== null && String(f.value_num).includes(q)),
          ),
      )
    }
    return list
  })

  // Actions
  async function sendHex() {
    const payload = hex().replace(/0x/gi, '').replace(/[\s:,]/g, '')
    if (!payload) return
    const chosen = targetPort() || (ports().length > 0 ? ports()[0].id : '')
    if (!chosen) {
      setAnswer('ERR: no active port to transmit')
      return
    }
    const body: Record<string, any> = { hex: payload }
    if (crc()) body.crc = crc()
    if (chunkSize()) body.chunk_size = parseInt(chunkSize(), 10)
    if (paceMs()) body.pace_ms = parseInt(paceMs(), 10)
    try {
      const res = await fetch(api(`/api/send?port=${encodeURIComponent(chosen)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setAnswer(`TX FAIL: HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      setAnswer(`TX OK: ${data.bytes_sent} B`)
      const entry: SentEntry = {
        id: `tx-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        time: new Date().toLocaleTimeString(),
        port: chosen,
        bytes: payload.length / 2,
        summary: payload.length <= 16 ? payload : `${payload.slice(0, 16)}...`,
        hex: payload,
        isTyped: typed(),
        typedValues: typed() ? { ...typedValues() } : undefined,
        crc: crc() || undefined,
        chunkSize: chunkSize() || undefined,
        paceMs: paceMs() || undefined,
      }
      setSentHistory((prev) => [entry, ...prev.slice(0, 49)])
    } catch (e: any) {
      setAnswer(`TX ERR: ${e.message}`)
    }
  }

  async function replaySent(entry: SentEntry) {
    setHex(entry.hex)
    setTargetPort(entry.port)
    if (entry.crc) setCrc(entry.crc)
    if (entry.chunkSize) setChunkSize(entry.chunkSize)
    if (entry.paceMs) setPaceMs(entry.paceMs)
    if (entry.isTyped && entry.typedValues) {
      setTyped(true)
      setTypedValues(entry.typedValues)
    }
    await sendHex()
  }

  async function sendTx(
    portId: string,
    text: string,
    mode: 'crlf' | 'lf' | 'cr' | 'none' | 'hex',
  ): Promise<boolean> {
    if (!portId) {
      setAnswer('ERR: no active port to transmit')
      return false
    }

    let bytes: number[]
    if (mode === 'hex') {
      const trimmed = text.trim()
      const tokens = trimmed.split(/[\s,:]+/).filter(Boolean)
      bytes = []
      if (tokens.length > 1) {
        for (let token of tokens) {
          token = token.replace(/^0x/i, '')
          if (token.length % 2 === 1) token = '0' + token
          for (let i = 0; i < token.length; i += 2) {
            const val = parseInt(token.slice(i, i + 2), 16)
            if (!isNaN(val)) bytes.push(val)
          }
        }
      } else if (trimmed) {
        const cleaned = trimmed.replace(/^0x/i, '')
        for (let i = 0; i < cleaned.length; i += 2) {
          const val = parseInt(cleaned.slice(i, i + 2), 16)
          if (!isNaN(val)) bytes.push(val)
        }
      }
    } else {
      const encoder = new TextEncoder()
      const raw = Array.from(encoder.encode(text))
      if (mode === 'crlf') {
        bytes = raw.concat([13, 10])
      } else if (mode === 'lf') {
        bytes = raw.concat([10])
      } else if (mode === 'cr') {
        bytes = raw.concat([13])
      } else {
        bytes = raw
      }
    }

    const hexPayload = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
    const body = {
      port: portId,
      bytes,
      hex: hexPayload,
    }

    try {
      const res = await fetch(api('/api/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setAnswer(`TX FAIL: HTTP ${res.status}`)
        return false
      }
      setAnswer(`TX OK: ${bytes.length} B`)
      const entry: SentEntry = {
        id: `tx-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        time: new Date().toLocaleTimeString(),
        port: portId,
        bytes: bytes.length,
        summary: text.length <= 24 ? text : `${text.slice(0, 24)}...`,
        hex: hexPayload,
        isTyped: false,
      }
      setSentHistory((prev) => [entry, ...prev.slice(0, 49)])
      return true
    } catch (e: any) {
      setAnswer(`TX ERR: ${e.message}`)
      return false
    }
  }

  async function setDtr(portId: string, state: boolean) {
    try {
      await fetch(api(`/api/dtr?port=${encodeURIComponent(portId)}&state=${state}`), { method: 'POST' })
    } catch (e: any) {
      setPinNote(`DTR error: ${e.message}`)
    }
  }

  async function setRts(portId: string, state: boolean) {
    try {
      await fetch(api(`/api/rts?port=${encodeURIComponent(portId)}&state=${state}`), { method: 'POST' })
    } catch (e: any) {
      setPinNote(`RTS error: ${e.message}`)
    }
  }

  async function pulsePin(portId: string, line: 'dtr' | 'rts', durationMs: number) {
    try {
      await fetch(api(`/api/pulse?port=${encodeURIComponent(portId)}&line=${line}&duration_ms=${durationMs}`), {
        method: 'POST',
      })
    } catch (e: any) {
      setPinNote(`Pulse error: ${e.message}`)
    }
  }

  async function sendSequence(portId: string, steps: PinStep[]) {
    try {
      await fetch(api(`/api/sequence?port=${encodeURIComponent(portId)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps }),
      })
      setPinNote(`Executed ${steps.length} pin steps on ${portId}`)
      setTimeout(() => setPinNote(null), 3000)
    } catch (e: any) {
      setPinNote(`Sequence error: ${e.message}`)
    }
  }

  async function injectFault() {
    const port = targetPort() || (ports().length > 0 ? ports()[0].id : '')
    if (!port) return
    const kind = faultKind()
    if (kind === 'off') {
      await disarmFault()
      return
    }
    const val = parseFloat(faultValue()) || 0
    try {
      const res = await fetch(api(`/api/fault?port=${encodeURIComponent(port)}&kind=${kind}&value=${val}`), {
        method: 'POST',
      })
      if (res.ok) {
        setFaultLine(`Armed ${kind} (${val}) on ${port}`)
      }
    } catch (e: any) {
      setFaultLine(`Fault arm error: ${e.message}`)
    }
  }

  async function disarmFault() {
    const port = targetPort() || (ports().length > 0 ? ports()[0].id : '')
    if (!port) return
    try {
      await fetch(api(`/api/fault?port=${encodeURIComponent(port)}&kind=off`), { method: 'POST' })
      setFaultKind('off')
      setFaultLine(null)
    } catch (e: any) {
      setFaultLine(`Fault disarm error: ${e.message}`)
    }
  }

  async function runDiff() {
    const a = diffPathA().trim()
    const b = diffPathB().trim()
    if (!a || !b) {
      setDiffError('Provide both Session A and Session B paths')
      return
    }
    setDiffLoading(true)
    setDiffError(null)
    try {
      const res = await fetch(api(`/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`))
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      const data = await res.json()
      setDiffReport(data)
    } catch (e: any) {
      setDiffError(e.message)
    } finally {
      setDiffLoading(false)
    }
  }

  async function yieldPort(port: string | PortView, durationSec: number = 30): Promise<boolean> {
    const portId = typeof port === 'string' ? port : port.id
    try {
      const res = await fetch(api('/api/yield'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: portId, duration_sec: durationSec, seconds: durationSec }),
      })
      if (!res.ok) {
        setYieldNote(`Yield failed: HTTP ${res.status}`)
        setTimeout(() => setYieldNote(null), 3500)
        return false
      }
      setYieldNote(`Yielded ${portId} for ${durationSec}s`)
      setTimeout(() => setYieldNote(null), 3500)
      return true
    } catch (e: any) {
      setYieldNote(`Yield error: ${e.message}`)
      setTimeout(() => setYieldNote(null), 3500)
      return false
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

  async function setPortFraming(portId: string, framing: string) {
    feed.updatePortFraming(portId, framing)
    try {
      await fetch(api(`/api/ports/${encodeURIComponent(portId)}/framing`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: framing, framing }),
      })
    } catch {
      // Non-blocking: backend endpoint optional
    }
  }

  async function saveWorkspace() {
    if (exporting()) return
    setExporting(true)
    setExportNote('saving workspace…')
    try {
      const res = await exportWorkspace(ports(), bridges())
      setExportNote(`saved ${res}`)
      setTimeout(() => setExportNote(null), 3500)
    } catch (e: any) {
      setExportNote(`save failed: ${e.message}`)
      setTimeout(() => setExportNote(null), 4000)
    } finally {
      setExporting(false)
    }
  }

  // DVR Timeline Operations
  async function loadWindow(timestampUs: number) {
    try {
      const res = await fetch(api(`/api/window?at_us=${timestampUs}&span_ms=2000`))
      if (!res.ok) return
      const data: TailRow[] = await res.json()
      setWindowRows(data)
    } catch (e: any) {
      setTimelineNote(`Window error: ${e.message}`)
    }
  }

  function scrub(timestampUs: number) {
    setFollow(false)
    setAt(timestampUs)
    loadWindow(timestampUs)
  }

  function snapLive() {
    setAt(null)
    setFollow(true)
    setPlaying(false)
  }

  function togglePlay() {
    setPlaying(!playing())
  }

  return {
    feed,
    session,
    ports,
    bridges,
    openPorts,
    activeBridge,
    bridgePorts,
    plotKeys,
    plottedKeys,
    plotted,
    setPlotted,
    plotField,
    unplotField,
    cycleMode,
    selected,
    setSelected,
    hovered,
    setHovered,
    rawRows,
    allRows,
    // Stream Filtering
    portFilter,
    setPortFilter,
    dirFilter,
    setDirFilter,
    kindFilter,
    setKindFilter,
    searchQuery,
    setSearchQuery,
    // Stream Scrolling
    scrollTop,
    setScrollTop,
    viewportHeight,
    setViewportHeight,
    follow,
    setFollow,
    // DVR / Playback
    at,
    setAt,
    spanMs,
    setSpanMs,
    playing,
    setPlaying,
    rate,
    setRate,
    scrub,
    snapLive,
    togglePlay,
    // Transmit & Forge
    hex,
    setHex,
    crc,
    setCrc,
    chunkSize,
    setChunkSize,
    paceMs,
    setPaceMs,
    typed,
    setTyped,
    typedValues,
    setTypedValues,
    answer,
    setAnswer,
    sentHistory,
    targetPort,
    setTargetPort,
    sendHex,
    sendTx,
    replaySent,
    // Pin Control
    setDtr,
    setRts,
    pulsePin,
    sendSequence,
    seqPort,
    setSeqPort,
    customSeqText,
    setCustomSeqText,
    pinNote,
    setPinNote,
    // Fault Injector
    faultKind,
    setFaultKind,
    faultValue,
    setFaultValue,
    faultLine,
    setFaultLine,
    injectFault,
    disarmFault,
    // Session Diff
    showDiff,
    setShowDiff,
    diffPathA,
    setDiffPathA,
    diffPathB,
    setDiffPathB,
    diffLoading,
    diffError,
    diffReport,
    setDiffReport,
    runDiff,
    // UI state
    consoleTab,
    setConsoleTab,
    consoleCollapsed,
    setConsoleCollapsed,
    paletteOpen,
    setPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    showNewWorkspaceModal,
    setShowNewWorkspaceModal,
    bridge,
    setBridge,
    renderer,
    setRenderer,
    stackRows,
    setStackRows,
    timelineNote,
    yieldNote,
    exportNote,
    setExportNote,
    exporting,
    setExporting,
    saveExport,
    setPortFraming,
    saveWorkspace,
    yieldPort,
  }
}

export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>
