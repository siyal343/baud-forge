import { create } from 'zustand';

/**
 * Global app preferences (the Settings dialog). Deliberately separate from
 * useWorkstationStore: these are set-once preferences, not session state, and
 * the Launcher screen needs them before any workstation store exists.
 *
 * Persistence mirrors the manual localStorage idiom used across the codebase
 * (see setUartConfig) — one JSON blob under a single `bforge_` key.
 */

export type ExportFormat = 'pcapng' | 'csv' | 'saleae' | 'jsonl' | 'parquet';
export type TimestampBase = 'wall' | 'relative';

export interface BfSettings {
  // Appearance
  /** Whole-app CSS zoom on <html>, 0.7–1.5. */
  uiScale: number;
  tooltipsEnabled: boolean;
  /** Stream Time column: wall clock vs elapsed since first formatted frame. */
  timestampBase: TimestampBase;
  hexBytesPerRow: 8 | 16 | 32;
  hexGrouping: 1 | 2 | 4;
  hexShowAscii: boolean;
  // Performance
  /** Rolling packet buffer depth (was the hardcoded MAX_PACKETS). */
  maxPackets: number;
  /** Oscilloscope / trace ring depth (was the hardcoded MAX_SCOPE_SAMPLES). */
  maxScopeSamples: number;
  // Data & export
  /** Format preselected when the vault export dialog opens. */
  defaultExportFormat: ExportFormat;
  /** REC file name template; `<stamp>` expands to an ISO timestamp. */
  vaultNamePattern: string;
}

export const EXPORT_FORMATS: ExportFormat[] = ['pcapng', 'saleae', 'csv', 'jsonl', 'parquet'];

export const DEFAULT_SETTINGS: BfSettings = {
  uiScale: 1.0,
  tooltipsEnabled: true,
  timestampBase: 'wall',
  hexBytesPerRow: 16,
  hexGrouping: 4,
  hexShowAscii: true,
  maxPackets: 10000,
  maxScopeSamples: 600,
  defaultExportFormat: 'pcapng',
  vaultNamePattern: 'rec-<stamp>',
};

export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
export const MAX_PACKETS_MIN = 1000;
export const MAX_PACKETS_MAX = 100000;
export const MAX_SCOPE_SAMPLES_MIN = 100;
export const MAX_SCOPE_SAMPLES_MAX = 5000;

const STORAGE_KEY = 'bforge_settings_v1';
const LEGACY_UI_SCALE_KEY = 'bforge_ui_scale';

const clampUiScale = (v: unknown): number => {
  const n = typeof v === 'number' && isFinite(v) ? v : DEFAULT_SETTINGS.uiScale;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(n * 100) / 100));
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Build the persisted layer: defaults → saved blob → legacy zoom-key
 * migration (one-time; the old `bforge_ui_scale` key is consumed here).
 */
const loadSettings = (): BfSettings => {
  const merged: BfSettings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (typeof saved.uiScale === 'number') merged.uiScale = clampUiScale(saved.uiScale);
        if (typeof saved.tooltipsEnabled === 'boolean') merged.tooltipsEnabled = saved.tooltipsEnabled;
        if (saved.timestampBase === 'wall' || saved.timestampBase === 'relative')
          merged.timestampBase = saved.timestampBase;
        if (saved.hexBytesPerRow === 8 || saved.hexBytesPerRow === 16 || saved.hexBytesPerRow === 32)
          merged.hexBytesPerRow = saved.hexBytesPerRow;
        if (saved.hexGrouping === 1 || saved.hexGrouping === 2 || saved.hexGrouping === 4)
          merged.hexGrouping = saved.hexGrouping;
        if (typeof saved.hexShowAscii === 'boolean') merged.hexShowAscii = saved.hexShowAscii;
        merged.maxPackets = clampInt(saved.maxPackets, MAX_PACKETS_MIN, MAX_PACKETS_MAX, merged.maxPackets);
        merged.maxScopeSamples = clampInt(
          saved.maxScopeSamples,
          MAX_SCOPE_SAMPLES_MIN,
          MAX_SCOPE_SAMPLES_MAX,
          merged.maxScopeSamples
        );
        if (EXPORT_FORMATS.includes(saved.defaultExportFormat))
          merged.defaultExportFormat = saved.defaultExportFormat;
        if (typeof saved.vaultNamePattern === 'string' && saved.vaultNamePattern.trim())
          merged.vaultNamePattern = saved.vaultNamePattern.trim();
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_UI_SCALE_KEY);
      if (legacy) {
        merged.uiScale = clampUiScale(parseFloat(legacy));
        localStorage.removeItem(LEGACY_UI_SCALE_KEY);
      } else if (typeof window !== 'undefined' && window.innerWidth < 1440) {
        // Same narrow-window fallback the old store used for fresh installs.
        merged.uiScale = 0.9;
      }
    }
  } catch (_) {}
  return merged;
};

interface SettingsState {
  settings: BfSettings;
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (partial: Partial<BfSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: loadSettings(),
  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  updateSettings: (partial) => {
    const next: BfSettings = { ...get().settings, ...partial };
    // Re-clamp free-form fields so direct writes (Ctrl+=/-/0 hotkeys) stay legal.
    next.uiScale = clampUiScale(next.uiScale);
    next.maxPackets = clampInt(next.maxPackets, MAX_PACKETS_MIN, MAX_PACKETS_MAX, DEFAULT_SETTINGS.maxPackets);
    next.maxScopeSamples = clampInt(
      next.maxScopeSamples,
      MAX_SCOPE_SAMPLES_MIN,
      MAX_SCOPE_SAMPLES_MAX,
      DEFAULT_SETTINGS.maxScopeSamples
    );
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
    set({ settings: next });
  },
}));

/**
 * Expand the REC name template into an engine vault path. `<stamp>` becomes
 * the same ISO stamp the ribbon always used; `.bflog` and the `vaults/`
 * directory are guaranteed so a hand-edited pattern can't stray.
 */
export const buildVaultPath = (pattern: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const trimmed = (pattern || '').trim() || DEFAULT_SETTINGS.vaultNamePattern;
  let name = trimmed.includes('<stamp>') ? trimmed.replace('<stamp>', stamp) : trimmed;
  if (!name.endsWith('.bflog')) name += '.bflog';
  return name.startsWith('vaults/') ? name : `vaults/${name}`;
};
