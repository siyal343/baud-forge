import { create } from 'zustand';
import { logAction, type LogLevel } from '../services/activityLog';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

const TOAST_LEVEL: Record<ToastKind, LogLevel> = {
  info: 'info',
  success: 'info',
  warn: 'warn',
  error: 'error',
};

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastState {
  toasts: Toast[];
  pushToast: (kind: ToastKind, title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
}

const DEDUPE_WINDOW_MS = 4000;
let nextId = 1;
// Title+detail pairs seen recently, so periodic loops (e.g. a 100 ms command
// loop against a dead engine) cannot flood the stack with identical toasts.
const recentSignatures = new Map<string, number>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (kind, title, detail) => {
    const now = Date.now();
    const signature = `${kind}|${title}|${detail ?? ''}`;
    const lastSeen = recentSignatures.get(signature);
    if (lastSeen !== undefined && now - lastSeen < DEDUPE_WINDOW_MS) return;
    recentSignatures.set(signature, now);
    // Prune stale signatures so the map cannot grow unbounded.
    for (const [sig, seen] of recentSignatures) {
      if (now - seen >= DEDUPE_WINDOW_MS) recentSignatures.delete(sig);
    }

    const toast: Toast = { id: nextId++, kind, title, detail };
    set({ toasts: [...get().toasts, toast].slice(-5) });
    // Every toast is a fact about the session; it lands in the same activity
    // timeline the engine writes, so a bug report needs only that one file.
    logAction('toast', detail ? `${title} — ${detail}` : title, TOAST_LEVEL[kind]);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Convenience helper so callers do not need the hook outside React components. */
export const toast = {
  info: (title: string, detail?: string) => useToastStore.getState().pushToast('info', title, detail),
  success: (title: string, detail?: string) => useToastStore.getState().pushToast('success', title, detail),
  warn: (title: string, detail?: string) => useToastStore.getState().pushToast('warn', title, detail),
  error: (title: string, detail?: string) => useToastStore.getState().pushToast('error', title, detail),
};
