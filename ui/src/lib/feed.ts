// One EventSource for the whole app: the snapshot is the source of truth, the ui
// events are a hint, and the frames are the stream the viewport draws.

import { createSignal, onCleanup } from 'solid-js'
import type { SeriesUpdate, TailRow, UiEvent, UiSnapshot } from './types'

/** Frames kept in the viewport. The engine caps its own queue at 4096. */
const FRAME_WINDOW = 500

/** Samples kept per series, matching the engine's ring. */
const SERIES_SAMPLES = 600

export type Link = 'connecting' | 'live' | 'down'

export function createFeed() {
  const [snapshot, setSnapshot] = createSignal<UiSnapshot | null>(null)
  const [frames, setFrames] = createSignal<TailRow[]>([])
  const [events, setEvents] = createSignal<{ at: number; text: string }[]>([])
  const [link, setLink] = createSignal<Link>('connecting')
  const [received, setReceived] = createSignal(0)
  const [series, setSeries] = createSignal<Record<string, number[]>>({})
  // Batches the engine had to replace because this client was too far behind.
  const [missed, setMissed] = createSignal(0)

  const source = new EventSource('/api/events')

  source.addEventListener('open', () => setLink('live'))
  // A proxy in front of the engine can fire one error while it flushes, so the
  // badge follows the data: a frame that arrives proves the stream is open.
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) {
      setLink('down')
    } else if (snapshot() === null && received() === 0) {
      // Only before the first message: once data has arrived, a proxy retry is
      // not a loss of the stream.
      setLink('connecting')
    }
  })

  source.addEventListener('snapshot', (message) => {
    setSnapshot(JSON.parse((message as MessageEvent<string>).data) as UiSnapshot)
    setLink('live')
  })

  source.addEventListener('frames', (message) => {
    const incoming = JSON.parse((message as MessageEvent<string>).data) as TailRow[]
    setLink('live')
    setReceived((count) => count + incoming.length)
    setFrames((current) => {
      const next = current.concat(incoming)
      return next.length > FRAME_WINDOW ? next.slice(next.length - FRAME_WINDOW) : next
    })
  })

  source.addEventListener('series', (message) => {
    const updates = JSON.parse((message as MessageEvent<string>).data) as SeriesUpdate[]
    setLink('live')
    setSeries((current) => {
      const next = { ...current }
      for (const update of updates) {
        const key = `${update.port}.${update.field}`
        const ring = (next[key] ?? []).concat(update.values)
        next[key] = ring.length > SERIES_SAMPLES ? ring.slice(ring.length - SERIES_SAMPLES) : ring
      }
      return next
    })
  })

  source.addEventListener('sampled', (message) => {
    const update = JSON.parse((message as MessageEvent<string>).data) as { missed: number }
    setMissed(update.missed)
  })

  source.addEventListener('ui', (message) => {
    const event = JSON.parse((message as MessageEvent<string>).data) as UiEvent
    const { event: name, at_ms, ...rest } = event
    const text = Object.entries(rest)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
    setEvents((current) => [{ at: at_ms, text: `${name} ${text}` }, ...current].slice(0, 40))
  })

  onCleanup(() => source.close())

  return { snapshot, frames, events, link, received, series, missed }
}
