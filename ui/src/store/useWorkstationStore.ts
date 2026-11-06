import { create } from 'zustand';
import { PacketRow, DissectedField, ScopeSignalSample, PinsView, PortView, BridgeView } from '../types';
import { generateSampleImuPacket, generateScopeSample } from '../services/simulationEngine';
import { engineApi } from '../services/engineApi';
import { logAction } from '../services/activityLog';
import { toast } from './useToastStore';

interface WorkstationState {
  // Connection & Port
  isConnected: boolean;
  portState: 'closed' | 'open' | 'reconnecting' | 'yielded';
  selectedPort: string;
  baudRate: number;
  framing: string;
  dataBits: number;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits: number;
  delimiterMode: 'cobs' | 'lf' | 'crlf' | 'null' | 'slip' | 'raw' | 'custom';
  customDelimiterHex: string;
  availablePorts: Array<{ id: string; device: string; description: string }>;
  /** Real session ports + live bridge state from the engine snapshot. */
  enginePorts: Array<{ id: string; device: string }>;
  bridges: BridgeView[];
  pins: PinsView;

  // Stream & Dissector
  packets: PacketRow[];
  selectedPacket: PacketRow | null;
  selectedField: DissectedField | null;
  hoveredField: DissectedField | null;
  autoScroll: boolean;
  filterText: string;
  directionFilter: 'all' | 'rx' | 'tx' | 'fault';
  /** 'all' or a port id from the stream (spec 2.3 port_filter chips). */
  portFilter: string;
  /** Errors-only toggle (spec 2.3 packet_kind_filter: errors). */
  errorsOnly: boolean;
  isScanningPorts: boolean;

  // Oscilloscope & Telemetry
  scopeSamples: ScopeSignalSample[];
  cursorT1Us: number | null;
  cursorT2Us: number | null;
  ch1Visible: boolean;
  ch2Visible: boolean;
  logicRailsVisible: boolean;
  /** Fields bound to scope trace lanes (spec 5.4 "plot any numeric field"). */
  traceBindings: Array<{ id: string; name: string; unit?: string }>;
  /** Per-binding time series, keyed by binding id, bounded like scopeSamples. */
  traceSeries: Record<string, Array<{ tUs: number; value: number }>>;
  traceHidden: Record<string, boolean>;

  // DVR Timeline
  isLive: boolean;
  isPaused: boolean;
  isReplaying: boolean;
  playbackSpeed: number;
  pausedTimestampUs: number | null;

  // Flash Yield
  isYielded: boolean;
  yieldRemainingSecs: number;

  // Fault Injection Rig
  isFaultArmed: boolean;
  bitFlip: boolean;
  corruptCrc: boolean;
  dropRate: number;

  // Simulation & Metrics
  isSimulated: boolean;
  vaultPath: string;
  vaultBytes: number;
  vaultChunks: number;
  engineRecording: boolean;
  rxBytes: number;
  txBytes: number;
  packetRate: number;
  overruns: number;
  uiScale: number;
  isExportModalOpen: boolean;
  activePreset: 'default' | 'dissector' | 'scope' | 'hil';
  openPanelId: string | null;
  resetLayoutTrigger: number;
  saveLayoutTrigger: number;
  restoreSavedLayoutTrigger: number;
  hasSavedLayout: boolean;

