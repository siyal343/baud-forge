import { createSignal, createMemo } from 'solid-js'
import {
  type AppTheme,
  type AppDensity,
  type AppAccent,
  type AppSettings,
  loadSettings,
  saveSettings,
} from './settings.ts'

const initialSettings = loadSettings()

const [theme, setThemeSignal] = createSignal<AppTheme>(initialSettings.theme)
const [density, setDensitySignal] = createSignal<AppDensity>(initialSettings.density)
const [accent, setAccentSignal] = createSignal<AppAccent>(initialSettings.accent)
const [fontSize, setFontSizeSignal] = createSignal<number>(initialSettings.fontSize)

export const currentTheme = theme
export const currentDensity = density
export const currentAccent = accent
export const currentFontSize = fontSize

export function getRowHeightForDensity(den: AppDensity): number {
  switch (den) {
    case 'compact':
      return 22
    case 'spacious':
      return 32
    case 'default':
    default:
      return 26
  }
}

export function getTableFontSizeForDensity(den: AppDensity): number {
  switch (den) {
    case 'compact':
      return 11
    case 'spacious':
      return 13
    case 'default':
    default:
      return 12
  }
}

export const currentRowHeight = createMemo(() => getRowHeightForDensity(density()))
export const currentTableFontSize = createMemo(() => getTableFontSizeForDensity(density()))

/**
 * Applies visual theme, density classes, and typography variables to the document root.
 */
export function applyTheme(
  targetTheme: AppTheme,
  targetDensity: AppDensity,
  targetFontSize: number,
  targetAccent: AppAccent,
): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  // Remove existing theme classes and assign new theme
  root.classList.remove('theme-carbon-dark', 'theme-paper-light', 'theme-high-contrast')
  root.classList.add(`theme-${targetTheme}`)
  root.setAttribute('data-theme', targetTheme)

  // Remove existing density classes and assign new density
  root.classList.remove('density-compact', 'density-default', 'density-spacious')
  root.classList.add(`density-${targetDensity}`)
  root.setAttribute('data-density', targetDensity)

  // Accent attribute
  root.setAttribute('data-accent', targetAccent)

  // Dynamic CSS variables
  const clampedSize = Math.max(11, Math.min(16, targetFontSize))
  root.style.setProperty('--font-ui-size', `${clampedSize}px`)

  const rowHeight = getRowHeightForDensity(targetDensity)
  root.style.setProperty('--row-height', `${rowHeight}px`)

  const tableFontSize = getTableFontSizeForDensity(targetDensity)
  root.style.setProperty('--table-font-size', `${tableFontSize}px`)

  // Update reactive signals
  setThemeSignal(targetTheme)
  setDensitySignal(targetDensity)
  setAccentSignal(targetAccent)
  setFontSizeSignal(clampedSize)
}

/**
 * Initializes theme engine from stored settings.
 */
export function initTheme(): void {
  const settings = loadSettings()
  applyTheme(settings.theme, settings.density, settings.fontSize, settings.accent)

  if (typeof window !== 'undefined') {
    window.addEventListener('baudforge:settings-changed', ((e: CustomEvent<AppSettings>) => {
      const s = e.detail
      if (s) {
        applyTheme(s.theme, s.density, s.fontSize, s.accent)
      }
    }) as EventListener)
  }
}

/**
 * Change active theme and persist.
 */
export function setTheme(newTheme: AppTheme): void {
  const s = loadSettings()
  s.theme = newTheme
  saveSettings(s)
  applyTheme(s.theme, s.density, s.fontSize, s.accent)
}

/**
 * Change row density tier and persist.
 */
export function setDensity(newDensity: AppDensity): void {
  const s = loadSettings()
  s.density = newDensity
  saveSettings(s)
  applyTheme(s.theme, s.density, s.fontSize, s.accent)
}

/**
 * Change accent color and persist.
 */
export function setAccent(newAccent: AppAccent): void {
  const s = loadSettings()
  s.accent = newAccent
  saveSettings(s)
  applyTheme(s.theme, s.density, s.fontSize, s.accent)
}

/**
 * Change global UI font size and persist.
 */
export function setFontSize(newSize: number): void {
  const s = loadSettings()
  s.fontSize = Math.max(11, Math.min(16, newSize))
  saveSettings(s)
  applyTheme(s.theme, s.density, s.fontSize, s.accent)
}

// Automatically initialize on import in browser environment
if (typeof document !== 'undefined') {
  initTheme()
}
