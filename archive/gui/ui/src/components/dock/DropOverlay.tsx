import { Show } from 'solid-js'
import type { DropZone } from '../../lib/dock/types'

export interface DropOverlayProps {
  stackId: string
  active: boolean
  currentZone: DropZone | null
  onZoneChange: (zone: DropZone | null) => void
  onDrop: (zone: DropZone) => void
}

export function DropOverlay(props: DropOverlayProps) {
  let overlayRef: HTMLDivElement | undefined

  const calculateZone = (clientX: number, clientY: number): DropZone | null => {
    if (!overlayRef) return null
    const rect = overlayRef.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const relX = (clientX - rect.left) / rect.width
    const relY = (clientY - rect.top) / rect.height

    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
      return null
    }

    const threshold = 0.28
    if (relX < threshold) return 'left'
    if (relX > 1 - threshold) return 'right'
    if (relY < threshold) return 'top'
    if (relY > 1 - threshold) return 'bottom'
    return 'center'
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move'
    }
    const zone = calculateZone(e.clientX, e.clientY)
    props.onZoneChange(zone)
  }

  const handleDragLeave = (e: DragEvent) => {
    // Only clear if mouse actually left the overlay container
    if (e.currentTarget === e.target || !overlayRef?.contains(e.relatedTarget as Node)) {
      props.onZoneChange(null)
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const zone = props.currentZone ?? calculateZone(e.clientX, e.clientY) ?? 'center'
    props.onDrop(zone)
    props.onZoneChange(null)
  }

  const getHighlightStyle = (zone: DropZone) => {
    switch (zone) {
      case 'left':
        return {
          top: '0',
          left: '0',
          bottom: '0',
          width: '50%',
        }
      case 'right':
        return {
          top: '0',
          right: '0',
          bottom: '0',
          width: '50%',
        }
      case 'top':
        return {
          top: '0',
          left: '0',
          right: '0',
          height: '50%',
        }
      case 'bottom':
        return {
          bottom: '0',
          left: '0',
          right: '0',
          height: '50%',
        }
      case 'center':
      default:
        return {
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
        }
    }
  }

  const getZoneLabel = (zone: DropZone) => {
    switch (zone) {
      case 'left':
        return 'SPLIT LEFT'
      case 'right':
        return 'SPLIT RIGHT'
      case 'top':
        return 'SPLIT TOP'
      case 'bottom':
        return 'SPLIT BOTTOM'
      case 'center':
        return 'TAB STACK'
    }
  }

  return (
    <Show when={props.active}>
      <div
        ref={overlayRef}
        class="dock-drop-overlay"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          position: 'absolute',
          inset: '0',
          'z-index': 100,
          background: 'rgba(9, 10, 13, 0.45)',
          'backdrop-filter': 'blur(1px)',
          'pointer-events': 'all',
          overflow: 'hidden',
        }}
      >
        {/* Active Zone Phosphor Highlight */}
        <Show when={props.currentZone}>
          {(activeZone) => (
            <div
              class="dock-drop-highlight"
              style={{
                position: 'absolute',
                ...getHighlightStyle(activeZone()),
                background: 'rgba(6, 182, 212, 0.16)',
                border: '1px solid var(--sig-tx, #06b6d4)',
                'box-shadow': 'inset 0 0 20px rgba(6, 182, 212, 0.3)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'pointer-events': 'none',
                transition: 'all 120ms cubic-bezier(0.23, 1, 0.32, 1)',
              }}
            >
              <div
                style={{
                  padding: '4px 8px',
                  background: 'var(--bg-surface-1, #101217)',
                  border: '1px solid var(--sig-tx, #06b6d4)',
                  'border-radius': '3px',
                  color: 'var(--sig-tx, #06b6d4)',
                  'font-family': 'var(--font-mono, monospace)',
                  'font-size': '10px',
                  'font-weight': '600',
                  'letter-spacing': '0.08em',
                  'box-shadow': '0 2px 8px rgba(0, 0, 0, 0.6)',
                }}
              >
                {getZoneLabel(activeZone())}
              </div>
            </div>
          )}
        </Show>

        {/* Center Compass / Quadrant Guide */}
        <div
          class="dock-drop-cross"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '80px',
            height: '80px',
            display: 'grid',
            'grid-template-columns': '24px 28px 24px',
            'grid-template-rows': '24px 28px 24px',
            gap: '2px',
            'pointer-events': 'none',
            opacity: '0.85',
          }}
        >
          {/* Top Zone Target */}
          <div
            style={{
              'grid-column': '2',
              'grid-row': '1',
              background: props.currentZone === 'top' ? 'var(--sig-tx)' : 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              'border-radius': '2px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <div style={{ width: '4px', height: '4px', background: 'var(--text-muted)' }} />
          </div>

          {/* Left Zone Target */}
          <div
            style={{
              'grid-column': '1',
              'grid-row': '2',
              background: props.currentZone === 'left' ? 'var(--sig-tx)' : 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              'border-radius': '2px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <div style={{ width: '4px', height: '4px', background: 'var(--text-muted)' }} />
          </div>

          {/* Center Zone Target */}
          <div
            style={{
              'grid-column': '2',
              'grid-row': '2',
              background: props.currentZone === 'center' ? 'var(--sig-tx)' : 'var(--bg-surface-3)',
              border: '1px solid var(--border-strong)',
              'border-radius': '2px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <div style={{ width: '8px', height: '6px', border: '1px solid var(--text-secondary)', 'border-radius': '1px' }} />
          </div>

          {/* Right Zone Target */}
          <div
            style={{
              'grid-column': '3',
              'grid-row': '2',
              background: props.currentZone === 'right' ? 'var(--sig-tx)' : 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              'border-radius': '2px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <div style={{ width: '4px', height: '4px', background: 'var(--text-muted)' }} />
          </div>

          {/* Bottom Zone Target */}
          <div
            style={{
              'grid-column': '2',
              'grid-row': '3',
              background: props.currentZone === 'bottom' ? 'var(--sig-tx)' : 'var(--bg-surface-2)',
              border: '1px solid var(--border-hairline)',
              'border-radius': '2px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <div style={{ width: '4px', height: '4px', background: 'var(--text-muted)' }} />
          </div>
        </div>
      </div>
    </Show>
  )
}
