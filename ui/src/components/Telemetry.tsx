import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { SERIES_RGB, TraceRenderer } from '../lib/webgl'

/** Colours in plot order: the guide's state colours, then quiet extensions. */
export const SERIES_COLOURS = SERIES_RGB.map(([r, g, b]) => {
  const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
})

/** How a trace is drawn: as a measurement, a state, or a rail per bit. */
export type TraceMode = 'line' | 'lane' | 'bits'

export interface SeriesLike {
  key: string
  values: number[]
  /** Missing means a line, which is what a measurement is. */
  mode?: TraceMode
}

interface Props {
  series: SeriesLike[]
  /** Samples shown per trace; the engine keeps 600 per field. */
  window?: number
  /** One row per measurement, each with its own scale. */
  stack?: boolean
  /** Told which renderer is live, so the header can say so. */
  onRenderer?: (renderer: 'webgl' | 'canvas') => void
}

/** A trace whose values are whole and few is a state, not a measurement. */
function isDiscrete(values: number[]): boolean {
  const distinct = new Set<number>()
  for (const value of values) {
    if (!Number.isInteger(value)) return false
    distinct.add(value)
    if (distinct.size > 8) return false
  }
  return distinct.size > 0
}

interface Row {
  traces: { key: string; values: number[]; colourIndex: number }[]
  low: number
  high: number
  top: number
  height: number
}

/**
 * The telemetry band: GPU traces on one canvas, oscilloscope graticule, labels,
 * cursor, lanes and rails on an overlay canvas above it.
 */
