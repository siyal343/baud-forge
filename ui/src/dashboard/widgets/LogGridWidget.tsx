import { For, createEffect, createMemo, type Component } from 'solid-js'
import type { ActionHandler, LogGridNode } from '../types'

interface LogGridWidgetProps {
  node: LogGridNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const LogGridWidget: Component<LogGridWidgetProps> = (props) => {
  let scrollContainer: HTMLDivElement | undefined

  const sourceKey = () => props.node.source || 'events'
  const limit = () => props.node.limit || 50
  const height = () => props.node.height || 200

  const rows = createMemo(() => {
    const ctx = props.context()
    if (!ctx) return []
    const key = sourceKey()
    const raw = ctx[key] || ctx.logs || ctx.tail || ctx.events || []
    if (Array.isArray(raw)) {
      return raw.slice(-limit())
    }
    return []
  })

  // Auto-scroll on new entries
  createEffect(() => {
    rows()
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight
    }
  })

  const formatRow = (row: any) => {
    if (typeof row === 'string') return row
    if (row && typeof row === 'object') {
      if (row.text) return `[${row.port || 'RX'}] ${row.text}`
      if (row.message) return `[${row.level || 'INFO'}] ${row.message}`
      return JSON.stringify(row)
    }
    return String(row)
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        background: 'var(--bg-canvas, #090a0d)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '8px',
        overflow: 'hidden',
        height: `${height()}px`,
        'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      {/* Console Bar */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          padding: '6px 12px',
          background: 'var(--bg-surface-2, #161920)',
          'border-bottom': '1px solid var(--border-hairline, #1f2430)',
        }}
      >
        <span
          style={{
            'font-size': '11px',
            'font-weight': '600',
            'letter-spacing': '0.04em',
            'text-transform': 'uppercase',
            color: 'var(--text-secondary, #949eb2)',
          }}
        >
          {sourceKey()} STREAM
        </span>
        <span
          style={{
            'font-family': 'var(--font-mono, monospace)',
            'font-size': '10px',
            color: 'var(--text-muted, #5e677a)',
          }}
        >
          {rows().length} ROWS
        </span>
      </div>

      {/* Scrolling Stream Content */}
      <div
        ref={scrollContainer}
        style={{
          flex: '1',
          'overflow-y': 'auto',
          padding: '8px 12px',
          'font-family': 'var(--font-mono, monospace)',
          'font-size': '11px',
          'line-height': '1.6',
          color: 'var(--text-secondary, #949eb2)',
        }}
      >
        <For each={rows()} fallback={<div style={{ color: 'var(--text-muted, #5e677a)' }}>No log entries</div>}>
          {(row) => (
            <div
              style={{
                'white-space': 'pre-wrap',
                'word-break': 'break-all',
                'border-bottom': '1px solid rgba(255, 255, 255, 0.02)',
                padding: '2px 0',
              }}
            >
              {formatRow(row)}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
