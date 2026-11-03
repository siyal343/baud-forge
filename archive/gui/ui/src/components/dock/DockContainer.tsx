import {
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { DockContext } from '../../lib/dock/context'
import {
  movePanel as treeMovePanel,
  removePanel as treeRemovePanel,
  reorderTabs as treeReorderTabs,
  setActiveTab as treeSetActiveTab,
  updateSplitRatio as treeUpdateSplitRatio,
} from '../../lib/dock/tree'
import type {
  DockContextValue,
  DockDragState,
  DockDropTarget,
  DockNode,
  DockPanelDefinition,
  DropZone,
} from '../../lib/dock/types'
import { DockSplitter } from './DockSplitter'
import { DockStack } from './DockStack'

export interface DockContainerProps {
  tree: DockNode
  renderPanel: (panelId: string) => JSX.Element
  panelDefs?: Record<string, DockPanelDefinition>
  onTreeChange?: (tree: DockNode) => void
  onClosePanel?: (panelId: string) => void
  onPopoutPanel?: (panelId: string) => void
  class?: string
  style?: JSX.CSSProperties
}

interface DockBranchProps {
  node: DockNode
  renderPanel: (panelId: string) => JSX.Element
  panelDefs?: Record<string, DockPanelDefinition>
  onResize: (splitId: string, ratio: number) => void
}

function DockBranch(props: DockBranchProps) {
  if (props.node.type === 'stack') {
    return (
      <DockStack
        node={props.node}
        renderPanel={props.renderPanel}
        panelDefs={props.panelDefs}
      />
    )
  }

  const splitNode = props.node
  const isHorizontal = () => splitNode.direction === 'horizontal'
  const firstBasis = () => `${splitNode.ratio * 100}%`
  const secondBasis = () => `${(1 - splitNode.ratio) * 100}%`

  return (
    <div
      class={`dock-split dock-split-${splitNode.direction}`}
      data-split-id={splitNode.id}
      style={{
        display: 'flex',
        'flex-direction': isHorizontal() ? 'row' : 'column',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* First Branch */}
      <div
        class="dock-branch dock-branch-first"
        style={{
          'flex-basis': firstBasis(),
          'flex-grow': 0,
          'flex-shrink': 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <DockBranch
          node={splitNode.first}
          renderPanel={props.renderPanel}
          panelDefs={props.panelDefs}
          onResize={props.onResize}
        />
      </div>

      {/* Splitter Bar */}
      <DockSplitter
        direction={splitNode.direction}
        ratio={splitNode.ratio}
        onResize={(ratio) => props.onResize(splitNode.id, ratio)}
      />

      {/* Second Branch */}
      <div
        class="dock-branch dock-branch-second"
        style={{
          'flex-basis': secondBasis(),
          'flex-grow': 1,
          'flex-shrink': 1,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <DockBranch
          node={splitNode.second}
          renderPanel={props.renderPanel}
          panelDefs={props.panelDefs}
          onResize={props.onResize}
        />
      </div>
    </div>
  )
}

export function DockContainer(props: DockContainerProps) {
  const [dragState, setDragState] = createSignal<DockDragState>(null)
  const [dropTarget, setDropTarget] = createSignal<DockDropTarget>(null)

  onMount(() => {
    const handleGlobalDragEnd = () => {
      setDragState(null)
      setDropTarget(null)
    }
    window.addEventListener('dragend', handleGlobalDragEnd)
    onCleanup(() => {
      window.removeEventListener('dragend', handleGlobalDragEnd)
    })
  })

  const handleSelectTab = (stackId: string, tabId: string) => {
    const nextTree = treeSetActiveTab(props.tree, stackId, tabId)
    props.onTreeChange?.(nextTree)
  }

  const handleClosePanel = (panelId: string) => {
    props.onClosePanel?.(panelId)
    const nextTree = treeRemovePanel(props.tree, panelId)
    if (nextTree) {
      props.onTreeChange?.(nextTree)
    }
  }

  const handlePopoutPanel = (panelId: string) => {
    props.onPopoutPanel?.(panelId)
  }

  const handleMovePanel = (
    panelId: string,
    targetStackId: string,
    zone: DropZone,
  ) => {
    const nextTree = treeMovePanel(props.tree, panelId, targetStackId, zone)
    props.onTreeChange?.(nextTree)
  }

  const handleReorderTabs = (
    stackId: string,
    fromIndex: number,
    toIndex: number,
  ) => {
    const nextTree = treeReorderTabs(props.tree, stackId, fromIndex, toIndex)
    props.onTreeChange?.(nextTree)
  }

  const handleUpdateSplitRatio = (splitId: string, ratio: number) => {
    const nextTree = treeUpdateSplitRatio(props.tree, splitId, ratio)
    props.onTreeChange?.(nextTree)
  }

  const contextValue: DockContextValue = {
    dragState,
    dropTarget,
    setDragState,
    setDropTarget,
    selectTab: handleSelectTab,
    closePanel: handleClosePanel,
    popoutPanel: handlePopoutPanel,
    movePanel: handleMovePanel,
    reorderTabs: handleReorderTabs,
    updateSplitRatio: handleUpdateSplitRatio,
    panelDefs: props.panelDefs,
  }

  return (
    <DockContext.Provider value={contextValue}>
      <div
        class={`dock-container ${props.class ?? ''}`}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          background: 'var(--bg-canvas, #090a0d)',
          ...(props.style ?? {}),
        }}
      >
        <DockBranch
          node={props.tree}
          renderPanel={props.renderPanel}
          panelDefs={props.panelDefs}
          onResize={handleUpdateSplitRatio}
        />
      </div>
    </DockContext.Provider>
  )
}
