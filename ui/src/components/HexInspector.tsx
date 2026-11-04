import React, { useState, useEffect } from 'react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { Binary, ChevronLeft, ChevronRight } from 'lucide-react';

const BYTES_PER_PAGE = 512; // Spec 0051: 32 rows of 16 bytes per page

export const HexInspector: React.FC = () => {
  const { selectedPacket, selectedField, hoveredField } = useWorkstationStore();

  const [page, setPage] = useState(0);

  const activeField = hoveredField || selectedField;
  const rawBytes = selectedPacket?.rawBytes || [];
  const totalPages = Math.max(1, Math.ceil(rawBytes.length / BYTES_PER_PAGE));

  // Reset page when frame changes, or jump to page containing activeField
  useEffect(() => {
    if (activeField && activeField.offset !== undefined) {
      const targetPage = Math.floor(activeField.offset / BYTES_PER_PAGE);
      if (targetPage < totalPages && targetPage >= 0) {
        setPage(targetPage);
        return;
      }
    }
  }, [activeField, totalPages]);

  useEffect(() => {
    setPage(0);
  }, [selectedPacket?.seqId]);

  // Group current page bytes into 16-byte rows
  const pageStart = page * BYTES_PER_PAGE;
  const pageEnd = Math.min(rawBytes.length, pageStart + BYTES_PER_PAGE);
  const pageBytes = rawBytes.slice(pageStart, pageEnd);

  const rows: { offset: number; bytes: number[] }[] = [];
  for (let i = 0; i < pageBytes.length; i += 16) {
    rows.push({
      offset: pageStart + i,
      bytes: pageBytes.slice(i, i + 16),
    });
  }

  // Determine if a byte index is within the highlighted field range
  const isByteHighlighted = (byteIdx: number) => {
    if (!activeField) return false;
    const start = activeField.offset;
    const end = activeField.offset + activeField.length;
    return byteIdx >= start && byteIdx < end;
  };

  const toAsciiChar = (b: number) => {
    if (b >= 32 && b <= 126) {
      return String.fromCharCode(b);
    }
    return '.';
  };

  return (
    <div className="flex flex-col h-full bg-[#0D111A] select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Binary className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            HEX INSPECTOR
          </span>
          <span className="text-[9.5px] text-[#64748B] font-mono">
            {rawBytes.length} BYTES {totalPages > 1 ? `(PG ${page + 1}/${totalPages})` : ''}
          </span>
        </div>

        {/* Page navigation controls if frame > 512 bytes */}
        {totalPages > 1 && (
          <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.2 font-mono text-[9px]">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className={`p-0.5 rounded ${
                page === 0 ? 'text-[#64748B] cursor-not-allowed' : 'text-[#E2E8F0] hover:text-[#00E5FF]'
              }`}
            >
              <ChevronLeft className="w-2.5 h-2.5" />
            </button>
            <span className="text-[#94A3B8] px-0.5">
              {pageStart}–{pageEnd}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className={`p-0.5 rounded ${
                page >= totalPages - 1
                  ? 'text-[#64748B] cursor-not-allowed'
                  : 'text-[#E2E8F0] hover:text-[#00E5FF]'
              }`}
            >
              <ChevronRight className="w-2.5 h-2.5" />
            </button>
          </div>
        )}

        {activeField && (
          <div className="flex items-center gap-1.5 text-[9.5px] font-mono text-[#00E5FF] truncate">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00E5FF] animate-pulse" />
            <span className="truncate">
              HL: {activeField.name} ({activeField.length}B)
            </span>
          </div>
        )}
      </div>

      {/* Hex Table Header */}
      <div className="h-[22px] bg-[#121722] border-b border-[#222D3D] px-2 grid grid-cols-[60px_1fr_90px] text-[9.5px] font-mono text-[#64748B] uppercase tracking-wider items-center shrink-0 min-w-[380px]">
        <div>Offset</div>
        <div className="tracking-widest">
          00 01 02 03&nbsp;&nbsp;04 05 06 07&nbsp;&nbsp;08 09 0A 0B&nbsp;&nbsp;0C 0D 0E 0F
        </div>
        <div className="text-right">ASCII</div>
      </div>

      {/* Hex & ASCII Viewport */}
      <div className="flex-1 overflow-auto font-mono p-2 divide-y divide-[#1A2230]/30 min-w-0">
        {!selectedPacket ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#64748B]">
            <Binary className="w-5 h-5 mb-1.5 text-[#64748B]" />
            <p className="text-xs font-semibold text-[#94A3B8] mb-0.5">Awaiting Frame Selection</p>
            <p className="text-[10px] max-w-xs">
              Raw hexadecimal bytes and ASCII characters will display here.
            </p>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.offset}
              className="grid grid-cols-[60px_1fr_90px] py-0.5 text-[11px] items-center hover:bg-[#161C28]/50 min-w-[380px]"
            >
              {/* Offset in Hex */}
              <div className="text-[#64748B] text-[10px]">
                {row.offset.toString(16).padStart(6, '0').toUpperCase()}
              </div>

              {/* 16 Hex Bytes with 4-byte Spacing */}
              <div className="flex items-center gap-0.5 text-[10.5px]">
                {Array.from({ length: 16 }).map((_, colIdx) => {
                  const globalIdx = row.offset + colIdx;
                  const hasByte = colIdx < row.bytes.length;
                  const byteVal = hasByte ? row.bytes[colIdx] : null;
                  const highlighted = hasByte && isByteHighlighted(globalIdx);

                  const extraMargin = colIdx > 0 && colIdx % 4 === 0 ? 'ml-1.5' : '';

                  if (!hasByte) {
                    return (
                      <span key={colIdx} className={`w-5 text-center text-transparent ${extraMargin}`}>
                        ..
                      </span>
                    );
                  }

                  return (
                    <span
                      key={colIdx}
                      className={`w-5 text-center px-0.5 rounded transition-colors ${extraMargin} ${
                        highlighted
                          ? 'bg-[#00E5FF] text-[#0A0D13] font-bold shadow-[0_0_6px_rgba(0,229,255,0.6)]'
                          : 'text-[#CBD5E1] hover:bg-[#26324A] hover:text-white'
                      }`}
                    >
                      {byteVal!.toString(16).padStart(2, '0').toUpperCase()}
                    </span>
                  );
                })}
              </div>

              {/* ASCII Representation */}
              <div className="text-right text-[#94A3B8] tracking-widest text-[10.5px] font-mono">
                {row.bytes.map((b, idx) => {
                  const globalIdx = row.offset + idx;
                  const highlighted = isByteHighlighted(globalIdx);
                  return (
                    <span
                      key={idx}
                      className={highlighted ? 'text-[#00E5FF] font-bold' : 'text-[#64748B]'}
                    >
                      {toAsciiChar(b)}
                    </span>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
