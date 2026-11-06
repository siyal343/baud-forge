// BaudForge Rust Engine API & EventSource Client
// Connects to crates/bforge-core/src/serve.rs over loopback HTTP & SSE

import { UiSnapshot, UiEvent, PacketRow, BridgeView as BridgeViewResult } from '../types';
import { logEngineFailure } from './activityLog';

/** One activity-log row, as GET /api/logs returns (spec: activity log). */
export interface LogEntryView {
  seq: number;
  at_ms: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'engine' | 'ui';
  event: string;
  detail: string;
}

/** One flattened field row, as /api/schema parse|decode returns. */
interface TransferStatusView {
  phase?: string;
  name?: string;
  direction?: string;
  block?: number;
  total_blocks?: number;
  bytes_done?: number;
  total_bytes?: number;
  retries?: number;
}

interface FieldRowResult {
  name: string;
  offset: number;
  len: number;
  value_num: number | null;
  value: string | null;
}

export class EngineApiClient {
  private eventSource: EventSource | null = null;
  private baseUrl: string;

  /** A failed engine call, recorded in the activity ring with its operation. */
  private failure(op: string, error: string): { ok: false; error: string } {
    logEngineFailure(op, error);
    return { ok: false, error };
  }

  constructor(baseUrl = '') {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const apiParam = params.get('api');
      if (apiParam) {
        baseUrl = apiParam.replace(/\/+$/, '');
      }
    }
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch with a hard deadline. Without this a hung / black-holed engine
   * (or the dev server when the Rust host is not running) would leave
   * callers awaiting forever — the root cause of the silent-no-op TX bug.
   */
  private async fetchWithTimeout(
    path: string,
    init?: RequestInit,
    timeoutMs = 3500
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/health', { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getSnapshot(): Promise<UiSnapshot | null> {
    try {
      const res = await this.fetchWithTimeout('/api/snapshot');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Parse a schema (dry run): POST /api/schema {action:'parse'}. */
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
      if (!res.ok) return this.failure('schema', data?.error || `HTTP ${res.status}`);
      return { ok: true, fields: Array.isArray(data) ? data : [] };
    } catch {
      return this.failure('schema', 'engine unreachable');
    }
  }

