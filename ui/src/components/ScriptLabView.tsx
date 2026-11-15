import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Code2,
  Download,
  LineChart,
  Play,
  Power,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Upload,
  Zap,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { engineApi, triggerFileDownload } from '../services/engineApi';
import {
  DEFAULT_TEST_FRAME_HEX,
  SCRIPT_TEMPLATES,
  ScriptTemplateId,
  parseHexBytes,
} from '../services/luaSandboxFallback';
import { usePlotStore } from '../store/usePlotStore';
import { toast } from '../store/useToastStore';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { plotEngine } from '../plot/engine';
import type { ScriptDryRunView } from '../types';

type DryRunResultWithMeta = ScriptDryRunView & { offline: boolean; hooks?: string[] };
type QuickFaultKind = 'bit_flip' | 'drop' | 'truncate' | 'corrupt_crc' | 'delay';

const QUICK_FAULT_OPTIONS: Record<
  QuickFaultKind,
  { label: string; options: Record<string, number> }
> = {
  bit_flip: { label: 'Bit Flip (10⁻⁵ BER)', options: { flip_rate: 1e-5 } },
  drop: { label: 'Drop Every 5th Frame', options: { drop_every: 5 } },
  truncate: { label: 'Truncate (-4 B)', options: { truncate: 4 } },
  corrupt_crc: { label: 'Corrupt CRC (-4 B)', options: { corrupt_crc: 4 } },
  delay: { label: 'Latency Jitter (150±30 ms)', options: { delay_ms: 150, jitter_ms: 30 } },
};

const QUICK_ONE_SHOTS = {
  badCrc: {
    hex: '66 61 75 6c 74 20 62 61 64 5f 63 72 63 20 33 0a',
    okTitle: 'One-shot CRC corruption sent',
    okDesc: '3 bad-CRC frames requested',
  },
  drop: {
    hex: '66 61 75 6c 74 20 64 72 6f 70 20 32 0a',
    okTitle: 'One-shot frame drop sent',
    okDesc: '2 dropped frames requested',
  },
} as const;

const SCRIPT_API_DOCS: Array<{ fn: string; desc: string }> = [
  { fn: 'bforge.on_rx_frame / on_tx_frame', desc: 'Intercept RX/TX frames (optional target port); return frame, hex, burst, or nil to drop.' },
  { fn: 'bforge.on_mitm_frame(target, fn)', desc: 'Mutate bridged A<->B frames in flight (`mitm_a_to_b` / `mitm_b_to_a`).' },
  { fn: 'bforge.on_raw_chunk / on_dissect', desc: 'Mutate pre-framer byte chunks or annotate synthetic fields with `frame:add_field`.' },
  { fn: 'bforge.on_init / on_timer / on_alert / on_command', desc: 'Lifecycle init, periodic timers, watchdog alerts, and named command builders.' },
  { fn: 'frame:get / set / fields / dissect', desc: 'Read/write schema fields or switch schema (`ImuPacket` / `EpsCommand`) at runtime.' },
  { fn: 'frame:u8 / u16_be / u32_le / slice / set_*', desc: 'Zero-offset binary readers, writers, `raw()`, `clone_bytes()`, `set_bytes()`, and `resize()`.' },
  { fn: 'frame:xor_bit / xor_u8 / corrupt_crc', desc: 'Deterministic fault injection and trailing CRC corruption.' },
  { fn: 'frame:recalc_crc(algo?)', desc: 'Recompute trailing crc8 / crc16_ccitt_false / crc16_modbus / crc16_xmodem / crc32c.' },
  { fn: 'frame:delay_ms / drop / bforge.burst', desc: 'Inject forwarding latency, drop the frame, or split into timed burst entries.' },
  { fn: 'bforge.send / crc / hex / unhex / seed / rand', desc: 'Inject TX replies, compute CRCs, convert spaced hex, and run xorshift64* PRNG.' },
  { fn: 'bforge.plot / metric / assert', desc: 'Stream Plot Forge series, publish Watch scalars, and record pass/fail assertions.' },
  { fn: 'bforge.set_pins / pulse_pin / trigger_pin / log_*', desc: 'Drive DTR/RTS hardware lines or emit rate-limited script console logs.' },
];

function verdictMeta(result: DryRunResultWithMeta): { label: string; cls: string } {
  if (!result.ok || result.verdict === 'error') {
    return { label: 'ERROR', cls: 'bg-bf-fault/15 text-bf-fault border-bf-fault/40' };
  }
  if (result.verdict === 'drop') {
    return { label: 'DROPPED', cls: 'bg-bf-fault/15 text-bf-fault border-bf-fault/40' };
  }
  if (result.verdict === 'burst') {
    return {
      label: `BURST (${result.burst_frames.length})`,
      cls: 'bg-bf-purple/15 text-bf-purple border-bf-purple/40',
    };
  }
  if (result.verdict === 'delay' || result.delay_ms > 0) {
    return {
      label: `DELAYED ${result.delay_ms} ms`,
      cls: 'bg-bf-amber/15 text-bf-amber border-bf-amber/40',
    };
  }
  if (result.mutated) {
    return { label: 'MUTATED', cls: 'bg-bf-cyan/15 text-bf-cyan border-bf-cyan/40' };
  }
  if (result.verdict === 'send') {
    return { label: 'SEND', cls: 'bg-bf-cyan/15 text-bf-cyan border-bf-cyan/40' };
  }
  return { label: 'PASS', cls: 'bg-bf-ok/15 text-bf-ok border-bf-ok/40' };
}

function formatBytesKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function parseByteTokens(hex: string): string[] {
  return parseHexBytes(hex).map((b) => b.toString(16).padStart(2, '0').toUpperCase());
}

