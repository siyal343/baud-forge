// Desktop launcher (spec 0036): the first screen inside the Tauri shell.
// Shown only when running inside Tauri with no engine session yet — the
// workbench replaces this view once a workspace starts (the shell navigates
// to the engine's own address, where the same UI runs same-origin).
//
// Two columns, one screen — the window itself never scrolls:
//   LEFT  — CONFIGURE SESSION: every session parameter as a form, no TOML.
//   RIGHT — QUICK OPEN: recent workspaces and saved profiles for one-click
//           starts, quick connect, the demo and capture review.
// Configured sessions are stored as profiles (<name>.bforge.toml) so the next
// session of the same kind is one click. Recents can be pruned (× per entry)
// or wiped (CLEAR ALL) without touching the workspace files themselves.
import React, { useEffect, useState } from 'react';
import { logAction } from '../services/activityLog';

type TauriCore = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

const tauri = (): TauriCore | null => {
  const w = window as unknown as { __TAURI__?: { core?: TauriCore } };
  return w.__TAURI__?.core ?? null;
};

export const isDesktopShell = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;

export const hasEngineParam = (): boolean =>
  new URLSearchParams(window.location.search).has('api');

interface SerialPort {
  device_path: string;
  vid_pid?: string | null;
  serial?: string | null;
}

interface Profile {
  name: string;
  path: string;
}

const BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
const FRAMING_MODES = ['delimiter', 'cobs', 'slip', 'intel_hex', 'header_length', 'idle_gap'];
const LENGTH_WIDTHS = ['u8', 'u16_le', 'u16_be', 'u32_le'];
const CHECKSUMS = ['none', 'crc8', 'crc16_ccitt_false', 'crc32c'];

/** Build the workspace TOML from the form — the launcher writes the file the
 * engineer would have hand-written. */
function buildConfigToml(f: ConfigState, portPath: string, headerPath: string | null): string {
  const framing: string[] = [`mode = "${f.framingMode}"`];
  if (f.framingMode === 'delimiter' && f.delimiter.trim()) framing.push(`delimiter = ${parseInt(f.delimiter.trim(), 16)}`);
  if (f.framingMode === 'header_length' && f.sync.trim()) framing.push(`sync = "${f.sync.trim()}"`);
  if (f.framingMode === 'header_length') {
    framing.push(`length_offset = ${f.lengthOffset || 0}`);
    framing.push(`length_width = "${f.lengthWidth}"`);
    if (f.lengthAdjust) framing.push(`length_adjust = ${f.lengthAdjust}`);
  }
  if (f.framingMode === 'idle_gap' && f.idleGapUs) framing.push(`idle_gap_us = ${f.idleGapUs}`);
  if (f.checksum !== 'none') framing.push(`crc = "${f.checksum}"`);

  const lines: string[] = [];
  lines.push(`[workspace]`);
  lines.push(`name = "${(f.name || f.portPath || 'session').replace(/"/g, '')}"`);
  lines.push(`version = "0.1"`);
  lines.push(``);
  lines.push(`[[ports]]`);
  lines.push(`id = "${(f.portId || 'dev').replace(/"/g, '')}"`);
  lines.push(`device_path = "${portPath}"`);
  lines.push(`baud_rate = ${f.baud}`);
  lines.push(`framing = { ${framing.join(', ')} }`);
  if (headerPath) {
    lines.push(`dissector = { type = "c_header", file = "${headerPath.replace(/\\/g, '/')}"${f.rootStruct.trim() ? `, root_struct = "${f.rootStruct.trim()}"` : ''} }`);
  }
  return lines.join('\n') + '\n';
}

interface ConfigState {
  name: string;
  portId: string;
  portPath: string;
  baud: number;
  dataBits: number;
  parity: string;
  stopBits: number;
  framingMode: string;
  delimiter: string;
  sync: string;
  lengthOffset: number;
  lengthWidth: string;
  lengthAdjust: number;
  idleGapUs: number;
  checksum: string;
  rootStruct: string;
}

const DEFAULT_CONFIG: ConfigState = {
  name: '',
  portId: 'dev',
  portPath: '',
  baud: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  framingMode: 'delimiter',
  delimiter: '0A',
  sync: '',
  lengthOffset: 0,
  lengthWidth: 'u8',
  lengthAdjust: 0,
  idleGapUs: 3000,
  checksum: 'none',
  rootStruct: '',
};

