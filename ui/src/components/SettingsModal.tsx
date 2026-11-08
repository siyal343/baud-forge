import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings, X, Check, RotateCcw, Palette, Gauge, Database, Info } from 'lucide-react';
import {
  useSettingsStore,
  DEFAULT_SETTINGS,
  EXPORT_FORMATS,
  buildVaultPath,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  MAX_PACKETS_MIN,
  MAX_PACKETS_MAX,
  MAX_SCOPE_SAMPLES_MIN,
  MAX_SCOPE_SAMPLES_MAX,
  BfSettings,
} from '../store/useSettingsStore';

type SettingsSection = 'appearance' | 'performance' | 'data';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'appearance', label: 'APPEARANCE', icon: Palette },
  { id: 'performance', label: 'PERFORMANCE', icon: Gauge },
  { id: 'data', label: 'DATA & EXPORT', icon: Database },
];

/** Circled ⓘ next to a setting's label — the only hover target for its hint. */
const InfoHint: React.FC<{ text: string }> = ({ text }) => (
  <span
    title={text}
    className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[#2D3A4E] text-[#64748B] hover:text-[#00E5FF] hover:border-[#00E5FF]/60 cursor-help transition-colors shrink-0"
  >
    <Info className="w-2.5 h-2.5" />
  </span>
);

/** Small labeled ON/OFF segment pair — the modal's boolean control. */
const BoolRow: React.FC<{
  label: string;
  tooltip: string;
  value: boolean;
  onChange: (v: boolean) => void;
  onLabel?: string;
  offLabel?: string;
}> = ({ label, tooltip, value, onChange, onLabel = 'ON', offLabel = 'OFF' }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="flex items-center gap-1 text-[#64748B] text-[10px]">
      {label}
      <InfoHint text={tooltip} />
    </span>
    <div className="flex items-center gap-1">
      {[true, false].map((v) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={`w-12 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
            value === v
              ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
              : 'bg-[#161C28] border-[#222D3D] text-[#94A3B8] hover:border-[#38BDF8]/40'
          }`}
        >
          {v ? onLabel : offLabel}
        </button>
      ))}
    </div>
  </div>
);

/** Generic enum segment row (options rendered right-to-left like UART bits). */
const SegRow: React.FC<{
  label: string;
  tooltip: string;
  value: string | number;
  options: Array<{ v: string | number; label: string }>;
  onChange: (v: any) => void;
}> = ({ label, tooltip, value, options, onChange }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="flex items-center gap-1 text-[#64748B] text-[10px]">
      {label}
      <InfoHint text={tooltip} />
    </span>
    <div className="flex items-center gap-1">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
            value === o.v
              ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
              : 'bg-[#161C28] border-[#222D3D] text-[#94A3B8] hover:border-[#38BDF8]/40'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  </div>
);

const NumRow: React.FC<{
  label: string;
  tooltip: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, tooltip, value, min, max, step, suffix, onChange }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="flex items-center gap-1 text-[#64748B] text-[10px]">
      {label}
      <InfoHint text={tooltip} />
    </span>
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(n);
        }}
        className="w-20 h-6 px-1.5 bg-[#0A0D13] border border-[#222D3D] rounded text-[#00E5FF] font-bold text-[10.5px] text-right focus:outline-none focus:border-[#00E5FF] font-mono"
      />
      {suffix && <span className="text-[9px] text-[#64748B]">{suffix}</span>}
    </div>
  </div>
);

