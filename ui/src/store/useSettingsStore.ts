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

/** Visual skin. `obsidian` is the classic engineering dark (the default). */
export type BfTheme = 'obsidian' | 'materials' | 'skeuomorph' | 'soft';
export type BfMode = 'dark' | 'light';

export const BF_THEMES: BfTheme[] = ['obsidian', 'materials', 'skeuomorph', 'soft'];
export const BF_MODES: BfMode[] = ['dark', 'light'];

export interface BfSettings {
  // Appearance
  /** Theme skin — indexes the --color-bf-* token sets in index.css. */
  theme: BfTheme;
  /** Light/dark variant of the selected theme. */
  themeMode: BfMode;
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
  theme: 'obsidian',
  themeMode: 'dark',
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

export const MAX_PACKETS_MIN = 1000;
export const MAX_PACKETS_MAX = 100000;
export const MAX_SCOPE_SAMPLES_MIN = 100;
export const MAX_SCOPE_SAMPLES_MAX = 5000;

const STORAGE_KEY = 'bforge_settings_v1';

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Pure merge: defaults → saved blob. Unknown keys in an older blob (e.g. the
 * removed `uiScale`) are simply ignored; every field is type/enum validated
 * so a corrupted blob can never poison the app. Exported for unit tests.
 */
export const mergeSettings = (saved: unknown): BfSettings => {
  const merged: BfSettings = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    const s = saved as Record<string, unknown>;
    if (BF_THEMES.includes(s.theme as BfTheme)) merged.theme = s.theme as BfTheme;
    if (BF_MODES.includes(s.themeMode as BfMode)) merged.themeMode = s.themeMode as BfMode;
    if (typeof s.tooltipsEnabled === 'boolean') merged.tooltipsEnabled = s.tooltipsEnabled;
    if (s.timestampBase === 'wall' || s.timestampBase === 'relative')
      merged.timestampBase = s.timestampBase;
    if (s.hexBytesPerRow === 8 || s.hexBytesPerRow === 16 || s.hexBytesPerRow === 32)
      merged.hexBytesPerRow = s.hexBytesPerRow;
    if (s.hexGrouping === 1 || s.hexGrouping === 2 || s.hexGrouping === 4)
      merged.hexGrouping = s.hexGrouping;
    if (typeof s.hexShowAscii === 'boolean') merged.hexShowAscii = s.hexShowAscii;
    merged.maxPackets = clampInt(s.maxPackets, MAX_PACKETS_MIN, MAX_PACKETS_MAX, merged.maxPackets);
    merged.maxScopeSamples = clampInt(
      s.maxScopeSamples,
      MAX_SCOPE_SAMPLES_MIN,
      MAX_SCOPE_SAMPLES_MAX,
      merged.maxScopeSamples
    );
    if (EXPORT_FORMATS.includes(s.defaultExportFormat as ExportFormat))
      merged.defaultExportFormat = s.defaultExportFormat as ExportFormat;
    if (typeof s.vaultNamePattern === 'string' && s.vaultNamePattern.trim())
      merged.vaultNamePattern = s.vaultNamePattern.trim();
  }
  return merged;
};

const loadSettings = (): BfSettings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeSettings(JSON.parse(raw));
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
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
    // Re-clamp free-form fields so direct writes stay legal.
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
