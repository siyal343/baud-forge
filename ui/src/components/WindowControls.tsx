import { inShell } from '../lib/shell'

/**
 * The title bar the guide asks for: the ribbon is the drag region, and these are the
 * three controls. Only rendered inside the desktop shell; a browser keeps its own chrome.
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
      <button type="button" title="minimise" onClick={() => current()?.minimize()}>–</button>
      <button type="button" title="maximise" onClick={() => current()?.toggleMaximize()}>□</button>
      <button type="button" class="close" title="close" onClick={() => current()?.close()}>×</button>
    </div>
  )
}