export const SettingsModal: React.FC = () => {
  const isOpen = useSettingsStore((s) => s.isSettingsOpen);
  const setSettingsOpen = useSettingsStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Draft state: staged locally, committed only on Apply (UartConfigModal idiom).
  const [draft, setDraft] = useState<BfSettings>(settings);
  const [section, setSection] = useState<SettingsSection>('appearance');
  const modalRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof BfSettings>(key: K, value: BfSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // Sync draft whenever the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setSection('appearance');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Close on outside click / Escape (discard the draft, like Cancel).
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, setSettingsOpen]);

  if (!isOpen) return null;

  const handleApply = () => {
    updateSettings(draft);
    setSettingsOpen(false);
  };

  const handleReset = () => setDraft({ ...DEFAULT_SETTINGS });

  const patternPreview = buildVaultPath(draft.vaultNamePattern).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/,
    '<stamp>'
  );

  return createPortal(
    <div className="fixed inset-0 z-[999998] bg-black/40 backdrop-blur-[1px]">
      <div
        ref={modalRef}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 999999,
        }}
        className="w-[680px] bg-[#0E131F] border border-[#2D3A4E] shadow-[0_12px_36px_rgba(0,0,0,0.85)] rounded-lg text-[11px] font-mono text-[#CBD5E1] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="h-[32px] bg-[#141B29] border-b border-[#222D3D] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 text-[#00E5FF] font-semibold text-[11.5px]">
            <Settings className="w-3.5 h-3.5" />
            <span>SETTINGS</span>
            <span className="text-[9px] text-[#64748B] font-normal ml-1">applied on APPLY · stored locally</span>
          </div>
          <button
            onClick={() => setSettingsOpen(false)}
            className="text-[#64748B] hover:text-[#EF4444] p-0.5 rounded transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body: section rail + content pane */}
        <div className="flex min-h-0">
          {/* Nav rail */}
          <div className="w-[132px] shrink-0 bg-[#10151F] border-r border-[#222D3D] p-1.5 flex flex-col gap-1">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-semibold tracking-wider transition-colors border text-left ${
                    active
                      ? 'bg-[#00E5FF]/10 border-[#00E5FF]/40 text-[#00E5FF]'
                      : 'bg-transparent border-transparent text-[#64748B] hover:text-[#94A3B8] hover:bg-[#161C28]'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>

          {/* Content pane */}
          <div className="flex-1 p-3.5 space-y-3 max-h-[440px] overflow-y-auto">
            {section === 'appearance' && (
              <>
                <NumRow
                  label="UI Scale:"
                  tooltip="Whole-workbench zoom (0.70–1.50). Ctrl+= / Ctrl+- / Ctrl+0 also work anywhere."
                  value={draft.uiScale}
                  min={UI_SCALE_MIN}
                  max={UI_SCALE_MAX}
                  step={0.05}
                  suffix="×"
                  onChange={(v) => set('uiScale', v)}
                />
                <BoolRow
                  label="Tooltips:"
                  tooltip="Custom dark tooltip surface on hover. OFF falls back to the browser's native title tooltips."
                  value={draft.tooltipsEnabled}
                  onChange={(v) => set('tooltipsEnabled', v)}
                />
                <SegRow
                  label="Timestamps:"
                  tooltip="Stream Time column base — wall clock (HH:MM:SS.mmm) or elapsed since the first frame (MM:SS.mmm)."
                  value={draft.timestampBase}
                  options={[
                    { v: 'relative', label: 'SESSION' },
                    { v: 'wall', label: 'WALL CLOCK' },
                  ]}
                  onChange={(v) => set('timestampBase', v)}
                />
                <div className="border-t border-[#222D3D] pt-3 space-y-3">
                  <div className="text-[10px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                    Hex Inspector Display
                  </div>
                  <SegRow
                    label="Bytes / Row:"
                    tooltip="Canonical hex dump row width. The page size stays 32 rows."
                    value={draft.hexBytesPerRow}
                    options={[
                      { v: 32, label: '32' },
                      { v: 16, label: '16' },
                      { v: 8, label: '8' },
                    ]}
                    onChange={(v) => set('hexBytesPerRow', v)}
                  />
                  <SegRow
                    label="Grouping:"
                    tooltip="Hex byte grouping inside a row (space every N bytes)."
                    value={draft.hexGrouping}
                    options={[
                      { v: 4, label: '×4' },
                      { v: 2, label: '×2' },
                      { v: 1, label: '×1' },
                    ]}
                    onChange={(v) => set('hexGrouping', v)}
                  />
                  <BoolRow
                    label="ASCII Gutter:"
                    tooltip="Show the printable-character column next to the hex bytes."
                    value={draft.hexShowAscii}
                    onChange={(v) => set('hexShowAscii', v)}
                  />
                </div>
              </>
            )}

            {section === 'performance' && (
              <>
                <div className="bg-[#161C28] border border-[#222D3D] px-2.5 py-1.5 rounded text-[9.5px] text-[#64748B] leading-relaxed">
                  Buffer depths bound the rolling in-memory history. Changes apply to newly captured
                  data — the current session's existing frames are not truncated retroactively.
                </div>
                <NumRow
                  label="Max Packets Kept:"
                  tooltip="Packet Stream ring depth. Oldest frames drop out first. 1,000 – 100,000."
                  value={draft.maxPackets}
                  min={MAX_PACKETS_MIN}
                  max={MAX_PACKETS_MAX}
                  step={1000}
                  suffix="frames"
                  onChange={(v) => set('maxPackets', v)}
                />
                <NumRow
                  label="Max Scope Samples:"
                  tooltip="Oscilloscope & trace-lane ring depth. 100 – 5,000."
                  value={draft.maxScopeSamples}
                  min={MAX_SCOPE_SAMPLES_MIN}
                  max={MAX_SCOPE_SAMPLES_MAX}
                  step={50}
                  suffix="points"
                  onChange={(v) => set('maxScopeSamples', v)}
                />
              </>
            )}

            {section === 'data' && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-[#64748B] text-[10px]">
                    Default Export Format:
                    <InfoHint text="Format preselected when the EXPORT dialog opens." />
                  </span>
                  <select
                    value={draft.defaultExportFormat}
                    onChange={(e) => set('defaultExportFormat', e.target.value as any)}
                    className="bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5 text-[10px] text-[#E2E8F0] focus:outline-none focus:border-[#00E5FF]"
                  >
                    {EXPORT_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-[#64748B] text-[10px]">
                      Vault Name Pattern:
                      <InfoHint text="REC file name template. <stamp> expands to the capture timestamp; .bflog and the vaults/ directory are always enforced." />
                    </span>
                    <input
                      type="text"
                      value={draft.vaultNamePattern}
                      onChange={(e) => set('vaultNamePattern', e.target.value)}
                      placeholder="rec-<stamp>"
                      spellCheck={false}
                      className="w-[220px] h-6 px-1.5 bg-[#0A0D13] border border-[#222D3D] rounded text-[#00E5FF] font-bold text-[10.5px] focus:outline-none focus:border-[#00E5FF] font-mono"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-1.5 text-[9px] text-[#64748B]">
                    <span>PREVIEW:</span>
                    <span className="text-[#10B981]">{patternPreview}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="h-[36px] bg-[#141B29] border-t border-[#222D3D] px-3 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 text-[10px] text-[#64748B] hover:text-[#94A3B8] transition-colors"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            <span>Reset to defaults</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              className="px-2.5 py-1 rounded bg-[#1E293B] hover:bg-[#334155] text-[#94A3B8] text-[10.5px] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="flex items-center gap-1 px-3 py-1 rounded bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-semibold text-[10.5px] transition-colors shadow-[0_0_8px_rgba(0,229,255,0.4)]"
            >
              <Check className="w-3 h-3" />
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