  // Actions
  setExportModalOpen: (open: boolean) => void;
  setActivePreset: (preset: 'default' | 'dissector' | 'scope' | 'hil') => void;
  requestOpenPanel: (id: string) => void;
  requestResetLayout: () => void;
  requestSaveLayout: () => void;
  requestRestoreSavedLayout: () => void;
  setHasSavedLayout: (saved: boolean) => void;
  setUiScale: (scale: number) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  setSelectedPort: (port: string) => void;
  setBaudRate: (baud: number) => void;
  setFraming: (framing: string) => void;
  setDirectionFilter: (filter: 'all' | 'rx' | 'tx' | 'fault') => void;
  setPortFilter: (port: string) => void;
  setErrorsOnly: (val: boolean) => void;
  rescanPorts: () => Promise<void>;
  setUartConfig: (cfg: Partial<{
    dataBits: number;
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits: number;
    delimiterMode: 'cobs' | 'lf' | 'crlf' | 'null' | 'slip' | 'raw' | 'custom';
    customDelimiterHex: string;
  }>) => void;
  selectPacket: (packet: PacketRow | null) => void;
  selectField: (field: DissectedField | null) => void;
  setHoveredField: (field: DissectedField | null) => void;
  setAutoScroll: (val: boolean) => void;
  setFilterText: (text: string) => void;
  setCursorT1: (tUs: number | null) => void;
  setCursorT2: (tUs: number | null) => void;
  toggleChannel: (ch: 'ch1' | 'ch2' | 'logic') => void;
  bindScopeTrace: (field: { name: string; unit?: string }) => string;
  unbindScopeTrace: (id: string) => void;
  toggleTraceVisibility: (id: string) => void;
  setDvrLive: () => void;
  setDvrPaused: (val: boolean) => void;
  startReplay: () => void;
  stopReplay: () => void;
  seekToTimestamp: (tUs: number) => void;
  stepFrame: (direction: 'forward' | 'back') => void;
  setPlaybackSpeed: (speed: number) => void;
  triggerFlashYield: (seconds?: number) => void;
  reclaimPort: () => void;
  toggleFaultArm: () => void;
  toggleSimulationMode: () => void;
  clearStream: () => void;
  loadSampleCapture: () => void;
  recordTx: (bytes: number) => void;
  addPacket: (pkt: PacketRow) => void;
  addPacketBatch: (pkts: PacketRow[]) => void;
  updatePins: (pins: Partial<PinsView>) => void;
  updateSnapshot: (ports: PortView[], bridges?: BridgeView[]) => void;
  updateSession: (session: { mode: string; vault: string; file_bytes: number; chunks: number }) => void;
}

const MAX_PACKETS = 10000;
const MAX_SCOPE_SAMPLES = 600;

// Live packet-rate metering: timestamps of recently added packets, sampled
// once per second. Kept outside the reactive state — only the computed rate
// is written to the store so subscribers re-render at 1 Hz, not per packet.
const rateTimestamps: number[] = [];
let yieldTimerId: number | null = null;

// DVR replay engine: walks the rolling packet buffer at playbackSpeed while
// the live capture is paused. Timer + cursor live outside the reactive state.
let replayTimerId: number | null = null;
let replayIdx = 0;

// Monotonic SeqId source. The previous schemes (Date.now() % 100000 for TX
// rows, timestamp_ms % 1000000 for engine frames) collided whenever two
// frames landed in the same millisecond, producing duplicate React keys and
// wrong DVR stepping. Every packet entering the store is renumbered here.
let nextSeqId = 1;
const withUniqueSeqId = (pkt: PacketRow): PacketRow => ({ ...pkt, seqId: nextSeqId++ });

/** First numeric value of a named dissected field, or null when absent. */
const FIELD_NUMBER = /-?\d+(?:\.\d+)?/;
const findFieldValue = (pkt: PacketRow, name: string): number | null => {
  const field = (pkt.dissectedFields ?? []).find((f) => f.name === name);
  if (!field) return null;
  const match = FIELD_NUMBER.exec(String(field.decodedValue));
  return match ? parseFloat(match[0]) : null;
};

/**
 * Derive a scope point from a REAL decoded packet instead of synthesizing a
 * sine wave. Values are read from the dissector's decoded fields (v_batt*,
 * gyro_z*); when a frame carries no matching fields (e.g. a TX command row)
 * the previous reading is held so the trace stays continuous.
 */
const scopeSampleFromPacket = (
  pkt: PacketRow,
  prev: ScopeSignalSample | null
): ScopeSignalSample => {
  const findVal = (re: RegExp): number | null => {
    for (const f of pkt.dissectedFields ?? []) {
      if (re.test(f.name)) {
        const m = /-?\d+(?:\.\d+)?/.exec(String(f.decodedValue));
        if (m) return parseFloat(m[0]);
      }
    }
    return null;
  };
  let vBatt = findVal(/^v_batt/);
  if (vBatt !== null && Math.abs(vBatt) < 100) vBatt *= 1000; // volts → mV
  const gyroZ = findVal(/^gyro_z/);
  return {
    timestampUs: pkt.timestampUs,
    vBattMv: vBatt ?? prev?.vBattMv ?? 0,
    gyroZ: gyroZ ?? prev?.gyroZ ?? 0,
    flags: [0, 0, 0],
    mode: prev?.mode ?? 0,
  };
};

