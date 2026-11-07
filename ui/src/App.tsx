import React, { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from './store/useWorkstationStore';
import { GlobalRibbon } from './components/GlobalRibbon';
import { WorkstationDock } from './components/WorkstationDock';
import { DvrTimelineBar } from './components/DvrTimelineBar';
import { StatusFooter } from './components/StatusFooter';
import { VaultExportModal } from './components/VaultExportModal';
import { TooltipOverlay } from './components/TooltipOverlay';
import { ToastHost } from './components/ToastHost';
import { Launcher, isDesktopShell, hasEngineParam } from './components/Launcher';
import { generateSampleImuPacket } from './services/simulationEngine';
import { engineApi } from './services/engineApi';
import { PacketDirection } from './types';

export const App: React.FC = () => {
  // Desktop shell: before an engine session starts, the workbench has no
  // /api to talk to — show the launcher instead (spec 0036 workspace picker).
  const [launcherState, setLauncherState] = useState<'checking' | 'show' | 'hide'>(
    isDesktopShell() && !hasEngineParam() ? 'checking' : 'hide'
  );
  useEffect(() => {
    if (launcherState !== 'checking') return;
    const core = (window as any).__TAURI__?.core;
    if (!core) {
      setLauncherState('show');
      return;
    }
    core
      .invoke('engine_state')
      .then((state: string | null) => {
        if (state) {
          // A session is already running (workspace passed on the command
          // line) — follow it, on THIS origin with ?api pointing at the
          // engine. The engine's absolute URL would hit the Tauri ACL: every
          // invoke is rejected there and the launcher would re-render forever.
          window.location.replace(`index.html?api=${state.split(' ')[0]}&v=${Date.now()}`);
        } else {
          setLauncherState('show');
        }
      })
      .catch(() => setLauncherState('show'));
  }, [launcherState]);
  if (launcherState === 'checking') return null;
  if (launcherState === 'show') return <Launcher />;
  const {
    isConnected,
    isSimulated,
    isPaused,
    isFaultArmed,
    selectedPort,
    uiScale,
    setUiScale,
    addPacket,
    addPacketBatch,
    loadSampleCapture,
    stepFrame,
    setDvrPaused,
    triggerFlashYield,
    updateSnapshot,
    updateSession,
    clearStream,
    setFilterText,
  } = useWorkstationStore(
    useShallow((s) => ({
      isConnected: s.isConnected,
      isSimulated: s.isSimulated,
      isPaused: s.isPaused,
      isFaultArmed: s.isFaultArmed,
      selectedPort: s.selectedPort,
      uiScale: s.uiScale,
      setUiScale: s.setUiScale,
      addPacket: s.addPacket,
      addPacketBatch: s.addPacketBatch,
      loadSampleCapture: s.loadSampleCapture,
      stepFrame: s.stepFrame,
      setDvrPaused: s.setDvrPaused,
      triggerFlashYield: s.triggerFlashYield,
      updateSnapshot: s.updateSnapshot,
      updateSession: s.updateSession,
      clearStream: s.clearStream,
      setFilterText: s.setFilterText,
    }))
  );

  // The demo capture seeds only when there is no engine to connect to —
  // tryConnect's failure path seeds it after the first failed health check.
  // Seeding unconditionally on mount mixed fake `COM8` rows (FAULT badges
  // included) into a real session's stream.

  // Try connecting to live Rust Engine (bforge serve /api/events).
  // Retries health checks on a 5 s loop (so a late-starting engine is picked
  // up without a reload) and re-subscribes with backoff when the SSE stream
  // drops. The `disposed` guard prevents the post-unmount subscription race
  // (StrictMode double-mounts included).
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let retryTimer: number | null = null;

    const handleFrameBatch = (rawFrames: any[]) => {
      if (Array.isArray(rawFrames) && rawFrames.length > 0) {
        const now = new Date();
        const timeStr =
          now.toTimeString().split(' ')[0] +
          '.' +
          String(now.getMilliseconds()).padStart(3, '0');

        const batch = rawFrames.map((f: any, idx: number) => {
          const bytes = f.hex
            ? f.hex
                .trim()
                .split(/\s+/)
                .map((h: string) => parseInt(h, 16))
                .filter((n: number) => !isNaN(n))
            : [];

          const dissectedFields = (f.fields || []).map((field: any) => ({
            name: field.name,
            type: 'field',
            offset: field.offset,
            length: field.len,
            rawHex: bytes
              .slice(field.offset, field.offset + field.len)
              .map((b: number) => b.toString(16).padStart(2, '0'))
              .join(' ')
              .toUpperCase(),
            // The numeric reading (`value_num`) makes the field plottable —
            // the trace-lane buttons need a real number, not the display string.
            decodedValue: field.value_num ?? field.value,
            unit: field.name.includes('mv')
              ? 'mV'
              : field.name.includes('us')
              ? 'μs'
              : field.name.includes('gyro')
              ? 'rad/s'
              : undefined,
          }));

          // The engine serializes Direction in PascalCase (`Rx`, `Tx`,
          // `MitmAToB`, `MitmBToA`, `InjectedFault`) — match it exactly, or
          // every honest RX frame would wear a FAULT badge.
          const direction: PacketDirection =
            f.direction === 'rx' || f.direction === 'Rx'
              ? 'RX'
              : f.direction === 'tx' || f.direction === 'Tx'
              ? 'TX'
              : f.direction === 'MitmAToB'
              ? 'A->B'
              : f.direction === 'MitmBToA'
              ? 'B->A'
              : f.direction === 'InjectedFault'
              ? 'FAULT'
              : 'RX';

          return {
            seqId: Math.round(f.timestamp_us / 1000) % 1000000 || idx + 1,
            timestampNs: f.timestamp_us * 1000,
            timestampUs: f.timestamp_us,
            deltaUs: f.delta_us,
            timeStr,
            direction,
            port: f.port,
            length: f.len,
            rawBytes: bytes,
            rawHex: f.hex || '',
            protocol: f.protocol || 'ImuPacket',
            summary:
              f.text ||
              (f.decode_error
                ? `ERR: ${f.decode_error}`
                : `Decoded ${dissectedFields.length} fields (${f.len}B)`),
            dissectedFields,
            hasError: !!f.decode_error,
            errorMsg: f.decode_error,
          };
        });

        addPacketBatch(batch);
      }
    };

    const tryConnect = () => {
      if (disposed) return;
      engineApi.checkHealth().then((isHealthy) => {
        if (disposed) return;
        if (!isHealthy) {
          // No engine (yet): keep the screen rich with the simulated capture.
          if (useWorkstationStore.getState().packets.length === 0) {
            loadSampleCapture();
          }
          retryTimer = window.setTimeout(tryConnect, 5000);
          return;
        }
        // First connect (not an SSE reconnect): drop any simulated rows so the
        // real session's stream holds only what the hardware actually sent.
        if (useWorkstationStore.getState().isSimulated) {
          useWorkstationStore.getState().clearStream();
        }
        useWorkstationStore.setState({ isSimulated: false, isConnected: true });
        unsubscribe = engineApi.subscribeEvents(
          (snapshot) => {
            updateSnapshot(snapshot.ports, snapshot.bridges);
            if (snapshot.session) {
              updateSession({
                mode: snapshot.session.mode,
                vault: snapshot.session.vault,
                file_bytes: snapshot.session.file_bytes,
                chunks: snapshot.session.chunks,
              });
            }
          },
          (uiEvent) => {
            console.log('UI Event:', uiEvent);
          },
          handleFrameBatch,
          undefined,
          // SSE dropped: tear down and retry until the stream returns.
          () => {
            if (disposed) return;
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }
            retryTimer = window.setTimeout(tryConnect, 2000);
          }
        );
      });
    };

    tryConnect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (unsubscribe) unsubscribe();
    };
  }, [updateSnapshot, updateSession, addPacketBatch]);

  // Continuous Telemetry Stream Generator (Simulation Mode)
  useEffect(() => {
    if (!isConnected || !isSimulated || isPaused) return;

    let pktCounter = 0;
    const interval = setInterval(() => {
      pktCounter++;
      // If fault injection is armed, inject fault 1 out of 5 frames
      const injectFault = isFaultArmed && pktCounter % 5 === 0;
      const pkt = generateSampleImuPacket(selectedPort, injectFault, 50000);
      addPacket(pkt);
    }, 50); // 20 packets/sec (115.2k typical rate)

    return () => clearInterval(interval);
  }, [isConnected, isSimulated, isPaused, isFaultArmed, selectedPort, addPacket]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;

      // Escape works everywhere — including inside text fields — so the
      // advertised "Clear filter (Esc)" behaves while typing in the filter.
      if (e.key === 'Escape') {
        setFilterText('');
        if (tag === 'INPUT') (document.activeElement as HTMLElement)?.blur?.();
        return;
      }

      // Otherwise ignore focus in a text field or on an interactive control —
      // Space/arrow keys must activate buttons and selects, not the DVR.
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON'
      ) {
        return;
      }

      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setUiScale(uiScale + 0.05);
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        setUiScale(uiScale - 0.05);
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        setUiScale(1.0);
      } else if (e.code === 'Space') {
        e.preventDefault();
        setDvrPaused(!useWorkstationStore.getState().isPaused);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepFrame('back');
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepFrame('forward');
      } else if (e.ctrlKey && e.shiftKey && e.code === 'KeyY') {
        e.preventDefault();
        triggerFlashYield(30);
      } else if (e.key === '/') {
        // Spec 2.3: '/' focuses the stream filter (advertised in its placeholder)
        e.preventDefault();
        const filter = document.getElementById('bforge-stream-filter') as HTMLInputElement | null;
        filter?.focus();
        filter?.select();
      } else if (e.ctrlKey && e.code === 'KeyL') {
        // UX_ARCH §2.3: Ctrl+L clears the stream view
        e.preventDefault();
        clearStream();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setDvrPaused, stepFrame, triggerFlashYield, setFilterText, clearStream, uiScale, setUiScale]);

  // Synchronize native webview zoom to document element for perfect responsive scaling
  useEffect(() => {
    const scale = uiScale || 1.0;
    (document.documentElement.style as any).zoom = String(scale);
  }, [uiScale]);

  return (
    <div className="w-full h-screen flex flex-col bg-[#0A0D13] overflow-hidden select-none">
      {/* 1. Global Toolbar / Quick-Action Ribbon */}
      <GlobalRibbon />

      {/* 2. Dockable & Resizable Central Workstation */}
      <WorkstationDock />

      {/* 3. DVR Time-Scrubber & Transport Bar */}
      <DvrTimelineBar />

      {/* 4. Hardware Modem Line & Status Footer */}
      <StatusFooter />

      {/* 5. Session Vault Export Modal (specs/0044) */}
      <VaultExportModal />

      {/* 6. Global Dark Engineering Tooltip Surface */}
      <TooltipOverlay />

      {/* 7. Global Feedback Toasts (engine errors, TX/fault/pin results) */}
      <ToastHost />
    </div>
  );
};

export default App;