export const ScriptLabView: React.FC = () => {
  const {
    isSimulated,
    isConnected,
    selectedPort,
    selectedPacket,
    scriptStatus,
    scriptSource,
    scriptName,
    scriptPolicy,
    scriptSeed,
    requestedScriptTemplate,
    scriptLogs,
    isFaultArmed,
    toggleFaultArm,
    setScriptDraft,
    setScriptStatus,
    setOfflineArmedScript,
    appendScriptLogs,
    resetOfflineScriptStats,
    clearRequestedScriptTemplate,
    requestOpenPanel,
  } = useWorkstationStore(
    useShallow((s) => ({
      isSimulated: s.isSimulated,
      isConnected: s.isConnected,
      selectedPort: s.selectedPort,
      selectedPacket: s.selectedPacket,
      scriptStatus: s.scriptStatus,
      scriptSource: s.scriptSource,
      scriptName: s.scriptName,
      scriptPolicy: s.scriptPolicy,
      scriptSeed: s.scriptSeed,
      requestedScriptTemplate: s.requestedScriptTemplate,
      scriptLogs: s.scriptLogs,
      isFaultArmed: s.isFaultArmed,
      toggleFaultArm: s.toggleFaultArm,
      setScriptDraft: s.setScriptDraft,
      setScriptStatus: s.setScriptStatus,
      setOfflineArmedScript: s.setOfflineArmedScript,
      appendScriptLogs: s.appendScriptLogs,
      resetOfflineScriptStats: s.resetOfflineScriptStats,
      clearRequestedScriptTemplate: s.clearRequestedScriptTemplate,
      requestOpenPanel: s.requestOpenPanel,
    }))
  );

  const [rightTab, setRightTab] = useState<'dryrun' | 'watch'>('dryrun');
  const [showApiRef, setShowApiRef] = useState(false);
  const [showQuickFaults, setShowQuickFaults] = useState(false);
  const [quickFaultKind, setQuickFaultKind] = useState<QuickFaultKind>('bit_flip');
  const [backendMode, setBackendMode] = useState<'engine' | 'offline'>(
    isConnected && !isSimulated ? 'engine' : 'offline'
  );
  const [compiledHooks, setCompiledHooks] = useState<string[]>([]);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileOk, setCompileOk] = useState<boolean | null>(null);
  const [dryRunResult, setDryRunResult] = useState<DryRunResultWithMeta | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [manualHex, setManualHex] = useState<string>(DEFAULT_TEST_FRAME_HEX);
  const [useManualHex, setUseManualHex] = useState(false);
  const [splitPct, setSplitPct] = useState(52);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedTemplateId = useMemo(() => {
    const match = (Object.keys(SCRIPT_TEMPLATES) as ScriptTemplateId[]).find(
      (id) => SCRIPT_TEMPLATES[id].source === scriptSource || `${id}.lua` === scriptName
    );
    return match ?? 'custom';
  }, [scriptSource, scriptName]);

  const activeInputHex = useMemo(() => {
    if (!useManualHex && selectedPacket?.rawHex) {
      return selectedPacket.rawHex;
    }
    return manualHex;
  }, [useManualHex, selectedPacket, manualHex]);

  const activePort = useMemo(
    () => (!useManualHex && selectedPacket?.port ? selectedPacket.port : selectedPort || 'COM8'),
    [useManualHex, selectedPacket, selectedPort]
  );

  const lineCount = useMemo(() => Math.max(1, scriptSource.split('\n').length), [scriptSource]);

  const syncScroll = useCallback(() => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  // Query live engine script state when mounting or reconnecting
  useEffect(() => {
    let cancelled = false;
    engineApi.getScriptStatus().then((res) => {
      if (cancelled) return;
      if (!res.offline && res.ok) {
        setBackendMode('engine');
        if (res.status) {
          setScriptStatus(res.status);
          setCompiledHooks(res.status.hooks);
        }
        if (res.source) {
          setScriptDraft({ source: res.source, name: res.status?.name });
        }
      } else {
        setBackendMode('offline');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isConnected, setScriptDraft, setScriptStatus]);

  const handleCompile = useCallback(
    async (sourceOverride?: string, nameOverride?: string) => {
      const src = sourceOverride ?? scriptSource;
      const name = nameOverride ?? scriptName;
      setBusyAction('compile');
      try {
        const res = await engineApi.scriptCompile(src, name);
        setBackendMode(res.offline ? 'offline' : 'engine');
        setCompiledHooks(res.hooks);
        setCompileOk(res.ok);
        setCompileError(res.error);
        if (res.status) setScriptStatus(res.status);
      } finally {
        setBusyAction(null);
      }
    },
    [scriptSource, scriptName, setScriptStatus]
  );

  // Auto-compile when Fault Rig or MITM Bridge jumps to a template
  useEffect(() => {
    if (!requestedScriptTemplate) return;
    const tpl = SCRIPT_TEMPLATES[requestedScriptTemplate as ScriptTemplateId];
    setDryRunResult(null);
    if (tpl) {
      void handleCompile(tpl.source, `${tpl.id}.lua`);
    } else {
      void handleCompile();
    }
    clearRequestedScriptTemplate();
  }, [requestedScriptTemplate, clearRequestedScriptTemplate, handleCompile]);

  const handleDryRun = useCallback(async () => {
    setBusyAction('dryrun');
    try {
      const pkt = !useManualHex && selectedPacket ? selectedPacket : null;
      const res = await engineApi.scriptTestFrame({
        source: scriptSource,
        name: scriptName,
        port: activePort,
        direction: pkt?.direction ?? 'RX',
        hex: activeInputHex,
        seq_id: pkt?.seqId,
        timestamp_us: pkt?.timestampUs,
        policy: scriptPolicy,
        seed: scriptSeed,
      });
      setBackendMode(res.offline ? 'offline' : 'engine');
      setDryRunResult(res);
      if (res.hooks) setCompiledHooks(res.hooks);
      setCompileOk(res.ok);
      setCompileError(res.ok ? null : res.error);
      const logActions = res.actions
        .filter((a) => a.kind === 'log' && a.message)
        .map((a) => ({
          level: a.level ?? 'info',
          message: a.message!,
          timestamp_us: a.timestamp_us ?? Date.now() * 1000,
        }));
      if (logActions.length > 0) appendScriptLogs(logActions);
    } finally {
      setBusyAction(null);
    }
  }, [
    useManualHex,
    selectedPacket,
    scriptSource,
    scriptName,
    activePort,
    activeInputHex,
    scriptPolicy,
    scriptSeed,
    appendScriptLogs,
  ]);

  const handleArmToggle = useCallback(async () => {
    setBusyAction('arm');
    try {
      if (scriptStatus?.armed) {
        const res = await engineApi.scriptDisarm();
        setBackendMode(res.offline ? 'offline' : 'engine');
        setOfflineArmedScript(null);
        if (res.status) setScriptStatus(res.status);
        toast.info('Script disarmed', `${scriptName || 'script.lua'} detached from frame path.`);
        return;
      }

      const res = await engineApi.scriptArm({
        source: scriptSource,
        name: scriptName,
        policy: scriptPolicy,
        seed: scriptSeed,
      });
      setBackendMode(res.offline ? 'offline' : 'engine');
      if (!res.ok) {
        setCompileOk(false);
        setCompileError(res.error || 'Failed to arm script');
        return;
      }
      setCompileOk(true);
      setCompileError(null);
      if (res.hooks) setCompiledHooks(res.hooks);
      if (res.offline) {
        setOfflineArmedScript({
          source: scriptSource,
          name: scriptName || 'script.lua',
          policy: scriptPolicy,
        });
      } else if (res.status) {
        setScriptStatus(res.status);
      }
      toast.success(
        'Script armed',
        res.offline
          ? `${scriptName || 'script.lua'} active in Simulated Mode.`
          : `${scriptName || 'script.lua'} active on live engine.`
      );
    } finally {
      setBusyAction(null);
    }
  }, [
    scriptStatus?.armed,
    scriptSource,
    scriptName,
    scriptPolicy,
    scriptSeed,
    setOfflineArmedScript,
    setScriptStatus,
  ]);

  const handleReset = useCallback(async () => {
    setBusyAction('reset');
    try {
      const res = await engineApi.scriptResetStats();
      setBackendMode(res.offline ? 'offline' : 'engine');
      resetOfflineScriptStats();
      if (!res.offline && res.status) {
        setScriptStatus(res.status);
      }
    } finally {
      setBusyAction(null);
    }
  }, [resetOfflineScriptStats, setScriptStatus]);

  const handleApplyQuickFault = useCallback(async () => {
    if (!isFaultArmed) return;
    const targetPort = selectedPort || activePort;
    const spec = QUICK_FAULT_OPTIONS[quickFaultKind];
    const ok = await engineApi.setFaultConfig(targetPort, quickFaultKind, spec.options);
    if (ok) {
      toast.success('Fault primitive applied', `${quickFaultKind} is live on ${targetPort}.`);
    } else {
      toast.error('Fault apply failed', `The bforge engine did not accept ${quickFaultKind} for ${targetPort}.`);
    }
  }, [isFaultArmed, selectedPort, activePort, quickFaultKind]);

  const handleDisarmQuickFaults = useCallback(async () => {
    if (isFaultArmed) toggleFaultArm();
    const targetPort = selectedPort || activePort;
    const ok = await engineApi.setFaultConfig(targetPort, 'off');
    if (ok) {
      toast.success('Faults disarmed', `Clean link restored on ${targetPort}.`);
    } else {
      toast.error('Disarm failed', `Engine did not accept disarm command for ${targetPort}.`);
    }
  }, [isFaultArmed, toggleFaultArm, selectedPort, activePort]);

  const handleQuickOneShot = useCallback(
    async (kind: keyof typeof QUICK_ONE_SHOTS) => {
      const targetPort = selectedPort || activePort;
      const spec = QUICK_ONE_SHOTS[kind];
      const result = await engineApi.sendBytes(targetPort, spec.hex);
      if (result.ok) {
        toast.success(spec.okTitle, `${spec.okDesc} on ${targetPort}.`);
      } else {
        toast.error('One-shot not delivered', result.error ?? `No engine connection on ${targetPort}.`);
      }
    },
    [selectedPort, activePort]
  );

  const handleSelectTemplate = (tplKey: string) => {
    if (tplKey === 'custom') return;
    const tpl = SCRIPT_TEMPLATES[tplKey as ScriptTemplateId];
    if (!tpl) return;
    setScriptDraft({ source: tpl.source, name: `${tpl.id}.lua` });
    setCompileOk(null);
    setCompileError(null);
    setDryRunResult(null);
    void handleCompile(tpl.source, `${tpl.id}.lua`);
  };

  const handleLoadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    setScriptDraft({ source: text, name: file.name });
    setCompileOk(null);
    setCompileError(null);
    setDryRunResult(null);
    void handleCompile(text, file.name);
  };

  const handleSaveFile = () => {
    const filename = (scriptName || 'script.lua').trim().endsWith('.lua')
      ? scriptName.trim()
      : `${scriptName.trim() || 'script'}.lua`;
    triggerFileDownload(new Blob([scriptSource], { type: 'text/x-lua;charset=utf-8' }), filename);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const nextValue = `${scriptSource.slice(0, start)}  ${scriptSource.slice(end)}`;
      setScriptDraft({ source: nextValue });
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + 2;
          textareaRef.current.selectionEnd = start + 2;
        }
      });
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleDryRun();
    }
  };

  const handlePlotSeries = (series: string, value?: number, timestampUs?: number) => {
    const fieldName = series.startsWith('script:') ? series : `script:${series}`;
    const plotState = usePlotStore.getState();
    const activeChart =
      plotState.charts.find((c) => c.id === plotState.activeChartId) ?? plotState.charts[0];
    if (
      activeChart &&
      !activeChart.channels.some((ch) => ch.source.kind === 'field' && ch.source.name === fieldName)
    ) {
      plotState.addChannel(activeChart.id, { kind: 'field', name: fieldName }, { label: fieldName });
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      plotEngine.pushScriptMetric(series, timestampUs ?? Date.now() * 1000, value);
    }
    toast.success('Script series added to Plot Forge', `${fieldName} bound to active chart.`);
    requestOpenPanel('plotForge');
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(28, Math.min(72, Math.round(pct))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const displayedHooks =
    compiledHooks.length > 0 ? compiledHooks : scriptStatus?.hooks ?? [];

  const memBytes = scriptStatus?.memory_bytes ?? dryRunResult?.memory_bytes ?? 24_576 + scriptSource.length * 4;
  const memLimit = scriptStatus?.memory_limit_bytes || 4 * 1024 * 1024;
  const memPct = Math.min(100, Math.round((memBytes / memLimit) * 100));
  const memBarColor =
    memPct > 90 ? 'bg-bf-fault' : memPct > 75 ? 'bg-bf-amber' : 'bg-bf-cyan';

  const inputByteTokens = useMemo(
    () => (dryRunResult ? parseByteTokens(dryRunResult.input_hex) : []),
    [dryRunResult]
  );
  const outputByteTokens = useMemo(
    () => (dryRunResult && dryRunResult.verdict !== 'drop' ? parseByteTokens(dryRunResult.output_hex) : []),
    [dryRunResult]
  );

  const isArmed = Boolean(scriptStatus?.armed);
  const verdict = dryRunResult ? verdictMeta(dryRunResult) : null;
  const metricEntries = Object.entries(scriptStatus?.metrics ?? {});
  const assertions = scriptStatus?.assertions ?? [];

  return (
    <div
      data-testid="script-lab-panel"
      className="h-full w-full bg-bf-panel text-bf-body flex flex-col overflow-hidden select-none"
    >
      {/* Header Toolbar */}
      <div className="bg-bf-subpanel border-b border-bf-line px-2.5 py-1 flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Code2 className="w-3.5 h-3.5 text-bf-cyan shrink-0" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[11px]">
            LUA 5.4 SCRIPT LAB
          </span>
          <span
            data-testid="script-backend-badge"
            className={`text-[10px] px-1.5 py-0.5 rounded font-mono border ${
              backendMode === 'engine'
                ? 'bg-bf-ok/15 text-bf-ok border-bf-ok/40'
                : 'bg-bf-amber/15 text-bf-amber border-bf-amber/40'
            }`}
          >
            {backendMode === 'engine' ? 'ENGINE LUA 5.4' : 'SIMULATED PREVIEW'}
          </span>
          {isArmed && (
            <span
              data-testid="script-armed-badge"
              className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-bf-ok/15 text-bf-ok border border-bf-ok/40 font-semibold"
            >
              ARMED
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Lua script template"
            data-testid="script-template-select"
            value={selectedTemplateId}
            onChange={(e) => handleSelectTemplate(e.target.value)}
            className="h-6 px-1.5 bg-bf-panel border border-bf-line rounded text-[11px] font-mono text-bf-body focus:outline-none focus:border-bf-cyan"
          >
            <optgroup label="Starter Templates">
              {Object.values(SCRIPT_TEMPLATES)
                .filter((tpl) => !tpl.id.startsWith('tutorial_'))
                .map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    Template: {tpl.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Tutorial Series (01–15)">
              {Object.values(SCRIPT_TEMPLATES)
                .filter((tpl) => tpl.id.startsWith('tutorial_'))
                .map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    Tutorial {tpl.name}
                  </option>
                ))}
            </optgroup>
            {selectedTemplateId === 'custom' && <option value="custom">Custom Buffer</option>}
          </select>

          <select
            aria-label="Error handling policy"
            data-testid="script-policy-select"
            value={scriptPolicy}
            onChange={(e) =>
              setScriptDraft({ policy: e.target.value as 'fail_open' | 'fail_closed' })
            }
            className="h-6 px-1.5 bg-bf-panel border border-bf-line rounded text-[11px] font-mono text-bf-body focus:outline-none focus:border-bf-cyan"
          >
            <option value="fail_open">FAIL-OPEN</option>
            <option value="fail_closed">FAIL-CLOSED</option>
          </select>

          <label className="flex items-center gap-1 text-[10px] font-mono text-bf-mute">
            <span>SEED</span>
            <input
              aria-label="PRNG seed"
              type="number"
              value={scriptSeed}
              onChange={(e) => setScriptDraft({ seed: Number(e.target.value) || 0 })}
              className="h-6 w-14 px-1 bg-bf-panel border border-bf-line rounded text-[11px] font-mono text-bf-body tabular-nums focus:outline-none focus:border-bf-cyan"
            />
          </label>

          <button
            type="button"
            data-testid="script-compile-btn"
            disabled={busyAction !== null}
            onClick={() => void handleCompile()}
            className="h-6 px-2 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-[11px] font-mono text-bf-body flex items-center gap-1 disabled:opacity-50"
          >
            <CheckCircle2 className="w-3 h-3 text-bf-cyan" />
            COMPILE
          </button>

          <button
            type="button"
            data-testid="script-dryrun-btn"
            disabled={busyAction !== null}
            onClick={() => void handleDryRun()}
            title="Dry-run against current packet (Ctrl+Enter)"
            className="h-6 px-2 rounded border border-bf-cyan/50 bg-bf-cyan/15 hover:bg-bf-cyan/25 text-[11px] font-mono font-semibold text-bf-cyan flex items-center gap-1 disabled:opacity-50"
          >
            <Play className="w-3 h-3" />
            DRY-RUN PACKET
          </button>

          <button
            type="button"
            data-testid="script-arm-btn"
            disabled={busyAction !== null}
            onClick={() => void handleArmToggle()}
            className={`h-6 px-2 rounded border text-[11px] font-mono font-semibold flex items-center gap-1 disabled:opacity-50 ${
              isArmed
                ? 'border-bf-fault/60 bg-bf-fault/15 hover:bg-bf-fault/25 text-bf-fault'
                : 'border-bf-ok/50 bg-bf-ok/15 hover:bg-bf-ok/25 text-bf-ok'
            }`}
          >
            <Power className="w-3 h-3" />
            {isArmed ? 'DISARM' : 'ARM SCRIPT'}
          </button>

          <button
            type="button"
            data-testid="script-reset-btn"
            disabled={busyAction !== null}
            onClick={() => void handleReset()}
            title="Reset VM counters and metrics"
            className="h-6 px-1.5 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-[11px] font-mono text-bf-mute hover:text-bf-body flex items-center gap-1 disabled:opacity-50"
          >
            <RotateCcw className="w-3 h-3" />
            RESET
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".lua,.txt"
            onChange={handleLoadFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Load .lua script from disk"
            className="h-6 px-1.5 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-[11px] font-mono text-bf-mute hover:text-bf-body flex items-center gap-1"
          >
            <Upload className="w-3 h-3" />
            LOAD
          </button>
          <button
            type="button"
            onClick={handleSaveFile}
            title="Download current script as .lua"
            className="h-6 px-1.5 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-[11px] font-mono text-bf-mute hover:text-bf-body flex items-center gap-1"
          >
            <Download className="w-3 h-3" />
            SAVE
          </button>
          <button
            type="button"
            data-testid="script-quick-faults-toggle"
            onClick={() => setShowQuickFaults((v) => !v)}
            title="Toggle inline Quick Hardware Fault Injection controls"
            className={`h-6 px-1.5 rounded border text-[11px] font-mono flex items-center gap-1 ${
              showQuickFaults || isFaultArmed
                ? 'border-bf-fault/60 bg-bf-fault/15 text-bf-fault font-semibold'
                : 'border-bf-line bg-bf-panel hover:bg-bf-hover text-bf-mute hover:text-bf-body'
            }`}
          >
            <ShieldAlert className="w-3 h-3" />
            QUICK FAULTS
          </button>
        </div>
      </div>

      {/* Collapsible Inline Quick Hardware Fault Strip */}
      {showQuickFaults && (
        <div
          data-testid="script-quick-fault-bar"
          className="bg-bf-head border-b border-bf-line px-2.5 py-1 flex flex-wrap items-center justify-between gap-2 shrink-0 font-mono text-[10px]"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={toggleFaultArm}
              className={`h-5 px-2 rounded border font-semibold flex items-center gap-1 ${
                isFaultArmed
                  ? 'border-bf-fault bg-bf-fault/20 text-bf-fault'
                  : 'border-bf-ok/50 bg-bf-ok/15 text-bf-ok'
              }`}
            >
              {isFaultArmed ? <ShieldAlert className="w-2.5 h-2.5" /> : <ShieldCheck className="w-2.5 h-2.5" />}
              {isFaultArmed ? 'FAULTS ARMED' : 'SAFE MODE'}
            </button>

            <select
              aria-label="Quick hardware fault primitive"
              value={quickFaultKind}
              onChange={(e) => setQuickFaultKind(e.target.value as QuickFaultKind)}
              className="h-5 px-1.5 bg-bf-panel border border-bf-line rounded text-[10px] text-bf-body focus:outline-none focus:border-bf-cyan"
            >
              {(Object.entries(QUICK_FAULT_OPTIONS) as Array<[QuickFaultKind, { label: string }]>).map(
                ([kind, meta]) => (
                  <option key={kind} value={kind}>
                    {meta.label}
                  </option>
                )
              )}
            </select>

            <button
              type="button"
              disabled={!isFaultArmed}
              onClick={() => void handleApplyQuickFault()}
              className="h-5 px-2 rounded border border-bf-fault/60 bg-bf-fault/15 hover:bg-bf-fault/25 text-bf-fault font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              APPLY FAULT
            </button>

            <button
              type="button"
              onClick={() => void handleDisarmQuickFaults()}
              className="h-5 px-2 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-bf-mute hover:text-bf-body"
            >
              DISARM ALL
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleQuickOneShot('badCrc')}
              className="h-5 px-2 rounded border border-bf-amber/40 bg-bf-amber/10 hover:bg-bf-amber/20 text-bf-amber"
            >
              1-SHOT BAD CRC (×3)
            </button>
            <button
              type="button"
              onClick={() => void handleQuickOneShot('drop')}
              className="h-5 px-2 rounded border border-bf-amber/40 bg-bf-amber/10 hover:bg-bf-amber/20 text-bf-amber"
            >
              1-SHOT DROP (×2)
            </button>
            <button
              type="button"
              onClick={() => requestOpenPanel('faultRig')}
              className="h-5 px-2 rounded border border-bf-line bg-bf-panel hover:bg-bf-hover text-bf-cyan"
            >
              FULL FAULT RIG ↗
            </button>
          </div>
        </div>
      )}

      {/* Split Workspace */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden"
      >
        {/* Left Pane: Lua 5.4 Editor */}
        <div
          style={{ flexBasis: `${splitPct}%` }}
          className="min-w-0 min-h-0 flex flex-col border-b md:border-b-0 md:border-r border-bf-line overflow-hidden shrink-0 grow md:grow-0"
        >
          {/* Editor Sub-header: Script Filename + Active Hooks + API Ref Toggle */}
          <div className="bg-bf-head border-b border-bf-line px-2 py-1 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <input
                aria-label="Script name"
                value={scriptName}
                onChange={(e) => setScriptDraft({ name: e.target.value })}
                className="h-5 w-36 px-1.5 bg-bf-panel border border-bf-line rounded text-[11px] font-mono text-bf-body focus:outline-none focus:border-bf-cyan"
              />
              <div className="flex flex-wrap items-center gap-1">
                {displayedHooks.length > 0 ? (
                  displayedHooks.map((h) => (
                    <span
                      key={h}
                      className="text-[10px] px-1.5 py-0.2 rounded font-mono bg-bf-cyan/10 text-bf-cyan border border-bf-cyan/30"
                    >
                      {h}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] font-mono text-bf-faint">no hooks compiled</span>
                )}
                {compileOk === true && !compileError && (
                  <span className="text-[10px] font-mono text-bf-ok">compiled ok</span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowApiRef((v) => !v)}
              className={`h-5 px-1.5 rounded border text-[10px] font-mono flex items-center gap-1 ${
                showApiRef
                  ? 'border-bf-cyan/50 bg-bf-cyan/15 text-bf-cyan'
                  : 'border-bf-line bg-bf-panel text-bf-mute hover:text-bf-body'
              }`}
            >
              <BookOpen className="w-3 h-3" />
              API REF
            </button>
          </div>

          {/* API Cheatsheet Drawer */}
          {showApiRef && (
            <div className="bg-bf-subpanel border-b border-bf-line px-2.5 py-1.5 max-h-36 overflow-y-auto shrink-0">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
                {SCRIPT_API_DOCS.map((item) => (
                  <div key={item.fn} className="truncate">
                    <span className="text-bf-cyan">{item.fn}</span>{' '}
                    <span className="text-bf-mute">— {item.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Compile Error Banner */}
          {compileError && (
            <div
              data-testid="script-compile-error"
              className="bg-bf-fault/10 border-b border-bf-fault/40 px-2.5 py-1 flex items-center gap-1.5 text-[11px] font-mono text-bf-fault shrink-0"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{compileError}</span>
            </div>
          )}

          {/* Line-Numbered Monospace Editor */}
          <div className="flex-1 min-h-0 flex bg-bf-panel overflow-hidden">
            <div
              ref={gutterRef}
              aria-hidden="true"
              className="w-10 py-2 pr-2 bg-bf-subpanel border-r border-bf-line text-right font-mono text-[12px] leading-5 text-bf-faint overflow-hidden shrink-0 select-none"
            >
              {Array.from({ length: lineCount }, (_, idx) => (
                <div key={idx + 1}>{idx + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              aria-label="Lua 5.4 script source"
              data-testid="script-editor-textarea"
              value={scriptSource}
              onChange={(e) => {
                setScriptDraft({ source: e.target.value });
                setCompileOk(null);
              }}
              onScroll={syncScroll}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              className="flex-1 min-w-0 h-full py-2 px-2.5 bg-bf-panel text-bf-body font-mono text-[12px] leading-5 resize-none focus:outline-none select-text overflow-auto whitespace-pre"
            />
          </div>

          {/* Footer VM Memory Meter */}
          <div className="h-6 bg-bf-subpanel border-t border-bf-line px-2.5 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[10px] font-mono text-bf-mute shrink-0">
                VM MEMORY: {formatBytesKb(memBytes)} / {formatBytesKb(memLimit)}
              </span>
              <div className="flex-1 max-w-44 h-1.5 bg-bf-panel border border-bf-line rounded overflow-hidden">
                <div
                  className={`h-full transition-all ${memBarColor}`}
                  style={{ width: `${Math.max(2, memPct)}%` }}
                />
              </div>
            </div>
            <span className="text-[10px] font-mono text-bf-faint shrink-0">
              Tab: indent · Ctrl+Enter: dry-run
            </span>
          </div>
        </div>

        {/* Horizontal Resize Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startResize}
          className="hidden md:block w-1 bg-bf-line hover:bg-bf-cyan cursor-col-resize shrink-0 transition-colors"
        />

        {/* Right Pane: DRY-RUN DIFF | LIVE VM & WATCH */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-bf-panel overflow-hidden">
          <div className="bg-bf-head border-b border-bf-line px-2 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="script-tab-dryrun"
                onClick={() => setRightTab('dryrun')}
                className={`px-2.5 py-1 text-[11px] font-mono border-b-2 transition-colors ${
                  rightTab === 'dryrun'
                    ? 'border-bf-cyan text-bf-body font-semibold'
                    : 'border-transparent text-bf-mute hover:text-bf-body'
                }`}
              >
                DRY-RUN DIFF
              </button>
              <button
                type="button"
                data-testid="script-tab-watch"
                onClick={() => setRightTab('watch')}
                className={`px-2.5 py-1 text-[11px] font-mono border-b-2 flex items-center gap-1.5 transition-colors ${
                  rightTab === 'watch'
                    ? 'border-bf-cyan text-bf-body font-semibold'
                    : 'border-transparent text-bf-mute hover:text-bf-body'
                }`}
              >
                LIVE VM &amp; WATCH
                {((scriptStatus?.failures ?? 0) > 0 || (scriptStatus?.assertions_failed ?? 0) > 0) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-bf-fault" />
                )}
              </button>
            </div>

            {dryRunResult && rightTab === 'dryrun' && (
              <div className="flex items-center gap-1.5">
                {dryRunResult.offline && (
                  <span
                    data-testid="script-sandbox-badge"
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-bf-amber/15 text-bf-amber border border-bf-amber/40"
                  >
                    SIMULATED SANDBOX
                  </span>
                )}
                {verdict && (
                  <span
                    data-testid="script-verdict-badge"
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold border ${verdict.cls}`}
                  >
                    {verdict.label}
                  </span>
                )}
              </div>
            )}
          </div>

          {rightTab === 'dryrun' ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5">
              {/* Input Frame Selector */}
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono">
                  <span className="text-bf-mute">
                    {!useManualHex && selectedPacket
                      ? `TEST TARGET: #${selectedPacket.seqId} · ${selectedPacket.port} · ${selectedPacket.direction} (${selectedPacket.length} B)`
                      : `TEST TARGET: MANUAL HEX · ${activePort}`}
                  </span>
                  {selectedPacket && useManualHex && (
                    <button
                      type="button"
                      onClick={() => setUseManualHex(false)}
                      className="text-bf-cyan hover:underline"
                    >
                      USE SELECTED (#{selectedPacket.seqId})
                    </button>
                  )}
                </div>
                <input
                  aria-label="Test frame hex payload"
                  value={activeInputHex}
                  onChange={(e) => {
                    setManualHex(e.target.value);
                    setUseManualHex(true);
                  }}
                  className="w-full h-6 px-2 bg-bf-panel border border-bf-line rounded font-mono text-[12px] text-bf-body focus:outline-none focus:border-bf-cyan select-text"
                />
              </div>

              {!dryRunResult ? (
                <div className="bg-bf-subpanel border border-bf-line rounded p-4 text-center space-y-1.5">
                  <Zap className="w-5 h-5 text-bf-cyan mx-auto" />
                  <div className="text-[12px] font-mono text-bf-body">
                    Press DRY-RUN PACKET (or Ctrl+Enter) to preview mutations &amp; VM cost.
                  </div>
                  <div className="text-[11px] font-mono text-bf-mute">
                    Dry-run executes once in isolation without modifying armed live counters.
                  </div>
                </div>
              ) : (
                <>
                  {/* VM Cost Strip */}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 bg-bf-subpanel border border-bf-line rounded text-[11px] font-mono tabular-nums">
                    <span data-testid="script-vm-cost" className="text-bf-body">
                      VM COST: {dryRunResult.instructions.toLocaleString()} / 200,000 instr ·{' '}
                      {dryRunResult.exec_us} µs
                    </span>
                    <span className="text-bf-mute">
                      MEM: {formatBytesKb(dryRunResult.memory_bytes)} · DIFFS:{' '}
                      {dryRunResult.field_diffs.length}
                    </span>
                  </div>

                  {dryRunResult.error && (
                    <div className="bg-bf-fault/10 border border-bf-fault/40 rounded px-2.5 py-1.5 text-[11px] font-mono text-bf-fault flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span className="break-all">{dryRunResult.error}</span>
                    </div>
                  )}

                  {/* Byte Diff Grid */}
                  <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-mono text-bf-mute">
                      <span>BYTE DIFF GRID ({inputByteTokens.length} B)</span>
                      <span>
                        {dryRunResult.verdict === 'drop'
                          ? 'FRAME DROPPED'
                          : dryRunResult.mutated
                          ? 'CHANGED BYTES HIGHLIGHTED'
                          : 'NO BYTE MUTATIONS'}
                      </span>
                    </div>
                    <div className="space-y-1 font-mono text-[12px]">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="w-12 text-[10px] text-bf-faint shrink-0">BEFORE</span>
                        {inputByteTokens.map((tok, idx) => {
                          const changed =
                            dryRunResult.verdict !== 'drop' && outputByteTokens[idx] !== tok;
                          return (
                            <span
                              key={`in-${idx}`}
                              title={`offset ${idx}: ${tok}`}
                              className={`px-1 py-0.5 rounded border text-[11px] ${
                                changed
                                  ? 'bg-bf-amber/15 text-bf-amber border-bf-amber/40'
                                  : 'bg-bf-panel text-bf-mute border-bf-line'
                              }`}
                            >
                              {tok}
                            </span>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="w-12 text-[10px] text-bf-faint shrink-0">AFTER</span>
                        {dryRunResult.verdict === 'drop' ? (
                          <span className="text-[11px] text-bf-fault">nil (dropped)</span>
                        ) : (
                          outputByteTokens.map((tok, idx) => {
                            const changed = inputByteTokens[idx] !== tok;
                            return (
                              <span
                                key={`out-${idx}`}
                                title={`offset ${idx}: ${inputByteTokens[idx] ?? '--'} -> ${tok}`}
                                className={`px-1 py-0.5 rounded border text-[11px] ${
                                  changed
                                    ? 'bg-bf-cyan/20 text-bf-cyan border-bf-cyan/60 font-semibold'
                                    : 'bg-bf-panel text-bf-body border-bf-line'
                                }`}
                              >
                                {tok}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Decoded Field Diff */}
                  <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1">
                    <div className="text-[10px] font-mono text-bf-mute">DECODED FIELD DIFF</div>
                    {dryRunResult.field_diffs.length === 0 ? (
                      <div className="text-[11px] font-mono text-bf-faint">
                        No schema field changes detected.
                      </div>
                    ) : (
                      <div className="space-y-1 font-mono text-[12px]">
                        {dryRunResult.field_diffs.map((d) => (
                          <div
                            key={d.name}
                            className="flex items-center justify-between gap-2 px-1.5 py-0.5 bg-bf-panel border border-bf-line rounded"
                          >
                            <span className="text-bf-cyan">{d.name}</span>
                            <span>
                              <span className="text-bf-mute">{d.before ?? 'nil'}</span>
                              <span className="text-bf-faint mx-1.5">→</span>
                              <span className="text-bf-amber font-semibold">
                                {d.after ?? 'nil'}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Emitted Side-Effects */}
                  <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1">
                    <div className="text-[10px] font-mono text-bf-mute">
                      EMITTED SIDE-EFFECTS ({dryRunResult.actions.length})
                    </div>
                    {dryRunResult.actions.length === 0 ? (
                      <div className="text-[11px] font-mono text-bf-faint">
                        No send, plot, pin, or log actions emitted.
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {dryRunResult.actions.map((act, idx) => (
                          <div
                            key={idx}
                            className="flex items-center justify-between gap-2 px-2 py-1 bg-bf-panel border border-bf-line rounded font-mono text-[11px]"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] px-1 py-0.2 rounded bg-bf-head border border-bf-line text-bf-cyan uppercase shrink-0">
                                {act.kind}
                              </span>
                              {act.kind === 'send' && (
                                <span className="truncate text-bf-body">
                                  {act.port} · {act.hex}
                                  {act.delay_ms ? ` (+${act.delay_ms} ms)` : ''}
                                </span>
                              )}
                              {act.kind === 'plot' && (
                                <span className="truncate text-bf-body">
                                  script:{act.series} ={' '}
                                  <span className="text-bf-amber tabular-nums">{act.value}</span>
                                </span>
                              )}
                              {act.kind === 'pulse_pin' && (
                                <span className="truncate text-bf-body">
                                  {act.pin} pulse {act.delay_ms ?? 50} ms
                                </span>
                              )}
                              {act.kind === 'set_pins' && (
                                <span className="truncate text-bf-body">
                                  {act.port} DTR={String(act.dtr)} RTS={String(act.rts)}
                                </span>
                              )}
                              {act.kind === 'log' && (
                                <span
                                  className={`truncate ${
                                    act.level === 'warn'
                                      ? 'text-bf-amber'
                                      : act.level === 'error'
                                      ? 'text-bf-fault'
                                      : 'text-bf-body'
                                  }`}
                                >
                                  [{act.level ?? 'info'}] {act.message}
                                </span>
                              )}
                            </div>

                            {act.kind === 'plot' && act.series && (
                              <button
                                type="button"
                                onClick={() =>
                                  handlePlotSeries(act.series!, act.value, act.timestamp_us)
                                }
                                className="h-5 px-1.5 rounded border border-bf-cyan/40 bg-bf-cyan/10 hover:bg-bf-cyan/20 text-[10px] font-mono text-bf-cyan flex items-center gap-1 shrink-0"
                              >
                                <LineChart className="w-3 h-3" />
                                PLOT
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Dry-Run Metrics & Assertions Preview */}
                  {(Object.keys(dryRunResult.metrics).length > 0 ||
                    dryRunResult.assertions.length > 0) && (
                    <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1.5">
                      <div className="text-[10px] font-mono text-bf-mute">
                        DRY-RUN METRICS &amp; ASSERTIONS
                      </div>
                      <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                        {Object.entries(dryRunResult.metrics).map(([k, v]) => (
                          <span
                            key={k}
                            className="px-1.5 py-0.5 rounded bg-bf-panel border border-bf-line text-bf-body"
                          >
                            {k}: <span className="text-bf-cyan tabular-nums">{v}</span>
                          </span>
                        ))}
                        {dryRunResult.assertions.map((a) => (
                          <span
                            key={a.name}
                            className={`px-1.5 py-0.5 rounded border ${
                              a.failed > 0
                                ? 'bg-bf-fault/10 border-bf-fault/40 text-bf-fault'
                                : 'bg-bf-ok/10 border-bf-ok/40 text-bf-ok'
                            }`}
                          >
                            assert({a.name}): {a.failed > 0 ? 'FAIL' : 'PASS'}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            /* LIVE VM & WATCH Tab */
            <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5">
              {/* Counters Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {[
                  { label: 'INVOCATIONS', value: scriptStatus?.invocations ?? 0 },
                  { label: 'CHANGED', value: scriptStatus?.changed ?? 0, accent: 'text-bf-cyan' },
                  { label: 'DROPPED', value: scriptStatus?.dropped ?? 0, accent: 'text-bf-amber' },
                  { label: 'DELAYED', value: scriptStatus?.delayed ?? 0 },
                  { label: 'INJECTED TX', value: scriptStatus?.injected_tx ?? 0 },
                  { label: 'FAILURES', value: scriptStatus?.failures ?? 0, accent: 'text-bf-fault' },
                  { label: 'MAX EXEC', value: `${scriptStatus?.max_exec_us ?? 0} µs` },
                  { label: 'LOGS SUPPR', value: scriptStatus?.logs_suppressed ?? 0 },
                ].map((c) => (
                  <div
                    key={c.label}
                    className="bg-bf-subpanel border border-bf-line rounded px-2 py-1.5"
                  >
                    <div className="text-[10px] font-mono text-bf-faint">{c.label}</div>
                    <div
                      className={`text-[12px] font-mono font-semibold tabular-nums ${
                        c.accent ?? 'text-bf-body'
                      }`}
                    >
                      {c.value}
                    </div>
                  </div>
                ))}
              </div>

              {scriptStatus?.last_error && (
                <div className="bg-bf-fault/10 border border-bf-fault/40 rounded px-2.5 py-1.5 text-[11px] font-mono text-bf-fault flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span className="break-all">LAST VM ERROR: {scriptStatus.last_error}</span>
                </div>
              )}

              {/* bforge.metric Watch Table */}
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1">
                <div className="flex items-center gap-1 text-[10px] font-mono text-bf-mute">
                  <Activity className="w-3 h-3 text-bf-cyan" />
                  <span>BFORGE.METRIC WATCH ({metricEntries.length})</span>
                </div>
                {metricEntries.length === 0 ? (
                  <div className="text-[11px] font-mono text-bf-faint">
                    Arm the script and run frames to inspect live watch metrics.
                  </div>
                ) : (
                  <div className="divide-y divide-bf-line border border-bf-line rounded bg-bf-panel">
                    {metricEntries.map(([k, v]) => (
                      <div
                        key={k}
                        className="px-2 py-1 flex items-center justify-between font-mono text-[12px]"
                      >
                        <span className="text-bf-cyan">{k}</span>
                        <span className="text-bf-body tabular-nums">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* bforge.assert Scoreboard */}
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1">
                <div className="text-[10px] font-mono text-bf-mute">
                  BFORGE.ASSERT SCOREBOARD ({assertions.length})
                </div>
                {assertions.length === 0 ? (
                  <div className="text-[11px] font-mono text-bf-faint">
                    No runtime assertions recorded yet.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {assertions.map((a) => (
                      <div
                        key={a.name}
                        className="px-2 py-1 bg-bf-panel border border-bf-line rounded flex items-center justify-between gap-2 font-mono text-[11px]"
                      >
                        <div className="min-w-0">
                          <div className="text-bf-body truncate">{a.name}</div>
                          {a.last_error && (
                            <div className="text-[10px] text-bf-fault truncate">{a.last_error}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 tabular-nums">
                          <span className="text-bf-ok">PASS {a.passed}</span>
                          <span className={a.failed > 0 ? 'text-bf-fault' : 'text-bf-mute'}>
                            FAIL {a.failed}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Script Log Console */}
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 space-y-1">
                <div className="flex items-center gap-1 text-[10px] font-mono text-bf-mute">
                  <Terminal className="w-3 h-3 text-bf-cyan" />
                  <span>SCRIPT CONSOLE ({scriptLogs.length})</span>
                </div>
                <div className="max-h-36 overflow-y-auto bg-bf-panel border border-bf-line rounded p-1.5 space-y-0.5 font-mono text-[11px] select-text">
                  {scriptLogs.length === 0 ? (
                    <div className="text-bf-faint">No bforge.log output yet.</div>
                  ) : (
                    scriptLogs.map((entry, idx) => (
                      <div
                        key={idx}
                        className={
                          entry.level === 'error'
                            ? 'text-bf-fault'
                            : entry.level === 'warn'
                            ? 'text-bf-amber'
                            : 'text-bf-body'
                        }
                      >
                        [{entry.level}] {entry.message}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
