import { inShell } from '../lib/shell'

/**
 * The title bar window chrome: rendered inside the desktop shell; a browser keeps its own chrome.
 */
export function WindowControls() {
  if (!inShell()) return null
  const shell = (globalThis as { __TAURI__?: { window?: { getCurrentWindow(): {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
  } } } }).__TAURI__
  const current = () => shell?.window?.getCurrentWindow()

  return (
    <div class="window-controls">
      <button type="button" title="minimise" onClick={() => current()?.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <line x1="1.5" y1="5" x2="8.5" y2="5" />
        </svg>
      </button>
      <button type="button" title="maximise" onClick={() => current()?.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
          <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
        </svg>
      </button>
      <button type="button" class="close" title="close" onClick={() => current()?.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
          <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
        </svg>
      </button>
    </div>
  )
}
