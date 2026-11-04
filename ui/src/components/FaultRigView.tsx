import React, { useState } from 'react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { engineApi } from '../services/engineApi';
import { ShieldAlert, ShieldCheck, Zap, AlertTriangle, RefreshCw } from 'lucide-react';

export const FaultRigView: React.FC = () => {
  const { selectedPort, isFaultArmed, toggleFaultArm } = useWorkstationStore();

  const [faultKind, setFaultKind] = useState<'bit_flip' | 'drop' | 'truncate' | 'corrupt_crc' | 'delay'>('bit_flip');
  const [flipRateExp, setFlipRateExp] = useState(5); // 10^-5
  const [dropEvery, setDropEvery] = useState(5);
  const [truncateBytes, setTruncateBytes] = useState(4);
  const [corruptCrcBytes, setCorruptCrcBytes] = useState(4);
  const [delayMs, setDelayMs] = useState(150);
  const [jitterMs, setJitterMs] = useState(30);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleApplyFault = async () => {
    if (!isFaultArmed) return;
    setStatusMsg(`Arming engine fault: ${faultKind}...`);
    try {
      let options: any = {};
      if (faultKind === 'bit_flip') {
        options.flip_rate = Math.pow(10, -flipRateExp);
      } else if (faultKind === 'drop') {
        options.drop_every = dropEvery;
      } else if (faultKind === 'truncate') {
        options.truncate = truncateBytes;
      } else if (faultKind === 'corrupt_crc') {
        options.corrupt_crc = corruptCrcBytes;
      } else if (faultKind === 'delay') {
        options.delay_ms = delayMs;
        options.jitter_ms = jitterMs;
      }

      await engineApi.setFaultConfig(selectedPort, faultKind, options);
      setStatusMsg(`Fault [${faultKind}] active`);
    } catch {
      setStatusMsg('Fault configuration failed');
    } finally {
      setTimeout(() => setStatusMsg(null), 2500);
    }
  };

  const handleDisarmAll = async () => {
    if (isFaultArmed) {
      toggleFaultArm();
    }
    await engineApi.setFaultConfig(selectedPort, 'off');
    setStatusMsg('All faults disarmed — clean link restored');
    setTimeout(() => setStatusMsg(null), 2000);
  };

  const triggerOneShotCorruptCrc = async () => {
    setStatusMsg('Dispatched one-shot CRC corruption...');
    // Send fault bad_crc 3 to physical firmware
    const faultHex = '66 61 75 6c 74 20 62 61 64 5f 63 72 63 20 33 0a';
    await engineApi.sendBytes(selectedPort, faultHex);
    setTimeout(() => setStatusMsg(null), 1500);
  };

  const triggerOneShotDrop = async () => {
    setStatusMsg('Dispatched one-shot frame drop...');
    // Send fault drop 2 to physical firmware
    const faultHex = '66 61 75 6c 74 20 64 72 6f 70 20 32 0a';
    await engineApi.sendBytes(selectedPort, faultHex);
    setTimeout(() => setStatusMsg(null), 1500);
  };

  return (
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-3 h-3 text-[#EF4444]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            HIL FAULT INJECTION RIG
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-[#1E2638] text-[#94A3B8] font-mono border border-[#222D3D]">
            HARDWARE IN THE LOOP
          </span>
        </div>

        {statusMsg && (
          <span className="text-[10px] font-mono text-[#00E5FF] animate-pulse">
            {statusMsg}
          </span>
        )}
      </div>

      {/* Master Safety Arm Interlock Strip */}
      <div
        className={`p-2 border-b flex items-center justify-between shrink-0 transition-colors ${
          isFaultArmed
            ? 'bg-[#EF4444]/20 border-[#EF4444] text-white'
            : 'bg-[#121722] border-[#222D3D] text-[#94A3B8]'
        }`}
      >
        <div className="flex items-center gap-2">
          {isFaultArmed ? (
            <AlertTriangle className="w-4 h-4 text-[#EF4444] animate-pulse" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-[#10B981]" />
          )}
          <div className="flex flex-col">
            <span className="font-mono font-bold text-[11px]">
              {isFaultArmed
                ? '⚠ MASTER FAULT INTERLOCK: ARMED (TRANSMITTING ERRORS)'
                : 'MASTER FAULT INTERLOCK: DISARMED (SAFE LINK)'}
            </span>
            <span className="text-[9.5px] text-[#64748B]">
              {isFaultArmed
                ? 'Target hardware will receive deliberate frame mutations, dropped packets and CRC errors.'
                : 'Serial packets pass unaltered without mutation.'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={isFaultArmed ? handleDisarmAll : toggleFaultArm}
            title={
              isFaultArmed
                ? 'Disarm fault injection interlock and restore clean serial wire'
                : 'Arm hardware fault injection rig to mutate outgoing wire bytes'
            }
            className={`flex items-center gap-1.5 px-3 py-1 rounded font-mono text-[10.5px] font-bold transition-all ${
              isFaultArmed
                ? 'bg-[#EF4444] hover:bg-[#DC2626] text-white shadow-[0_0_8px_rgba(239,68,68,0.5)]'
                : 'bg-[#161C28] border border-[#222D3D] text-[#94A3B8] hover:text-white hover:border-[#10B981]'
            }`}
          >
            {isFaultArmed ? (
              <>
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>DISARM ALL FAULTS</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                <span>ARM FAULT RIG</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Fault Parameters & Configuration */}
      <div className="flex-1 overflow-auto p-2 font-mono flex flex-col gap-3">
        {/* Fault Primitive Selector */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[#64748B] text-[10px] uppercase tracking-wider">
            Select Active Fault Primitive:
          </span>
          <div className="grid grid-cols-5 gap-1.5 bg-[#161C28] border border-[#222D3D] p-1 rounded">
            {[
              { id: 'bit_flip', label: 'BIT FLIP (BER)' },
              { id: 'drop', label: 'PACKET DROP' },
              { id: 'corrupt_crc', label: 'CORRUPT CRC' },
              { id: 'truncate', label: 'TRUNCATE' },
              { id: 'delay', label: 'BUS DELAY' },
            ].map((kind) => (
              <button
                key={kind.id}
                onClick={() => setFaultKind(kind.id as any)}
                className={`py-1 rounded text-center text-[10px] font-bold transition-colors ${
                  faultKind === kind.id
                    ? 'bg-[#26324A] text-[#00E5FF] border border-[#00E5FF]/50'
                    : 'text-[#64748B] hover:text-[#E2E8F0]'
                }`}
              >
                {kind.label}
              </button>
            ))}
          </div>
        </div>

        {/* Selected Primitive Controls */}
        <div className="bg-[#161C28] border border-[#222D3D] rounded p-2.5 flex flex-col gap-2">
          {faultKind === 'bit_flip' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">Bit Error Rate (BER):</span>
                <span className="text-[#00E5FF] font-bold text-[12px]">
                  10^-{flipRateExp} (1 error in {Math.pow(10, flipRateExp).toLocaleString()} bits)
                </span>
              </div>
              <input
                type="range"
                min="3"
                max="9"
                value={flipRateExp}
                onChange={(e) => setFlipRateExp(parseInt(e.target.value, 10))}
                className="w-full accent-[#00E5FF] cursor-pointer"
              />
              <span className="text-[#64748B] text-[10px]">
                Injects random single-bit flips across frame bytes before wire transmission.
              </span>
            </div>
          )}

          {faultKind === 'drop' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">Drop Ratio:</span>
                <span className="text-[#00E5FF] font-bold text-[12px]">
                  Drop 1 out of every {dropEvery} frames
                </span>
              </div>
              <input
                type="range"
                min="2"
                max="50"
                value={dropEvery}
                onChange={(e) => setDropEvery(parseInt(e.target.value, 10))}
                className="w-full accent-[#00E5FF] cursor-pointer"
              />
              <span className="text-[#64748B] text-[10px]">
                Simulates wireless link fading and UART buffer exhaustion by silently dropping frames.
              </span>
            </div>
          )}

          {faultKind === 'corrupt_crc' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">CRC Corruption Mask:</span>
                <span className="text-[#00E5FF] font-bold text-[12px]">
                  Invert {corruptCrcBytes} checksum bytes
                </span>
              </div>
              <input
                type="number"
                min="1"
                max="4"
                value={corruptCrcBytes}
                onChange={(e) => setCorruptCrcBytes(parseInt(e.target.value, 10) || 1)}
                className="w-24 bg-[#10141D] border border-[#222D3D] rounded px-2 py-0.5 text-[#E2E8F0]"
              />
              <span className="text-[#64748B] text-[10px]">
                Inverts the trailing CRC-32C/CRC-16 bytes to test whether receiver rejects invalid checksums.
              </span>
            </div>
          )}

          {faultKind === 'truncate' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">Truncate Bytes:</span>
                <span className="text-[#00E5FF] font-bold text-[12px]">
                  Cut off {truncateBytes} bytes from frame tail
                </span>
              </div>
              <input
                type="number"
                min="1"
                max="32"
                value={truncateBytes}
                onChange={(e) => setTruncateBytes(parseInt(e.target.value, 10) || 1)}
                className="w-24 bg-[#10141D] border border-[#222D3D] rounded px-2 py-0.5 text-[#E2E8F0]"
              />
              <span className="text-[#64748B] text-[10px]">
                Tests parser timeout resilience when packets are truncated mid-transfer.
              </span>
            </div>
          )}

          {faultKind === 'delay' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">Base Bus Latency:</span>
                <span className="text-[#00E5FF] font-bold text-[12px]">{delayMs} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="1000"
                value={delayMs}
                onChange={(e) => setDelayMs(parseInt(e.target.value, 10))}
                className="w-full accent-[#00E5FF] cursor-pointer"
              />
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#E2E8F0]">Random Timing Jitter:</span>
                <span className="text-[#FBBF24] font-bold text-[12px]">±{jitterMs} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="200"
                value={jitterMs}
                onChange={(e) => setJitterMs(parseInt(e.target.value, 10))}
                className="w-full accent-[#FBBF24] cursor-pointer"
              />
            </div>
          )}

          <button
            onClick={handleApplyFault}
            disabled={!isFaultArmed}
            className={`mt-1 py-1 rounded font-bold text-center transition-colors ${
              isFaultArmed
                ? 'bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13]'
                : 'bg-[#222D3D] text-[#64748B] cursor-not-allowed'
            }`}
          >
            {isFaultArmed ? 'APPLY LIVE MUTATION TO ENGINE' : 'ARM RIG ABOVE TO ACTIVATE'}
          </button>
        </div>

        {/* Quick One-Shot Hardware Triggers */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[#64748B] text-[10px] uppercase tracking-wider">
            Quick One-Shot Target Triggers (ESP32-C3 Firmware):
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={triggerOneShotCorruptCrc}
              className="flex items-center justify-center gap-1.5 p-2 bg-[#161C28] hover:bg-[#26324A] text-[#EF4444] border border-[#EF4444]/40 rounded font-bold text-[10px] transition-colors"
            >
              <Zap className="w-3 h-3" />
              <span>BURST 3 BAD CRC FRAMES</span>
            </button>
            <button
              onClick={triggerOneShotDrop}
              className="flex items-center justify-center gap-1.5 p-2 bg-[#161C28] hover:bg-[#26324A] text-[#F59E0B] border border-[#F59E0B]/40 rounded font-bold text-[10px] transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              <span>DROP NEXT 2 FRAMES</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
