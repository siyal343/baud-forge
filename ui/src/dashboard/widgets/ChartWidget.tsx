import { createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js'
import { compileExpr } from '../expr'
import type { ActionHandler, ChartNode } from '../types'

interface ChartWidgetProps {
  node: ChartNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

interface DataPoint {
  time: number
  value: number
}

export const ChartWidget: Component<ChartWidgetProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined

  const evaluator = createMemo(() => compileExpr(props.node.source))
  const [history, setHistory] = createSignal<DataPoint[]>([])
  const [currentVal, setCurrentVal] = createSignal<number>(0)

  const strokeColor = () => props.node.color || 'var(--sig-tx, #06b6d4)'
  const chartHeight = () => props.node.height || 140
  const maxPoints = 120

  // Sample incoming telemetry reactively
  createEffect(() => {
    try {
      const val = evaluator()(props.context())
      const num = Number(val)
      if (!isNaN(num)) {
        setCurrentVal(num)
        setHistory((prev) => {
          const next = [...prev, { time: Date.now(), value: num }]
          if (next.length > maxPoints) {
            return next.slice(next.length - maxPoints)
          }
          return next
        })
      }
    } catch {
      // Ignored during transient context loads
    }
  })

  // Canvas drawing routine
  const renderChart = () => {
    if (!canvasRef || !containerRef) return
    const canvas = canvasRef
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = containerRef.getBoundingClientRect()
    const width = rect.width
    const height = chartHeight()

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr
      canvas.height = height * dpr
    }

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    // Background grid
    ctx.strokeStyle = '#1f2430'
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])

    // Draw 3 horizontal gridlines
    for (let i = 1; i <= 3; i++) {
      const y = (height / 4) * i
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    ctx.setLineDash([])

    const pts = history()
    if (pts.length < 2) {
      ctx.restore()
      return
    }

    // Determine scale bounds
    let minBound = props.node.min !== undefined ? props.node.min : Infinity
    let maxBound = props.node.max !== undefined ? props.node.max : -Infinity

    if (props.node.min === undefined || props.node.max === undefined) {
      for (const p of pts) {
        if (props.node.min === undefined && p.value < minBound) minBound = p.value
        if (props.node.max === undefined && p.value > maxBound) maxBound = p.value
      }
    }

    if (minBound === maxBound || !isFinite(minBound) || !isFinite(maxBound)) {
      minBound = minBound - 1
      maxBound = maxBound + 1
    }

    const range = maxBound - minBound
    const paddingY = 8
    const usableHeight = height - paddingY * 2

    const getY = (val: number) => {
      const norm = (val - minBound) / range
      return height - paddingY - norm * usableHeight
    }

    const stepX = width / (maxPoints - 1)
    const startX = width - (pts.length - 1) * stepX

    // Draw filled gradient area
    const gradient = ctx.createLinearGradient(0, 0, 0, height)
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.25)')
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)')

    ctx.beginPath()
    ctx.moveTo(startX, height)
    pts.forEach((p, idx) => {
      const x = startX + idx * stepX
      const y = getY(p.value)
      ctx.lineTo(x, y)
    })
    ctx.lineTo(startX + (pts.length - 1) * stepX, height)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    // Draw line plot
    ctx.beginPath()
    ctx.strokeStyle = strokeColor().startsWith('var') ? '#06b6d4' : strokeColor()
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    pts.forEach((p, idx) => {
      const x = startX + idx * stepX
      const y = getY(p.value)
      if (idx === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Draw current head point
    if (pts.length > 0) {
      const lastX = startX + (pts.length - 1) * stepX
      const lastY = getY(pts[pts.length - 1].value)
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()
  }

  onMount(() => {
    let animId: number
    const loop = () => {
      renderChart()
      animId = requestAnimationFrame(loop)
    }
    animId = requestAnimationFrame(loop)

    const observer = new ResizeObserver(() => {
      renderChart()
    })
    if (containerRef) {
      observer.observe(containerRef)
    }

    onCleanup(() => {
      cancelAnimationFrame(animId)
      observer.disconnect()
    })
  })

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        padding: '12px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '8px',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
        'min-width': '220px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Chart Header */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          'margin-bottom': '8px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: strokeColor().startsWith('var') ? '#06b6d4' : strokeColor(),
              'box-shadow': '0 0 6px rgba(6, 182, 212, 0.6)',
            }}
          />
          <span
            style={{
              'font-size': '11px',
              'font-weight': '600',
              'letter-spacing': '0.04em',
              'text-transform': 'uppercase',
              color: 'var(--text-secondary, #949eb2)',
            }}
          >
            {props.node.source}
          </span>
        </div>
        <span
          style={{
            'font-family': 'var(--font-mono, monospace)',
            'font-size': '12px',
            'font-weight': '700',
            color: 'var(--text-primary, #edf0f7)',
          }}
        >
          {Number.isInteger(currentVal()) ? currentVal() : currentVal().toFixed(2)}
        </span>
      </div>

      {/* Chart Canvas */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: `${chartHeight()}px`,
          display: 'block',
          background: 'var(--bg-canvas, #090a0d)',
          'border-radius': '6px',
          border: '1px solid var(--border-hairline, #1f2430)',
        }}
      />
    </div>
  )
}
