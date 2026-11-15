import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { HexInspector, bytesToAscii, DirectionBadge } from './HexInspector';
import {
  ArrowDownCircle,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  ArrowDown,
  Search,
} from 'lucide-react';

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

type PayloadMode = 'summary' | 'hex' | 'both';
type HexSplitMode = 'off' | 'bottom' | 'right';

interface ColumnDef {
  id: string;
  label: string;
  minWidth: number;
  defaultWidth: number;
}

const STREAM_COLUMNS: ColumnDef[] = [
  { id: 'seq', label: 'Seq', minWidth: 48, defaultWidth: 58 },
  { id: 'delta', label: 'Delta T', minWidth: 70, defaultWidth: 92 },
  { id: 'time', label: 'Time', minWidth: 72, defaultWidth: 94 },
  { id: 'dir', label: 'Dir', minWidth: 42, defaultWidth: 52 },
  { id: 'port', label: 'Port', minWidth: 48, defaultWidth: 62 },
  { id: 'len', label: 'Len', minWidth: 38, defaultWidth: 48 },
  { id: 'protocol', label: 'Protocol', minWidth: 70, defaultWidth: 98 },
  { id: 'summary', label: 'Decoded Summary / Hex + ASCII', minWidth: 180, defaultWidth: 400 },
];

const formatPayloadPreview = (rawBytes: number[], rawHex: string, maxBytes: number) => {
  if (rawBytes && rawBytes.length > 0) {
    const slice = rawBytes.slice(0, maxBytes);
    const hasMore = rawBytes.length > maxBytes;
    const hex =
      slice.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') +
      (hasMore ? ' …' : '');
    const ascii = bytesToAscii(slice) + (hasMore ? '…' : '');
    return { hex, ascii };
  }
  return { hex: rawHex || '', ascii: '' };
};

