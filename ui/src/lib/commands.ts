import { createSignal } from 'solid-js'
import {
  DEFAULT_KEYBINDINGS,
  loadSettings,
  saveSettings,
} from './settings'

export interface CommandDef {
  id: string
  label: string
  category: 'General' | 'Navigation' | 'Stream' | 'DVR' | 'Panels' | 'Presets'
  defaultKey: string
  description?: string
}

export const COMMAND_DEFINITIONS: CommandDef[] = [
  {
    id: 'workspace.new',
    label: 'Create New Workspace',
    category: 'General',
    defaultKey: 'Ctrl+N',
    description: 'Open visual New Workspace Wizard',
  },
  {
    id: 'palette.open',
    label: 'Open Command Palette',
    category: 'Navigation',
    defaultKey: 'Ctrl+K',
    description: 'Quick action switcher and search bar',
  },
  {
    id: 'workspace.save',
    label: 'Save Workspace Configuration',
    category: 'General',
    defaultKey: 'Ctrl+S',
    description: 'Save current session as .bforge.toml',
  },
  {
    id: 'filter.focus',
    label: 'Focus Stream Search Filter',
    category: 'Stream',
    defaultKey: '/',
    description: 'Focus stream filter text input',
  },
  {
    id: 'dvr.toggle_play',
    label: 'Toggle DVR Play / Pause',
    category: 'DVR',
    defaultKey: 'Space',
    description: 'Pause live capture or resume playback',
  },
  {
    id: 'dvr.step_back',
    label: 'DVR Step Backward',
    category: 'DVR',
    defaultKey: 'ArrowLeft',
    description: 'Step back one frame in timeline buffer',
  },
  {
    id: 'dvr.step_forward',
    label: 'DVR Step Forward',
    category: 'DVR',
    defaultKey: 'ArrowRight',
    description: 'Step forward one frame in timeline buffer',
  },
  {
    id: 'dvr.snap_live',
    label: 'Snap to Live Edge',
    category: 'DVR',
    defaultKey: 'End',
    description: 'Return to live stream head',
  },
  {
    id: 'settings.open',
    label: 'Open Workbench Settings',
    category: 'General',
    defaultKey: 'Ctrl+,',
    description: 'Configure appearance, columns, and shortcuts',
  },
  {
    id: 'diff.toggle',
    label: 'Toggle Session Diff Pane',
    category: 'Panels',
    defaultKey: 'Ctrl+Shift+D',
    description: 'Show or hide session diff comparative tool',
  },
  {
    id: 'preset.bringup',
    label: 'Load Bringup Preset',
    category: 'Presets',
    defaultKey: 'Alt+1',
    description: 'Default hardware bringup layout',
  },
  {
    id: 'preset.debug',
    label: 'Load Protocol Debug Preset',
    category: 'Presets',
    defaultKey: 'Alt+2',
    description: 'Expanded stream and hex analysis layout',
  },
  {
    id: 'preset.telemetry',
    label: 'Load Telemetry Preset',
    category: 'Presets',
    defaultKey: 'Alt+3',
    description: 'Maximized oscilloscope and signal plots layout',
  },
  {
    id: 'preset.hardware',
    label: 'Load Hardware Logic Preset',
    category: 'Presets',
    defaultKey: 'Alt+4',
    description: 'Dedicated GPIO, fault injection, and bus pin control',
  },
  {
    id: 'stream.jump_live',
    label: 'Jump to Live Stream',
    category: 'Stream',
    defaultKey: 'L',
    description: 'Scroll directly to live stream edge',
  },
  {
    id: 'stream.toggle_follow',
    label: 'Toggle Auto-Follow',
    category: 'Stream',
    defaultKey: 'F',
    description: 'Lock or unlock scroll follow at live edge',
  },
]

export function getKeybindingsMap(): Record<string, string> {
  const settings = loadSettings()
  return {
    ...DEFAULT_KEYBINDINGS,
    ...(settings.keybindings || {}),
  }
}

