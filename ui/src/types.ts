// BaudForge UI Data Contracts & Type Definitions
// Corresponds to crates/bforge-core/src/contract.rs & docs/UI-UX-DESIGNER-HANDOVER.md

export interface ScriptAssertionView {
  name: string;
  passed: number;
  failed: number;
  last_error: string | null;
}

export interface ScriptStatusView {
  armed: boolean;
  name: string;
  policy: 'fail_open' | 'fail_closed';
  hooks: string[];
  invocations: number;
  changed: number;
  dropped: number;
  delayed: number;
  injected_tx: number;
  failures: number;
  logs_suppressed: number;
  assertions_passed: number;
  assertions_failed: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  last_instructions: number;
  last_exec_us: number;
  max_exec_us: number;
  last_error: string | null;
  metrics: Record<string, string>;
  assertions: ScriptAssertionView[];
}

export interface ScriptFieldDiffView {
  name: string;
  before: string | null;
  after: string | null;
}

export interface ScriptActionView {
  kind: 'send' | 'set_pins' | 'pulse_pin' | 'plot' | 'log';
  port?: string;
  hex?: string;
  delay_ms?: number;
  dtr?: boolean;
  rts?: boolean;
  pin?: string;
  series?: string;
  value?: number;
  timestamp_us?: number;
  level?: string;
  message?: string;
}

export interface ScriptDryRunView {
  ok: boolean;
  verdict: 'pass' | 'send' | 'delay' | 'drop' | 'burst' | 'error';
  mutated: boolean;
  input_hex: string;
  output_hex: string;
  delay_ms: number;
  burst_frames: Array<{ hex: string; delay_ms: number }>;
  field_diffs: ScriptFieldDiffView[];
  instructions: number;
  exec_us: number;
  memory_bytes: number;
  actions: ScriptActionView[];
  metrics: Record<string, string>;
  assertions: ScriptAssertionView[];
  error: string | null;
}

export interface UiSnapshot {
  contract: number;
  session: SessionView;
  ports: PortView[];
  bridges: BridgeView[];
  script?: ScriptStatusView | null;
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
