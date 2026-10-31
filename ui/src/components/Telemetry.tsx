import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { SERIES_RGB, TraceRenderer } from '../lib/webgl'

/** Colours in plot order: the guide's state colours, then quiet extensions. */
export const SERIES_COLOURS = SERIES_RGB.map(([r, g, b]) => {
  const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
})

export interface SeriesLike {
  key: string
  values: number[]
}

interface Props {
  series: SeriesLike[]
  /** Samples shown per trace; the engine keeps 600 per field. */
  window?: number
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

/**
 * The telemetry band: GPU traces on one canvas, grid, labels, cursor and state lanes on
 * another above it.
 *
 * Two canvases rather than two contexts: a canvas owns exactly one, and mixing text and
 * WebGL in one would mean drawing the labels as geometry. The overlay is cheap; the data
 * is what needs the GPU.
 */
export function Telemetry(props: Props) {
  let tracesCanvas: HTMLCanvasElement | undefined
  let overlayCanvas: HTMLCanvasElement | undefined
  const [size, setSize] = createSignal({ width: 800, height: 160 })
  const [hover, setHover] = createSignal<number | null>(null)
  const [renderer, setRenderer] = createSignal<'webgl' | 'canvas'>('canvas')

  const windowSize = () => props.window ?? 600
  const visible = createMemo(() =>
    props.series.map((trace) => ({
      key: trace.key,
      values: trace.values.slice(-windowSize()),
    })),
  )
  const longest = createMemo(() =>
    visible().reduce((most, trace) => Math.max(most, trace.values.length), 0),
  )

  /** State lanes: discrete traces get a strip of their own instead of a line. */
  const lanes = createMemo(() => visible().filter((trace) => isDiscrete(trace.values)))

  const bounds = createMemo(() => {
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const trace of visible()) {
      if (isDiscrete(trace.values)) continue
      for (const value of trace.values) {
        if (!Number.isFinite(value)) continue
        if (value < low) low = value
        if (value > high) high = value
      }
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1 }
    if (high - low < 1e-9) return { low: low - 0.5, high: high + 0.5 }
    const pad = (high - low) * 0.08
    return { low: low - pad, high: high + pad }
  })

  const padding = { left: 46, right: 10, top: 8, bottom: 18 }
  const plotWidth = () => Math.max(1, size().width - padding.left - padding.right)
  const plotHeight = () => Math.max(1, size().height - padding.top - padding.bottom)

  const format = (value: number) => {
    const magnitude = Math.abs(value)
    if (magnitude !== 0 && (magnitude >= 100000 || magnitude < 0.001)) return value.toExponential(2)
    if (magnitude >= 1000) return value.toFixed(0)
    return value.toFixed(2)
  }

  function drawOverlay() {
    const element = overlayCanvas
    if (!element) return
    const ratio = globalThis.devicePixelRatio || 1
    const { width, height } = size()
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
    }
    const context = element.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const { low, high } = bounds()
    const span = high - low || 1
    const y = (value: number) => padding.top + plotHeight() - ((value - low) / span) * plotHeight()
    const x = (index: number, count: number) =>
      padding.left + (count <= 1 ? plotWidth() : (index / (count - 1)) * plotWidth())

    context.strokeStyle = '#1e2638'
    context.fillStyle = '#7c879c'
    context.lineWidth = 1
    context.font = '10px ui-monospace, monospace'
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (let step = 0; step <= 4; step += 1) {
      const value = low + (span * step) / 4
      const at = y(value)
      context.beginPath()
      context.moveTo(padding.left, at)
      context.lineTo(width - padding.right, at)
      context.stroke()
      context.fillText(format(value), padding.left - 6, at)
    }

