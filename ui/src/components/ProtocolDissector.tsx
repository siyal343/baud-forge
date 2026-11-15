import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { usePlotStore } from '../store/usePlotStore';
import { toast } from '../store/useToastStore';
import { DissectedField } from '../types';
import { CheckCircle2, AlertTriangle, Layers, LineChart } from 'lucide-react';

export const ProtocolDissector: React.FC = () => {
  const {
    selectedPacket,
    selectedField,
    hoveredField,
    selectField,
    setHoveredField,
    setSelectedByteOffset,
    bindScopeTrace,
  } = useWorkstationStore(
    useShallow((s) => ({
      selectedPacket: s.selectedPacket,
      selectedField: s.selectedField,
      hoveredField: s.hoveredField,
      selectField: s.selectField,
      setHoveredField: s.setHoveredField,
      setSelectedByteOffset: s.setSelectedByteOffset,
      bindScopeTrace: s.bindScopeTrace,
    }))
  );

  const fields = selectedPacket?.dissectedFields || [];
  const activeField = hoveredField || selectedField;
  const hasCrcError = selectedPacket?.hasError;

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[12px]">
      {/* Header */}
      <div className="min-h-[26px] bg-bf-subpanel border-b border-bf-line px-2.5 py-1 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Layers className="w-3.5 h-3.5 text-bf-cyan shrink-0" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[11px] shrink-0">
            DISSECTOR
          </span>
          {selectedPacket && (
            <span className="text-[11px] text-bf-cyan font-mono px-1.5 py-0.5 bg-bf-active rounded border border-bf-cyan/40 leading-none truncate">
              {selectedPacket.protocol} ({selectedPacket.length}B)
            </span>
          )}
        </div>

        {selectedPacket && (
          <div className="shrink-0">
            {hasCrcError ? (
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-bf-fault/20 border border-bf-fault text-bf-fault rounded text-[10px] font-mono font-bold leading-none">
                <AlertTriangle className="w-2.5 h-2.5" />
                CRC ERROR
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-bf-ok/20 border border-bf-ok/60 text-bf-ok rounded text-[10px] font-mono font-bold leading-none">
                <CheckCircle2 className="w-2.5 h-2.5" />
                CRC OK
              </span>
            )}
          </div>
        )}
      </div>

      {/* Column Headers */}
      <div className="h-[24px] bg-bf-head border-b border-bf-line grid grid-cols-[116px_80px_86px_1fr_56px] px-2 text-[11px] font-mono text-bf-faint uppercase tracking-wider items-center shrink-0">
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
            <p className="text-[13px] font-semibold text-bf-mute mb-0.5">No Frame Selected</p>
            <p className="text-[11px] max-w-xs">
              Select a packet in the packet stream to dissect its binary struct fields.
            </p>
          </div>
        ) : (
          fields.map((f: DissectedField) => {
            const isSelected =
              selectedField?.name === f.name && selectedField?.offset === f.offset;
            const isHovered =
              hoveredField?.name === f.name && hoveredField?.offset === f.offset;

            const rowClasses = isHovered
              ? isSelected
                ? 'bg-bf-active text-bf-bright border-l-2 border-bf-cyan ring-1 ring-inset ring-bf-cyan/60'
                : 'bg-bf-cyan/15 text-bf-bright border-l-2 border-bf-cyan/80'
              : isSelected
              ? 'bg-bf-active text-bf-bright border-l-2 border-bf-cyan'
              : f.isMutated
              ? 'bg-bf-fault/10 text-bf-fault-soft hover:bg-bf-fault/20'
              : 'hover:bg-bf-subpanel text-bf-dim';

            return (
              <div
                key={`${f.name}-${f.offset}`}
                onClick={() => {
                  selectField(f);
                  setSelectedByteOffset(null);
                }}
                onMouseEnter={() => setHoveredField(f)}
                onMouseLeave={() => setHoveredField(null)}
                className={`grid grid-cols-[116px_80px_86px_1fr_56px] px-2 py-0.5 text-[12px] items-center cursor-pointer transition-colors ${rowClasses}`}
              >
                {/* Field Name */}
                <div className="flex items-center gap-1 font-semibold truncate pr-1">
                  <span className="text-bf-cyan text-[10px]">▸</span>
                  <span
                    className={`truncate ${
                      isHovered || isSelected ? 'text-bf-cyan' : 'text-bf-body'
                    }`}
                  >
                    {f.name}
                  </span>
                </div>

                {/* Type */}
                <div className="text-bf-faint text-[11px] truncate pr-1">{f.type}</div>

                {/* Raw Hex */}
                <div className="text-bf-mute text-[12px] truncate pr-1">{f.rawHex}</div>

                {/* Decoded Value */}
                <div className="flex items-center gap-2 truncate pr-1">
                  {f.isMutated && f.originalValue ? (
                    <div className="flex items-center gap-1 text-[12px] truncate">
                      <span className="line-through text-bf-faint">{f.originalValue}</span>
                      <span className="text-bf-fault font-bold">{String(f.decodedValue)}</span>
                      <span className="text-[10px] bg-bf-fault/20 text-bf-fault px-1 rounded leading-tight">
                        MUTATED
                      </span>
                    </div>
                  ) : (
                    <span className="text-bf-body font-medium truncate">
                      {String(f.decodedValue)}
                    </span>
                  )}
                </div>

                {/* Units & Quick Plot Action */}
                <div className="flex items-center justify-between text-bf-faint text-[11px] gap-1">
                  <span className="truncate">{f.unit || '-'}</span>
                  {typeof f.decodedValue === 'number' && (
                    <button
                      type="button"
                      title={`Plot ${f.name} in Oscilloscope`}
                      onClick={(e) => {
                        e.stopPropagation();
                        // Spec 5.4: bind the field to a scope trace lane; the
                        // store feeds it from every frame that carries the field.
                        bindScopeTrace({ name: f.name, unit: f.unit });
                        const plotState = usePlotStore.getState();
                        const activeChart =
                          plotState.charts.find((c) => c.id === plotState.activeChartId) ??
                          plotState.charts[0];
                        if (
                          activeChart &&
                          !activeChart.channels.some(
                            (ch) => ch.source.kind === 'field' && ch.source.name === f.name
                          )
                        ) {
                          plotState.addChannel(
                            activeChart.id,
                            { kind: 'field', name: f.name },
                            { label: f.name, unit: f.unit }
                          );
                        }
                        toast.success(
                          'Field bound to scope',
                          `${f.name} now plots as a trace lane (open the Telemetry Oscilloscope).`
                        );
                      }}
                      className="text-bf-faint hover:text-bf-cyan p-0.5 shrink-0"
                    >
                      <LineChart className="w-3.5 h-3.5" />
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
        <div className="min-h-[24px] bg-bf-head border-t border-bf-line px-3 py-0.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-bf-mute shrink-0">
          <span className="text-bf-cyan">
            {hoveredField ? 'Hovered' : 'Selected'}:{' '}
            <span className="font-semibold">{activeField.name}</span>
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
