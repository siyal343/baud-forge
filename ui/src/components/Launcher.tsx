// Desktop launcher (spec 0036): the first screen inside the Tauri shell.
// Shown only when running inside Tauri with no engine session yet — the
// workbench replaces this view once a workspace starts (the shell navigates
// to the engine's own address, where the same UI runs same-origin).
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

export const Launcher: React.FC = () => {
  const [recents, setRecents] = useState<string[]>([]);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [pickedPort, setPickedPort] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    window.location.replace(`${base}/?v=${Date.now()}`);
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
    const path = (await core.invoke('pick_workspace')) as string | null;
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
    const path = (await core.invoke('pick_vault', { suggest: 'capture.bflog' })) as
      | string
      | null;
    if (!path) return;
    setBusy(path);
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

  const navButton =
    'w-full px-3 py-2 rounded text-left font-mono text-[11px] transition-colors bg-[#121722] border border-[#222D3D] text-[#E2E8F0] hover:border-[#00E5FF]/60 hover:text-[#00E5FF] disabled:opacity-40 disabled:hover:border-[#222D3D]';

  return (
    <div className="w-full h-screen bg-[#0A0D13] flex items-center justify-center select-none">
      <div className="w-[460px] bg-[#10141D] border border-[#222D3D] rounded-lg p-5 shadow-[0_0_40px_rgba(0,0,0,0.6)]">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-[#00E5FF] font-mono font-bold text-sm tracking-widest">
            BAUDFORGE
          </span>
          <span className="text-[9px] px-1 py-0.2 rounded bg-[#1E2638] text-[#94A3B8] border border-[#222D3D]">
            v1.0
          </span>
        </div>
        <p className="text-[10px] text-[#64748B] font-mono mb-4">
          Hardware engineering workstation — pick a workspace to open the rig.
        </p>

        <div className="space-y-1.5">
          <button
            onClick={openPicker}
            disabled={busy !== null}
            className={navButton + ' font-bold border-[#00E5FF]/40 text-[#00E5FF]'}
          >
            {busy && busy !== 'demo' && busy.startsWith('/')
              ? 'STARTING…'
              : 'OPEN WORKSPACE…'}
          </button>

          {recents.map((path) => (
            <button
              key={path}
              onClick={() => startWorkspace(path)}
              disabled={busy !== null}
              title={path}
              className={navButton + ' truncate'}
            >
              {path.split(/[\\/]/).pop()}{' '}
              <span className="text-[#64748B] text-[9px]">— {path}</span>
            </button>
          ))}

          <button
            onClick={openDemo}
            disabled={busy !== null}
            className={navButton}
          >
            DEMO (loopback, no hardware)
          </button>

          <button
            onClick={reviewVault}
            disabled={busy !== null}
            className={navButton}
          >
            REVIEW A CAPTURE (.bflog)…
          </button>
        </div>

        <div className="mt-4 pt-3 border-t border-[#222D3D]">
          <div className="text-[9px] text-[#64748B] uppercase tracking-wider font-bold mb-1.5">
            Quick connect (serial, 115200 8N1)
          </div>
          {ports.length === 0 ? (
            <p className="text-[9.5px] text-[#64748B] font-mono">
              No serial ports detected.
            </p>
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
        </div>

        {error && (
          <div className="mt-3 p-1.5 rounded bg-[#EF4444]/15 border border-[#EF4444]/30 text-[#EF4444] text-[10px] font-mono break-all">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};
