import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineApiClient } from './engineApi';
import { DEFAULT_TEST_FRAME_HEX, SCRIPT_TEMPLATES } from './luaSandboxFallback';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('EngineApiClient /api/script methods', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes through live engine 200 responses with offline: false', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (!init?.method || init.method === 'GET') {
        return jsonResponse({
          ok: true,
          source: '-- live script',
          status: {
            armed: true,
            name: 'live.lua',
            policy: 'fail_open',
            hooks: ['on_rx_frame'],
            invocations: 5,
            changed: 2,
            dropped: 0,
            delayed: 0,
            injected_tx: 0,
            failures: 0,
            logs_suppressed: 0,
            assertions_passed: 5,
            assertions_failed: 0,
            memory_bytes: 32000,
            memory_limit_bytes: 4194304,
            last_instructions: 140,
            last_exec_us: 12,
            max_exec_us: 19,
            last_error: null,
            metrics: { hits: '2' },
            assertions: [],
          },
        });
      }
      if (payload.action === 'compile') {
        return jsonResponse({ ok: true, hooks: ['on_rx_frame'], error: null });
      }
      if (payload.action === 'test_frame') {
        return jsonResponse({
          ok: true,
          verdict: 'send',
          mutated: true,
          input_hex: payload.hex,
          output_hex: 'AA 55 00',
          delay_ms: 0,
          burst_frames: [],
          field_diffs: [{ name: 'version', before: '1', after: '0' }],
          instructions: 95,
          exec_us: 8,
          memory_bytes: 31000,
          actions: [],
          metrics: { live: 'yes' },
          assertions: [],
          error: null,
        });
      }
      return jsonResponse({ ok: true, status: { armed: payload.action === 'arm' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = new EngineApiClient('http://127.0.0.1:7717');
    const st = await api.getScriptStatus();
    expect(st.ok).toBe(true);
    expect(st.offline).toBe(false);
    expect(st.status?.name).toBe('live.lua');

    const comp = await api.scriptCompile(SCRIPT_TEMPLATES.seu_bitflip.source, 'seu.lua');
    expect(comp.ok).toBe(true);
    expect(comp.offline).toBe(false);
    expect(comp.hooks).toEqual(['on_rx_frame']);

    const dry = await api.scriptTestFrame({
      source: SCRIPT_TEMPLATES.seu_bitflip.source,
      hex: DEFAULT_TEST_FRAME_HEX,
    });
    expect(dry.ok).toBe(true);
    expect(dry.offline).toBe(false);
    expect(dry.output_hex).toBe('AA 55 00');
    expect(dry.metrics.live).toBe('yes');
  });

  it('never fakes success via offline fallback when live engine returns HTTP 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: "syntax error near 'end' (engine)" }, 400))
    );

    const api = new EngineApiClient('http://127.0.0.1:7717');
    const comp = await api.scriptCompile(SCRIPT_TEMPLATES.seu_bitflip.source, 'seu.lua');
    expect(comp.ok).toBe(false);
    expect(comp.offline).toBe(false);
    expect(comp.error).toContain("syntax error near 'end' (engine)");

    const dry = await api.scriptTestFrame({
      source: SCRIPT_TEMPLATES.seu_bitflip.source,
      hex: DEFAULT_TEST_FRAME_HEX,
    });
    expect(dry.ok).toBe(false);
    expect(dry.offline).toBe(false);
    expect(dry.verdict).toBe('error');
    expect(dry.error).toContain("syntax error near 'end' (engine)");

    const arm = await api.scriptArm({
      source: SCRIPT_TEMPLATES.seu_bitflip.source,
      name: 'seu.lua',
    });
    expect(arm.ok).toBe(false);
    expect(arm.offline).toBe(false);
  });

  it('falls back to offline simulator cleanly on network failure and HTTP 502/503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const api = new EngineApiClient('http://127.0.0.1:7717');
    const compNet = await api.scriptCompile(SCRIPT_TEMPLATES.seu_bitflip.source, 'seu.lua');
    expect(compNet.ok).toBe(true);
    expect(compNet.offline).toBe(true);
    expect(compNet.hooks).toContain('on_rx_frame');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    );

    const dry502 = await api.scriptTestFrame({
      source: SCRIPT_TEMPLATES.seu_bitflip.source,
      hex: DEFAULT_TEST_FRAME_HEX,
      port: 'COM8',
    });
    expect(dry502.ok).toBe(true);
    expect(dry502.offline).toBe(true);
    expect(dry502.mutated).toBe(true);

    const arm502 = await api.scriptArm({
      source: SCRIPT_TEMPLATES.seu_bitflip.source,
      name: 'seu.lua',
      policy: 'fail_closed',
    });
    expect(arm502.ok).toBe(true);
    expect(arm502.offline).toBe(true);
    expect(arm502.status?.armed).toBe(true);
    expect(arm502.status?.policy).toBe('fail_closed');
  });
});
