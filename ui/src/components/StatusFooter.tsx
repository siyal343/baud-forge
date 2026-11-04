import React from 'react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { HardDrive, Zap, CheckCircle2, AlertOctagon } from 'lucide-react';

export const StatusFooter: React.FC = () => {
  const {
    isConnected,
    selectedPort,
    baudRate,
    framing,
    dataBits,
    parity,
    stopBits,
    pins,
    rxBytes,
    txBytes,
    packetRate,
    overruns,
    isSimulated,
  } = useWorkstationStore();

  const formatBytes = (bytes: number) => {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const PinLed = ({ label, active, color = 'bg-[#10B981]' }: { label: string; active: boolean; color?: string }) => (
    <div className="flex items-center gap-1 font-mono text-[10px]">
      <div
        className={`w-1.5 h-1.5 rounded-full ${
          active ? `${color} shadow-[0_0_4px_currentColor]` : 'bg-[#222D3D]'
        }`}
      />
      <span className={active ? 'text-[#E2E8F0]' : 'text-[#64748B]'}>{label}</span>
    </div>
  );

  return (
    <footer className="h-[20px] bg-[#10141D] border-t border-[#222D3D] px-2.5 flex items-center justify-between shrink-0 select-none text-[10px] font-mono text-[#94A3B8]">
      {/* Left: Port Link State & Parameters */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-[#10B981] animate-pulse' : 'bg-[#EF4444]'
            }`}
          />
          <span className="font-semibold text-[#E2E8F0]">
            {isConnected ? 'LINK OPEN' : 'LINK CLOSED'}
          </span>
          <span className="text-[#64748B]">
            [{selectedPort} {baudRate} {dataBits}{parity.charAt(0).toUpperCase()}{stopBits} / {framing.toUpperCase()}]
          </span>
        </div>

        {isSimulated && (
          <span className="px-1 py-0.2 bg-[#26324A] text-[#00E5FF] rounded text-[9px] border border-[#00E5FF]/40">
            SIMULATED
          </span>
        )}
      </div>

      {/* Center: Hardware Modem Lines LED Matrix */}
      <div className="flex items-center gap-2 px-2 py-0.2 bg-[#161C28] rounded border border-[#222D3D]">
        <PinLed label="CTS" active={pins.cts} />
        <PinLed label="DSR" active={pins.dsr} />
        <PinLed label="DCD" active={pins.dcd} />
        <PinLed label="RI" active={pins.ri} color="bg-[#F59E0B]" />
        <div className="w-[1px] h-2.5 bg-[#222D3D]" />
        <span className={`text-[9.5px] ${pins.dtr ? 'text-[#00E5FF]' : 'text-[#64748B]'}`}>
          DTR:{pins.dtr ? '1' : '0'}
        </span>
        <span className={`text-[9.5px] ${pins.rts ? 'text-[#00E5FF]' : 'text-[#64748B]'}`}>
          RTS:{pins.rts ? '1' : '0'}
        </span>
      </div>

      {/* Right: Telemetry Metrics & Overruns */}
      <div className="flex items-center gap-3">
        {/* Packet Rate */}
        <div className="flex items-center gap-1 text-[#64748B]">
          <Zap className="w-2.5 h-2.5 text-[#00E5FF]" />
          <span>{packetRate} pkt/s</span>
        </div>

        {/* Ingested Bytes */}
        <div className="flex items-center gap-1">
          <HardDrive className="w-2.5 h-2.5 text-[#94A3B8]" />
          <span>RX: {formatBytes(rxBytes)}</span>
          <span className="text-[#64748B]">|</span>
          <span>TX: {formatBytes(txBytes)}</span>
        </div>

        {/* Buffer Overrun Indicator */}
        <div className="flex items-center gap-1">
          {overruns === 0 ? (
            <span className="text-[#10B981] flex items-center gap-0.5">
              <CheckCircle2 className="w-2.5 h-2.5" />
              0 OVERRUNS
            </span>
          ) : (
            <span className="text-[#EF4444] font-bold flex items-center gap-0.5 animate-pulse">
              <AlertOctagon className="w-3 h-3" />
              {overruns} OVERRUNS
            </span>
          )}
        </div>

        <span className="text-[10px] text-[#64748B] pl-2 border-l border-[#222D3D]">
          CONTRACT v1
        </span>
      </div>
    </footer>
  );
};
