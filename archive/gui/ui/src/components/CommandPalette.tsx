import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'

export interface CommandAction {
  id: string
  label: string
  category: string
  shortcut?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  actions: CommandAction[]
}

/** Zero-latency (0ms animation per /emil-design-eng) Command Palette triggered by Ctrl+K. */
export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const filteredActions = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return props.actions
    return props.actions.filter(
      (action) =>
        action.label.toLowerCase().includes(q) ||
        action.category.toLowerCase().includes(q) ||
        (action.shortcut && action.shortcut.toLowerCase().includes(q)),
    )
  })

  // Reset selected index when query changes
  createEffect(() => {
    query()
    setSelectedIndex(0)
  })

  // Immediate focus on open with 0ms delay
  createEffect(() => {
    if (props.open) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => {
        inputRef?.focus()
        inputRef?.select()
      })
    }
  })

  // Scroll active item into view
  createEffect(() => {
    const idx = selectedIndex()
    if (idx >= 0 && listRef) {
      const itemEl = listRef.children[idx] as HTMLElement | undefined
      itemEl?.scrollIntoView({ block: 'nearest' })
    }
  })

  // Window-level escape and Ctrl+K close guard
  createEffect(() => {
    if (!props.open) return
    const onGlobalKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onGlobalKey)
    onCleanup(() => window.removeEventListener('keydown', onGlobalKey))
  })

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
      return
    }

    const items = filteredActions()
    if (items.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const action = items[selectedIndex()]
      if (action) {
        props.onClose()
        action.run()
      }
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      props.onClose()
    }
  }

  function runAction(action: CommandAction) {
    props.onClose()
    action.run()
  }

  return (
    <Show when={props.open}>
      <div class="cmd-palette-backdrop" onClick={handleBackdropClick}>
        <style>{`
          .cmd-palette-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.65);
            backdrop-filter: blur(2px);
            z-index: 9999;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding-top: 14vh;
          }
          .cmd-palette-dialog {
            width: 100%;
            max-width: 580px;
            background: var(--bg-surface-1, var(--panel, #111621));
            border: 1px solid var(--border-strong, var(--line, #2d3446));
            border-radius: 8px;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--border-highlight, rgba(255, 255, 255, 0.06));
            overflow: hidden;
            display: flex;
            flex-direction: column;
            font-family: var(--font-sans, inherit);
          }
          .cmd-input-wrapper {
            display: flex;
            align-items: center;
            padding: 10px 14px;
            border-bottom: 1px solid var(--border-hairline, var(--line, #1e2638));
            gap: 10px;
            background: var(--bg-surface-2, var(--panel-2, #161920));
          }
          .cmd-search-icon {
            color: var(--text-muted, var(--dim, #7c879c));
            flex-shrink: 0;
          }
          .cmd-input {
            flex: 1;
            background: transparent;
            border: 0;
            outline: none;
            color: var(--text-primary, var(--text, #edf0f7));
            font-size: 13.5px;
            font-family: inherit;
          }
          .cmd-input::placeholder {
            color: var(--text-muted, var(--dim, #7c879c));
          }
          .cmd-esc-badge {
            font-family: var(--font-mono, monospace);
            font-size: 10px;
            padding: 2px 5px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-hairline, var(--line, #1e2638));
            color: var(--text-muted, var(--dim, #7c879c));
            cursor: pointer;
            user-select: none;
          }
          .cmd-list {
            max-height: 320px;
            overflow-y: auto;
            padding: 6px;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .cmd-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 7px 10px;
            border-radius: 6px;
            cursor: pointer;
            color: var(--text-secondary, var(--dim, #949eb2));
            font-size: 12.5px;
            user-select: none;
          }
          .cmd-item.selected {
            background: var(--bg-surface-3, var(--panel-2, #1e222b));
            color: var(--text-primary, var(--text, #edf0f7));
          }
          .cmd-item-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
          }
          .cmd-item-category {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            padding: 1px 5px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.06);
            color: var(--text-muted, var(--dim, #7c879c));
            font-family: var(--font-mono, monospace);
            font-weight: 600;
            flex-shrink: 0;
          }
          .cmd-item.selected .cmd-item-category {
            color: var(--sig-tx, var(--tx, #06b6d4));
            background: var(--sig-tx-dim, rgba(6, 182, 212, 0.14));
          }
          .cmd-item-label {
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .cmd-item-shortcut {
            font-family: var(--font-mono, monospace);
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--border-hairline, var(--line, #1e2638));
            color: var(--text-muted, var(--dim, #7c879c));
            flex-shrink: 0;
          }
          .cmd-empty {
            padding: 24px 16px;
            text-align: center;
            color: var(--text-muted, var(--dim, #7c879c));
            font-size: 12.5px;
          }
          .cmd-footer {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 14px;
            padding: 7px 14px;
            background: var(--bg-surface-2, var(--panel-2, #161920));
            border-top: 1px solid var(--border-hairline, var(--line, #1e2638));
            font-size: 11px;
            color: var(--text-muted, var(--dim, #7c879c));
          }
          .cmd-hint {
            display: flex;
            align-items: center;
            gap: 4px;
          }
          .cmd-hint kbd {
            font-family: var(--font-mono, monospace);
            padding: 1px 4px;
            border-radius: 3px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--border-hairline, var(--line, #1e2638));
            color: var(--text-secondary, var(--dim, #949eb2));
          }
        `}</style>
        <div
          class="cmd-palette-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Command Palette"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="cmd-input-wrapper">
            <svg
              class="cmd-search-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z"
              />
            </svg>
            <input
              ref={inputRef}
              type="text"
              class="cmd-input"
              placeholder="Type a command or search actions..."
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            <kbd class="cmd-esc-badge" onClick={props.onClose} title="Close (Esc)">
              ESC
            </kbd>
          </div>

          <div class="cmd-list" role="listbox" ref={listRef}>
            <Show
              when={filteredActions().length > 0}
              fallback={
                <div class="cmd-empty">
                  No commands matching "<strong>{query()}</strong>"
                </div>
              }
            >
              <For each={filteredActions()}>
                {(action, idx) => {
                  const isSelected = () => idx() === selectedIndex()
                  return (
                    <div
                      class="cmd-item"
                      classList={{ selected: isSelected() }}
                      role="option"
                      aria-selected={isSelected()}
                      onClick={() => runAction(action)}
                      onMouseEnter={() => setSelectedIndex(idx())}
                    >
                      <div class="cmd-item-left">
                        <span class="cmd-item-category">{action.category}</span>
                        <span class="cmd-item-label">{action.label}</span>
                      </div>
                      <Show when={action.shortcut}>
                        <kbd class="cmd-item-shortcut">{action.shortcut}</kbd>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>

          <div class="cmd-footer">
            <span class="cmd-hint">
              <kbd>↑</kbd> <kbd>↓</kbd> navigate
            </span>
            <span class="cmd-hint">
              <kbd>↵</kbd> run
            </span>
            <span class="cmd-hint">
              <kbd>esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default CommandPalette
