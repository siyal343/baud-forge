import { createMemo, type Component } from 'solid-js'
import { compileExpr } from '../expr'
import type { ActionHandler, LedNode } from '../types'

interface LedWidgetProps {
  node: LedNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const LedWidget: Component<LedWidgetProps> = (props) => {
  const evaluator = createMemo(() => compileExpr(props.node.source))

  const isOn = createMemo(() => {
    try {
      const val = evaluator()(props.context())
      if (typeof val === 'boolean') return val
      if (typeof val === 'number') return val !== 0
      return Boolean(val)
    } catch {
      return false
    }
  })

  const onColor = () => props.node.onColor || 'var(--sig-rx, #10b981)'
  const offColor = () => props.node.offColor || '#1e222b'

  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '10px',
        padding: '8px 12px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '6px',
        'box-shadow': '0 1px 4px rgba(0,0,0,0.2)',
      }}
    >
      {/* LED Bezel & Lens */}
      <div
        style={{
          width: '14px',
          height: '14px',
          'border-radius': '50%',
          background: 'var(--bg-canvas, #090a0d)',
          border: '1px solid var(--border-strong, #2d3446)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: '9px',
            height: '9px',
            'border-radius': '50%',
            background: isOn() ? (onColor().startsWith('var') ? '#10b981' : onColor()) : offColor(),
            'box-shadow': isOn()
              ? `0 0 8px ${onColor().startsWith('var') ? '#10b981' : onColor()}, 0 0 16px ${onColor().startsWith('var') ? 'rgba(16, 185, 129, 0.5)' : onColor()}`
              : 'none',
            transition: 'background 0.15s ease, box-shadow 0.15s ease',
            animation: isOn() && props.node.pulse ? 'led-pulse 1s infinite alternate' : 'none',
          }}
        />
      </div>

      {/* LED Label */}
      <span
        style={{
          'font-size': '11px',
          'font-weight': '600',
          'letter-spacing': '0.03em',
          color: isOn() ? 'var(--text-primary, #edf0f7)' : 'var(--text-muted, #5e677a)',
          'user-select': 'none',
        }}
      >
        {props.node.label || props.node.source}
      </span>

      <style>{`
        @keyframes led-pulse {
          0% { opacity: 0.7; transform: scale(0.95); }
          100% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
    </div>
  )
}
