import { create } from 'zustand';
import { PacketRow, DissectedField, ScopeSignalSample, PinsView, PortView } from '../types';
import { generateSampleImuPacket, generateScopeSample } from '../services/simulationEngine';

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
  pins: PinsView;

  // Stream & Dissector
  packets: PacketRow[];
  selectedPacket: PacketRow | null;
  selectedField: DissectedField | null;
  hoveredField: DissectedField | null;
  autoScroll: boolean;
  filterText: string;

  // Oscilloscope & Telemetry
  scopeSamples: ScopeSignalSample[];
  cursorT1Us: number | null;
  cursorT2Us: number | null;
  ch1Visible: boolean;
  ch2Visible: boolean;
  logicRailsVisible: boolean;

  // DVR Timeline
  isLive: boolean;
  isPaused: boolean;
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
  isRecording: boolean;
  vaultPath: string;
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
  connect: () => void;
  disconnect: () => void;
  setSelectedPort: (port: string) => void;
  setBaudRate: (baud: number) => void;
  setFraming: (framing: string) => void;
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
  setDvrLive: () => void;
  setDvrPaused: (val: boolean) => void;
  seekToTimestamp: (tUs: number) => void;
  stepFrame: (direction: 'forward' | 'back') => void;
  setPlaybackSpeed: (speed: number) => void;
  triggerFlashYield: (seconds?: number) => void;
  reclaimPort: () => void;
  toggleFaultArm: () => void;
  toggleSimulationMode: () => void;
  toggleRecording: () => void;
  clearStream: () => void;
  loadSampleCapture: () => void;
  recordTx: (bytes: number) => void;
  addPacket: (pkt: PacketRow) => void;
  addPacketBatch: (pkts: PacketRow[]) => void;
  updatePins: (pins: Partial<PinsView>) => void;
  updateSnapshot: (ports: PortView[]) => void;
}

const MAX_PACKETS = 10000;
const MAX_SCOPE_SAMPLES = 600;

// Live packet-rate metering: timestamps of recently added packets, sampled
// once per second. Kept outside the reactive state — only the computed rate
// is written to the store so subscribers re-render at 1 Hz, not per packet.
const rateTimestamps: number[] = [];
let yieldTimerId: number | null = null;

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

  // Oscilloscope
  scopeSamples: [],
  cursorT1Us: null,
  cursorT2Us: null,
  ch1Visible: true,
  ch2Visible: true,
  logicRailsVisible: true,

  // DVR Timeline
  isLive: true,
  isPaused: false,
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
  isRecording: false,
  vaultPath: 'vaults/session_001.bflog',
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
  connect: () => {
    set({ isConnected: true, portState: 'open' });
  },

  disconnect: () => {
    set({ isConnected: false, portState: 'closed' });
  },

  setSelectedPort: (port) => set({ selectedPort: port }),
  setBaudRate: (baudRate) => set({ baudRate }),
  setFraming: (framing) => set({ framing }),
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

  setDvrLive: () => {
    set({ isLive: true, isPaused: false, pausedTimestampUs: null, autoScroll: true });
  },

  setDvrPaused: (paused) => {
    set((state) => ({
      isPaused: paused,
      isLive: !paused,
      autoScroll: !paused,
      pausedTimestampUs: paused
        ? state.packets[state.packets.length - 1]?.timestampUs || null
        : null,
    }));
  },

  seekToTimestamp: (tUs) => {
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
      autoScroll: false,
      selectedPacket: closest,
      pausedTimestampUs: tUs,
    });
  },

  stepFrame: (direction) => {
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
        cursorT1Us: nextPacket.timestampUs,
        isLive: false,
        isPaused: true,
        pausedTimestampUs: nextPacket.timestampUs,
      });
    }
  },

  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  triggerFlashYield: (seconds = 30) => {
    // Replace any running yield countdown instead of stacking a second
    // interval that would double-decrement and double-reclaim the port.
    if (yieldTimerId !== null) {
      clearInterval(yieldTimerId);
      yieldTimerId = null;
    }
    set({ isYielded: true, yieldRemainingSecs: seconds, portState: 'yielded' });
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

  toggleRecording: () => {
    set((state) => ({ isRecording: !state.isRecording }));
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
      const pkt = generateSampleImuPacket('COM8', injectFault, 50000);
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

  addPacket: (pkt) => {
    rateTimestamps.push(Date.now());
    if (rateTimestamps.length > 400) rateTimestamps.splice(0, rateTimestamps.length - 400);
    set((state) => {
      const newPackets = state.packets.length >= MAX_PACKETS
        ? [...state.packets.slice(state.packets.length - MAX_PACKETS + 1), pkt]
        : [...state.packets, pkt];

      const scopePt = generateScopeSample(pkt.timestampUs);
      const newScope = state.scopeSamples.length >= MAX_SCOPE_SAMPLES
        ? [...state.scopeSamples.slice(state.scopeSamples.length - MAX_SCOPE_SAMPLES + 1), scopePt]
        : [...state.scopeSamples, scopePt];

      return {
        packets: newPackets,
        scopeSamples: newScope,
        rxBytes: state.rxBytes + pkt.length,
        selectedPacket: state.autoScroll ? pkt : state.selectedPacket,
      };
    });
  },

  addPacketBatch: (batch) => {
    if (!batch.length) return;
    const now = Date.now();
    for (let i = 0; i < batch.length; i++) rateTimestamps.push(now);
    if (rateTimestamps.length > 400) rateTimestamps.splice(0, rateTimestamps.length - 400);
    set((state) => {
      let combined = state.packets.concat(batch);
      if (combined.length > MAX_PACKETS) {
        combined = combined.slice(combined.length - MAX_PACKETS);
      }

      // Sample scope points from the newest frames
      const newestFrames = batch.slice(-10);
      const newScopeSamples = newestFrames.map((p) => generateScopeSample(p.timestampUs));
      let combinedScope = state.scopeSamples.concat(newScopeSamples);
      if (combinedScope.length > MAX_SCOPE_SAMPLES) {
        combinedScope = combinedScope.slice(combinedScope.length - MAX_SCOPE_SAMPLES);
      }

      const addedBytes = batch.reduce((sum, p) => sum + p.length, 0);
      const lastPkt = batch[batch.length - 1];

      return {
        packets: combined,
        scopeSamples: combinedScope,
        rxBytes: state.rxBytes + addedBytes,
        selectedPacket: state.autoScroll ? lastPkt : state.selectedPacket,
      };
    });
  },

  updatePins: (pins) => {
    set((state) => ({ pins: { ...state.pins, ...pins } }));
  },

  updateSnapshot: (ports) => {
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
}));

// Recompute the footer packet rate once per second from the rolling
// timestamp window. Replaces the previous hardcoded `packetRate: 20`.
if (typeof window !== 'undefined') {
  setInterval(() => {
    const cutoff = Date.now() - 2000;
    while (rateTimestamps.length > 0 && rateTimestamps[0] < cutoff) rateTimestamps.shift();
    const rate = Math.round(rateTimestamps.length / 2);
    const current = useWorkstationStore.getState().packetRate;
    if (rate !== current) useWorkstationStore.setState({ packetRate: rate });
  }, 1000);
}
