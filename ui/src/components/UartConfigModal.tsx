import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X, Check, RotateCcw } from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';

interface UartConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

export const UartConfigModal: React.FC<UartConfigModalProps> = ({ isOpen, onClose, anchorRect }) => {
  const {
    dataBits,
    parity,
    stopBits,
    delimiterMode,
    customDelimiterHex,
    setUartConfig,
  } = useWorkstationStore();

  const [tempDataBits, setTempDataBits] = useState(dataBits);
  const [tempParity, setTempParity] = useState(parity);
  const [tempStopBits, setTempStopBits] = useState(stopBits);
  const [tempMode, setTempMode] = useState(delimiterMode);
  const [tempCustomHex, setTempCustomHex] = useState(customDelimiterHex);

  const modalRef = useRef<HTMLDivElement>(null);

  // Sync state whenever opened
  useEffect(() => {
    if (isOpen) {
      setTempDataBits(dataBits);
      setTempParity(parity);
      setTempStopBits(stopBits);
      setTempMode(delimiterMode);
      setTempCustomHex(customDelimiterHex);
    }
  }, [isOpen, dataBits, parity, stopBits, delimiterMode, customDelimiterHex]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleApply = () => {
    setUartConfig({
      dataBits: tempDataBits,
      parity: tempParity,
      stopBits: tempStopBits,
      delimiterMode: tempMode,
      customDelimiterHex: tempCustomHex.trim().replace(/^0x/i, '') || '00',
    });
    onClose();
  };

  const handleReset = () => {
    setTempDataBits(8);
    setTempParity('none');
    setTempStopBits(1);
    setTempMode('cobs');
    setTempCustomHex('00');
  };

  // Compute position relative to anchor if provided
  let style: React.CSSProperties = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 999999,
  };

  if (anchorRect) {
    const top = Math.min(anchorRect.bottom + 6, window.innerHeight - 380);
    const left = Math.min(Math.max(10, anchorRect.left - 100), window.innerWidth - 380);
    style = {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      zIndex: 999999,
    };
  }

  const shorthand = `${tempDataBits}${tempParity.charAt(0).toUpperCase()}${tempStopBits}`;

  return createPortal(
    <div className="fixed inset-0 z-[999998] bg-black/40 backdrop-blur-[1px]">
      <div
        ref={modalRef}
        style={style}
        className="w-[360px] bg-[#0E131F] border border-[#2D3A4E] shadow-[0_12px_36px_rgba(0,0,0,0.85)] rounded-lg text-[11px] font-mono text-[#CBD5E1] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="h-[32px] bg-[#141B29] border-b border-[#222D3D] px-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[#00E5FF] font-semibold text-[11.5px]">
            <Settings2 className="w-3.5 h-3.5" />
            <span>UART & DELIMITER CONFIGURATION</span>
          </div>
          <button
            onClick={onClose}
            className="text-[#64748B] hover:text-[#EF4444] p-0.5 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-3.5 space-y-3.5 max-h-[460px] overflow-y-auto">
          {/* Active Shorthand Badge */}
          <div className="flex items-center justify-between bg-[#161C28] border border-[#222D3D] px-2.5 py-1.5 rounded">
            <span className="text-[#64748B] text-[10px]">FRAMING SHORTHAND</span>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-[#00E5FF]/10 text-[#00E5FF] font-bold border border-[#00E5FF]/30 text-[11px]">
                {shorthand}
              </span>
              <span className="text-[10px] text-[#94A3B8]">
                {tempDataBits} Data · {tempParity.toUpperCase()} Parity · {tempStopBits} Stop
              </span>
            </div>
          </div>

          {/* Section 1: UART Line Framing */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
              1. Line Parameters (Data · Parity · Stop)
            </div>

            {/* Data Bits */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#64748B] text-[10px]">Data Bits:</span>
              <div className="flex items-center gap-1">
                {[8, 7, 6, 5].map((bits) => (
                  <button
                    key={bits}
                    type="button"
                    onClick={() => setTempDataBits(bits)}
                    className={`w-9 py-0.5 rounded text-[10.5px] font-semibold transition-colors border ${
                      tempDataBits === bits
                        ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
                        : 'bg-[#161C28] border-[#222D3D] text-[#94A3B8] hover:border-[#38BDF8]/40'
                    }`}
                  >
                    {bits}
                  </button>
                ))}
              </div>
            </div>

            {/* Parity */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#64748B] text-[10px]">Parity:</span>
              <div className="flex items-center gap-1">
                {(['none', 'even', 'odd', 'mark', 'space'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTempParity(p)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors border ${
                      tempParity === p
                        ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
                        : 'bg-[#161C28] border-[#222D3D] text-[#94A3B8] hover:border-[#38BDF8]/40'
                    }`}
                  >
                    {p === 'none' ? 'None (N)' : p === 'even' ? 'Even (E)' : p === 'odd' ? 'Odd (O)' : p.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Stop Bits */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#64748B] text-[10px]">Stop Bits:</span>
              <div className="flex items-center gap-1">
                {[1, 1.5, 2].map((sb) => (
                  <button
                    key={sb}
                    type="button"
                    onClick={() => setTempStopBits(sb)}
                    className={`w-11 py-0.5 rounded text-[10.5px] font-semibold transition-colors border ${
                      tempStopBits === sb
                        ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
                        : 'bg-[#161C28] border-[#222D3D] text-[#94A3B8] hover:border-[#38BDF8]/40'
                    }`}
                  >
                    {sb}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section 2: Delimiter / Frame Extraction */}
          <div className="space-y-2 border-t border-[#222D3D] pt-3">
            <div className="text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider flex items-center justify-between">
              <span>2. Frame Delimiter & Packet Slicer</span>
              <span className="text-[#00E5FF] text-[9.5px]">{tempMode.toUpperCase()}</span>
            </div>

            <div className="grid grid-cols-1 gap-1.5">
              {[
                { id: 'cobs', label: 'COBS (Consistent Overhead Byte Stuffing)', desc: 'Zero-byte frame delimiter with automatic byte unstuffing' },
                { id: 'lf', label: 'LF / Newline (\\n, 0x0A)', desc: 'Standard ASCII line delimiter (UNIX / Terminal)' },
                { id: 'crlf', label: 'CRLF (\\r\\n, 0x0D 0x0A)', desc: 'Standard Windows / AT Command line delimiter' },
                { id: 'null', label: 'NULL Byte (0x00)', desc: 'Split on raw null byte without payload unpacking' },
                { id: 'slip', label: 'SLIP Protocol (RFC 1055, 0xC0)', desc: 'Serial Line IP framing with 0xDB escape sequences' },
                { id: 'raw', label: 'Raw Stream (No Delimiter)', desc: 'Direct byte streaming with continuous pass-through' },
                { id: 'custom', label: 'Custom Delimiter Byte', desc: 'Specify custom single-byte boundary in hex' },
              ].map((m) => (
                <label
                  key={m.id}
                  onClick={() => setTempMode(m.id as any)}
                  className={`flex items-start gap-2 p-1.5 rounded cursor-pointer border transition-colors ${
                    tempMode === m.id
                      ? 'bg-[#00E5FF]/10 border-[#00E5FF]/60 text-[#E2E8F0]'
                      : 'bg-[#141A26] border-[#1E293B] hover:border-[#334155] text-[#94A3B8]'
                  }`}
                >
                  <input
                    type="radio"
                    name="delimiterMode"
                    checked={tempMode === m.id}
                    onChange={() => setTempMode(m.id as any)}
                    className="mt-0.5 accent-[#00E5FF] cursor-pointer"
                  />
                  <div className="flex-1">
                    <div className="text-[10.5px] font-semibold">{m.label}</div>
                    <div className="text-[9px] text-[#64748B] leading-tight mt-0.5">{m.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Custom byte input when Custom selected */}
            {tempMode === 'custom' && (
              <div className="flex items-center gap-2 p-2 rounded bg-[#161C28] border border-[#2D3A4E]">
                <span className="text-[#64748B] text-[10px]">HEX BYTE (00-FF):</span>
                <span className="text-[#00E5FF] font-bold">0x</span>
                <input
                  type="text"
                  maxLength={2}
                  value={tempCustomHex}
                  onChange={(e) => setTempCustomHex(e.target.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase())}
                  placeholder="7E"
                  className="w-12 h-6 px-1.5 bg-[#0E131F] border border-[#00E5FF]/50 rounded text-center text-[#00E5FF] font-bold text-xs focus:outline-none font-mono"
                />
                <span className="text-[#64748B] text-[9.5px]">
                  (Decimal: {parseInt(tempCustomHex || '0', 16) || 0})
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="h-[36px] bg-[#141B29] border-t border-[#222D3D] px-3 flex items-center justify-between">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 text-[10px] text-[#64748B] hover:text-[#94A3B8] transition-colors"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            <span>Reset (8-N-1 · COBS)</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-2.5 py-1 rounded bg-[#1E293B] hover:bg-[#334155] text-[#94A3B8] text-[10.5px] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="flex items-center gap-1 px-3 py-1 rounded bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-semibold text-[10.5px] transition-colors shadow-[0_0_8px_rgba(0,229,255,0.4)]"
            >
              <Check className="w-3 h-3" />
              <span>Apply Configuration</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
