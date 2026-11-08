import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useSettingsStore, buildVaultPath } from '../store/useSettingsStore';
import { useToastStore } from '../store/useToastStore';
import { useLayoutLibraryStore } from '../store/useLayoutLibraryStore';
import { engineApi } from '../services/engineApi';
import {
  Zap,
  ShieldAlert,
  Play,
  Square,
  RefreshCw,
  Cpu,
  Radio,
  Clock,
  RotateCcw,
  Download,
  LayoutGrid,
  ChevronDown,
  Check,
  Settings2,
  Settings,
  Save,
  Star,
  Trash2,
  X,
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
  { id: 'bridge', name: 'MITM Bridge & Relay' },
  { id: 'activityLog', name: 'Activity Log' },
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
    engineRecording,
    vaultPath,
    vaultBytes,
    isScanningPorts,
    rescanPorts,
    activePreset,
    connect,
    disconnect,
    setSelectedPort,
    setBaudRate,
    triggerFlashYield,
    reclaimPort,
    toggleFaultArm,
    toggleSimulationMode,
    loadSampleCapture,
    setExportModalOpen,
    setActivePreset,
    requestOpenPanel,
    requestResetLayout,
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
      engineRecording: s.engineRecording,
      vaultPath: s.vaultPath,
      vaultBytes: s.vaultBytes,
      isScanningPorts: s.isScanningPorts,
      rescanPorts: s.rescanPorts,
      activePreset: s.activePreset,
      connect: s.connect,
      disconnect: s.disconnect,
      setSelectedPort: s.setSelectedPort,
      setBaudRate: s.setBaudRate,
      triggerFlashYield: s.triggerFlashYield,
      reclaimPort: s.reclaimPort,
      toggleFaultArm: s.toggleFaultArm,
      toggleSimulationMode: s.toggleSimulationMode,
      loadSampleCapture: s.loadSampleCapture,
      setExportModalOpen: s.setExportModalOpen,
      setActivePreset: s.setActivePreset,
      requestOpenPanel: s.requestOpenPanel,
      requestResetLayout: s.requestResetLayout,
    }))
  );

  // Named layout library (see useLayoutLibraryStore): the menu drives the
  // requests, the dock — which owns the DockviewApi — performs save/load.
  const layouts = useLayoutLibraryStore((s) => s.layouts);
  const defaultLayout = useLayoutLibraryStore((s) => s.defaultLayout);
  const lastLayoutName = useLayoutLibraryStore((s) => s.lastLayoutName);
  const requestSaveLayoutAs = useLayoutLibraryStore((s) => s.requestSaveLayoutAs);
  const requestLoadLayout = useLayoutLibraryStore((s) => s.requestLoadLayout);
  const deleteLayout = useLayoutLibraryStore((s) => s.deleteLayout);
  const setDefaultLayout = useLayoutLibraryStore((s) => s.setDefaultLayout);

  const [recPending, setRecPending] = useState(false);
  const [isCustomBaud, setIsCustomBaud] = useState(false);
  const [customBaudDraft, setCustomBaudDraft] = useState('115200');
  const pushToast = useToastStore((s) => s.pushToast);

  const formatVaultBytes = (bytes: number) => {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const [isLayoutMenuOpen, setIsLayoutMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isUartModalOpen, setIsUartModalOpen] = useState(false);
  const [uartAnchorRect, setUartAnchorRect] = useState<DOMRect | null>(null);
  const [isSaveNameOpen, setIsSaveNameOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState('');
  // Two-click delete: first click arms, second within the window confirms.
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const portalMenuRef = useRef<HTMLDivElement>(null);
  const uartButtonRef = useRef<HTMLButtonElement>(null);

  const savedLayoutRows = Object.entries(layouts).sort((a, b) => b[1].savedAt - a[1].savedAt);

  const formatLayoutDate = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const submitLayoutSave = () => {
    if (!requestSaveLayoutAs(saveNameDraft)) {
      pushToast('error', 'Layout name required', 'Enter a name for the saved layout.');
      return;
    }
    setIsSaveNameOpen(false);
    setIsLayoutMenuOpen(false);
  };

  const handleDeleteLayout = (name: string) => {
    if (deleteArm === name) {
      deleteLayout(name);
      setDeleteArm(null);
      pushToast('info', 'Layout deleted', `“${name}” removed from the library.`);
    } else {
      setDeleteArm(name);
      setTimeout(() => setDeleteArm((cur) => (cur === name ? null : cur)), 2500);
    }
  };

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
      setIsSaveNameOpen(false);
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
    <header className="h-[34px] bg-bf-panel border-b border-bf-line flex items-center justify-between px-2.5 shrink-0 select-none text-[11px] gap-2 relative z-30">
      {/* Left: Brand, Port, Baud & Master Connect */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-1.5 pr-2 border-r border-bf-line">
          <div className="w-2 h-2 rounded-full bg-bf-cyan animate-pulse" />
          <span className="font-mono font-bold tracking-wider text-bf-cyan text-[12px]">
            BAUDFORGE
          </span>
          <span className="hidden xl:inline text-[9px] text-bf-faint font-mono px-1 py-0.2 bg-bf-subpanel rounded border border-bf-line">
            v1.0
          </span>
        </div>

        {/* Port Selector */}
        <div
          title="Hardware serial port device (e.g. COM8, /dev/ttyUSB0)"
          className="flex items-center gap-1 bg-bf-subpanel border border-bf-line-strong rounded px-1.5 py-0.5"
        >
          <Cpu className="w-3 h-3 text-bf-mute" />
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            className="bg-transparent text-bf-body font-mono text-[11px] focus:outline-none cursor-pointer max-w-[110px] truncate"
          >
            {availablePorts.map((p) => (
              <option key={p.id} value={p.id} className="bg-bf-panel text-bf-body">
                {p.id} ({p.device})
              </option>
            ))}
          </select>
          <button
            title="Rescan hardware ports"
            onClick={() => {
              void rescanPorts();
            }}
            disabled={isScanningPorts}
            className={`transition-colors p-0.5 ${
              isScanningPorts
                ? 'text-bf-cyan animate-spin'
                : 'text-bf-faint hover:text-bf-cyan'
            }`}
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>

        {/* Baud Rate Compact Dropdown */}
        <div
          title="UART baud rate in bits/second (Standard 115.2k up to 12 Mbps)"
          className="flex items-center gap-1 bg-bf-subpanel border border-bf-line rounded px-1.5 py-0.5 font-mono text-[11px]"
        >
          <span className="text-bf-faint text-[10px]">BAUD:</span>
          {isCustomBaud ? (
            <input
              autoFocus
              type="number"
              min={110}
              max={12000000}
              value={customBaudDraft}
              onChange={(e) => setCustomBaudDraft(e.target.value)}
              onBlur={() => {
                const value = parseInt(customBaudDraft, 10);
                if (!isNaN(value) && value >= 110 && value <= 12000000) {
                  setBaudRate(value);
                } else {
                  pushToast('error', 'Invalid baud rate', 'Enter a rate between 110 and 12,000,000.');
                }
                setIsCustomBaud(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setIsCustomBaud(false);
              }}
              title="Custom baud rate: 110 to 12,000,000 (Enter to apply, Esc to cancel)"
              className="w-[70px] bg-bf-panel border border-bf-cyan/60 rounded px-1 text-bf-cyan font-semibold focus:outline-none"
            />
          ) : (
            <select
              value={allBaudRates.includes(baudRate) ? baudRate : 'custom'}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setCustomBaudDraft(String(baudRate));
                  setIsCustomBaud(true);
                } else {
                  setBaudRate(Number(e.target.value));
                }
              }}
              className="bg-transparent text-bf-cyan font-semibold focus:outline-none cursor-pointer"
            >
              {allBaudRates.map((b) => (
                <option key={b} value={b} className="bg-bf-panel text-bf-body">
                  {formatBaud(b)} ({b.toLocaleString()})
                </option>
              ))}
              <option value="custom" className="bg-bf-panel text-bf-body">
                Custom…
              </option>
            </select>
          )}
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
          className="flex items-center gap-1 bg-bf-subpanel hover:bg-bf-btn border border-bf-line hover:border-bf-cyan/40 rounded px-1.5 py-0.5 font-mono text-[11px] text-bf-mute hover:text-bf-cyan transition-colors"
        >
          <Settings2 className="w-2.5 h-2.5 text-bf-cyan" />
          <span className="font-bold text-bf-body">
            {dataBits}{parity.charAt(0).toUpperCase()}{stopBits}
          </span>
          <span className="text-bf-faint text-[9.5px]">·</span>
          <span className="text-bf-cyan uppercase font-semibold text-[10px]">
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
              ? 'bg-bf-fault/20 border border-bf-fault text-bf-fault hover:bg-bf-fault/30'
              : 'bg-bf-ok text-bf-onfill hover:bg-bf-ok-hi'
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
          data-tooltip="Switch workbench layout presets, re-open closed panels, or manage saved layouts"
          className="flex items-center gap-1.5 px-2 py-0.5 bg-bf-subpanel hover:bg-bf-hover border border-bf-line hover:border-bf-cyan rounded text-[10.5px] font-mono text-bf-body transition-colors"
        >
          <LayoutGrid className="w-3 h-3 text-bf-cyan" />
          <span className="font-semibold">LAYOUTS & PANELS</span>
          <ChevronDown className="w-2.5 h-2.5 text-bf-faint" />
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
              className="w-72 bg-bf-surface border border-bf-line rounded-lg shadow-[0_16px_48px_rgb(var(--bf-shadow-rgb)/0.95)] p-2.5 font-mono text-[10.5px] text-bf-body flex flex-col gap-1"
            >
              <div className="text-[9.5px] uppercase tracking-wider text-bf-faint px-2 py-0.5 font-bold">
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
                      ? 'bg-bf-cyan/15 text-bf-cyan font-bold'
                      : 'hover:bg-bf-subpanel text-bf-mute hover:text-bf-body'
                  }`}
                >
                  <div>
                    <div className="text-[10px] text-bf-bright">{p.name}</div>
                    <div className="text-[8.5px] text-bf-faint">{p.desc}</div>
                  </div>
                  {activePreset === p.id && <Check className="w-3 h-3 text-bf-cyan mt-0.5 shrink-0" />}
                </button>
              ))}

              <div className="border-t border-bf-line my-1" />

              <div className="text-[9.5px] uppercase tracking-wider text-bf-faint px-2 py-0.5 font-bold">
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
                    className="w-full flex items-center justify-between px-2 py-1 rounded text-left text-[10px] text-bf-mute hover:text-bf-cyan hover:bg-bf-subpanel transition-colors"
                  >
                    <span>{panel.name}</span>
                    <span className="text-[9px] text-bf-faint font-mono">OPEN</span>
                  </button>
                ))}
              </div>

              <div className="border-t border-bf-line my-1" />

              <div className="text-[9.5px] uppercase tracking-wider text-bf-faint px-2 py-0.5 font-bold">
                Layout Management
              </div>

              <div className="flex flex-col gap-1">
                {!isSaveNameOpen ? (
                  <button
                    onClick={() => {
                      setSaveNameDraft(lastLayoutName);
                      setIsSaveNameOpen(true);
                    }}
                    data-tooltip="Save the current panel arrangement, tab order, and sizes under a name"
                    className="w-full flex items-center justify-between px-2 py-1 bg-bf-subpanel hover:bg-bf-hover text-bf-cyan rounded text-[10px] transition-colors font-bold"
                  >
                    <div className="flex items-center gap-1.5">
                      <Save className="w-3 h-3" />
                      <span>Save Current Layout…</span>
                    </div>
                    <span className="text-[8.5px] text-bf-faint">CUSTOM</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1 bg-bf-panel border border-bf-cyan/60 rounded px-1.5 py-1">
                    <input
                      autoFocus
                      value={saveNameDraft}
                      maxLength={40}
                      placeholder="Layout name"
                      onChange={(e) => setSaveNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitLayoutSave();
                        if (e.key === 'Escape') setIsSaveNameOpen(false);
                      }}
                      title="Name for this saved layout (Enter to save, Esc to cancel)"
                      className="flex-1 min-w-0 bg-transparent text-bf-cyan font-mono text-[10px] placeholder-bf-faint focus:outline-none"
                    />
                    <button
                      onClick={submitLayoutSave}
                      title="Save layout"
                      className="px-1.5 py-0.5 bg-bf-cyan text-bf-onfill font-bold text-[9px] rounded hover:bg-bf-sky shrink-0"
                    >
                      SAVE
                    </button>
                    <button
                      onClick={() => setIsSaveNameOpen(false)}
                      title="Cancel"
                      className="text-bf-faint hover:text-bf-fault shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {savedLayoutRows.length > 0 && (
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    {savedLayoutRows.map(([name, entry]) => {
                      const isDefault = defaultLayout === name;
                      return (
                        <div
                          key={name}
                          className={`flex items-center gap-1 px-1.5 py-1 rounded transition-colors ${
                            isDefault ? 'bg-bf-cyan/10' : 'bg-bf-subpanel hover:bg-bf-hover'
                          }`}
                        >
                          <button
                            onClick={() => {
                              requestLoadLayout(name);
                              setIsLayoutMenuOpen(false);
                            }}
                            title={`Load “${name}”`}
                            className="flex-1 min-w-0 text-left"
                          >
                            <div
                              className={`flex items-center gap-1 text-[10px] ${
                                isDefault ? 'text-bf-cyan font-bold' : 'text-bf-body'
                              }`}
                            >
                              <span className="truncate">{name}</span>
                              {isDefault && (
                                <span className="text-[7.5px] px-1 rounded bg-bf-cyan text-bf-onfill font-bold shrink-0">
                                  DEFAULT
                                </span>
                              )}
                            </div>
                            <div className="text-[8px] text-bf-faint">
                              {formatLayoutDate(entry.savedAt)} ·{' '}
                              {Object.keys((entry.data as any)?.panels ?? {}).length} panels
                            </div>
                          </button>
                          <button
                            onClick={() => {
                              const next = isDefault ? null : name;
                              setDefaultLayout(next);
                              pushToast(
                                next ? 'success' : 'info',
                                next ? 'Startup default set' : 'Startup default cleared',
                                next
                                  ? `“${name}” loads every time BaudForge starts.`
                                  : 'Startup reverts to the last session arrangement.'
                              );
                            }}
                            title={isDefault ? 'Clear startup default' : 'Load this layout on startup'}
                            className={`p-0.5 rounded transition-colors shrink-0 ${
                              isDefault ? 'text-bf-cyan' : 'text-bf-ghost hover:text-bf-cyan'
                            }`}
                          >
                            <Star className="w-3 h-3" fill={isDefault ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            onClick={() => handleDeleteLayout(name)}
                            title={deleteArm === name ? 'Click again to confirm delete' : 'Delete layout'}
                            className={`p-0.5 rounded transition-colors shrink-0 ${
                              deleteArm === name
                                ? 'text-bf-fault bg-bf-fault/15'
                                : 'text-bf-ghost hover:text-bf-fault'
                            }`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <button
                  onClick={() => {
                    requestResetLayout();
                    setIsLayoutMenuOpen(false);
                  }}
                  data-tooltip="Rebuild the canonical factory layout — your named saved layouts are kept"
                  className="w-full flex items-center justify-between px-2 py-1 bg-bf-subpanel hover:bg-bf-hover text-bf-warn rounded text-[10px] transition-colors font-bold"
                >
                  <div className="flex items-center gap-1.5">
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset to Factory Layout</span>
                  </div>
                  <span className="text-[8.5px] text-bf-warn/70">FACTORY</span>
                </button>
              </div>
            </div>,
            document.body
          )}
      </div>

      {/* Right: Signature Workflows & Export */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Flash-Yield Button / Countdown Banner */}
        {isYielded ? (
          <div className="flex items-center gap-1.5 bg-bf-warn/20 border border-bf-warn text-bf-warn px-2 py-0.5 rounded animate-pulse">
            <Clock className="w-3 h-3" />
            <span className="font-mono font-bold text-[10px]">
              YIELD ({yieldRemainingSecs}s)
            </span>
            <button
              onClick={reclaimPort}
              title="Reclaim serial handle immediately"
              className="px-1 py-0.2 bg-bf-warn text-bf-onfill font-bold text-[9px] rounded hover:bg-bf-warn-hi"
            >
              RECLAIM
            </button>
          </div>
        ) : (
          <button
            onClick={() => triggerFlashYield(30)}
            title="Surrender COM port handle for external programmer/IDE (Ctrl+Shift+Y). Does not drop session capture history."
            className="flex items-center gap-1 px-2 py-0.5 bg-bf-subpanel border border-bf-warn/40 text-bf-warn rounded hover:bg-bf-warn/10 transition-colors"
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
              ? 'bg-bf-fault text-white font-bold animate-pulse shadow-[0_0_8px_rgb(var(--bf-fault-rgb)/0.5)]'
              : 'bg-bf-subpanel border border-bf-fault/50 text-bf-fault hover:bg-bf-fault/10'
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
              ? 'bg-bf-active border border-bf-cyan text-bf-cyan'
              : 'bg-bf-subpanel border border-bf-line text-bf-faint hover:text-bf-mute'
          }`}
        >
          <Radio className="w-3 h-3" />
          <span className="hidden lg:inline">{isSimulated ? 'SIM' : 'HW'}</span>
        </button>

        {/* Load Sample Capture button */}
        <button
          onClick={loadSampleCapture}
          title="Load demonstration telemetry capture stream (50 sample frames)"
          className="hidden xl:inline-block px-1.5 py-0.5 bg-bf-subpanel hover:bg-bf-hover text-bf-mute hover:text-bf-body border border-bf-line rounded text-[10px] font-mono"
        >
          DEMO
        </button>

        {/* Session Vault Recording Button — engine-driven (POST /api/record) */}
        <button
          onClick={async () => {
            if (recPending) return;
            setRecPending(true);
            try {
              if (engineRecording) {
                const result = await engineApi.recordControl('stop');
                if (result.ok) {
                  pushToast('success', 'Vault sealed', `${result.vault ?? 'vault'} saved.`);
                } else {
                  pushToast('error', 'Stop failed', result.error ?? 'Engine did not confirm.');
                }
              } else {
                // Vault path from the Settings dialog's name pattern
                // (defaults to `vaults/rec-<stamp>.bflog`).
                const result = await engineApi.recordControl(
                  'start',
                  buildVaultPath(useSettingsStore.getState().settings.vaultNamePattern)
                );
                if (result.ok) {
                  pushToast('success', 'Recording started', `${result.vault} is capturing the raw link.`);
                } else {
                  pushToast('error', 'Record failed', result.error ?? 'Engine did not confirm.');
                }
              }
            } finally {
              setRecPending(false);
            }
          }}
          disabled={recPending}
          title={
            engineRecording
              ? `Recording active: ${vaultPath} (${formatVaultBytes(vaultBytes)}) — click to seal the vault`
              : 'Record raw session to an append-only binary .bflog on the engine host'
          }
          className={`flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] transition-colors ${
            engineRecording
              ? 'bg-bf-fault text-white font-bold animate-pulse'
              : 'bg-bf-subpanel border border-bf-line text-bf-mute hover:text-bf-body'
          }`}
        >
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              engineRecording ? 'bg-white' : 'bg-bf-fault'
            }`}
          />
          <span className="hidden sm:inline">
            {engineRecording ? `● REC ${formatVaultBytes(vaultBytes)}` : recPending ? '…' : 'STANDBY'}
          </span>
        </button>

        {/* Multi-Format Vault Export Dialog */}
        <button
          onClick={() => setExportModalOpen(true)}
          title="Export session vault to Wireshark PCAP-NG, Saleae Logic CSV, or Streaming NDJSON"
          className="flex items-center gap-1 px-2 py-0.5 bg-bf-subpanel hover:bg-bf-hover text-bf-cyan hover:text-bf-sky border border-bf-cyan/40 rounded font-mono text-[10px] transition-colors shadow-[0_0_8px_rgb(var(--bf-cyan-rgb)/0.15)]"
        >
          <Download className="w-3 h-3" />
          <span className="hidden sm:inline font-bold">EXPORT</span>
        </button>

        {/* Global Settings Dialog (gear · Ctrl+,) */}
        <button
          onClick={() => useSettingsStore.getState().setSettingsOpen(true)}
          title="Application settings: appearance, performance & export defaults (Ctrl+,)"
          className="flex items-center px-1.5 py-0.5 bg-bf-subpanel hover:bg-bf-hover text-bf-mute hover:text-bf-cyan border border-bf-line hover:border-bf-cyan/40 rounded transition-colors"
        >
          <Settings className="w-3 h-3" />
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
