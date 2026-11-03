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

/**
 * Creates the Dashboards preset:
 * Top stream (0.35), Bottom dashboard (0.65).
 */
export function createDashboardPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'vertical',
    ratio: 0.35,
    first: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['stream'],
      activeTab: 'stream',
    },
    second: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['dashboard', 'console'],
      activeTab: 'dashboard',
    },
  }
}

/**
 * Creates the Session Diff preset:
 * Top stream (0.35), Bottom diff (0.65).
 */
export function createSessionDiffPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'vertical',
    ratio: 0.35,
    first: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['stream'],
      activeTab: 'stream',
    },
    second: {
      type: 'stack',
      id: createNodeId('stack'),
      tabs: ['diff'],
      activeTab: 'diff',
    },
  }
}

/**
 * Creates the HIL & Fault Rig preset:
 * Left hardware bay with fault controls (0.32), Right stream (0.65) with bottom console (0.35).
 */
export function createHilFaultRigPreset(): DockNode {
  return {
    type: 'split',
    id: createNodeId('split'),
    direction: 'horizontal',
    ratio: 0.32,
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

export type BuiltinPresetName =
  | 'Bring-up'
  | 'Protocol Debug'
  | 'Telemetry & Oscilloscope'
  | 'Dashboards'
  | 'HIL & Fault Rig'
  | 'Session Diff'
  | 'Minimal Stream'

export const DOCK_PRESETS: Record<BuiltinPresetName, () => DockNode> = {
  'Bring-up': createBringUpPreset,
  'Protocol Debug': createProtocolDebugPreset,
  'Telemetry & Oscilloscope': createTelemetryPreset,
  'Dashboards': createDashboardPreset,
  'HIL & Fault Rig': createHilFaultRigPreset,
  'Session Diff': createSessionDiffPreset,
  'Minimal Stream': createMinimalStreamPreset,
}

export function normalizePresetName(name: string): BuiltinPresetName {
  const clean = (name || '').trim().toLowerCase()
  if (clean === 'protocol' || clean.includes('protocol') || clean.includes('dissect')) {
    return 'Protocol Debug'
  }
  if (clean === 'telemetry' || clean.includes('telemetry') || clean.includes('scope') || clean.includes('oscilloscope')) {
    return 'Telemetry & Oscilloscope'
  }
  if (clean === 'dashboards' || clean === 'dashboard' || clean.includes('dashboard')) {
    return 'Dashboards'
  }
  if (clean.includes('hil') || clean.includes('fault') || clean.includes('rig')) {
    return 'HIL & Fault Rig'
  }
  if (clean === 'diff' || clean.includes('diff') || clean.includes('regression') || clean.includes('golden')) {
    return 'Session Diff'
  }
  if (clean === 'bring-up' || clean === 'bringup' || clean.includes('bring-up') || clean.includes('bringup') || clean.includes('bridge')) {
    return 'Bring-up'
  }
  if (clean === 'minimal' || clean.includes('minimal')) {
    return 'Minimal Stream'
  }
  if (name in DOCK_PRESETS) {
    return name as BuiltinPresetName
  }
  return 'Bring-up'
}

/**
 * Returns a new layout tree for the given preset name.
 * Falls back to 'Bring-up' if presetName is unrecognized.
 */
export function getDefaultLayout(presetName: string): DockNode {
  const resolved = normalizePresetName(presetName)
  const factory = DOCK_PRESETS[resolved]
  if (factory) {
    return factory()
  }
  return createBringUpPreset()
}
