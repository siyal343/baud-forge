// MITM Bridge Panel (spec 2.5 / Tool 5.7): join two session ports so bytes
// received on one side are written to the other — a hardware-in-the-middle
// relay with live forwarded/dropped counters. The engine owns the relay
// (session.rs bridges); this panel composes the set and shows the counters.
import React, { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Shuffle, Plus, Trash2, ArrowRightLeft } from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useToastStore } from '../store/useToastStore';
import { engineApi } from '../services/engineApi';

export const BridgePanel: React.FC = () => {
  const { enginePorts, bridges, selectedPort } = useWorkstationStore(
    useShallow((s) => ({
      enginePorts: s.enginePorts,
      bridges: s.bridges,
      selectedPort: s.selectedPort,
    }))
  );
  const pushToast = useToastStore((s) => s.pushToast);

  const [portA, setPortA] = useState(selectedPort);
  const [portB, setPortB] = useState('');
  const [forward, setForward] = useState(true);
  const [applying, setApplying] = useState(false);

  // Real engine session ports when connected; the static list otherwise.
  const portOptions = enginePorts.length
    ? enginePorts.map((p) => ({ id: p.id, label: `${p.id} (${p.device})` }))
    : [];

  const desired = (extra: Array<{ id: string; a: string; b: string; forward: boolean }>) => [
    ...bridges.map((b) => ({ id: b.id, a: b.a, b: b.b, forward: b.forward })),
    ...extra,
  ];

  const handleAdd = async () => {
    if (!portA || !portB) {
      pushToast('warn', 'Pick both bridge ends', 'Select port A and port B before arming the bridge.');
      return;
    }
    if (portA === portB) {
      pushToast('warn', 'Bridge ends identical', 'A bridge joins two DIFFERENT ports.');
      return;
    }
    setApplying(true);
    const id = `bridge-${Date.now().toString(36)}`;
    const result = await engineApi.setBridges(desired([{ id, a: portA, b: portB, forward }]));
    setApplying(false);
    if (result.ok) {
      pushToast('success', 'Bridge armed', `${portA} ⇄ ${portB}${forward ? ' (forwarding)' : ' (timeline only)'}.`);
    } else {
      pushToast('error', 'Bridge rejected', result.error ?? 'Engine did not accept the bridge set.');
    }
  };

  const handleRemove = async (id: string) => {
    setApplying(true);
    const result = await engineApi.setBridges(
      bridges.filter((b) => b.id !== id).map((b) => ({ id: b.id, a: b.a, b: b.b, forward: b.forward }))
    );
    setApplying(false);
    if (result.ok) {
      pushToast('info', 'Bridge removed');
    } else {
      pushToast('error', 'Remove failed', result.error ?? 'Engine did not confirm.');
    }
  };

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-bf-subpanel border-b border-bf-line px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Shuffle className="w-3 h-3 text-bf-purple" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[10.5px]">
            MITM BRIDGE &amp; RELAY
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-bf-hover text-bf-purple font-mono border border-bf-purple/30">
            HARDWARE IN THE MIDDLE
          </span>
        </div>
      </div>

      {/* Composer */}
      <div className="p-2 border-b border-bf-line flex flex-col gap-2 shrink-0 bg-bf-head">
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
          <div>
            <label className="text-[9.5px] text-bf-faint block mb-1 font-bold">PORT A (TAP)</label>
            <select
              value={portA}
              onChange={(e) => setPortA(e.target.value)}
              className="w-full bg-bf-panel border border-bf-line rounded px-2 py-1 text-xs text-bf-body font-mono focus:outline-none focus:border-bf-cyan"
            >
              <option value="">— select —</option>
              {portOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <ArrowRightLeft className="w-3.5 h-3.5 text-bf-purple mb-1.5" />
          <div>
            <label className="text-[9.5px] text-bf-faint block mb-1 font-bold">PORT B (INJECT)</label>
            <select
              value={portB}
              onChange={(e) => setPortB(e.target.value)}
              className="w-full bg-bf-panel border border-bf-line rounded px-2 py-1 text-xs text-bf-body font-mono focus:outline-none focus:border-bf-cyan"
            >
              <option value="">— select —</option>
              {portOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-[10px] font-mono text-bf-mute cursor-pointer">
          <input
            type="checkbox"
            checked={forward}
            onChange={(e) => setForward(e.target.checked)}
            className="accent-bf-purple"
          />
          Forward bytes A → B (uncheck for a passive shared timeline)
        </label>

        <button
          onClick={handleAdd}
          disabled={applying}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-bf-purple/15 hover:bg-bf-purple/25 text-bf-purple border border-bf-purple/50 rounded text-[10px] font-bold font-mono transition-colors disabled:opacity-50"
        >
          <Plus className="w-3 h-3" />
          {applying ? 'APPLYING…' : 'ARM BRIDGE'}
        </button>
        {portOptions.length === 0 && (
          <p className="text-[9px] text-bf-faint font-mono">
            No engine session ports yet — bridges join REAL session ports. Start the engine with two
            ports (or use quick-connect) to arm one.
          </p>
        )}
      </div>

      {/* Live bridge table */}
      <div className="flex-1 overflow-y-auto p-2 min-h-0">
        {bridges.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-bf-faint">
            <Shuffle className="w-6 h-6 mb-2 opacity-40 text-bf-purple" />
            <p className="text-[10px]">No bridges armed.</p>
            <p className="text-[9px] mt-1 max-w-[260px]">
              A forwarding bridge writes what PORT A receives into PORT B — intercept, log, and
              mutate traffic between two hardware links.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {bridges.map((b) => (
              <div
                key={b.id}
                className="bg-bf-head border border-bf-line rounded p-2 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-bf-body truncate">
                    {b.a} <ArrowRightLeft className="w-2.5 h-2.5 inline text-bf-purple" /> {b.b}
                    <span
                      className={`ml-1.5 text-[8.5px] px-1 py-0.2 rounded border ${
                        b.forward
                          ? 'bg-bf-purple/20 text-bf-purple border-bf-purple/40'
                          : 'bg-bf-hover text-bf-faint border-bf-line'
                      }`}
                    >
                      {b.forward ? 'FORWARDING' : 'PASSIVE'}
                    </span>
                  </div>
                  <div className="text-[9px] font-mono text-bf-faint mt-0.5">
                    forwarded {b.forwarded.toLocaleString()} B · dropped {b.dropped.toLocaleString()} B
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(b.id)}
                  disabled={applying}
                  title="Remove this bridge"
                  className="text-bf-faint hover:text-bf-fault p-1 disabled:opacity-50 shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
