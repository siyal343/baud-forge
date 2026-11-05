import React, { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from './store/useWorkstationStore';
import { GlobalRibbon } from './components/GlobalRibbon';
import { WorkstationDock } from './components/WorkstationDock';
import { DvrTimelineBar } from './components/DvrTimelineBar';
import { StatusFooter } from './components/StatusFooter';
import { VaultExportModal } from './components/VaultExportModal';
import { TooltipOverlay } from './components/TooltipOverlay';
import { ToastHost } from './components/ToastHost';
import { generateSampleImuPacket } from './services/simulationEngine';
import { engineApi } from './services/engineApi';
import { PacketDirection } from './types';

export const App: React.FC = () => {
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

  // Initial demo capture load on start so screen is immediately rich with realistic data
  useEffect(() => {
    loadSampleCapture();
  }, [loadSampleCapture]);

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
            decodedValue: field.value,
            unit: field.name.includes('mv')
              ? 'mV'
              : field.name.includes('us')
              ? 'μs'
              : field.name.includes('gyro')
              ? 'rad/s'
              : undefined,
          }));

          return {
            seqId: Math.round(f.timestamp_us / 1000) % 1000000 || idx + 1,
            timestampNs: f.timestamp_us * 1000,
            timestampUs: f.timestamp_us,
            deltaUs: f.delta_us,
            timeStr,
            direction: (f.direction === 'rx'
              ? 'RX'
              : f.direction === 'tx'
              ? 'TX'
              : 'FAULT') as PacketDirection,
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
          retryTimer = window.setTimeout(tryConnect, 5000);
          return;
        }
        useWorkstationStore.setState({ isSimulated: false, isConnected: true });
        unsubscribe = engineApi.subscribeEvents(
          (snapshot) => {
            updateSnapshot(snapshot.ports);
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
