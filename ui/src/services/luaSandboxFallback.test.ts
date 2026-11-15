import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCRIPT_TEMPLATES,
  DEFAULT_TEST_FRAME_HEX,
  compileLuaScriptOffline,
  dryRunLuaScriptOffline,
  formatSpacedHex,
  parseHexBytes,
} from './luaSandboxFallback';
import { crc8Atm, crc16CcittFalse, crc16Modbus, crc16Xmodem } from '../utils/checksums';
import type { PacketRow } from '../types';

function makeImuPacket(): PacketRow {
  const bytes = [
    0xaa, 0x55, 0x01, 0x13, 0x40, 0xe2, 0x01, 0x00, 0x1f, 0xf4, 0x00, 0x00, 0x00, 0x00, 0x80, 0x90,
    0xa0, 0xb0, 0x01, 0x5b,
  ];
  return {
    seqId: 42,
    timestampNs: 1_000_000_000,
    timestampUs: 1_000_000,
    deltaUs: 500,
    timeStr: '00:00:01.000',
    direction: 'RX',
    port: 'COM8',
    length: bytes.length,
    rawBytes: bytes,
    rawHex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    protocol: 'ImuPacket',
    summary: 'IMU test frame',
    hasError: false,
    dissectedFields: [
      { name: 'sync', type: 'uint16', offset: 0, length: 2, rawHex: 'AA 55', decodedValue: '0xAA55' },
      { name: 'version', type: 'uint8', offset: 2, length: 1, rawHex: '01', decodedValue: 1 },
      { name: 'v_batt_mv', type: 'uint16_be', offset: 8, length: 2, rawHex: '1F F4', decodedValue: '8.18', unit: 'V' },
      { name: 'gyro_z', type: 'float32_le', offset: 10, length: 4, rawHex: '00 00 00 00', decodedValue: 0, unit: 'rad/s' },
      { name: 'checksum', type: 'uint8', offset: 19, length: 1, rawHex: '5B', decodedValue: '0x5B' },
    ],
  };
}

describe('luaSandboxFallback.compileLuaScriptOffline', () => {
  it('compiles all starter and tutorial templates cleanly and detects hooks', () => {
    const keys = Object.keys(SCRIPT_TEMPLATES);
    expect(keys.slice(0, 5)).toEqual([
      'seu_bitflip',
      'mitm_glitch',
      'virtual_responder',
      'telemetry_plot',
      'watchdog_pins',
    ]);
    expect(keys.length).toBe(20);
    for (const [id, tpl] of Object.entries(SCRIPT_TEMPLATES)) {
      const res = compileLuaScriptOffline(tpl.source);
      expect(res.ok, `${id} should compile: ${res.error}`).toBe(true);
      expect(res.error).toBeNull();
      expect(res.hooks).toContain(tpl.hook);
    }
  });

  it('validates balanced control blocks and ignores keywords in comments/strings', () => {
    const src = `
      --[[ multiline comment with end and unclosed function ( ]]
      -- trailing comment if while for
      bforge.on_rx_frame(function(frame)
        local text = "end function if ("
        local sum = 0
        for i = 1, 3 do
          while sum < 10 do
            if i == 1 then
              sum = sum + 1
            elseif i == 2 then
              sum = sum + 2
            else
              sum = sum + 3
            end
          end
        end
        repeat
          sum = sum - 1
        until sum <= 5
        return frame
      end)
    `;
    const res = compileLuaScriptOffline(src);
    expect(res.ok).toBe(true);
    expect(res.hooks).toEqual(['on_rx_frame']);
  });

  it('rejects unclosed blocks, unmatched brackets, and scripts without hooks', () => {
    expect(
      compileLuaScriptOffline(`
        bforge.on_rx_frame(function(frame)
          if true then
            return frame
        end)
      `).ok
    ).toBe(false);

    expect(
      compileLuaScriptOffline(`
        bforge.on_rx_frame(function(frame)
          return frame
        end
      `).ok
    ).toBe(false);

    const noHook = compileLuaScriptOffline('local x = 1 + 2');
    expect(noHook.ok).toBe(false);
    expect(noHook.error).toMatch(/bforge\.on_/);
  });
});

