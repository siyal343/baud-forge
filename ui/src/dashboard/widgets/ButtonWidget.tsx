import { type Component } from 'solid-js'
import type { ActionHandler, ButtonNode } from '../types'

interface ButtonWidgetProps {
  node: ButtonNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const ButtonWidget: Component<ButtonWidgetProps> = (props) => {
  const handleClick = () => {
    if (props.onAction) {
      props.onAction({
        type: 'command',
        command: props.node.command,
        param: props.node.param,
      })
    }
  }

  const variant = () => props.node.variant || 'primary'

  const getStyle = () => {
    switch (variant()) {
      case 'danger':
        return {
          background: 'rgba(244, 63, 94, 0.15)',
          border: '1px solid var(--sig-fault, #f43f5e)',
          color: 'var(--sig-fault, #f43f5e)',
          'box-shadow': '0 2px 6px rgba(244, 63, 94, 0.25)',
        }
      case 'ghost':
        return {
          background: 'var(--bg-surface-2, #161920)',
          border: '1px solid var(--border-hairline, #1f2430)',
          color: 'var(--text-secondary, #949eb2)',
          'box-shadow': 'none',
        }
      case 'primary':
      default:
        return {
          background: 'rgba(6, 182, 212, 0.15)',
          border: '1px solid var(--sig-tx, #06b6d4)',
          color: 'var(--sig-tx, #06b6d4)',
          'box-shadow': '0 2px 6px rgba(6, 182, 212, 0.2)',
        }
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        padding: '8px 16px',
        'font-family': 'var(--font-sans, sans-serif)',
        'font-size': '12px',
        'font-weight': '600',
        'letter-spacing': '0.04em',
        'border-radius': '6px',
        cursor: 'pointer',
        transition: 'all 0.12s ease',
        outline: 'none',
        'user-select': 'none',
        ...getStyle(),
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'translateY(1px)'
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      {props.node.label}
    </button>
  )
}