export function Telemetry(props: Props) {
  let tracesCanvas: HTMLCanvasElement | undefined
  let overlayCanvas: HTMLCanvasElement | undefined
  const [size, setSize] = createSignal({ width: 800, height: 160 })
  const [hover, setHover] = createSignal<number | null>(null)
  const [renderer, setRenderer] = createSignal<'webgl' | 'canvas'>('canvas')

  const windowSize = () => props.window ?? 600
  const visible = createMemo(() =>
    props.series.map((trace, index) => ({
      key: trace.key,
      mode: trace.mode ?? 'line',
      colourIndex: index,
      values: trace.values.slice(-windowSize()),
    })),
  )
  const longest = createMemo(() =>
    visible().reduce((most, trace) => Math.max(most, trace.values.length), 0),
  )

  /** State lanes: a discrete trace asked for as a lane gets a strip, not a line. */
  const lanes = createMemo(() => visible().filter((trace) => trace.mode === 'lane'))
  /** Bit rails: one row per bit of a flags word. */
  const rails = createMemo(() => visible().filter((trace) => trace.mode === 'bits'))
  /** Lines: the measurements, which is what the rows scale. */
  const lines = createMemo(() =>
    visible().filter((trace) => trace.mode === 'line' && !isDiscrete(trace.values)),
  )

  const padding = { left: 46, right: 10, top: 8, bottom: 18 }
  const plotWidth = () => Math.max(1, size().width - padding.left - padding.right)

  /** Height the lanes and rails need under the traces. */
  const reserved = () => {
    const laneRows = lanes().length * 10
    const railRows = rails().reduce((total, rail) => {
      const bits = Math.max(1, Math.min(16, 32 - Math.clz32(bitsOf(rail.values))))
      return total + bits * 4 + 6
    }, 0)
    return laneRows + railRows + 8
  }

  /** The rows of measurements: one, or one per trace when stacked. */
  const rows = createMemo<Row[]>(() => {
    const plotHeight = Math.max(
      20,
      size().height - padding.top - padding.bottom - reserved(),
    )
    const traces = lines()
    const count = props.stack ? Math.max(1, Math.min(3, traces.length)) : 1
    const gap = count > 1 ? 10 : 0
    const height = Math.max(16, (plotHeight - gap * (count - 1)) / count)
    const groups: Row['traces'][] = Array.from({ length: count }, () => [])
    traces.forEach((trace, index) => groups[index % count].push(trace))
    return groups.map((group, index) => {
      let low = Number.POSITIVE_INFINITY
      let high = Number.NEGATIVE_INFINITY
      for (const trace of group) {
        for (const value of trace.values) {
          if (!Number.isFinite(value)) continue
          if (value < low) low = value
          if (value > high) high = value
        }
      }
      if (!Number.isFinite(low) || !Number.isFinite(high)) {
        low = 0
        high = 1
      }
      if (high - low < 1e-9) {
        low -= 0.5
        high += 0.5
      }
      const pad = (high - low) * 0.08
      return {
        traces: group,
        low: low - pad,
        high: high + pad,
        top: padding.top + index * (height + gap),
        height,
      }
    })
  })

  const format = (value: number) => {
    const magnitude = Math.abs(value)
    if (magnitude !== 0 && (magnitude >= 100000 || magnitude < 0.001)) return value.toExponential(2)
    if (magnitude >= 1000) return value.toFixed(0)
    return value.toFixed(2)
  }

  const bitsOf = (values: number[]) =>
    values.reduce(
      (most, value) => Math.max(most, Number.isFinite(value) ? Math.floor(value) : 0),
      0,
    )

  function drawOverlay() {
    const element = overlayCanvas
    if (!element) return
    const ratio = globalThis.devicePixelRatio || 1
    const { width, height } = size()
    if (
      element.width !== Math.round(width * ratio) ||
      element.height !== Math.round(height * ratio)
    ) {
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
    }
    const context = element.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.font = '10px "JetBrains Mono", ui-monospace, monospace'
    context.lineWidth = 1

    const bottom = rows().length > 0 ? rows().at(-1)!.top + rows().at(-1)!.height : padding.top

    // Vertical time-division grid lines (8 divisions across plotWidth)
    context.save()
    context.strokeStyle = '#161920'
    context.setLineDash([2, 3])
    for (let division = 1; division < 8; division += 1) {
      const vx = padding.left + (division * plotWidth()) / 8
      context.beginPath()
      context.moveTo(vx, padding.top)
      context.lineTo(vx, bottom)
      context.stroke()
    }
    context.restore()

    // Horizontal scale lines per row with right-aligned Y-axis labels
    rows().forEach((row) => {
      const span = row.high - row.low || 1
      context.strokeStyle = '#1f2430'
      context.fillStyle = '#949eb2'
      context.textAlign = 'right'
      context.textBaseline = 'middle'
      context.font = '10px "JetBrains Mono", ui-monospace, monospace'

      for (let step = 0; step <= 2; step += 1) {
        const value = row.low + (span * step) / 2
        const at = row.top + row.height - (row.height * step) / 2
        context.beginPath()
        context.moveTo(padding.left, at)
        context.lineTo(width - padding.right, at)
        context.stroke()
        context.fillText(format(value), padding.left - 6, at)
      }

      // Subtle dark pill behind trace label when stacked
      if (props.stack && row.traces.length > 0) {
        const labels = row.traces.map((trace) => trace.key.split('.').slice(-1)[0]).join(' ')
        context.font = '10px "JetBrains Mono", ui-monospace, monospace'
        const metrics = context.measureText(labels)
        const pillX = padding.left + 4
        const pillY = row.top + 3
        const pillW = metrics.width + 10
        const pillH = 14

        context.save()
        context.fillStyle = 'rgba(16, 18, 23, 0.88)'
        context.strokeStyle = '#1f2430'
        context.lineWidth = 1
        if (typeof context.roundRect === 'function') {
          context.beginPath()
          context.roundRect(pillX, pillY, pillW, pillH, 3)
          context.fill()
          context.stroke()
        } else {
          context.fillRect(pillX, pillY, pillW, pillH)
          context.strokeRect(pillX, pillY, pillW, pillH)
        }
        context.textAlign = 'left'
        context.textBaseline = 'middle'
        context.fillStyle = SERIES_COLOURS[row.traces[0].colourIndex % SERIES_COLOURS.length]
        context.fillText(labels, pillX + 5, pillY + pillH / 2)
        context.restore()
      }
    })

    const x = (index: number, count: number) =>
      padding.left + (count <= 1 ? plotWidth() : (index / (count - 1)) * plotWidth())

    // Logic analyzer bit rails under the rows: inactive rail tracks (#181c24) and high bits
    let railTop = bottom + 6
    rails().forEach((rail) => {
      const bits = Math.max(1, Math.min(16, 32 - Math.clz32(bitsOf(rail.values))))
      const rowHeight = 3
      const gap = 1
      const totalRailHeight = bits * (rowHeight + gap)
      const colour = SERIES_COLOURS[rail.colourIndex % SERIES_COLOURS.length]

      // Left gutter label: 'bits'
      context.font = '10px "JetBrains Mono", ui-monospace, monospace'
      context.textAlign = 'right'
      context.textBaseline = 'middle'
      context.fillStyle = '#5e677a'
      context.fillText('bits', padding.left - 6, railTop + totalRailHeight / 2)

      // Inactive bit rail tracks
      for (let bit = 0; bit < bits; bit += 1) {
        const y = railTop + (bits - 1 - bit) * (rowHeight + gap)
        context.fillStyle = '#181c24'
        context.fillRect(padding.left, y, plotWidth(), rowHeight)
      }

      // Active high bits
      if (rail.values.length > 1) {
        const step = plotWidth() / (rail.values.length - 1)
        rail.values.forEach((value, index) => {
          for (let bit = 0; bit < bits; bit += 1) {
            if (((Math.floor(value) >> bit) & 1) === 0) continue
            context.fillStyle = colour
            context.fillRect(
              padding.left + index * step,
              railTop + (bits - 1 - bit) * (rowHeight + gap),
              Math.max(1, step),
              rowHeight,
            )
          }
        })
      }
      railTop += totalRailHeight + 6
    })

    // State lanes below rails: inactive background track + shaded level blocks
    let laneTop = railTop + 2
    lanes().forEach((lane) => {
      const laneHeight = 6
      const distinct = [...new Set(lane.values)].sort((a, b) => a - b)
      const colour = SERIES_COLOURS[lane.colourIndex % SERIES_COLOURS.length]

      // Left gutter label: 'lane'
      context.font = '10px "JetBrains Mono", ui-monospace, monospace'
      context.textAlign = 'right'
      context.textBaseline = 'middle'
      context.fillStyle = '#5e677a'
      context.fillText('lane', padding.left - 6, laneTop + laneHeight / 2)

      // Inactive track
      context.fillStyle = '#181c24'
      context.fillRect(padding.left, laneTop, plotWidth(), laneHeight)

      // State blocks
      lane.values.forEach((value, index) => {
        if (index === 0) return
        if (value === lane.values[index - 1]) return
        const level = distinct.indexOf(value)
        context.fillStyle = colour
        context.globalAlpha = 0.15 + (0.6 * (level + 1)) / distinct.length
        context.fillRect(
          x(index, lane.values.length),
          laneTop,
          Math.max(1, plotWidth() / Math.max(1, lane.values.length - 1)),
          laneHeight,
        )
      })
      context.globalAlpha = 1
      laneTop += laneHeight + 4
    })

    // Sample count readout in bottom-left
    context.textAlign = 'left'
    context.textBaseline = 'alphabetic'
    context.fillStyle = '#5e677a'
    context.font = '10px "JetBrains Mono", ui-monospace, monospace'
    context.fillText(`${longest()} samples`, padding.left, height - 5)

    // Interactive crosshair & multi-trace readout HUD
    const cursor = hover()
    if (cursor !== null && longest() > 1) {
      const at = x(cursor, longest())

      // Crisp vertical cursor line
      context.save()
      context.strokeStyle = '#06b6d4'
      context.lineWidth = 1
      context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(at, padding.top)
      context.lineTo(at, bottom)
      context.stroke()
      context.restore()

      // Trace sample points and HUD items
      const readouts: { name: string; value: string; colour: string }[] = []

      rows().forEach((row) => {
        const span = row.high - row.low || 1
        for (const trace of row.traces) {
          const value = trace.values[cursor]
          if (value === undefined) continue
          const y = row.top + row.height - ((value - row.low) / span) * row.height
          const colour = SERIES_COLOURS[trace.colourIndex % SERIES_COLOURS.length]

          // 3px circle with dark #090a0d 1.5px stroke
          context.save()
          context.beginPath()
          context.arc(at, y, 3, 0, Math.PI * 2)
          context.fillStyle = colour
          context.fill()
          context.lineWidth = 1.5
          context.strokeStyle = '#090a0d'
          context.stroke()
          context.restore()

          const shortName = trace.key.split('.').slice(-1)[0]
          readouts.push({
            name: shortName,
            value: format(value),
            colour,
          })
        }
      })

      lanes().forEach((lane) => {
        const value = lane.values[cursor]
        if (value !== undefined) {
          readouts.push({
            name: lane.key.split('.').slice(-1)[0],
            value: String(value),
            colour: SERIES_COLOURS[lane.colourIndex % SERIES_COLOURS.length],
          })
        }
      })

      rails().forEach((rail) => {
        const value = rail.values[cursor]
        if (value !== undefined) {
          readouts.push({
            name: rail.key.split('.').slice(-1)[0],
            value: `0x${Math.floor(value).toString(16).toUpperCase()}`,
            colour: SERIES_COLOURS[rail.colourIndex % SERIES_COLOURS.length],
          })
        }
      })

      // Compact translucent HUD readout box
      context.font = '10px "JetBrains Mono", ui-monospace, monospace'
      const titleText = `sample #${cursor}`
      let maxContentWidth = context.measureText(titleText).width

      for (const item of readouts) {
        const lineText = `${item.name}: ${item.value}`
        const itemWidth = context.measureText(lineText).width
        if (itemWidth > maxContentWidth) maxContentWidth = itemWidth
      }

      const hudPaddingX = 8
      const hudPaddingY = 6
      const hudLineHeight = 13
      const hudWidth = maxContentWidth + hudPaddingX * 2
      const hudHeight = hudPaddingY * 2 + (1 + readouts.length) * hudLineHeight

      let hudX = width - padding.right - hudWidth - 6
      const hudY = padding.top + 4

      // Reposition HUD to left if cursor lies directly beneath it
      if (at > hudX - 20 && at < hudX + hudWidth + 20) {
        hudX = padding.left + 6
      }

      context.save()
      context.fillStyle = 'rgba(16, 18, 23, 0.92)'
      context.strokeStyle = '#2d3446'
      context.lineWidth = 1

      if (typeof context.roundRect === 'function') {
        context.beginPath()
        context.roundRect(hudX, hudY, hudWidth, hudHeight, 4)
        context.fill()
        context.stroke()
      } else {
        context.fillRect(hudX, hudY, hudWidth, hudHeight)
        context.strokeRect(hudX, hudY, hudWidth, hudHeight)
      }

      context.textAlign = 'left'
      context.textBaseline = 'top'
      context.fillStyle = '#949eb2'
      context.fillText(titleText, hudX + hudPaddingX, hudY + hudPaddingY)

      readouts.forEach((item, idx) => {
        const itemY = hudY + hudPaddingY + (idx + 1) * hudLineHeight
        context.fillStyle = item.colour
        context.fillText(`${item.name}: `, hudX + hudPaddingX, itemY)
        const nameWidth = context.measureText(`${item.name}: `).width
        context.fillStyle = '#edf0f7'
        context.fillText(item.value, hudX + hudPaddingX + nameWidth, itemY)
      })

      context.restore()
    }
  }

  function drawTraces(gpu: TraceRenderer | null) {
    const element = tracesCanvas
    if (!element) return
    const ratio = globalThis.devicePixelRatio || 1
    const { width, height } = size()

    if (gpu) {
      gpu.resize(width, height, ratio)
      // Clip space runs from the bottom edge: each row maps its own range into its band.
      const traces: { colour: [number, number, number]; points: number[] }[] = []
      for (const row of rows()) {
        const span = row.high - row.low || 1
        for (const trace of row.traces) {
          if (trace.values.length < 2) continue
          const points: number[] = []
          trace.values.forEach((value, index) => {
            const pixelX = padding.left + (index / (trace.values.length - 1)) * plotWidth()
            const pixelY = row.top + row.height - ((value - row.low) / span) * row.height
            points.push((pixelX / width) * 2 - 1, 1 - (pixelY / height) * 2)
          })
          traces.push({
            colour: SERIES_RGB[trace.colourIndex % SERIES_RGB.length],
            points,
          })
        }
      }
      gpu.draw(traces)
      return
    }

    // No WebGL2: draw the same traces with the 2D context.
    const context = element.getContext('2d')
    if (!context) return
    if (
      element.width !== Math.round(width * ratio) ||
      element.height !== Math.round(height * ratio)
    ) {
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.lineWidth = 1.5
    for (const row of rows()) {
      const span = row.high - row.low || 1
      for (const trace of row.traces) {
        if (trace.values.length < 2) continue
        context.strokeStyle = SERIES_COLOURS[trace.colourIndex % SERIES_COLOURS.length]
        context.beginPath()
        trace.values.forEach((value, index) => {
          const at = padding.left + (index / (trace.values.length - 1)) * plotWidth()
          const level = row.top + row.height - ((value - row.low) / span) * row.height
          if (index === 0) context.moveTo(at, level)
          else context.lineTo(at, level)
        })
        context.stroke()
      }
    }
  }

  function onMove(event: PointerEvent) {
    const element = overlayCanvas
    if (!element) return
    const rect = element.getBoundingClientRect()
    const relative = (event.clientX - rect.left - padding.left) / plotWidth()
    const count = longest()
    if (count < 2) return setHover(null)
    setHover(Math.round(Math.min(1, Math.max(0, relative)) * (count - 1)))
  }

  onMount(() => {
    const gpu = tracesCanvas ? TraceRenderer.create(tracesCanvas) : null
    setRenderer(gpu ? 'webgl' : 'canvas')
    props.onRenderer?.(gpu ? 'webgl' : 'canvas')

    const element = overlayCanvas
    if (!element) return
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })

    let frame = 0
    let last = 0
    const tick = (time: number) => {
      if (time - last >= 16) {
        last = time
        drawTraces(gpu)
        drawOverlay()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    })
  })

  // A redraw whenever the data, the selection or the row layout changes.
  createEffect(() => {
    visible()
    rows()
  })

  return (
    <div class={`telemetry${props.stack ? ' stacked' : ''}`}>
      <canvas class="traces" ref={tracesCanvas} aria-hidden="true" />
      <canvas
        class="overlay"
        ref={overlayCanvas}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`telemetry plot, ${renderer()} rendering${props.stack ? ', stacked rows' : ''}`}
      />
    </div>
  )
}
