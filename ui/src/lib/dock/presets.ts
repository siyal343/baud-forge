import { createNodeId } from './tree'
import type { DockNode, DockPanelDefinition } from './types'

export const BUILTIN_PANELS: Record<string, DockPanelDefinition> = {
  hardware: {
    id: 'hardware',
    title: 'Hardware Bay',
    icon: 'cpu',
    closeable: true,
    allowPopout: true,
  },
  stream: {
    id: 'stream',
    title: 'Stream',
    icon: 'activity',
    closeable: false,
    allowPopout: true,
  },
  inspector: {
    id: 'inspector',
    title: 'Inspector',
    icon: 'search',
    closeable: true,
    allowPopout: true,
  },
  telemetry: {
    id: 'telemetry',
    title: 'Telemetry',
    icon: 'bar-chart-2',
    closeable: true,
    allowPopout: true,
  },
  console: {
    id: 'console',
    title: 'Console',
    icon: 'terminal',
    closeable: true,
    allowPopout: true,
  },
  dashboard: {
    id: 'dashboard',
    title: 'Dashboard',
    icon: 'grid',
    closeable: true,
    allowPopout: true,
  },
  diff: {
    id: 'diff',
    title: 'Session Diff',
    icon: 'git-commit',
    closeable: true,
    allowPopout: true,
  },
}

/**
 * Creates the Bring-up preset:
 * Left hardware bay (0.28), Center stream (0.72) with bottom console (0.35).
 */
export function createBringUpPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'horizontal',
    ratio: 0.28,
    first: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['hardware'],
      activeTab: 'hardware',
    },
    second: {
      type: 'split',
      id: createNodeId('split'),
      direction: 'vertical',
      ratio: 0.65,
      first: {
        type: 'stack',
        id: createNodeId('stack'),
        tabs: ['stream'],
        activeTab: 'stream',
      },
      second: {
        type: 'stack',
        id: createNodeId('stack'),
        tabs: ['console'],
        activeTab: 'console',
      },
    },
  }
}

/**
 * Creates the Protocol Debug preset:
 * Left stream (0.45), Right inspector (0.55), bottom console (0.35).
 */
export function createProtocolDebugPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'vertical',
    ratio: 0.65,
    first: {
      type: 'split',
      id: createNodeId('split'),
      direction: 'horizontal',
      ratio: 0.45,
      first: {
        type: 'stack',
        id: createNodeId('stack'),
        tabs: ['stream'],
        activeTab: 'stream',
      },
      second: {
        type: 'stack',
        id: createNodeId('stack'),
        tabs: ['inspector'],
        activeTab: 'inspector',
      },
    },
    second: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['console'],
      activeTab: 'console',
    },
  }
}

/**
 * Creates the Telemetry & Oscilloscope preset:
 * Top stream (0.4), Bottom telemetry & dashboard stack (0.6).
 */
export function createTelemetryPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'vertical',
    ratio: 0.4,
    first: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['stream'],
      activeTab: 'stream',
    },
    second: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['telemetry', 'console'],
      activeTab: 'telemetry',
    },
  }
}

/**
 * Creates the Minimal Stream preset:
 * Full window stream with collapsible tabs.
 */
export function createMinimalStreamPreset(): DockNode {
  return {
    type: 'stack',
    id: createNodeId('stack'),
    tabs: ['stream', 'inspector', 'telemetry', 'console', 'hardware'],
    activeTab: 'stream',
  }
}

export type BuiltinPresetName =
  | 'Bring-up'
  | 'Protocol Debug'
  | 'Telemetry & Oscilloscope'
  | 'Minimal Stream'

export const DOCK_PRESETS: Record<BuiltinPresetName, () => DockNode> = {
  'Bring-up': createBringUpPreset,
  'Protocol Debug': createProtocolDebugPreset,
  'Telemetry & Oscilloscope': createTelemetryPreset,
  'Minimal Stream': createMinimalStreamPreset,
}

/**
 * Returns a new layout tree for the given preset name.
 * Falls back to 'Bring-up' if presetName is unrecognized.
 */
export function getDefaultLayout(presetName: string): DockNode {
  const factory = DOCK_PRESETS[presetName as BuiltinPresetName]
  if (factory) {
    return factory()
  }
  return createBringUpPreset()
}
