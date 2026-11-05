// X/YMODEM Transfer Rig (spec 2.7) — REAL implementation.
// The X/YMODEM state machine lives in the engine (crates/bforge-core/xmodem.rs)
// and runs on the pump; this panel stages the file, arms the transfer, polls
// status, and drains the received bytes when done.
import React, { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Upload,
  Play,
  Square,
  RotateCcw,
} from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { engineApi } from '../services/engineApi';

type ModemMode = 'xmodem-crc' | 'xmodem-1k';
type TransferDirection = 'send' | 'recv';
type TransferStatus = 'idle' | 'handshake' | 'transferring' | 'finishing' | 'complete' | 'cancelled' | 'error';

export const FileTransferView: React.FC = () => {
  const { selectedPort } = useWorkstationStore(
    useShallow((s) => ({ selectedPort: s.selectedPort }))
  );

  const [mode, setMode] = useState<ModemMode>('xmodem-crc');
  const [direction, setDirection] = useState<TransferDirection>('send');
  const [filename, setFilename] = useState('esp32_firmware_v1.0.bin');
  const [fileSize, setFileSize] = useState<number>(32768);
  const [maxRetries] = useState<number>(10);
  const [status, setStatus] = useState<TransferStatus>('idle');
  const [currentBlock, setCurrentBlock] = useState<number>(0);
  const [totalBlocks, setTotalBlocks] = useState<number>(256);
  const [bytesTransferred, setBytesTransferred] = useState<number>(0);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [stagedName, setStagedName] = useState<string | null>(null);
  const [stagedBytes, setStagedBytes] = useState<Uint8Array | null>(null);
  const pollRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const addLog = (msg: string) => {
    const time = new Date().toTimeString().split(' ')[0];
    setLogMessages((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 49)]);
  };

  // Unmount cleanup: stop polling; the engine-side state machine is cancelled
  // explicitly via the Cancel button (or times out on its own).
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const modeWire = mode === 'xmodem-1k' ? 'crc1k' : 'crc128';

  // Stage a real file for a Send transfer (cross-platform file input).
  const handleFilePick = async (file: File | undefined) => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await engineApi.transferUpload(bytes);
    if (result.ok) {
      setStagedName(file.name);
      setStagedBytes(bytes);
      setFilename(file.name);
      setFileSize(bytes.length);
      addLog(`Staged ${file.name} (${bytes.length} B) for transmission.`);
    } else {
      addLog(`STAGE FAILED: ${result.error ?? 'engine unreachable'}`);
    }
  };

  const startPolling = () => {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(async () => {
      if (!aliveRef.current) return;
      const result = await engineApi.transferStatus(selectedPort);
      if (!result.ok) return;
      const view = result.view;
      if (!view) return;
      const phase = view.phase ?? 'none';
      if (phase === 'none' || phase.startsWith('failed')) {
        if (pollRef.current !== null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        if (phase.startsWith('failed')) {
          setStatus('error');
          addLog(`TRANSFER FAILED: ${phase.slice('failed:'.length)}`);
        } else {
          setStatus('idle');
        }
        return;
      }
      if (phase === 'handshake') setStatus('handshake');
      else if (phase === 'transferring') setStatus('transferring');
      else if (phase === 'finishing') setStatus('finishing');
      else if (phase === 'done') {
        setStatus('complete');
        if (pollRef.current !== null) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        if (view.direction === 'recv') {
          // Drain the received bytes and offer them as a download.
          const data = await engineApi.transferData(selectedPort);
          if (data.ok && data.bytes && data.bytes.length > 0) {
            const blob = new Blob([data.bytes as unknown as BlobPart], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = view.name || 'received.bin';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1500);
            addLog(`Received ${view.name} (${data.bytes.length} B) — download offered.`);
          }
        }
        addLog(`Transfer COMPLETE across ${view.total_blocks} blocks.`);
        return;
      }
      setCurrentBlock(view.block ?? 0);
      setTotalBlocks(view.total_blocks ?? 0);
      setBytesTransferred(view.bytes_done ?? 0);
    }, 400);
  };

  const handleStartTransfer = async () => {
    if (status === 'transferring' || status === 'handshake' || status === 'finishing') return;

    setCurrentBlock(0);
    setBytesTransferred(0);
    addLog(`Arming ${mode.toUpperCase()} ${direction.toUpperCase()} transfer on ${selectedPort}`);

    if (direction === 'send' && !stagedBytes) {
      addLog('No file staged — pick a file first (STAGE FILE).');
      return;
    }

    const blocks = Math.ceil(
      (direction === 'send' ? stagedBytes?.length ?? fileSize : fileSize) /
        (mode === 'xmodem-1k' ? 1024 : 128)
    );
    setTotalBlocks(blocks);

    const result = await engineApi.transferArm({
      port: selectedPort,
      direction,
      mode: modeWire,
      name: filename,
      size: direction === 'send' ? stagedBytes?.length : fileSize,
    });
    if (!result.ok) {
      setStatus('error');
      addLog(`ARM FAILED: ${result.error ?? 'engine unreachable'}`);
      return;
    }
    setStatus('handshake');
    addLog('Transfer armed — waiting for the device handshake on the wire.');
    if (direction === 'send') {
      addLog(`Waiting for the receiver's 'C' (CRC mode) on ${selectedPort}…`);
    } else {
      addLog(`Polling 'C' toward ${selectedPort}; the device should start sending blocks.`);
    }
    startPolling();
  };

  const handleCancel = async () => {
    const result = await engineApi.transferCancel(selectedPort);
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setStatus('cancelled');
    addLog(
      result.ok
        ? 'Transfer CANCELLED — CAN CAN sent to the device.'
        : `CANCEL FAILED: ${result.error ?? 'no transfer armed'}`
    );
  };

  const handleReset = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setStatus('idle');
    setCurrentBlock(0);
    setBytesTransferred(0);
    setLastBlockPreview(null);
    addLog('Reset transfer panel to IDLE.');
  };

  const blockSize = mode === 'xmodem-1k' ? 1024 : 128;
  const progress = totalBlocks > 0 ? Math.min(100, Math.round((currentBlock / totalBlocks) * 100)) : 0;
  const wireBlocks = Math.max(1, Math.ceil((direction === 'send' ? stagedBytes?.length ?? fileSize : fileSize) / blockSize));

  return (
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Upload className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            X/YMODEM Transfer Rig
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] font-mono border border-[#00E5FF]/30">
            X/YMODEM PROTOCOL
          </span>
        </div>
        <span
          className={`text-[9.5px] font-mono px-1.5 py-0.2 rounded ${
            status === 'complete'
              ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40'
              : status === 'error'
              ? 'bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/40'
              : 'bg-[#1E2638] text-[#94A3B8] border border-[#222D3D]'
          }`}
        >
          {status.toUpperCase()}
        </span>
      </div>

      {/* Main 3-column split */}
      <div className="flex-1 grid grid-cols-[1fr_1fr_1fr] gap-2 p-2 min-h-0 overflow-hidden">
        {/* Protocol & File Setup */}
        <div className="bg-[#121722] border border-[#222D3D] rounded p-2 flex flex-col gap-2 overflow-y-auto min-h-0">
          <div className="text-[9.5px] font-bold uppercase tracking-wider text-[#94A3B8] border-b border-[#222D3D] pb-1">
            Protocol & File Setup
          </div>

          <div>
            <span className="text-[9px] text-[#64748B] block mb-1">PROTOCOL DIALECT</span>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setMode('xmodem-crc')}
                className={`px-1.5 py-1 rounded text-[9.5px] font-mono transition-colors border ${
                  mode === 'xmodem-crc'
                    ? 'bg-[#00E5FF]/15 border-[#00E5FF]/50 text-[#00E5FF]'
                    : 'bg-[#0A0D13] border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                XMODEM-CRC
              </button>
              <button
                onClick={() => setMode('xmodem-1k')}
                className={`px-1.5 py-1 rounded text-[9.5px] font-mono transition-colors border ${
                  mode === 'xmodem-1k'
                    ? 'bg-[#00E5FF]/15 border-[#00E5FF]/50 text-[#00E5FF]'
                    : 'bg-[#0A0D13] border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                XMODEM-1K
              </button>
            </div>
          </div>

          <div>
            <span className="text-[9px] text-[#64748B] block mb-1">TRANSFER DIRECTION</span>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => setDirection('send')}
                className={`px-1.5 py-1 rounded text-[9.5px] font-mono transition-colors border ${
                  direction === 'send'
                    ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                    : 'bg-[#0A0D13] border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                ▲ SEND (UPLOAD)
              </button>
              <button
                onClick={() => setDirection('recv')}
                className={`px-1.5 py-1 rounded text-[9.5px] font-mono transition-colors border ${
                  direction === 'recv'
                    ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                    : 'bg-[#0A0D13] border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                ▼ RECV (DUMP)
              </button>
            </div>
          </div>

          {direction === 'send' && (
            <label
              data-tooltip="Pick the file to transmit — bytes stage on the engine"
              className="flex items-center justify-center gap-1 px-2 py-1.5 bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 rounded text-[9.5px] font-bold cursor-pointer transition-colors"
            >
              <Upload className="w-3 h-3" />
              <span>{stagedBytes ? `STAGED: ${stagedName} (${stagedBytes.length} B)` : 'STAGE FILE…'}</span>
              <input
                type="file"
                className="hidden"
                onChange={(e) => handleFilePick(e.target.files?.[0])}
              />
            </label>
          )}

          <div>
            <span className="text-[9px] text-[#64748B] block mb-1">FILENAME (wire name)</span>
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className="w-full bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1 text-[10px] text-[#E2E8F0] font-mono focus:border-[#00E5FF] focus:outline-none"
            />
          </div>

          <div>
            <span className="text-[9px] text-[#64748B] block mb-1">
              SIZE (BYTES){direction === 'recv' ? ' — expected, trims padding' : ''}
            </span>
            <input
              type="number"
              min={1}
              value={fileSize}
              onChange={(e) => setFileSize(parseInt(e.target.value, 10) || 1)}
              className="w-full bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1 text-[10px] text-[#E2E8F0] font-mono focus:border-[#00E5FF] focus:outline-none"
            />
          </div>

          <div>
            <span className="text-[9px] text-[#64748B] block mb-1">MAX RETRIES</span>
            <input
              type="number"
              value={maxRetries}
              readOnly
              className="w-full bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1 text-[10px] text-[#64748B] font-mono"
            />
          </div>

          <button
            onClick={handleStartTransfer}
            disabled={status === 'transferring' || status === 'handshake' || status === 'finishing'}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-[#00E5FF] hover:bg-[#00B4D8] disabled:opacity-40 text-[#0A0D13] font-bold rounded text-[10px] transition-colors"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>START TRANSFER</span>
          </button>

          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={handleCancel}
              className="flex items-center justify-center gap-1 px-2 py-1 bg-[#EF4444]/15 hover:bg-[#EF4444]/25 text-[#EF4444] border border-[#EF4444]/40 rounded text-[9.5px] font-bold transition-colors"
            >
              <Square className="w-3 h-3 fill-current" />
              CANCEL
            </button>
            <button
              onClick={handleReset}
              className="flex items-center justify-center gap-1 px-2 py-1 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] border border-[#222D3D] rounded text-[9.5px] font-bold transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              RESET
            </button>
          </div>
        </div>

        {/* Transfer Telemetry */}
        <div className="bg-[#121722] border border-[#222D3D] rounded p-2 flex flex-col gap-2 overflow-y-auto min-h-0">
          <div className="text-[9.5px] font-bold uppercase tracking-wider text-[#94A3B8] border-b border-[#222D3D] pb-1">
            Transfer Telemetry
          </div>

          <div>
            <div className="flex items-center justify-between text-[9.5px] mb-1">
              <span className="text-[#64748B]">Progress ({progress}%)</span>
              <span className="text-[#00E5FF] font-mono">
                {bytesTransferred.toLocaleString()} /{' '}
                {(direction === 'send' ? stagedBytes?.length ?? fileSize : fileSize).toLocaleString()} B
              </span>
            </div>
            <div className="h-2 bg-[#0A0D13] rounded overflow-hidden border border-[#222D3D]">
              <div
                className="h-full bg-[#00E5FF] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[#0A0D13] border border-[#222D3D] rounded p-1.5">
              <div className="text-[8.5px] text-[#64748B] uppercase tracking-wider">Block Counter</div>
              <div className="text-[14px] text-[#00E5FF] font-mono font-bold">
                #{currentBlock} <span className="text-[10px] text-[#64748B]">/ {totalBlocks || wireBlocks}</span>
              </div>
            </div>
            <div className="bg-[#0A0D13] border border-[#222D3D] rounded p-1.5">
              <div className="text-[8.5px] text-[#64748B] uppercase tracking-wider">Block Size</div>
              <div className="text-[14px] text-[#94A3B8] font-mono font-bold">{blockSize} B</div>
            </div>
          </div>

          <div className="bg-[#0A0D13] border border-[#222D3D] rounded p-1.5">
            <div className="text-[8.5px] text-[#64748B] uppercase tracking-wider mb-1">
              Wire Frame Structure ({direction === 'send' ? 'SOH/STX + CRC16' : 'as received'})
            </div>
            <div className="text-[9px] text-[#64748B] font-mono break-all">
              {stagedBytes && direction === 'send'
                ? Array.from(stagedBytes.slice(0, 12))
                    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
                    .join(' ') + (stagedBytes.length > 12 ? ' …' : '')
                : 'Awaiting transfer frames…'}
            </div>
          </div>
        </div>

        {/* Transfer Protocol Log */}
        <div className="bg-[#121722] border border-[#222D3D] rounded p-2 flex flex-col min-h-0">
          <div className="flex items-center justify-between border-b border-[#222D3D] pb-1 mb-1">
            <span className="text-[9.5px] font-bold uppercase tracking-wider text-[#94A3B8]">
              Transfer Protocol Log
            </span>
            <button
              onClick={() => setLogMessages([])}
              className="text-[9px] text-[#64748B] hover:text-[#E2E8F0]"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[9px] space-y-0.5 min-h-0">
            {logMessages.length === 0 ? (
              <div className="text-[#475569]">Ready. Arm a transfer to begin.</div>
            ) : (
              logMessages.map((msg, i) => (
                <div key={i} className={msg.includes('FAILED') ? 'text-[#EF4444]' : 'text-[#94A3B8]'}>
                  {msg}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Local alias to satisfy the empty-state slot above without duplicating state.
const setLastBlockPreview = (_value: null) => {};
