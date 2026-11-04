import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import {
  ArrowDownCircle,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  ArrowDown,
  Search,
  Settings2,
} from 'lucide-react';
import { UartConfigModal } from './UartConfigModal';

const ROW_HEIGHT = 20;
const OVERSCAN = 8;

interface ColumnDef {
  id: string;
  label: string;
  minWidth: number;
  defaultWidth: number;
}

const STREAM_COLUMNS: ColumnDef[] = [
  { id: 'seq', label: 'Seq', minWidth: 44, defaultWidth: 54 },
  { id: 'delta', label: 'Delta T', minWidth: 64, defaultWidth: 86 },
  { id: 'time', label: 'Time', minWidth: 60, defaultWidth: 76 },
  { id: 'dir', label: 'Dir', minWidth: 40, defaultWidth: 48 },
  { id: 'port', label: 'Port', minWidth: 44, defaultWidth: 54 },
  { id: 'len', label: 'Len', minWidth: 36, defaultWidth: 44 },
  { id: 'protocol', label: 'Protocol', minWidth: 65, defaultWidth: 96 },
  { id: 'summary', label: 'Decoded Summary / Raw Payload', minWidth: 160, defaultWidth: 380 },
];

export const PacketStreamView: React.FC = () => {
  const {
    packets,
    selectedPacket,
    autoScroll,
    filterText,
    directionFilter,
    dataBits,
    parity,
    stopBits,
    delimiterMode,
    selectPacket,
    setAutoScroll,
    clearStream,
    setFilterText,
    setDirectionFilter,
  } = useWorkstationStore(
    useShallow((s) => ({
      packets: s.packets,
      selectedPacket: s.selectedPacket,
      autoScroll: s.autoScroll,
      filterText: s.filterText,
      directionFilter: s.directionFilter,
      dataBits: s.dataBits,
      parity: s.parity,
      stopBits: s.stopBits,
      delimiterMode: s.delimiterMode,
      selectPacket: s.selectPacket,
      setAutoScroll: s.setAutoScroll,
      clearStream: s.clearStream,
      setFilterText: s.setFilterText,
      setDirectionFilter: s.setDirectionFilter,
    }))
  );

  const headerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const uartBtnRef = useRef<HTMLButtonElement>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [newFramesCount, setNewFramesCount] = useState(0);

  const [isUartModalOpen, setIsUartModalOpen] = useState(false);
  const [uartAnchorRect, setUartAnchorRect] = useState<DOMRect | null>(null);

  // Column Widths State (saved to / loaded from localStorage)
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('bforge_stream_col_widths');
      if (raw) {
        const parsed = JSON.parse(raw);
        const merged: Record<string, number> = {};
        STREAM_COLUMNS.forEach((c) => {
          merged[c.id] = typeof parsed[c.id] === 'number' ? parsed[c.id] : c.defaultWidth;
        });
        return merged;
      }
    } catch (_) {}
    const def: Record<string, number> = {};
    STREAM_COLUMNS.forEach((c) => {
      def[c.id] = c.defaultWidth;
    });
    return def;
  });

  const [resizingCol, setResizingCol] = useState<{ id: string; startX: number; startWidth: number } | null>(null);

  const startColResize = (colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingCol({
      id: colId,
      startX: e.clientX,
      startWidth: colWidths[colId] || STREAM_COLUMNS.find((c) => c.id === colId)!.defaultWidth,
    });
  };

  const resetColWidth = (colId: string) => {
    const col = STREAM_COLUMNS.find((c) => c.id === colId);
    if (!col) return;
    setColWidths((prev) => {
      const next = { ...prev, [colId]: col.defaultWidth };
      try {
        localStorage.setItem('bforge_stream_col_widths', JSON.stringify(next));
      } catch (_) {}
      return next;
    });
  };

  useEffect(() => {
    if (!resizingCol) return;
    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizingCol.startX;
      const col = STREAM_COLUMNS.find((c) => c.id === resizingCol.id);
      const minW = col ? col.minWidth : 36;
      const newW = Math.max(minW, Math.round(resizingCol.startWidth + deltaX));

      setColWidths((prev) => {
        const next = { ...prev, [resizingCol.id]: newW };
        try {
          localStorage.setItem('bforge_stream_col_widths', JSON.stringify(next));
        } catch (_) {}
        return next;
      });
    };

    const handleMouseUp = () => {
      setResizingCol(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizingCol]);

  const gridTemplateColumns = useMemo(() => {
    return `${colWidths.seq || 54}px ${colWidths.delta || 86}px ${colWidths.time || 76}px ${colWidths.dir || 48}px ${colWidths.port || 54}px ${colWidths.len || 44}px ${colWidths.protocol || 96}px minmax(${colWidths.summary || 380}px, 1fr)`;
  }, [colWidths]);

  const totalMinWidth = useMemo(() => {
    return STREAM_COLUMNS.reduce((acc, c) => acc + (colWidths[c.id] || c.defaultWidth), 0);
  }, [colWidths]);

  const directionFiltered = directionFilter === 'all'
    ? packets
    : packets.filter((p) => p.direction.toLowerCase() === directionFilter);

  const filteredPackets = filterText.trim()
    ? directionFiltered.filter((p) => {
        const query = filterText.toLowerCase();
        return (
          p.protocol.toLowerCase().includes(query) ||
          p.summary.toLowerCase().includes(query) ||
          p.rawHex.toLowerCase().includes(query) ||
          p.direction.toLowerCase().includes(query)
        );
      })
    : directionFiltered;

  const totalRows = filteredPackets.length;

  // Track container height for virtualization
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight || 500);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Handle scroll events & sync horizontal scroll with header
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      setScrollTop(target.scrollTop);
      if (headerRef.current) {
        headerRef.current.scrollLeft = target.scrollLeft;
      }

      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceFromBottom > 35) {
        if (autoScroll) setAutoScroll(false);
        setIsUserScrolledUp(true);
      } else {
        if (!autoScroll) setAutoScroll(true);
        setIsUserScrolledUp(false);
        setNewFramesCount(0);
      }
    },
    [autoScroll, setAutoScroll]
  );

  // Auto-scroll to bottom on incoming frames if follow mode active
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    } else if (isUserScrolledUp) {
      setNewFramesCount((prev) => prev + 1);
    }
  }, [packets.length, autoScroll, isUserScrolledUp]);

  const handleJumpToLive = () => {
    setAutoScroll(true);
    setIsUserScrolledUp(false);
    setNewFramesCount(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  const formatDelta = (us: number) => {
    const sign = us >= 0 ? '+' : '';
    return `${sign}${us.toString().padStart(6, '0')} μs`;
  };

  const getDirBadge = (dir: string, isFault?: boolean) => {
    if (isFault || dir === 'FAULT') {
      return (
        <span className="px-1 py-0.2 bg-[#EF4444]/20 border border-[#EF4444] text-[#EF4444] rounded text-[9px] font-bold">
          FAULT
        </span>
      );
    }
    switch (dir) {
      case 'RX':
        return (
          <span className="px-1 py-0.2 bg-[#10B981]/20 border border-[#10B981]/60 text-[#10B981] rounded text-[9px] font-bold">
            RX
          </span>
        );
      case 'TX':
        return (
          <span className="px-1 py-0.2 bg-[#38BDF8]/20 border border-[#38BDF8]/60 text-[#38BDF8] rounded text-[9px] font-bold">
            TX
          </span>
        );
      case 'A->B':
      case 'B->A':
        return (
          <span className="px-1 py-0.2 bg-[#F59E0B]/20 border border-[#F59E0B]/60 text-[#F59E0B] rounded text-[9px] font-bold">
            {dir}
          </span>
        );
      default:
        return (
          <span className="px-1 py-0.2 bg-[#161C28] text-[#94A3B8] rounded text-[9px]">
            {dir}
          </span>
        );
    }
  };

  // Virtual window bounds calculation
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visiblePackets = filteredPackets.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalRows - endIndex) * ROW_HEIGHT);

  const uartShorthand = `${dataBits}${parity.charAt(0).toUpperCase()}${stopBits}`;

  return (
    <div className="relative flex flex-col h-full bg-[#10141D] select-none text-[11px] overflow-hidden">
      {/* Sub-Header & Controls */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            PACKET STREAM
          </span>
          <span className="text-[9.5px] text-[#64748B] font-mono hidden sm:inline">
            {totalRows > 0 ? `ROWS ${startIndex + 1}–${endIndex} OF ${totalRows}` : '0 FRAMES'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-1 justify-end">
          {/* UART Line & Delimiter Settings Button */}
          <button
            ref={uartBtnRef}
            onClick={() => {
              if (uartBtnRef.current) {
                setUartAnchorRect(uartBtnRef.current.getBoundingClientRect());
              }
              setIsUartModalOpen(true);
            }}
            title="Configure serial frame delimiter and UART parameters (Data/Parity/Stop bits)"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#10141D] hover:bg-[#1E2638] border border-[#2D3A4E] hover:border-[#00E5FF]/50 text-[#94A3B8] hover:text-[#00E5FF] font-mono text-[9.5px] transition-colors"
          >
            <span className="font-bold text-[#E2E8F0]">{uartShorthand}</span>
            <span className="text-[#64748B]">·</span>
            <span className="text-[#00E5FF] uppercase font-semibold">{delimiterMode}</span>
            <Settings2 className="w-2.5 h-2.5 text-[#64748B] ml-0.5" />
          </button>

          {/* Direction filter chips (spec 2.3: All/RX/TX/FAULT) */}
          <div className="flex items-center rounded border border-[#222D3D] overflow-hidden shrink-0">
            {(['all', 'rx', 'tx', 'fault'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => setDirectionFilter(dir)}
                title={`Show only ${dir.toUpperCase()} frames`}
                className={`px-1.5 py-0.5 text-[9px] font-mono transition-colors ${
                  directionFilter === dir
                    ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold'
                    : 'text-[#64748B] hover:text-[#94A3B8] hover:bg-[#1E2638]'
                }`}
              >
                {dir.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Stream Search / Filter Input */}
          <div className="relative flex items-center min-w-[120px] max-w-[220px] flex-1">
            <Search className="w-3 h-3 absolute left-1.5 text-[#64748B] pointer-events-none" />
            <input
              type="text"
              placeholder="Filter stream (/)..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              title="Filter packet stream by protocol, hex bytes, direction (RX/TX/FAULT), or decoded summary"
              className="w-full h-[20px] bg-[#161C28] border border-[#222D3D] rounded pl-5 pr-4 text-[9.5px] text-[#E2E8F0] placeholder-[#64748B] focus:border-[#00E5FF] focus:outline-none font-mono"
            />
            {filterText && (
              <button
                onClick={() => setFilterText('')}
                title="Clear filter (Esc)"
                className="absolute right-1 text-[#64748B] hover:text-[#E2E8F0] text-[10px]"
              >
                ×
              </button>
            )}
          </div>

          {filterText && (
            <span className="text-[9px] px-1 py-0.2 rounded bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30 font-mono shrink-0">
              {filteredPackets.length} MATCH{filteredPackets.length === 1 ? '' : 'ES'}
            </span>
          )}

          {/* Autoscroll toggle */}
          <button
            onClick={() => {
              if (!autoScroll) handleJumpToLive();
              else setAutoScroll(false);
            }}
            className={`flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-mono transition-colors ${
              autoScroll
                ? 'bg-[#26324A] text-[#00E5FF] border border-[#00E5FF]/40'
                : 'text-[#64748B] hover:text-[#94A3B8]'
            }`}
          >
            <ArrowDownCircle className="w-2.5 h-2.5" />
            AUTO {autoScroll ? 'ON' : 'OFF'}
          </button>

          {/* Clear stream */}
          <button
            onClick={clearStream}
            title="Clear view buffer (preserves disk vault)"
            className="flex items-center gap-1 text-[#64748B] hover:text-[#EF4444] px-1 py-0.2 rounded text-[9.5px] font-mono transition-colors"
          >
            <Trash2 className="w-2.5 h-2.5" />
            CLEAR
          </button>
        </div>
      </div>

      {/* Table Column Headers (Centered text, proper separators, draggable resize) */}
      <div
        ref={headerRef}
        className="h-[22px] bg-[#121722] border-b border-[#222D3D] overflow-x-hidden overflow-y-hidden shrink-0 select-none"
      >
        <div
          style={{
            minWidth: `${totalMinWidth}px`,
            gridTemplateColumns,
          }}
          className="grid h-full text-[9.5px] font-mono text-[#64748B] uppercase tracking-wider items-center"
        >
          {STREAM_COLUMNS.map((col) => (
            <div
              key={col.id}
              className="relative h-full flex items-center justify-center text-center px-1 border-r border-[#222D3D] font-semibold select-none group"
            >
              <span className="truncate">{col.label}</span>
              {/* Draggable resize handle */}
              <div
                onMouseDown={(e) => startColResize(col.id, e)}
                onDoubleClick={() => resetColWidth(col.id)}
                title="Drag separator to resize column (Double-click to reset)"
                className="absolute right-0 top-0 bottom-0 w-2 -mr-1 cursor-col-resize z-20 group-hover:bg-[#00E5FF]/50 active:bg-[#00E5FF] transition-colors"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Virtualized Packet List Viewport */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono"
      >
        {totalRows === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#64748B]">
            <p className="text-xs font-semibold text-[#94A3B8] mb-1">Awaiting Packet Stream</p>
            <p className="text-[10px] max-w-sm mb-3">
              Incoming serial frames with microsecond timestamps will stream here automatically.
            </p>
            <button
              onClick={() => useWorkstationStore.getState().loadSampleCapture()}
              className="px-2.5 py-1 bg-[#161C28] hover:bg-[#26324A] border border-[#00E5FF]/40 text-[#00E5FF] rounded text-[11px] font-mono font-medium transition-colors"
            >
              Load Sample Capture Stream
            </button>
          </div>
        ) : (
          <div style={{ minWidth: `${totalMinWidth}px` }}>
            {/* Top Virtual Spacer */}
            <div style={{ height: `${topSpacerHeight}px` }} />

            {/* Rendered Visible Rows */}
            <div className="divide-y divide-[#1A2230]/40">
              {visiblePackets.map((pkt) => {
                const isSelected = selectedPacket?.seqId === pkt.seqId;
                return (
                  <div
                    key={pkt.seqId}
                    onClick={() => selectPacket(pkt)}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      gridTemplateColumns,
                    }}
                    className={`grid text-[11px] items-center cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#26324A] text-white'
                        : pkt.isFaultInjected
                        ? 'bg-[#EF4444]/10 hover:bg-[#EF4444]/15 text-[#FCA5A5]'
                        : 'hover:bg-[#161C28] text-[#CBD5E1]'
                    }`}
                  >
                    {/* Seq ID - Centered */}
                    <div className="h-full flex items-center justify-center text-center font-semibold text-[#94A3B8] border-r border-[#1E293B]/40 px-1 truncate">
                      #{String(pkt.seqId).padStart(5, '0')}
                    </div>

                    {/* Delta Time - Centered */}
                    <div className="h-full flex items-center justify-center text-center text-[#64748B] text-[10px] border-r border-[#1E293B]/40 px-1 truncate">
                      {formatDelta(pkt.deltaUs)}
                    </div>

                    {/* Absolute Time - Centered */}
                    <div className="h-full flex items-center justify-center text-center text-[#94A3B8] text-[10px] border-r border-[#1E293B]/40 px-1 truncate">
                      {pkt.timeStr}
                    </div>

                    {/* Direction - Centered */}
                    <div className="h-full flex items-center justify-center border-r border-[#1E293B]/40 px-1">
                      {getDirBadge(pkt.direction, pkt.isFaultInjected)}
                    </div>

                    {/* Port - Centered */}
                    <div className="h-full flex items-center justify-center text-center text-[#64748B] text-[10px] border-r border-[#1E293B]/40 px-1 truncate">
                      {pkt.port}
                    </div>

                    {/* Length - Centered */}
                    <div className="h-full flex items-center justify-center text-center text-[#94A3B8] text-[10px] border-r border-[#1E293B]/40 px-1 truncate">
                      {pkt.length}B
                    </div>

                    {/* Protocol Tag - Centered */}
                    <div className="h-full flex items-center justify-center text-center font-semibold text-[#00E5FF] text-[10.5px] border-r border-[#1E293B]/40 px-1 truncate">
                      {pkt.protocol}
                    </div>

                    {/* Summary / Error Info */}
                    <div className="h-full flex items-center gap-2 truncate px-2 border-r border-[#1E293B]/40">
                      {pkt.hasError ? (
                        <span className="flex items-center gap-1 text-[#EF4444] font-semibold text-[10px] shrink-0">
                          <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                          {pkt.errorMsg || 'CRC ERROR'}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[#10B981] text-[10px] shrink-0">
                          <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                        </span>
                      )}
                      <span className="truncate text-[#94A3B8]">{pkt.summary}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Bottom Virtual Spacer */}
            <div style={{ height: `${bottomSpacerHeight}px` }} />
          </div>
        )}
      </div>

      {/* Floating Jump-to-Live Pill Button */}
      {isUserScrolledUp && (
        <button
          onClick={handleJumpToLive}
          className="absolute bottom-3 right-4 flex items-center gap-1.5 px-3 py-1 bg-[#00E5FF] text-[#0A0D13] font-bold text-[10px] rounded-full shadow-[0_2px_10px_rgba(0,229,255,0.4)] hover:bg-[#00B4D8] transition-all z-20 cursor-pointer animate-pulse"
        >
          <ArrowDown className="w-3 h-3" />
          <span>JUMP TO LIVE {newFramesCount > 0 ? `(${newFramesCount} NEW)` : ''}</span>
        </button>
      )}

      {/* Port Framing & Delimiter Modal */}
      <UartConfigModal
        isOpen={isUartModalOpen}
        onClose={() => setIsUartModalOpen(false)}
        anchorRect={uartAnchorRect}
      />
    </div>
  );
};
