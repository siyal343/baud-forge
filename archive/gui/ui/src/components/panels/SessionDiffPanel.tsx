import { Show } from 'solid-js'
import type { WorkbenchStore } from '../../lib/store'

export function SessionDiffPanel(props: { store: WorkbenchStore }) {
  const { store } = props

  function handleDiff(e: Event) {
    e.preventDefault()
    void store.runDiff()
  }

  function handleFileSelect(slot: 'a' | 'b', e: Event) {
    const target = e.currentTarget as HTMLInputElement
    const file = target.files?.[0]
    if (!file) return
    if (slot === 'a') {
      store.setDiffPathA(file.name)
    } else {
      store.setDiffPathB(file.name)
    }
    target.value = ''
  }

  function loadDemoRegression() {
    store.setDiffPathA('sessions/golden-baseline-flight.bflog')
    store.setDiffPathB('sessions/candidate-regression-flight.bflog')
    store.setDiffReport({
      records_a: 1420,
      records_b: 1418,
      frames_a: 1420,
      frames_b: 1418,
      identical: false,
      first_divergence: {
        index: 842,
        port: 'COM3',
        reason: 'Field value divergence: motor_temp +4.8°C exceeds tolerance',
        timestamp_us_a: 8420000,
        timestamp_us_b: 8421850,
        field_diffs: [
          {
            frame_index: 842,
            port: 'COM3',
            field_name: 'motor_temp',
            value_a: '48.2',
            value_b: '53.0',
          },
        ],
      },
      changed_fields: [
        {
          frame_index: 842,
          port: 'COM3',
          field_name: 'motor_temp',
          value_a: '48.2',
          value_b: '53.0',
        },
        {
          frame_index: 843,
          port: 'COM3',
          field_name: 'phase_current',
          value_a: '18.4',
          value_b: '22.1',
        },
      ],
      missing_from_a: 0,
      missing_from_b: 2,
    })
  }

  function resetDiff() {
    store.setDiffReport(null)
  }

  return (
    <div class="panel-content diff-panel-content">
      <form class="diff-form" onSubmit={handleDiff}>
        <span class="diff-title">diff</span>
        <input
          class="diff-input"
          value={store.diffPathA()}
          onInput={(event) => store.setDiffPathA(event.currentTarget.value)}
          placeholder={store.session()?.vault ? `a: ${store.session()!.vault}` : 'vault a (defaults to active)'}
          title="vault a path (leave blank to use active session vault)"
        />
        <span class="diff-sep">vs</span>
        <input
          class="diff-input"
          value={store.diffPathB()}
          onInput={(event) => store.setDiffPathB(event.currentTarget.value)}
          placeholder="vault b path (required)"
          title="comparison vault b path"
          required
        />
        <button type="submit" class="chip action" disabled={store.diffLoading() || !store.diffPathB().trim()}>
          {store.diffLoading() ? 'comparing…' : 'compare'}
        </button>
      </form>
      <Show when={store.diffError()}>
        {(err) => <p class="diff-error">diff error: {err()}</p>}
      </Show>
      <Show
        when={store.diffReport()}
        fallback={
          <div class="diff-zero-state">
            <div class="diff-zero-card">
              <div class="diff-header">
                <span class="diff-badge">REGRESSION AUDITING</span>
                <h3 class="diff-title-hero">Semantic Session Regression Diff</h3>
                <p class="diff-desc">
                  Compare two .bflog recordings to identify field-by-field divergence, dropped packets, and timing drift.
                </p>
              </div>

              {/* Dual File Picker Slots */}
              <div class="diff-slots-grid">
                {/* Vault A Slot */}
                <div class="diff-slot">
                  <div class="diff-slot-header">
                    <span class="slot-tag tag-a">VAULT A</span>
                    <span class="slot-role">Golden Baseline</span>
                  </div>
                  <div class="diff-slot-body">
                    <span class="slot-path text-mono" title={store.diffPathA() || store.session()?.vault || 'Active session or .bflog'}>
                      {store.diffPathA() || store.session()?.vault || 'Select baseline recording (.bflog)…'}
                    </span>
                    <label class="diff-slot-btn">
                      <span>Browse…</span>
                      <input
                        type="file"
                        accept=".bflog"
                        onChange={(e) => handleFileSelect('a', e)}
                        class="sr-only"
                        aria-label="Upload Vault A file"
                      />
                    </label>
                  </div>
                </div>

                {/* Vault B Slot */}
                <div class="diff-slot">
                  <div class="diff-slot-header">
                    <span class="slot-tag tag-b">VAULT B</span>
                    <span class="slot-role">Regression Candidate</span>
                  </div>
                  <div class="diff-slot-body">
                    <span class="slot-path text-mono" title={store.diffPathB() || 'Candidate .bflog file'}>
                      {store.diffPathB() || 'Select candidate recording (.bflog)…'}
                    </span>
                    <label class="diff-slot-btn">
                      <span>Browse…</span>
                      <input
                        type="file"
                        accept=".bflog"
                        onChange={(e) => handleFileSelect('b', e)}
                        class="sr-only"
                        aria-label="Upload Vault B file"
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div class="diff-action-bar">
                <button
                  type="button"
                  class="btn-action"
                  onClick={loadDemoRegression}
                >
                  Load Demo Regression
                </button>
                <Show when={store.diffPathA() && store.diffPathB()}>
                  <button
                    type="button"
                    class="chip action"
                    onClick={() => void store.runDiff()}
                    disabled={store.diffLoading()}
                  >
                    {store.diffLoading() ? 'comparing…' : 'Run Diff'}
                  </button>
                </Show>
              </div>
            </div>
          </div>
        }
      >
        {(report) => (
          <div class="diff-report">
            <div class="diff-summary">
              <Show
                when={report().identical}
                fallback={<span class="chip fault">diverged</span>}
              >
                <span class="chip live">identical</span>
              </Show>
              <span class="hint">
                records: {report().records_a} vs {report().records_b} · frames: {report().frames_a} vs {report().frames_b}
                <Show when={report().missing_from_a > 0}>
                  {` · missing in a: ${report().missing_from_a}`}
                </Show>
                <Show when={report().missing_from_b > 0}>
                  {` · missing in b: ${report().missing_from_b}`}
                </Show>
              </span>
              <button
                type="button"
                class="chip action diff-reset-btn"
                onClick={resetDiff}
                title="Reset comparison and choose new files"
              >
                reset diff
              </button>
            </div>
            <Show when={!report().identical && report().first_divergence}>
              {(div) => (
                <div class="divergence-banner">
                  <span class="div-index">Frame #{div().index}</span>
                  <span class="div-reason">{div().reason}</span>
                  <span class="div-time">
                    Δt: {((div().timestamp_us_b - div().timestamp_us_a) / 1000).toFixed(2)} ms
                  </span>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
