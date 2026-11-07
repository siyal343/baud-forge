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
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px] overflow-hidden">
      {/* Header */}
      <div className="h-[24px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <GitCompare className="w-3 h-3 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            SEMANTIC SESSION DIFF
          </span>
          <span className="text-[9.5px] px-1 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] font-mono border border-[#00E5FF]/30">
            SESSION COMPARISON
          </span>
        </div>

        {result && (
          <div>
            {result.identical ? (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-[#10B981]/20 border border-[#10B981]/60 text-[#10B981] rounded text-[9.5px] font-mono font-bold">
                <CheckCircle2 className="w-2.5 h-2.5" />
                IDENTICAL CAPTURES
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.2 bg-[#F59E0B]/20 border border-[#F59E0B] text-[#F59E0B] rounded text-[9.5px] font-mono font-bold">
                <AlertTriangle className="w-2.5 h-2.5" />
                {result.changed_fields.length} FIELD DIVERGENCES
              </span>
            )}
          </div>
        )}
      </div>

      {/* Target Vault Selectors & Presets */}
      <div className="bg-[#121722] border-b border-[#222D3D] p-2 flex flex-col gap-1.5 shrink-0">
        <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
          {/* Vault A */}
          <div className="flex items-center gap-1 bg-[#161C28] border border-[#222D3D] rounded px-2 py-0.5">
            <span className="text-[#00E5FF] font-mono font-bold text-[9.5px]">A:</span>
            <input
              type="text"
              value={vaultA}
              onChange={(e) => setVaultA(e.target.value)}
              placeholder="Baseline golden vault (.bflog)..."
              className="bg-transparent text-[#E2E8F0] font-mono text-[10.5px] w-full focus:outline-none"
            />
          </div>

          <ArrowRight className="w-3 h-3 text-[#64748B]" />

          {/* Vault B */}
          <div className="flex items-center gap-1 bg-[#161C28] border border-[#222D3D] rounded px-2 py-0.5">
            <span className="text-[#FBBF24] font-mono font-bold text-[9.5px]">B:</span>
            <input
              type="text"
              value={vaultB}
              onChange={(e) => setVaultB(e.target.value)}
              placeholder="Test comparison vault (.bflog)..."
              className="bg-transparent text-[#E2E8F0] font-mono text-[10.5px] w-full focus:outline-none"
            />
          </div>

          {/* Run Diff Button */}
          <button
            onClick={handleRunDiff}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded font-mono text-[10.5px] transition-colors"
          >
            <Play className="w-2.5 h-2.5 fill-current" />
            <span>{loading ? 'ANALYZING...' : 'RUN DIFF'}</span>
          </button>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-1.5 font-mono text-[9.5px]">
          <span className="text-[#64748B]">PRESETS:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setVaultA(p.a);
                setVaultB(p.b);
              }}
              className="px-1.5 py-0.2 bg-[#161C28] hover:bg-[#26324A] text-[#94A3B8] hover:text-[#00E5FF] rounded border border-[#222D3D] transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Diff Content Viewport */}
      <div className="flex-1 overflow-auto p-2 font-mono">
        {!result && !error && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#64748B]">
            <GitCompare className="w-6 h-6 mb-2 text-[#64748B]" />
            <p className="text-xs font-semibold text-[#94A3B8] mb-1">Semantic Session Diff Engine</p>
            <p className="text-[10.5px] max-w-sm mb-3">
              Compare an anomalous hardware run against a golden baseline vault to instantly isolate corrupted fields, dropped frames, and clock drifts.
            </p>
            <button
              onClick={handleRunDiff}
              className="px-2.5 py-1 bg-[#161C28] hover:bg-[#26324A] border border-[#00E5FF]/40 text-[#00E5FF] rounded text-[10.5px] font-mono font-medium transition-colors"
            >
              Run Demo Regression Comparison
            </button>
          </div>
        )}

        {error && (
          <div className="bg-[#EF4444]/15 border border-[#EF4444] rounded p-2 text-[#EF4444] text-[10.5px] mb-2">
            Diff Error: {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            {/* Summary Metrics Bar */}
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-[#161C28] border border-[#222D3D] rounded p-2 flex flex-col">
                <span className="text-[#64748B] text-[9.5px]">RECORDS (A / B)</span>
                <span className="text-[13px] font-bold text-[#E2E8F0]">
                  {result.records_a} / {result.records_b}
                </span>
              </div>
              <div className="bg-[#161C28] border border-[#222D3D] rounded p-2 flex flex-col">
                <span className="text-[#64748B] text-[9.5px]">FRAMES (A / B)</span>
                <span className="text-[13px] font-bold text-[#E2E8F0]">
                  {result.frames_a} / {result.frames_b}
                </span>
              </div>
              <div className="bg-[#161C28] border border-[#222D3D] rounded p-2 flex flex-col">
                <span className="text-[#64748B] text-[9.5px]">MISSING FRAMES</span>
                <span className="text-[13px] font-bold text-[#F59E0B]">
                  {result.missing_from_b} dropped
                </span>
              </div>
              <div className="bg-[#161C28] border border-[#222D3D] rounded p-2 flex flex-col">
                <span className="text-[#64748B] text-[9.5px]">FIRST DIVERGENCE</span>
                <span className="text-[13px] font-bold text-[#EF4444]">
                  {result.first_divergence ? `Record #${result.first_divergence.record}` : 'None'}
                </span>
              </div>
            </div>

            {/* First Divergence Banner */}
            {result.first_divergence && (
              <div className="bg-[#EF4444]/10 border border-[#EF4444]/60 rounded p-2 flex items-center justify-between text-[10.5px]">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-[#EF4444] shrink-0" />
                  <div>
                    <span className="font-bold text-[#EF4444]">
                      First divergence at record #{result.first_divergence.record}:
                    </span>{' '}
                    <span className="text-[#E2E8F0]">{result.first_divergence.reason}</span>
                    {result.first_divergence.field && (
                      <span className="ml-1 text-[#00E5FF]">[{result.first_divergence.field}]</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Changed Fields Table */}
            <div className="bg-[#161C28] border border-[#222D3D] rounded overflow-hidden">
              <div className="h-[22px] bg-[#121722] border-b border-[#222D3D] grid grid-cols-[140px_80px_1fr_1fr] px-2 text-[9.5px] text-[#64748B] uppercase tracking-wider items-center">
                <div>Field Name</div>
                <div>Count</div>
                <div>Sample Baseline (A)</div>
                <div>Sample Test (B)</div>
              </div>
              <div className="divide-y divide-[#222D3D]/50 text-[10.5px]">
                {result.changed_fields.length === 0 ? (
                  <div className="p-3 text-center text-[#64748B]">No field differences found.</div>
                ) : (
                  result.changed_fields.map((f) => (
                    <div
                      key={f.name}
                      className="grid grid-cols-[140px_80px_1fr_1fr] px-2 py-1 items-center hover:bg-[#1E2638]"
                    >
                      <div className="font-semibold text-[#00E5FF]">{f.name}</div>
                      <div className="text-[#F59E0B]">{f.occurrences}x</div>
                      <div className="text-[#94A3B8] truncate">{f.sample_a}</div>
                      <div className="text-[#FBBF24] font-medium truncate">{f.sample_b}</div>
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