    // State lanes, under the traces: one row per discrete field, a block per change.
    lanes().forEach((lane, laneIndex) => {
      const laneHeight = 6
      const laneY = padding.top + plotHeight() - 4 - laneIndex * (laneHeight + 3)
      const distinct = [...new Set(lane.values)].sort((a, b) => a - b)
      const colour = SERIES_COLOURS[(visible().findIndex((trace) => trace.key === lane.key)) % SERIES_COLOURS.length]
      context.globalAlpha = 0.55
      lane.values.forEach((value, index) => {
        if (index === 0) return
        if (value === lane.values[index - 1]) return
        const level = distinct.indexOf(value)
        context.fillStyle = colour
        context.globalAlpha = 0.15 + (0.6 * (level + 1)) / distinct.length
        context.fillRect(
          x(index, lane.values.length),
          laneY - laneHeight,
          Math.max(1, plotWidth() / Math.max(1, lane.values.length - 1)),
          laneHeight,
        )
      })
      context.globalAlpha = 1
      // The first stretch has no previous sample to change from, so it is drawn plainly.
      context.fillStyle = colour
      context.globalAlpha = 0.25
      context.fillRect(padding.left, laneY - laneHeight, x(1, lane.values.length) - padding.left, laneHeight)
      context.globalAlpha = 1
    })

    context.textAlign = 'left'
    context.textBaseline = 'alphabetic'
    context.fillStyle = '#7c879c'
    context.fillText(`${longest()} samples`, padding.left, height - 5)

    const cursor = hover()
    if (cursor !== null && longest() > 1) {
      const at = x(cursor, longest())
      context.strokeStyle = '#a78bfa'
      context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(at, padding.top)
      context.lineTo(at, padding.top + plotHeight())
      context.stroke()
      context.setLineDash([])
      visible().forEach((trace, index) => {
        const value = trace.values[cursor]
        if (value === undefined || isDiscrete(trace.values)) return
        context.fillStyle = SERIES_COLOURS[index % SERIES_COLOURS.length]
        context.beginPath()
        context.arc(at, y(value), 2.5, 0, Math.PI * 2)
        context.fill()
      })
    }
  }

  function drawTraces(renderer: TraceRenderer | null) {
    const element = tracesCanvas
    if (!element) return
    const ratio = globalThis.devicePixelRatio || 1
    const { width, height } = size()
    const { low, high } = bounds()
    const span = high - low || 1

    if (renderer) {
      renderer.resize(width, height, ratio)
      // Normalise to clip space here, where the padding and the range are known: pixel y
      // runs down the canvas, clip y runs up from the bottom edge.
      const toClip = (value: number, index: number, count: number): [number, number] => {
        const fraction = (value - low) / span
        const pixelX = padding.left + (count <= 1 ? 0 : (index / (count - 1)) * plotWidth())
        const pixelY = padding.top + plotHeight() * (1 - fraction)
        return [(pixelX / width) * 2 - 1, 1 - (pixelY / height) * 2]
      }
      const traces = visible()
        .map((trace, index) => {
          if (isDiscrete(trace.values) || trace.values.length < 2) return null
          const points: number[] = []
          trace.values.forEach((value, sample) => {
            const [x, y] = toClip(value, sample, trace.values.length)
            points.push(x, y)
          })
          return { colour: SERIES_RGB[index % SERIES_RGB.length], points }
        })
        .filter((trace): trace is { colour: [number, number, number]; points: number[] } => trace !== null)
      renderer.draw(traces)
      return
    }

    // No WebGL2: draw the same traces with the 2D context.
    const context = element.getContext('2d')
    if (!context) return
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.lineWidth = 1.5
    visible().forEach((trace, index) => {
      if (trace.values.length < 2 || isDiscrete(trace.values)) return
      context.strokeStyle = SERIES_COLOURS[index % SERIES_COLOURS.length]
      context.beginPath()
      trace.values.forEach((value, sample) => {
        const at =
          padding.left +
          (sample / (trace.values.length - 1)) * plotWidth()
        const level = padding.top + plotHeight() - ((value - low) / span) * plotHeight()
        if (sample === 0) context.moveTo(at, level)
        else context.lineTo(at, level)
      })
      context.stroke()
    })
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

  // A redraw whenever the data or the selection changes, so a paused tab stays correct.
  createEffect(() => {
    visible()
    bounds()
  })

  return (
    <div class="telemetry">
      <canvas class="traces" ref={tracesCanvas} aria-hidden="true" />
      <canvas
        class="overlay"
        ref={overlayCanvas}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`telemetry plot, ${renderer()} rendering`}
      />
    </div>
  )
}
