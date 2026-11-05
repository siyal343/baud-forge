#!/usr/bin/env python3
"""One-off patch: add ELF upload + schema client methods to engineApi.ts."""
import io

p = "ui/src/services/engineApi.ts"
s = io.open(p, encoding="utf-8").read()

anchor = "  /** Replace the session's MITM bridge set (POST /api/bridge). */"
methods = """  /** Parse a schema (dry run): POST /api/schema {action:'parse'}. */
  async schemaParse(
    kind: string,
    text: string,
    root?: string
  ): Promise<{ ok: boolean; fields?: FieldRowResult[]; error?: string }> {
    return this.schemaRequest('parse', kind, text, root);
  }

  /** Decode sample hex with a schema: POST /api/schema {action:'decode'}. */
  async schemaDecode(
    kind: string,
    text: string,
    root: string | undefined,
    hex: string
  ): Promise<{ ok: boolean; rows?: FieldRowResult[]; error?: string }> {
    const result = await this.schemaRequest('decode', kind, text, root, hex);
    return { ok: result.ok, rows: result.fields, error: result.error };
  }

  /** Apply a schema to a live port's decoder: POST /api/schema {action:'apply'}. */
  async schemaApply(
    kind: string,
    text: string,
    root: string | undefined,
    port: string
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.schemaRequest('apply', kind, text, root, undefined, port);
    return { ok: result.ok, error: result.error };
  }

  private async schemaRequest(
    action: 'parse' | 'decode' | 'apply',
    kind: string,
    text: string,
    root?: string,
    hex?: string,
    port?: string
  ): Promise<{ ok: boolean; fields?: FieldRowResult[]; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/schema',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, kind, text, root, hex, port }),
        },
        action === 'apply' ? 5000 : 8000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true, fields: Array.isArray(data) ? data : [] };
    } catch {
      return { ok: false, error: 'engine unreachable' };
    }
  }

  /** Upload a firmware image for symbolization (POST /api/elf, raw bytes). */
  async uploadElf(bytes: Uint8Array): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/elf',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes as unknown as BodyInit,
        },
        8000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` };
      return { ok: true, path: data?.path };
    } catch {
      return { ok: false, error: 'engine unreachable' };
    }
  }

  /** Replace the session's MITM bridge set (POST /api/bridge). */"""
assert anchor in s, "anchor missing"
s = s.replace(anchor, methods, 1)

# Type alias at the top after imports
imp_anchor = "import { UiSnapshot, UiEvent, PacketRow, BridgeView as BridgeViewResult } from '../types';"
assert imp_anchor in s, "import anchor missing"
s = s.replace(
    imp_anchor,
    imp_anchor
    + "\n\n/** One flattened field row, as /api/schema parse|decode returns. */\ninterface FieldRowResult {\n  name: string;\n  offset: number;\n  len: number;\n  value_num: number | null;\n  value: string | null;\n}",
    1,
)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("patched engineApi.ts")
