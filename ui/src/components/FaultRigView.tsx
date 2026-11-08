import React, { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useToastStore } from '../store/useToastStore';
import { engineApi } from '../services/engineApi';
import { ShieldAlert, ShieldCheck, Zap, AlertTriangle, RefreshCw } from 'lucide-react';

export const FaultRigView: React.FC = () => {
  const { selectedPort, isFaultArmed, toggleFaultArm } = useWorkstationStore(
    useShallow((s) => ({
      selectedPort: s.selectedPort,
      isFaultArmed: s.isFaultArmed,
      toggleFaultArm: s.toggleFaultArm,
    }))
  );
  const pushToast = useToastStore((s) => s.pushToast);

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

      const ok = await engineApi.setFaultConfig(selectedPort, faultKind, options);
      if (ok) {
        setStatusMsg(`Fault [${faultKind}] active`);
        pushToast('success', 'Fault primitive applied', `${faultKind} is live on ${selectedPort}.`);
      } else {
        setStatusMsg('Engine unreachable — fault NOT applied');
        pushToast('error', 'Fault apply failed', `The bforge engine did not accept the ${faultKind} profile for ${selectedPort}.`);
      }
    } catch {
      setStatusMsg('Fault configuration failed');
      pushToast('error', 'Fault configuration failed');
    } finally {
      setTimeout(() => setStatusMsg(null), 2500);
    }
  };

  const handleDisarmAll = async () => {
    if (isFaultArmed) {
      toggleFaultArm();
    }
    const ok = await engineApi.setFaultConfig(selectedPort, 'off');
    if (ok) {
      setStatusMsg('All faults disarmed — clean link restored');
      pushToast('success', 'Faults disarmed', 'Clean link restored on ' + selectedPort + '.');
    } else {
      setStatusMsg('Engine unreachable — disarm command not delivered');
      pushToast('error', 'Disarm failed', `The engine did not accept the disarm command for ${selectedPort}.`);
    }
    setTimeout(() => setStatusMsg(null), 2000);
  };

  const triggerOneShotCorruptCrc = async () => {
    // Send fault bad_crc 3 to physical firmware
    const faultHex = '66 61 75 6c 74 20 62 61 64 5f 63 72 63 20 33 0a';
    const result = await engineApi.sendBytes(selectedPort, faultHex);
    if (result.ok) {
      setStatusMsg('Dispatched one-shot CRC corruption...');
      pushToast('success', 'One-shot CRC corruption sent', `3 bad-CRC frames requested on ${selectedPort}.`);
    } else {
      setStatusMsg('One-shot NOT delivered');
      pushToast('error', 'One-shot not delivered', result.error ?? `No engine connection on ${selectedPort}.`);
    }
    setTimeout(() => setStatusMsg(null), 1500);
  };

  const triggerOneShotDrop = async () => {
    // Send fault drop 2 to physical firmware
    const faultHex = '66 61 75 6c 74 20 64 72 6f 70 20 32 0a';
    const result = await engineApi.sendBytes(selectedPort, faultHex);
    if (result.ok) {
      setStatusMsg('Dispatched one-shot frame drop...');
      pushToast('success', 'One-shot frame drop sent', `2 dropped frames requested on ${selectedPort}.`);
    } else {
      setStatusMsg('One-shot NOT delivered');
      pushToast('error', 'One-shot not delivered', result.error ?? `No engine connection on ${selectedPort}.`);
    }
    setTimeout(() => setStatusMsg(null), 1500);
  };

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-bf-subpanel border-b border-bf-line px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-3 h-3 text-bf-fault" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[10.5px]">
            HIL FAULT INJECTION RIG
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-bf-hover text-bf-mute font-mono border border-bf-line">
            HARDWARE IN THE LOOP
          </span>
        </div>

        {statusMsg && (
          <span className="text-[10px] font-mono text-bf-cyan animate-pulse">
            {statusMsg}
          </span>
        )}
      </div>

      {/* Master Safety Arm Interlock Strip */}
      <div
        className={`p-2 border-b flex items-center justify-between shrink-0 transition-colors ${
          isFaultArmed
            ? 'bg-bf-fault/20 border-bf-fault text-white'
            : 'bg-bf-head border-bf-line text-bf-mute'
        }`}
      >
        <div className="flex items-center gap-2">
          {isFaultArmed ? (
            <AlertTriangle className="w-4 h-4 text-bf-fault animate-pulse" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-bf-ok" />
          )}
          <div className="flex flex-col">
            <span className="font-mono font-bold text-[11px]">
              {isFaultArmed
                ? '⚠ MASTER FAULT INTERLOCK: ARMED (TRANSMITTING ERRORS)'
                : 'MASTER FAULT INTERLOCK: DISARMED (SAFE LINK)'}
            </span>
            <span className="text-[9.5px] text-bf-faint">
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
                ? 'bg-bf-fault hover:bg-bf-fault-hi text-white shadow-[0_0_8px_rgb(var(--bf-fault-rgb)/0.5)]'
                : 'bg-bf-subpanel border border-bf-line text-bf-mute hover:text-white hover:border-bf-ok'
            }`}
          >
            {isFaultArmed ? (
              <>
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>DISARM ALL FAULTS</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-3.5 h-3.5 text-bf-ok" />
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
          <span className="text-bf-faint text-[10px] uppercase tracking-wider">
            Select Active Fault Primitive:
          </span>
          <div className="grid grid-cols-5 gap-1.5 bg-bf-subpanel border border-bf-line p-1 rounded">
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
                    ? 'bg-bf-active text-bf-cyan border border-bf-cyan/50'
                    : 'text-bf-faint hover:text-bf-body'
                }`}
              >
                {kind.label}
              </button>
            ))}
          </div>
        </div>

        {/* Selected Primitive Controls */}
        <div className="bg-bf-subpanel border border-bf-line rounded p-2.5 flex flex-col gap-2">
          {faultKind === 'bit_flip' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">Bit Error Rate (BER):</span>
                <span className="text-bf-cyan font-bold text-[12px]">
                  10^-{flipRateExp} (1 error in {Math.pow(10, flipRateExp).toLocaleString()} bits)
                </span>
              </div>
              <input
                type="range"
                min="3"
                max="9"
                value={flipRateExp}
                onChange={(e) => setFlipRateExp(parseInt(e.target.value, 10))}
                className="w-full accent-bf-cyan cursor-pointer"
              />
              <span className="text-bf-faint text-[10px]">
                Injects random single-bit flips across frame bytes before wire transmission.
              </span>
            </div>
          )}

          {faultKind === 'drop' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">Drop Ratio:</span>
                <span className="text-bf-cyan font-bold text-[12px]">
                  Drop 1 out of every {dropEvery} frames
                </span>
              </div>
              <input
                type="range"
                min="2"
                max="50"
                value={dropEvery}
                onChange={(e) => setDropEvery(parseInt(e.target.value, 10))}
                className="w-full accent-bf-cyan cursor-pointer"
              />
              <span className="text-bf-faint text-[10px]">
                Simulates wireless link fading and UART buffer exhaustion by silently dropping frames.
              </span>
            </div>
          )}

          {faultKind === 'corrupt_crc' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">CRC Corruption Mask:</span>
                <span className="text-bf-cyan font-bold text-[12px]">
                  Invert {corruptCrcBytes} checksum bytes
                </span>
              </div>
              <input
                type="number"
                min="1"
                max="4"
                value={corruptCrcBytes}
                onChange={(e) => setCorruptCrcBytes(parseInt(e.target.value, 10) || 1)}
                className="w-24 bg-bf-panel border border-bf-line rounded px-2 py-0.5 text-bf-body"
              />
              <span className="text-bf-faint text-[10px]">
                Inverts the trailing CRC-32C/CRC-16 bytes to test whether receiver rejects invalid checksums.
              </span>
            </div>
          )}

          {faultKind === 'truncate' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">Truncate Bytes:</span>
                <span className="text-bf-cyan font-bold text-[12px]">
                  Cut off {truncateBytes} bytes from frame tail
                </span>
              </div>
              <input
                type="number"
                min="1"
                max="32"
                value={truncateBytes}
                onChange={(e) => setTruncateBytes(parseInt(e.target.value, 10) || 1)}
                className="w-24 bg-bf-panel border border-bf-line rounded px-2 py-0.5 text-bf-body"
              />
              <span className="text-bf-faint text-[10px]">
                Tests parser timeout resilience when packets are truncated mid-transfer.
              </span>
            </div>
          )}

          {faultKind === 'delay' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">Base Bus Latency:</span>
                <span className="text-bf-cyan font-bold text-[12px]">{delayMs} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="1000"
                value={delayMs}
                onChange={(e) => setDelayMs(parseInt(e.target.value, 10))}
                className="w-full accent-bf-cyan cursor-pointer"
              />
              <div className="flex items-center justify-between">
                <span className="font-semibold text-bf-body">Random Timing Jitter:</span>
                <span className="text-bf-amber font-bold text-[12px]">±{jitterMs} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="200"
                value={jitterMs}
                onChange={(e) => setJitterMs(parseInt(e.target.value, 10))}
                className="w-full accent-bf-amber cursor-pointer"
              />
            </div>
          )}

          <button
            onClick={handleApplyFault}
            disabled={!isFaultArmed}
            className={`mt-1 py-1 rounded font-bold text-center transition-colors ${
              isFaultArmed
                ? 'bg-bf-cyan hover:bg-bf-cyan-hi text-bf-onfill'
                : 'bg-bf-line text-bf-faint cursor-not-allowed'
            }`}
          >
            {isFaultArmed ? 'APPLY LIVE MUTATION TO ENGINE' : 'ARM RIG ABOVE TO ACTIVATE'}
          </button>
        </div>

        {/* Quick One-Shot Hardware Triggers */}
        <div className="flex flex-col gap-1.5">
          <span className="text-bf-faint text-[10px] uppercase tracking-wider">
            Quick One-Shot Target Triggers (ESP32-C3 Firmware):
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={triggerOneShotCorruptCrc}
              className="flex items-center justify-center gap-1.5 p-2 bg-bf-subpanel hover:bg-bf-active text-bf-fault border border-bf-fault/40 rounded font-bold text-[10px] transition-colors"
            >
              <Zap className="w-3 h-3" />
              <span>BURST 3 BAD CRC FRAMES</span>
            </button>
            <button
              onClick={triggerOneShotDrop}
              className="flex items-center justify-center gap-1.5 p-2 bg-bf-subpanel hover:bg-bf-active text-bf-warn border border-bf-warn/40 rounded font-bold text-[10px] transition-colors"
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
