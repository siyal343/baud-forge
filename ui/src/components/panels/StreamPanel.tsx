import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { WorkbenchStore } from '../../lib/store'
import { visibleColumns, allColumns, toggleColumnVisibility } from '../../lib/columns'
import { sourceOf, shortName } from '../InspectorPane'

const clock = (us: number) => `${(us / 1e6).toFixed(4)} s`

export function StreamPanel(props: { store: WorkbenchStore }) {
  const { store } = props

  let viewportRef: HTMLDivElement | undefined
  let searchInputRef: HTMLInputElement | undefined

  const [columnMenuOpen, setColumnMenuOpen] = createSignal(false)

  // Virtualizer row height bound to density CSS setting
  const getRowHeight = () => {
    if (typeof window === 'undefined') return 26
    const style = getComputedStyle(document.documentElement)
    const h = parseInt(style.getPropertyValue('--row-height'), 10)
    return Number.isFinite(h) && h > 0 ? h : 26
  }

  const OVERSCAN = 8
  const totalRows = () => store.allRows().length
  const startIndex = createMemo(() =>
    Math.max(0, Math.floor(store.scrollTop() / getRowHeight()) - OVERSCAN),
  )
  const endIndex = createMemo(() =>
    Math.min(
      totalRows(),
      Math.ceil((store.scrollTop() + store.viewportHeight()) / getRowHeight()) + OVERSCAN,
    ),
  )

  const visibleRows = createMemo(() => store.allRows().slice(startIndex(), endIndex()))
  const topSpacer = createMemo(() => startIndex() * getRowHeight())
  const bottomSpacer = createMemo(() =>
    Math.max(0, (totalRows() - endIndex()) * getRowHeight()),
  )

  function onViewportScroll(event: Event) {
    const el = event.currentTarget as HTMLDivElement
    store.setScrollTop(el.scrollTop)
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= getRowHeight() * 2
    if (atBottom) {
      store.setFollow(true)
    } else if (store.follow()) {
      store.setFollow(false)
    }
  }

  function jumpToLive() {
    store.setFollow(true)
    if (viewportRef) {
      viewportRef.scrollTop = viewportRef.scrollHeight
    }
  }

  createEffect(() => {
    store.allRows().length
    if (store.follow() && viewportRef) {
      viewportRef.scrollTop = viewportRef.scrollHeight
    }
  })

  let ro: ResizeObserver | undefined
  createEffect(() => {
    if (viewportRef) {
      ro = new ResizeObserver(() => {
        if (!viewportRef) return
        store.setViewportHeight(viewportRef.clientHeight)
        if (store.follow()) {
          viewportRef.scrollTop = viewportRef.scrollHeight
        }
      })
      ro.observe(viewportRef)
      store.setViewportHeight(viewportRef.clientHeight)
      if (store.follow()) {
        viewportRef.scrollTop = viewportRef.scrollHeight
      }
    }
  })
  onCleanup(() => {
    ro?.disconnect()
  })

  return (
    <div class="panel-content stream-panel-content">
      <div class="stream-head stream-toolbar">
        <div class="filter-group">
          <h2>Stream</h2>
          <select
            class="port-filter-select"
            value={store.portFilter()}
            onChange={(e) => store.setPortFilter(e.currentTarget.value)}
            aria-label="filter by port"
          >
            <option value="all">all ports</option>
            <For each={store.ports()}>{(p) => <option value={p.id}>{p.id}</option>}</For>
          </select>
          <div class="dir-filters">
            <button
              type="button"
              class="chip action"
              classList={{ on: store.dirFilter() === 'all' }}
              onClick={() => store.setDirFilter('all')}
            >
              all
            </button>
            <button
              type="button"
              class="chip action"
              classList={{ on: store.dirFilter() === 'rx' }}
              onClick={() => store.setDirFilter('rx')}
            >
              rx
            </button>
            <button
              type="button"
              class="chip action"
              classList={{ on: store.dirFilter() === 'tx' }}
              onClick={() => store.setDirFilter('tx')}
            >
              tx
            </button>
          </div>
          <div class="kind-filters">
            <button
              type="button"
              class="chip action"
              classList={{ on: store.kindFilter() === 'all' }}
              onClick={() => store.setKindFilter('all')}
            >
              all
            </button>
            <button
              type="button"
              class="chip action"
              classList={{ on: store.kindFilter() === 'errors' }}
              onClick={() => store.setKindFilter('errors')}
            >
              errors
            </button>
            <button
              type="button"
              class="chip action"
              classList={{ on: store.kindFilter() === 'symbols' }}
              onClick={() => store.setKindFilter('symbols')}
            >
              symbols
            </button>
          </div>
          <div class="search-wrap">
            <input
              ref={searchInputRef}
              class="search-input"
              value={store.searchQuery()}
              onInput={(e) => store.setSearchQuery(e.currentTarget.value)}
              placeholder="Filter hex, protocol, text… (/)"
              aria-label="filter stream"
            />
            <Show when={store.searchQuery()}>
              <button
                type="button"
                class="search-clear"
                onClick={() => store.setSearchQuery('')}
                title="clear search"
              >
                ✕
              </button>
            </Show>
          </div>
        </div>
        <div class="stream-actions">
          <div class="column-picker-wrapper">
            <button
              type="button"
              class="chip action column-picker-btn"
              onClick={() => setColumnMenuOpen(!columnMenuOpen())}
              title="customize visible columns"
            >
              columns ▾
            </button>
            <Show when={columnMenuOpen()}>
              <div class="column-picker-dropdown">
                <div class="picker-header">Visible Columns</div>
                <For each={allColumns()}>
                  {(col) => (
                    <label class="column-picker-item">
                      <input
                        type="checkbox"
                        checked={col.visible}
                        disabled={col.fixed}
                        onChange={() => toggleColumnVisibility(col.id)}
                      />
                      <span>{col.label}</span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <span class="hint">
            {totalRows() === 0
              ? '0 frames'
              : `rows ${startIndex() + 1}–${Math.min(endIndex(), totalRows())} of ${totalRows()} (${store.feed.received()} rx)`}
          </span>
          <button
            type="button"
            class="chip action"
            classList={{ on: store.follow() }}
            onClick={() => {
              if (!store.follow()) jumpToLive()
              else store.setFollow(false)
            }}
            title={store.follow() ? 'following live stream (click to pause)' : 'stream paused (click to follow live)'}
          >
            {store.follow() ? '● follow' : 'jump to live'}
          </button>
        </div>
      </div>

      <div class="stream-viewport" ref={viewportRef} onScroll={onViewportScroll}>
        <table>
          <colgroup>
            <For each={visibleColumns()}>
              {(col) => <col style={{ width: `${col.width}px` }} />}
            </For>
          </colgroup>
          <thead>
            <tr>
              <For each={visibleColumns()}>
                {(col) => (
                  <th title={col.description || col.label}>
                    {col.label}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <Show when={totalRows() === 0}>
              <tr>
                <td colSpan={visibleColumns().length} class="empty">
                  Waiting for frames or no match for current filter.
                </td>
              </tr>
            </Show>
            <Show when={topSpacer() > 0}>
              <tr class="spacer" style={{ height: `${topSpacer()}px` }}>
                <td
                  colSpan={visibleColumns().length}
                  style={{
                    height: `${topSpacer()}px`,
                    padding: '0',
                    border: '0',
                    margin: '0',
                    'line-height': '0',
                    'font-size': '0',
                  }}
                />
              </tr>
            </Show>
            <For each={visibleRows()}>
              {(row, idx) => {
                const isRx = () => row.direction.toLowerCase() === 'rx'
                return (
                  <tr
                    classList={{
                      chosen: store.selected() === row,
                      faulty: row.decode_error != null,
                    }}
                    onClick={() => store.setSelected(row)}
                  >
                    <For each={visibleColumns()}>
                      {(col) => {
                        if (col.id === 'index') {
                          return <td>{startIndex() + idx() + 1}</td>
                        }
                        if (col.id === 'time') {
                          return <td>{clock(row.timestamp_us)}</td>
                        }
                        if (col.id === 'delta') {
                          return <td>{row.delta_us}</td>
                        }
                        if (col.id === 'port') {
                          return <td>{row.port}</td>
                        }
                        if (col.id === 'dir') {
                          return (
                            <td>
                              <span class={`dir-badge ${isRx() ? 'rx' : 'tx'}`}>
                                {row.direction.toLowerCase()}
                              </span>
                            </td>
                          )
                        }
                        if (col.id === 'kind') {
                          return (
                            <td>
                              <span class="kind-tag">
                                {row.decode_error ? 'fault' : row.protocol ?? 'data'}
                              </span>
                            </td>
                          )
                        }
                        if (col.id === 'payload') {
                          return <td>{row.len}</td>
                        }
                        if (col.id === 'hex') {
                          return <td class="hexcell">{row.hex}</td>
                        }
                        if (col.id === 'ascii') {
                          return <td class="asciicell">{row.text || '-'}</td>
                        }
                        if (col.id === 'protocol') {
                          return (
                            <td>
                              <span class="proto-badge">
                                {row.protocol ?? (row.text ? 'text' : '-')}
                              </span>
                            </td>
                          )
                        }
                        if (col.id === 'symbol') {
                          return (
                            <td class="crash">
                              <Show when={row.symbols[0]}>
                                {(hit) => (
                                  <span
                                    class="symbol-pill"
                                    title={`${shortName(hit().function)} @ 0x${hit().address.toString(16)}`}
                                  >
                                    {hit().field}
                                    <Show when={sourceOf(hit())}> {sourceOf(hit())}</Show>
                                  </span>
                                )}
                              </Show>
                              <Show when={row.decode_error && !row.symbols[0]}>
                                <span class="error-pill" title={row.decode_error!}>
                                  {row.decode_error}
                                </span>
                              </Show>
                            </td>
                          )
                        }
                        return <td />
                      }}
                    </For>
                  </tr>
                )
              }}
            </For>
            <Show when={bottomSpacer() > 0}>
              <tr class="spacer" style={{ height: `${bottomSpacer()}px` }}>
                <td
                  colSpan={visibleColumns().length}
                  style={{
                    height: `${bottomSpacer()}px`,
                    padding: '0',
                    border: '0',
                    margin: '0',
                    'line-height': '0',
                    'font-size': '0',
                  }}
                />
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
    </div>
  )
}
