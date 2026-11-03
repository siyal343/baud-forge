import { createSignal, createMemo } from 'solid-js'
import {
  type ColumnSetting,
  DEFAULT_COLUMNS,
  loadSettings,
  saveSettings,
} from './settings.ts'

export interface ColumnDefinition extends ColumnSetting {
  description?: string
}

const COLUMN_DESCRIPTIONS: Record<string, string> = {
  index: 'Sequential frame sequence index (#)',
  time: 'High-resolution timestamp clock in seconds',
  port: 'Hardware serial, UART, or bus port identifier',
  dir: 'Signal transmission direction (RX / TX)',
  kind: 'Packet classification or frame type',
  delta: 'Inter-packet arrival time difference (Δt µs)',
  payload: 'Payload byte count length',
  hex: 'Raw payload formatted in hexadecimal byte pairs',
  ascii: 'Printable ASCII representation of payload',
  protocol: 'Decoded high-level protocol identifier or text indicator',
  symbol: 'ELF DWARF function symbol name, address, or decode fault',
}

function decorateColumn(col: ColumnSetting): ColumnDefinition {
  return {
    ...col,
    description: COLUMN_DESCRIPTIONS[col.id] || col.label,
  }
}

function getInitialColumns(): ColumnDefinition[] {
  const settings = loadSettings()
  return (settings.columns && settings.columns.length > 0 ? settings.columns : DEFAULT_COLUMNS).map(
    decorateColumn,
  )
}

const [columnsSignal, setColumnsSignal] = createSignal<ColumnDefinition[]>(getInitialColumns())

export const allColumns = columnsSignal
export const visibleColumns = createMemo(() => columnsSignal().filter((c) => c.visible))

function commitColumns(updated: ColumnDefinition[]): void {
  setColumnsSignal(updated)
  const currentSettings = loadSettings()
  currentSettings.columns = updated.map((col) => ({
    id: col.id,
    label: col.label,
    width: col.width,
    minWidth: col.minWidth,
    visible: col.visible,
    fixed: col.fixed,
  }))
  saveSettings(currentSettings)
}

/**
 * Toggles the visibility of a column. Fixed columns cannot be hidden.
 */
export function toggleColumnVisibility(columnId: string): void {
  const current = columnsSignal()
  const target = current.find((c) => c.id === columnId)
  if (!target || target.fixed) return

  const updated = current.map((c) => (c.id === columnId ? { ...c, visible: !c.visible } : c))
  commitColumns(updated)
}

/**
 * Resizes a column by ID, respecting minWidth constraint.
 */
export function resizeColumn(columnId: string, newWidth: number): void {
  const current = columnsSignal()
  const target = current.find((c) => c.id === columnId)
  if (!target) return

  const min = target.minWidth ?? 30
  const clampedWidth = Math.max(min, Math.min(1200, Math.round(newWidth)))

  const updated = current.map((c) => (c.id === columnId ? { ...c, width: clampedWidth } : c))
  commitColumns(updated)
}

/**
 * Moves a column from one index position to another.
 */
export function reorderColumns(fromIndex: number, toIndex: number): void {
  const list = [...columnsSignal()]
  if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) {
    return
  }

  // Preserve fixed columns at beginning (index 0)
  if (list[fromIndex].fixed || toIndex === 0) {
    return
  }

  const [moved] = list.splice(fromIndex, 1)
  list.splice(toIndex, 0, moved)
  commitColumns(list)
}

/**
 * Moves a column up (towards index 1).
 */
export function moveColumnUp(columnId: string): void {
  const list = columnsSignal()
  const idx = list.findIndex((c) => c.id === columnId)
  if (idx <= 1) return // Cannot move above fixed column #0
  reorderColumns(idx, idx - 1)
}

/**
 * Moves a column down (towards the end).
 */
export function moveColumnDown(columnId: string): void {
  const list = columnsSignal()
  const idx = list.findIndex((c) => c.id === columnId)
  if (idx < 0 || idx >= list.length - 1) return
  reorderColumns(idx, idx + 1)
}

/**
 * Resets column configuration back to factory defaults.
 */
export function resetColumns(): void {
  const defaults = DEFAULT_COLUMNS.map(decorateColumn)
  commitColumns(defaults)
}

/**
 * Initializes column registry and syncs with global settings event.
 */
export function initColumns(): void {
  setColumnsSignal(getInitialColumns())

  if (typeof window !== 'undefined') {
    window.addEventListener('baudforge:settings-changed', () => {
      setColumnsSignal(getInitialColumns())
    })
  }
}