const getSavedUartConfig = () => {
  try {
    const raw = localStorage.getItem('bforge_uart_config');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
};
const initialUart = getSavedUartConfig();

export const useWorkstationStore = create<WorkstationState>((set, get) => ({
  // Connection & Port
  isConnected: true, // Default active in simulated mode for instant onboarding
  portState: 'open',
  selectedPort: 'COM8',
  baudRate: 115200,
  framing: initialUart?.delimiterMode || 'cobs',
  dataBits: initialUart?.dataBits ?? 8,
  parity: initialUart?.parity ?? 'none',
  stopBits: initialUart?.stopBits ?? 1,
  delimiterMode: initialUart?.delimiterMode ?? 'cobs',
  customDelimiterHex: initialUart?.customDelimiterHex ?? '00',
  availablePorts: [
    { id: 'COM8', device: 'ESP32-C3', description: 'Espressif USB JTAG/Serial [303A:1001]' },
    { id: 'COM3', device: 'STM32F401', description: 'STMicroelectronics ST-Link V2-1' },
    { id: 'loopback-a', device: 'OBC Simulator', description: '127.0.0.1:9100 (TCP)' },
    { id: 'loopback-b', device: 'EPS Simulator', description: '127.0.0.1:9101 (TCP)' },
  ],
  enginePorts: [],
  bridges: [],
  pins: {
    cts: true,
    dsr: true,
    dcd: true,
    ri: false,
    break_state: false,
    framing_error: false,
    parity_error: false,
    dtr: true,
    rts: false,
  },

  // Stream & Dissector
  packets: [],
  selectedPacket: null,
  selectedField: null,
  hoveredField: null,
  autoScroll: true,
  filterText: '',
  directionFilter: 'all',
  portFilter: 'all',
  errorsOnly: false,
  isScanningPorts: false,

  // Oscilloscope
  scopeSamples: [],
  cursorT1Us: null,
  cursorT2Us: null,
  ch1Visible: true,
  ch2Visible: true,
  logicRailsVisible: true,
  // Per-field trace bindings (spec 5.4: plot any numeric dissected field).
  traceBindings: [],
  traceSeries: {},
  traceHidden: {},

  // DVR Timeline
  isLive: true,
  isPaused: false,
  isReplaying: false,
  playbackSpeed: 1.0,
  pausedTimestampUs: null,

  // Flash Yield
  isYielded: false,
  yieldRemainingSecs: 0,

  // Fault Injection Rig
  isFaultArmed: false,
  bitFlip: false,
  corruptCrc: false,
  dropRate: 0,

  // Simulation & Metrics
  isSimulated: true,
  vaultPath: 'vaults/session_001.bflog',
  vaultBytes: 0,
  vaultChunks: 0,
  engineRecording: false,
  rxBytes: 4210080,
  txBytes: 15420,
  packetRate: 20,
  overruns: 0,
  uiScale: (() => {
    try {
      const saved = localStorage.getItem('bforge_ui_scale');
      if (saved) return parseFloat(saved);
      if (typeof window !== 'undefined' && window.innerWidth < 1440) return 0.9;
    } catch (_) {}
    return 1.0;
  })(),
  isExportModalOpen: false,
  activePreset: (localStorage.getItem('bforge_active_preset') as any) || 'default',
  openPanelId: null,
  resetLayoutTrigger: 0,
  saveLayoutTrigger: 0,
  restoreSavedLayoutTrigger: 0,
  hasSavedLayout: typeof localStorage !== 'undefined' && localStorage.getItem('bforge_user_saved_layout') !== null,

  // Actions
  setExportModalOpen: (open: boolean) => set({ isExportModalOpen: open }),
  setActivePreset: (preset) => {
    try {
      localStorage.setItem('bforge_active_preset', preset);
    } catch (_) {}
    set({ activePreset: preset });
  },
  requestOpenPanel: (id) => set({ openPanelId: id }),
  requestResetLayout: () => set((state) => ({ resetLayoutTrigger: state.resetLayoutTrigger + 1 })),
  requestSaveLayout: () => set((state) => ({ saveLayoutTrigger: state.saveLayoutTrigger + 1 })),
  requestRestoreSavedLayout: () => set((state) => ({ restoreSavedLayoutTrigger: state.restoreSavedLayoutTrigger + 1 })),
  setHasSavedLayout: (saved) => set({ hasSavedLayout: saved }),
  setUiScale: (scale: number) => {
    const clamped = Math.min(1.5, Math.max(0.7, Math.round(scale * 100) / 100));
    try {
      localStorage.setItem('bforge_ui_scale', clamped.toString());
    } catch (_) {}
    set({ uiScale: clamped });
  },
  connect: async () => {
    // Reach the engine so a real port session starts (serve.rs /api/quick-connect).
    const ok = await engineApi.quickConnect(get().selectedPort, get().baudRate);
    if (ok) {
      set({ isConnected: true, portState: 'open' });
      toast.success('Link opened', `${get().selectedPort} @ ${get().baudRate} baud connected by engine.`);
    } else {
      // Simulated-mode fallback: keep the local link state honest about the engine.
      set({ isConnected: true, portState: 'open' });
      toast.warn(
        'Engine unreachable — simulated link only',
        `${get().selectedPort} is open in the workstation, but no hardware session was started.`
      );
    }
  },

  disconnect: () => {
    set({ isConnected: false, portState: 'closed' });
    // NOTE: serve.rs exposes no disconnect endpoint yet — the engine-side
    // session (if any) keeps running; only the workstation link closes.
    toast.info('Link closed', 'Workstation detached. An engine-side session may still be running.');
  },

  setSelectedPort: (port) => set({ selectedPort: port }),
  setBaudRate: (baudRate) => set({ baudRate }),
  setFraming: (framing) => set({ framing }),
  setDirectionFilter: (directionFilter) => set({ directionFilter }),
  setPortFilter: (portFilter) => set({ portFilter }),
  setErrorsOnly: (errorsOnly) => set({ errorsOnly }),
  rescanPorts: async () => {
    set({ isScanningPorts: true });
    try {
      const devices = await engineApi.getDevices();
      if (devices.length > 0) {
        set({
          availablePorts: devices.map((d) => ({
            id: d.device_path,
            device: d.vid_pid || 'Serial Device',
            description: d.serial ? `S/N ${d.serial}` : 'Hardware port',
          })),
        });
        toast.success('Port scan complete', `${devices.length} hardware port(s) found.`);
      } else {
        toast.warn('No hardware ports found', 'Simulated loopback ports remain available.');
      }
    } finally {
      set({ isScanningPorts: false });
    }
  },
  setUartConfig: (cfg) => {
    set((state) => {
      const updated = {
        dataBits: cfg.dataBits ?? state.dataBits,
        parity: cfg.parity ?? state.parity,
        stopBits: cfg.stopBits ?? state.stopBits,
        delimiterMode: cfg.delimiterMode ?? state.delimiterMode,
        customDelimiterHex: cfg.customDelimiterHex ?? state.customDelimiterHex,
      };
      try {
        localStorage.setItem('bforge_uart_config', JSON.stringify(updated));
      } catch (_) {}
      return {
        ...updated,
        framing: updated.delimiterMode,
      };
    });
  },

  selectPacket: (packet) => {
    set({
      selectedPacket: packet,
      // Default to first field when selecting packet
      selectedField: packet?.dissectedFields?.[0] || null,
    });
  },

  selectField: (field) => set({ selectedField: field }),
  setHoveredField: (field) => {
    // Skip no-op hovers (leave/enter between non-field rows) — without this
    // guard every row hover in the dissector triggers a full-app re-render.
    if (get().hoveredField === field) return;
    set({ hoveredField: field });
  },
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  setFilterText: (filterText) => set({ filterText }),

  setCursorT1: (cursorT1Us) => set({ cursorT1Us }),
  setCursorT2: (cursorT2Us) => set({ cursorT2Us }),

  toggleChannel: (ch) =>
    set((state) => ({
      ch1Visible: ch === 'ch1' ? !state.ch1Visible : state.ch1Visible,
      ch2Visible: ch === 'ch2' ? !state.ch2Visible : state.ch2Visible,
      logicRailsVisible: ch === 'logic' ? !state.logicRailsVisible : state.logicRailsVisible,
    })),

  // Trace binding: seed the series with the field's current reading (if the
  // newest packet carries it) so the lane is never empty until the next frame.
  bindScopeTrace: (field) => {
    const existing = get().traceBindings.find((b) => b.name === field.name);
    if (existing) {
      set({ traceHidden: { ...get().traceHidden, [existing.id]: false } });
      logAction('trace_bind', `${field.name} (already bound, lane unhidden)`);
      return existing.id;
    }
    const id = `trace-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const newest = get().packets[get().packets.length - 1];
    const seedValue = newest
      ? findFieldValue(newest, field.name)
      : null;
    set((state) => ({
      traceBindings: [...state.traceBindings, { id, name: field.name, unit: field.unit }],
      traceSeries: {
        ...state.traceSeries,
        [id]: seedValue !== null ? [{ tUs: newest.timestampUs, value: seedValue }] : [],
      },
      traceHidden: { ...state.traceHidden, [id]: false },
    }));
    logAction('trace_bind', `${field.name} bound to a scope lane`);
    return id;
  },

  unbindScopeTrace: (id) => {
    const binding = get().traceBindings.find((b) => b.id === id);
    set((state) => {
      const { [id]: _removed, ...series } = state.traceSeries;
      const { [id]: _hidden, ...hidden } = state.traceHidden;
      return {
        traceBindings: state.traceBindings.filter((b) => b.id !== id),
        traceSeries: series,
        traceHidden: hidden,
      };
    });
    if (binding) logAction('trace_unbind', `${binding.name} unbound`);
  },

  toggleTraceVisibility: (id) =>
    set((state) => ({
      traceHidden: { ...state.traceHidden, [id]: !state.traceHidden[id] },
    })),

  setDvrLive: () => {
    stopReplayTimer();
    set({ isLive: true, isPaused: false, isReplaying: false, pausedTimestampUs: null, autoScroll: true });
  },

  setDvrPaused: (paused) => {
    if (paused) stopReplayTimer();
    set((state) => ({
      isPaused: paused,
      isLive: !paused,
      isReplaying: false,
      autoScroll: !paused,
      pausedTimestampUs: paused
        ? state.packets[state.packets.length - 1]?.timestampUs || null
        : null,
    }));
  },

  // True replay (spec 2.6): walks the buffered frames from the current scrub
  // position at playbackSpeed, updating stream/hex/scope as it goes. The
  // live capture stays paused for the duration (isPaused remains true).
  startReplay: () => {
    const { packets, selectedPacket } = get();
    if (!packets.length) return;
    const currentIdx = selectedPacket
      ? packets.findIndex((p) => p.seqId === selectedPacket.seqId)
      : -1;
    // Pausing a live stream leaves the cursor on the newest frame — replaying
    // from there would end instantly, so rewind to the buffer start. A cursor
    // left mid-buffer (after scrubbing) resumes from that position.
    replayIdx = currentIdx >= 0 && currentIdx < packets.length - 1 ? currentIdx : 0;
    set({ isPaused: true, isLive: false, isReplaying: true, autoScroll: false });
    logAction('replay_start', `from frame ${replayIdx + 1}/${packets.length}`);
    restartReplayTimer();
  },

  stopReplay: () => {
    stopReplayTimer();
    const wasReplaying = get().isReplaying;
    set({ isReplaying: false });
    if (wasReplaying) logAction('replay_stop');
  },

  seekToTimestamp: (tUs) => {
    stopReplayTimer();
    const { packets } = get();
    // Find closest packet
    let closest: PacketRow | null = null;
    let minDelta = Infinity;
    for (const p of packets) {
      const delta = Math.abs(p.timestampUs - tUs);
      if (delta < minDelta) {
        minDelta = delta;
        closest = p;
      }
    }
    set({
      isLive: false,
      isPaused: true,
      isReplaying: false,
      autoScroll: false,
      selectedPacket: closest,
      selectedField: closest?.dissectedFields?.[0] ?? null,
      pausedTimestampUs: tUs,
    });
    // Workflow B: a scope click is an investigation act — record which frame
    // it landed on, so the activity log explains the selection that follows.
    if (closest) {
      logAction('scope_seek', `frame ${closest.seqId} @ ${closest.timestampUs} µs (Δ${minDelta.toFixed(0)} µs)`);
    }
  },

  stepFrame: (direction) => {
    stopReplayTimer();
    const { packets, selectedPacket } = get();
    if (!packets.length) return;
    const currentIndex = selectedPacket
      ? packets.findIndex((p) => p.seqId === selectedPacket.seqId)
      : packets.length - 1;

    let nextIndex = currentIndex;
    if (direction === 'forward' && currentIndex < packets.length - 1) {
      nextIndex = currentIndex + 1;
    } else if (direction === 'back' && currentIndex > 0) {
      nextIndex = currentIndex - 1;
    }

    const nextPacket = packets[nextIndex];
    if (nextPacket) {
      set({
        selectedPacket: nextPacket,
        selectedField: nextPacket.dissectedFields?.[0] ?? null,
        cursorT1Us: nextPacket.timestampUs,
        isLive: false,
        isPaused: true,
        isReplaying: false,
        pausedTimestampUs: nextPacket.timestampUs,
      });
    }
  },

  setPlaybackSpeed: (speed) => {
    set({ playbackSpeed: speed });
    // Speed chips are live controls during replay.
    if (get().isReplaying) restartReplayTimer();
  },

  triggerFlashYield: (seconds = 30) => {
    // Replace any running yield countdown instead of stacking a second
    // interval that would double-decrement and double-reclaim the port.
    if (yieldTimerId !== null) {
      clearInterval(yieldTimerId);
      yieldTimerId = null;
    }
    set({ isYielded: true, yieldRemainingSecs: seconds, portState: 'yielded' });
    // Tell the engine so session streaming actually pauses on the wire.
    // Fire-and-forget with an honest warning when the engine is offline.
    engineApi
      .yieldPort(get().selectedPort, seconds)
      .then((ok) => {
        if (!ok) {
          toast.warn(
            'Yield not acknowledged by engine',
            `Local countdown running, but the engine did not confirm the ${seconds}s yield on ${get().selectedPort}.`
          );
        }
      });
    yieldTimerId = window.setInterval(() => {
      const { yieldRemainingSecs } = get();
      if (yieldRemainingSecs <= 1) {
        if (yieldTimerId !== null) {
          clearInterval(yieldTimerId);
          yieldTimerId = null;
        }
        get().reclaimPort();
      } else {
        set({ yieldRemainingSecs: yieldRemainingSecs - 1 });
      }
    }, 1000);
  },

  reclaimPort: () => {
    set({ isYielded: false, yieldRemainingSecs: 0, portState: 'open' });
  },

  toggleFaultArm: () => {
    set((state) => ({ isFaultArmed: !state.isFaultArmed }));
  },

  toggleSimulationMode: () => {
    set((state) => ({ isSimulated: !state.isSimulated }));
  },

  clearStream: () => {
    set({ packets: [], scopeSamples: [], selectedPacket: null, selectedField: null });
  },

  loadSampleCapture: () => {
    const samples: PacketRow[] = [];
    const scopePts: ScopeSignalSample[] = [];
    let t = 100000;
    for (let i = 0; i < 30; i++) {
      const injectFault = i === 12; // Inject fault on frame 12
      const pkt = withUniqueSeqId(generateSampleImuPacket('COM8', injectFault, 50000));
      samples.push(pkt);
      scopePts.push(generateScopeSample(pkt.timestampUs));
      t = pkt.timestampUs;
    }
    set({
      packets: samples,
      scopeSamples: scopePts,
      selectedPacket: samples[samples.length - 1],
      selectedField: samples[samples.length - 1]?.dissectedFields[5] || null,
      cursorT1Us: t,
    });
  },

  recordTx: (bytes) => set((state) => ({ txBytes: state.txBytes + bytes })),

  addPacket: (rawPkt) => {
    const pkt = withUniqueSeqId(rawPkt);
    rateTimestamps.push(Date.now());
    if (rateTimestamps.length > 400) rateTimestamps.splice(0, rateTimestamps.length - 400);
    set((state) => {
      // Per-field trace lanes (spec 5.4): feed every bound series whose field
      // this frame carries.
      let traceSeries = state.traceSeries;
      if (state.traceBindings.length) {
        const next: Record<string, Array<{ tUs: number; value: number }>> = { ...traceSeries };
        for (const binding of state.traceBindings) {
          const value = findFieldValue(pkt, binding.name);
          if (value === null) continue;
          const series = [...(next[binding.id] ?? []), { tUs: pkt.timestampUs, value }];
          next[binding.id] =
            series.length > MAX_SCOPE_SAMPLES ? series.slice(series.length - MAX_SCOPE_SAMPLES) : series;
        }
        traceSeries = next;
      }
      const newPackets = state.packets.length >= MAX_PACKETS
        ? [...state.packets.slice(state.packets.length - MAX_PACKETS + 1), pkt]
        : [...state.packets, pkt];

      // Scope data source: synthetic generator in simulation mode, decoded
      // payload fields when frames come from the real engine.
      const scopePt = state.isSimulated
        ? generateScopeSample(pkt.timestampUs)
        : scopeSampleFromPacket(pkt, state.scopeSamples[state.scopeSamples.length - 1] ?? null);
      const newScope = state.scopeSamples.length >= MAX_SCOPE_SAMPLES
        ? [...state.scopeSamples.slice(state.scopeSamples.length - MAX_SCOPE_SAMPLES + 1), scopePt]
        : [...state.scopeSamples, scopePt];

      return {
        packets: newPackets,
        scopeSamples: newScope,
        traceSeries,
        rxBytes: state.rxBytes + pkt.length,
        // Live-follow: keep the highlighted hex/dissector field in sync with
        // the newest frame, matching selectPacket's first-field behavior.
        selectedPacket: state.autoScroll ? pkt : state.selectedPacket,
        selectedField: state.autoScroll ? (pkt.dissectedFields?.[0] ?? null) : state.selectedField,
      };
    });
  },

  addPacketBatch: (batch) => {
    if (!batch.length) return;
    batch = batch.map(withUniqueSeqId);
    const now = Date.now();
    for (let i = 0; i < batch.length; i++) rateTimestamps.push(now);
    if (rateTimestamps.length > 400) rateTimestamps.splice(0, rateTimestamps.length - 400);
    set((state) => {
      let combined = state.packets.concat(batch);
      if (combined.length > MAX_PACKETS) {
        combined = combined.slice(combined.length - MAX_PACKETS);
      }

      // Sample scope points from the newest frames (decoded payloads in HW mode)
      const newestFrames = batch.slice(-10);
      let prevSample = state.scopeSamples[state.scopeSamples.length - 1] ?? null;
      const newScopeSamples = newestFrames.map((p) => {
        const pt = state.isSimulated
          ? generateScopeSample(p.timestampUs)
          : scopeSampleFromPacket(p, prevSample);
        prevSample = pt;
        return pt;
      });

      // Per-field trace lanes from engine batches.
      let traceSeries = state.traceSeries;
      if (state.traceBindings.length) {
        const next: Record<string, Array<{ tUs: number; value: number }>> = { ...traceSeries };
        for (const binding of state.traceBindings) {
          const points = newestFrames
            .map((p) => ({ tUs: p.timestampUs, value: findFieldValue(p, binding.name) }))
            .filter((pt): pt is { tUs: number; value: number } => pt.value !== null);
          if (!points.length) continue;
          const series = [...(next[binding.id] ?? []), ...points];
          next[binding.id] =
            series.length > MAX_SCOPE_SAMPLES ? series.slice(series.length - MAX_SCOPE_SAMPLES) : series;
        }
        traceSeries = next;
      }
      let combinedScope = state.scopeSamples.concat(newScopeSamples);
      if (combinedScope.length > MAX_SCOPE_SAMPLES) {
        combinedScope = combinedScope.slice(combinedScope.length - MAX_SCOPE_SAMPLES);
      }

      const addedBytes = batch.reduce((sum, p) => sum + p.length, 0);
      const lastPkt = batch[batch.length - 1];

      return {
        packets: combined,
        scopeSamples: combinedScope,
        traceSeries,
        rxBytes: state.rxBytes + addedBytes,
        selectedPacket: state.autoScroll ? lastPkt : state.selectedPacket,
        selectedField: state.autoScroll ? (lastPkt.dissectedFields?.[0] ?? null) : state.selectedField,
      };
    });
  },

  updatePins: (pins) => {
    set((state) => ({ pins: { ...state.pins, ...pins } }));
  },

  updateSnapshot: (ports, bridges) => {
    set((state) => ({
      // Real session ports feed the bridge composer's port pickers.
      enginePorts: ports.map((p) => ({ id: p.id, device: p.device })),
      bridges: bridges ?? state.bridges,
    }));
    const active = ports.find((p) => p.id === get().selectedPort) || ports[0];
    if (active) {
      set({
        portState: active.state as any,
        pins: active.pins,
        baudRate: active.baud_rate,
        overruns: active.overruns,
      });
    }
  },

  // Real engine recording state (contract SessionView), consumed by the REC
  // pill: mode 'record' with a vault path means the engine is writing a vault.
  updateSession: (session) => {
    set({
      engineRecording: session.mode === 'record' && session.vault !== '',
      vaultPath: session.vault || get().vaultPath,
      vaultBytes: session.file_bytes,
      vaultChunks: session.chunks,
    });
  },
}));

// DVR replay timer machinery. Declared as hoisted function statements so the
// store actions above can call them before this point in the module.
function stopReplayTimer() {
  if (replayTimerId !== null) {
    window.clearInterval(replayTimerId);
    replayTimerId = null;
  }
}

function restartReplayTimer() {
  stopReplayTimer();
  const speed = Math.max(0.25, useWorkstationStore.getState().playbackSpeed || 1);
  // 1x replays at the live capture cadence (20 frames/s); speed chips scale it.
  const intervalMs = Math.max(25, Math.round(50 / speed));
  replayTimerId = window.setInterval(() => {
    const s = useWorkstationStore.getState();
    if (!s.isReplaying) {
      stopReplayTimer();
      return;
    }
    const { packets } = s;
    if (!packets.length) {
      stopReplayTimer();
      useWorkstationStore.setState({ isReplaying: false });
      return;
    }
    replayIdx += 1;
    if (replayIdx >= packets.length) {
      // End of buffer: halt on the last frame rather than looping.
      replayIdx = packets.length - 1;
      const last = packets[replayIdx];
      stopReplayTimer();
      useWorkstationStore.setState({
        isReplaying: false,
        selectedPacket: last,
        selectedField: last.dissectedFields?.[0] ?? null,
        pausedTimestampUs: last.timestampUs,
      });
      return;
    }
    const pkt = packets[replayIdx];
    useWorkstationStore.setState({
      selectedPacket: pkt,
      selectedField: pkt.dissectedFields?.[0] ?? null,
      pausedTimestampUs: pkt.timestampUs,
    });
  }, intervalMs);
}

// Recompute the footer packet rate once per second from the rolling
// timestamp window. Replaces the previous hardcoded `packetRate: 20`.
if (typeof window !== 'undefined') {
  // Test-harness handle (headless smoke): lets the UI smoke drive panel
  // opens when the layouts menu is timing-flaky under automation.
  (window as any).__bforgeStore = useWorkstationStore;
  setInterval(() => {
    const cutoff = Date.now() - 2000;
    while (rateTimestamps.length > 0 && rateTimestamps[0] < cutoff) rateTimestamps.shift();
    const rate = Math.round(rateTimestamps.length / 2);
    const current = useWorkstationStore.getState().packetRate;
    if (rate !== current) useWorkstationStore.setState({ packetRate: rate });
  }, 1000);
}
