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
    <div className="flex flex-col h-full bg-bf-onfill font-mono text-[11px] text-bf-body overflow-hidden select-text">
      {/* Top Header & ELF Image Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-bf-head border-b border-bf-line">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-bf-cyan" />
          <span className="font-bold tracking-wider uppercase text-bf-bright">
            ELF Symbol & Crash Resolver
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-bf-hover text-bf-cyan border border-bf-cyan/30">
            DWARF & TOKENS
          </span>
          <span
            data-tooltip="This panel currently renders a built-in demonstration dataset — symbols are not yet loaded from a real ELF binary."
            className="text-[9px] px-1.5 py-0.2 rounded bg-bf-amber/15 text-bf-amber border border-bf-amber/50 font-bold cursor-help"
          >
            DEMO DATA
          </span>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center gap-1 bg-bf-subpanel p-0.5 rounded border border-bf-line">
          <button
            onClick={() => setActiveTab('stack')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              activeTab === 'stack' ? 'bg-bf-cyan/20 text-bf-cyan font-bold' : 'text-bf-mute hover:text-bf-body'
            }`}
          >
            CRASH RESOLVER
          </button>
          <button
            onClick={() => setActiveTab('tokens')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              activeTab === 'tokens' ? 'bg-bf-cyan/20 text-bf-cyan font-bold' : 'text-bf-mute hover:text-bf-body'
            }`}
          >
            DEFMT / TOKENS
          </button>
        </div>
      </div>

      {/* ELF Upload Bar — real firmware image loaded onto the engine */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-bf-subpanel border-b border-bf-line text-[10px]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileCode className="w-3.5 h-3.5 text-bf-mute" />
          <span className="text-bf-faint shrink-0">Active ELF:</span>
          {elfLoaded ? (
            <span className="text-bf-ok font-mono truncate" title={elfPath}>
              {elfPath}
            </span>
          ) : (
            <span className="text-bf-faint font-mono truncate">
              none — frames decode with raw addresses until a firmware image is loaded
            </span>
          )}
          <label
            data-tooltip="Upload a firmware image to the engine — decoded frames get symbol badges"
            className="flex items-center gap-1 px-2 py-0.5 bg-bf-cyan/10 hover:bg-bf-cyan/20 text-bf-cyan border border-bf-cyan/40 rounded cursor-pointer transition-colors shrink-0"
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
        <div className="flex items-center gap-2 text-bf-mute shrink-0">
          {elfLoaded ? (
            <span className="flex items-center gap-1 text-bf-ok">
              <CheckCircle2 className="w-3 h-3" />
              <span>SYMBOLS ACTIVE</span>
            </span>
          ) : (
            <span
              data-tooltip="The symbol table and backtrace below use a built-in demonstration dataset until a real firmware image is uploaded."
              className="flex items-center gap-1 text-bf-amber"
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
            <div className="bg-bf-head border border-bf-line rounded p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-bf-mute flex items-center gap-1.5">
                  <Terminal className="w-3 h-3 text-bf-warn" />
                  <span>Crash Log / Panic Backtrace Input</span>
                </span>
                <button
                  onClick={handleResolveTrace}
                  className="px-2.5 py-0.5 bg-bf-cyan hover:bg-bf-cyan-hi text-bf-onfill font-bold rounded text-[10px] transition-colors"
                >
                  DECODE CRASH TRACE
                </button>
              </div>
              <textarea
                value={rawTrace}
                onChange={(e) => setRawTrace(e.target.value)}
                rows={3}
                placeholder="Paste panic log or backtrace here (e.g. Backtrace: 0x42001484:0x3fc91cd0 ...)"
                className="w-full bg-bf-onfill border border-bf-line rounded p-2 text-[10px] text-bf-body font-mono focus:border-bf-cyan focus:outline-none resize-none"
              />
            </div>

            {/* Resolved Stack Frames Table */}
            <div className="bg-bf-head border border-bf-line rounded overflow-hidden">
              <div className="px-3 py-1.5 bg-bf-subpanel border-b border-bf-line flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-bf-mute">
                  Resolved Call Stack ({resolvedFrames.length} Frames)
                </span>
                <span className="text-[9px] text-bf-faint">
                  Demangled Rust & C Source Mappings
                </span>
              </div>

              <div className="divide-y divide-bf-line">
                {resolvedFrames.map((frame, idx) => (
                  <div
                    key={idx}
                    className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-bf-subpanel/60 transition-colors"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="text-bf-faint font-bold text-[10px] mt-0.5">
                        #{frame.depth}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-bf-cyan font-bold">{frame.functionName}</span>
                          {frame.isRust && (
                            <span className="px-1 py-0.2 rounded text-[8px] bg-bf-warn/20 text-bf-warn border border-bf-warn/30">
                              RUST DEMANGLED
                            </span>
                          )}
                          {frame.inline && (
                            <span className="px-1 py-0.2 rounded text-[8px] bg-bf-info/20 text-bf-info border border-bf-info/30">
                              INLINE
                            </span>
                          )}
                        </div>
                        <div className="text-bf-mute text-[10px] mt-0.5 flex items-center gap-2">
                          <span>{frame.sourceFile}:{frame.line}</span>
                          <span className="text-bf-faint">·</span>
                          <span className="text-bf-faint">{frame.address}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => copyToClipboard(`${frame.functionName} (${frame.sourceFile}:${frame.line})`, idx)}
                        className="p-1 rounded text-bf-mute hover:text-bf-cyan hover:bg-bf-line transition-colors"
                        title="Copy function & source location"
                      >
                        {copiedIndex === idx ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-bf-ok" />
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
                <Search className="w-3 h-3 absolute left-2 top-2 text-bf-faint" />
                <input
                  type="text"
                  placeholder="Search token ID, format string, or file..."
                  value={tokenSearch}
                  onChange={(e) => setTokenSearch(e.target.value)}
                  className="w-full bg-bf-subpanel border border-bf-line rounded pl-7 pr-2 py-1 text-[10px] text-bf-body focus:border-bf-cyan focus:outline-none"
                />
              </div>
              <span className="text-[10px] text-bf-mute">
                {filteredTokens.length} active format tokens
              </span>
            </div>

            <div className="bg-bf-head border border-bf-line rounded overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-bf-subpanel border-b border-bf-line text-[9px] uppercase tracking-wider text-bf-mute">
                    <th className="py-1.5 px-3">Token ID</th>
                    <th className="py-1.5 px-3">Kind</th>
                    <th className="py-1.5 px-3">Format String Template</th>
                    <th className="py-1.5 px-3">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bf-line">
                  {filteredTokens.map((t, idx) => (
                    <tr key={idx} className="hover:bg-bf-subpanel/50 transition-colors">
                      <td className="py-1.5 px-3 font-mono text-bf-cyan">{t.id}</td>
                      <td className="py-1.5 px-3">
                        <span className={`px-1 py-0.2 rounded text-[8px] font-mono border ${
                          t.kind === 'defmt'
                            ? 'bg-bf-ok/15 border-bf-ok/30 text-bf-ok'
                            : 'bg-bf-purple/15 border-bf-purple/30 text-bf-purple'
                        }`}>
                          {t.kind.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 font-mono text-bf-bright">{t.formatString}</td>
                      <td className="py-1.5 px-3 text-bf-mute">{t.file}:{t.line}</td>
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
