//! Where the engine is, and how to talk to the shell around it.
//!
//! The workbench runs in two places: served by the engine itself (`bforge serve`, a
//! browser), where every `/api` path is relative, and inside the desktop bundle, where
//! the engine is a different origin and the shell has to say which one. The shell passes
//! `?api=http://127.0.0.1:PORT`; everything else uses the empty base.

/** The engine's base URL, without a trailing slash. Empty means "this origin". */
export function apiBase(): string {
  const fromQuery = new URLSearchParams(location.search).get('api')
  return (fromQuery ?? '').replace(/\/+$/, '')
}

/** An absolute URL for an engine route, for the fetch calls and the EventSource. */
export function api(path: string): string {
  return `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`
}

/** The shell's commands, when this page runs inside the desktop application. */
interface ShellBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
}

function bridge(): ShellBridge | null {
  const tauri = (globalThis as { __TAURI__?: { core?: ShellBridge } }).__TAURI__
  return tauri?.core ?? null
}

/** True when the workbench is hosted by the desktop shell rather than by the engine. */
export function inShell(): boolean {
  return bridge() !== null
}

/** Stop the session this window started. Returns false when not in the shell. */
export async function stopSession(): Promise<boolean> {
  const shell = bridge()
  if (!shell) return false
  await shell.invoke('stop_workspace')
  return true
}

/** Go back to the workspace picker the shell serves. */
export function toPicker(): void {
  const shell = bridge()
  if (!shell) return
  // The bundle's own entry point, not the engine's.
  location.replace('desktop.html')
}
