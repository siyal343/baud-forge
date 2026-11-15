import React, { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { DissectedField } from '../types';
import { Binary, ChevronLeft, ChevronRight } from 'lucide-react';

const ROWS_PER_PAGE = 32; // Spec 0051: 32 rows per page (row width is a Setting)

export const toAsciiChar = (b: number, fallback = '.'): string =>
  b >= 32 && b <= 126 ? String.fromCharCode(b) : fallback;

export const bytesToAscii = (bytes: number[], fallback = '.'): string =>
  bytes.map((b) => toAsciiChar(b, fallback)).join('');

export const findFieldAtOffset = (
  fields: DissectedField[] | undefined,
  byteIdx: number
): DissectedField | null =>
  fields?.find((f) => byteIdx >= f.offset && byteIdx < f.offset + f.length) ?? null;

export const DirectionBadge: React.FC<{ direction: string; isFault?: boolean }> = ({
  direction,
  isFault,
}) => {
  if (isFault || direction === 'FAULT') {
    return (
      <span className="px-1 py-0.5 bg-bf-fault/20 border border-bf-fault text-bf-fault rounded text-[10px] font-mono font-bold leading-none">
        FAULT
      </span>
    );
  }
  switch (direction) {
    case 'RX':
      return (
        <span className="px-1 py-0.5 bg-bf-ok/20 border border-bf-ok/60 text-bf-ok rounded text-[10px] font-mono font-bold leading-none">
          RX
        </span>
      );
    case 'TX':
      return (
        <span className="px-1 py-0.5 bg-bf-sky/20 border border-bf-sky/60 text-bf-sky rounded text-[10px] font-mono font-bold leading-none">
          TX
        </span>
      );
    case 'A->B':
    case 'B->A':
      return (
        <span className="px-1 py-0.5 bg-bf-warn/20 border border-bf-warn/60 text-bf-warn rounded text-[10px] font-mono font-bold leading-none">
          {direction}
        </span>
      );
    default:
      return (
        <span className="px-1 py-0.5 bg-bf-subpanel border border-bf-line text-bf-mute rounded text-[10px] font-mono leading-none">
          {direction}
        </span>
      );
  }
};

export interface HexInspectorProps {
  embedded?: boolean;
  onClose?: () => void;
}

export const HexInspector: React.FC<HexInspectorProps> = ({ embedded = false, onClose }) => {
  const {
    selectedPacket,
    selectedField,
    hoveredField,
    hoveredByteOffset,
    selectedByteOffset,
    autoScroll,
    setHoveredByteOffset,
    setSelectedByteOffset,
    selectField,
    setHoveredField,
    stepFrame,
    setAutoScroll,
  } = useWorkstationStore(
    useShallow((s) => ({
      selectedPacket: s.selectedPacket,
      selectedField: s.selectedField,
      hoveredField: s.hoveredField,
      hoveredByteOffset: s.hoveredByteOffset,
      selectedByteOffset: s.selectedByteOffset,
      autoScroll: s.autoScroll,
      setHoveredByteOffset: s.setHoveredByteOffset,
      setSelectedByteOffset: s.setSelectedByteOffset,
      selectField: s.selectField,
      setHoveredField: s.setHoveredField,
      stepFrame: s.stepFrame,
      setAutoScroll: s.setAutoScroll,
    }))
  );

  const hexBytesPerRow = useSettingsStore((s) => s.settings.hexBytesPerRow);
  const hexGrouping = useSettingsStore((s) => s.settings.hexGrouping);
  const hexShowAscii = useSettingsStore((s) => s.settings.hexShowAscii);

  const [page, setPage] = useState(0);

  const activeField = hoveredField || selectedField;
  const rawBytes = selectedPacket?.rawBytes || [];
  const bytesPerPage = ROWS_PER_PAGE * hexBytesPerRow;
  const totalPages = Math.max(1, Math.ceil(rawBytes.length / bytesPerPage));

  useEffect(() => {
    setPage(0);
  }, [selectedPacket?.seqId]);

  // Jump to page containing activeField when inspecting multi-page payloads
  useEffect(() => {
    if (activeField && activeField.offset !== undefined) {
      const targetPage = Math.floor(activeField.offset / bytesPerPage);
      if (targetPage < totalPages && targetPage >= 0) {
        setPage(targetPage);
      }
    }
  }, [activeField, totalPages, bytesPerPage]);

  // Group current page bytes into configurable-width rows
  const pageStart = page * bytesPerPage;
  const pageEnd = Math.min(rawBytes.length, pageStart + bytesPerPage);
  const pageBytes = rawBytes.slice(pageStart, pageEnd);

  const rows: { offset: number; bytes: number[] }[] = [];
  for (let i = 0; i < pageBytes.length; i += hexBytesPerRow) {
    rows.push({
      offset: pageStart + i,
      bytes: pageBytes.slice(i, i + hexBytesPerRow),
    });
  }

  // Column-header ruler mirroring the configured row width & grouping
  const headerCells: Array<{ label: string; gap: boolean }> = [];
  for (let col = 0; col < hexBytesPerRow; col++) {
    headerCells.push({
      label: col.toString(16).padStart(2, '0').toUpperCase(),
      gap: hexGrouping > 1 && col > 0 && col % hexGrouping === 0,
    });
  }

  const gridTemplateColumns = hexShowAscii
    ? `64px minmax(max-content, 1fr) ${hexBytesPerRow + 2}ch`
    : '64px minmax(max-content, 1fr)';

  const activeByteIdx = hoveredByteOffset ?? selectedByteOffset;

  const isByteHighlighted = (byteIdx: number) => {
    if (!activeField) return false;
    return byteIdx >= activeField.offset && byteIdx < activeField.offset + activeField.length;
  };

  const renderDecoderFooter = () => {
    if (!selectedPacket || rawBytes.length === 0) return null;
    const inspectIdx = Math.min(
      rawBytes.length - 1,
      Math.max(0, hoveredByteOffset ?? selectedByteOffset ?? activeField?.offset ?? 0)
    );
    const b = rawBytes[inspectIdx];
    const fieldAtInspectIdx =
      selectedField &&
      inspectIdx >= selectedField.offset &&
      inspectIdx < selectedField.offset + selectedField.length
        ? selectedField
        : findFieldAtOffset(selectedPacket.dissectedFields, inspectIdx);
    const inspectField = hoveredField ?? fieldAtInspectIdx;
    const asciiDisplay = b >= 32 && b <= 126 ? `'${toAsciiChar(b)}'` : '·';

    return (
      <div className="bg-bf-subpanel border-t border-bf-line px-2.5 py-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-bf-mute shrink-0">
        <span>
          <span className="text-bf-faint">OFFSET:</span>{' '}
          <span className="text-bf-body font-semibold">
            0x{inspectIdx.toString(16).padStart(4, '0').toUpperCase()} ({inspectIdx})
          </span>
        </span>
        <span>
          <span className="text-bf-faint">HEX:</span>{' '}
          <span className="text-bf-cyan font-semibold">
            0x{b.toString(16).padStart(2, '0').toUpperCase()}
          </span>
        </span>
        <span>
          <span className="text-bf-faint">U8:</span>{' '}
          <span className="text-bf-body">{b}</span>
          <span className="text-bf-line-strong mx-1">|</span>
          <span className="text-bf-faint">I8:</span>{' '}
          <span className="text-bf-body">{b > 127 ? b - 256 : b}</span>
        </span>
        {inspectIdx + 1 < rawBytes.length && (
          <span>
            <span className="text-bf-faint">U16LE:</span>{' '}
            <span className="text-bf-body">{b | (rawBytes[inspectIdx + 1] << 8)}</span>
          </span>
        )}
        <span>
          <span className="text-bf-faint">BIN:</span>{' '}
          <span className="text-bf-body">{b.toString(2).padStart(8, '0')}</span>
        </span>
        <span>
          <span className="text-bf-faint">ASCII:</span>{' '}
          <span className="text-bf-amber font-semibold">{asciiDisplay}</span>
        </span>
        {inspectField && (
          <span className="ml-auto px-1.5 py-0.5 rounded bg-bf-cyan/15 border border-bf-cyan/40 text-bf-cyan text-[10px] font-semibold truncate max-w-full">
            {inspectField.name} ({inspectField.type}) = {String(inspectField.decodedValue)}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-bf-deep select-none text-[12px] overflow-hidden">
      {/* Packet Identity Header Bar */}
      <div className="min-h-[26px] bg-bf-subpanel border-b border-bf-line px-2.5 py-1 flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Binary className="w-3.5 h-3.5 text-bf-cyan shrink-0" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[11px] shrink-0">
            HEX INSPECTOR
          </span>
          {selectedPacket && (
            <>
              <span className="px-1.5 py-0.5 rounded bg-bf-panel border border-bf-line font-mono font-semibold text-bf-cyan text-[11px] leading-none shrink-0">
                #{selectedPacket.seqId}
              </span>
              <DirectionBadge
                direction={selectedPacket.direction}
                isFault={selectedPacket.isFaultInjected}
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Page navigation controls if frame > 512 bytes */}
          {totalPages > 1 && (
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1 py-0.5 font-mono text-[11px]">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className={`p-0.5 rounded ${
                  page === 0 ? 'text-bf-faint cursor-not-allowed' : 'text-bf-body hover:text-bf-cyan'
                }`}
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <span className="text-bf-mute px-0.5">
                {pageStart}–{pageEnd}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className={`p-0.5 rounded ${
                  page >= totalPages - 1
                    ? 'text-bf-faint cursor-not-allowed'
                    : 'text-bf-body hover:text-bf-cyan'
                }`}
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Frame stepper buttons */}
          <div className="flex items-center rounded border border-bf-line overflow-hidden bg-bf-panel">
            <button
              type="button"
              onClick={() => stepFrame('back')}
              disabled={!selectedPacket}
              title="Previous frame"
              aria-label="Previous frame"
              className="px-1.5 py-0.5 text-[10px] font-mono text-bf-mute hover:text-bf-cyan hover:bg-bf-hover disabled:text-bf-ghost disabled:cursor-not-allowed transition-colors border-r border-bf-line"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => stepFrame('forward')}
              disabled={!selectedPacket}
              title="Next frame"
              aria-label="Next frame"
              className="px-1.5 py-0.5 text-[10px] font-mono text-bf-mute hover:text-bf-cyan hover:bg-bf-hover disabled:text-bf-ghost disabled:cursor-not-allowed transition-colors"
            >
              ▶
            </button>
          </div>

          {/* LIVE vs PINNED toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            title={
              autoScroll
                ? 'Live follow active — incoming frames update inspector (click to pin)'
                : 'Frame pinned — incoming frames will not overwrite selection (click for live)'
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold leading-none transition-colors ${
              autoScroll
                ? 'bg-bf-ok/20 border-bf-ok/60 text-bf-ok'
                : 'bg-bf-warn/20 border-bf-warn/60 text-bf-warn'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                autoScroll ? 'bg-bf-ok animate-pulse' : 'bg-bf-warn'
              }`}
            />
            {autoScroll ? 'LIVE' : 'PINNED'}
          </button>

          {embedded && onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close inline Hex Inspector"
              aria-label="Close Hex Inspector"
              className="px-1.5 py-0.5 rounded text-bf-faint hover:text-bf-body hover:bg-bf-hover font-mono text-[12px] leading-none transition-colors"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Correlated Metadata & Active Field Strip */}
      {selectedPacket && (
        <div className="min-h-[24px] bg-bf-head border-b border-bf-line px-2.5 py-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] font-mono shrink-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-bf-mute min-w-0">
            <span className="text-bf-body">{selectedPacket.port}</span>
            <span className="text-bf-faint">·</span>
            <span className="text-bf-mute">{selectedPacket.timeStr}</span>
            <span className="text-bf-faint">·</span>
            <span className="text-bf-cyan font-semibold">{selectedPacket.protocol}</span>
            <span className="text-bf-faint">·</span>
            <span className="text-bf-body">
              {rawBytes.length} B{totalPages > 1 ? ` (PG ${page + 1}/${totalPages})` : ''}
            </span>
          </div>

          {activeField && (
            <div
              data-tooltip={`Offset: 0x${activeField.offset.toString(16).padStart(2, '0').toUpperCase()}..0x${(activeField.offset + activeField.length - 1).toString(16).padStart(2, '0').toUpperCase()} | Value: ${String(activeField.decodedValue)}${activeField.unit ? ` ${activeField.unit}` : ''}`}
              className="flex items-center gap-1.5 text-[11px] font-mono text-bf-cyan truncate max-w-full cursor-help"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-bf-cyan animate-pulse shrink-0" />
              <span className="truncate">
                HL: {activeField.name} · 0x{activeField.offset.toString(16).padStart(2, '0').toUpperCase()}..0x
                {(activeField.offset + activeField.length - 1).toString(16).padStart(2, '0').toUpperCase()} ·{' '}
                {String(activeField.decodedValue)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Hex & ASCII Viewport */}
      <div className="flex-1 overflow-auto font-mono min-w-0">
        {!selectedPacket ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-bf-faint">
            <Binary className="w-5 h-5 mb-1.5 text-bf-faint" />
            <p className="text-[13px] font-semibold text-bf-mute mb-0.5">Awaiting Frame Selection</p>
            <p className="text-[11px] max-w-xs">
              Raw hexadecimal bytes and ASCII characters will display here.
            </p>
          </div>
        ) : rawBytes.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-bf-faint">
            <p className="text-[13px] font-semibold text-bf-mute mb-0.5">Empty Payload (0 B)</p>
            <p className="text-[11px] max-w-xs">
              Selected frame #{selectedPacket.seqId} contains no payload bytes.
            </p>
          </div>
        ) : (
          <div className="w-fit min-w-full pb-1">
            {/* Sticky Hex Table Header */}
            <div
              style={{ gridTemplateColumns }}
              className="sticky top-0 z-10 h-[22px] bg-bf-head border-b border-bf-line px-2 grid gap-2 text-[11px] font-mono text-bf-faint uppercase tracking-wider items-center"
            >
              <div>Offset</div>
              <div className="flex items-center gap-0.5">
                {headerCells.map((c, i) => (
                  <span
                    key={i}
                    className={`w-[22px] text-center ${c.gap ? 'ml-1.5' : ''}`}
                  >
                    {c.label}
                  </span>
                ))}
              </div>
              {hexShowAscii && (
                <div className="pl-2 border-l border-bf-line-soft/60 text-left">ASCII</div>
              )}
            </div>

            <div className="p-2 pt-1 divide-y divide-bf-line-soft/30">
              {rows.map((row) => (
                <div
                  key={row.offset}
                  style={{ gridTemplateColumns }}
                  className="grid gap-2 py-0.5 text-[12px] items-center hover:bg-bf-subpanel/50"
                >
                  {/* Offset in Hex */}
                  <div className="text-bf-faint text-[12px]">
                    {row.offset.toString(16).padStart(6, '0').toUpperCase()}
                  </div>

                  {/* Configured-width Hex Rows with configurable grouping */}
                  <div className="flex items-center gap-0.5 text-[12px]">
                    {Array.from({ length: hexBytesPerRow }).map((_, colIdx) => {
                      const byteIdx = row.offset + colIdx;
                      const hasByte = colIdx < row.bytes.length;
                      const byteVal = hasByte ? row.bytes[colIdx] : null;
                      const extraMargin =
                        hexGrouping > 1 && colIdx > 0 && colIdx % hexGrouping === 0 ? 'ml-1.5' : '';

                      if (!hasByte) {
                        return (
                          <span
                            key={colIdx}
                            className={`w-[22px] text-center text-transparent ${extraMargin}`}
                          >
                            ..
                          </span>
                        );
                      }

                      const fieldForByte = findFieldAtOffset(selectedPacket.dissectedFields, byteIdx);
                      const inActiveField = isByteHighlighted(byteIdx);
                      const isActiveByte = byteIdx === activeByteIdx;

                      const byteClasses = inActiveField
                        ? isActiveByte
                          ? 'bg-bf-cyan text-bf-onfill font-bold ring-2 ring-bf-amber shadow-[0_0_8px_rgb(var(--bf-cyan-rgb)/0.75)]'
                          : 'bg-bf-cyan text-bf-onfill font-bold shadow-[0_0_6px_rgb(var(--bf-cyan-rgb)/0.55)]'
                        : isActiveByte
                        ? 'bg-bf-active text-bf-bright font-bold ring-1 ring-bf-cyan'
                        : 'text-bf-dim hover:bg-bf-active hover:text-bf-bright';

                      return (
                        <span
                          key={colIdx}
                          onMouseEnter={() => {
                            setHoveredByteOffset(byteIdx);
                            setHoveredField(fieldForByte);
                          }}
                          onMouseLeave={() => {
                            setHoveredByteOffset(null);
                            setHoveredField(null);
                          }}
                          onClick={() => {
                            setSelectedByteOffset(byteIdx);
                            if (fieldForByte) selectField(fieldForByte);
                          }}
                          className={`w-[22px] text-center px-0.5 rounded cursor-pointer transition-colors ${extraMargin} ${byteClasses}`}
                        >
                          {byteVal!.toString(16).padStart(2, '0').toUpperCase()}
                        </span>
                      );
                    })}
                  </div>

                  {/* ASCII Representation */}
                  {hexShowAscii && (
                    <div className="pl-2 border-l border-bf-line-soft/60 flex items-center text-[12px] font-mono">
                      {row.bytes.map((b, idx) => {
                        const byteIdx = row.offset + idx;
                        const fieldForByte = findFieldAtOffset(selectedPacket.dissectedFields, byteIdx);
                        const inActiveField = isByteHighlighted(byteIdx);
                        const isActiveByte = byteIdx === activeByteIdx;

                        const asciiClasses = inActiveField
                          ? isActiveByte
                            ? 'bg-bf-cyan text-bf-onfill font-bold ring-1 ring-bf-amber'
                            : 'bg-bf-cyan/25 text-bf-cyan font-bold'
                          : isActiveByte
                          ? 'bg-bf-active text-bf-cyan font-bold ring-1 ring-bf-cyan'
                          : 'text-bf-faint hover:bg-bf-active hover:text-bf-bright';

                        return (
                          <span
                            key={idx}
                            onMouseEnter={() => {
                              setHoveredByteOffset(byteIdx);
                              setHoveredField(fieldForByte);
                            }}
                            onMouseLeave={() => {
                              setHoveredByteOffset(null);
                              setHoveredField(null);
                            }}
                            onClick={() => {
                              setSelectedByteOffset(byteIdx);
                              if (fieldForByte) selectField(fieldForByte);
                            }}
                            className={`inline-block w-[1ch] text-center rounded-[2px] cursor-pointer transition-colors ${asciiClasses}`}
                          >
                            {toAsciiChar(b)}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Live Byte Decoder Footer Bar */}
      {renderDecoderFooter()}
    </div>
  );
};