const [keybindingsSignal, setKeybindingsSignal] = createSignal<Record<string, string>>(
  getKeybindingsMap(),
)

export const currentKeybindings = keybindingsSignal

export function getKeybinding(commandId: string): string {
  const current = keybindingsSignal()
  if (current[commandId]) {
    return current[commandId]
  }
  const def = COMMAND_DEFINITIONS.find((c) => c.id === commandId)
  return def ? def.defaultKey : ''
}

export function setKeybinding(commandId: string, combo: string): void {
  const settings = loadSettings()
  settings.keybindings = settings.keybindings || {}
  settings.keybindings[commandId] = combo
  saveSettings(settings)
  setKeybindingsSignal(getKeybindingsMap())
}

export function resetKeybindings(): void {
  const settings = loadSettings()
  settings.keybindings = { ...DEFAULT_KEYBINDINGS }
  saveSettings(settings)
  setKeybindingsSignal(getKeybindingsMap())
}

type CommandHandler = () => void
const commandHandlers = new Map<string, Set<CommandHandler>>()

/**
 * Registers an execution handler for a specific command.
 * Returns an unregister function.
 */
export function registerCommandHandler(commandId: string, handler: CommandHandler): () => void {
  if (!commandHandlers.has(commandId)) {
    commandHandlers.set(commandId, new Set())
  }
  commandHandlers.get(commandId)!.add(handler)

  return () => {
    const set = commandHandlers.get(commandId)
    if (set) {
      set.delete(handler)
      if (set.size === 0) {
        commandHandlers.delete(commandId)
      }
    }
  }
}

/**
 * Dispatches a command directly by ID.
 */
export function executeCommand(commandId: string): boolean {
  const set = commandHandlers.get(commandId)
  if (set && set.size > 0) {
    for (const fn of set) {
      try {
        fn()
      } catch (err) {
        console.error(`[commands] Error executing handler for ${commandId}:`, err)
      }
    }
    return true
  }
  return false
}

/**
 * Formats a KeyboardEvent into a canonical string key combination.
 */
export function eventToKeyCombo(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    return null
  }

  const parts: string[] = []

  if (e.ctrlKey || e.metaKey) {
    parts.push('Ctrl')
  }

  if (e.altKey) {
    parts.push('Alt')
  }

  if (e.shiftKey) {
    parts.push('Shift')
  }

  let key = e.key
  if (e.code === 'Space' || key === ' ') {
    key = 'Space'
  } else if (key === 'Escape') {
    key = 'Escape'
  } else if (key.length === 1) {
    key = key.toUpperCase()
  }

  parts.push(key)
  return parts.join('+')
}

function isTypingInInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false

  const tagName = target.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true
  }

  if (target.isContentEditable) {
    return true
  }

  return false
}

/**
 * Initializes the centralized keyboard router with global listener.
 */
export function initCommandRouter(): () => void {
  if (typeof window === 'undefined') return () => {}

  const onKeyDown = (e: KeyboardEvent) => {
    // Check if user is typing in form control
    const isTyping = isTypingInInput(e.target)
    const hasCtrl = e.ctrlKey || e.metaKey

    // In input fields: only allow Esc or Ctrl+* combos
    if (isTyping && e.key !== 'Escape' && !hasCtrl) {
      return
    }

    const combo = eventToKeyCombo(e)
    if (!combo) return

    const bindings = keybindingsSignal()
    for (const [cmdId, boundCombo] of Object.entries(bindings)) {
      if (boundCombo.toLowerCase() === combo.toLowerCase()) {
        const set = commandHandlers.get(cmdId)
        if (set && set.size > 0) {
          e.preventDefault()
          executeCommand(cmdId)
          return
        }
      }
    }
  }

  window.addEventListener('keydown', onKeyDown)

  const onSettingsChanged = () => {
    setKeybindingsSignal(getKeybindingsMap())
  }
  window.addEventListener('baudforge:settings-changed', onSettingsChanged)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('baudforge:settings-changed', onSettingsChanged)
  }
}
