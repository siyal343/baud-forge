// BaudForge UI Data Contracts & Type Definitions
// Corresponds to crates/bforge-core/src/contract.rs & docs/UI-UX-DESIGNER-HANDOVER.md

export interface UiSnapshot {
  contract: number;
  session: SessionView;
  ports: PortView[];
  bridges: BridgeView[];
}

export interface SessionView {
  mode: 'idle' | 'record' | 'replay';
  vault: string;
  file_bytes: number;
  chunks: number;
  payload_bytes: number;
  elapsed_ms: number;
  started_epoch_ns: number;
  elf: string | null;
}

export interface PortView {
  id: string;
  device: string;
  baud_rate: number;
  framing: string;
  checksum: string | null;
  state: 'closed' | 'open' | 'reconnecting' | 'yielded';
  pins: PinsView;
  chunks: number;
  bytes: number;
  overruns: number;
  stalls_ms: number;
  read_errors: number;
}

export interface PinsView {
  cts: boolean;
  dsr: boolean;
  dcd: boolean;
  ri: boolean;
  break_state: boolean;
  framing_error: boolean;
  parity_error: boolean;
  dtr: boolean;
  rts: boolean;
}

export interface BridgeView {
  id: string;
  a: string;
  b: string;
  forward: boolean;
  forwarded: number;
  dropped: number;
}

export interface UiEvent {
  event: string;
  at_ms: number;
  [key: string]: any;
}

export type PacketDirection = 'RX' | 'TX' | 'A->B' | 'B->A' | 'FAULT';

export interface DissectedField {
  name: string;
  type: string;
  offset: number; // byte offset in payload
  length: number; // byte length
  rawHex: string;
  decodedValue: string | number | boolean;
  unit?: string;
  isValidCrc?: boolean | null;
  bitfield?: { bit: number; name: string; val: number }[];
  isMutated?: boolean;
  originalValue?: string;
}

export interface PacketRow {
  seqId: number;
  timestampNs: number;
  timestampUs: number;
  deltaUs: number;
  timeStr: string;
  direction: PacketDirection;
  port: string;
  length: number;
  rawBytes: number[];
  rawHex: string;
  protocol: string;
  summary: string;
  dissectedFields: DissectedField[];
  hasError: boolean;
  errorMsg?: string;
  isFaultInjected?: boolean;
}

export interface ScopeSignalSample {
  timestampUs: number;
  vBattMv: number;
  gyroZ: number;
  flags: [number, number, number];
  mode: number;
}