describe('luaSandboxFallback.dryRunLuaScriptOffline', () => {
  it('runs seu_bitflip: xor_bit mutates byte 8, populates field diff, metrics, log and plot', () => {
    const res = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.seu_bitflip.source, DEFAULT_TEST_FRAME_HEX, 'COM8');
    expect(res.ok).toBe(true);
    expect(res.offline).toBe(true);
    expect(res.mutated).toBe(true);
    expect(res.verdict).toBe('send');

    const beforeBytes = DEFAULT_TEST_FRAME_HEX.split(' ');
    const afterBytes = res.output_hex.split(' ');
    expect(parseInt(afterBytes[8], 16)).toBe(parseInt(beforeBytes[8], 16) ^ (1 << 2));
    expect(res.field_diffs.some((d) => d.name === 'v_batt_mv')).toBe(true);
    expect(res.metrics.seu_hits).toBe('1');
    expect(res.actions.some((a) => a.kind === 'log' && a.level === 'warn')).toBe(true);
    expect(res.actions.some((a) => a.kind === 'plot' && a.series === 'seu_v_batt_mv')).toBe(true);
    expect(res.assertions.find((a) => a.name === 'vbatt_present')?.passed).toBe(1);
  });

  it('runs mitm_glitch: sets v_batt_mv, recalculates crc8, and injects 45ms delay', () => {
    const res = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.mitm_glitch.source, makeImuPacket(), 'COM8');
    expect(res.ok).toBe(true);
    expect(res.mutated).toBe(true);
    expect(res.delay_ms).toBe(45);
    expect(res.verdict).toBe('delay');
    const vbattDiff = res.field_diffs.find((d) => d.name === 'v_batt_mv');
    expect(vbattDiff).toBeDefined();
    expect(vbattDiff?.before).toBe('8180');
    expect(vbattDiff?.after).toBe('6980');
    expect(res.field_diffs.some((d) => d.name === 'checksum')).toBe(true);
    expect(res.metrics.mitm_glitched).toBe('1');
  });

  it('runs virtual_responder: packs little-endian ACK via string.pack and queues bforge.send', () => {
    const res = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.virtual_responder.source, makeImuPacket(), 'COM9');
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe('send');
    const sendAct = res.actions.find((a) => a.kind === 'send');
    expect(sendAct).toBeDefined();
    expect(sendAct?.port).toBe('COM8');
    expect(sendAct?.hex).toBe('55 AA 81 00 00 00');
    expect(sendAct?.delay_ms).toBe(5);
    expect(res.metrics.ack_sent).toBe('1');
  });

  it('runs telemetry_plot: extracts v_batt_mv/gyro_z, emits plot actions and passing assertions', () => {
    const res = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.telemetry_plot.source, makeImuPacket(), 'COM8');
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe('pass');
    const plotSeries = res.actions.filter((a) => a.kind === 'plot').map((a) => a.series);
    expect(plotSeries).toEqual(['vbatt_mv', 'gyro_abs']);
    expect(res.assertions.every((a) => a.passed === 1 && a.failed === 0)).toBe(true);
    expect(res.metrics.last_vbatt_mv).toBe('8180');
  });

  it('runs watchdog_pins on_timer across persistent locals and pulses DTR after 4 ticks', () => {
    const timerOnly = `
      local missed = 0
      bforge.on_timer(250, function()
        missed = missed + 1
        bforge.metric("watchdog_ticks", missed)
        if missed >= 4 then
          bforge.pulse_pin("DTR", 50)
          missed = 0
        end
      end)
    `;
    const locals: Record<string, number | string | boolean | null> = {};
    let lastRes = dryRunLuaScriptOffline(timerOnly, DEFAULT_TEST_FRAME_HEX, 'COM8', 'fail_open', { locals });
    expect(lastRes.actions.some((a) => a.kind === 'pulse_pin')).toBe(false);
    for (let i = 0; i < 3; i++) {
      lastRes = dryRunLuaScriptOffline(timerOnly, DEFAULT_TEST_FRAME_HEX, 'COM8', 'fail_open', { locals });
    }
    const pulse = lastRes.actions.find((a) => a.kind === 'pulse_pin');
    expect(pulse).toBeDefined();
    expect(pulse?.pin).toBe('DTR');
    expect(pulse?.delay_ms).toBe(50);
  });

  it('supports frame:drop() and return nil drop verdicts', () => {
    const dropScript = `
      bforge.on_rx_frame(function(frame)
        frame:drop()
      end)
    `;
    const res1 = dryRunLuaScriptOffline(dropScript, DEFAULT_TEST_FRAME_HEX);
    expect(res1.ok).toBe(true);
    expect(res1.verdict).toBe('drop');
    expect(res1.output_hex).toBe('');

    const nilScript = `
      bforge.on_rx_frame(function(frame)
        return nil
      end)
    `;
    const res2 = dryRunLuaScriptOffline(nilScript, DEFAULT_TEST_FRAME_HEX);
    expect(res2.ok).toBe(true);
    expect(res2.verdict).toBe('drop');
  });

  it('supports bforge.unhex and bforge.hex transformations', () => {
    const src = `
      bforge.on_rx_frame(function(frame)
        local raw = bforge.unhex(frame.hex)
        raw[1] = 0x55
        raw[2] = 0xAA
        return bforge.hex(raw)
      end)
    `;
    const res = dryRunLuaScriptOffline(src, 'AA 55 01 02');
    expect(res.ok).toBe(true);
    expect(res.mutated).toBe(true);
    expect(res.output_hex).toBe('55 AA 01 02');
    expect(res.verdict).toBe('send');
  });

  it('enforces instruction budget and sandbox restrictions against io/os/require', () => {
    const infiniteLoop = `
      bforge.on_rx_frame(function(frame)
        while true do
        end
        return frame
      end)
    `;
    const loopRes = dryRunLuaScriptOffline(infiniteLoop, DEFAULT_TEST_FRAME_HEX);
    expect(loopRes.ok).toBe(false);
    expect(loopRes.verdict).toBe('error');
    expect(loopRes.error).toMatch(/budget/i);

    const forbiddenIo = `
      bforge.on_rx_frame(function(frame)
        local f = io.open("/etc/passwd", "r")
        return frame
      end)
    `;
    const ioRes = dryRunLuaScriptOffline(forbiddenIo, DEFAULT_TEST_FRAME_HEX);
    expect(ioRes.ok).toBe(false);
    expect(ioRes.verdict).toBe('error');
    expect(ioRes.error).toMatch(/sandbox/i);
  });
});

