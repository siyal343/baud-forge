// Layout library store verification: name validation, persistence, the
// default-star lifecycle (deleting a starred layout clears the star), and the
// one-time migration from the pre-library single-slot save.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useLayoutLibraryStore,
  normalizeLayoutName,
  LAYOUT_NAME_MAX,
} from './useLayoutLibraryStore';

const resetLibrary = () => {
  useLayoutLibraryStore.setState({
    layouts: {},
    defaultLayout: null,
    lastLayoutName: 'Layout 1',
    saveRequest: null,
    loadRequest: null,
  });
};

describe('layout library store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibrary();
  });

  it('normalizes names: trims whitespace, caps length, rejects blank', () => {
    expect(normalizeLayoutName('  Scope Bench  ')).toBe('Scope Bench');
    expect(normalizeLayoutName('x'.repeat(100)).length).toBe(LAYOUT_NAME_MAX);
    expect(normalizeLayoutName('   ')).toBe('');
  });

  it('requestSaveLayoutAs rejects blank names without queuing a request', () => {
    expect(useLayoutLibraryStore.getState().requestSaveLayoutAs('   ')).toBe(false);
    expect(useLayoutLibraryStore.getState().saveRequest).toBeNull();
  });

  it('requestSaveLayoutAs queues a request carrying the cleaned name', () => {
    expect(useLayoutLibraryStore.getState().requestSaveLayoutAs('  HIL Bench ')).toBe(true);
    expect(useLayoutLibraryStore.getState().saveRequest).toMatchObject({ name: 'HIL Bench' });
  });

  it('commitSaveLayout stores the entry, persists it, and updates lastLayoutName', () => {
    useLayoutLibraryStore.getState().commitSaveLayout('Scope Bench', { grid: {}, panels: {} });
    const s = useLayoutLibraryStore.getState();
    expect(s.layouts['Scope Bench']).toBeDefined();
    expect(s.lastLayoutName).toBe('Scope Bench');

    const blob = JSON.parse(localStorage.getItem('bforge_layout_library_v1') || 'null');
    expect(blob.layouts['Scope Bench']).toBeDefined();
    expect(blob.lastLayoutName).toBe('Scope Bench');
  });

  it('commitSaveLayout overwrites an existing name in place', () => {
    const s = useLayoutLibraryStore.getState();
    s.commitSaveLayout('Bench', { gen: 1 });
    s.commitSaveLayout('Bench', { gen: 2 });
    expect(useLayoutLibraryStore.getState().layouts['Bench'].data).toEqual({ gen: 2 });
    expect(Object.keys(useLayoutLibraryStore.getState().layouts)).toHaveLength(1);
  });

  it('deleteLayout removes the entry and clears a default pointing at it', () => {
    const s = useLayoutLibraryStore.getState();
    s.commitSaveLayout('Bench', {});
    s.setDefaultLayout('Bench');
    expect(useLayoutLibraryStore.getState().defaultLayout).toBe('Bench');

    s.deleteLayout('Bench');
    const after = useLayoutLibraryStore.getState();
    expect(after.layouts['Bench']).toBeUndefined();
    expect(after.defaultLayout).toBeNull();
    expect(JSON.parse(localStorage.getItem('bforge_layout_library_v1') || '{}').defaultLayout).toBeNull();
  });

  it('deleteLayout keeps the default when an unrelated layout is removed', () => {
    const s = useLayoutLibraryStore.getState();
    s.commitSaveLayout('A', {});
    s.commitSaveLayout('B', {});
    s.setDefaultLayout('A');
    s.deleteLayout('B');
    expect(useLayoutLibraryStore.getState().defaultLayout).toBe('A');
  });

  it('setDefaultLayout(null) clears the star and persists', () => {
    const s = useLayoutLibraryStore.getState();
    s.commitSaveLayout('Bench', {});
    s.setDefaultLayout('Bench');
    s.setDefaultLayout(null);
    expect(useLayoutLibraryStore.getState().defaultLayout).toBeNull();
    expect(JSON.parse(localStorage.getItem('bforge_layout_library_v1') || '{}').defaultLayout).toBeNull();
  });

  it('repeated requests for the same name are distinguishable by seq', () => {
    const s = useLayoutLibraryStore.getState();
    s.requestLoadLayout('Bench');
    const first = useLayoutLibraryStore.getState().loadRequest;
    s.requestLoadLayout('Bench');
    const second = useLayoutLibraryStore.getState().loadRequest;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.seq).toBeGreaterThan(first!.seq);
  });

  it('imports the legacy single-slot save once as "My Layout" and consumes it', async () => {
    vi.resetModules();
    localStorage.setItem('bforge_user_saved_layout', JSON.stringify({ grid: { root: true }, panels: {} }));

    const mod = await import('./useLayoutLibraryStore');
    const s = mod.useLayoutLibraryStore.getState();
    expect(s.layouts['My Layout']).toBeDefined();
    expect(s.lastLayoutName).toBe('My Layout');
    // Consumed: a later factory reset can't resurrect the legacy blob.
    expect(localStorage.getItem('bforge_user_saved_layout')).toBeNull();
    // Already persisted under the new key.
    expect(JSON.parse(localStorage.getItem('bforge_layout_library_v1') || '{}').layouts['My Layout']).toBeDefined();
  });

  it('falls back to an empty library when the persisted blob is corrupt', async () => {
    vi.resetModules();
    localStorage.setItem('bforge_layout_library_v1', '{not json');

    const mod = await import('./useLayoutLibraryStore');
    const s = mod.useLayoutLibraryStore.getState();
    expect(s.layouts).toEqual({});
    expect(s.defaultLayout).toBeNull();
  });
});
