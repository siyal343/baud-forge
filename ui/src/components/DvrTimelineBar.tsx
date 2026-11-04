import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { Play, Pause, ChevronLeft, ChevronRight, Radio, AlertCircle } from 'lucide-react';

export const DvrTimelineBar: React.FC = () => {
  const {
    packets,
    selectedPacket,
    isLive,
    isPaused,
    isReplaying,
    playbackSpeed,
    setDvrLive,
    setDvrPaused,
    startReplay,
    stopReplay,
    stepFrame,
    setPlaybackSpeed,
    seekToTimestamp,
  } = useWorkstationStore(
    useShallow((s) => ({
      packets: s.packets,
      selectedPacket: s.selectedPacket,
      isLive: s.isLive,
      isPaused: s.isPaused,
      isReplaying: s.isReplaying,
      playbackSpeed: s.playbackSpeed,
      setDvrLive: s.setDvrLive,
      setDvrPaused: s.setDvrPaused,
      startReplay: s.startReplay,
      stopReplay: s.stopReplay,
      stepFrame: s.stepFrame,
      setPlaybackSpeed: s.setPlaybackSpeed,
      seekToTimestamp: s.seekToTimestamp,
    }))
  );

  const totalPackets = packets.length;
  // seqId lookup memoized — a linear findIndex over up to 10 000 packets
  // previously ran on every 20 Hz tick even while idle.
  const selectedIndex = useMemo(
    () => (selectedPacket ? packets.findIndex((p) => p.seqId === selectedPacket.seqId) : -1),
    [packets, selectedPacket]
  );
  const currentIdx = selectedIndex >= 0 ? selectedIndex : totalPackets - 1;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value, 10);
    const pkt = packets[idx];
    if (pkt) {
      seekToTimestamp(pkt.timestampUs);
    }
  };

  const speedOptions = [0.25, 0.5, 1.0, 2.0];

  return (
    <div className="h-[26px] bg-[#10141D] border-t border-[#222D3D] px-2.5 flex items-center justify-between shrink-0 select-none text-[11px]">
      {/* Transport Controls */}
      <div className="flex items-center gap-1.5">
        {/* Play / Pause / Replay Toggle (spec 2.6: historical replay vs live) */}
        <button
          onClick={() => {
            if (isReplaying) stopReplay();
            else if (isPaused) startReplay();
            else setDvrPaused(true);
          }}
          className={`p-1 rounded transition-colors ${
            isReplaying
              ? 'bg-[#00E5FF] text-[#0A0D13] font-bold'
              : isPaused
              ? 'bg-[#F59E0B] text-[#0A0D13] font-bold'
              : 'bg-[#161C28] text-[#E2E8F0] hover:bg-[#26324A]'
          }`}
          title={
            isReplaying
              ? 'Pause replay'
              : isPaused
              ? 'Replay buffered frames from the scrub position'
              : 'Pause live stream (Spacebar)'
          }
        >
          {isPaused && !isReplaying ? (
            <Play className="w-2.5 h-2.5 fill-current" />
          ) : (
            <Pause className="w-2.5 h-2.5" />
          )}
        </button>

        {/* Step Back 1 Frame */}
        <button
          onClick={() => stepFrame('back')}
          className="p-1 bg-[#161C28] hover:bg-[#26324A] text-[#94A3B8] hover:text-[#E2E8F0] rounded transition-colors"
          title="Step 1 Frame Back (Left Arrow)"
        >
          <ChevronLeft className="w-2.5 h-2.5" />
        </button>

        {/* Step Forward 1 Frame */}
        <button
          onClick={() => stepFrame('forward')}
          className="p-1 bg-[#161C28] hover:bg-[#26324A] text-[#94A3B8] hover:text-[#E2E8F0] rounded transition-colors"
          title="Step 1 Frame Forward (Right Arrow)"
        >
          <ChevronRight className="w-2.5 h-2.5" />
        </button>

        {/* Speed Chips — live controls for the replay loop */}
        <div className="flex items-center gap-0.5 bg-[#161C28] border border-[#222D3D] rounded px-1 py-0.2 font-mono text-[9px]">
          {speedOptions.map((s) => (
            <button
              key={s}
              onClick={() => setPlaybackSpeed(s)}
              title={`Replay speed ×${s}`}
              className={`px-1 py-0.2 rounded transition-colors ${
                playbackSpeed === s
                  ? 'bg-[#26324A] text-[#00E5FF] font-semibold border border-[#00E5FF]/40'
                  : 'text-[#64748B] hover:text-[#94A3B8]'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      {/* Center: Full-width Scrubber Bar */}
      <div className="flex-1 mx-4 flex items-center gap-3">
        <span className="text-[10px] font-mono text-[#64748B] w-12 text-right">
          #{Math.max(0, currentIdx + 1)}
        </span>
        <input
          type="range"
          min="0"
          max={Math.max(0, totalPackets - 1)}
          value={Math.max(0, currentIdx)}
          onChange={handleSliderChange}
          disabled={totalPackets <= 1}
          className="flex-1 h-1.5 bg-[#222D3D] rounded-lg appearance-none cursor-pointer accent-[#00E5FF]"
        />
        <span className="text-[10px] font-mono text-[#64748B] w-12">
          #{totalPackets}
        </span>
      </div>

      {/* Right: Mode Status & Live Snap */}
      <div className="flex items-center gap-2">
        {isReplaying ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#00E5FF]/20 border border-[#00E5FF]/50 text-[#00E5FF] rounded text-[10px] font-mono font-bold animate-pulse">
            <Play className="w-3 h-3" />
            <span>REPLAYING ×{playbackSpeed}</span>
          </div>
        ) : isPaused ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#F59E0B]/20 border border-[#F59E0B]/50 text-[#F59E0B] rounded text-[10px] font-mono font-bold animate-pulse">
            <AlertCircle className="w-3 h-3" />
            <span>
              PAUSED AT T-
              {(
                Math.max(
                  0,
                  (packets.length ? packets[packets.length - 1].timestampUs : 0) -
                    (selectedPacket?.timestampUs ?? 0)
                ) / 1e6
              ).toFixed(3)}
              s
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#10B981]/20 border border-[#10B981]/50 text-[#10B981] rounded text-[10px] font-mono font-bold">
            <Radio className="w-3 h-3 animate-pulse" />
            <span>STREAMING LIVE</span>
          </div>
        )}

        {/* Live Snap Button */}
        <button
          onClick={setDvrLive}
          disabled={isLive}
          className={`px-2.5 py-1 rounded font-mono text-[11px] font-semibold transition-colors ${
            !isLive
              ? 'bg-[#00E5FF] text-[#0A0D13] hover:bg-[#38BDF8] shadow-[0_0_8px_rgba(0,229,255,0.4)]'
              : 'bg-[#161C28] text-[#64748B] cursor-default'
          }`}
        >
          ● LIVE SNAP
        </button>
      </div>
    </div>
  );
};
