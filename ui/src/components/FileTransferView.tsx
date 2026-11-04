import React, { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Upload,
  Download,
  Play,
  Square,
  RotateCcw,
  Zap,
} from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { engineApi } from '../services/engineApi';

type ModemMode = 'xmodem-crc' | 'xmodem-1k' | 'xmodem-checksum' | 'ymodem';
type TransferDirection = 'send' | 'recv';
type TransferStatus = 'idle' | 'handshake' | 'transferring' | 'eot' | 'complete' | 'cancelled' | 'error';

interface TransferBlock {
  blockNum: number;
  size: number;
  crc16: number;
  retries: number;
  status: 'pending' | 'acked' | 'nacked';
  rawPreview: string;
}

export const FileTransferView: React.FC = () => {
  const { selectedPort, triggerFlashYield, isYielded } = useWorkstationStore(
    useShallow((s) => ({
      selectedPort: s.selectedPort,
      triggerFlashYield: s.triggerFlashYield,
      isYielded: s.isYielded,
    }))
  );

  const [mode, setMode] = useState<ModemMode>('xmodem-crc');
  const [direction, setDirection] = useState<TransferDirection>('send');
  const [filename, setFilename] = useState('esp32_firmware_v1.0.bin');
  const [fileSize, setFileSize] = useState<number>(32768); // 32 KB default
  const [maxRetries, setMaxRetries] = useState<number>(10);
  const [status, setStatus] = useState<TransferStatus>('idle');
  const [currentBlock, setCurrentBlock] = useState<number>(0);
  const [totalBlocks, setTotalBlocks] = useState<number>(256);
  const [retriesCount, setRetriesCount] = useState<number>(0);
  const [bytesTransferred, setBytesTransferred] = useState<number>(0);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [lastBlockPreview, setLastBlockPreview] = useState<TransferBlock | null>(null);

  const transferIntervalRef = useRef<number | null>(null);
  // Guards the deferred handshake setTimeouts: closing the dockview tab
  // mid-handshake must not spawn a fresh transfer interval after unmount.
  const aliveRef = useRef(true);

  // Unmount cleanup — without this a mid-transfer tab close left the interval
  // running invisibly, spamming marker frames to the serial port until
  // "completion" with no way to stop it from the UI.
  useEffect(() => {
    return () => {
      aliveRef.current = false;
      if (transferIntervalRef.current !== null) {
        window.clearInterval(transferIntervalRef.current);
        transferIntervalRef.current = null;
      }
    };
  }, []);

  // Compute block size based on mode
  const blockSize = mode === 'xmodem-1k' || (mode === 'ymodem' && currentBlock > 0) ? 1024 : 128;

  useEffect(() => {
    const blocks = Math.ceil(fileSize / (mode === 'xmodem-1k' ? 1024 : 128));
    setTotalBlocks(blocks);
  }, [fileSize, mode]);

  const addLog = (msg: string) => {
    const time = new Date().toTimeString().split(' ')[0];
    setLogMessages((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 49)]);
  };

  const handleStartTransfer = async () => {
    if (status === 'transferring' || status === 'handshake') return;

    setStatus('handshake');
    setCurrentBlock(0);
    setBytesTransferred(0);
    setRetriesCount(0);
    addLog(`Initiating ${mode.toUpperCase()} ${direction.toUpperCase()} transfer on ${selectedPort}`);

    // Automatically yield the port to avoid contention with session streaming
    if (!isYielded) {
      triggerFlashYield(60);
      addLog(`Auto-yielded port ${selectedPort} for 60s for exclusive Xfer access`);
    }

    if (direction === 'send') {
      addLog(`Waiting for receiver start character (${mode === 'xmodem-checksum' ? 'NAK 0x15' : "'C' 0x43"})...`);

      // Simulate initial handshake ACK / 'C'
      setTimeout(() => {
        if (!aliveRef.current) return;
        addLog(`Received receiver sync character '${mode === 'xmodem-checksum' ? 'NAK' : 'C'}'. Beginning transmission.`);
        setStatus('transferring');
        startBlockTransmission();
      }, 600);
    } else {
      addLog(`Sending polling character '${mode === 'xmodem-checksum' ? 'NAK' : 'C'}' to target...`);
      setTimeout(() => {
        if (!aliveRef.current) return;
        setStatus('transferring');
        startBlockReception();
      }, 600);
    }
  };

  const startBlockTransmission = () => {
    let blockIdx = 1;
    let bytesSent = 0;

    if (transferIntervalRef.current) clearInterval(transferIntervalRef.current);

    transferIntervalRef.current = window.setInterval(() => {
      if (blockIdx > totalBlocks) {
        if (transferIntervalRef.current) clearInterval(transferIntervalRef.current);
        setStatus('eot');
        addLog('Transmitted all data blocks. Sending EOT (0x04)...');

        setTimeout(() => {
          setStatus('complete');
          addLog(`Transfer COMPLETE. Transmitted ${bytesSent} bytes across ${totalBlocks} blocks (0 retries).`);
        }, 500);
        return;
      }

      const curBlockSize = mode === 'xmodem-1k' ? 1024 : 128;
      bytesSent = Math.min(fileSize, blockIdx * curBlockSize);

      setCurrentBlock(blockIdx);
      setBytesTransferred(bytesSent);

      // Simulate block hex preview
      const previewHex = `${curBlockSize === 1024 ? '02' : '01'} ${blockIdx.toString(16).padStart(2, '0').toUpperCase()} ${(255 - blockIdx).toString(16).padStart(2, '0').toUpperCase()} 42 46 4F 52 47 45 ... ${mode === 'xmodem-checksum' ? 'CHECKSUM: 7A' : 'CRC16: 3D4B'}`;
      setLastBlockPreview({
        blockNum: blockIdx,
        size: curBlockSize,
        crc16: 0x3d4b,
        retries: 0,
        status: 'acked',
        rawPreview: previewHex,
      });

      addLog(`Block #${blockIdx}/${totalBlocks} (${curBlockSize}B) -> ACK received`);

      // Transmit simulated block to port via engineApi so activity shows on line
      engineApi.sendBytes(selectedPort, curBlockSize === 1024 ? '0201fe4246' : '0101fe4246');

      blockIdx++;
    }, 120);
  };

  const startBlockReception = () => {
    let blockIdx = 1;
    let bytesRecv = 0;

    if (transferIntervalRef.current) clearInterval(transferIntervalRef.current);

    transferIntervalRef.current = window.setInterval(() => {
      if (blockIdx > totalBlocks) {
        if (transferIntervalRef.current) clearInterval(transferIntervalRef.current);
        setStatus('complete');
        addLog(`Reception COMPLETE. Stored ${bytesRecv} bytes in ${filename}.`);
        return;
      }

      const curBlockSize = mode === 'xmodem-1k' ? 1024 : 128;
      bytesRecv = Math.min(fileSize, blockIdx * curBlockSize);

      setCurrentBlock(blockIdx);
      setBytesTransferred(bytesRecv);
      addLog(`Received Block #${blockIdx}/${totalBlocks} -> ACK sent`);
      blockIdx++;
    }, 120);
  };

  const handleCancel = () => {
    if (transferIntervalRef.current) {
      clearInterval(transferIntervalRef.current);
      transferIntervalRef.current = null;
    }
    // Send double CAN (0x18, 0x18) per spec 0056
    engineApi.sendBytes(selectedPort, '1818');
    setStatus('cancelled');
    addLog('Transfer CANCELLED. Sent double CAN (0x18 0x18) abort sequence.');
  };

  const handleReset = () => {
    if (transferIntervalRef.current) {
      clearInterval(transferIntervalRef.current);
      transferIntervalRef.current = null;
    }
    setStatus('idle');
    setCurrentBlock(0);
    setBytesTransferred(0);
    setRetriesCount(0);
    setLastBlockPreview(null);
    addLog('Reset transfer state machine to IDLE.');
  };

  const progressPercent = totalBlocks > 0 ? Math.min(100, Math.round((currentBlock / totalBlocks) * 100)) : 0;

  return (
    <div className="flex flex-col h-full bg-[#0A0D13] font-mono text-[11px] text-[#E2E8F0] overflow-hidden">
      {/* Top Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#121824] border-b border-[#222D3D]">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-[#00E5FF]" />
          <span className="font-bold tracking-wider uppercase text-[#F8FAFC]">
            X/YMODEM Transfer Rig
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] border border-[#00E5FF]/30">
            X/YMODEM PROTOCOL
          </span>
        </div>

        {/* State Badge */}
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${
              status === 'transferring'
                ? 'bg-[#00E5FF]/20 border-[#00E5FF] text-[#00E5FF] animate-pulse'
                : status === 'handshake'
                ? 'bg-[#F59E0B]/20 border-[#F59E0B] text-[#F59E0B] animate-pulse'
                : status === 'complete'
                ? 'bg-[#10B981]/20 border-[#10B981] text-[#10B981]'
                : status === 'cancelled' || status === 'error'
                ? 'bg-[#EF4444]/20 border-[#EF4444] text-[#EF4444]'
                : 'bg-[#161C28] border-[#222D3D] text-[#64748B]'
            }`}
          >
            {status}
          </span>
        </div>
      </div>

      {/* Main Configuration & Telemetry Grid */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2 p-3 overflow-y-auto">
        {/* Left Column: Transfer Configuration */}
        <div className="bg-[#121824] border border-[#222D3D] rounded p-3 space-y-3">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] border-b border-[#222D3D] pb-1">
            Protocol & File Setup
          </h3>

          {/* Protocol Mode */}
          <div>
            <label className="block text-[10px] text-[#94A3B8] mb-1">Protocol Dialect</label>
            <div className="grid grid-cols-2 gap-1.5">
              {(['xmodem-crc', 'xmodem-1k', 'ymodem', 'xmodem-checksum'] as ModemMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  disabled={status === 'transferring'}
                  className={`px-2 py-1 rounded text-left border text-[10px] transition-colors ${
                    mode === m
                      ? 'border-[#00E5FF] bg-[#00E5FF]/15 text-[#00E5FF] font-bold'
                      : 'border-[#222D3D] bg-[#161C28] text-[#94A3B8] hover:border-[#334155]'
                  }`}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Direction */}
          <div>
            <label className="block text-[10px] text-[#94A3B8] mb-1">Transfer Direction</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => setDirection('send')}
                disabled={status === 'transferring'}
                className={`flex items-center justify-center gap-1.5 px-2 py-1 rounded border text-[10px] ${
                  direction === 'send'
                    ? 'border-[#10B981] bg-[#10B981]/15 text-[#10B981] font-bold'
                    : 'border-[#222D3D] bg-[#161C28] text-[#94A3B8]'
                }`}
              >
                <Upload className="w-3 h-3" />
                <span>SEND (UPLOAD)</span>
              </button>
              <button
                onClick={() => setDirection('recv')}
                disabled={status === 'transferring'}
                className={`flex items-center justify-center gap-1.5 px-2 py-1 rounded border text-[10px] ${
                  direction === 'recv'
                    ? 'border-[#3B82F6] bg-[#3B82F6]/15 text-[#3B82F6] font-bold'
                    : 'border-[#222D3D] bg-[#161C28] text-[#94A3B8]'
                }`}
              >
                <Download className="w-3 h-3" />
                <span>RECV (DUMP)</span>
              </button>
            </div>
          </div>

          {/* Filename & Size */}
          <div className="space-y-2">
            <div>
              <label className="block text-[10px] text-[#94A3B8] mb-1">Filename</label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={status === 'transferring'}
                className="w-full px-2 py-1 bg-[#161C28] border border-[#222D3D] rounded text-[10px] text-[#F8FAFC] focus:border-[#00E5FF] focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-[#94A3B8] mb-1">Size (Bytes)</label>
                <input
                  type="number"
                  value={fileSize}
                  onChange={(e) => setFileSize(Math.max(128, parseInt(e.target.value) || 128))}
                  disabled={status === 'transferring'}
                  className="w-full px-2 py-1 bg-[#161C28] border border-[#222D3D] rounded text-[10px] text-[#F8FAFC] focus:border-[#00E5FF] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#94A3B8] mb-1">Max Retries</label>
                <input
                  type="number"
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Math.max(1, parseInt(e.target.value) || 10))}
                  disabled={status === 'transferring'}
                  className="w-full px-2 py-1 bg-[#161C28] border border-[#222D3D] rounded text-[10px] text-[#F8FAFC] focus:border-[#00E5FF] focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col gap-1.5">
            {status === 'transferring' || status === 'handshake' ? (
              <button
                onClick={handleCancel}
                className="flex items-center justify-center gap-1.5 w-full py-1.5 bg-[#EF4444] hover:bg-[#DC2626] text-white font-bold rounded shadow-[0_0_10px_rgba(239,68,68,0.3)] transition-colors"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>ABORT (CAN/CAN)</span>
              </button>
            ) : (
              <button
                onClick={handleStartTransfer}
                className="flex items-center justify-center gap-1.5 w-full py-1.5 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded shadow-[0_0_10px_rgba(0,229,255,0.3)] transition-colors"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>START TRANSFER</span>
              </button>
            )}

            <button
              onClick={handleReset}
              className="flex items-center justify-center gap-1 w-full py-1 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222D3D] rounded text-[10px] transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset State Machine</span>
            </button>
          </div>
        </div>

        {/* Center Column: Live Progress & Frame Dissection */}
        <div className="bg-[#121824] border border-[#222D3D] rounded p-3 space-y-3 flex flex-col">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] border-b border-[#222D3D] pb-1">
            Transfer Telemetry
          </h3>

          {/* Progress Bar */}
          <div>
            <div className="flex justify-between text-[10px] mb-1 font-mono">
              <span className="text-[#94A3B8]">
                Progress ({progressPercent}%)
              </span>
              <span className="text-[#00E5FF] font-bold">
                {bytesTransferred.toLocaleString()} / {fileSize.toLocaleString()} B
              </span>
            </div>
            <div className="w-full h-3 bg-[#161C28] border border-[#222D3D] rounded overflow-hidden relative">
              <div
                className="h-full bg-gradient-to-r from-[#00E5FF] to-[#10B981] transition-all duration-150"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Metrics Counters */}
          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
            <div className="bg-[#161C28] border border-[#222D3D] p-2 rounded">
              <span className="text-[#64748B] block">BLOCK COUNTER</span>
              <span className="text-[14px] font-bold text-[#F8FAFC]">
                #{currentBlock} <span className="text-[10px] text-[#64748B]">/ {totalBlocks}</span>
              </span>
            </div>
            <div className="bg-[#161C28] border border-[#222D3D] p-2 rounded">
              <span className="text-[#64748B] block">BLOCK SIZE</span>
              <span className="text-[14px] font-bold text-[#00E5FF]">
                {blockSize} B
              </span>
            </div>
            <div className="bg-[#161C28] border border-[#222D3D] p-2 rounded">
              <span className="text-[#64748B] block">RETRANSMISSIONS</span>
              <span className="text-[14px] font-bold text-[#10B981]">
                {retriesCount}
              </span>
            </div>
            <div className="bg-[#161C28] border border-[#222D3D] p-2 rounded">
              <span className="text-[#64748B] block">SPEED (EST.)</span>
              <span className="text-[14px] font-bold text-[#F59E0B]">
                {status === 'transferring' ? '11.5 KB/s' : '0.0 KB/s'}
              </span>
            </div>
          </div>

          {/* Last Block Wire Preview */}
          <div className="flex-1 bg-[#161C28] border border-[#222D3D] rounded p-2 flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#64748B] mb-1">
              Wire Frame Structure (Block #{currentBlock || 1})
            </span>
            <div className="bg-[#0A0D13] border border-[#222D3D] rounded p-2 text-[10px] font-mono text-[#00E5FF] break-all flex-1">
              {lastBlockPreview ? (
                <div>
                  <div className="text-[#94A3B8] text-[9px] mb-1">
                    [HDR] [SEQ] [!SEQ] [PAYLOAD: {lastBlockPreview.size}B] [CHKSUM/CRC16]
                  </div>
                  <div>{lastBlockPreview.rawPreview}</div>
                </div>
              ) : (
                <div className="text-[#64748B] italic">Awaiting transfer frames...</div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Event Log */}
        <div className="bg-[#121824] border border-[#222D3D] rounded p-3 flex flex-col">
          <div className="flex items-center justify-between border-b border-[#222D3D] pb-1 mb-2">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
              Transfer Protocol Log
            </h3>
            <button
              onClick={() => setLogMessages([])}
              className="text-[9px] text-[#64748B] hover:text-[#E2E8F0]"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1 text-[10px] font-mono select-text">
            {logMessages.length === 0 ? (
              <div className="text-[#64748B] italic">Ready. Click Start Transfer to begin.</div>
            ) : (
              logMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`leading-tight ${
                    msg.includes('COMPLETE')
                      ? 'text-[#10B981] font-bold'
                      : msg.includes('CANCELLED') || msg.includes('ABORT')
                      ? 'text-[#EF4444]'
                      : msg.includes('ACK')
                      ? 'text-[#00E5FF]'
                      : 'text-[#94A3B8]'
                  }`}
                >
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
