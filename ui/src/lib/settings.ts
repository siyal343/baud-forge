export type AppTheme = 'carbon-dark' | 'paper-light' | 'high-contrast'
export type AppDensity = 'compact' | 'default' | 'spacious'
export type AppAccent = 'cyan' | 'green' | 'amber' | 'purple'

export interface ColumnSetting {
  id: string
  label: string
  width: number
  minWidth?: number
  visible: boolean
  fixed?: boolean
}

export interface AppSettings {
  theme: AppTheme
  density: AppDensity
  accent: AppAccent
  fontSize: number // 11..16, default 12
  activePreset: string
  customPresets: Record<string, any>
  columns: ColumnSetting[]
  keybindings: Record<string, string> // commandId -> key combo
}

export const DEFAULT_COLUMNS: ColumnSetting[] = [
  { id: 'index', label: '#', width: 56, minWidth: 40, visible: true, fixed: true },
  { id: 'time', label: 'Timestamp', width: 96, minWidth: 70, visible: true },
  { id: 'port', label: 'Port', width: 72, minWidth: 50, visible: true },
  { id: 'dir', label: 'Direction', width: 52, minWidth: 40, visible: true },
  { id: 'kind', label: 'Kind', width: 64, minWidth: 50, visible: true },
  { id: 'delta', label: 'Δ Time', width: 72, minWidth: 60, visible: false },
  { id: 'payload', label: 'Length', width: 56, minWidth: 45, visible: true },
  { id: 'hex', label: 'Hex Dump', width: 240, minWidth: 120, visible: true },
  { id: 'ascii', label: 'ASCII Text', width: 160, minWidth: 80, visible: true },
  { id: 'protocol', label: 'Protocol', width: 80, minWidth: 60, visible: true },
  { id: 'symbol', label: 'DWARF Symbol', width: 140, minWidth: 80, visible: false },
]

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'palette.open': 'Ctrl+K',
  'workspace.save': 'Ctrl+S',
  'filter.focus': '/',
  'dvr.toggle_play': 'Space',
  'dvr.step_back': 'ArrowLeft',
  'dvr.step_forward': 'ArrowRight',
  'dvr.snap_live': 'End',
  'settings.open': 'Ctrl+,',
  'diff.toggle': 'Ctrl+Shift+D',
  'preset.bringup': 'Alt+1',
  'preset.debug': 'Alt+2',
  'preset.telemetry': 'Alt+3',
  'preset.hardware': 'Alt+4',
  'stream.jump_live': 'L',
  'stream.toggle_follow': 'F',
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'carbon-dark',
  density: 'default',
  accent: 'cyan',
  fontSize: 12,
  activePreset: 'bringup',
  customPresets: {},
  columns: DEFAULT_COLUMNS,
  keybindings: DEFAULT_KEYBINDINGS,
}

const SETTINGS_STORAGE_KEY = 'baudforge:settings:v1'

/**
 * Validate and sanitize loaded settings to guarantee complete type safety.
 */
function sanitizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  }

  const candidate = raw as Record<string, any>

  const theme: AppTheme =
    candidate.theme === 'carbon-dark' ||
    candidate.theme === 'paper-light' ||
    candidate.theme === 'high-contrast'
      ? candidate.theme
      : DEFAULT_SETTINGS.theme

  const density: AppDensity =
    candidate.density === 'compact' ||
    candidate.density === 'default' ||
    candidate.density === 'spacious'
      ? candidate.density
      : DEFAULT_SETTINGS.density

  const accent: AppAccent =
    candidate.accent === 'cyan' ||
    candidate.accent === 'green' ||
    candidate.accent === 'amber' ||
    candidate.accent === 'purple'
      ? candidate.accent
      : DEFAULT_SETTINGS.accent

  const rawFontSize = Number(candidate.fontSize)
  const fontSize =
    !isNaN(rawFontSize) && rawFontSize >= 11 && rawFontSize <= 16
      ? Math.round(rawFontSize)
      : DEFAULT_SETTINGS.fontSize

  const activePreset =
    typeof candidate.activePreset === 'string' && candidate.activePreset.length > 0
      ? candidate.activePreset
      : DEFAULT_SETTINGS.activePreset

  const customPresets =
    candidate.customPresets && typeof candidate.customPresets === 'object'
      ? candidate.customPresets
      : {}

  // Sanitize and align columns against DEFAULT_COLUMNS
  let columns: ColumnSetting[] = DEFAULT_COLUMNS.map((col) => ({ ...col }))
  if (Array.isArray(candidate.columns) && candidate.columns.length > 0) {
    const loadedMap = new Map<string, ColumnSetting>()
    for (const c of candidate.columns) {
      if (c && typeof c.id === 'string') {
        loadedMap.set(c.id, {
          id: c.id,
          label: typeof c.label === 'string' ? c.label : c.id,
          width: typeof c.width === 'number' && c.width > 20 ? c.width : 80,
          minWidth: typeof c.minWidth === 'number' ? c.minWidth : undefined,
          visible: typeof c.visible === 'boolean' ? c.visible : true,
          fixed: c.id === 'index' ? true : Boolean(c.fixed),
        })
      }
    }

    // Preserve order from candidate if valid, plus append any missing defaults
    const assembled: ColumnSetting[] = []
    const seen = new Set<string>()

    for (const c of candidate.columns) {
      if (c && typeof c.id === 'string' && loadedMap.has(c.id) && !seen.has(c.id)) {
        assembled.push(loadedMap.get(c.id)!)
        seen.add(c.id)
      }
    }

    // Append missing columns from defaults
    for (const def of DEFAULT_COLUMNS) {
      if (!seen.has(def.id)) {
        assembled.push({ ...def })
        seen.add(def.id)
      }
    }

    columns = assembled
  }

  // Sanitize keybindings
  const keybindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS }
  if (candidate.keybindings && typeof candidate.keybindings === 'object') {
    for (const [cmd, key] of Object.entries(candidate.keybindings)) {
      if (typeof key === 'string' && key.trim()) {
        keybindings[cmd] = key.trim()
      }
    }
  }

  return {
    theme,
    density,
    accent,
    fontSize,
    activePreset,
    customPresets,
    columns,
    keybindings,
  }
}

let cachedSettings: AppSettings | null = null

/**
 * Loads settings from localStorage with fallback defaults.
 */
export function loadSettings(): AppSettings {
  if (cachedSettings) {
    return { ...cachedSettings }
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        cachedSettings = sanitizeSettings(parsed)
        return { ...cachedSettings }
      }
    }
  } catch (err) {
    console.warn('[settings] Failed to read localStorage, using defaults:', err)
  }

  cachedSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  return { ...cachedSettings! }
}

/**
 * Persists settings to localStorage and notifies listeners.
 */
export function saveSettings(settings: AppSettings): void {
  const sanitized = sanitizeSettings(settings)
  cachedSettings = sanitized

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitized))
    }
  } catch (err) {
    console.error('[settings] Failed to save settings to localStorage:', err)
  }

  // Broadcast settings change event for cross-module sync
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('baudforge:settings-changed', { detail: sanitized }))
  }
}

/**
 * Serializes current settings to formatted JSON string.
 */
export function exportSettingsJson(): string {
  const settings = loadSettings()
  return JSON.stringify(settings, null, 2)
}

/**
 * Imports settings from a JSON string.
 * Returns true if parsed and applied successfully, false otherwise.
 */
export function importSettingsJson(json: string): boolean {
  try {
    const parsed = JSON.parse(json)
    const sanitized = sanitizeSettings(parsed)
    saveSettings(sanitized)
    return true
  } catch (err) {
    console.error('[settings] Failed to parse imported JSON:', err)
    return false
  }
}

/**
 * Resets all settings to factory defaults and persists them.
 */
export function resetToDefaults(): AppSettings {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  saveSettings(defaults)
  return defaults
}
