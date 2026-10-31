import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'

/** Colours in plot order: the guide's state colours, then quiet extensions. */
export const SERIES_COLOURS = ['#10b981', '#06b6d4', '#f59e0b', '#ef4444', '#a78bfa', '#38bdf8']

export interface SeriesLike {
  key: string
  values: number[]
}

interface Props {
  series: SeriesLike[]
  /** Samples shown per trace; the engine keeps 600 per field. */
  window?: number
}

/**
 * The telemetry band: one canvas, one animation frame at a time.
 *
 * A canvas at device pixel ratio is what keeps this at 60 FPS with several traces;
 * SVG re-creates every node on each sample batch. Hovering reads the value under the
 * cursor, which is the other half of "plot this field" being useful.
 */
export function Telemetry(props: Props) {
  let canvas: HTMLCanvasElement | undefined
  const [size, setSize] = createSignal({ width: 800, height: 160 })
  const [hover, setHover] = createSignal<number | null>(null)

  const windowSize = () => props.window ?? 600
  const visible = createMemo(() =>
    props.series.map((trace) => ({
      key: trace.key,
      values: trace.values.slice(-windowSize()),
    })),
  )

  const bounds = createMemo(() => {
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const trace of visible()) {
      for (const value of trace.values) {
        if (!Number.isFinite(value)) continue
        if (value < low) low = value
        if (value > high) high = value
      }
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 1 }
    // A flat trace still needs a band to draw inside.
    if (high - low < 1e-9) return { low: low - 0.5, high: high + 0.5 }
    const pad = (high - low) * 0.08
    return { low: low - pad, high: high + pad }
  })

  const longest = createMemo(() =>
    visible().reduce((most, trace) => Math.max(most, trace.values.length), 0),
  )

  const format = (value: number) => {
    const size = Math.abs(value)
    if (size !== 0 && (size >= 100000 || size < 0.001)) return value.toExponential(2)
    if (size >= 1000) return value.toFixed(0)
    return value.toFixed(2)
  }

  function draw() {
    const element = canvas
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

    const padding = { left: 46, right: 10, top: 8, bottom: 18 }
    const plotWidth = Math.max(1, width - padding.left - padding.right)
    const plotHeight = Math.max(1, height - padding.top - padding.bottom)
    const { low, high } = bounds()
    const span = high - low || 1
    const x = (index: number, count: number) =>
      padding.left + (count <= 1 ? plotWidth : (index / (count - 1)) * plotWidth)
    const y = (value: number) => padding.top + plotHeight - ((value - low) / span) * plotHeight

    // Grid and labels, drawn in the hairline colour so data stays the brightest thing.
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

    context.textAlign = 'left'
    context.textBaseline = 'alphabetic'
    context.fillText(`${longest()} samples`, padding.left, height - 5)

    // Traces.
    context.lineWidth = 1.5
    visible().forEach((trace, index) => {
      if (trace.values.length < 2) return
      context.strokeStyle = SERIES_COLOURS[index % SERIES_COLOURS.length]
      context.beginPath()
      trace.values.forEach((value, sample) => {
        const pointX = x(sample, trace.values.length)
        const pointY = y(value)
        if (sample === 0) context.moveTo(pointX, pointY)
        else context.lineTo(pointX, pointY)
      })
      context.stroke()
    })

    // Cursor: a vertical line and a dot per trace, so a frame can be read exactly.
    const cursor = hover()
    if (cursor !== null && longest() > 1) {
      const at = x(cursor, longest())
      context.strokeStyle = '#a78bfa'
      context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(at, padding.top)
      context.lineTo(at, padding.top + plotHeight)
      context.stroke()
      context.setLineDash([])
      visible().forEach((trace, index) => {
        const value = trace.values[cursor]
        if (value === undefined) return
        context.fillStyle = SERIES_COLOURS[index % SERIES_COLOURS.length]
        context.beginPath()
        context.arc(at, y(value), 2.5, 0, Math.PI * 2)
        context.fill()
      })
    }
  }

  function onMove(event: PointerEvent) {
    const element = canvas
    if (!element) return
    const rect = element.getBoundingClientRect()
    const padding = { left: 46, right: 10 }
    const plotWidth = Math.max(1, rect.width - padding.left - padding.right)
    const relative = (event.clientX - rect.left - padding.left) / plotWidth
    const count = longest()
    if (count < 2) return setHover(null)
    const index = Math.round(Math.min(1, Math.max(0, relative)) * (count - 1))
    setHover(index)
  }

  onMount(() => {
    const element = canvas
    if (!element) return
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })

    let frame = 0
    let last = 0
    const tick = (time: number) => {
      // Draw at most every 16 ms: the data arrives every 200 ms, but the cursor and the
      // autoscale must follow a pointer without waiting for the next batch.
      if (time - last >= 16) {
        last = time
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    onCleanup(() => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    })
  })

  // Redraw once whenever the data or the selection changes, so a paused tab is correct.
  createEffect(() => {
    visible()
    bounds()
    draw()
  })

  return (
    <div class="telemetry">
      <canvas
        ref={canvas}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        aria-label="telemetry plot"
        role="img"
      />
    </div>
  )
}
