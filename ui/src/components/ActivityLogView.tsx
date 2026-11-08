// Activity Log panel (spec: activity log system): one interleaved timeline of
// engine events and UI actions, polled from GET /api/logs. This is the "what
// happened right before the failure?" view — level filters, live tail, and a
// .jsonl export for a bug report.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollText, Download, Copy, Pause, Play } from 'lucide-react';
import { engineApi, type LogEntryView } from '../services/engineApi';
import { triggerFileDownload } from '../services/engineApi';
import { logAction } from '../services/activityLog';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVEL_STYLE: Record<Level, string> = {
  debug: 'text-bf-faint border-bf-btn-hi',
  info: 'text-bf-cyan border-bf-cyan/40',
  warn: 'text-bf-warn border-bf-warn/50',
  error: 'text-bf-fault border-bf-fault/60',
};

const SOURCE_STYLE: Record<string, string> = {
  engine: 'bg-bf-hover text-bf-mute',
  ui: 'bg-bf-purple/15 text-bf-purple',
};

function clock(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export const ActivityLogView: React.FC = () => {
  const [entries, setEntries] = useState<LogEntryView[]>([]);
  const [minLevel, setMinLevel] = useState<Level>('debug');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const cursorRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const poll = useCallback(async () => {
    const fresh = await engineApi.fetchLogs(cursorRef.current);
    if (fresh.length > 0) {
      cursorRef.current = fresh[fresh.length - 1].seq;
      setEntries((prev) => {
        const merged = [...prev, ...fresh.filter((f) => !prev.some((p) => p.seq === f.seq))];
        // The ring holds 2,000 entries server-side; the view mirrors that cap.
        return merged.length > 2000 ? merged.slice(merged.length - 2000) : merged;
      });
    } else if (fresh.length === 0 && cursorRef.current === 0) {
      // First poll with nothing at all: mark the cursor so we do not re-render.
      cursorRef.current = 0;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && !paused) void poll();
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [poll, paused]);

  // Follow the tail unless the reader scrolled up to study something.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, follow]);

  const visible = entries.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER[minLevel]);

  const download = () => {
    const lines = visible.map((e) => JSON.stringify(e)).join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerFileDownload(
      new Blob([lines + (lines ? '\n' : '')], { type: 'application/x-ndjson;charset=utf-8' }),
      `bforge-activity-${stamp}.jsonl`
    );
    logAction('activity_export', `${visible.length} entries downloaded`);
  };

  const copy = async () => {
    const text = visible
      .map((e) => `${clock(e.at_ms)} [${e.level.toUpperCase()}] (${e.source}) ${e.event} — ${e.detail}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      logAction('activity_copy', `${visible.length} entries copied`, 'debug');
    } catch {
      // Clipboard permission denied: not an action worth a toast loop.
    }
  };

  const toggleLevel = (level: Level) => setMinLevel((current) => (current === level ? 'debug' : level));

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-bf-subpanel border-b border-bf-line px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <ScrollText className="w-3 h-3 text-bf-cyan" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[10.5px]">
            ACTIVITY LOG
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-bf-hover text-bf-mute font-mono border border-bf-line">
            {visible.length} ENTRIES
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume live tail' : 'Pause the live tail'}
            className="p-1 rounded text-bf-faint hover:text-bf-cyan hover:bg-bf-subpanel transition-colors"
          >
            {paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
          </button>
          <button
            onClick={copy}
            title="Copy the visible entries as text"
            className="p-1 rounded text-bf-faint hover:text-bf-cyan hover:bg-bf-subpanel transition-colors"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            onClick={download}
            title="Download the visible entries as .jsonl"
            className="p-1 rounded text-bf-faint hover:text-bf-cyan hover:bg-bf-subpanel transition-colors"
          >
            <Download className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Level filter */}
      <div className="px-2 py-1 border-b border-bf-line bg-bf-head flex items-center gap-1 shrink-0">
        <span className="text-[9px] text-bf-faint uppercase font-bold tracking-wider mr-1">Level ≥</span>
        {(['debug', 'info', 'warn', 'error'] as Level[]).map((level) => (
          <button
            key={level}
            onClick={() => toggleLevel(level)}
            className={`px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase transition-colors ${
              minLevel === level
                ? LEVEL_STYLE[level] + ' bg-bf-subpanel'
                : 'text-bf-faint border-bf-line hover:text-bf-mute'
            }`}
          >
            {level}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-[9px] font-mono text-bf-faint cursor-pointer">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="accent-bf-cyan"
          />
          FOLLOW TAIL
        </label>
      </div>

      {/* Timeline */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setFollow(atBottom);
        }}
        className="flex-1 overflow-y-auto min-h-0 font-mono text-[9.5px] leading-[1.5]"
      >
        {visible.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-bf-faint">
            <ScrollText className="w-6 h-6 mb-2 opacity-40 text-bf-cyan" />
            <p className="text-[10px]">No entries yet.</p>
            <p className="text-[9px] mt-1 max-w-[280px]">
              Everything the engine does — TX, REC, transfers, overruns — and the buttons you press
              land here in one timeline. With the vault sealed it is saved as
              <span className="text-bf-mute"> &lt;vault&gt;.activity.jsonl</span> next to the capture.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.seq} className="align-top hover:bg-bf-subpanel/60">
                  <td className="pl-2 pr-1 py-[1px] text-bf-faint whitespace-nowrap">{clock(entry.at_ms)}</td>
                  <td className="pr-1 py-[1px] whitespace-nowrap">
                    <span className={`px-1 rounded border ${LEVEL_STYLE[entry.level]}`}>
                      {entry.level.toUpperCase()}
                    </span>
                  </td>
                  <td className="pr-1 py-[1px] whitespace-nowrap">
                    <span className={`px-1 rounded text-[8.5px] ${SOURCE_STYLE[entry.source] ?? ''}`}>
                      {entry.source.toUpperCase()}
                    </span>
                  </td>
                  <td className="pr-1 py-[1px] text-bf-body whitespace-nowrap">{entry.event}</td>
                  <td className="pr-2 py-[1px] text-bf-mute break-all">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