  /** Stage bytes for a Send transfer (POST /api/transfer/upload). */
  async transferUpload(bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/transfer/upload',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes as unknown as BodyInit,
        },
        15000
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return this.failure('transferUpload', data?.error || `HTTP ${res.status}`);
      }
      return { ok: true };
    } catch {
      return this.failure('transferUpload', 'engine unreachable');
    }
  }

  /** Arm an X/YMODEM transfer (POST /api/transfer {action:'arm'}). */
  async transferArm(body: {
    port: string;
    direction: 'send' | 'recv';
    mode: 'crc128' | 'crc1k';
    name: string;
    size?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/transfer',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'arm', ...body }),
        },
        8000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return this.failure('transferArm', data?.error || `HTTP ${res.status}`);
      return { ok: true };
    } catch {
      return this.failure('transferArm', 'engine unreachable');
    }
  }

  /** Cancel an armed transfer (POST /api/transfer {action:'cancel'}). */
  async transferCancel(port: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/transfer',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', port }),
        },
        5000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return this.failure('transferCancel', data?.error || `HTTP ${res.status}`);
      return { ok: true };
    } catch {
      return this.failure('transferCancel', 'engine unreachable');
    }
  }

  /** Live transfer status (GET /api/transfer?port=). */
  async transferStatus(port: string): Promise<{ ok: boolean; view?: TransferStatusView; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(`/api/transfer?port=${encodeURIComponent(port)}`, {
        method: 'GET',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return this.failure('transferStatus', data?.error || `HTTP ${res.status}`);
      return { ok: true, view: data as TransferStatusView };
    } catch {
      return this.failure('transferStatus', 'engine unreachable');
    }
  }

  /** Drain a finished receive (GET /api/transfer/data?port=). */
  async transferData(port: string): Promise<{ ok: boolean; bytes?: Uint8Array; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(`/api/transfer/data?port=${encodeURIComponent(port)}`, {
        method: 'GET',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return this.failure('transferData', data?.error || `HTTP ${res.status}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { ok: true, bytes };
    } catch {
      return this.failure('transferData', 'engine unreachable');
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
      if (!res.ok) return this.failure('uploadElf', data?.error || `HTTP ${res.status}`);
      return { ok: true, path: data?.path };
    } catch {
      return this.failure('uploadElf', 'engine unreachable');
    }
  }

  /** Replace the session's MITM bridge set (POST /api/bridge). */
  async setBridges(
    bridges: Array<{ id: string; a: string; b: string; forward: boolean }>
  ): Promise<{ ok: boolean; views?: BridgeViewResult[]; error?: string }> {
    try {
      const res = await this.fetchWithTimeout('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bridges }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return this.failure('setBridges', data?.error || `HTTP ${res.status}`);
      return { ok: true, views: Array.isArray(data) ? data : [] };
    } catch {
      return this.failure('setBridges', 'engine unreachable');
    }
  }

  /** Start or stop the session vault (POST /api/record, workbench REC pill). */
  async recordControl(
    action: 'start' | 'stop',
    path?: string
  ): Promise<{ ok: boolean; vault?: string; error?: string }> {
    try {
      const res = await this.fetchWithTimeout(
        '/api/record',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, path }),
        },
        6000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return this.failure('recordControl', data?.error || `HTTP ${res.status}`);
      return { ok: true, vault: data?.vault };
    } catch {
      return this.failure('recordControl', 'engine unreachable');
    }
  }

  /** Open a hardware port session (POST /api/quick-connect). */
  async quickConnect(device: string, baudRate: number): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/quick-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, baud_rate: baudRate }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Hardware serial ports currently visible to the OS (GET /api/devices). */
  async getDevices(): Promise<
    Array<{ device_path: string; vid_pid?: string | null; serial?: string | null }>
  > {
    try {
      const res = await this.fetchWithTimeout('/api/devices');
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Activity ring rows after `since`, at or above `minLevel` (GET /api/logs). */
  async fetchLogs(since = 0, minLevel?: string): Promise<LogEntryView[]> {
    try {
      const params = new URLSearchParams({ since: String(since) });
      if (minLevel) params.set('level', minLevel);
      const res = await this.fetchWithTimeout(`/api/logs?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? (data as LogEntryView[]) : [];
    } catch {
      return [];
    }
  }

  subscribeEvents(
    onSnapshot: (snapshot: UiSnapshot) => void,
    onUiEvent: (event: UiEvent) => void,
    onFrameBatch?: (frames: any[]) => void,
    onOpen?: () => void,
    onError?: () => void
  ): () => void {
    if (this.eventSource) {
      this.eventSource.close();
    }

    try {
      this.eventSource = new EventSource(`${this.baseUrl}/api/events`);

      this.eventSource.addEventListener('open', () => {
        onOpen?.();
      });

      this.eventSource.addEventListener('error', () => {
        onError?.();
      });

      this.eventSource.addEventListener('snapshot', (e) => {
        try {
          const data = JSON.parse(e.data);
          onSnapshot(data);
        } catch (err) {
          console.warn('Failed to parse snapshot:', err);
        }
      });

      this.eventSource.addEventListener('ui', (e) => {
        try {
          const data = JSON.parse(e.data);
          onUiEvent(data);
        } catch (err) {
          console.warn('Failed to parse UI event:', err);
        }
      });

      this.eventSource.addEventListener('frames', (e) => {
        try {
          const data = JSON.parse(e.data);
          onFrameBatch?.(data);
        } catch (err) {
          console.warn('Failed to parse frames:', err);
        }
      });
    } catch {
      onError?.();
    }

    return () => {
      this.eventSource?.close();
      this.eventSource = null;
    };
  }

  async sendBytes(port: string, hexBytes: string, paceMs?: number): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port,
          hex: hexBytes,
          pace_ms: paceMs,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async yieldPort(port: string, seconds: number): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/yield', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, seconds }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async setFault(port: string, profile: any): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, profile }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async setPins(port: string, dtr: boolean, rts: boolean, pulseMs?: number): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, dtr, rts, pulse_ms: pulseMs }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async runPinSequence(
    port: string,
    steps: Array<{ dtr: boolean; rts: boolean; wait_ms: number }>
  ): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, steps }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getDiff(pathA: string, pathB: string): Promise<any> {
    try {
      const params = new URLSearchParams({ a: pathA, b: pathB });
      const res = await this.fetchWithTimeout(`/api/diff?${params.toString()}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async setFaultConfig(
    port: string,
    kind: string,
    options?: {
      flip_rate?: number;
      drop_every?: number;
      truncate?: number;
      corrupt_crc?: number;
      delay_ms?: number;
      jitter_ms?: number;
    }
  ): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('/api/fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port,
          kind,
          ...options,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  getVaultExportUrl(format: string, path?: string): string {
    const params = new URLSearchParams({ format });
    if (path) params.set('path', path);
    return `${this.baseUrl}/api/vault/export?${params.toString()}`;
  }

  async getVaultInfo(path?: string): Promise<{
    path: string;
    records: number;
    bytes: number;
    damaged_tail: number;
    duration_ms: number;
  } | null> {
    try {
      const params = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await this.fetchWithTimeout(`/api/vault${params}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}

export function triggerFileDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function exportPacketsClientSide(
  packets: PacketRow[],
  format: 'csv' | 'saleae' | 'jsonl' | 'pcapng',
  baudRate = 115200
) {
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    let out = 'seq,timestamp_ns,seconds,port,direction,line_state,length,hex,text\n';
    for (const pkt of packets) {
      const tsNs = pkt.timestampNs || pkt.timestampUs * 1000;
      const sec = (pkt.timestampUs / 1e6).toFixed(6);
      const hex = pkt.rawHex || pkt.rawBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      // Quote the printable-ASCII column — payload text containing commas or
      // quotes previously corrupted every subsequent field in the row.
      const text = pkt.rawBytes
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('')
        .replace(/"/g, '""');
      out += `${pkt.seqId},${tsNs},${sec},${pkt.port},${pkt.direction.toLowerCase()},0,${pkt.rawBytes.length},${hex},"${text}"\n`;
    }
    const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
    triggerFileDownload(blob, `bforge-capture-${timestampStr}.csv`);
  } else if (format === 'saleae') {
    let out = 'Time [s], value, parity, error\n';
    const bitPeriodSec = 1 / baudRate; // per-byte UART framing period
    for (const pkt of packets) {
      const baseSec = pkt.timestampUs / 1e6;
      for (let i = 0; i < pkt.rawBytes.length; i++) {
        const byte = pkt.rawBytes[i];
        const sec = (baseSec + i * bitPeriodSec).toFixed(6);
        const hex = '0x' + byte.toString(16).padStart(2, '0').toUpperCase();
        out += `${sec}, ${hex}, none, \n`;
      }
    }
    const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
    triggerFileDownload(blob, `bforge-capture-${timestampStr}.saleae.csv`);
  } else if (format === 'jsonl') {
    let out = '';
    for (const pkt of packets) {
      const tsNs = pkt.timestampNs || pkt.timestampUs * 1000;
      const sec = (pkt.timestampUs / 1e6).toFixed(6);
      const hex = pkt.rawHex || pkt.rawBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      const text = pkt.rawBytes
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
      out += `{"seq":${pkt.seqId},"timestamp_ns":${tsNs},"seconds":${sec},"port":"${pkt.port}","direction":"${pkt.direction.toLowerCase()}","line_state":0,"length":${pkt.rawBytes.length},"hex":"${hex}","text":"${text}"}\n`;
    }
    const blob = new Blob([out], { type: 'application/x-ndjson;charset=utf-8' });
    triggerFileDownload(blob, `bforge-capture-${timestampStr}.jsonl`);
  } else if (format === 'pcapng') {
    // Wireshark PCAPNG binary block builder (LinkType 147 USER0)
    const blocks: Uint8Array[] = [];

    // Helper to pad and finish block
    const finishBlock = (type: number, body: number[]) => {
      while (body.length % 4 !== 0) body.push(0);
      const totalLen = body.length + 12;
      const buf = new Uint8Array(totalLen);
      const view = new DataView(buf.buffer);
      view.setUint32(0, type, true);
      view.setUint32(4, totalLen, true);
      buf.set(body, 8);
      view.setUint32(totalLen - 4, totalLen, true);
      return buf;
    };

    // 1. Section Header Block (0x0A0D0D0A)
    const shbBody = [
      0x4d, 0x3c, 0x2b, 0x1a, // Magic 0x1A2B3C4D
      0x01, 0x00, 0x00, 0x00, // Version 1.0
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff // Section length unspecified
    ];
    blocks.push(finishBlock(0x0a0d0d0a, shbBody));

    // 2. Interface Description Block (0x00000001) - LinkType 147 (USER0)
    const idbBody: number[] = [
      0x93, 0x00, 0x00, 0x00, // LinkType 147 (0x0093), Reserved 0x0000
      0x00, 0x00, 0x04, 0x00, // SnapLen 262144
      // Option 2 (if_name = "bforge-uart")
      0x02, 0x00, 0x0b, 0x00, ...Array.from(new TextEncoder().encode('bforge-uart')), 0x00,
      // Option 9 (if_tsresol = 6 / microsecond)
      0x09, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00,
      // End of options
      0x00, 0x00, 0x00, 0x00
    ];
    blocks.push(finishBlock(0x00000001, idbBody));

    // 3. Enhanced Packet Blocks (0x00000006)
    for (const pkt of packets) {
      const portId = parseInt(pkt.port.replace(/\D/g, '')) || 0;
      const dirCode = pkt.direction.toLowerCase() === 'tx' ? 1 : 0;
      const payloadWithHeader = [
        portId & 0xff, (portId >> 8) & 0xff,
        dirCode,
        ...pkt.rawBytes
      ];

      const epbBody: number[] = [];
      const view = new DataView(new ArrayBuffer(20));
      view.setUint32(0, 0, true); // Interface ID 0
      const tsUs = BigInt(pkt.timestampUs);
      view.setUint32(4, Number(tsUs >> 32n), true); // High timestamp
      view.setUint32(8, Number(tsUs & 0xffffffffn), true); // Low timestamp
      view.setUint32(12, payloadWithHeader.length, true); // Captured length
      view.setUint32(16, payloadWithHeader.length, true); // Original length
      epbBody.push(...new Uint8Array(view.buffer));
      epbBody.push(...payloadWithHeader);

      blocks.push(finishBlock(0x00000006, epbBody));
    }

    const totalBytes = blocks.reduce((acc, b) => acc + b.length, 0);
    const fullPcap = new Uint8Array(totalBytes);
    let offset = 0;
    for (const b of blocks) {
      fullPcap.set(b, offset);
      offset += b.length;
    }

    const blob = new Blob([fullPcap], { type: 'application/vnd.tcpdump.pcap' });
    triggerFileDownload(blob, `bforge-capture-${timestampStr}.pcapng`);
  }
}

export const engineApi = new EngineApiClient();
