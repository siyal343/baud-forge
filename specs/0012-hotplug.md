# 0012 Hotplug and reconnect

Status: accepted (28 October 2026). Implements F1.2.5.

## Problem

A USB cable moves. Sometimes a person pulls it, sometimes a hub browns out,
sometimes a flash tool takes the port. A recorder that treats the first read error
as fatal loses the session, and a tool that reopens on every error spins. The port
must come back on its own, quickly enough to look continuous, and the UI must say
what happened.

## Scope

Classifying a disconnect, reopening the port from the reader thread, the state the
snapshot reports, and the event that announces a transition. Not in this stage:
reopening by USB identity when the device returns on a different COM number
(D-49), and the yield flow, which releases the port on purpose (D-09).

## Behavior

1. An I/O error that means the device left the bus is classified as
   `Disconnected`. Windows reports an unplug as a bad command, a general failure, a
   missing file or an access denial depending on the driver and the moment; all of
   those map to the same thing. A read timeout is idle time and still returns 0.
2. The reader owns the handle, so the reader reopens it. The caller never sees a
   disconnect as a session error.
3. On a disconnect: close, publish `reconnecting`, count it, then poll.
4. The poll is 2 ms for the first second, then 5 ms. A cable is usually plugged
   straight back in; a port that stays away for a minute should not spin a core.
5. The attempt budget is cumulative since the last byte, not per disconnect. A port
   that opens and fails again immediately still gives up after 1 200 attempts
   (12 s at the slow poll), and the reader then stops with the state `closed`.
6. When a reopen succeeds, the state returns to `open`, `last_open_ms` records the
   open call, and `last_reconnect_ms` records how long the port was away.
7. `PortView.state` in the contract comes from the pipeline. Before this stage it
   was hard-coded to `open`, which was a lie the moment a cable moved.
8. A `port_state_changed` event carries every transition to a subscriber, so the
   ribbon can show a yield, a reconnect or a give-up without polling.

## Data

New in `PipelineStats`: `state` (`closed`, `open`, `reconnecting`, `yielded`),
`reconnects`, `last_reconnect_ms`, `last_open_ms`.

New event: `port_state_changed { at_ms, port, state }`.

## Measured

Three runs, ESP32-C3 on COM8, USB unplugged and plugged back in by the user.
`away` is the time the port was missing, which includes the person's pause; `open`
is the reopen call alone.

| Run | Detection after last byte | Away | Reopen call | Data resumed |
| --- | --- | --- | --- | --- |
| 1 | 47.1 ms | 6 097 ms | not separated | yes, same session |
| 2 | 16.8 ms | 7 145 ms | not separated | yes, same session |
| 3 | 24.9 ms | 13 366 ms | 1 ms | yes, same session |

Run 3 transcript:

```text
105699.6 ms  state -> reconnecting  reconnects 1  ...  read errors 1
105699.6 ms  data was quiet for 24.9 ms before the port left
119067.2 ms  state -> open          reconnects 1  away 13366 ms  open 1 ms
```

Detection is bounded by the 50 ms read timeout and was 17 to 47 ms in practice.
The reopen call takes 1 ms. With the 5 ms slow poll, a re-enumerated port is
usable again within **poll plus open, at most 6 ms**, which is inside the 10 ms
requirement. That figure is a derivation from two measured parts; the instant of
re-enumeration itself is not observed directly, which is D-48.

Every run resumed in the same session with one reconnect and one read error, so a
cable move costs the outage and nothing else.

## Test

```sh
cargo test -p bforge-core --test reconnect
```

Three deterministic tests with a fake transport: the reader reopens and data
resumes; the state reports `reconnecting` and then `closed` when the port stays
away, with the transition visible to a poller; and a healthy port reports no
reconnect and no read errors.

The hardware runs are the fourth test, and the one that found the first design
mistake: the attempt budget was per disconnect, so a port that opened and failed
again immediately looped forever. The budget is now cumulative since the last
byte, and `the_state_says_reconnecting_while_the_port_is_away` holds that line.
