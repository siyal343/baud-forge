import { For, Show, createMemo, createSignal, type Component } from 'solid-js'
import { parseDashboardXml } from './parser'
import type {
  ActionHandler,
  DashboardConfig,
  DashboardLayoutNode,
  DashboardNode,
} from './types'
import { ButtonWidget } from './widgets/ButtonWidget'
import { ChartWidget } from './widgets/ChartWidget'
import { GaugeWidget } from './widgets/GaugeWidget'
import { LedWidget } from './widgets/LedWidget'
import { LogGridWidget } from './widgets/LogGridWidget'
import { NumericDisplayWidget } from './widgets/NumericDisplayWidget'
import { SliderWidget } from './widgets/SliderWidget'
import { SwitchWidget } from './widgets/SwitchWidget'

export interface DashboardRendererProps {
  xml?: string
  config?: DashboardConfig
  context?: Record<string, any> | (() => Record<string, any>)
  onAction?: ActionHandler
  class?: string
}

export const DashboardRenderer: Component<DashboardRendererProps> = (props) => {
  const [parseError, setParseError] = createSignal<string | null>(null)

  const ctxGetter = (): Record<string, any> => {
    if (typeof props.context === 'function') {
      return props.context() || {}
    }
    return props.context || {}
  }

  const activeConfig = createMemo<DashboardConfig | null>(() => {
    if (props.config) {
      setParseError(null)
      return props.config
    }
    if (props.xml) {
      try {
        const parsed = parseDashboardXml(props.xml)
        setParseError(null)
        return parsed
      } catch (err: any) {
        setParseError(err?.message || String(err))
        return null
      }
    }
    setParseError(null)
    return null
  })

  // Recursive Layout & Widget Node Dispatcher
  const renderNode = (node: DashboardNode) => {
    switch (node.type) {
      case 'grid': {
        const layout = node as DashboardLayoutNode
        return (
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
              width: '100%',
            }}
          >
            {layout.title && (
              <div
                style={{
                  'font-size': '12px',
                  'font-weight': '600',
                  'letter-spacing': '0.04em',
                  color: 'var(--text-secondary, #949eb2)',
                  'text-transform': 'uppercase',
                }}
              >
                {layout.title}
              </div>
            )}
            <div
              style={{
                display: 'grid',
                'grid-template-columns': `repeat(${layout.columns || 2}, minmax(0, 1fr))`,
                gap: `${layout.gap ?? 12}px`,
                width: '100%',
              }}
            >
              <For each={layout.children}>{(child) => renderNode(child)}</For>
            </div>
          </div>
        )
      }

      case 'stack': {
        const layout = node as DashboardLayoutNode
        const isHoriz = layout.direction === 'horizontal'
        return (
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
              width: '100%',
            }}
          >
            {layout.title && (
              <div
                style={{
                  'font-size': '12px',
                  'font-weight': '600',
                  'letter-spacing': '0.04em',
                  color: 'var(--text-secondary, #949eb2)',
                  'text-transform': 'uppercase',
                }}
              >
                {layout.title}
              </div>
            )}
            <div
              style={{
                display: 'flex',
                'flex-direction': isHoriz ? 'row' : 'column',
                gap: `${layout.gap ?? 12}px`,
                'flex-wrap': isHoriz ? 'wrap' : 'nowrap',
                width: '100%',
              }}
            >
              <For each={layout.children}>{(child) => renderNode(child)}</For>
            </div>
          </div>
        )
      }

      case 'card': {
        const layout = node as DashboardLayoutNode
        return (
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              background: 'var(--bg-surface-1, #101217)',
              border: '1px solid var(--border-hairline, #1f2430)',
              'border-radius': '10px',
              padding: '14px',
              gap: '12px',
              'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
            }}
          >
            {layout.title && (
              <div
                style={{
                  'font-size': '12px',
                  'font-weight': '700',
                  'letter-spacing': '0.05em',
                  color: 'var(--text-primary, #edf0f7)',
                  'text-transform': 'uppercase',
                  'border-bottom': '1px solid var(--border-hairline, #1f2430)',
                  'padding-bottom': '8px',
                }}
              >
                {layout.title}
              </div>
            )}
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
              <For each={layout.children}>{(child) => renderNode(child)}</For>
            </div>
          </div>
        )
      }

      case 'split': {
        const layout = node as DashboardLayoutNode
        const isVert = layout.direction === 'vertical'
        return (
          <div
            style={{
              display: 'flex',
              'flex-direction': isVert ? 'column' : 'row',
              gap: `${layout.gap ?? 8}px`,
              width: '100%',
            }}
          >
            <For each={layout.children}>{(child) => renderNode(child)}</For>
          </div>
        )
      }

      // Widgets
      case 'gauge':
        return <GaugeWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'numeric-display':
        return <NumericDisplayWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'chart':
        return <ChartWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'led':
        return <LedWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'switch':
        return <SwitchWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'button':
        return <ButtonWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'slider':
        return <SliderWidget node={node} context={ctxGetter} onAction={props.onAction} />

      case 'log-grid':
        return <LogGridWidget node={node} context={ctxGetter} onAction={props.onAction} />

      default:
        return null
    }
  }

  return (
    <div
      class={props.class}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '16px',
        padding: '16px',
        background: 'var(--bg-canvas, #090a0d)',
        color: 'var(--text-primary, #edf0f7)',
        width: '100%',
        height: '100%',
        'box-sizing': 'border-box',
        'overflow-y': 'auto',
      }}
    >
      {/* Error Boundary Banner */}
      <Show when={parseError()}>
        <div
          style={{
            background: 'rgba(244, 63, 94, 0.1)',
            border: '1px solid var(--sig-fault, #f43f5e)',
            'border-radius': '8px',
            padding: '12px 16px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
            <span
              style={{
                background: 'var(--sig-fault, #f43f5e)',
                color: '#fff',
                'font-size': '10px',
                'font-weight': '700',
                padding: '2px 6px',
                'border-radius': '4px',
                'letter-spacing': '0.05em',
              }}
            >
              XML PARSE ERROR
            </span>
            <span
              style={{
                'font-family': 'var(--font-mono, monospace)',
                'font-size': '12px',
                color: 'var(--text-primary, #edf0f7)',
              }}
            >
              Failed to compile dashboard markup
            </span>
          </div>
          <pre
            style={{
              margin: '0',
              'font-family': 'var(--font-mono, monospace)',
              'font-size': '11px',
              color: 'var(--sig-fault, #f43f5e)',
              'white-space': 'pre-wrap',
            }}
          >
            {parseError()}
          </pre>
        </div>
      </Show>

      {/* Main Dashboard Render */}
      <Show when={activeConfig()}>
        {(cfg) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px', width: '100%' }}>
            {/* Dashboard Header Bar */}
            <div
              style={{
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center',
                'padding-bottom': '12px',
                'border-bottom': '1px solid var(--border-hairline, #1f2430)',
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'baseline', gap: '10px' }}>
                <h2
                  style={{
                    margin: '0',
                    'font-size': '16px',
                    'font-weight': '700',
                    'letter-spacing': '0.02em',
                    color: 'var(--text-primary, #edf0f7)',
                  }}
                >
                  {cfg().title}
                </h2>
                <span
                  style={{
                    'font-family': 'var(--font-mono, monospace)',
                    'font-size': '10px',
                    'font-weight': '600',
                    color: 'var(--text-muted, #5e677a)',
                  }}
                >
                  v{cfg().version}
                </span>
              </div>

              {cfg().refreshMs !== undefined && (
                <div
                  style={{
                    'font-family': 'var(--font-mono, monospace)',
                    'font-size': '10px',
                    padding: '2px 8px',
                    background: 'var(--bg-surface-2, #161920)',
                    border: '1px solid var(--border-hairline, #1f2430)',
                    'border-radius': '4px',
                    color: 'var(--sig-tx, #06b6d4)',
                  }}
                >
                  REFRESH: {cfg().refreshMs} ms
                </div>
              )}
            </div>

            {/* Dashboard Root Node */}
            {renderNode(cfg().root)}
          </div>
        )}
      </Show>
    </div>
  )
}
