import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import {
  Zap,
  ShieldAlert,
  Play,
  Square,
  RefreshCw,
  Cpu,
  Radio,
  Clock,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  LayoutGrid,
  ChevronDown,
  Check,
  Settings2,
  Save,
  Bookmark,
} from 'lucide-react';
import { UartConfigModal } from './UartConfigModal';

const PANEL_CATALOG = [
  { id: 'packetStream', name: 'Packet Stream (COBS)' },
  { id: 'protocolDissector', name: 'Protocol Dissector' },
  { id: 'hexInspector', name: 'Canonical Hex & ASCII' },
  { id: 'sessionDiff', name: 'Session Diff & Comparison' },
  { id: 'oscilloscope', name: 'Telemetry Oscilloscope' },
  { id: 'commandForge', name: 'Command Forge' },
  { id: 'pinSequencer', name: 'Pin Sequencer & Modem Lines' },
  { id: 'faultRig', name: 'HIL Fault Injection Rig' },
  { id: 'fileTransfer', name: 'X/YMODEM File Transfer' },
  { id: 'elfSymbols', name: 'ELF Symbol & Crash Trace' },
  { id: 'schemaDialects', name: 'Schema Dialects (Proto/MAVLink)' },
];

export const GlobalRibbon: React.FC = () => {
  const {
    isConnected,
    selectedPort,
    baudRate,
    dataBits,
    parity,
    stopBits,
    delimiterMode,
    availablePorts,
    isYielded,
    yieldRemainingSecs,
    isFaultArmed,
    isSimulated,
    isRecording,
    uiScale,
    activePreset,
    connect,
    disconnect,
    setSelectedPort,
    setBaudRate,
    triggerFlashYield,
    reclaimPort,
    toggleFaultArm,
    toggleSimulationMode,
    toggleRecording,
    loadSampleCapture,
    setUiScale,
    setExportModalOpen,
    setActivePreset,
    requestOpenPanel,
    requestResetLayout,
    requestSaveLayout,
    requestRestoreSavedLayout,
    hasSavedLayout,
  } = useWorkstationStore(
    useShallow((s) => ({
      isConnected: s.isConnected,
      selectedPort: s.selectedPort,
      baudRate: s.baudRate,
      dataBits: s.dataBits,
      parity: s.parity,
      stopBits: s.stopBits,
      delimiterMode: s.delimiterMode,
      availablePorts: s.availablePorts,
      isYielded: s.isYielded,
      yieldRemainingSecs: s.yieldRemainingSecs,
      isFaultArmed: s.isFaultArmed,
      isSimulated: s.isSimulated,
      isRecording: s.isRecording,
      uiScale: s.uiScale,
      activePreset: s.activePreset,
      connect: s.connect,
      disconnect: s.disconnect,
      setSelectedPort: s.setSelectedPort,
      setBaudRate: s.setBaudRate,
      triggerFlashYield: s.triggerFlashYield,
      reclaimPort: s.reclaimPort,
      toggleFaultArm: s.toggleFaultArm,
      toggleSimulationMode: s.toggleSimulationMode,
      toggleRecording: s.toggleRecording,
      loadSampleCapture: s.loadSampleCapture,
      setUiScale: s.setUiScale,
      setExportModalOpen: s.setExportModalOpen,
      setActivePreset: s.setActivePreset,
      requestOpenPanel: s.requestOpenPanel,
      requestResetLayout: s.requestResetLayout,
      requestSaveLayout: s.requestSaveLayout,
      requestRestoreSavedLayout: s.requestRestoreSavedLayout,
      hasSavedLayout: s.hasSavedLayout,
    }))
  );

  const [saveSuccessMsg, setSaveSuccessMsg] = useState(false);

  const [isLayoutMenuOpen, setIsLayoutMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isUartModalOpen, setIsUartModalOpen] = useState(false);
  const [uartAnchorRect, setUartAnchorRect] = useState<DOMRect | null>(null);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const portalMenuRef = useRef<HTMLDivElement>(null);
  const uartButtonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        layoutMenuRef.current &&
        !layoutMenuRef.current.contains(target) &&
        portalMenuRef.current &&
        !portalMenuRef.current.contains(target)
      ) {
        setIsLayoutMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleLayoutMenu = () => {
    if (!isLayoutMenuOpen && layoutMenuRef.current) {
      const rect = layoutMenuRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left });
      setIsLayoutMenuOpen(true);
    } else {
      setIsLayoutMenuOpen(false);
    }
  };

  const allBaudRates = [
    9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000, 3000000, 6000000, 12000000,
  ];

  const formatBaud = (b: number) => {
    if (b >= 1000000) return `${(b / 1000000).toFixed(0)}M`;
    if (b >= 1000) return `${(b / 1000).toFixed(1)}k`;
    return `${b}`;
  };

  return (
    <header className="h-[34px] bg-[#10141D] border-b border-[#222D3D] flex items-center justify-between px-2.5 shrink-0 select-none text-[11px] gap-2 relative z-30">
      {/* Left: Brand, Port, Baud & Master Connect */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-1.5 pr-2 border-r border-[#222D3D]">
          <div className="w-2 h-2 rounded-full bg-[#00E5FF] animate-pulse" />
          <span className="font-mono font-bold tracking-wider text-[#00E5FF] text-[12px]">
            BAUDFORGE
          </span>
          <span className="hidden xl:inline text-[9px] text-[#64748B] font-mono px-1 py-0.2 bg-[#161C28] rounded border border-[#222D3D]">
            v1.0
          </span>
        </div>

        {/* Port Selector */}
        <div
          title="Hardware serial port device (e.g. COM8, /dev/ttyUSB0)"
          className="flex items-center gap-1 bg-[#161C28] border border-[#2D3A4E] rounded px-1.5 py-0.5"
        >
          <Cpu className="w-3 h-3 text-[#94A3B8]" />
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            className="bg-transparent text-[#E2E8F0] font-mono text-[11px] focus:outline-none cursor-pointer max-w-[110px] truncate"
          >
            {availablePorts.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#10141D] text-[#E2E8F0]">
                {p.id} ({p.device})
              </option>
            ))}
          </select>
          <button
            title="Rescan hardware ports"
            className="text-[#64748B] hover:text-[#00E5FF] transition-colors p-0.5"
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>

        {/* Baud Rate Compact Dropdown */}
        <div
          title="UART baud rate in bits/second (Standard 115.2k up to 12 Mbps)"
          className="flex items-center gap-1 bg-[#161C28] border border-[#222D3D] rounded px-1.5 py-0.5 font-mono text-[11px]"
        >
          <span className="text-[#64748B] text-[10px]">BAUD:</span>
          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            className="bg-transparent text-[#00E5FF] font-semibold focus:outline-none cursor-pointer"
          >
            {allBaudRates.map((b) => (
              <option key={b} value={b} className="bg-[#10141D] text-[#E2E8F0]">
                {formatBaud(b)} ({b.toLocaleString()})
              </option>
            ))}
          </select>
        </div>

        {/* UART Framing & Delimiter Trigger */}
        <button
          ref={uartButtonRef}
          onClick={() => {
            if (uartButtonRef.current) {
              setUartAnchorRect(uartButtonRef.current.getBoundingClientRect());
            }
            setIsUartModalOpen(true);
          }}
          data-tooltip="Configure UART Line Framing (Data, Parity, Stop bits) and Delimiter / Packet Slicer"
          className="flex items-center gap-1 bg-[#161C28] hover:bg-[#1E293B] border border-[#222D3D] hover:border-[#00E5FF]/40 rounded px-1.5 py-0.5 font-mono text-[11px] text-[#94A3B8] hover:text-[#00E5FF] transition-colors"
        >
          <Settings2 className="w-2.5 h-2.5 text-[#00E5FF]" />
          <span className="font-bold text-[#E2E8F0]">
            {dataBits}{parity.charAt(0).toUpperCase()}{stopBits}
          </span>
          <span className="text-[#64748B] text-[9.5px]">·</span>
          <span className="text-[#00E5FF] uppercase font-semibold text-[10px]">
            {delimiterMode}
          </span>
        </button>

        {/* Master Connect / Disconnect */}
        <button
          onClick={isConnected ? disconnect : connect}
          title={
            isConnected
              ? 'Close active serial port and halt stream ingestion'
              : 'Open selected serial port at specified baud rate'
          }
          className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-semibold transition-all ${
            isConnected
              ? 'bg-[#EF4444]/20 border border-[#EF4444] text-[#EF4444] hover:bg-[#EF4444]/30'
              : 'bg-[#10B981] text-[#0A0D13] hover:bg-[#059669]'
          }`}
        >
          {isConnected ? (
            <>
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>DISCONNECT</span>
            </>
          ) : (
            <>
              <Play className="w-2.5 h-2.5 fill-current" />
              <span>CONNECT</span>
            </>
          )}
        </button>
      </div>

      {/* Center: Layout Presets & Panel Catalog Menu */}
      <div className="relative flex items-center" ref={layoutMenuRef}>
        <button
          onClick={toggleLayoutMenu}
          data-tooltip="Switch workbench layout presets or re-open closed docked panels"
          className="flex items-center gap-1.5 px-2 py-0.5 bg-[#161C28] hover:bg-[#1E2638] border border-[#222D3D] hover:border-[#00E5FF] rounded text-[10.5px] font-mono text-[#E2E8F0] transition-colors"
        >
          <LayoutGrid className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-semibold">LAYOUTS & PANELS</span>
          <ChevronDown className="w-2.5 h-2.5 text-[#64748B]" />
        </button>

        {isLayoutMenuOpen &&
          menuPos &&
          createPortal(
            <div
              ref={portalMenuRef}
              style={{
                position: 'fixed',
                top: `${menuPos.top}px`,
                left: `${menuPos.left}px`,
                zIndex: 999999,
              }}
              className="w-72 bg-[#0E131F] border border-[#222D3D] rounded-lg shadow-[0_16px_48px_rgba(0,0,0,0.95)] p-2.5 font-mono text-[10.5px] text-[#E2E8F0] flex flex-col gap-1"
            >
              <div className="text-[9.5px] uppercase tracking-wider text-[#64748B] px-2 py-0.5 font-bold">
                Layout Presets
              </div>

              {[
                { id: 'default', name: 'Default CAD Workbench', desc: 'Stream + Dissector + Scope + Tools' },
                { id: 'dissector', name: 'Dissector & Schemas Focus', desc: 'Wide dissector, hex, schemas & symbols' },
                { id: 'scope', name: 'Telemetry Oscilloscope Focus', desc: 'Maximized analog DSO and logic analyzer' },
                { id: 'hil', name: 'HIL & Hardware Rig', desc: 'Stream + Fault rig + Pins + Transfers' },
              ].map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setActivePreset(p.id as any);
                    setIsLayoutMenuOpen(false);
                  }}
                  className={`flex items-start justify-between gap-1 px-2 py-1 rounded text-left transition-colors ${
                    activePreset === p.id
                      ? 'bg-[#00E5FF]/15 text-[#00E5FF] font-bold'
                      : 'hover:bg-[#161C28] text-[#94A3B8] hover:text-[#E2E8F0]'
                  }`}
                >
                  <div>
                    <div className="text-[10px] text-[#F8FAFC]">{p.name}</div>
                    <div className="text-[8.5px] text-[#64748B]">{p.desc}</div>
                  </div>
                  {activePreset === p.id && <Check className="w-3 h-3 text-[#00E5FF] mt-0.5 shrink-0" />}
                </button>
              ))}

              <div className="border-t border-[#222D3D] my-1" />

              <div className="text-[9.5px] uppercase tracking-wider text-[#64748B] px-2 py-0.5 font-bold">
                Re-open Closed Panel
              </div>

              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {PANEL_CATALOG.map((panel) => (
                  <button
                    key={panel.id}
                    onClick={() => {
                      requestOpenPanel(panel.id);
                      setIsLayoutMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2 py-1 rounded text-left text-[10px] text-[#94A3B8] hover:text-[#00E5FF] hover:bg-[#161C28] transition-colors"
                  >
                    <span>{panel.name}</span>
                    <span className="text-[9px] text-[#64748B] font-mono">OPEN</span>
                  </button>
                ))}
              </div>

              <div className="border-t border-[#222D3D] my-1" />

              <div className="text-[9.5px] uppercase tracking-wider text-[#64748B] px-2 py-0.5 font-bold">
                Layout Management
              </div>

              <div className="flex flex-col gap-1">
                <button
                  onClick={() => {
                    requestSaveLayout();
                    setSaveSuccessMsg(true);
                    setTimeout(() => setSaveSuccessMsg(false), 2200);
                  }}
                  data-tooltip="Save current workstation panel layout, tab order, and sizes"
                  className="w-full flex items-center justify-between px-2 py-1 bg-[#161C28] hover:bg-[#1E2638] text-[#00E5FF] rounded text-[10px] transition-colors font-bold"
                >
                  <div className="flex items-center gap-1.5">
                    <Save className="w-3 h-3" />
                    <span>{saveSuccessMsg ? '✓ Layout Saved!' : 'Save Current Layout'}</span>
                  </div>
                  <span className="text-[8.5px] text-[#64748B]">CUSTOM</span>
                </button>

                {hasSavedLayout && (
                  <button
                    onClick={() => {
                      requestRestoreSavedLayout();
                      setIsLayoutMenuOpen(false);
                    }}
                    data-tooltip="Restore previously saved custom workstation layout"
                    className="w-full flex items-center justify-between px-2 py-1 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] hover:text-[#E2E8F0] rounded text-[10px] transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      <Bookmark className="w-3 h-3 text-[#00E5FF]" />
                      <span>Restore Saved Layout</span>
                    </div>
                    <span className="text-[8.5px] text-[#64748B]">SAVED</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    requestResetLayout();
                    setIsLayoutMenuOpen(false);
                  }}
                  data-tooltip="Reset workstation layout to canonical factory default"
                  className="w-full flex items-center justify-between px-2 py-1 bg-[#161C28] hover:bg-[#1E2638] text-[#F59E0B] rounded text-[10px] transition-colors font-bold"
                >
                  <div className="flex items-center gap-1.5">
                    <RotateCcw className="w-3 h-3" />
                    <span>Set to Default Layout</span>
                  </div>
                  <span className="text-[8.5px] text-[#F59E0B]/70">FACTORY</span>
                </button>
              </div>
            </div>,
            document.body
          )}
      </div>

      {/* Right: Signature Workflows, Zoom & Export */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* UI Zoom Controls */}
        <div
          title="Adjust display scaling ratio for different monitor sizes (Ctrl + / Ctrl - / Ctrl 0)"
          className="flex items-center bg-[#161C28] border border-[#222D3D] rounded px-1 py-0.5 text-[10px] font-mono text-[#94A3B8]"
        >
          <button
            onClick={() => setUiScale(uiScale - 0.05)}
            title="Zoom Out (Ctrl -)"
            className="p-0.5 hover:text-[#00E5FF] transition-colors"
          >
            <ZoomOut className="w-3 h-3" />
          </button>
          <button
            onClick={() => setUiScale(1.0)}
            title="Reset Zoom to 100% (Ctrl 0)"
            className="px-1 text-[10px] hover:text-[#00E5FF] transition-colors"
          >
            {Math.round(uiScale * 100)}%
          </button>
          <button
            onClick={() => setUiScale(uiScale + 0.05)}
            title="Zoom In (Ctrl +)"
            className="p-0.5 hover:text-[#00E5FF] transition-colors"
          >
            <ZoomIn className="w-3 h-3" />
          </button>
          {uiScale !== 1.0 && (
            <button
              onClick={() => setUiScale(1.0)}
              title="Reset Zoom"
              className="ml-0.5 text-[#64748B] hover:text-[#00E5FF]"
            >
              <RotateCcw className="w-2.5 h-2.5" />
            </button>
          )}
        </div>

        {/* Flash-Yield Button / Countdown Banner */}
        {isYielded ? (
          <div className="flex items-center gap-1.5 bg-[#F59E0B]/20 border border-[#F59E0B] text-[#F59E0B] px-2 py-0.5 rounded animate-pulse">
            <Clock className="w-3 h-3" />
            <span className="font-mono font-bold text-[10px]">
              YIELD ({yieldRemainingSecs}s)
            </span>
            <button
              onClick={reclaimPort}
              title="Reclaim serial handle immediately"
              className="px-1 py-0.2 bg-[#F59E0B] text-[#0A0D13] font-bold text-[9px] rounded hover:bg-[#D97706]"
            >
              RECLAIM
            </button>
          </div>
        ) : (
          <button
            onClick={() => triggerFlashYield(30)}
            title="Surrender COM port handle for external programmer/IDE (Ctrl+Shift+Y). Does not drop session capture history."
            className="flex items-center gap-1 px-2 py-0.5 bg-[#161C28] border border-[#F59E0B]/40 text-[#F59E0B] rounded hover:bg-[#F59E0B]/10 transition-colors"
          >
            <Zap className="w-3 h-3" />
            <span className="font-mono text-[10px] hidden md:inline">YIELD</span>
          </button>
        )}

        {/* HIL Fault Injection Master Arm */}
        <button
          onClick={toggleFaultArm}
          title={
            isFaultArmed
              ? 'Disarm fault injection interlock and restore clean serial wire'
              : 'Arm hardware fault injection rig: Corrupt bits, drop frames, or delay bytes'
          }
          className={`flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] transition-all ${
            isFaultArmed
              ? 'bg-[#EF4444] text-white font-bold animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]'
              : 'bg-[#161C28] border border-[#EF4444]/50 text-[#EF4444] hover:bg-[#EF4444]/10'
          }`}
        >
          <ShieldAlert className="w-3 h-3" />
          <span className="hidden sm:inline">{isFaultArmed ? 'ARMED' : 'FAULT'}</span>
        </button>

        {/* Simulated Target Mode Toggle */}
        <button
          onClick={toggleSimulationMode}
          title={
            isSimulated
              ? 'Running Simulated Loopback. Click to connect physical hardware'
              : 'Running Physical Hardware. Click to enable simulated loopback'
          }
          className={`flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] transition-colors ${
            isSimulated
              ? 'bg-[#26324A] border border-[#00E5FF] text-[#00E5FF]'
              : 'bg-[#161C28] border border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
          }`}
        >
          <Radio className="w-3 h-3" />
          <span className="hidden lg:inline">{isSimulated ? 'SIM' : 'HW'}</span>
        </button>

        {/* Load Sample Capture button */}
        <button
          onClick={loadSampleCapture}
          title="Load demonstration telemetry capture stream (50 sample frames)"
          className="hidden xl:inline-block px-1.5 py-0.5 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] hover:text-[#E2E8F0] border border-[#222D3D] rounded text-[10px] font-mono"
        >
          DEMO
        </button>

        {/* Session Vault Recording Button */}
        <button
          onClick={toggleRecording}
          title={
            isRecording
              ? 'Recording active: saving every raw serial record to append-only binary .bflog'
              : 'Record raw session to append-only binary .bflog'
          }
          className={`flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] transition-colors ${
            isRecording
              ? 'bg-[#EF4444] text-white font-bold animate-pulse'
              : 'bg-[#161C28] border border-[#222D3D] text-[#94A3B8] hover:text-[#E2E8F0]'
          }`}
        >
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isRecording ? 'bg-white' : 'bg-[#EF4444]'
            }`}
          />
          <span className="hidden sm:inline">{isRecording ? 'REC' : 'REC'}</span>
        </button>

        {/* Multi-Format Vault Export Dialog */}
        <button
          onClick={() => setExportModalOpen(true)}
          title="Export session vault to Wireshark PCAP-NG, Saleae Logic CSV, or Streaming NDJSON"
          className="flex items-center gap-1 px-2 py-0.5 bg-[#161C28] hover:bg-[#1E2638] text-[#00E5FF] hover:text-[#38BDF8] border border-[#00E5FF]/40 rounded font-mono text-[10px] transition-colors shadow-[0_0_8px_rgba(0,229,255,0.15)]"
        >
          <Download className="w-3 h-3" />
          <span className="hidden sm:inline font-bold">EXPORT</span>
        </button>
      </div>

      <UartConfigModal
        isOpen={isUartModalOpen}
        onClose={() => setIsUartModalOpen(false)}
        anchorRect={uartAnchorRect}
      />
    </header>
  );
};
