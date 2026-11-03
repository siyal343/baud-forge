import { createEffect, createSignal, type Component } from 'solid-js'
import type { ActionHandler, SwitchNode } from '../types'

interface SwitchWidgetProps {
  node: SwitchNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const SwitchWidget: Component<SwitchWidgetProps> = (props) => {
  const [internalActive, setInternalActive] = createSignal(false)

  const onVal = () => (props.node.onValue !== undefined ? props.node.onValue : true)
  const offVal = () => (props.node.offValue !== undefined ? props.node.offValue : false)

  // Sync with context if target property is available
  createEffect(() => {
    const ctx = props.context()
    if (props.node.target && ctx && props.node.target in ctx) {
      const current = ctx[props.node.target]
      setInternalActive(current === onVal())
    }
  })

  const handleToggle = () => {
    const nextState = !internalActive()
    setInternalActive(nextState)
    const emittedValue = nextState ? onVal() : offVal()

    if (props.onAction) {
      props.onAction({
        type: 'set',
        target: props.node.target,
        value: emittedValue,
      })
    }
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: '12px',
        padding: '8px 12px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '6px',
        'box-shadow': '0 1px 4px rgba(0,0,0,0.2)',
        'min-width': '120px',
      }}
    >
      <span
        style={{
          'font-size': '11px',
          'font-weight': '600',
          'letter-spacing': '0.04em',
          color: 'var(--text-secondary, #949eb2)',
          'user-select': 'none',
        }}
      >
        {props.node.label || props.node.target}
      </span>

      {/* Tactile Toggle Button */}
      <button
        type="button"
        onClick={handleToggle}
        style={{
          width: '36px',
          height: '20px',
          'border-radius': '10px',
          background: internalActive() ? 'var(--sig-rx, #10b981)' : 'var(--bg-surface-3, #1e222b)',
          border: '1px solid var(--border-strong, #2d3446)',
          position: 'relative',
          cursor: 'pointer',
          padding: '2px',
          transition: 'background 0.2s cubic-bezier(0.23, 1, 0.32, 1)',
          outline: 'none',
          'box-shadow': internalActive() ? '0 0 10px rgba(16, 185, 129, 0.4)' : 'inset 0 1px 3px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            width: '14px',
            height: '14px',
            'border-radius': '50%',
            background: '#ffffff',
            position: 'absolute',
            top: '2px',
            left: internalActive() ? '18px' : '2px',
            transition: 'left 0.2s cubic-bezier(0.23, 1, 0.32, 1)',
            'box-shadow': '0 1px 3px rgba(0,0,0,0.4)',
          }}
        />
      </button>
    </div>
  )
}
