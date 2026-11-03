import { createEffect, createSignal, type Component } from 'solid-js'
import type { ActionHandler, SliderNode } from '../types'

interface SliderWidgetProps {
  node: SliderNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const SliderWidget: Component<SliderWidgetProps> = (props) => {
  const min = () => props.node.min
  const max = () => props.node.max
  const step = () => props.node.step || 1

  const [val, setVal] = createSignal<number>(props.node.min)

  // Sync with incoming telemetry context if target property is available
  createEffect(() => {
    const ctx = props.context()
    if (props.node.target && ctx && props.node.target in ctx) {
      const current = Number(ctx[props.node.target])
      if (!isNaN(current)) {
        setVal(current)
      }
    }
  })

  const handleChange = (e: Event) => {
    const target = e.target as HTMLInputElement
    const nextVal = parseFloat(target.value)
    setVal(nextVal)
    if (props.onAction) {
      props.onAction({
        type: 'set',
        target: props.node.target,
        value: nextVal,
      })
    }
  }

  const percentage = () => {
    const range = max() - min()
    if (range <= 0) return 0
    return ((val() - min()) / range) * 100
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        padding: '10px 14px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '8px',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
        'min-width': '180px',
      }}
    >
      {/* Slider Header with Value Bubble */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
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
          {props.node.label || props.node.target}
        </span>
        <span
          style={{
            'font-family': 'var(--font-mono, monospace)',
            'font-size': '11px',
            'font-weight': '700',
            padding: '1px 6px',
            background: 'var(--bg-surface-3, #1e222b)',
            border: '1px solid var(--border-hairline, #1f2430)',
            'border-radius': '4px',
            color: 'var(--sig-tx, #06b6d4)',
          }}
        >
          {Number.isInteger(val()) ? val() : val().toFixed(2)}
        </span>
      </div>

      {/* Range Track */}
      <div style={{ position: 'relative', width: '100%', height: '24px', display: 'flex', 'align-items': 'center' }}>
        <input
          type="range"
          min={min()}
          max={max()}
          step={step()}
          value={val()}
          onInput={handleChange}
          style={{
            width: '100%',
            height: '6px',
            '-webkit-appearance': 'none',
            appearance: 'none',
            background: `linear-gradient(to right, var(--sig-tx, #06b6d4) 0%, var(--sig-tx, #06b6d4) ${percentage()}%, var(--bg-surface-3, #1e222b) ${percentage()}%, var(--bg-surface-3, #1e222b) 100%)`,
            'border-radius': '3px',
            outline: 'none',
            cursor: 'pointer',
          }}
        />
      </div>

      {/* Min & Max Sub-labels */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'font-family': 'var(--font-mono, monospace)',
          'font-size': '9px',
          color: 'var(--text-muted, #5e677a)',
        }}
      >
        <span>{min()}</span>
        <span>{max()}</span>
      </div>
    </div>
  )
}
