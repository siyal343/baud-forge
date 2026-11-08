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

  const PinLed = ({ label, active, color = 'bg-bf-ok' }: { label: string; active: boolean; color?: string }) => (
    <div className="flex items-center gap-1 font-mono text-[10px]">
      <div
        className={`w-1.5 h-1.5 rounded-full ${
          active ? `${color} shadow-[0_0_4px_currentColor]` : 'bg-bf-line'
        }`}
      />
      <span className={active ? 'text-bf-body' : 'text-bf-faint'}>{label}</span>
    </div>
  );

  return (
    <footer className="h-[20px] bg-bf-panel border-t border-bf-line px-2.5 flex items-center justify-between shrink-0 select-none text-[10px] font-mono text-bf-mute">
      {/* Left: Port Link State & Parameters */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isConnected ? 'bg-bf-ok animate-pulse' : 'bg-bf-fault'
            }`}
          />
          <span className="font-semibold text-bf-body">
            {isConnected ? 'LINK OPEN' : 'LINK CLOSED'}
          </span>
          <span className="text-bf-faint">
            [{selectedPort} {baudRate} {dataBits}{parity.charAt(0).toUpperCase()}{stopBits} / {framing.toUpperCase()}]
          </span>
        </div>

        {isSimulated && (
          <span className="px-1 py-0.2 bg-bf-active text-bf-cyan rounded text-[9px] border border-bf-cyan/40">
            SIMULATED
          </span>
        )}
      </div>

      {/* Center: Hardware Modem Lines LED Matrix */}
      <div className="flex items-center gap-2 px-2 py-0.2 bg-bf-subpanel rounded border border-bf-line">
        <PinLed label="CTS" active={pins.cts} />
        <PinLed label="DSR" active={pins.dsr} />
        <PinLed label="DCD" active={pins.dcd} />
        <PinLed label="RI" active={pins.ri} color="bg-bf-warn" />
        <div className="w-[1px] h-2.5 bg-bf-line" />
        <span className={`text-[9.5px] ${pins.dtr ? 'text-bf-cyan' : 'text-bf-faint'}`}>
          DTR:{pins.dtr ? '1' : '0'}
        </span>
        <span className={`text-[9.5px] ${pins.rts ? 'text-bf-cyan' : 'text-bf-faint'}`}>
          RTS:{pins.rts ? '1' : '0'}
        </span>
      </div>

      {/* Right: Telemetry Metrics & Overruns */}
      <div className="flex items-center gap-3">
        {/* Packet Rate */}
        <div className="flex items-center gap-1 text-bf-faint">
          <Zap className="w-2.5 h-2.5 text-bf-cyan" />
          <span>{packetRate} pkt/s</span>
        </div>

        {/* Ingested Bytes */}
        <div className="flex items-center gap-1">
          <HardDrive className="w-2.5 h-2.5 text-bf-mute" />
          <span>RX: {formatBytes(rxBytes)}</span>
          <span className="text-bf-faint">|</span>
          <span>TX: {formatBytes(txBytes)}</span>
        </div>

        {/* Buffer Overrun Indicator */}
        <div className="flex items-center gap-1">
          {overruns === 0 ? (
            <span className="text-bf-ok flex items-center gap-0.5">
              <CheckCircle2 className="w-2.5 h-2.5" />
              0 OVERRUNS
            </span>
          ) : (
            <span className="text-bf-fault font-bold flex items-center gap-0.5 animate-pulse">
              <AlertOctagon className="w-3 h-3" />
              {overruns} OVERRUNS
            </span>
          )}
        </div>

        <span className="text-[10px] text-bf-faint pl-2 border-l border-bf-line">
          CONTRACT v1
        </span>
      </div>
    </footer>
  );
};
