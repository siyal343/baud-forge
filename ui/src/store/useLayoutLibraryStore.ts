import { create } from 'zustand';

// Named workstation layout library: the dock serializes its panel arrangement
// under a user-chosen name, layouts are listed in the LAYOUTS & PANELS menu,
// and one can be starred as the startup default. Persisted manually (project
// pattern — no zustand persist middleware) under a versioned localStorage key.
// The pre-library single-slot `bforge_user_saved_layout` is imported once as
// "My Layout", then consumed so it can't resurrect after a factory reset.

const STORAGE_KEY = 'bforge_layout_library_v1';
const LEGACY_KEY = 'bforge_user_saved_layout';

export const LAYOUT_NAME_MAX = 40;

export interface SavedLayoutEntry {
  savedAt: number;
  data: unknown; // dockview SerializedDockview
}

export interface LayoutRequest {
  seq: number;
  name: string;
}

interface PersistedLibrary {
  version: 1;
  defaultLayout: string | null;
  lastLayoutName: string;
  layouts: Record<string, SavedLayoutEntry>;
}

interface LayoutLibraryState {
  layouts: Record<string, SavedLayoutEntry>;
  /** Layout loaded on startup; null means session auto-save behavior. */
  defaultLayout: string | null;
  /** Pre-fills the save-name input. */
  lastLayoutName: string;
  /** Pending dock-mediated actions; `seq` distinguishes repeats of the same name. */
  saveRequest: LayoutRequest | null;
  loadRequest: LayoutRequest | null;

  /** Validates the name and asks the dock to serialize. Returns false for blank names. */
  requestSaveLayoutAs: (rawName: string) => boolean;
  requestLoadLayout: (name: string) => void;
  /** Dock callback with the serialized arrangement. */
  commitSaveLayout: (name: string, data: unknown) => void;
  deleteLayout: (name: string) => void;
  setDefaultLayout: (name: string | null) => void;
}

export const normalizeLayoutName = (raw: string): string =>
  raw.trim().slice(0, LAYOUT_NAME_MAX).trim();

const emptyLibrary = (): PersistedLibrary => ({
  version: 1,
  defaultLayout: null,
  lastLayoutName: 'Layout 1',
  layouts: {},
});

const loadPersisted = (): PersistedLibrary => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.layouts && typeof parsed.layouts === 'object') {
        return {
          version: 1,
          defaultLayout: typeof parsed.defaultLayout === 'string' ? parsed.defaultLayout : null,
          lastLayoutName: typeof parsed.lastLayoutName === 'string' ? parsed.lastLayoutName : 'Layout 1',
          layouts: parsed.layouts,
        };
      }
    }
    // One-time migration from the single-slot era.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      localStorage.removeItem(LEGACY_KEY);
      const migrated: PersistedLibrary = {
        version: 1,
        defaultLayout: null,
        lastLayoutName: 'My Layout',
        layouts: { 'My Layout': { savedAt: Date.now(), data: JSON.parse(legacy) } },
      };
      // Durable immediately — a crash after this point must not lose the import.
      persist(migrated);
      return migrated;
    }
  } catch (_) {
    // Corrupt blob falls through to a fresh library; the dock still boots.
  }
  return emptyLibrary();
};

const persist = (lib: PersistedLibrary): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
  } catch (_) {
    // Quota or privacy-mode failure keeps the in-memory library usable.
  }
};

let requestSeq = 0;
const nextSeq = () => ++requestSeq;

export const useLayoutLibraryStore = create<LayoutLibraryState>()((set, get) => {
  const initial = loadPersisted();
  return {
    layouts: initial.layouts,
    defaultLayout: initial.defaultLayout,
    lastLayoutName: initial.lastLayoutName,
    saveRequest: null,
    loadRequest: null,

    requestSaveLayoutAs: (rawName) => {
      const name = normalizeLayoutName(rawName);
      if (!name) return false;
      set({ saveRequest: { seq: nextSeq(), name } });
      return true;
    },

    requestLoadLayout: (name) => {
      set({ loadRequest: { seq: nextSeq(), name } });
    },

    commitSaveLayout: (name, data) => {
      const layouts = { ...get().layouts, [name]: { savedAt: Date.now(), data } };
      set({ layouts, lastLayoutName: name });
      persist({ version: 1, defaultLayout: get().defaultLayout, lastLayoutName: name, layouts });
    },

    deleteLayout: (name) => {
      const layouts = { ...get().layouts };
      delete layouts[name];
      const defaultLayout = get().defaultLayout === name ? null : get().defaultLayout;
      set({ layouts, defaultLayout });
      persist({ version: 1, defaultLayout, lastLayoutName: get().lastLayoutName, layouts });
    },

    setDefaultLayout: (name) => {
      set({ defaultLayout: name });
      persist({ version: 1, defaultLayout: name, lastLayoutName: get().lastLayoutName, layouts: get().layouts });
    },
  };
});

/** Sync snapshot for the dock's onReady, which runs before React effects. */
export const readLayoutLibrarySnapshot = (): {
  layouts: Record<string, SavedLayoutEntry>;
  defaultLayout: string | null;
} => {
  const s = useLayoutLibraryStore.getState();
  return { layouts: s.layouts, defaultLayout: s.defaultLayout };
};
