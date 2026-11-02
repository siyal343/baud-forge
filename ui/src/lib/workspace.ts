import type { BridgeView, PortView } from './types'
import { api, inShell } from './shell'

export interface FramingModeDef {
  id: string
  name: string
  label: string
  description: string
}

export const FRAMING_MODES: FramingModeDef[] = [
  {
    id: 'delimiter',
    name: 'delimiter',
    label: 'Line Delimited (\\n)',
    description: 'Line Delimited (\\n)',
  },
  {
    id: 'cobs',
    name: 'cobs',
    label: 'Consistent Overhead Byte Stuffing',
    description: 'Consistent Overhead Byte Stuffing',
  },
  {
    id: 'slip',
    name: 'slip',
    label: 'SLIP RFC 1055',
    description: 'SLIP RFC 1055',
  },
  {
    id: 'header-length',
    name: 'header-length',
    label: 'Length-prefixed sync',
    description: 'Length-prefixed sync',
  },
  {
    id: 'intel-hex',
    name: 'intel-hex',
    label: 'Intel HEX records',
    description: 'Intel HEX records',
  },
]

/**
 * Generate a client-side synthesized .bforge.toml string based on ports and bridges.
 */
export function synthesizeWorkspaceToml(ports: PortView[], bridges: BridgeView[] = []): string {
  const lines: string[] = [
    '# BaudForge Precision Instrument Workspace Configuration',
    '# Synthesized from active UI session state',
    '[workspace]',
    'name = "baudforge-workspace"',
    'version = "1.0"',
    '',
  ]

  for (const port of ports) {
    lines.push('[[ports]]')
    lines.push(`id = ${JSON.stringify(port.id)}`)
    if (port.device) {
      if (port.device.includes(':')) {
        lines.push('transport = "tcp-client"')
        lines.push(`address = ${JSON.stringify(port.device)}`)
      } else {
        lines.push(`device_path = ${JSON.stringify(port.device)}`)
      }
    } else {
      lines.push(`device_path = ${JSON.stringify(port.id)}`)
    }
    lines.push(`baud_rate = ${port.baud_rate || 115200}`)

    const mode = (port.framing || 'cobs').toLowerCase().replace(/-/g, '_')
    const crcPart = port.checksum ? `, crc = ${JSON.stringify(port.checksum)}` : ''

    if (mode === 'delimiter') {
      lines.push(`framing = { mode = "delimiter", delimiter = 10${crcPart} }`)
    } else if (mode === 'header_length') {
      lines.push(
        `framing = { mode = "header_length", sync = "AA 55", length_offset = 2, length_width = "u8", length_adjust = 3${crcPart} }`,
      )
    } else if (mode === 'intel_hex') {
      lines.push(`framing = { mode = "intel_hex"${crcPart} }`)
    } else if (mode === 'slip') {
      lines.push(`framing = { mode = "slip"${crcPart} }`)
    } else {
      lines.push(`framing = { mode = "cobs"${crcPart} }`)
    }
    lines.push('')
  }

  for (const b of bridges) {
    lines.push('[[bridges]]')
    lines.push(`id = ${JSON.stringify(b.id)}`)
    lines.push(`a = ${JSON.stringify(b.a)}`)
    lines.push(`b = ${JSON.stringify(b.b)}`)
    lines.push(`forward = ${b.forward ? 'true' : 'false'}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Triggers a browser download of a text blob.
 */
export function triggerFileDownload(filename: string, content: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Exports workspace configuration as .bforge.toml.
 * Attempts server /api/workspace/export first; falls back to client-side synthesis.
 */
export async function exportWorkspace(ports: PortView[], bridges: BridgeView[] = []): Promise<string> {
  const filename = 'baudforge-workspace.bforge.toml'
  let tomlContent: string | null = null

  // 1. Attempt GET or POST to /api/workspace/export
  try {
    const res = await fetch(api('/api/workspace/export'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports, bridges }),
    })
    if (res.ok) {
      const text = await res.text()
      try {
        const parsed = JSON.parse(text)
        tomlContent = parsed.toml || text
      } catch {
        tomlContent = text
      }
    }
  } catch {
    // /api/workspace/export not yet available
  }

  // 2. Synthesize client-side .bforge.toml if endpoint not available
  if (!tomlContent) {
    tomlContent = synthesizeWorkspaceToml(ports, bridges)
  }

  // 3. If running inside Tauri shell with invoke bridge, attempt native file save
  if (inShell()) {
    try {
      const tauri = (globalThis as { __TAURI__?: { core?: { invoke<T>(cmd: string, args?: any): Promise<T> } } })
        .__TAURI__
      if (tauri?.core) {
        const saved = await tauri.core.invoke<string>('save_workspace', { content: tomlContent, filename })
        if (saved) return saved
      }
    } catch {
      // Fall through to browser download
    }
  }

  // 4. Download file in web mode
  triggerFileDownload(filename, tomlContent)
  return filename
}
