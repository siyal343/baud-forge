export type DockDirection = 'horizontal' | 'vertical'

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface DockSplitNode {
  type: 'split'
  id: string
  direction: DockDirection
  ratio: number
  first: DockNode
  second: DockNode
}

export interface DockStackNode {
  type: 'stack'
  id: string
  tabs: string[]
  activeTab: string
}

export type DockNode = DockSplitNode | DockStackNode

export interface DockPanelDefinition {
  id: string
  title: string
  icon?: string
  closeable?: boolean
  allowPopout?: boolean
}

export type DockDragState = {
  draggingPanelId: string
  sourceStackId: string
} | null

export type DockDropTarget = {
  stackId: string
  zone: DropZone
} | null

export interface DockContextValue {
  dragState: () => DockDragState
  dropTarget: () => DockDropTarget
  setDragState: (state: DockDragState) => void
  setDropTarget: (target: DockDropTarget) => void
  selectTab: (stackId: string, tabId: string) => void
  closePanel: (panelId: string) => void
  popoutPanel: (panelId: string) => void
  movePanel: (panelId: string, targetStackId: string, zone: DropZone) => void
  reorderTabs: (stackId: string, fromIndex: number, toIndex: number) => void
  updateSplitRatio: (splitId: string, ratio: number) => void
  panelDefs?: Record<string, DockPanelDefinition>
}
