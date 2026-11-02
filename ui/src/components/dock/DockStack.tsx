import { For, Show, createSignal, type JSX } from 'solid-js'
import { useDock } from '../../lib/dock/context'
import { BUILTIN_PANELS } from '../../lib/dock/presets'
import type { DockPanelDefinition, DockStackNode, DropZone } from '../../lib/dock/types'
import { DropOverlay } from './DropOverlay'

export interface DockStackProps {
  node: DockStackNode
  renderPanel: (panelId: string) => JSX.Element
  panelDefs?: Record<string, DockPanelDefinition>
}

export function DockStack(props: DockStackProps) {
  const dock = useDock()
  const [currentDropZone, setCurrentDropZone] = createSignal<DropZone | null>(null)
  const [dragOverTabIndex, setDragOverTabIndex] = createSignal<number | null>(null)

  const getDef = (panelId: string): DockPanelDefinition => {
    return (
      props.panelDefs?.[panelId] ??
      dock.panelDefs?.[panelId] ??
      BUILTIN_PANELS[panelId] ?? {
        id: panelId,
        title: panelId.charAt(0).toUpperCase() + panelId.slice(1),
        closeable: true,
        allowPopout: true,
      }
    )
  }

  const renderIcon = (icon?: string) => {
    switch (icon) {
      case 'cpu':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
          </svg>
        )
      case 'activity':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        )
      case 'search':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        )
      case 'bar-chart-2':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        )
      case 'terminal':
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        )
      default:
        return null
    }
  }

  const handleTabDragStart = (e: DragEvent, tabId: string) => {
    dock.setDragState({
      draggingPanelId: tabId,
      sourceStackId: props.node.id,
    })
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', tabId)
    }
  }

  const handleTabDragEnd = () => {
    dock.setDragState(null)
    setDragOverTabIndex(null)
  }

  const handleTabDragOver = (e: DragEvent, index: number) => {
    const drag = dock.dragState()
    if (drag && drag.sourceStackId === props.node.id) {
      e.preventDefault()
      e.stopPropagation()
      setDragOverTabIndex(index)
    }
  }

  const handleTabDrop = (e: DragEvent, targetIndex: number) => {
    const drag = dock.dragState()
    if (drag && drag.sourceStackId === props.node.id) {
      e.preventDefault()
      e.stopPropagation()
      const fromIndex = props.node.tabs.indexOf(drag.draggingPanelId)
      if (fromIndex !== -1 && fromIndex !== targetIndex) {
        dock.reorderTabs(props.node.id, fromIndex, targetIndex)
      }
      dock.setDragState(null)
      setDragOverTabIndex(null)
    }
  }

  const handleOverlayDrop = (zone: DropZone) => {
    const drag = dock.dragState()
    if (!drag) return
    dock.movePanel(drag.draggingPanelId, props.node.id, zone)
    dock.setDragState(null)
    setCurrentDropZone(null)
  }

  const isDraggingAnyPanel = () => dock.dragState() !== null

  return (
    <div
      class="dock-stack"
      data-stack-id={props.node.id}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--bg-canvas, #090a0d)',
      }}
    >
      {/* Stack Tab Bar */}
      <div
        class="dock-tabbar"
        style={{
          display: 'flex',
          'align-items': 'center',
          height: '28px',
          'min-height': '28px',
          background: 'var(--bg-surface-1, #101217)',
          'border-bottom': '1px solid var(--border-hairline, #1f2430)',
          'padding-left': '4px',
          'padding-right': '4px',
          gap: '2px',
          overflow: 'hidden',
          'user-select': 'none',
        }}
      >
        <div
          class="dock-tab-list"
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '2px',
            flex: '1',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <For each={props.node.tabs}>
            {(tabId, index) => {
              const def = getDef(tabId)
              const isActive = () => props.node.activeTab === tabId
              const isOver = () => dragOverTabIndex() === index()

              return (
                <div
                  class={`dock-tab ${isActive() ? 'is-active' : ''} ${isOver() ? 'is-drag-target' : ''}`}
                  draggable={true}
                  onDragStart={(e) => handleTabDragStart(e, tabId)}
                  onDragEnd={handleTabDragEnd}
                  onDragOver={(e) => handleTabDragOver(e, index())}
                  onDrop={(e) => handleTabDrop(e, index())}
                  onClick={() => dock.selectTab(props.node.id, tabId)}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '6px',
                    height: '24px',
                    padding: '0 8px',
                    'font-size': '11px',
                    'font-weight': isActive() ? '500' : '400',
                    color: isActive()
                      ? 'var(--text-primary, #edf0f7)'
                      : 'var(--text-secondary, #949eb2)',
                    background: isActive()
                      ? 'var(--bg-surface-2, #161920)'
                      : 'transparent',
                    border: '1px solid',
                    'border-color': isActive()
                      ? 'var(--border-strong, #2d3446)'
                      : isOver()
                        ? 'var(--sig-tx, #06b6d4)'
                        : 'transparent',
                    'border-bottom': isActive()
                      ? '1px solid var(--bg-surface-2, #161920)'
                      : '1px solid transparent',
                    'border-radius': '4px 4px 0 0',
                    cursor: 'pointer',
                    transition: 'all 100ms ease',
                    'white-space': 'nowrap',
                    position: 'relative',
                  }}
                >
                  {/* Tab Icon */}
                  <Show when={def.icon}>
                    <span
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        color: isActive()
                          ? 'var(--sig-tx, #06b6d4)'
                          : 'var(--text-muted, #5e677a)',
                      }}
                    >
                      {renderIcon(def.icon)}
                    </span>
                  </Show>

                  {/* Tab Title */}
                  <span style={{ 'margin-right': '2px' }}>{def.title}</span>

                  {/* Popout Button */}
                  <Show when={def.allowPopout !== false}>
                    <button
                      type="button"
                      class="dock-tab-btn"
                      title="Pop out panel"
                      onClick={(e) => {
                        e.stopPropagation()
                        dock.popoutPanel(tabId)
                      }}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        width: '16px',
                        height: '16px',
                        padding: '0',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted, #5e677a)',
                        cursor: 'pointer',
                        'border-radius': '2px',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--text-primary)'
                        e.currentTarget.style.background = 'var(--bg-surface-3)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--text-muted)'
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </button>
                  </Show>

                  {/* Close Tab Button */}
                  <Show when={def.closeable !== false}>
                    <button
                      type="button"
                      class="dock-tab-btn"
                      title="Close panel"
                      onClick={(e) => {
                        e.stopPropagation()
                        dock.closePanel(tabId)
                      }}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        width: '16px',
                        height: '16px',
                        padding: '0',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted, #5e677a)',
                        cursor: 'pointer',
                        'border-radius': '2px',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--sig-fault, #f43f5e)'
                        e.currentTarget.style.background = 'var(--sig-fault-dim, rgba(244, 63, 94, 0.14))'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = 'var(--text-muted)'
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      {/* Content Container */}
      <div
        class="dock-content-container"
        style={{
          flex: '1',
          width: '100%',
          height: 'calc(100% - 28px)',
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--bg-canvas, #090a0d)',
        }}
      >
        <Show when={props.node.activeTab}>
          {(activeId) => props.renderPanel(activeId())}
        </Show>

        {/* Drop Target Overlay */}
        <DropOverlay
          stackId={props.node.id}
          active={isDraggingAnyPanel()}
          currentZone={currentDropZone()}
          onZoneChange={setCurrentDropZone}
          onDrop={handleOverlayDrop}
        />
      </div>
    </div>
  )
}
