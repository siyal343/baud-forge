import { createMemo, type Component } from 'solid-js'
import { compileExpr } from '../expr'
import type { ActionHandler, NumericDisplayNode } from '../types'

interface NumericDisplayWidgetProps {
  node: NumericDisplayNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const NumericDisplayWidget: Component<NumericDisplayWidgetProps> = (props) => {
  const evaluator = createMemo(() => compileExpr(props.node.source))

  const displayValue = createMemo(() => {
    try {
      const val = evaluator()(props.context())
      if (val === undefined || val === null) return '---'
      if (typeof val === 'number') {
        const prec = props.node.precision
        return prec !== undefined ? val.toFixed(prec) : Number.isInteger(val) ? val.toString() : val.toFixed(2)
      }
      return String(val)
    } catch {
      return 'ERR'
    }
  })

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'justify-content': 'space-between',
        padding: '12px 14px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '8px',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
        'min-width': '140px',
        position: 'relative',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-bottom': '8px',
        }}
      >
        <span
          style={{
            'font-size': '11px',
            'font-weight': '600',
            'letter-spacing': '0.05em',
            'text-transform': 'uppercase',
            color: 'var(--text-secondary, #949eb2)',
          }}
        >
          {props.node.label || 'NUMERIC'}
        </span>
        {props.node.unit && (
          <span
            style={{
              'font-family': 'var(--font-mono, monospace)',
              'font-size': '10px',
              'font-weight': '600',
              padding: '1px 5px',
              background: 'var(--bg-surface-3, #1e222b)',
              border: '1px solid var(--border-hairline, #1f2430)',
              'border-radius': '4px',
              color: 'var(--text-muted, #5e677a)',
            }}
          >
            {props.node.unit}
          </span>
        )}
      </div>

      {/* Main Digital Readout */}
      <div
        style={{
          background: 'var(--bg-canvas, #090a0d)',
          border: '1px solid var(--border-hairline, #1f2430)',
          'border-radius': '6px',
          padding: '8px 12px',
          display: 'flex',
          'align-items': 'baseline',
          'justify-content': 'flex-end',
          'box-shadow': 'inset 0 1px 4px rgba(0,0,0,0.6)',
        }}
      >
        <span
          style={{
            'font-family': 'var(--font-mono, monospace)',
            'font-size': '26px',
            'font-weight': '700',
            'letter-spacing': '0.02em',
            color: 'var(--sig-rx, #10b981)',
            'text-shadow': '0 0 12px rgba(16, 185, 129, 0.4)',
            'font-variant-numeric': 'tabular-nums',
          }}
        >
          {displayValue()}
        </span>
      </div>
    </div>
  )
}
