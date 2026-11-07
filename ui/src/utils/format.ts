import { useSettingsStore } from '../store/useSettingsStore';

/**
 * Stream Time column formatter, shared by the live engine frame mapper and
 * the simulation generator (both used to build wall-clock strings inline).
 *
 * Base comes from the settings store at format time, so the next packet after
 * a Settings change already reflects it — no re-render plumbing needed.
 */

// Anchor for session-relative stamps: the first frame formatted after load.
let sessionStartMs: number | null = null;

/** `MM:SS.mmm`, rolling to `H:MM:SS.mmm` past an hour. */
export const formatRelativeElapsed = (elapsedMs: number): string => {
  const totalMs = Math.max(0, elapsedMs);
  const ms = Math.floor(totalMs % 1000);
  const totalSecs = Math.floor(totalMs / 1000);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const core = `${pad(mins)}:${pad(secs)}.${String(ms).padStart(3, '0')}`;
  return hours > 0 ? `${hours}:${core}` : core;
};

export const formatPacketTime = (d: Date): string => {
  const base = useSettingsStore.getState().settings.timestampBase;
  if (base === 'wall') {
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  if (sessionStartMs === null) sessionStartMs = d.getTime();
  return formatRelativeElapsed(d.getTime() - sessionStartMs);
};
