import { createSignal } from 'solid-js'
import type { DockDirection } from '../../lib/dock/types'

export interface DockSplitterProps {
  direction: DockDirection
  ratio: number
  onResize: (newRatio: number) => void
  class?: string
}

export function DockSplitter(props: DockSplitterProps) {
  let splitterRef: HTMLDivElement | undefined
  let parentRect: DOMRect | null = null
  const [isDragging, setIsDragging] = createSignal(false)

  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    const parent = splitterRef?.parentElement
    if (!parent) return

    parentRect = parent.getBoundingClientRect()
    setIsDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging() || !parentRect) return
    e.preventDefault()

    const isHorizontal = props.direction === 'horizontal'
    let rawRatio: number

    if (isHorizontal) {
      if (parentRect.width <= 0) return
      rawRatio = (e.clientX - parentRect.left) / parentRect.width
    } else {
      if (parentRect.height <= 0) return
      rawRatio = (e.clientY - parentRect.top) / parentRect.height
    }

    const clampedRatio = Math.max(0.1, Math.min(0.9, rawRatio))
    props.onResize(clampedRatio)
  }

  const handlePointerUp = (e: PointerEvent) => {
    if (!isDragging()) return
    setIsDragging(false)
    parentRect = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Ignore release capture errors if pointer was already lost.
    }
  }

  return (
    <div
      ref={splitterRef}
      class={`dock-splitter ${props.direction} ${isDragging() ? 'is-active' : ''} ${props.class ?? ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: 'relative',
        'z-index': 20,
        'flex-shrink': 0,
        'user-select': 'none',
        'touch-action': 'none',
        cursor: props.direction === 'horizontal' ? 'col-resize' : 'row-resize',
        width: props.direction === 'horizontal' ? '6px' : '100%',
        height: props.direction === 'horizontal' ? '100%' : '6px',
        margin: props.direction === 'horizontal' ? '0 -3px' : '-3px 0',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
      }}
    >
      <div
        class="dock-splitter-line"
        style={{
          width: props.direction === 'horizontal' ? '1px' : '100%',
          height: props.direction === 'horizontal' ? '100%' : '1px',
          background: isDragging()
            ? 'var(--sig-tx, #06b6d4)'
            : 'var(--border-hairline, #1f2430)',
          'box-shadow': isDragging()
            ? '0 0 6px rgba(6, 182, 212, 0.5)'
            : 'none',
          transition: 'background 120ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 120ms cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      />
    </div>
  )
}
