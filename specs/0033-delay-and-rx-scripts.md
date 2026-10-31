# 0033 Latency on the wire, and scripts on what arrives

Status: accepted (31 October 2026). Closes D-66 and D-84.

## Problem

A fault injector that can only corrupt bytes is half a rig. FR-FLT-01 also asks for
jitter and latency up to 5 s, and FR-SCR-01's receive side is the case a developer
actually meets: "the device sent something my host decoded wrongly — make the host see
what I think it saw". Neither existed: the injector wrote immediately, and the script
hook was wired to the transmit path only.

## Scope

A fixed delay in the fault profile, held by the reader, and a Lua hook on arriving
bytes before framing. Not in this stage: a random jitter span (D-91), a delay that
survives a reconnect, and scripts that can read decoded fields on the receive side
(still D-83).

## Behavior

### Delay

1. `POST /api/fault {"kind":"delay","delay_ms":300}` arms a hold of 0 to 5000 ms.
   `jitter_ms` adds a draw inside a span on top of the base, from the profile's seed, so
   arrival times vary instead of repeating one number.
2. The **reader** holds the write until its deadline, so a delayed frame never blocks
   the read path and never stalls the pump.
3. The send answers at once with `"delay_ms"` in the reply: the frame was accepted, not
   delivered. A send that waits would be a different promise.
4. On shutdown, frames still held are counted as failed and any waiting caller is told
   the session stopped.
5. Bound: the hold list is per port and grows only with the frames a caller posts.

### Receive script

1. A workspace may name `rx_script_path`. The hook sees the bytes a port received,
   **before** the vault and the decoder, and returns the bytes to decode or nil to drop
   the chunk.
2. The same sandbox applies: no `io`, no `os`, no clock, 200 000 instructions per call.
   A failing call passes the bytes through unchanged and is counted.
3. The vault records what the script produced, because that is what the engine decoded.
   A session with a receive script is not a faithful tap, and the setting says so.
4. `enable_rx_script` is separate from `enable_script`: a workspace can run both, one on
   each direction.

## Data

`FaultProfile.delay_ms: u16`; `FaultOutcome.delay: Option<Duration>`; `WriteRequest.due:
Option<Instant>`; `Session.rx_script`, `Session.chunks_received_dropped`.

## Measured

```text
delay_ms 40, jitter_ms 0        -> every frame held 40 ms
delay_ms 0, jitter_ms 40, seed 9 -> eight sends reported eight holds inside 0..=40,
                                    not all the same
same seed                        -> the same sequence of holds
```

```text
delay 300 ms, POST /api/send "01 02 03"
  reply in < 150 ms, with {"sent":3,"delay_ms":300}
  device received 01 02 03 after >= 250 ms

rx script that uppercases ASCII, device sends "hello 7\n"
  decoded frame text: "HELLO 7"
```

Ten serve tests, 259 in the workspace.

## Test

```sh
cargo test -p bforge-core --test serve
```

## Limits, recorded

- Jitter is a uniform draw inside the span, not a distribution a user can shape.
- A held frame does not survive a reconnect: it is failed and counted.
- A receive script makes the vault a record of what the engine decoded, not of what the
  device sent; a passive tap should not use one.
