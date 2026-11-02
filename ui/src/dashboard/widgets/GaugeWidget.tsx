import { createMemo, type Component } from 'solid-js'
import { compileExpr } from '../expr'
import type { ActionHandler, GaugeNode } from '../types'

interface GaugeWidgetProps {
  node: GaugeNode
  context: () => Record<string, any>
  onAction?: ActionHandler
}

export const GaugeWidget: Component<GaugeWidgetProps> = (props) => {
  const evaluator = createMemo(() => compileExpr(props.node.source))

  const rawValue = createMemo(() => {
    try {
      const val = evaluator()(props.context())
      const num = Number(val)
      return isNaN(num) ? props.node.min : num
    } catch {
      return props.node.min
    }
  })

  const clampedValue = createMemo(() => {
    const min = props.node.min
    const max = props.node.max
    return Math.min(Math.max(rawValue(), min), max)
  })

  const normalized = createMemo(() => {
    const range = props.node.max - props.node.min
    if (range <= 0) return 0
    return (clampedValue() - props.node.min) / range
  })

  // Geometry: 270-degree arc from 135deg (bottom-left) to 405deg (bottom-right)
  const cx = 100
  const cy = 95
  const radius = 68
  const startAngleDeg = 135
  const sweepAngleDeg = 270

  const angleRad = (deg: number) => (deg * Math.PI) / 180

  const pointAt = (angleDeg: number, r: number) => {
    const rad = angleRad(angleDeg)
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    }
  }

  const arcPath = (startDeg: number, endDeg: number, r: number) => {
    const start = pointAt(startDeg, r)
    const end = pointAt(endDeg, r)
    const largeArc = endDeg - startDeg > 180 ? 1 : 0
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`
  }

  // Warning & Fault zone computations
  const lowThreshold = () => props.node.zones?.low
  const highThreshold = () => props.node.zones?.high

  const isWarn = createMemo(() => {
    const low = lowThreshold()
    return low !== undefined && rawValue() < low
  })

  const isFault = createMemo(() => {
    const high = highThreshold()
    return high !== undefined && rawValue() > high
  })

  const activeColor = createMemo(() => {
    if (isFault()) return props.node.zones?.faultColor || 'var(--sig-fault, #f43f5e)'
    if (isWarn()) return props.node.zones?.warnColor || 'var(--sig-warn, #f59e0b)'
    return 'var(--sig-tx, #06b6d4)'
  })

  // Needle angle
  const needleDeg = createMemo(() => startAngleDeg + normalized() * sweepAngleDeg)

  // Major tick marks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const deg = startAngleDeg + ratio * sweepAngleDeg
    const p1 = pointAt(deg, radius - 4)
    const p2 = pointAt(deg, radius + 4)
    const val = props.node.min + ratio * (props.node.max - props.node.min)
    const labelPos = pointAt(deg, radius - 16)
    return { p1, p2, val, labelPos }
  })

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        padding: '12px 8px 8px 8px',
        background: 'var(--bg-surface-2, #161920)',
        border: '1px solid var(--border-hairline, #1f2430)',
        'border-radius': '8px',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.3)',
        'min-width': '160px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Widget Header Label */}
      <div
        style={{
          'font-size': '11px',
          'font-weight': '600',
          'letter-spacing': '0.04em',
          'text-transform': 'uppercase',
          color: 'var(--text-secondary, #949eb2)',
          'margin-bottom': '2px',
        }}
      >
        {props.node.label || 'GAUGE'}
      </div>

      {/* SVG Instrument Dial */}
      <svg
        viewBox="0 0 200 170"
        style={{
          width: '100%',
          'max-width': '190px',
          height: 'auto',
          overflow: 'visible',
        }}
      >
        <defs>
          <filter id="gauge-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Dial Background Track */}
        <path
          d={arcPath(startAngleDeg, startAngleDeg + sweepAngleDeg, radius)}
          fill="none"
          stroke="var(--bg-surface-3, #1e222b)"
          stroke-width="8"
          stroke-linecap="round"
        />

        {/* High / Fault Zone arc if defined */}
        {highThreshold() !== undefined && (
          <path
            d={arcPath(
              startAngleDeg +
                Math.max(0, (highThreshold()! - props.node.min) / (props.node.max - props.node.min)) *
                  sweepAngleDeg,
              startAngleDeg + sweepAngleDeg,
              radius,
            )}
            fill="none"
            stroke={props.node.zones?.faultColor || 'rgba(244, 63, 94, 0.4)'}
            stroke-width="8"
            stroke-linecap="round"
          />
        )}

        {/* Low / Warn Zone arc if defined */}
        {lowThreshold() !== undefined && (
          <path
            d={arcPath(
              startAngleDeg,
              startAngleDeg +
                Math.min(1, Math.max(0, (lowThreshold()! - props.node.min) / (props.node.max - props.node.min))) *
                  sweepAngleDeg,
              radius,
            )}
            fill="none"
            stroke={props.node.zones?.warnColor || 'rgba(245, 158, 11, 0.4)'}
            stroke-width="8"
            stroke-linecap="round"
          />
        )}

        {/* Active Value Arc */}
        <path
          d={arcPath(startAngleDeg, Math.max(startAngleDeg + 0.1, needleDeg()), radius)}
          fill="none"
          stroke={activeColor()}
          stroke-width="8"
          stroke-linecap="round"
          filter="url(#gauge-glow)"
          style={{ transition: 'stroke 0.2s ease' }}
        />

        {/* Major Ticks & Labels */}
        {ticks.map((t) => (
          <g>
            <line
              x1={t.p1.x}
              y1={t.p1.y}
              x2={t.p2.x}
              y2={t.p2.y}
              stroke="var(--border-strong, #2d3446)"
              stroke-width="1.5"
            />
            <text
              x={t.labelPos.x}
              y={t.labelPos.y}
              text-anchor="middle"
              dominant-baseline="central"
              font-family="var(--font-mono, monospace)"
              font-size="9"
              fill="var(--text-muted, #5e677a)"
            >
              {Math.round(t.val)}
            </text>
          </g>
        ))}

        {/* Gauge Needle */}
        <g
          style={{
            transform: `rotate(${needleDeg() + 90}deg)`,
            'transform-origin': `${cx}px ${cy}px`,
            transition: 'transform 0.15s cubic-bezier(0.23, 1, 0.32, 1)',
          }}
        >
          <polygon
            points={`${cx - 2.5},${cy} ${cx},${cy - radius + 10} ${cx + 2.5},${cy} ${cx},${cy + 10}`}
            fill={activeColor()}
          />
          <circle cx={cx} cy={cy} r="6" fill="var(--bg-surface-1, #101217)" stroke={activeColor()} stroke-width="2" />
          <circle cx={cx} cy={cy} r="2" fill="#fff" />
        </g>
      </svg>

      {/* Digital Readout */}
      <div
        style={{
          display: 'flex',
          'align-items': 'baseline',
          gap: '4px',
          'margin-top': '-12px',
        }}
      >
        <span
          style={{
            'font-family': 'var(--font-mono, monospace)',
            'font-size': '20px',
            'font-weight': '700',
            color: activeColor(),
            'letter-spacing': '-0.02em',
          }}
        >
          {Number.isInteger(rawValue()) ? rawValue() : rawValue().toFixed(1)}
        </span>
        {props.node.unit && (
          <span
            style={{
              'font-family': 'var(--font-mono, monospace)',
              'font-size': '11px',
              'font-weight': '500',
              color: 'var(--text-muted, #5e677a)',
            }}
          >
            {props.node.unit}
          </span>
        )}
      </div>
    </div>
  )
}