describe('luaSandboxFallback.tutorialSeries01to15', () => {
  const TUTORIAL_FILES: Array<[keyof typeof SCRIPT_TEMPLATES, string]> = [
    ['tutorial_01', '01_packet_filter_and_metadata.lua'],
    ['tutorial_02', '02_schema_assertions_and_logging.lua'],
    ['tutorial_03', '03_derived_telemetry_plotting.lua'],
    ['tutorial_04', '04_field_patching_and_crc8.lua'],
    ['tutorial_05', '05_zero_offset_binary_surgery.lua'],
    ['tutorial_06', '06_deterministic_seu_bitflip_fuzzer.lua'],
    ['tutorial_07', '07_mitm_directional_latency_glitch.lua'],
    ['tutorial_08', '08_multi_schema_dynamic_dissect.lua'],
    ['tutorial_09', '09_packet_burst_duplication_and_split.lua'],
    ['tutorial_10', '10_virtual_device_auto_responder.lua'],
    ['tutorial_11', '11_raw_chunk_pre_framer_corruptor.lua'],
    ['tutorial_12', '12_custom_dissector_and_command_builder.lua'],
    ['tutorial_13', '13_periodic_timer_poller_and_jitter.lua'],
    ['tutorial_14', '14_hardware_pin_reset_and_alert_handler.lua'],
    ['tutorial_15', '15_fail_closed_safety_interlock_and_budget.lua'],
  ];

  const tutorialDir = resolve(__dirname, '../../../examples/tutorials');

  it('keeps SCRIPT_TEMPLATES tutorial_01..tutorial_15 identical to examples/tutorials/*.lua', () => {
    for (const [id, filename] of TUTORIAL_FILES) {
      const disk = readFileSync(resolve(tutorialDir, filename), 'utf8').replace(/\r\n/g, '\n');
      expect(SCRIPT_TEMPLATES[id].source.trimEnd(), `${id} source parity`).toBe(disk.trimEnd());
    }
  });

  it('executes every tutorial template offline without error on sample frames', () => {
    for (const [id] of TUTORIAL_FILES) {
      const res = dryRunLuaScriptOffline(
        SCRIPT_TEMPLATES[id].source,
        DEFAULT_TEST_FRAME_HEX,
        'uart0',
        id === 'tutorial_15' ? 'fail_closed' : 'fail_open',
        { name: `${id}.lua`, seqId: 42, timestampUs: 10_000 }
      );
      expect(res.ok, `${id} failed: ${res.error}`).toBe(true);
      expect(res.error, `${id} error`).toBeNull();
    }
  });

  it('tutorial 01: passes valid ImuPacket and drops malformed short frame with log & metadata', () => {
    const src = SCRIPT_TEMPLATES.tutorial_01.source;
    const passRes = dryRunLuaScriptOffline(src, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      seqId: 42,
      timestampUs: 10_000,
    });
    expect(passRes.verdict).toBe('pass');
    expect(passRes.metrics.rx_passed).toBe('1');
    expect(passRes.metrics.last_port).toBe('uart0');
    expect(passRes.metrics.last_direction).toBe('rx');
    expect(passRes.metrics.last_seq_id).toBe('42');
    expect(passRes.metrics.last_len).toBe('20');

    const dropRes = dryRunLuaScriptOffline(src, 'FF 01 02', 'uart0', 'fail_open', { seqId: 7 });
    expect(dropRes.verdict).toBe('drop');
    expect(dropRes.metrics.rx_dropped).toBe('1');
    expect(dropRes.metrics.last_dropped_hex).toBe('FF 01 02');
    expect(dropRes.actions.some((a) => a.kind === 'log' && a.level === 'warn')).toBe(true);
  });

  it('tutorial 02: checks all 3 schema assertions and triggers critical battery error log', () => {
    const src = SCRIPT_TEMPLATES.tutorial_02.source;
    const okRes = dryRunLuaScriptOffline(src, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(okRes.verdict).toBe('pass');
    expect(okRes.assertions).toHaveLength(3);
    expect(okRes.assertions.every((a) => a.passed === 1 && a.failed === 0)).toBe(true);
    expect(okRes.actions.some((a) => a.kind === 'log' && a.level === 'info')).toBe(true);

    const critBytes = parseHexBytes(DEFAULT_TEST_FRAME_HEX);
    critBytes[8] = 0x15; // 5500 mV = 0x157C
    critBytes[9] = 0x7c;
    const critRes = dryRunLuaScriptOffline(src, formatSpacedHex(critBytes), 'uart0');
    expect(critRes.assertions.find((a) => a.name === 'v_batt_nominal')?.failed).toBe(1);
    expect(critRes.actions.some((a) => a.kind === 'log' && a.level === 'error')).toBe(true);
  });

  it('tutorial 03: computes EMA and peak-to-peak across multiple frames via locals', () => {
    const src = SCRIPT_TEMPLATES.tutorial_03.source;
    const locals: Record<string, number | string | boolean | null> = {};
    let res = dryRunLuaScriptOffline(src, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      locals,
      timestampUs: 1_000,
    });
    expect(res.actions.filter((a) => a.kind === 'plot')).toHaveLength(3);

    for (const [idx, mv] of [8000, 8400, 8200].entries()) {
      const b = parseHexBytes(DEFAULT_TEST_FRAME_HEX);
      b[8] = (mv >> 8) & 0xff;
      b[9] = mv & 0xff;
      res = dryRunLuaScriptOffline(src, formatSpacedHex(b), 'uart0', 'fail_open', {
        locals,
        timestampUs: (idx + 2) * 1_000,
      });
    }
    expect(res.metrics.samples).toBe('4');
    expect(res.metrics.v_batt_p2p_mv).toBe('400');
  });

  it('tutorial 04 & 05: patch named fields / zero-offset binary layout and recalculate CRC-8', () => {
    const res04 = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.tutorial_04.source, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(res04.verdict).toBe('send');
    expect(res04.mutated).toBe(true);
    expect(
      res04.field_diffs.some((d) => d.name === 'v_batt_mv' && d.before === '8180' && d.after === '8280')
    ).toBe(true);
    const out04 = parseHexBytes(res04.output_hex);
    expect(out04[19]).toBe(crc8Atm(out04.slice(0, 19)));

    const res05 = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.tutorial_05.source, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(res05.verdict).toBe('send');
    expect(res05.mutated).toBe(true);
    expect(res05.metrics.samples_hex).toBe('80 90 A0 B0');
    expect(res05.metrics.patched_batt_mv).toBe('8130');
    const out05 = parseHexBytes(res05.output_hex);
    expect(out05[2]).toBe(2);
    expect(out05[19]).toBe(crc8Atm(out05.slice(0, 19)));
  });

  it('tutorial 06: deterministic on_init seed(42) yields bit-identical SEU corruption across runs', () => {
    const src = SCRIPT_TEMPLATES.tutorial_06.source;
    const runA = dryRunLuaScriptOffline(src, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', { name: '06a' });
    const runB = dryRunLuaScriptOffline(src, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', { name: '06b' });
    expect(runA.ok).toBe(true);
    expect(runA.mutated).toBe(true);
    expect(runA.output_hex).toBe(runB.output_hex);
    expect(runA.metrics.fuzzer_seed).toBe('42');
    expect(runA.actions.some((a) => a.kind === 'log' && a.level === 'info')).toBe(true);
  });

  it('tutorial 07 & 08: MITM direction branching and multi-schema frame:dissect', () => {
    const src07 = SCRIPT_TEMPLATES.tutorial_07.source;
    const aToB = dryRunLuaScriptOffline(src07, DEFAULT_TEST_FRAME_HEX, 'a', 'fail_open', {
      direction: 'mitm_a_to_b',
      bridge: 'obc_eps',
    });
    expect(aToB.verdict).toBe('delay');
    expect(aToB.delay_ms).toBe(45);
    expect(aToB.metrics.last_bridge).toBe('obc_eps');
    expect(aToB.metrics.a_to_b_glitched).toBe('1');
    const aBytes = parseHexBytes(aToB.output_hex);
    expect((aBytes[8] << 8) | aBytes[9]).toBe(7930);
    expect(aBytes[19]).toBe(crc8Atm(aBytes.slice(0, 19)));

    const bToA = dryRunLuaScriptOffline(src07, DEFAULT_TEST_FRAME_HEX, 'b', 'fail_open', {
      direction: 'mitm_b_to_a',
      bridge: 'obc_eps',
    });
    expect(bToA.verdict).toBe('pass');
    expect(bToA.delay_ms).toBe(0);
    expect(bToA.metrics.b_to_a_forwarded).toBe('1');

    const src08 = SCRIPT_TEMPLATES.tutorial_08.source;
    const imuRes = dryRunLuaScriptOffline(src08, DEFAULT_TEST_FRAME_HEX, 'link', 'fail_open', {
      direction: 'mitm_a_to_b',
    });
    expect(imuRes.metrics.active_schema).toBe('ImuPacket');
    expect(
      imuRes.field_diffs.some((d) => d.name === 'version' && d.before === '1' && d.after === '2')
    ).toBe(true);

    const epsBase = [0xaa, 0x55, 0x04, 10, 0, 0, 0];
    const epsCrc = crc16CcittFalse(epsBase);
    const epsHex = formatSpacedHex([...epsBase, epsCrc & 0xff, (epsCrc >> 8) & 0xff]);
    const epsRes = dryRunLuaScriptOffline(src08, epsHex, 'link', 'fail_open', {
      direction: 'mitm_a_to_b',
    });
    expect(epsRes.ok).toBe(true);
    expect(epsRes.metrics.active_schema).toBe('EpsCommand');
    expect(
      epsRes.field_diffs.some((d) => d.name === 'hold_time_s' && d.before === '10' && d.after === '25')
    ).toBe(true);
    const epsOut = parseHexBytes(epsRes.output_hex);
    const expEpsCrc = crc16CcittFalse(epsOut.slice(0, 7));
    expect([epsOut[7], epsOut[8]]).toEqual([expEpsCrc & 0xff, (expEpsCrc >> 8) & 0xff]);
  });

  it('tutorial 09 & 10: returns 4-part burst and packs string.unpack + CRC-16/MODBUS ACK reply', () => {
    const res09 = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.tutorial_09.source, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(res09.verdict).toBe('burst');
    expect(res09.burst_frames).toHaveLength(4);
    expect(res09.burst_frames[0]).toEqual({ hex: DEFAULT_TEST_FRAME_HEX, delay_ms: 0 });
    expect(res09.burst_frames[1].delay_ms).toBe(10);
    const dupBytes = parseHexBytes(res09.burst_frames[1].hex);
    const origBytes = parseHexBytes(DEFAULT_TEST_FRAME_HEX);
    expect(dupBytes[dupBytes.length - 1]).toBe(origBytes[origBytes.length - 1] ^ 0xff);
    const reassembled = [
      ...parseHexBytes(res09.burst_frames[2].hex),
      ...parseHexBytes(res09.burst_frames[3].hex),
    ];
    expect(reassembled).toEqual(origBytes);

    const res10 = dryRunLuaScriptOffline(SCRIPT_TEMPLATES.tutorial_10.source, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(res10.verdict).toBe('send');
    expect(res10.metrics.rx_flags).toBe('3');
    expect(res10.metrics.rx_channel).toBe('2');
    const sendAct = res10.actions.find((a) => a.kind === 'send');
    expect(sendAct?.port).toBe('uart0');
    expect(sendAct?.delay_ms).toBe(4);
    const ackBytes = parseHexBytes(sendAct?.hex ?? '');
    expect(ackBytes).toHaveLength(6);
    expect(ackBytes.slice(0, 4)).toEqual([0xaa, 0x55, 0x81, 0x13]);
    const expCrc = crc16Modbus(ackBytes.slice(0, 4));
    expect([ackBytes[4], ackBytes[5]]).toEqual([expCrc & 0xff, (expCrc >> 8) & 0xff]);
    expect(res10.metrics.ack_crc16).toBe(`0x${expCrc.toString(16).padStart(4, '0').toUpperCase()}`);
  });

  it('tutorial 11 & 12: pre-framer raw chunk corruption, custom add_field dissectors, and on_command XMODEM', () => {
    const src11 = SCRIPT_TEMPLATES.tutorial_11.source;
    const locals11: Record<string, number | string | boolean | null> = {};
    const c1 = dryRunLuaScriptOffline(src11, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', { locals: locals11 });
    expect(c1.metrics.last_fault).toBe('prepend_garbage');
    expect(parseHexBytes(c1.output_hex).slice(0, 2)).toEqual([0x00, 0xff]);
    const c2 = dryRunLuaScriptOffline(src11, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', { locals: locals11 });
    expect(c2.metrics.last_fault).toBe('truncate_half');
    expect(parseHexBytes(c2.output_hex)).toHaveLength(10);

    const src12 = SCRIPT_TEMPLATES.tutorial_12.source;
    const defaultDissect = dryRunLuaScriptOffline(src12, DEFAULT_TEST_FRAME_HEX, 'uart0');
    expect(defaultDissect.metrics.custom_dissected).toBe('1');
    expect(defaultDissect.field_diffs.some((d) => d.name === 'wire_sync' && d.after === '0xAA55')).toBe(true);
    expect(defaultDissect.field_diffs.some((d) => d.name === 'batt_volts' && d.after === '8.180 V')).toBe(true);
    expect(defaultDissect.field_diffs.some((d) => d.name === 'tail_crc8' && d.after === 'CRC_ERR(0x5B)')).toBe(true);

    const validCrcBytes = parseHexBytes(DEFAULT_TEST_FRAME_HEX);
    validCrcBytes[19] = crc8Atm(validCrcBytes.slice(0, 19));
    const validDissect = dryRunLuaScriptOffline(src12, formatSpacedHex(validCrcBytes), 'uart0');
    expect(validDissect.field_diffs.some((d) => d.name === 'tail_crc8' && d.after === 'CRC_OK')).toBe(true);

    const cmdRes = dryRunLuaScriptOffline(src12, '', 'uart0', 'fail_open', {
      hook: 'on_command',
      commandName: 'set_heater',
      commandArgs: { zone: '2', duty: '75', enable: '1' },
    });
    expect(cmdRes.ok).toBe(true);
    const cmdBytes = parseHexBytes(cmdRes.output_hex);
    expect(cmdBytes.slice(0, 6)).toEqual([0xaa, 0x55, 0x31, 2, 1, 75]);
    const expXmodem = crc16Xmodem(cmdBytes.slice(0, 6));
    expect([cmdBytes[6], cmdBytes[7]]).toEqual([expXmodem & 0xff, (expXmodem >> 8) & 0xff]);
  });

  it('tutorial 13, 14 & 15: timer jitter plotter, alert pin sequence, and short-circuit fail-closed interlock', () => {
    const src13 = SCRIPT_TEMPLATES.tutorial_13.source;
    const timerRes = dryRunLuaScriptOffline(src13, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      hook: 'on_timer',
      timestampUs: 100_000,
    });
    const pollSend = timerRes.actions.find((a) => a.kind === 'send');
    expect(pollSend?.port).toBe('*');
    const pollBytes = parseHexBytes(pollSend?.hex ?? '');
    expect(pollBytes).toHaveLength(5);
    expect(pollBytes[4]).toBe(crc8Atm(pollBytes.slice(0, 4)));

    const locals13: Record<string, number | string | boolean | null> = {};
    let rxRes = dryRunLuaScriptOffline(src13, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      locals: locals13,
      timestampUs: 10_000,
    });
    rxRes = dryRunLuaScriptOffline(src13, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      locals: locals13,
      timestampUs: 20_500,
    });
    rxRes = dryRunLuaScriptOffline(src13, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      locals: locals13,
      timestampUs: 30_000,
    });
    expect(rxRes.metrics.last_jitter_us).toBe('1000');
    expect(rxRes.actions.some((a) => a.kind === 'plot' && a.series === 'rx_jitter_us' && a.value === 1000)).toBe(true);

    const src14 = SCRIPT_TEMPLATES.tutorial_14.source;
    const alertRes = dryRunLuaScriptOffline(src14, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_open', {
      hook: 'on_alert',
      alertName: 'dead_man_timer',
      alertDetail: 'silence > 2000ms',
      timestampUs: 55_000,
    });
    expect(alertRes.ok).toBe(true);
    expect(alertRes.metrics.mcu_resets).toBe('1');
    expect(alertRes.actions.some((a) => a.kind === 'set_pins' && a.dtr === true && a.rts === false)).toBe(true);
    expect(alertRes.actions.some((a) => a.kind === 'pulse_pin' && a.pin === 'RTS' && a.delay_ms === 25)).toBe(true);
    expect(alertRes.actions.some((a) => a.kind === 'set_pins' && a.dtr === false && a.rts === false)).toBe(true);

    const src15 = SCRIPT_TEMPLATES.tutorial_15.source;
    const safeRes = dryRunLuaScriptOffline(src15, DEFAULT_TEST_FRAME_HEX, 'uart0', 'fail_closed');
    expect(safeRes.ok).toBe(true);
    expect(safeRes.verdict).toBe('pass');
    expect(safeRes.metrics.interlock_state).toBe('OK');

    const shortDrop = dryRunLuaScriptOffline(src15, '01 02', 'uart0', 'fail_closed');
    expect(shortDrop.ok).toBe(true);
    expect(shortDrop.verdict).toBe('drop');
    expect(shortDrop.metrics.interlock_state).toBe('TRIPPED');
  });
});
