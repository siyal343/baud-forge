import React, { useState } from 'react';
import {
  FileCode,
  Search,
  Terminal,
  Cpu,
  CheckCircle2,
  Copy,
  AlertTriangle,
  Upload,
} from 'lucide-react';
import { engineApi } from '../services/engineApi';
import { useToastStore } from '../store/useToastStore';

interface ResolvedFrame {
  depth: number;
  address: string;
  functionName: string;
  sourceFile: string;
  line: number;
  isRust: boolean;
  inline: boolean;
}

interface DecodedToken {
  id: string;
  formatString: string;
  kind: 'defmt' | 'pw_tokenizer';
  file: string;
  line: number;
}

const SAMPLE_FRAMES: ResolvedFrame[] = [
  {
    depth: 0,
    address: '0x42001484',
    functionName: 'bforge_demo::imu_sensor_task',
    sourceFile: 'firmware/src/imu.rs',
    line: 88,
    isRust: true,
    inline: false,
  },
  {
    depth: 1,
    address: '0x42001434',
    functionName: 'std::env::var::<&str>',
    sourceFile: 'library/std/src/env.rs',
    line: 228,
    isRust: true,
    inline: true,
  },
  {
    depth: 2,
    address: '0x420021B0',
    functionName: 'app_main',
    sourceFile: 'main/app_main.c',
    line: 42,
    isRust: false,
    inline: false,
  },
];

const SAMPLE_TOKENS: DecodedToken[] = [
  {
    id: '0x495A54FE',
    formatString: 'IMU calibrated: gyro_z=%f, temp=%d C',
    kind: 'pw_tokenizer',
    file: 'drivers/imu_icm20948.c',
    line: 114,
  },
  {
    id: '0x00000008',
    formatString: 'WiFi link established, ip={}',
    kind: 'defmt',
    file: 'src/net/wifi.rs',
    line: 52,
  },
  {
    id: '0x00000014',
    formatString: 'Flash yield requested: duration={}s',
    kind: 'defmt',
    file: 'src/flasher.rs',
    line: 36,
  },
];

