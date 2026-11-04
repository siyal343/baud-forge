// BaudForge Rust Engine API & EventSource Client
// Connects to crates/bforge-core/src/serve.rs over loopback HTTP & SSE

import { UiSnapshot, UiEvent, PacketRow } from '../types';

export class EngineApiClient {
  private eventSource: EventSource | null = null;
  private baseUrl: string;

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

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getSnapshot(): Promise<UiSnapshot | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/snapshot`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
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
      const res = await fetch(`${this.baseUrl}/api/send`, {
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
      const res = await fetch(`${this.baseUrl}/api/yield`, {
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
      const res = await fetch(`${this.baseUrl}/api/fault`, {
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
      const res = await fetch(`${this.baseUrl}/api/pins`, {
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
      const res = await fetch(`${this.baseUrl}/api/pins`, {
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
      const res = await fetch(`${this.baseUrl}/api/diff?${params.toString()}`);
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
      const res = await fetch(`${this.baseUrl}/api/fault`, {
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
      const res = await fetch(`${this.baseUrl}/api/vault${params}`);
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
  format: 'csv' | 'saleae' | 'jsonl' | 'pcapng'
) {
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    let out = 'seq,timestamp_ns,seconds,port,direction,line_state,length,hex,text\n';
    for (const pkt of packets) {
      const tsNs = pkt.timestampNs || pkt.timestampUs * 1000;
      const sec = (pkt.timestampUs / 1e6).toFixed(6);
      const hex = pkt.rawHex || pkt.rawBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      const text = pkt.rawBytes
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('');
      out += `${pkt.seqId},${tsNs},${sec},${pkt.port},${pkt.direction.toLowerCase()},0,${pkt.rawBytes.length},${hex},${text}\n`;
    }
    const blob = new Blob([out], { type: 'text/csv;charset=utf-8' });
    triggerFileDownload(blob, `bforge-capture-${timestampStr}.csv`);
  } else if (format === 'saleae') {
    let out = 'Time [s], value, parity, error\n';
    for (const pkt of packets) {
      const baseSec = pkt.timestampUs / 1e6;
      for (let i = 0; i < pkt.rawBytes.length; i++) {
        const byte = pkt.rawBytes[i];
        const sec = (baseSec + i * 0.0000868).toFixed(6); // ~115.2k estimate
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
