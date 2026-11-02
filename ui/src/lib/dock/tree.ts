import type {
  DockDirection,
  DockNode,
  DockSplitNode,
  DockStackNode,
  DropZone,
} from './types'

let idCounter = 0

/**
 * Generates a unique node ID for splits and stacks.
 */
export function createNodeId(prefix: 'split' | 'stack' = 'stack'): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).substring(2, 6)}`
}

/**
 * Deep clones a DockNode tree to prevent unintentional mutations.
 */
export function cloneTree(tree: DockNode): DockNode {
  if (tree.type === 'stack') {
    return {
      type: 'stack',
      id: tree.id,
      tabs: [...tree.tabs],
      activeTab: tree.activeTab,
    }
  }
  return {
    type: 'split',
    id: tree.id,
    direction: tree.direction,
    ratio: tree.ratio,
    first: cloneTree(tree.first),
    second: cloneTree(tree.second),
  }
}

/**
 * Finds the first node matching the specified predicate in depth-first order.
 */
export function findNode(
  tree: DockNode,
  predicate: (node: DockNode) => boolean,
): DockNode | null {
  if (predicate(tree)) {
    return tree
  }
  if (tree.type === 'split') {
    const inFirst = findNode(tree.first, predicate)
    if (inFirst) return inFirst
    return findNode(tree.second, predicate)
  }
  return null
}

/**
 * Finds the parent split node of the node with targetId. Returns null if node is root or not found.
 */
export function findParent(tree: DockNode, targetId: string): DockSplitNode | null {
  if (tree.type !== 'split') {
    return null
  }
  if (tree.first.id === targetId || tree.second.id === targetId) {
    return tree
  }
  const inFirst = findParent(tree.first, targetId)
  if (inFirst) return inFirst
  return findParent(tree.second, targetId)
}

/**
 * Finds the stack node that contains the specified panelId.
 */
export function findStackContaining(
  tree: DockNode,
  panelId: string,
): DockStackNode | null {
  if (tree.type === 'stack') {
    return tree.tabs.includes(panelId) ? tree : null
  }
  return findStackContaining(tree.first, panelId) || findStackContaining(tree.second, panelId)
}

/**
 * Collects all unique panel IDs contained across all stacks in the tree.
 */
export function collectPanelIds(tree: DockNode): string[] {
  if (tree.type === 'stack') {
    return [...tree.tabs]
  }
  return [...collectPanelIds(tree.first), ...collectPanelIds(tree.second)]
}

/**
 * Adds a panel tab to the designated stack and sets it as the active tab.
 */
export function addTabToStack(
  tree: DockNode,
  stackId: string,
  panelId: string,
): DockNode {
  if (tree.type === 'stack') {
    if (tree.id === stackId) {
      const tabs = tree.tabs.includes(panelId)
        ? tree.tabs
        : [...tree.tabs, panelId]
      return {
        ...tree,
        tabs,
        activeTab: panelId,
      }
    }
    return tree
  }
  return {
    ...tree,
    first: addTabToStack(tree.first, stackId, panelId),
    second: addTabToStack(tree.second, stackId, panelId),
  }
}

/**
 * Removes a panel from the tree.
 * If the stack containing the panel becomes empty, collapses the split parent
 * to the surviving sibling node. Returns null if the root node becomes empty.
 */
export function removePanel(tree: DockNode, panelId: string): DockNode | null {
  if (tree.type === 'stack') {
    if (!tree.tabs.includes(panelId)) {
      return tree
    }
    const remainingTabs = tree.tabs.filter((t) => t !== panelId)
    if (remainingTabs.length === 0) {
      return null
    }
    let nextActive = tree.activeTab
    if (nextActive === panelId) {
      const oldIdx = tree.tabs.indexOf(panelId)
      const nextIdx = Math.min(oldIdx, remainingTabs.length - 1)
      nextActive = remainingTabs[nextIdx] ?? remainingTabs[0]
    }
    return {
      ...tree,
      tabs: remainingTabs,
      activeTab: nextActive,
    }
  }

  const newFirst = removePanel(tree.first, panelId)
  const newSecond = removePanel(tree.second, panelId)

  if (newFirst === tree.first && newSecond === tree.second) {
    return tree
  }
  if (newFirst === null && newSecond === null) {
    return null
  }
  if (newFirst === null) {
    return newSecond
  }
  if (newSecond === null) {
    return newFirst
  }

  return {
    ...tree,
    first: newFirst,
    second: newSecond,
  }
}

/**
 * Updates the active tab of the specified stack.
 */
export function setActiveTab(
  tree: DockNode,
  stackId: string,
  tabId: string,
): DockNode {
  if (tree.type === 'stack') {
    if (tree.id === stackId && tree.tabs.includes(tabId)) {
      return {
        ...tree,
        activeTab: tabId,
      }
    }
    return tree
  }
  return {
    ...tree,
    first: setActiveTab(tree.first, stackId, tabId),
    second: setActiveTab(tree.second, stackId, tabId),
  }
}

/**
 * Splits a target stack in the specified direction and adds a new stack with the panel.
 */
export function splitStack(
  tree: DockNode,
  targetStackId: string,
  newPanelId: string,
  direction: DockDirection,
  insertBefore: boolean,
): DockNode {
  if (tree.type === 'stack') {
    if (tree.id === targetStackId) {
      const newStack: DockStackNode = {
        type: 'stack',
        id: createNodeId('stack'),
        tabs: [newPanelId],
        activeTab: newPanelId,
      }
      const splitNode: DockSplitNode = {
        type: 'split',
        id: createNodeId('split'),
        direction,
        ratio: 0.5,
        first: insertBefore ? newStack : tree,
        second: insertBefore ? tree : newStack,
      }
      return splitNode
    }
    return tree
  }

  return {
    ...tree,
    first: splitStack(tree.first, targetStackId, newPanelId, direction, insertBefore),
    second: splitStack(tree.second, targetStackId, newPanelId, direction, insertBefore),
  }
}

/**
 * Updates the split ratio of a split node, clamping between 0.05 and 0.95.
 */
export function updateSplitRatio(
  tree: DockNode,
  splitId: string,
  ratio: number,
): DockNode {
  if (tree.type === 'split') {
    if (tree.id === splitId) {
      const clamped = Math.max(0.05, Math.min(0.95, Math.round(ratio * 1000) / 1000))
      return {
        ...tree,
        ratio: clamped,
      }
    }
    return {
      ...tree,
      first: updateSplitRatio(tree.first, splitId, ratio),
      second: updateSplitRatio(tree.second, splitId, ratio),
    }
  }
  return tree
}

/**
 * Moves a panel from its current location to a target stack and drop zone.
 */
export function movePanel(
  tree: DockNode,
  panelId: string,
  targetStackId: string,
  zone: DropZone,
): DockNode {
  const targetStack = findNode(
    tree,
    (node) => node.id === targetStackId && node.type === 'stack',
  ) as DockStackNode | null
  if (!targetStack) {
    return tree
  }

  const sourceStack = findStackContaining(tree, panelId)
  if (!sourceStack) {
    return tree
  }

  // Dropping into center of the same stack: activate tab only
  if (targetStackId === sourceStack.id && zone === 'center') {
    return setActiveTab(tree, targetStackId, panelId)
  }

  // Dropping on edge of same stack when it has only 1 tab: no-op
  if (targetStackId === sourceStack.id && sourceStack.tabs.length <= 1) {
    return tree
  }

  if (zone === 'center') {
    const pruned = removePanel(tree, panelId)
    if (!pruned) return tree
    return addTabToStack(pruned, targetStackId, panelId)
  }

  const direction: DockDirection =
    zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const insertBefore = zone === 'left' || zone === 'top'

  const pruned = removePanel(tree, panelId)
  if (!pruned) return tree

  const targetStillExists = findNode(pruned, (node) => node.id === targetStackId)
  if (!targetStillExists) {
    return pruned
  }

  return splitStack(pruned, targetStackId, panelId, direction, insertBefore)
}

/**
 * Reorders tabs within a specific stack.
 */
export function reorderTabs(
  tree: DockNode,
  stackId: string,
  fromIndex: number,
  toIndex: number,
): DockNode {
  if (tree.type === 'stack') {
    if (tree.id === stackId) {
      if (
        fromIndex < 0 ||
        fromIndex >= tree.tabs.length ||
        toIndex < 0 ||
        toIndex >= tree.tabs.length ||
        fromIndex === toIndex
      ) {
        return tree
      }
      const nextTabs = [...tree.tabs]
      const [moved] = nextTabs.splice(fromIndex, 1)
      nextTabs.splice(toIndex, 0, moved)
      return {
        ...tree,
        tabs: nextTabs,
      }
    }
    return tree
  }

  return {
    ...tree,
    first: reorderTabs(tree.first, stackId, fromIndex, toIndex),
    second: reorderTabs(tree.second, stackId, fromIndex, toIndex),
  }
}
