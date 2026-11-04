import React, { useState, useEffect } from 'react';
import {
  X,
  Download,
  FileSpreadsheet,
  FileText,
  Network,
  Binary,
  Database,
  CheckCircle2,
  HardDrive,
  Radio,
  AlertCircle
} from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { engineApi, exportPacketsClientSide } from '../services/engineApi';

type ExportFormat = 'pcapng' | 'csv' | 'saleae' | 'jsonl' | 'parquet';

interface FormatOption {
  id: ExportFormat;
  name: string;
  ext: string;
  badge: string;
  badgeColor: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

const FORMAT_OPTIONS: FormatOption[] = [
  {
    id: 'pcapng',
    name: 'Wireshark PCAP-NG',
    ext: '.pcapng',
    badge: 'LINKTYPE 147 (USER0)',
    badgeColor: 'border-[#00E5FF]/40 text-[#00E5FF] bg-[#00E5FF]/10',
    description: 'Microsecond timestamps, UART port ID, and direction headers. Opens natively in Wireshark.',
    icon: Network,
  },
  {
    id: 'saleae',
    name: 'Saleae Logic CSV',
    ext: '.saleae.csv',
    badge: 'LOGIC 2 ASYNC',
    badgeColor: 'border-[#10B981]/40 text-[#10B981] bg-[#10B981]/10',
    description: 'Time [s], value, parity, error. Drop directly into Saleae Logic 2 for timing alignment.',
    icon: Binary,
  },
  {
    id: 'csv',
    name: 'Standard CSV Table',
    ext: '.csv',
    badge: 'PANDAS / EXCEL',
    badgeColor: 'border-[#3B82F6]/40 text-[#3B82F6] bg-[#3B82F6]/10',
    description: 'seq, timestamp_ns, seconds, port, direction, line_state, length, hex, text.',
    icon: FileSpreadsheet,
  },
  {
    id: 'jsonl',
    name: 'JSON Lines (NDJSON)',
    ext: '.jsonl',
    badge: 'STREAMING JSON',
    badgeColor: 'border-[#A855F7]/40 text-[#A855F7] bg-[#A855F7]/10',
    description: 'One JSON record per line. Escaped printable characters for automated pipelines.',
    icon: FileText,
  },
  {
    id: 'parquet',
    name: 'Apache Parquet',
    ext: '.parquet',
    badge: 'REFUSED BY SPEC',
    badgeColor: 'border-[#EF4444]/40 text-[#EF4444] bg-[#EF4444]/10',
    description: 'Refused by name per spec 0044. Use CSV or JSON Lines for equivalent columnar data.',
    icon: Database,
    disabled: true,
  },
];

export const VaultExportModal: React.FC = () => {
  const { isExportModalOpen, setExportModalOpen, packets, vaultPath } = useWorkstationStore();
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('pcapng');
  const [sourceMode, setSourceMode] = useState<'vault' | 'memory'>('vault');
  const [customVaultPath, setCustomVaultPath] = useState(vaultPath || 'vaults/session_001.bflog');
  const [vaultInfo, setVaultInfo] = useState<{
    path: string;
    records: number;
    bytes: number;
    damaged_tail: number;
    duration_ms: number;
  } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isExportModalOpen && sourceMode === 'vault') {
      engineApi.getVaultInfo(customVaultPath).then((info) => {
        setVaultInfo(info);
      });
    }
  }, [isExportModalOpen, sourceMode, customVaultPath]);

  if (!isExportModalOpen) return null;

  const handleExport = async () => {
    if (selectedFormat === 'parquet') return;
    setIsExporting(true);
    setStatusMessage(null);

    try {
      if (sourceMode === 'vault') {
        const downloadUrl = engineApi.getVaultExportUrl(selectedFormat, customVaultPath);
        // In browser or webview: initiate anchor download
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `bforge-vault.${selectedFormat === 'saleae' ? 'saleae.csv' : selectedFormat}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setStatusMessage(`Download initiated via engine endpoint /api/vault/export?format=${selectedFormat}`);
      } else {
        // Export live in-memory packets
        exportPacketsClientSide(packets, selectedFormat);
        setStatusMessage(`Exported ${packets.length.toLocaleString()} in-memory frames to ${selectedFormat.toUpperCase()}`);
      }
    } catch (err: any) {
      setStatusMessage(`Export failed: ${err?.message || err}`);
    } finally {
      setIsExporting(false);
    }
  };

  const selectedOpt = FORMAT_OPTIONS.find((f) => f.id === selectedFormat)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-[2px] p-4">
      <div className="bg-[#0E131F] border border-[#222D3D] rounded-lg shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col font-sans text-[#E2E8F0] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#161C28] border-b border-[#222D3D]">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-[#00E5FF]" />
            <h2 className="text-[12px] font-bold tracking-wider uppercase font-mono text-[#F8FAFC]">
              Session Vault Export
            </h2>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#222D3D] text-[#00E5FF] border border-[#00E5FF]/30">
              CAPTURE EXPORT
            </span>
          </div>
          <button
            onClick={() => setExportModalOpen(false)}
            className="p-1 rounded text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#222D3D] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 space-y-4 text-[11px]">
          {/* Source Selector */}
          <div>
            <label className="block text-[10px] font-mono uppercase text-[#94A3B8] mb-1.5">
              1. Select Export Source
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSourceMode('vault')}
                className={`flex items-start gap-2.5 p-2.5 rounded border text-left transition-all ${
                  sourceMode === 'vault'
                    ? 'border-[#00E5FF] bg-[#00E5FF]/5 text-white'
                    : 'border-[#222D3D] bg-[#161C28]/60 text-[#94A3B8] hover:border-[#334155]'
                }`}
              >
                <HardDrive className={`w-4 h-4 mt-0.5 ${sourceMode === 'vault' ? 'text-[#00E5FF]' : 'text-[#64748B]'}`} />
                <div>
                  <div className="font-semibold font-mono text-[11px] text-[#F8FAFC]">
                    Disk Vault (.bflog)
                  </div>
                  <div className="text-[10px] text-[#94A3B8] mt-0.5">
                    Engine forward-pass streaming from append-only binary log.
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSourceMode('memory')}
                className={`flex items-start gap-2.5 p-2.5 rounded border text-left transition-all ${
                  sourceMode === 'memory'
                    ? 'border-[#00E5FF] bg-[#00E5FF]/5 text-white'
                    : 'border-[#222D3D] bg-[#161C28]/60 text-[#94A3B8] hover:border-[#334155]'
                }`}
              >
                <Radio className={`w-4 h-4 mt-0.5 ${sourceMode === 'memory' ? 'text-[#00E5FF]' : 'text-[#64748B]'}`} />
                <div>
                  <div className="font-semibold font-mono text-[11px] text-[#F8FAFC]">
                    Live Stream Buffer
                  </div>
                  <div className="text-[10px] text-[#94A3B8] mt-0.5">
                    Active viewport capture ({packets.length.toLocaleString()} frames in memory).
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Vault Path Details (when source is vault) */}
          {sourceMode === 'vault' && (
            <div className="bg-[#161C28] border border-[#222D3D] rounded p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-[#94A3B8]">Vault Path:</span>
                <input
                  type="text"
                  value={customVaultPath}
                  onChange={(e) => setCustomVaultPath(e.target.value)}
                  className="w-2/3 px-2 py-0.5 bg-[#0E131F] border border-[#222D3D] rounded text-[10px] font-mono text-[#E2E8F0] focus:border-[#00E5FF] focus:outline-none"
                  placeholder="vaults/session_001.bflog"
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-[#64748B] pt-1 border-t border-[#222D3D]">
                <span>Status: {vaultInfo ? `${vaultInfo.records.toLocaleString()} records (${(vaultInfo.bytes / 1024).toFixed(1)} KB)` : 'Ready'}</span>
                <span>Duration: {vaultInfo ? `${(vaultInfo.duration_ms / 1000).toFixed(2)}s` : 'Sequential scan'}</span>
              </div>
            </div>
          )}

          {/* Target Format Grid */}
          <div>
            <label className="block text-[10px] font-mono uppercase text-[#94A3B8] mb-1.5">
              2. Select Target Export Format
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {FORMAT_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const isSelected = selectedFormat === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => setSelectedFormat(opt.id)}
                    className={`flex items-start gap-2.5 p-2.5 rounded border text-left transition-all ${
                      opt.disabled
                        ? 'opacity-40 cursor-not-allowed border-[#222D3D] bg-[#161C28]/30'
                        : isSelected
                        ? 'border-[#00E5FF] bg-[#00E5FF]/10 text-white shadow-[0_0_10px_rgba(0,229,255,0.15)]'
                        : 'border-[#222D3D] bg-[#161C28]/60 text-[#94A3B8] hover:border-[#334155] hover:text-[#E2E8F0]'
                    }`}
                  >
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${isSelected ? 'text-[#00E5FF]' : 'text-[#64748B]'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold font-mono text-[11px] text-[#F8FAFC]">
                          {opt.name}
                        </span>
                        <span className={`text-[9px] font-mono px-1 py-0.2 rounded border ${opt.badgeColor}`}>
                          {opt.badge}
                        </span>
                      </div>
                      <p className="text-[10px] text-[#94A3B8] mt-1 leading-tight line-clamp-2">
                        {opt.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Feedback status */}
          {statusMessage && (
            <div className="flex items-center gap-2 p-2 rounded bg-[#161C28] border border-[#222D3D] text-[10px] font-mono text-[#00E5FF]">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-[#10B981]" />
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#161C28] border-t border-[#222D3D]">
          <div className="text-[10px] font-mono text-[#64748B] flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3 text-[#00E5FF]" />
            <span>Output format: <span className="text-[#E2E8F0] font-bold">{selectedOpt.ext}</span></span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExportModalOpen(false)}
              className="px-3 py-1 bg-[#222D3D] hover:bg-[#334155] text-[#E2E8F0] rounded text-[11px] font-mono transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              disabled={isExporting || selectedFormat === 'parquet'}
              onClick={handleExport}
              className="flex items-center gap-1.5 px-3.5 py-1 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded text-[11px] font-mono transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_12px_rgba(0,229,255,0.3)]"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExporting ? 'EXPORTING...' : `EXPORT ${selectedFormat.toUpperCase()}`}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
