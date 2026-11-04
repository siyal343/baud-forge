import React, { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useToastStore } from '../store/useToastStore';
import { engineApi } from '../services/engineApi';
import { Sliders, Play, Plus, Trash2, Cpu, RotateCcw, Zap } from 'lucide-react';

interface Step {
  id: number;
  dtr: boolean;
  rts: boolean;
  wait_ms: number;
}

export const PinSequencerView: React.FC = () => {
  const { selectedPort, pins, updatePins } = useWorkstationStore(
    useShallow((s) => ({
      selectedPort: s.selectedPort,
      pins: s.pins,
      updatePins: s.updatePins,
    }))
  );
  const pushToast = useToastStore((s) => s.pushToast);

  const [dtrState, setDtrState] = useState(pins.dtr);
  const [rtsState, setRtsState] = useState(pins.rts);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [steps, setSteps] = useState<Step[]>([
    { id: 1, dtr: false, rts: true, wait_ms: 50 },
    { id: 2, dtr: true, rts: false, wait_ms: 100 },
    { id: 3, dtr: true, rts: true, wait_ms: 50 },
  ]);

  const handleApplyPins = async (dtr: boolean, rts: boolean) => {
    setDtrState(dtr);
    setRtsState(rts);
    updatePins({ dtr, rts });
    const ok = await engineApi.setPins(selectedPort, dtr, rts);
    if (!ok) {
      pushToast('error', 'Pin toggle not delivered', `Engine did not accept DTR:${dtr ? 1 : 0}/RTS:${rts ? 1 : 0} for ${selectedPort}.`);
    }
  };

  const handlePulse = async (pulseMs: number) => {
    setStatusMsg(`Pulsing lines for ${pulseMs} ms...`);
    const ok = await engineApi.setPins(selectedPort, dtrState, rtsState, pulseMs);
    if (ok) {
      pushToast('success', 'Reset pulse sent', `${pulseMs} ms pulse on ${selectedPort}.`);
    } else {
      pushToast('error', 'Pulse not delivered', `Engine unreachable — no pulse on ${selectedPort}.`);
    }
    setTimeout(() => setStatusMsg(null), 1500);
  };

  const loadEsp32BootloaderMacro = () => {
    setSteps([
      { id: 1, dtr: false, rts: true, wait_ms: 50 },
      { id: 2, dtr: true, rts: false, wait_ms: 50 },
      { id: 3, dtr: true, rts: true, wait_ms: 20 },
    ]);
    setStatusMsg('Loaded ESP32 ROM Bootloader Macro');
    setTimeout(() => setStatusMsg(null), 2000);
  };

  const loadStm32ResetMacro = () => {
    setSteps([
      { id: 1, dtr: true, rts: true, wait_ms: 100 },
      { id: 2, dtr: true, rts: false, wait_ms: 50 },
    ]);
    setStatusMsg('Loaded STM32 Hardware Reset Macro');
    setTimeout(() => setStatusMsg(null), 2000);
  };

  const handleAddStep = () => {
    const nextId = steps.length > 0 ? Math.max(...steps.map((s) => s.id)) + 1 : 1;
    setSteps([...steps, { id: nextId, dtr: dtrState, rts: rtsState, wait_ms: 50 }]);
  };

  const handleRemoveStep = (id: number) => {
    setSteps(steps.filter((s) => s.id !== id));
  };

  const handleUpdateStep = (id: number, patch: Partial<Step>) => {
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const handleRunSequence = async () => {
    if (steps.length === 0) return;
    setRunning(true);
    setStatusMsg(`Executing ${steps.length}-step hardware sequence...`);
    try {
      const payload = steps.map((s) => ({
        dtr: s.dtr,
        rts: s.rts,
        wait_ms: s.wait_ms,
      }));
      const ok = await engineApi.runPinSequence(selectedPort, payload);
      if (ok) {
        setStatusMsg('Sequence completed successfully');
        pushToast('success', 'Pin sequence executed', `${steps.length}-step sequence completed on ${selectedPort}.`);
      } else {
        setStatusMsg('Engine unreachable — sequence NOT executed');
        pushToast('error', 'Sequence not executed', `The engine did not accept the ${steps.length}-step sequence for ${selectedPort}.`);
      }
    } catch {
      setStatusMsg('Sequence execution failed');
      pushToast('error', 'Sequence execution failed');
    } finally {
      setRunning(false);
      setTimeout(() => setStatusMsg(null), 2500);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Sliders className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            PIN SEQUENCER & MODEM LINES
          </span>
          <span
            data-tooltip="Timed GPIO pattern sequence generator for hardware reset & bootloader sequencing"
            className="text-[9.5px] px-1 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] font-mono border border-[#00E5FF]/30 cursor-help"
          >
            TIMED GPIO
          </span>
        </div>

        {statusMsg && (
          <span className="text-[10px] font-mono text-[#00E5FF] animate-pulse">
            {statusMsg}
          </span>
        )}
      </div>

      {/* Direct Manual Controls Bar */}
      <div className="bg-[#121722] border-b border-[#222D3D] p-2 flex items-center justify-between gap-3 shrink-0">
        {/* DTR Toggle */}
        <div className="flex items-center gap-2 bg-[#161C28] border border-[#222D3D] rounded px-2.5 py-1">
          <span className="font-mono font-semibold text-[#E2E8F0] text-[10.5px]">DTR LINE:</span>
          <button
            onClick={() => handleApplyPins(!dtrState, rtsState)}
            data-tooltip="Toggle DTR (Data Terminal Ready) UART hardware line"
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-colors ${
              dtrState
                ? 'bg-[#00E5FF] text-[#0A0D13]'
                : 'bg-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
            }`}
          >
            {dtrState ? 'ASSERTED (HIGH)' : 'DEASSERTED (LOW)'}
          </button>
        </div>

        {/* RTS Toggle */}
        <div className="flex items-center gap-2 bg-[#161C28] border border-[#222D3D] rounded px-2.5 py-1">
          <span className="font-mono font-semibold text-[#E2E8F0] text-[10.5px]">RTS LINE:</span>
          <button
            onClick={() => handleApplyPins(dtrState, !rtsState)}
            data-tooltip="Toggle RTS (Request To Send) UART hardware line"
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-colors ${
              rtsState
                ? 'bg-[#00E5FF] text-[#0A0D13]'
                : 'bg-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
            }`}
          >
            {rtsState ? 'ASSERTED (HIGH)' : 'DEASSERTED (LOW)'}
          </button>
        </div>

        {/* Quick Pulse */}
        <div className="flex items-center gap-1 font-mono text-[10px]">
          <button
            onClick={() => handlePulse(100)}
            data-tooltip="Emit a 100 ms active-low hardware reset pulse on DTR / RTS lines"
            className="flex items-center gap-1 px-2 py-1 bg-[#161C28] hover:bg-[#26324A] text-[#F59E0B] border border-[#F59E0B]/40 rounded transition-colors"
          >
            <Zap className="w-3 h-3" />
            <span>100ms RESET PULSE</span>
          </button>
        </div>
      </div>

      {/* Preset Macro Buttons */}
      <div className="bg-[#10141D] border-b border-[#222D3D] px-2 py-1 flex items-center gap-2 shrink-0 font-mono text-[9.5px]">
        <span className="text-[#64748B]">PRESET MACROS:</span>
        <button
          onClick={loadEsp32BootloaderMacro}
          data-tooltip="Macro: Strap GPIO0 LOW and pulse EN/NRST to enter ESP32 ROM bootloader"
          className="flex items-center gap-1 px-1.5 py-0.5 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] hover:text-[#00E5FF] rounded border border-[#222D3D] transition-colors"
        >
          <Cpu className="w-2.5 h-2.5" />
          <span>ESP32 ROM BOOTLOADER</span>
        </button>
        <button
          onClick={loadStm32ResetMacro}
          data-tooltip="Macro: Assert and release hardware NRST pin for STM32 system reset"
          className="flex items-center gap-1 px-1.5 py-0.5 bg-[#161C28] hover:bg-[#1E2638] text-[#94A3B8] hover:text-[#00E5FF] rounded border border-[#222D3D] transition-colors"
        >
          <RotateCcw className="w-2.5 h-2.5" />
          <span>STM32 NRST PIN RESET</span>
        </button>
      </div>

      {/* Sequence Step Table */}
      <div className="flex-1 overflow-auto p-2 font-mono">
        <div className="bg-[#161C28] border border-[#222D3D] rounded overflow-hidden">
          <div className="h-[22px] bg-[#121722] border-b border-[#222D3D] grid grid-cols-[40px_100px_100px_120px_1fr_40px] px-2 text-[9.5px] text-[#64748B] uppercase tracking-wider items-center">
            <div data-tooltip="Sequential execution step number">Step</div>
            <div data-tooltip="DTR logic state during this step">DTR State</div>
            <div data-tooltip="RTS logic state during this step">RTS State</div>
            <div data-tooltip="Dwell / pause time before executing the next transition step">Wait Time</div>
            <div data-tooltip="Microcontroller hardware pin action explanation">Description</div>
            <div data-tooltip="Delete step action" className="text-center">Del</div>
          </div>
          <div className="divide-y divide-[#222D3D]/50 text-[10.5px]">
            {steps.map((s, idx) => (
              <div
                key={s.id}
                className="grid grid-cols-[40px_100px_100px_120px_1fr_40px] px-2 py-1 items-center hover:bg-[#1E2638]"
              >
                <div className="text-[#64748B] font-bold">#{idx + 1}</div>
                <div>
                  <button
                    onClick={() => handleUpdateStep(s.id, { dtr: !s.dtr })}
                    data-tooltip={`Click to toggle DTR logic level for step #${idx + 1}`}
                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                      s.dtr
                        ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                        : 'bg-[#222D3D] text-[#64748B]'
                    }`}
                  >
                    {s.dtr ? 'HIGH (1)' : 'LOW (0)'}
                  </button>
                </div>
                <div>
                  <button
                    onClick={() => handleUpdateStep(s.id, { rts: !s.rts })}
                    data-tooltip={`Click to toggle RTS logic level for step #${idx + 1}`}
                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                      s.rts
                        ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40'
                        : 'bg-[#222D3D] text-[#64748B]'
                    }`}
                  >
                    {s.rts ? 'HIGH (1)' : 'LOW (0)'}
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    value={s.wait_ms}
                    onChange={(e) =>
                      handleUpdateStep(s.id, { wait_ms: parseInt(e.target.value, 10) || 10 })
                    }
                    data-tooltip="Duration in milliseconds to hold these pin states before next step (1 - 5000 ms)"
                    className="w-16 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.2 text-[10.5px] text-[#E2E8F0] focus:outline-none focus:border-[#00E5FF]"
                  />
                  <span className="text-[#64748B] text-[10px]">ms</span>
                </div>
                <div className="text-[#94A3B8] text-[10px] truncate">
                  {s.dtr && !s.rts
                    ? 'Drive MCU into Boot Mode'
                    : !s.dtr && s.rts
                    ? 'Assert Target Chip Reset'
                    : 'Normal Pin State'}
                </div>
                <div className="text-center">
                  <button
                    onClick={() => handleRemoveStep(s.id)}
                    data-tooltip={`Delete step #${idx + 1} from sequence`}
                    className="text-[#64748B] hover:text-[#EF4444] transition-colors p-0.5"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Buttons Below Table */}
        <div className="flex items-center justify-between mt-2">
          <button
            onClick={handleAddStep}
            data-tooltip="Append a new hardware pin transition step to the sequence"
            className="flex items-center gap-1 px-2.5 py-1 bg-[#161C28] hover:bg-[#26324A] text-[#94A3B8] hover:text-[#00E5FF] border border-[#222D3D] rounded text-[10.5px] font-mono transition-colors"
          >
            <Plus className="w-3 h-3" />
            <span>ADD TRANSITION STEP</span>
          </button>

          <button
            onClick={handleRunSequence}
            disabled={running || steps.length === 0}
            data-tooltip="Transmit timed hardware pin sequence to physical UART modem lines"
            className="flex items-center gap-1 px-3 py-1 bg-[#10B981] hover:bg-[#059669] disabled:opacity-50 text-[#0A0D13] font-bold rounded font-mono text-[10.5px] transition-colors shadow-sm"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>{running ? 'EXECUTING SEQUENCE...' : 'EXECUTE TIMED SEQUENCE'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
