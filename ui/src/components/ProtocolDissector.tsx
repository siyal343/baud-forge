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
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px]">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Layers className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            DISSECTOR
          </span>
          {selectedPacket && (
            <span className="text-[9.5px] text-[#00E5FF] font-mono px-1 py-0.2 bg-[#26324A] rounded border border-[#00E5FF]/40">
              {selectedPacket.protocol} ({selectedPacket.length}B)
            </span>
          )}
        </div>

        {selectedPacket && (
          <div>
            {hasCrcError ? (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-[#EF4444]/20 border border-[#EF4444] text-[#EF4444] rounded text-[9.5px] font-mono font-bold">
                <AlertTriangle className="w-2.5 h-2.5" />
                CRC ERROR
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-[#10B981]/20 border border-[#10B981]/60 text-[#10B981] rounded text-[9.5px] font-mono font-bold">
                <CheckCircle2 className="w-2.5 h-2.5" />
                CRC OK
              </span>
            )}
          </div>
        )}
      </div>

      {/* Column Headers */}
      <div className="h-[22px] bg-[#121722] border-b border-[#222D3D] grid grid-cols-[105px_60px_65px_1fr_40px] px-2 text-[9.5px] font-mono text-[#64748B] uppercase tracking-wider items-center shrink-0">
        <div>Field</div>
        <div>Type</div>
        <div>Raw Hex</div>
        <div>Decoded Value</div>
        <div>Unit</div>
      </div>

      {/* Field Tree List */}
      <div className="flex-1 overflow-y-auto font-mono divide-y divide-[#1A2230]/40">
        {!selectedPacket ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#64748B]">
            <Layers className="w-5 h-5 mb-1.5 text-[#64748B]" />
            <p className="text-xs font-semibold text-[#94A3B8] mb-0.5">No Frame Selected</p>
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
                    ? 'bg-[#26324A] text-white border-l-2 border-[#00E5FF]'
                    : f.isMutated
                    ? 'bg-[#EF4444]/10 text-[#FCA5A5] hover:bg-[#EF4444]/20'
                    : 'hover:bg-[#161C28] text-[#CBD5E1]'
                }`}
              >
                {/* Field Name */}
                <div className="flex items-center gap-1 font-semibold truncate">
                  <span className="text-[#00E5FF] text-[9px]">▸</span>
                  <span className={`truncate ${isSelected ? 'text-[#00E5FF]' : 'text-[#E2E8F0]'}`}>
                    {f.name}
                  </span>
                </div>

                {/* Type */}
                <div className="text-[#64748B] text-[10px] truncate">{f.type}</div>

                {/* Raw Hex */}
                <div className="text-[#94A3B8] text-[10.5px] truncate">{f.rawHex}</div>

                {/* Decoded Value */}
                <div className="flex items-center gap-2 truncate">
                  {f.isMutated && f.originalValue ? (
                    <div className="flex items-center gap-1 text-xs">
                      <span className="line-through text-[#64748B]">{f.originalValue}</span>
                      <span className="text-[#EF4444] font-bold">{String(f.decodedValue)}</span>
                      <span className="text-[10px] bg-[#EF4444]/20 text-[#EF4444] px-1 rounded">
                        MUTATED
                      </span>
                    </div>
                  ) : (
                    <span className="text-[#E2E8F0] font-medium">{String(f.decodedValue)}</span>
                  )}
                </div>

                {/* Units & Quick Plot Action */}
                <div className="flex items-center justify-between text-[#64748B] text-[11px]">
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
                      className="text-[#64748B] hover:text-[#00E5FF] p-0.5"
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
        <div className="h-[24px] bg-[#121722] border-t border-[#222D3D] px-3 flex items-center justify-between text-[11px] font-mono text-[#94A3B8]">
          <span className="text-[#00E5FF]">
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
