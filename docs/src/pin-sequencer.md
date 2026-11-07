# Pin Sequencer & Modem Lines

The Pin Sequencer drives the serial control lines — DTR and RTS — singly or as timed sequences, for exactly the moments a firmware engineer needs them: resetting a target, kicking it into a bootloader, glitch-testing brown-out handling.

![The pin sequencer with a bootloader sequence](img/pin-sequencer.png)

## Driving the lines

- **DTR LINE / RTS LINE** chips toggle each line between `ASSERTED (HIGH)` and `DEASSERTED (LOW)` immediately. The ribbon's `DTR:0 RTS:0` readout mirrors the current state.
- Line state is what **this session drove** — the panel reports what you set, not what the far end interprets.

## Presets

Two ready-made sequences cover the classic bring-up flows:

- **ESP32 ROM BOOTLOADER** — enters the ESP32's download mode: reset while IO0 held, then release into the bootloader.
- **STM32 NRST PIN RESET** — a clean NRST pulse via the control lines.

Clicking a preset loads its steps into the table; tweak timings and states before running.

## Timed sequences

The step table runs top to bottom:

| Column | Meaning |
|---|---|
| **STEP** | Order in the sequence. `↑ ↓` reorder a step; `DEL` removes it. |
| **DTR / RTS STATE** | `LOW (0)` or `HIGH (1)` — the level held during this step. |
| **WAIT TIME** | Milliseconds to hold before moving to the next step. |
| **DESCRIPTION** | Free text (e.g. "Assert Target Chip Reset"). |

**ADD TRANSITION STEP** appends a row. **EXECUTE TIMED SEQUENCE** runs the whole table against the selected port — each step is a real pin write followed by the wait.

## How it works under the hood

Pin writes go to the engine (`POST /api/pins`), which drives the OS serial control lines. On a socket transport (TCP/UDP) pins are not supported and the panel reports that honestly — pins are a serial-port instrument.

## Tips

- A **100ms RESET PULSE** preset (assert, wait 100 ms, deassert) is the quickest "did the firmware survive?" button.
- Combine with the [Yield port](troubleshooting.html#yielding-the-port) feature when an external flasher needs exclusive access to the same port.