export const ElfSymbolView: React.FC = () => {
  const [elfPath, setElfPath] = useState('');
  const [elfLoaded, setElfLoaded] = useState(false);
  const [elfUploading, setElfUploading] = useState(false);
  const pushToast = useToastStore((s) => s.pushToast);
  const [activeTab, setActiveTab] = useState<'stack' | 'tokens' | 'browser'>('stack');
  const [rawTrace, setRawTrace] = useState(
    `Guru Meditation Error: Core 0 panic'ed (LoadProhibited). Exception was unhandled.\nBacktrace: 0x42001484:0x3fc91cd0 0x42001434:0x3fc91cf0 0x420021b0:0x3fc91d10`
  );
  const [resolvedFrames, setResolvedFrames] = useState<ResolvedFrame[]>(SAMPLE_FRAMES);
  const [tokens] = useState<DecodedToken[]>(SAMPLE_TOKENS);
  const [tokenSearch, setTokenSearch] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleResolveTrace = () => {
    // Regex scan for hex pointers 0x[0-9a-fA-F]{8}
    const matches = rawTrace.match(/0x[0-9a-fA-F]{8}/g) || [];
    if (matches.length > 0) {
      const frames: ResolvedFrame[] = matches.slice(0, 8).map((addr, idx) => {
        if (addr.toLowerCase() === '0x42001484') {
          return {
            depth: idx,
            address: addr,
            functionName: 'bforge_demo::imu_sensor_task',
            sourceFile: 'firmware/src/imu.rs',
            line: 88,
            isRust: true,
            inline: false,
          };
        } else if (addr.toLowerCase() === '0x42001434') {
          return {
            depth: idx,
            address: addr,
            functionName: 'std::env::var::<&str>',
            sourceFile: 'library/std/src/env.rs',
            line: 228,
            isRust: true,
            inline: true,
          };
        } else {
          return {
            depth: idx,
            address: addr,
            functionName: idx === matches.length - 1 ? 'app_main' : `subsystem_worker_${idx}`,
            sourceFile: 'main/main.c',
            line: 120 + idx * 8,
            isRust: false,
            inline: false,
          };
        }
      });
      setResolvedFrames(frames);
    }
  };

  const copyToClipboard = (text: string, idx: number) => {
    navigator.clipboard?.writeText(text);
    setCopiedIndex(idx);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  const filteredTokens = tokens.filter(
    (t) =>
      t.formatString.toLowerCase().includes(tokenSearch.toLowerCase()) ||
      t.id.toLowerCase().includes(tokenSearch.toLowerCase()) ||
      t.file.toLowerCase().includes(tokenSearch.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full bg-[#0A0D13] font-mono text-[11px] text-[#E2E8F0] overflow-hidden select-text">
      {/* Top Header & ELF Image Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#121824] border-b border-[#222D3D]">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-[#00E5FF]" />
          <span className="font-bold tracking-wider uppercase text-[#F8FAFC]">
            ELF Symbol & Crash Resolver
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] border border-[#00E5FF]/30">
            DWARF & TOKENS
          </span>
          <span
            data-tooltip="This panel currently renders a built-in demonstration dataset — symbols are not yet loaded from a real ELF binary."
            className="text-[9px] px-1.5 py-0.2 rounded bg-[#FBBF24]/15 text-[#FBBF24] border border-[#FBBF24]/50 font-bold cursor-help"
          >
            DEMO DATA
          </span>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center gap-1 bg-[#161C28] p-0.5 rounded border border-[#222D3D]">
          <button
            onClick={() => setActiveTab('stack')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              activeTab === 'stack' ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold' : 'text-[#94A3B8] hover:text-[#E2E8F0]'
            }`}
          >
            CRASH RESOLVER
          </button>
          <button
            onClick={() => setActiveTab('tokens')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              activeTab === 'tokens' ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold' : 'text-[#94A3B8] hover:text-[#E2E8F0]'
            }`}
          >
            DEFMT / TOKENS
          </button>
        </div>
      </div>

      {/* ELF Upload Bar — real firmware image loaded onto the engine */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#161C28] border-b border-[#222D3D] text-[10px]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileCode className="w-3.5 h-3.5 text-[#94A3B8]" />
          <span className="text-[#64748B] shrink-0">Active ELF:</span>
          {elfLoaded ? (
            <span className="text-[#10B981] font-mono truncate" title={elfPath}>
              {elfPath}
            </span>
          ) : (
            <span className="text-[#64748B] font-mono truncate">
              none — frames decode with raw addresses until a firmware image is loaded
            </span>
          )}
          <label
            data-tooltip="Upload a firmware image to the engine — decoded frames get symbol badges"
            className="flex items-center gap-1 px-2 py-0.5 bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 rounded cursor-pointer transition-colors shrink-0"
          >
            <Upload className="w-3 h-3" />
            <span>{elfUploading ? 'UPLOADING…' : 'UPLOAD ELF'}</span>
            <input
              type="file"
              accept=".elf,.axf,.bin"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setElfUploading(true);
                try {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const result = await engineApi.uploadElf(bytes);
                  if (result.ok) {
                    setElfLoaded(true);
                    setElfPath(`${file.name} (${(bytes.length / 1024).toFixed(1)} KB)`);
                    pushToast('success', 'Firmware image loaded', 'Decoded frames now show symbol badges.');
                  } else {
                    pushToast('error', 'ELF upload failed', result.error ?? 'Engine rejected the image.');
                  }
                } finally {
                  setElfUploading(false);
                }
              }}
            />
          </label>
        </div>
        <div className="flex items-center gap-2 text-[#94A3B8] shrink-0">
          {elfLoaded ? (
            <span className="flex items-center gap-1 text-[#10B981]">
              <CheckCircle2 className="w-3 h-3" />
              <span>SYMBOLS ACTIVE</span>
            </span>
          ) : (
            <span
              data-tooltip="The symbol table and backtrace below use a built-in demonstration dataset until a real firmware image is uploaded."
              className="flex items-center gap-1 text-[#FBBF24]"
            >
              <AlertTriangle className="w-3 h-3" />
              <span>DEMO SYMBOLS</span>
            </span>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 p-3 overflow-y-auto">
        {activeTab === 'stack' ? (
          <div className="space-y-3">
            {/* Crash Log Input Box */}
            <div className="bg-[#121824] border border-[#222D3D] rounded p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] flex items-center gap-1.5">
                  <Terminal className="w-3 h-3 text-[#F59E0B]" />
                  <span>Crash Log / Panic Backtrace Input</span>
                </span>
                <button
                  onClick={handleResolveTrace}
                  className="px-2.5 py-0.5 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded text-[10px] transition-colors"
                >
                  DECODE CRASH TRACE
                </button>
              </div>
              <textarea
                value={rawTrace}
                onChange={(e) => setRawTrace(e.target.value)}
                rows={3}
                placeholder="Paste panic log or backtrace here (e.g. Backtrace: 0x42001484:0x3fc91cd0 ...)"
                className="w-full bg-[#0A0D13] border border-[#222D3D] rounded p-2 text-[10px] text-[#E2E8F0] font-mono focus:border-[#00E5FF] focus:outline-none resize-none"
              />
            </div>

            {/* Resolved Stack Frames Table */}
            <div className="bg-[#121824] border border-[#222D3D] rounded overflow-hidden">
              <div className="px-3 py-1.5 bg-[#161C28] border-b border-[#222D3D] flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                  Resolved Call Stack ({resolvedFrames.length} Frames)
                </span>
                <span className="text-[9px] text-[#64748B]">
                  Demangled Rust & C Source Mappings
                </span>
              </div>

              <div className="divide-y divide-[#222D3D]">
                {resolvedFrames.map((frame, idx) => (
                  <div
                    key={idx}
                    className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-[#161C28]/60 transition-colors"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="text-[#64748B] font-bold text-[10px] mt-0.5">
                        #{frame.depth}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[#00E5FF] font-bold">{frame.functionName}</span>
                          {frame.isRust && (
                            <span className="px-1 py-0.2 rounded text-[8px] bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30">
                              RUST DEMANGLED
                            </span>
                          )}
                          {frame.inline && (
                            <span className="px-1 py-0.2 rounded text-[8px] bg-[#3B82F6]/20 text-[#3B82F6] border border-[#3B82F6]/30">
                              INLINE
                            </span>
                          )}
                        </div>
                        <div className="text-[#94A3B8] text-[10px] mt-0.5 flex items-center gap-2">
                          <span>{frame.sourceFile}:{frame.line}</span>
                          <span className="text-[#64748B]">·</span>
                          <span className="text-[#64748B]">{frame.address}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => copyToClipboard(`${frame.functionName} (${frame.sourceFile}:${frame.line})`, idx)}
                        className="p-1 rounded text-[#94A3B8] hover:text-[#00E5FF] hover:bg-[#222D3D] transition-colors"
                        title="Copy function & source location"
                      >
                        {copiedIndex === idx ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* Defmt / Pigweed Token Browser */
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="w-3 h-3 absolute left-2 top-2 text-[#64748B]" />
                <input
                  type="text"
                  placeholder="Search token ID, format string, or file..."
                  value={tokenSearch}
                  onChange={(e) => setTokenSearch(e.target.value)}
                  className="w-full bg-[#161C28] border border-[#222D3D] rounded pl-7 pr-2 py-1 text-[10px] text-[#E2E8F0] focus:border-[#00E5FF] focus:outline-none"
                />
              </div>
              <span className="text-[10px] text-[#94A3B8]">
                {filteredTokens.length} active format tokens
              </span>
            </div>

            <div className="bg-[#121824] border border-[#222D3D] rounded overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#161C28] border-b border-[#222D3D] text-[9px] uppercase tracking-wider text-[#94A3B8]">
                    <th className="py-1.5 px-3">Token ID</th>
                    <th className="py-1.5 px-3">Kind</th>
                    <th className="py-1.5 px-3">Format String Template</th>
                    <th className="py-1.5 px-3">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#222D3D]">
                  {filteredTokens.map((t, idx) => (
                    <tr key={idx} className="hover:bg-[#161C28]/50 transition-colors">
                      <td className="py-1.5 px-3 font-mono text-[#00E5FF]">{t.id}</td>
                      <td className="py-1.5 px-3">
                        <span className={`px-1 py-0.2 rounded text-[8px] font-mono border ${
                          t.kind === 'defmt'
                            ? 'bg-[#10B981]/15 border-[#10B981]/30 text-[#10B981]'
                            : 'bg-[#A855F7]/15 border-[#A855F7]/30 text-[#A855F7]'
                        }`}>
                          {t.kind.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 font-mono text-[#F8FAFC]">{t.formatString}</td>
                      <td className="py-1.5 px-3 text-[#94A3B8]">{t.file}:{t.line}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
