import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { toast } from '../store/useToastStore';
import { DissectedField } from '../types';
import { CheckCircle2, AlertTriangle, Layers, LineChart } from 'lucide-react';

export const ProtocolDissector: React.FC = () => {
  const { selectedPacket, selectedField, hoveredField, selectField, setHoveredField, bindScopeTrace } =
    useWorkstationStore(
      useShallow((s) => ({
        selectedPacket: s.selectedPacket,
        selectedField: s.selectedField,
        hoveredField: s.hoveredField,
        selectField: s.selectField,
        setHoveredField: s.setHoveredField,
        bindScopeTrace: s.bindScopeTrace,
      }))
    );

  const fields = selectedPacket?.dissectedFields || [];
  const activeField = hoveredField || selectedField;

  const hasCrcError = selectedPacket?.hasError;

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px]">
      {/* Header */}
      <div className="h-[24px] bg-bf-subpanel border-b border-bf-line px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Layers className="w-3 h-3 text-bf-cyan" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[10.5px]">
            DISSECTOR
          </span>
          {selectedPacket && (
            <span className="text-[9.5px] text-bf-cyan font-mono px-1 py-0.2 bg-bf-active rounded border border-bf-cyan/40">
              {selectedPacket.protocol} ({selectedPacket.length}B)
            </span>
          )}
        </div>

        {selectedPacket && (
          <div>
            {hasCrcError ? (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-bf-fault/20 border border-bf-fault text-bf-fault rounded text-[9.5px] font-mono font-bold">
                <AlertTriangle className="w-2.5 h-2.5" />
                CRC ERROR
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-bf-ok/20 border border-bf-ok/60 text-bf-ok rounded text-[9.5px] font-mono font-bold">
                <CheckCircle2 className="w-2.5 h-2.5" />
                CRC OK
              </span>
            )}
          </div>
        )}
      </div>

      {/* Column Headers */}
      <div className="h-[22px] bg-bf-head border-b border-bf-line grid grid-cols-[105px_60px_65px_1fr_40px] px-2 text-[9.5px] font-mono text-bf-faint uppercase tracking-wider items-center shrink-0">
        <div>Field</div>
        <div>Type</div>
        <div>Raw Hex</div>
        <div>Decoded Value</div>
        <div>Unit</div>
      </div>

      {/* Field Tree List */}
      <div className="flex-1 overflow-y-auto font-mono divide-y divide-bf-line-soft/40">
        {!selectedPacket ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-bf-faint">
            <Layers className="w-5 h-5 mb-1.5 text-bf-faint" />
            <p className="text-xs font-semibold text-bf-mute mb-0.5">No Frame Selected</p>
            <p className="text-[10px] max-w-xs">
              Select a packet in the packet stream to dissect its binary struct fields.
            </p>
          </div>
        ) : (
          fields.map((f: DissectedField) => {
            const isSelected = activeField?.name === f.name;
            return (
              <div
                key={f.name}
                onClick={() => selectField(f)}
                onMouseEnter={() => setHoveredField(f)}
                onMouseLeave={() => setHoveredField(null)}
                className={`grid grid-cols-[105px_60px_65px_1fr_40px] px-2 py-0.5 text-[11px] items-center cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-bf-active text-white border-l-2 border-bf-cyan'
                    : f.isMutated
                    ? 'bg-bf-fault/10 text-bf-fault-soft hover:bg-bf-fault/20'
                    : 'hover:bg-bf-subpanel text-bf-dim'
                }`}
              >
                {/* Field Name */}
                <div className="flex items-center gap-1 font-semibold truncate">
                  <span className="text-bf-cyan text-[9px]">▸</span>
                  <span className={`truncate ${isSelected ? 'text-bf-cyan' : 'text-bf-body'}`}>
                    {f.name}
                  </span>
                </div>

                {/* Type */}
                <div className="text-bf-faint text-[10px] truncate">{f.type}</div>

                {/* Raw Hex */}
                <div className="text-bf-mute text-[10.5px] truncate">{f.rawHex}</div>

                {/* Decoded Value */}
                <div className="flex items-center gap-2 truncate">
                  {f.isMutated && f.originalValue ? (
                    <div className="flex items-center gap-1 text-xs">
                      <span className="line-through text-bf-faint">{f.originalValue}</span>
                      <span className="text-bf-fault font-bold">{String(f.decodedValue)}</span>
                      <span className="text-[10px] bg-bf-fault/20 text-bf-fault px-1 rounded">
                        MUTATED
                      </span>
                    </div>
                  ) : (
                    <span className="text-bf-body font-medium">{String(f.decodedValue)}</span>
                  )}
                </div>

                {/* Units & Quick Plot Action */}
                <div className="flex items-center justify-between text-bf-faint text-[11px]">
                  <span>{f.unit || '-'}</span>
                  {typeof f.decodedValue === 'number' && (
                    <button
                      title={`Plot ${f.name} in Oscilloscope`}
                      onClick={() => {
                        // Spec 5.4: bind the field to a scope trace lane; the
                        // store feeds it from every frame that carries the field.
                        bindScopeTrace({ name: f.name, unit: f.unit });
                        toast.success(
                          'Field bound to scope',
                          `${f.name} now plots as a trace lane (open the Telemetry Oscilloscope).`
                        );
                      }}
                      className="text-bf-faint hover:text-bf-cyan p-0.5"
                    >
                      <LineChart className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Field Offset Callout Info Banner */}
      {activeField && (
        <div className="h-[24px] bg-bf-head border-t border-bf-line px-3 flex items-center justify-between text-[11px] font-mono text-bf-mute">
          <span className="text-bf-cyan">
            Selected: <span className="font-semibold">{activeField.name}</span>
          </span>
          <span>
            Offset: 0x{activeField.offset.toString(16).padStart(2, '0').toUpperCase()}..0x
            {(activeField.offset + activeField.length - 1).toString(16).padStart(2, '0').toUpperCase()}{' '}
            ({activeField.length} byte{activeField.length > 1 ? 's' : ''})
          </span>
        </div>
      )}
    </div>
  );
};