const inputCls =
  'w-full bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1.5 text-[11px] text-[#E2E8F0] font-mono focus:outline-none focus:border-[#00E5FF]';
const labelCls = 'text-[9.5px] text-[#64748B] block mb-1 font-bold uppercase tracking-wider';
const chipCls = (active: boolean) =>
  `px-1.5 py-0.5 rounded border text-[9.5px] font-mono transition-colors ${
    active
      ? 'bg-[#00E5FF]/15 text-[#00E5FF] border-[#00E5FF]/50'
      : 'bg-[#10141D] text-[#94A3B8] border-[#222D3D] hover:text-[#E2E8F0]'
  }`;
const navButton =
  'w-full px-3 py-2 rounded text-left font-mono text-[11px] transition-colors bg-[#121722] border border-[#222D3D] text-[#E2E8F0] hover:border-[#00E5FF]/60 hover:text-[#00E5FF] disabled:opacity-40 disabled:hover:border-[#222D3D]';
const killButton =
  'shrink-0 self-stretch px-2 rounded border border-[#222D3D] text-[#64748B] hover:text-[#EF4444] hover:border-[#EF4444]/50 text-[10px] font-mono transition-colors disabled:opacity-40';
const sectionCls = 'rounded-md bg-[#0C111B] border border-[#1E2836] p-3';
const sectionTitleCls = 'text-[9px] text-[#00E5FF]/70 uppercase tracking-wider font-bold';

/** A titled, bordered group inside a launcher column. */
const Card: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  right,
  children,
  className,
}) => (
  <div className={sectionCls + (className ? ` ${className}` : '')}>
    <div className="flex items-center justify-between mb-2 gap-2">
      <span className={sectionTitleCls}>{title}</span>
      {right}
    </div>
    {children}
  </div>
);

const errorBox = (message: string) => (
  <div className="mt-2 p-1.5 rounded bg-[#EF4444]/15 border border-[#EF4444]/30 text-[#EF4444] text-[10px] font-mono break-all">
    {message}
  </div>
);

const emptyHint = (text: string) => <p className="text-[9.5px] text-[#64748B] font-mono py-1">{text}</p>;

/* ------------------------------------------------------------------ */
/* LEFT COLUMN — configure a session from scratch                      */
/* ------------------------------------------------------------------ */

