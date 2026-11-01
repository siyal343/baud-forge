# 0043 Playback

Status: accepted (1 November 2026). Closes D-105.

## Problem

The timeline dragged. To watch a recording pass, a person had to hold the slider and move it
by hand, which is not what a DVR does and not what the guide's band 3B describes.

## Scope

A transport that advances the window through the recording at a chosen rate, with the plot
and the log following. Not in this stage: frame-by-frame stepping, loop, or playback of the
live session (the vault grows while it plays, which the span refresh already handles).

## Behavior

1. **▶ / ⏸** in the timeline. Playing starts at the current position, or at the beginning
   when the position is the end.
2. **Rate** cycles `1x → 2x → 4x`; changing it mid-play continues from where it is.
3. The playhead advances on a 60 ms clock; a vault window is fetched every 300 ms, because
   that is what a person can read and anything faster is work for nothing.
4. Reaching the end stops playback and lands on the last record.
5. **live** stops playback and returns to the stream.
6. `?play=1` (or `--query "play=1"` on the shell) starts playback once at least ten seconds
   have been recorded, so a shortcut can open a session in motion.

## Measured

Two captures six seconds apart, same run:

```text
capture 1   ⏸   1x   5.712 s / 12.2 s
capture 2   ▶   1x   12.151 s / 12.2 s
```

The first shows it playing mid-recording, the second that it stopped on the last record. The
plot, the lane and the table followed: each fetch replaces the window, and the traces read
the window while the timeline is not live.

## Test

```sh
cd ui && npm run build
cargo build -p bforge-gui
```

Verified by running the application with `--query "play=1"` and capturing the window twice;
there is no automated harness for wall-clock behaviour in the webview (spec 0029).

## Limits, recorded

- No frame-by-frame stepping, no loop, no reverse.
- The rate applies to wall-clock time; a 4x playback still fetches every 300 ms, so the
  visible window jumps in larger steps than at 1x.
- Playback reads the vault, not the live stream: pressing play while live records nothing
  new, it walks what is already on disk.