export const PacketStreamView: React.FC = () => {
  const {
    packets,
    selectedPacket,
    autoScroll,
    filterText,
    directionFilter,
    portFilter,
    errorsOnly,
    selectPacket,
    setAutoScroll,
    clearStream,
    setFilterText,
    setDirectionFilter,
    setPortFilter,
    setErrorsOnly,
  } = useWorkstationStore(
    useShallow((s) => ({
      packets: s.packets,
      selectedPacket: s.selectedPacket,
      autoScroll: s.autoScroll,
      filterText: s.filterText,
      directionFilter: s.directionFilter,
      portFilter: s.portFilter,
      errorsOnly: s.errorsOnly,
      selectPacket: s.selectPacket,
      setAutoScroll: s.setAutoScroll,
      clearStream: s.clearStream,
      setFilterText: s.setFilterText,
      setDirectionFilter: s.setDirectionFilter,
      setPortFilter: s.setPortFilter,
      setErrorsOnly: s.setErrorsOnly,
    }))
  );

  const headerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const splitBodyRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const lastSyncTriggerRef = useRef<string | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [newFramesCount, setNewFramesCount] = useState(0);
  const [payloadMode, setPayloadMode] = useState<PayloadMode>('both');
  const [hexSplit, setHexSplit] = useState<HexSplitMode>('bottom');
  const [splitRatio, setSplitRatio] = useState<number>(0.38);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

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

  const [resizingCol, setResizingCol] = useState<{
    id: string;
    startX: number;
    startWidth: number;
  } | null>(null);

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
      const minW = col ? col.minWidth : 38;
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

  // Split-pane drag handler between stream table and embedded HexInspector
  useEffect(() => {
    if (!isDraggingSplit || hexSplit === 'off') return;
    const handleMouseMove = (e: MouseEvent) => {
      const rect = splitBodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (hexSplit === 'bottom' && rect.height > 0) {
        const fraction = (rect.bottom - e.clientY) / rect.height;
        setSplitRatio(Math.min(0.75, Math.max(0.2, fraction)));
      } else if (hexSplit === 'right' && rect.width > 0) {
        const fraction = (rect.right - e.clientX) / rect.width;
        setSplitRatio(Math.min(0.75, Math.max(0.2, fraction)));
      }
    };

    const handleMouseUp = () => {
      setIsDraggingSplit(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = hexSplit === 'bottom' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDraggingSplit, hexSplit]);

  const gridTemplateColumns = useMemo(() => {
    return `${colWidths.seq || 58}px ${colWidths.delta || 92}px ${colWidths.time || 94}px ${colWidths.dir || 52}px ${colWidths.port || 62}px ${colWidths.len || 48}px ${colWidths.protocol || 98}px minmax(${colWidths.summary || 400}px, 1fr)`;
  }, [colWidths]);

  const totalMinWidth = useMemo(() => {
    return STREAM_COLUMNS.reduce((acc, c) => acc + (colWidths[c.id] || c.defaultWidth), 0);
  }, [colWidths]);

  // Spec 2.3 filters, applied cheapest first: port chips → direction →
  // errors-only kind → free text.
  const ports = useMemo(() => [...new Set(packets.map((p) => p.port))], [packets]);

  const filteredPackets = useMemo(() => {
    const portFiltered =
      portFilter === 'all' ? packets : packets.filter((p) => p.port === portFilter);
    const directionFiltered =
      directionFilter === 'all'
        ? portFiltered
        : portFiltered.filter((p) => p.direction.toLowerCase() === directionFilter);
    const kindFiltered = errorsOnly
      ? directionFiltered.filter((p) => p.hasError)
      : directionFiltered;
    const query = filterText.trim().toLowerCase();
    if (!query) return kindFiltered;
    return kindFiltered.filter(
      (p) =>
        p.protocol.toLowerCase().includes(query) ||
        p.summary.toLowerCase().includes(query) ||
        p.rawHex.toLowerCase().includes(query) ||
        p.direction.toLowerCase().includes(query)
    );
  }, [packets, portFilter, directionFilter, errorsOnly, filterText]);

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

  // Clear scrolled-up banner if autoScroll is resumed externally (e.g., HexInspector LIVE pill or DVR LIVE SNAP)
  useEffect(() => {
    if (autoScroll && isUserScrolledUp) {
      setIsUserScrolledUp(false);
      setNewFramesCount(0);
    }
  }, [autoScroll, isUserScrolledUp]);

  // Handle scroll events & sync horizontal scroll with header
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      setScrollTop(target.scrollTop);
      if (headerRef.current) {
        headerRef.current.scrollLeft = target.scrollLeft;
      }

      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }

      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceFromBottom > 35) {
        if (autoScroll) setAutoScroll(false);
        setIsUserScrolledUp(true);
      } else {
        if (isUserScrolledUp && !autoScroll) setAutoScroll(true);
        setIsUserScrolledUp(false);
        setNewFramesCount(0);
      }
    },
    [autoScroll, isUserScrolledUp, setAutoScroll]
  );

  // Auto-scroll to bottom on incoming frames if follow mode active. The write
  // is rAF-deferred and skipped when already at the bottom: at hundreds of
  // frames per second a synchronous forced scroll per batch saturated the main
  // thread (the whole workbench froze under load).
  useEffect(() => {
    if (!autoScroll || isUserScrolledUp || !containerRef.current) return;
    const raf = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 4) {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [packets.length, autoScroll, isUserScrolledUp]);

  // External selection scroll-sync: keep selected row visible when stepped/scrubbed/filtered
  useEffect(() => {
    if (autoScroll || !selectedPacket || !containerRef.current) {
      lastSyncTriggerRef.current = null;
      return;
    }
    const syncTrigger = `${selectedPacket.seqId}|${portFilter}|${directionFilter}|${errorsOnly}|${filterText}|${hexSplit}`;
    if (lastSyncTriggerRef.current === syncTrigger) return;
    lastSyncTriggerRef.current = syncTrigger;

    const el = containerRef.current;
    if (el.clientHeight <= ROW_HEIGHT) return;
    const idx = filteredPackets.findIndex((p) => p.seqId === selectedPacket.seqId);
    if (idx < 0) return;

    const rowTop = idx * ROW_HEIGHT;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - ROW_HEIGHT;
    if (rowTop < viewTop || rowTop > viewBottom) {
      const nextTop =
        rowTop < viewTop ? rowTop : Math.max(0, rowTop - el.clientHeight + ROW_HEIGHT);
      if (el.scrollTop !== nextTop) {
        programmaticScrollRef.current = true;
        el.scrollTop = nextTop;
        setScrollTop(nextTop);
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
    }
  }, [
    selectedPacket?.seqId,
    autoScroll,
    filteredPackets,
    portFilter,
    directionFilter,
    errorsOnly,
    filterText,
    hexSplit,
  ]);

  // Count frames the reader misses while they have scrolled up to study history.
  useEffect(() => {
    if (isUserScrolledUp && !autoScroll) {
      setNewFramesCount((prev) => prev + 1);
    }
  }, [packets.length, isUserScrolledUp, autoScroll]);

  const handleJumpToLive = () => {
    setAutoScroll(true);
    setIsUserScrolledUp(false);
    setNewFramesCount(0);
    if (containerRef.current) {
      programmaticScrollRef.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    }
  };

  const formatDelta = (us: number) => {
    const sign = us >= 0 ? '+' : '';
    return `${sign}${us.toString().padStart(6, '0')} μs`;
  };

  // Virtual window bounds calculation
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN
  );
  const visiblePackets = filteredPackets.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalRows - endIndex) * ROW_HEIGHT);

  const summaryHeaderLabel =
    payloadMode === 'summary'
      ? 'Decoded Summary'
      : payloadMode === 'hex'
      ? 'Raw Hex + ASCII'
      : 'Decoded Summary / Hex + ASCII';

  return (
    <div className="relative flex flex-col h-full bg-bf-panel select-none text-[12px] overflow-hidden">
      {/* Sub-Header & Controls */}
      <div className="min-h-[26px] bg-bf-subpanel border-b border-bf-line px-2.5 py-1 flex flex-wrap items-center justify-between shrink-0 gap-x-2 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[11px]">
            PACKET STREAM
          </span>
          <span className="text-[11px] text-bf-faint font-mono hidden sm:inline">
            {totalRows > 0 ? `ROWS ${startIndex + 1}–${endIndex} OF ${totalRows}` : '0 FRAMES'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 flex-1 justify-end">
          {/* Direction filter chips (spec 2.3: All/RX/TX/FAULT) */}
          <div className="flex items-center rounded border border-bf-line overflow-hidden shrink-0">
            {(['all', 'rx', 'tx', 'fault'] as const).map((dir) => (
              <button
                type="button"
                key={dir}
                onClick={() => setDirectionFilter(dir)}
                title={`Show only ${dir.toUpperCase()} frames`}
                className={`px-1.5 py-0.5 text-[11px] font-mono leading-none transition-colors ${
                  directionFilter === dir
                    ? 'bg-bf-cyan/20 text-bf-cyan font-bold'
                    : 'text-bf-faint hover:text-bf-mute hover:bg-bf-hover'
                }`}
              >
                {dir.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Port filter (spec 2.3 port_filter) */}
          {ports.length > 1 && (
            <select
              value={portFilter}
              onChange={(e) => setPortFilter(e.target.value)}
              title="Show only frames from one port"
              className="bg-bf-panel border border-bf-line rounded px-1.5 py-0.5 text-[11px] font-mono text-bf-mute focus:outline-none focus:border-bf-cyan max-w-[105px] shrink-0"
            >
              <option value="all">ALL PORTS</option>
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}

          {/* Errors-only kind filter (spec 2.3 packet_kind_filter) */}
          <button
            type="button"
            onClick={() => setErrorsOnly(!errorsOnly)}
            title="Show only frames with CRC/decode errors"
            className={`px-1.5 py-0.5 rounded text-[11px] font-mono leading-none transition-colors border shrink-0 ${
              errorsOnly
                ? 'bg-bf-fault/20 text-bf-fault border-bf-fault/50 font-bold'
                : 'text-bf-faint border-bf-line hover:text-bf-mute'
            }`}
          >
            ERRORS
          </button>

          {/* Payload column display mode */}
          <div
            className="flex items-center rounded border border-bf-line overflow-hidden shrink-0"
            title="Payload column display mode"
          >
            {([
              { id: 'summary', label: 'DECODED' },
              { id: 'hex', label: 'HEX+ASCII' },
              { id: 'both', label: 'BOTH' },
            ] as const).map((opt) => (
              <button
                type="button"
                key={opt.id}
                onClick={() => setPayloadMode(opt.id)}
                className={`px-1.5 py-0.5 text-[11px] font-mono leading-none transition-colors ${
                  payloadMode === opt.id
                    ? 'bg-bf-cyan/20 text-bf-cyan font-bold'
                    : 'text-bf-faint hover:text-bf-mute hover:bg-bf-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Inline Hex & ASCII split pane toggle */}
          <div
            className="flex items-center rounded border border-bf-line overflow-hidden shrink-0"
            title="Integrated Canonical Hex & ASCII split pane"
          >
            <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold text-bf-faint bg-bf-head border-r border-bf-line leading-none">
              HEX PANE
            </span>
            {([
              { id: 'off', label: 'Off' },
              { id: 'bottom', label: 'Bottom' },
              { id: 'right', label: 'Right' },
            ] as const).map((opt) => (
              <button
                type="button"
                key={opt.id}
                onClick={() => setHexSplit(opt.id)}
                className={`px-1.5 py-0.5 text-[11px] font-mono leading-none transition-colors ${
                  hexSplit === opt.id
                    ? 'bg-bf-cyan/20 text-bf-cyan font-bold'
                    : 'text-bf-faint hover:text-bf-mute hover:bg-bf-hover'
                }`}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => useWorkstationStore.getState().requestOpenPanel('hexInspector')}
              title="Open standalone Canonical Hex & ASCII dock tab"
              className="px-1.5 py-0.5 text-[10px] font-mono leading-none border-l border-bf-line text-bf-mute hover:text-bf-cyan hover:bg-bf-hover transition-colors"
            >
              Tab ↗
            </button>
          </div>

          {/* Stream Search / Filter Input */}
          <div className="relative flex items-center min-w-[120px] max-w-[210px] flex-1">
            <Search className="w-3 h-3 absolute left-1.5 text-bf-faint pointer-events-none" />
            <input
              type="text"
              id="bforge-stream-filter"
              placeholder="Filter stream (/)..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              title="Filter packet stream by protocol, hex bytes, direction (RX/TX/FAULT), or decoded summary"
              className="w-full h-[22px] bg-bf-subpanel border border-bf-line rounded pl-5 pr-5 text-[11px] text-bf-body placeholder-bf-faint focus:border-bf-cyan focus:outline-none font-mono"
            />
            {filterText && (
              <button
                type="button"
                onClick={() => setFilterText('')}
                title="Clear filter (Esc)"
                className="absolute right-1.5 text-bf-faint hover:text-bf-body text-[11px]"
              >
                ×
              </button>
            )}
          </div>

          {filterText && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bf-cyan/10 text-bf-cyan border border-bf-cyan/30 font-mono leading-none shrink-0">
              {filteredPackets.length} MATCH{filteredPackets.length === 1 ? '' : 'ES'}
            </span>
          )}

          {/* Autoscroll toggle */}
          <button
            type="button"
            onClick={() => {
              if (!autoScroll) handleJumpToLive();
              else setAutoScroll(false);
            }}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono leading-none transition-colors ${
              autoScroll
                ? 'bg-bf-active text-bf-cyan border border-bf-cyan/40'
                : 'text-bf-faint hover:text-bf-mute border border-transparent'
            }`}
          >
            <ArrowDownCircle className="w-3 h-3" />
            AUTO {autoScroll ? 'ON' : 'OFF'}
          </button>

          {/* Clear stream */}
          <button
            type="button"
            onClick={clearStream}
            title="Clear view buffer (preserves disk vault)"
            className="flex items-center gap-1 text-bf-faint hover:text-bf-fault px-1.5 py-0.5 rounded text-[11px] font-mono leading-none transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            CLEAR
          </button>
        </div>
      </div>

      {/* Master-Detail Split Body */}
      <div
        ref={splitBodyRef}
        className={`flex-1 min-h-0 flex overflow-hidden ${
          hexSplit === 'right' ? 'flex-row' : 'flex-col'
        }`}
      >
        {/* Stream Table Pane */}
        <div className="relative flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
          {/* Table Column Headers (Centered text, proper separators, draggable resize) */}
          <div
            ref={headerRef}
            className="h-[24px] bg-bf-head border-b border-bf-line overflow-x-hidden overflow-y-hidden shrink-0 select-none"
          >
            <div
              style={{
                minWidth: `${totalMinWidth}px`,
                gridTemplateColumns,
              }}
              className="grid h-full text-[11px] font-mono text-bf-faint uppercase tracking-wider items-center"
            >
              {STREAM_COLUMNS.map((col) => (
                <div
                  key={col.id}
                  className="relative h-full flex items-center justify-center text-center px-1 border-r border-bf-line font-semibold select-none group"
                >
                  <span className="truncate">
                    {col.id === 'summary' ? summaryHeaderLabel : col.label}
                  </span>
                  {/* Draggable resize handle */}
                  <div
                    onMouseDown={(e) => startColResize(col.id, e)}
                    onDoubleClick={() => resetColWidth(col.id)}
                    title="Drag separator to resize column (Double-click to reset)"
                    className="absolute right-0 top-0 bottom-0 w-2 -mr-1 cursor-col-resize z-20 group-hover:bg-bf-cyan/50 active:bg-bf-cyan transition-colors"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Virtualized Packet List Viewport */}
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-auto font-mono"
          >
            {totalRows === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-bf-faint">
                <p className="text-[13px] font-semibold text-bf-mute mb-1">Awaiting Packet Stream</p>
                <p className="text-[11px] max-w-sm mb-3">
                  Incoming serial frames with microsecond timestamps will stream here automatically.
                </p>
                <button
                  type="button"
                  onClick={() => useWorkstationStore.getState().loadSampleCapture()}
                  className="px-2.5 py-1 bg-bf-subpanel hover:bg-bf-active border border-bf-cyan/40 text-bf-cyan rounded text-[11px] font-mono font-medium transition-colors"
                >
                  Load Sample Capture Stream
                </button>
              </div>
            ) : (
              <div style={{ minWidth: `${totalMinWidth}px` }}>
                {/* Top Virtual Spacer */}
                <div style={{ height: `${topSpacerHeight}px` }} />

                {/* Rendered Visible Rows */}
                <div className="divide-y divide-bf-line-soft/40">
                  {visiblePackets.map((pkt) => {
                    const isSelected = selectedPacket?.seqId === pkt.seqId;
                    const preview =
                      payloadMode !== 'summary'
                        ? formatPayloadPreview(
                            pkt.rawBytes,
                            pkt.rawHex,
                            payloadMode === 'hex' ? 48 : 16
                          )
                        : null;

                    return (
                      <div
                        key={pkt.seqId}
                        onClick={() => {
                          if (autoScroll) setAutoScroll(false);
                          selectPacket(pkt);
                        }}
                        style={{
                          height: `${ROW_HEIGHT}px`,
                          gridTemplateColumns,
                        }}
                        className={`grid text-[12px] items-center cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-bf-active text-bf-bright'
                            : pkt.isFaultInjected
                            ? 'bg-bf-fault/10 hover:bg-bf-fault/15 text-bf-fault-soft'
                            : 'hover:bg-bf-subpanel text-bf-dim'
                        }`}
                      >
                        {/* Seq ID - Centered */}
                        <div className="h-full flex items-center justify-center text-center font-semibold text-bf-mute border-r border-bf-btn/40 px-1 truncate">
                          #{String(pkt.seqId).padStart(5, '0')}
                        </div>

                        {/* Delta Time - Centered */}
                        <div className="h-full flex items-center justify-center text-center text-bf-faint border-r border-bf-btn/40 px-1 truncate">
                          {formatDelta(pkt.deltaUs)}
                        </div>

                        {/* Absolute Time - Centered */}
                        <div className="h-full flex items-center justify-center text-center text-bf-mute border-r border-bf-btn/40 px-1 truncate">
                          {pkt.timeStr}
                        </div>

                        {/* Direction - Centered */}
                        <div className="h-full flex items-center justify-center border-r border-bf-btn/40 px-1">
                          <DirectionBadge
                            direction={pkt.direction}
                            isFault={pkt.isFaultInjected}
                          />
                        </div>

                        {/* Port - Centered */}
                        <div className="h-full flex items-center justify-center text-center text-bf-faint border-r border-bf-btn/40 px-1 truncate">
                          {pkt.port}
                        </div>

                        {/* Length - Centered */}
                        <div className="h-full flex items-center justify-center text-center text-bf-mute border-r border-bf-btn/40 px-1 truncate">
                          {pkt.length}B
                        </div>

                        {/* Protocol Tag - Centered */}
                        <div className="h-full flex items-center justify-center text-center font-semibold text-bf-cyan border-r border-bf-btn/40 px-1 truncate">
                          {pkt.protocol}
                        </div>

                        {/* Summary / Raw Hex + ASCII Payload */}
                        <div className="h-full flex items-center gap-2 truncate px-2 border-r border-bf-btn/40 min-w-0">
                          {pkt.hasError ? (
                            <span className="flex items-center gap-1 text-bf-fault font-semibold text-[11px] shrink-0">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              {pkt.errorMsg || 'CRC ERROR'}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-bf-ok shrink-0">
                              <CheckCircle2 className="w-3 h-3 shrink-0" />
                            </span>
                          )}

                          {payloadMode === 'summary' && (
                            <span className="truncate text-bf-mute">{pkt.summary}</span>
                          )}

                          {payloadMode === 'hex' && preview && (
                            <>
                              <span className="truncate text-bf-dim font-mono min-w-0">
                                {preview.hex || '—'}
                              </span>
                              {preview.ascii && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded bg-bf-head border border-bf-line-soft text-bf-mute font-mono text-[11px] leading-none">
                                  |{preview.ascii}|
                                </span>
                              )}
                            </>
                          )}

                          {payloadMode === 'both' && (
                            <>
                              <span className="truncate text-bf-body shrink min-w-[80px]">
                                {pkt.summary}
                              </span>
                              {preview?.hex && (
                                <span className="truncate text-bf-faint font-mono border-l border-bf-line-soft pl-2 shrink-[2] min-w-[60px]">
                                  {preview.hex}
                                </span>
                              )}
                              {preview?.ascii && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded bg-bf-head border border-bf-line-soft text-bf-mute font-mono text-[11px] leading-none">
                                  {preview.ascii}
                                </span>
                              )}
                            </>
                          )}
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
              type="button"
              onClick={handleJumpToLive}
              className="absolute bottom-3 right-4 flex items-center gap-1.5 px-3 py-1 bg-bf-cyan text-bf-onfill font-bold text-[11px] rounded-full shadow-[0_2px_10px_rgb(var(--bf-cyan-rgb)/0.4)] hover:bg-bf-cyan-hi transition-all z-20 cursor-pointer animate-pulse"
            >
              <ArrowDown className="w-3 h-3" />
              <span>JUMP TO LIVE {newFramesCount > 0 ? `(${newFramesCount} NEW)` : ''}</span>
            </button>
          )}
        </div>

        {/* Draggable Splitter + Embedded Canonical Hex & ASCII Pane */}
        {hexSplit !== 'off' && (
          <>
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDraggingSplit(true);
              }}
              onDoubleClick={() => setSplitRatio(0.38)}
              title={
                hexSplit === 'bottom'
                  ? 'Drag to resize Hex Inspector height (Double-click to reset)'
                  : 'Drag to resize Hex Inspector width (Double-click to reset)'
              }
              className={
                hexSplit === 'bottom'
                  ? 'h-[5px] shrink-0 cursor-row-resize bg-bf-line/70 hover:bg-bf-cyan/60 active:bg-bf-cyan transition-colors flex items-center justify-center border-y border-bf-line'
                  : 'w-[5px] shrink-0 cursor-col-resize bg-bf-line/70 hover:bg-bf-cyan/60 active:bg-bf-cyan transition-colors flex items-center justify-center border-x border-bf-line'
              }
            >
              <span
                className={
                  hexSplit === 'bottom'
                    ? 'w-8 h-[2px] rounded-full bg-bf-line-strong'
                    : 'h-8 w-[2px] rounded-full bg-bf-line-strong'
                }
              />
            </div>

            <div
              style={
                hexSplit === 'bottom'
                  ? { height: `${Math.round(splitRatio * 100)}%` }
                  : { width: `${Math.round(splitRatio * 100)}%` }
              }
              className={`shrink-0 overflow-hidden ${
                hexSplit === 'bottom' ? 'min-h-[120px] min-w-0' : 'min-w-[260px] min-h-0'
              }`}
            >
              <HexInspector embedded onClose={() => setHexSplit('off')} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