const ConfigureSession: React.FC<{ core: TauriCore; onSaved: () => void }> = ({ core, onSaved }) => {
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [f, setF] = useState<ConfigState>(DEFAULT_CONFIG);
  const [headerPath, setHeaderPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ConfigState>) => setF((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    core
      .invoke('list_serial_ports')
      .then((list) => {
        const items = (list as SerialPort[]) ?? [];
        setPorts(items);
        if (items.length > 0) set({ portPath: items[0].device_path });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const portPath = f.portPath || ports[0]?.device_path || '';

  const startOrSave = async (mode: 'start' | 'save') => {
    setBusy(mode);
    setError(null);
    try {
      const toml = buildConfigToml(f, portPath, headerPath);
      const profileName = (f.name || '').trim();
      if (mode === 'start') {
        const url = (await core.invoke('start_configured', {
          configText: toml,
          profileName: profileName || null,
        })) as string;
        logAction('session_configured', `${portPath} @ ${f.baud} ${f.framingMode}${headerPath ? ' + dissector' : ''}`);
        window.location.replace(`index.html?api=${url}&v=${Date.now()}`);
        return;
      }
      if (!profileName) {
        setError('Name the profile before saving (the NAME field).');
        return;
      }
      await core.invoke('save_profile', { name: profileName, content: toml });
      logAction('profile_saved', profileName);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pickHeader = async () => {
    const path = (await core.invoke('pick_header_file')) as string | null;
    if (path) {
      setHeaderPath(path);
      if (!f.rootStruct.trim()) set({ rootStruct: 'ImuPacket' });
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Card title="Session identity">
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <div>
            <label className={labelCls}>Profile name (saved for reuse)</label>
            <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="My board @ 115200" />
          </div>
          <div>
            <label className={labelCls}>Port id in the workbench</label>
            <input className={inputCls} value={f.portId} onChange={(e) => set({ portId: e.target.value })} placeholder="dev" />
          </div>
        </div>
      </Card>

      <Card title="Serial port">
        <label className={labelCls}>Detected ports</label>
        <select className={inputCls} value={f.portPath} onChange={(e) => set({ portPath: e.target.value })}>
          {ports.map((p) => (
            <option key={p.device_path} value={p.device_path}>
              {p.device_path} {p.vid_pid ? `(${p.vid_pid})` : ''}
            </option>
          ))}
          {f.portPath && !ports.some((p) => p.device_path === f.portPath) && (
            <option value={f.portPath}>{f.portPath} (manual)</option>
          )}
        </select>
        <label className={labelCls + ' mt-2'}>Device path — or type an address</label>
        <input
          className={inputCls}
          value={f.portPath}
          onChange={(e) => set({ portPath: e.target.value })}
          placeholder="COM8 — or type a device path / address"
        />
      </Card>

      <Card title="Line settings">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
          <div>
            <label className={labelCls}>Baud rate</label>
            <div className="flex gap-1.5">
              <select
                className={inputCls}
                value={BAUD_PRESETS.includes(f.baud) ? f.baud : 'custom'}
                onChange={(e) => set({ baud: e.target.value === 'custom' ? 115200 : Number(e.target.value) })}
              >
                {BAUD_PRESETS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
                <option value="custom">custom…</option>
              </select>
              {!BAUD_PRESETS.includes(f.baud) && (
                <input
                  className={inputCls + ' w-28 shrink-0'}
                  type="number"
                  value={f.baud}
                  onChange={(e) => set({ baud: Number(e.target.value) || 115200 })}
                />
              )}
            </div>
          </div>
          <div>
            <label className={labelCls}>Data</label>
            <select className={inputCls} value={f.dataBits} onChange={(e) => set({ dataBits: Number(e.target.value) })}>
              <option value={8}>8</option>
              <option value={7}>7</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Parity</label>
            <select className={inputCls} value={f.parity} onChange={(e) => set({ parity: e.target.value })}>
              <option value="none">none</option>
              <option value="even">even</option>
              <option value="odd">odd</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Stop</label>
            <select className={inputCls} value={f.stopBits} onChange={(e) => set({ stopBits: Number(e.target.value) })}>
              <option value={1}>1</option>
              <option value={1.5}>1.5</option>
              <option value={2}>2</option>
            </select>
          </div>
        </div>
      </Card>

      <Card title="Framing — how frames are sliced from the byte stream">
        <div className="flex flex-wrap gap-1">
          {FRAMING_MODES.map((m) => (
            <button key={m} onClick={() => set({ framingMode: m })} className={chipCls(f.framingMode === m)}>{m}</button>
          ))}
        </div>
        {f.framingMode === 'delimiter' && (
          <div className="mt-2">
            <label className={labelCls}>Delimiter byte (hex, e.g. 0A for \n)</label>
            <input className={inputCls} value={f.delimiter} onChange={(e) => set({ delimiter: e.target.value })} />
          </div>
        )}
        {f.framingMode === 'header_length' && (
          <div className="mt-2 grid grid-cols-[1fr_1fr_1fr] gap-2">
            <div>
              <label className={labelCls}>Sync word (hex)</label>
              <input className={inputCls} value={f.sync} onChange={(e) => set({ sync: e.target.value })} placeholder="AA 55" />
            </div>
            <div>
              <label className={labelCls}>Length offset</label>
              <input className={inputCls} type="number" value={f.lengthOffset} onChange={(e) => set({ lengthOffset: Number(e.target.value) || 0 })} />
            </div>
            <div>
              <label className={labelCls}>Width</label>
              <select className={inputCls} value={f.lengthWidth} onChange={(e) => set({ lengthWidth: e.target.value })}>
                {LENGTH_WIDTHS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          </div>
        )}
        {f.framingMode === 'idle_gap' && (
          <div className="mt-2">
            <label className={labelCls}>Idle gap (µs of silence that ends a frame)</label>
            <input className={inputCls} type="number" value={f.idleGapUs} onChange={(e) => set({ idleGapUs: Number(e.target.value) || 3000 })} />
          </div>
        )}
      </Card>

      <Card title="Checksum — validated on decode; none = raw">
        <div className="flex flex-wrap gap-1">
          {CHECKSUMS.map((c) => (
            <button key={c} onClick={() => set({ checksum: c })} className={chipCls(f.checksum === c)}>{c}</button>
          ))}
        </div>
      </Card>

      <Card title="Protocol dissector (optional)">
        <div className="flex gap-1.5">
          <button
            onClick={pickHeader}
            className="flex-1 px-2 py-1.5 rounded text-[10.5px] font-mono bg-[#10141D] border border-[#222D3D] hover:border-[#00E5FF]/50 text-[#94A3B8] hover:text-[#00E5FF] transition-colors"
          >
            {headerPath ? `📄 ${headerPath.split(/[\\/]/).pop()}` : 'Pick C header (.h)…'}
          </button>
          {headerPath && (
            <button onClick={() => setHeaderPath(null)} className={killButton}>×</button>
          )}
        </div>
        {headerPath && (
          <input
            className={inputCls + ' mt-2'}
            value={f.rootStruct}
            onChange={(e) => set({ rootStruct: e.target.value })}
            placeholder="Root struct name (e.g. ImuPacket) — optional for single-struct headers"
          />
        )}
      </Card>

      <div className="flex gap-1.5 pt-0.5">
        <button
          onClick={() => startOrSave('start')}
          disabled={busy !== null || !portPath}
          className="flex-1 px-2 py-2 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded text-[10.5px] disabled:opacity-40"
        >
          {busy === 'start' ? 'STARTING…' : 'START SESSION'}
        </button>
        <button
          onClick={() => startOrSave('save')}
          disabled={busy !== null || !portPath}
          className="px-3 py-2 bg-[#161C28] hover:bg-[#1E2638] border border-[#222D3D] hover:border-[#00E5FF]/50 text-[#94A3B8] hover:text-[#00E5FF] rounded text-[10.5px] font-mono disabled:opacity-40"
        >
          {busy === 'save' ? 'SAVING…' : 'SAVE PROFILE'}
        </button>
      </div>
      {error && errorBox(error)}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* RIGHT COLUMN — everything that opens a session in one click         */
/* ------------------------------------------------------------------ */

/** One removable row: a wide open button plus a × that only touches the list. */
const OpenRow: React.FC<{
  onOpen: () => void;
  onRemove?: () => void;
  disabled: boolean;
  title?: string;
  removeTitle?: string;
  children: React.ReactNode;
}> = ({ onOpen, onRemove, disabled, title, removeTitle, children }) => (
  <div className="flex items-stretch gap-1">
    <button onClick={onOpen} disabled={disabled} title={title} className={navButton + ' min-w-0'}>
      {children}
    </button>
    {onRemove && (
      <button onClick={onRemove} disabled={disabled} title={removeTitle} className={killButton}>
        ×
      </button>
    )}
  </div>
);

const RecentWorkspaces: React.FC<{
  core: TauriCore;
  recents: string[];
  setRecents: (list: string[]) => void;
  onOpen: (path: string) => void;
  busy: string | null;
}> = ({ core, recents, setRecents, onOpen, busy }) => {
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = window.setTimeout(() => setConfirmingClear(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmingClear]);

  const removeOne = async (path: string) => {
    try {
      setRecents((await core.invoke('remove_recent_workspace', { path })) as string[]);
      logAction('recent_removed', path);
    } catch {
      /* the list on disk wins the next reload; nothing to show */
    }
  };

  const clearAll = async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setConfirmingClear(false);
    try {
      setRecents((await core.invoke('clear_recent_workspaces')) as string[]);
      logAction('recent_cleared');
    } catch {
      /* as above */
    }
  };

  const clearLabel = confirmingClear ? 'SURE?' : 'CLEAR';

  return (
    <Card
      title="Recent workspaces"
      className="mt-3"
      right={
        recents.length > 0 ? (
          <button
            onClick={clearAll}
            title="Remove every entry from this list — the workspace files are kept"
            className="px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-wider transition-colors border-[#222D3D] text-[#64748B] hover:text-[#EF4444] hover:border-[#EF4444]/50"
          >
            {clearLabel}
          </button>
        ) : undefined
      }
    >
      {recents.length === 0 ? (
        emptyHint('No recent workspaces yet — open one above.')
      ) : (
        <div className="space-y-1.5">
          {recents.map((path) => (
            <OpenRow
              key={path}
              onOpen={() => onOpen(path)}
              onRemove={() => removeOne(path)}
              disabled={busy !== null}
              title={path}
              removeTitle="Remove from this list — the workspace file is kept"
            >
              <span className="block truncate">{path.split(/[\\/]/).pop()}</span>
              <span className="block truncate text-[8.5px] text-[#64748B]">{path}</span>
            </OpenRow>
          ))}
        </div>
      )}
    </Card>
  );
};

const SavedProfiles: React.FC<{
  core: TauriCore;
  reloadKey: number;
  onOpenProfile: (path: string) => void;
  busy: string | null;
}> = ({ core, reloadKey, onOpenProfile, busy }) => {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    core
      .invoke('list_profiles')
      .then((list) => setProfiles((list as Profile[]) ?? []))
      .catch(() => {});
  }, [core, reloadKey]);

  const start = async (profile: Profile) => {
    setStarting(profile.path);
    setError(null);
    try {
      await core.invoke('start_workspace', { path: profile.path });
      onOpenProfile(profile.path);
    } catch (e) {
      setError(String(e));
      setStarting(null);
    }
  };

  const remove = async (profile: Profile) => {
    try {
      await core.invoke('delete_profile', { path: profile.path });
      setProfiles((prev) => prev.filter((p) => p.path !== profile.path));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Card title="Saved profiles — one click for the same kind of session" className="mt-3">
      {profiles.length === 0 ? (
        emptyHint('No saved profiles yet — configure one on the left, then SAVE PROFILE.')
      ) : (
        <div className="space-y-1.5">
          {profiles.map((p) => (
            <OpenRow
              key={p.path}
              onOpen={() => start(p)}
              onRemove={() => remove(p)}
              disabled={busy !== null || starting !== null}
              title={p.path}
              removeTitle="Delete this profile"
            >
              <span className="block truncate">{starting === p.path ? 'STARTING…' : p.name}</span>
            </OpenRow>
          ))}
        </div>
      )}
      {error && <p className="mt-1.5 text-[10px] text-[#EF4444] font-mono break-all">{error}</p>}
    </Card>
  );
};

export const Launcher: React.FC = () => {
  const [recents, setRecents] = useState<string[]>([]);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [pickedPort, setPickedPort] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileReloadKey, setProfileReloadKey] = useState(0);

  useEffect(() => {
    const core = tauri();
    if (!core) return;
    core
      .invoke('recent_workspaces')
      .then((list) => setRecents((list as string[]) ?? []))
      .catch(() => {});
    core
      .invoke('list_serial_ports')
      .then((list) => {
        const items = (list as SerialPort[]) ?? [];
        setPorts(items);
        if (items.length > 0) setPickedPort(items[0].device_path);
      })
      .catch(() => {});
  }, []);

  const navigate = (base: string) => {
    // Relative, exactly like the shell's own open_workbench: the workbench
    // must run on THIS origin (?api points it at the engine). Navigating to
    // the engine's absolute URL would land on a page where the Tauri ACL
    // rejects every invoke — the launcher would just re-render, forever.
    window.location.replace(`index.html?api=${base}&v=${Date.now()}`);
  };

  const startWorkspace = async (path: string) => {
    const core = tauri();
    if (!core) return;
    setBusy(path);
    setError(null);
    logAction('workspace_open', path);
    try {
      const url = (await core.invoke('start_workspace', { path })) as string;
      navigate(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openPicker = async () => {
    const core = tauri();
    if (!core) return;
    let path: string | null = null;
    try {
      path = (await core.invoke('pick_workspace')) as string | null;
    } catch (e) {
      setError(String(e));
      return;
    }
    if (path) await startWorkspace(path);
  };

  const openDemo = async () => {
    const core = tauri();
    if (!core) return;
    setBusy('demo');
    setError(null);
    try {
      const path = (await core.invoke('demo_workspace')) as string;
      await startWorkspace(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const reviewVault = async () => {
    const core = tauri();
    if (!core) return;
    let path: string | null = null;
    try {
      path = (await core.invoke('pick_vault', { suggest: 'capture.bflog' })) as string | null;
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!path) return;
    setBusy('review');
    setError(null);
    try {
      const url = (await core.invoke('start_review', { path })) as string;
      navigate(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const quickConnect = async () => {
    const core = tauri();
    if (!core) return;
    setBusy(`qc-${pickedPort}`);
    setError(null);
    logAction('quick_connect', `${pickedPort} @ 115200`);
    try {
      const url = (await core.invoke('quick_connect', {
        device: pickedPort,
        baudRate: 115200,
      })) as string;
      navigate(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // A workspace or profile is starting whenever `busy` holds a path rather
  // than one of the named actions below.
  const startingPath = busy !== null && busy !== 'demo' && busy !== 'review' && !busy.startsWith('qc-');

  return (
    <div className="w-full h-screen bg-[#0A0D13] flex flex-col select-none overflow-hidden">
      <header className="shrink-0 flex items-baseline gap-2 px-5 pt-4 pb-3 bg-[#10141D] border-b border-[#222D3D]">
        <span className="text-[#00E5FF] font-mono font-bold text-sm tracking-widest">BAUDFORGE</span>
        <span className="text-[9px] px-1 py-0.2 rounded bg-[#1E2638] text-[#94A3B8] border border-[#222D3D]">v1.0</span>
        <span className="ml-auto text-[10px] text-[#64748B] font-mono truncate">
          Hardware engineering workstation — configure a session on the left, or open one from the right.
        </span>
      </header>

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        {/* LEFT — configure session */}
        <section className="w-[620px] shrink-0 flex flex-col bg-[#10141D] border border-[#222D3D] rounded-lg shadow-[0_0_40px_rgba(0,0,0,0.6)] overflow-hidden">
          <div className="shrink-0 px-4 pt-3.5 pb-2.5 border-b border-[#222D3D]">
            <h1 className="text-[10px] text-[#E2E8F0] uppercase tracking-wider font-bold">
              Configure session <span className="text-[#64748B] font-normal normal-case tracking-normal">— every parameter, no TOML needed</span>
            </h1>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            <ConfigureSession core={tauri()!} onSaved={() => setProfileReloadKey((k) => k + 1)} />
          </div>
        </section>

        {/* RIGHT — quick open */}
        <section className="flex-1 min-w-0 flex flex-col bg-[#10141D] border border-[#222D3D] rounded-lg shadow-[0_0_40px_rgba(0,0,0,0.6)] overflow-y-auto p-4">
          <h1 className="text-[10px] text-[#E2E8F0] uppercase tracking-wider font-bold mb-3">
            Quick open <span className="text-[#64748B] font-normal normal-case tracking-normal">— one click back into a session</span>
          </h1>

          <div className="flex gap-1.5">
            <button
              onClick={openPicker}
              disabled={busy !== null}
              className={navButton + ' font-bold border-[#00E5FF]/40 text-[#00E5FF]'}
            >
              {startingPath ? 'STARTING…' : 'OPEN WORKSPACE…'}
            </button>
          </div>
          <div className="flex gap-1.5 mt-1.5">
            <button onClick={openDemo} disabled={busy !== null} className={navButton}>
              {busy === 'demo' ? 'STARTING…' : 'DEMO (loopback, no hardware)'}
            </button>
            <button onClick={reviewVault} disabled={busy !== null} className={navButton}>
              {busy === 'review' ? 'STARTING…' : 'REVIEW A CAPTURE (.bflog)…'}
            </button>
          </div>

          <RecentWorkspaces
            core={tauri()!}
            recents={recents}
            setRecents={setRecents}
            onOpen={startWorkspace}
            busy={busy}
          />

          <SavedProfiles
            core={tauri()!}
            reloadKey={profileReloadKey}
            onOpenProfile={() => window.location.replace(`index.html?v=${Date.now()}`)}
            busy={busy}
          />

          <Card title="Quick connect (serial, 115200 8N1)" className="mt-3">
            {ports.length === 0 ? (
              emptyHint('No serial ports detected.')
            ) : (
              <div className="flex gap-1.5">
                <select
                  value={pickedPort}
                  onChange={(e) => setPickedPort(e.target.value)}
                  className="flex-1 bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1.5 text-[10.5px] text-[#E2E8F0] font-mono focus:outline-none focus:border-[#00E5FF]"
                >
                  {ports.map((p) => (
                    <option key={p.device_path} value={p.device_path}>
                      {p.device_path} {p.vid_pid ? `(${p.vid_pid})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={quickConnect}
                  disabled={busy !== null || !pickedPort}
                  className="px-3 py-1.5 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded text-[10px] disabled:opacity-40"
                >
                  {busy === `qc-${pickedPort}` ? '…' : 'CONNECT'}
                </button>
              </div>
            )}
          </Card>

          {error && errorBox(error)}
        </section>
      </div>
    </div>
  );
};
