import React, { useState } from 'react';
import { engineApi } from '../services/engineApi';
import { GitCompare, Play, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

interface DiffResult {
  records_a: number;
  records_b: number;
  frames_a: number;
  frames_b: number;
  identical: boolean;
  first_divergence?: {
    record: number;
    reason: string;
    field?: string;
  };
  changed_fields: Array<{
    name: string;
    occurrences: number;
    sample_a: string;
    sample_b: string;
  }>;
  missing_from_a: number;
  missing_from_b: number;
}

export const SessionDiffView: React.FC = () => {
  const [vaultA, setVaultA] = useState('vaults/imu-assert.bflog');
  const [vaultB, setVaultB] = useState('vaults/s6-COM8.bflog');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const presets = [
    { label: 'IMU Assert vs Hardware Run', a: 'vaults/imu-assert.bflog', b: 'vaults/s6-COM8.bflog' },
    { label: 'COM8 Run 2 vs Run 4', a: 'vaults/s2-COM8.bflog', b: 'vaults/s4-COM8.bflog' },
    { label: 'Simulation vs Throughput', a: 'vaults/sim.bflog', b: 'vaults/throughput.bflog' },
  ];

  const handleRunDiff = async () => {
    if (!vaultA.trim() || !vaultB.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await engineApi.getDiff(vaultA.trim(), vaultB.trim());
      if (result.ok && result.report) {
        setResult(result.report);
      } else {
        // Honest failure: never fabricate a diff. A validation tool that
        // invents divergences is worse than one that reports the real reason.
        setResult(null);
        setError(
          result.error
            ? String(result.error)
            : 'Engine unreachable — no real comparison available. Start the bforge engine and ensure both .bflog paths exist.'
        );
      }
    } catch (err: any) {
      setError(err?.message || 'Diff failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-bf-panel select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-bf-subpanel border-b border-bf-line px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <GitCompare className="w-3 h-3 text-bf-cyan" />
          <span className="font-mono font-semibold text-bf-body tracking-wide text-[10.5px]">
            SEMANTIC SESSION DIFF
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-bf-hover text-bf-cyan font-mono border border-bf-cyan/30">
            SESSION COMPARISON
          </span>
        </div>

        {result && (
          <div>
            {result.identical ? (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-bf-ok/20 border border-bf-ok/60 text-bf-ok rounded text-[9.5px] font-mono font-bold">
                <CheckCircle2 className="w-2.5 h-2.5" />
                IDENTICAL CAPTURES
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-bf-warn/20 border border-bf-warn text-bf-warn rounded text-[9.5px] font-mono font-bold">
                <AlertTriangle className="w-2.5 h-2.5" />
                {result.changed_fields.length} FIELD DIVERGENCES
              </span>
            )}
          </div>
        )}
      </div>

      {/* Target Vault Selectors & Presets */}
      <div className="bg-bf-head border-b border-bf-line p-2 flex flex-col gap-1.5 shrink-0">
        <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
          {/* Vault A */}
          <div className="flex items-center gap-1 bg-bf-subpanel border border-bf-line rounded px-2 py-0.5">
            <span className="text-bf-cyan font-mono font-bold text-[9.5px]">A:</span>
            <input
              type="text"
              value={vaultA}
              onChange={(e) => setVaultA(e.target.value)}
              placeholder="Baseline golden vault (.bflog)..."
              className="bg-transparent text-bf-body font-mono text-[10.5px] w-full focus:outline-none"
            />
          </div>

          <ArrowRight className="w-3 h-3 text-bf-faint" />

          {/* Vault B */}
          <div className="flex items-center gap-1 bg-bf-subpanel border border-bf-line rounded px-2 py-0.5">
            <span className="text-bf-amber font-mono font-bold text-[9.5px]">B:</span>
            <input
              type="text"
              value={vaultB}
              onChange={(e) => setVaultB(e.target.value)}
              placeholder="Test comparison vault (.bflog)..."
              className="bg-transparent text-bf-body font-mono text-[10.5px] w-full focus:outline-none"
            />
          </div>

          {/* Run Diff Button */}
          <button
            onClick={handleRunDiff}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1 bg-bf-cyan hover:bg-bf-cyan-hi text-bf-onfill font-bold rounded font-mono text-[10.5px] transition-colors"
          >
            <Play className="w-2.5 h-2.5 fill-current" />
            <span>{loading ? 'ANALYZING...' : 'RUN DIFF'}</span>
          </button>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-1.5 font-mono text-[9.5px]">
          <span className="text-bf-faint">PRESETS:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setVaultA(p.a);
                setVaultB(p.b);
              }}
              className="px-1.5 py-0.2 bg-bf-subpanel hover:bg-bf-active text-bf-mute hover:text-bf-cyan rounded border border-bf-line transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Diff Content Viewport */}
      <div className="flex-1 overflow-auto p-2 font-mono">
        {!result && !error && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-bf-faint">
            <GitCompare className="w-6 h-6 mb-2 text-bf-faint" />
            <p className="text-xs font-semibold text-bf-mute mb-1">Semantic Session Diff Engine</p>
            <p className="text-[10.5px] max-w-sm mb-3">
              Compare an anomalous hardware run against a golden baseline vault to instantly isolate corrupted fields, dropped frames, and clock drifts.
            </p>
            <button
              onClick={handleRunDiff}
              className="px-2.5 py-1 bg-bf-subpanel hover:bg-bf-active border border-bf-cyan/40 text-bf-cyan rounded text-[10.5px] font-mono font-medium transition-colors"
            >
              Run Demo Regression Comparison
            </button>
          </div>
        )}

        {error && (
          <div className="bg-bf-fault/15 border border-bf-fault rounded p-2 text-bf-fault text-[10.5px] mb-2">
            Diff Error: {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            {/* Summary Metrics Bar */}
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 flex flex-col">
                <span className="text-bf-faint text-[9.5px]">RECORDS (A / B)</span>
                <span className="text-[13px] font-bold text-bf-body">
                  {result.records_a} / {result.records_b}
                </span>
              </div>
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 flex flex-col">
                <span className="text-bf-faint text-[9.5px]">FRAMES (A / B)</span>
                <span className="text-[13px] font-bold text-bf-body">
                  {result.frames_a} / {result.frames_b}
                </span>
              </div>
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 flex flex-col">
                <span className="text-bf-faint text-[9.5px]">MISSING FRAMES</span>
                <span className="text-[13px] font-bold text-bf-warn">
                  {result.missing_from_b} dropped
                </span>
              </div>
              <div className="bg-bf-subpanel border border-bf-line rounded p-2 flex flex-col">
                <span className="text-bf-faint text-[9.5px]">FIRST DIVERGENCE</span>
                <span className="text-[13px] font-bold text-bf-fault">
                  {result.first_divergence ? `Record #${result.first_divergence.record}` : 'None'}
                </span>
              </div>
            </div>

            {/* First Divergence Banner */}
            {result.first_divergence && (
              <div className="bg-bf-fault/10 border border-bf-fault/60 rounded p-2 flex items-center justify-between text-[10.5px]">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-bf-fault shrink-0" />
                  <div>
                    <span className="font-bold text-bf-fault">
                      First divergence at record #{result.first_divergence.record}:
                    </span>{' '}
                    <span className="text-bf-body">{result.first_divergence.reason}</span>
                    {result.first_divergence.field && (
                      <span className="ml-1 text-bf-cyan">[{result.first_divergence.field}]</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Changed Fields Table */}
            <div className="bg-bf-subpanel border border-bf-line rounded overflow-hidden">
              <div className="h-[22px] bg-bf-head border-b border-bf-line grid grid-cols-[140px_80px_1fr_1fr] px-2 text-[9.5px] text-bf-faint uppercase tracking-wider items-center">
                <div>Field Name</div>
                <div>Count</div>
                <div>Sample Baseline (A)</div>
                <div>Sample Test (B)</div>
              </div>
              <div className="divide-y divide-bf-line/50 text-[10.5px]">
                {result.changed_fields.length === 0 ? (
                  <div className="p-3 text-center text-bf-faint">No field differences found.</div>
                ) : (
                  result.changed_fields.map((f) => (
                    <div
                      key={f.name}
                      className="grid grid-cols-[140px_80px_1fr_1fr] px-2 py-1 items-center hover:bg-bf-hover"
                    >
                      <div className="font-semibold text-bf-cyan">{f.name}</div>
                      <div className="text-bf-warn">{f.occurrences}x</div>
                      <div className="text-bf-mute truncate">{f.sample_a}</div>
                      <div className="text-bf-amber font-medium truncate">{f.sample_b}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
