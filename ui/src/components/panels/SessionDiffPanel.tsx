import { Show } from 'solid-js'
import type { WorkbenchStore } from '../../lib/store'

export function SessionDiffPanel(props: { store: WorkbenchStore }) {
  const { store } = props

  function handleDiff(e: Event) {
    e.preventDefault()
    void store.runDiff()
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
      <Show when={store.diffReport()}>
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
