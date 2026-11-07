// @vitest-environment jsdom
// Global renderer error handlers: every unhandled exception and rejection
// must reach the activity ring, or a broken workbench leaves no trace.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installGlobalErrorHandlers } from './globalErrors';
import { logAction } from './activityLog';

vi.mock('./activityLog', () => ({ logAction: vi.fn() }));

/** jsdom has no `PromiseRejectionEvent`; the handler only reads `.reason`. */
function reject(reason: unknown): void {
  window.dispatchEvent(
    Object.assign(new Event('unhandledrejection'), { reason })
  );
}

// jsdom re-reports a dispatched ErrorEvent asynchronously, so a stray extra
// call can arrive a tick later; assertions are order- and count-independent.
describe('installGlobalErrorHandlers', () => {
  beforeEach(() => {
    vi.mocked(logAction).mockClear();
    installGlobalErrorHandlers();
  });

  it('reports an unhandled exception with its stack', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('boom') }));

    expect(logAction).toHaveBeenCalledWith(
      'ui_exception',
      expect.stringContaining('boom'),
      'error'
    );
  });

  it('reports an unhandled promise rejection', () => {
    reject(new Error('nope'));

    expect(logAction).toHaveBeenCalledWith(
      'ui_rejection',
      expect.stringContaining('nope'),
      'error'
    );
  });

  it('describes non-Error reasons as text', () => {
    reject('plain string');

    expect(logAction).toHaveBeenCalledWith('ui_rejection', 'plain string', 'error');
  });

  it('ignores resource load failures, which carry no error object', async () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'script failed' }));
    // Let any delayed re-report from an earlier dispatch land first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logAction).not.toHaveBeenCalled();
  });
});
