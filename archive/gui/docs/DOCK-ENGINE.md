# BaudForge Dock Engine Architecture

## 1. Overview
The BaudForge Dock Engine is an in-house, zero-dependency layout engine built for high-performance serial stream analysis and hardware instrumentation. It provides recursive binary split trees and multi-tab stack containers with drag-and-drop panel repositioning, tab reordering, and splitter resizing.

## 2. Directory Structure
```
ui/
├── src/
│   ├── lib/
│   │   └── dock/
│   │       ├── types.ts       # Structural definitions, unions, and context interface
│   │       ├── tree.ts        # Pure functional tree operations and immutable transforms
│   │       ├── presets.ts     # Workspace presets and layout factories
│   │       ├── context.ts     # SolidJS context provider and consumption hook
│   │       └── index.ts       # Module barrel export
│   └── components/
│       └── dock/
│           ├── DockContainer.tsx # Top-level recursive dock renderer
│           ├── DockSplitter.tsx  # Interactive resizing divider with pointer capture
│           ├── DockStack.tsx     # Tab bar, tab reorder, popout, and panel container
│           ├── DropOverlay.tsx   # 5-zone drop target indicator with phosphor highlights
│           └── index.ts          # Components barrel export
```

## 3. Data Structures (`types.ts`)
- `DockDirection`: `'horizontal' | 'vertical'`
- `DropZone`: `'left' | 'right' | 'top' | 'bottom' | 'center'`
- `DockSplitNode`: `{ type: 'split', id: string, direction: DockDirection, ratio: number, first: DockNode, second: DockNode }`
- `DockStackNode`: `{ type: 'stack', id: string, tabs: string[], activeTab: string }`
- `DockNode`: `DockSplitNode | DockStackNode`
- `DockPanelDefinition`: `{ id: string, title: string, icon?: string, closeable?: boolean, allowPopout?: boolean }`
- `DockDragState`: `{ draggingPanelId: string, sourceStackId: string } | null`
- `DockDropTarget`: `{ stackId: string, zone: DropZone } | null`

## 4. Pure Functional Tree Engine (`tree.ts`)
All tree transformations are pure, returning immutable clones:
- `findNode(tree, predicate)`: Locates nodes in depth-first order.
- `findParent(tree, targetId)`: Identifies the enclosing `DockSplitNode`.
- `findStackContaining(tree, panelId)`: Returns the stack containing a panel.
- `collectPanelIds(tree)`: Recursively aggregates panel IDs in tree order.
- `addTabToStack(tree, stackId, panelId)`: Appends tab and sets it active.
- `removePanel(tree, panelId)`: Prunes panel from stack; when a stack empties, automatically collapses the split parent to the surviving sibling.
- `setActiveTab(tree, stackId, tabId)`: Sets active tab in target stack.
- `splitStack(tree, targetStackId, newPanelId, direction, insertBefore)`: Replaces a stack with a binary split and new stack sibling.
- `updateSplitRatio(tree, splitId, ratio)`: Updates ratio clamped to [0.05, 0.95].
- `movePanel(tree, panelId, targetStackId, zone)`: Moves panel into tab stack ('center') or splits stack ('left' | 'right' | 'top' | 'bottom').
- `reorderTabs(tree, stackId, fromIndex, toIndex)`: Shifts tab positions within stack.

## 5. Built-in Presets (`presets.ts`)
- `Bring-up`: Hardware Bay left (0.28), Center Stream (0.65) with Workbench Console below (0.35).
- `Protocol Debug`: Top split into Stream (0.45) and Inspector (0.55), Workbench Console below (0.35).
- `Telemetry & Oscilloscope`: Top Stream (0.4), Bottom Telemetry & Oscilloscope stack (0.6).
- `Minimal Stream`: Single tabbed stream view maximizing canvas area.

## 6. Components
- `DockContainer`: Top-level recursive dispatcher providing `DockContext`.
- `DockSplitter`: Uses Pointer Capture API on pointerdown with smooth clamping between 0.1 and 0.9.
- `DockStack`: Tab items with active phosphor highlight, SVG icons, close buttons, popout handlers, and HTML5 drag handles.
- `DropOverlay`: Dynamic 5-zone drop overlay with translucent phosphor box and crosshairs.

## 7. Metrics
- External dependencies added: 0 (pure SolidJS only).
- Verified test suite: 13/13 assertions passing.
