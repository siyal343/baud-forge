// Client-side activity logging (spec: activity log system).
//
// Every significant UI action lands in the engine's activity ring through
// `POST /api/logs/client`, so one timeline holds both what the human pressed
// and what the engine did in response. This module is deliberately standalone
// (no engineApi import): engineApi logs its own failures here, and a cycle
// between the two would make that fragile.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Verbose mode: `?debug=1` lets `debug`-level actions reach the ring too. */
export const debugVerbose =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('debug') === '1';

/** Same engine-address rule as engineApi: the `?api=` param, else same-origin. */
function engineBase(): string {
  if (typeof window === 'undefined') return '';
  const api = new URLSearchParams(window.location.search).get('api');
  return api ? api.replace(/\/+$/, '') : '';
}

/**
 * Record a UI-originated action in the engine's activity ring.
 * Fire-and-forget by design: logging must never break the action it observes,
 * so every failure here is swallowed.
 */
export function logAction(event: string, detail?: string, level: LogLevel = 'info'): void {
  if (level === 'debug' && !debugVerbose) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  fetch(`${engineBase()}/api/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, event, detail: detail ?? '' }),
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/** Record an engine-call failure with the operation that produced it. */
export function logEngineFailure(op: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
  logAction('engine_error', `${op}: ${detail}`, 'error');
}
