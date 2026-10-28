// The wire types of the F1.7 contract (spec 0006) and the tail rows (spec 0018).
// They mirror the Rust structs; the contract version guards a mismatch.

export interface PinsView {
  cts: boolean
  dsr: boolean
  dcd: boolean
  ri: boolean
  break_state: boolean
  framing_error: boolean
  parity_error: boolean
}

export interface PortView {
  id: string
  device: string
  baud_rate: number
  framing: string
  checksum: string | null
  state: 'closed' | 'open' | 'reconnecting' | 'yielded'
  pins: PinsView
  chunks: number
  bytes: number
  overruns: number
  stalls_ms: number
  read_errors: number
}

export interface SessionView {
  mode: string
  vault: string
  file_bytes: number
  chunks: number
  payload_bytes: number
  elapsed_ms: number
  started_epoch_ns: number
  elf: string | null
}

export interface UiSnapshot {
  contract: number
  session: SessionView
  ports: PortView[]
}

export interface FieldRow {
  name: string
  offset: number
  len: number
  value: string
}

export interface TailRow {
  port: string
  timestamp_us: number
  delta_us: number
  len: number
  hex: string
  text: string
  protocol: string | null
  fields: FieldRow[]
  decode_error: string | null
}

export type UiEvent =
  | { event: 'started'; at_ms: number; ports: number; vault: string }
  | { event: 'stats'; at_ms: number; chunks: number; payload_bytes: number; overruns: number; chunks_per_sec: number }
  | { event: 'port_state_changed'; at_ms: number; port: string; state: string }
  | { event: 'overrun'; at_ms: number; port: string; total: number }
  | { event: 'damaged_tail'; at_ms: number; port: string }
  | { event: 'stopped'; at_ms: number; chunks: number; payload_bytes: number }
