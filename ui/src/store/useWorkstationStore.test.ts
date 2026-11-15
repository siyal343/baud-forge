// Store logic verification for the audit fix waves: unique seqIds, live TX
// accounting, direction filter state, HW-mode scope extraction from decoded
// payloads, and flash-yield interval replace-any semantics.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useWorkstationStore } from './useWorkstationStore';
import { useSettingsStore } from './useSettingsStore';
import { PacketRow } from '../types';
import { plotEngine } from '../plot/engine';
import { SCRIPT_TEMPLATES } from '../services/luaSandboxFallback';

const makePacket = (overrides: Partial<PacketRow> = {}): PacketRow => ({
  seqId: 0,
  timestampNs: 0,
  timestampUs: 1000,
  deltaUs: 50,
  timeStr: '00:00:00.000',
  direction: 'RX',
  port: 'COM8',
  length: 20,
  rawBytes: [0xaa],
  rawHex: 'AA',
  protocol: 'ImuPacket',
  summary: 'test frame',
  dissectedFields: [],
  hasError: false,
  ...overrides,
});

describe('workstation store', () => {
  beforeEach(() => {
    useWorkstationStore.getState().clearScriptState();
    useWorkstationStore.setState({
      packets: [],
      scopeSamples: [],
      rxBytes: 0,
      txBytes: 0,
      isSimulated: false, // exercise the real-payload scope path
      isYielded: false,
      yieldRemainingSecs: 0,
    });
  });

  afterEach(() => {
    plotEngine.reset();
    vi.useRealTimers();
  });

  it('renumbers every packet with a unique monotonic seqId', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(makePacket({ seqId: 42 }));
    s.addPacket(makePacket({ seqId: 42 })); // deliberate duplicate attempt
    s.addPacketBatch([makePacket({ seqId: 7 }), makePacket({ seqId: 7 })]);
    const { packets } = useWorkstationStore.getState();
    expect(packets).toHaveLength(4);
    const ids = packets.map((p) => p.seqId);
    expect(new Set(ids).size).toBe(4);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // strictly increasing
  });

  it('recordTx accumulates transmitted bytes into the footer counter', () => {
    const s = useWorkstationStore.getState();
    s.recordTx(10);
    s.recordTx(184);
    expect(useWorkstationStore.getState().txBytes).toBe(194);
  });

  it('holds last scope reading across fieldless frames (HW mode)', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(
      makePacket({
        timestampUs: 5000,
        dissectedFields: [
          { name: 'v_batt_mv', type: 'uint32', offset: 4, length: 4, rawHex: '', decodedValue: '7430 mV' },
          { name: 'gyro_z', type: 'float32', offset: 8, length: 4, rawHex: '', decodedValue: '-0.45 rad/s' },
        ],
      })
    );
    // A TX command row carries no decoded fields -> previous reading holds.
    s.addPacket(makePacket({ timestampUs: 6000, direction: 'TX', dissectedFields: [] }));
    const { scopeSamples } = useWorkstationStore.getState();
    expect(scopeSamples).toHaveLength(2);
    expect(scopeSamples[0].vBattMv).toBe(7430);
    expect(scopeSamples[0].gyroZ).toBeCloseTo(-0.45, 5);
    expect(scopeSamples[1].vBattMv).toBe(7430); // held, not zeroed
    expect(scopeSamples[1].gyroZ).toBeCloseTo(-0.45, 5);
    expect(scopeSamples[1].timestampUs).toBe(6000);
  });

  it('parses volt-scale v_batt values up to millivolts', () => {
    const s = useWorkstationStore.getState();
    s.addPacket(
      makePacket({
        dissectedFields: [
          { name: 'v_batt', type: 'float32', offset: 0, length: 4, rawHex: '', decodedValue: '8.2 V' },
        ],
      })
    );
    expect(useWorkstationStore.getState().scopeSamples[0].vBattMv).toBeCloseTo(8200, 5);
  });

  it('directionFilter defaults to all and is settable', () => {
    expect(useWorkstationStore.getState().directionFilter).toBe('all');
    useWorkstationStore.getState().setDirectionFilter('tx');
    expect(useWorkstationStore.getState().directionFilter).toBe('tx');
  });

  it('scope trace bindings capture named fields from later frames only', () => {
    const s = useWorkstationStore.getState();
    // Seed frame: bindScopeTrace seeds its lane from the newest packet's value.
    s.addPacket(
      makePacket({
        timestampUs: 1000,
        dissectedFields: [
          { name: 'v_batt_mv', type: 'uint32', offset: 4, length: 4, rawHex: '', decodedValue: '7430 mV' },
        ],
      })
    );
    const id = s.bindScopeTrace({ name: 'v_batt_mv', unit: 'mV' });
    const afterBind = useWorkstationStore.getState();
    expect(afterBind.traceBindings).toHaveLength(1);
    expect(afterBind.traceSeries[id]).toHaveLength(1);

    // Frames carrying the field append points; frames without it do not.
    s.addPacket(
      makePacket({
        timestampUs: 2000,
        dissectedFields: [
          { name: 'v_batt_mv', type: 'uint32', offset: 4, length: 4, rawHex: '', decodedValue: '7500 mV' },
        ],
      })
    );
    s.addPacket(makePacket({ timestampUs: 3000, dissectedFields: [] }));
    const { traceSeries } = useWorkstationStore.getState();
    expect(traceSeries[id]).toHaveLength(2);
    expect(traceSeries[id][1]).toEqual({ tUs: 2000, value: 7500 });

    // Re-binding the same field reuses the slot instead of duplicating lanes.
    const again = s.bindScopeTrace({ name: 'v_batt_mv' });
    expect(again).toBe(id);
    expect(useWorkstationStore.getState().traceBindings).toHaveLength(1);

    // Unbind removes the lane and its series.
    s.unbindScopeTrace(id);
    expect(useWorkstationStore.getState().traceBindings).toHaveLength(0);
    expect(useWorkstationStore.getState().traceSeries[id]).toBeUndefined();
  });

  it('replaces a running flash-yield countdown instead of stacking intervals', () => {
    vi.useFakeTimers();
    const s = useWorkstationStore.getState();
    s.triggerFlashYield(30);
    s.triggerFlashYield(10); // second trigger while the first counts down
    vi.advanceTimersByTime(11000);
    // With stacked intervals the countdown would double-decrement and go
    // negative / reclaim twice; with replace-any it expires exactly once.
    const after = useWorkstationStore.getState();
    expect(after.isYielded).toBe(false);
    expect(after.yieldRemainingSecs).toBe(0);
    expect(after.portState).toBe('open');
  });

  describe('DVR replay', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Seed a 5-frame buffer with distinct seqIds.
      const s = useWorkstationStore.getState();
      s.clearStream();
      for (let i = 0; i < 5; i++) {
        s.addPacket(makePacket({ timestampUs: 1000 + i * 1000 }));
      }
    });

    afterEach(() => {
      useWorkstationStore.getState().setDvrLive();
    });

    it('walks buffered frames at playbackSpeed and halts at the end', () => {
      const s = useWorkstationStore.getState();
      s.setDvrPaused(true);
      s.setPlaybackSpeed(1);
      s.startReplay();
      expect(useWorkstationStore.getState().isReplaying).toBe(true);

      vi.advanceTimersByTime(50 * 3); // 3 ticks at 50 ms (1x = 20 fps)
      const mid = useWorkstationStore.getState();
      expect(mid.isReplaying).toBe(true);
      expect(mid.selectedPacket?.timestampUs).toBe(4000); // idx 3 of 5

      vi.advanceTimersByTime(50 * 2);
      const end = useWorkstationStore.getState();
      // Reached the last frame and stopped there (no loop).
      expect(end.isReplaying).toBe(false);
      expect(end.selectedPacket?.timestampUs).toBe(5000);
      expect(end.isPaused).toBe(true);
    });

    it('speed chips change the replay rate live', () => {
      const s = useWorkstationStore.getState();
      s.setDvrPaused(true);
      s.setPlaybackSpeed(0.5); // 100 ms per frame
      s.startReplay();
      vi.advanceTimersByTime(100);
      expect(useWorkstationStore.getState().selectedPacket?.timestampUs).toBe(2000);
      s.setPlaybackSpeed(2); // now 25 ms per frame
      vi.advanceTimersByTime(50); // two frames at 2x
      expect(useWorkstationStore.getState().selectedPacket?.timestampUs).toBe(4000);
    });

    it('scrubbing or stepping cancels the replay', () => {
      const s = useWorkstationStore.getState();
      s.setDvrPaused(true);
      s.startReplay();
      vi.advanceTimersByTime(100);
      expect(useWorkstationStore.getState().isReplaying).toBe(true);
      s.stopReplay();
      expect(useWorkstationStore.getState().isReplaying).toBe(false);
      vi.advanceTimersByTime(500);
      // No further advancement after stop.
      const frozen = useWorkstationStore.getState().selectedPacket?.timestampUs;
      vi.advanceTimersByTime(500);
      expect(useWorkstationStore.getState().selectedPacket?.timestampUs).toBe(frozen);
    });

    it('returning live clears the replay state', () => {
      const s = useWorkstationStore.getState();
      s.setDvrPaused(true);
      s.startReplay();
      vi.advanceTimersByTime(100);
      s.setDvrLive();
      const live = useWorkstationStore.getState();
      expect(live.isReplaying).toBe(false);
      expect(live.isLive).toBe(true);
      expect(live.isPaused).toBe(false);
      vi.advanceTimersByTime(500);
      // Selected packet no longer advances — live capture owns selection.
      const sel = live.selectedPacket?.timestampUs;
      vi.advanceTimersByTime(500);
      expect(useWorkstationStore.getState().selectedPacket?.timestampUs).toBe(sel);
    });
  });

  describe('hex byte selection and packet pin correlation', () => {
    beforeEach(() => {
      useWorkstationStore.setState({
        packets: [],
        selectedPacket: null,
        selectedField: null,
        hoveredField: null,
        hoveredByteOffset: null,
        selectedByteOffset: null,
        autoScroll: true,
      });
    });

    it('tracks hoveredByteOffset and selectedByteOffset and resets them on selectPacket', () => {
      const s = useWorkstationStore.getState();
      expect(s.hoveredByteOffset).toBeNull();
      expect(s.selectedByteOffset).toBeNull();

      s.setHoveredByteOffset(4);
      s.setSelectedByteOffset(10);
      expect(useWorkstationStore.getState().hoveredByteOffset).toBe(4);
      expect(useWorkstationStore.getState().selectedByteOffset).toBe(10);

      const pkt = makePacket({
        seqId: 101,
        dissectedFields: [
          { name: 'sync', type: 'uint16', offset: 0, length: 2, rawHex: 'AA 55', decodedValue: '0xAA55' },
        ],
      });
      s.selectPacket(pkt);

      const afterSelect = useWorkstationStore.getState();
      expect(afterSelect.selectedPacket).toEqual(pkt);
      expect(afterSelect.selectedField?.name).toBe('sync');
      expect(afterSelect.hoveredByteOffset).toBeNull();
      expect(afterSelect.selectedByteOffset).toBeNull();

      // Clearing hovered/selected offsets explicitly also works, and selectPacket(null) resets them.
      s.setHoveredByteOffset(2);
      s.setSelectedByteOffset(3);
      s.selectPacket(null);
      expect(useWorkstationStore.getState().hoveredByteOffset).toBeNull();
      expect(useWorkstationStore.getState().selectedByteOffset).toBeNull();
      expect(useWorkstationStore.getState().selectedPacket).toBeNull();
    });

    it('stepFrame disables autoScroll and resets byte offsets on frame change', () => {
      const s = useWorkstationStore.getState();
      s.addPacket(makePacket({ timestampUs: 1000 }));
      s.addPacket(makePacket({ timestampUs: 2000 }));
      s.setAutoScroll(true);
      s.setHoveredByteOffset(1);
      s.setSelectedByteOffset(2);

      s.stepFrame('back');
      const afterStep = useWorkstationStore.getState();
      expect(afterStep.autoScroll).toBe(false);
      expect(afterStep.selectedPacket?.timestampUs).toBe(1000);
      expect(afterStep.hoveredByteOffset).toBeNull();
      expect(afterStep.selectedByteOffset).toBeNull();
    });
  });

  describe('scope logic flags and bounded ring buffers', () => {
    it('extracts digital logic flags from flag-like fields and packet direction/error fallback', () => {
      const s = useWorkstationStore.getState();

      // Numeric flags field: bit 0, bit 1, bit 2
      s.addPacket(
        makePacket({
          timestampUs: 1000,
          dissectedFields: [
            { name: 'flags', type: 'uint8', offset: 0, length: 1, rawHex: '05', decodedValue: 5 },
          ],
        })
      );
      // Binary string flags field
      s.addPacket(
        makePacket({
          timestampUs: 2000,
          dissectedFields: [
            { name: 'gpio_state', type: 'bitfield', offset: 0, length: 1, rawHex: '03', decodedValue: '0b011' },
          ],
        })
      );
      // String status/mode containing FAULT or ERR sets bit 2
      s.addPacket(
        makePacket({
          timestampUs: 3000,
          dissectedFields: [
            { name: 'status', type: 'enum', offset: 0, length: 1, rawHex: '02', decodedValue: 'ERR_CRC' },
          ],
        })
      );
      // Fallback when no flags/status/state/mode/gpio field exists: RX normal, TX, and error/fault
      s.addPacketBatch([
        makePacket({ timestampUs: 4000, direction: 'RX', hasError: false, dissectedFields: [] }),
        makePacket({ timestampUs: 5000, direction: 'TX', hasError: false, dissectedFields: [] }),
        makePacket({ timestampUs: 6000, direction: 'RX', hasError: true, dissectedFields: [] }),
        makePacket({ timestampUs: 7000, direction: 'RX', hasError: false, isFaultInjected: true, dissectedFields: [] }),
      ]);

      const { scopeSamples } = useWorkstationStore.getState();
      expect(scopeSamples).toHaveLength(7);
      expect(scopeSamples[0].flags).toEqual([1, 0, 1]);
      expect(scopeSamples[1].flags).toEqual([1, 1, 0]);
      expect(scopeSamples[2].flags).toEqual([0, 0, 1]);
      expect(scopeSamples[3].flags).toEqual([1, 0, 0]);
      expect(scopeSamples[4].flags).toEqual([1, 1, 0]);
      expect(scopeSamples[5].flags).toEqual([1, 0, 1]);
      expect(scopeSamples[6].flags).toEqual([1, 0, 1]);
    });

    it('keeps packets, scopeSamples, and traceSeries bounded across single and batch inserts', () => {
      const prevSettings = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: { ...prevSettings, maxPackets: 3, maxScopeSamples: 3 },
      });
      let traceId = '';
      try {
        const s = useWorkstationStore.getState();
        traceId = s.bindScopeTrace({ name: 'v_batt_mv', unit: 'mV' });
        const mk = (t: number, v: number) =>
          makePacket({
            timestampUs: t,
            dissectedFields: [
              { name: 'v_batt_mv', type: 'uint16', offset: 0, length: 2, rawHex: '', decodedValue: v },
            ],
          });

        s.addPacket(mk(100, 7000));
        s.addPacket(mk(200, 7100));
        s.addPacket(mk(300, 7200));
        s.addPacket(mk(400, 7300));
        expect(useWorkstationStore.getState().packets.map((p) => p.timestampUs)).toEqual([200, 300, 400]);
        expect(useWorkstationStore.getState().scopeSamples.map((p) => p.timestampUs)).toEqual([200, 300, 400]);
        expect(useWorkstationStore.getState().traceSeries[traceId].map((p) => p.value)).toEqual([7100, 7200, 7300]);

        s.addPacketBatch([mk(500, 7400), mk(600, 7500)]);
        expect(useWorkstationStore.getState().packets.map((p) => p.timestampUs)).toEqual([400, 500, 600]);
        expect(useWorkstationStore.getState().scopeSamples.map((p) => p.timestampUs)).toEqual([400, 500, 600]);
        expect(useWorkstationStore.getState().traceSeries[traceId].map((p) => p.value)).toEqual([7300, 7400, 7500]);
      } finally {
        if (traceId) useWorkstationStore.getState().unbindScopeTrace(traceId);
        useSettingsStore.setState({ settings: prevSettings });
      }
    });
  });

  describe('Lua 5.4 Script Lab state & Simulated Mode hooks', () => {
    it('syncs snapshot.script in applySnapshot and opens requested templates', () => {
      const s = useWorkstationStore.getState();
      s.setOfflineArmedScript({
        source: SCRIPT_TEMPLATES.seu_bitflip.source,
        name: 'seu_bitflip.lua',
        policy: 'fail_open',
      });
      expect(useWorkstationStore.getState().offlineArmedScript).not.toBeNull();

      s.applySnapshot({
        contract: 1,
        session: {
          mode: 'idle',
          vault: '',
          file_bytes: 0,
          chunks: 0,
          payload_bytes: 0,
          elapsed_ms: 0,
          started_epoch_ns: 0,
          elf: null,
        },
        ports: [],
        bridges: [],
        script: {
          armed: true,
          name: 'engine_script.lua',
          policy: 'fail_closed',
          hooks: ['on_rx_frame'],
          invocations: 12,
          changed: 3,
          dropped: 1,
          delayed: 0,
          injected_tx: 0,
          failures: 0,
          logs_suppressed: 0,
          assertions_passed: 12,
          assertions_failed: 0,
          memory_bytes: 32000,
          memory_limit_bytes: 4194304,
          last_instructions: 180,
          last_exec_us: 15,
          max_exec_us: 22,
          last_error: null,
          metrics: { hits: '3' },
          assertions: [{ name: 'ok', passed: 12, failed: 0, last_error: null }],
        },
      });

      const synced = useWorkstationStore.getState();
      expect(synced.scriptStatus?.name).toBe('engine_script.lua');
      expect(synced.scriptStatus?.invocations).toBe(12);
      expect(synced.offlineArmedScript).toBeNull();

      synced.openScriptLabWithTemplate('mitm_glitch');
      const afterOpen = useWorkstationStore.getState();
      expect(afterOpen.requestedScriptTemplate).toBe('mitm_glitch');
      expect(afterOpen.openPanelId).toBe('scriptLab');
      expect(afterOpen.scriptName).toBe('mitm_glitch.lua');
      expect(afterOpen.scriptSource).toBe(SCRIPT_TEMPLATES.mitm_glitch.source);
    });

    it('executes armed offline scripts in Simulated Mode and pushes bforge.plot metrics to PlotEngine', () => {
      plotEngine.reset();
      plotEngine.ensureChannel({
        id: 'ch_script_vbatt',
        label: 'script:vbatt_mv',
        color: '#38bdf8',
        visible: true,
        axis: 'y1',
        source: { kind: 'field', name: 'script:vbatt_mv' },
      });

      useWorkstationStore.setState({ isSimulated: true });
      const s = useWorkstationStore.getState();
      s.setOfflineArmedScript({
        source: SCRIPT_TEMPLATES.telemetry_plot.source,
        name: 'telemetry_plot.lua',
        policy: 'fail_open',
      });

      const imuBytes = [
        0xaa, 0x55, 0x01, 0x13, 0x40, 0xe2, 0x01, 0x00, 0x1f, 0xf4, 0x00, 0x00, 0x00, 0x00, 0x80,
        0x90, 0xa0, 0xb0, 0x01, 0x5b,
      ];
      s.addPacket(
        makePacket({
          timestampUs: 50_000,
          length: imuBytes.length,
          rawBytes: imuBytes,
          rawHex: imuBytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
          dissectedFields: [
            {
              name: 'v_batt_mv',
              type: 'uint16_be',
              offset: 8,
              length: 2,
              rawHex: '1F F4',
              decodedValue: '8.18',
              unit: 'V',
            },
            {
              name: 'gyro_z',
              type: 'float32_le',
              offset: 10,
              length: 4,
              rawHex: '00 00 00 00',
              decodedValue: 0,
              unit: 'rad/s',
            },
          ],
        })
      );

      const st = useWorkstationStore.getState();
      expect(st.packets).toHaveLength(1);
      expect(st.scriptStatus?.invocations).toBe(1);
      expect(st.scriptStatus?.metrics.sampled_frames).toBe('1');
      expect(st.scriptStatus?.assertions_passed).toBe(2);
      expect(st.packets[0].dissectedFields.some((f) => f.name === 'script:vbatt_mv')).toBe(true);
      expect(plotEngine.catalogEntry('script:vbatt_mv')?.lastValue).toBe(8180);
      expect(plotEngine.lastValue('ch_script_vbatt')).toBe(8180);

      // Verify frame drop verdict suppresses packet ingestion in Simulated Mode
      st.setOfflineArmedScript({
        source: `bforge.on_rx_frame(function(frame)\n return nil\nend)`,
        name: 'dropper.lua',
        policy: 'fail_open',
      });
      useWorkstationStore.setState({ packets: [] });
      st.addPacket(makePacket({ timestampUs: 60_000 }));
      expect(useWorkstationStore.getState().packets).toHaveLength(0);
      expect(useWorkstationStore.getState().scriptStatus?.dropped).toBe(1);
    });
  });
});
