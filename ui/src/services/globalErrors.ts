// Last-resort crash reporting for the renderer (spec: activity log system).
//
// An unhandled exception or rejected promise means the workbench broke in a
// way no button click reveals. Both land in the engine's activity ring — and
// from there into `<vault>.activity.jsonl`, or into the crash report if the
// process itself dies — even when nobody has the browser console open.

import { logAction } from './activityLog';

/** Describe anything the handlers receive in the most informative short form. */
function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack || reason.message;
  return String(reason ?? 'unknown');
}

/**
 * Install `error` and `unhandledrejection` listeners. Call once at startup;
 * every handler is fire-and-forget (logAction swallows its own failures), so
 * a reporting failure can never break the app further.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    // Resource load failures (a missing image, a blocked script) arrive here
    // with no error object; they are noise, not a broken workbench.
    if (!event.error) return;
    logAction('ui_exception', describe(event.error), 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    logAction('ui_rejection', describe(event.reason), 'error');
  });
}
