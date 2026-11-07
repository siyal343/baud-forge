# Packet Stream

The Packet Stream is the live view of everything on the wire. Every frame the engine receives or transmits appears here as a row: sequence number, delta time since the previous frame, wall-clock time, direction, port, length, protocol and the decoded summary.

![Packet Stream with live decoded frames](img/overview.png)

## Reading a row

| Column | Meaning |
|---|---|
| **SEQ** | Monotonic frame number (`#00019`). Click a row to select the frame everywhere — dissector, hex view, scope cursor. |
| **DELTA T** | Microseconds since the previous frame **on that port** — your inter-frame gap. |
| **TIME** | Wall-clock arrival time (`HH:MM:SS.mmm`). |
| **DIR** | `RX` (device → you), `TX` (you → device), `A->B`/`B->A` (bridge forwarding), `FAULT` (fault-injected or damaged frame). |
| **PORT** | The workspace port id the frame arrived on (`esp`, `obc`, …). |
| **LEN** | Payload length in bytes. |
| **PROTOCOL** | The dissector tag that decoded it, e.g. `C_STRUCT:ImuPacket`. |
| **SUMMARY** | Decoded field summary, printable text, or the raw payload for undecoded frames. |

A green dot next to the protocol means the frame's checksum validated; a red-tinted row means the frame carried an error (`ERR: …` summary).

## Filters

- **Text filter** — press `/` anywhere in the workbench to focus it. Matches port, protocol, summary and hex. `Esc` clears it; `Ctrl+L` clears the stream.
- **Direction chips** — `ALL`, `RX`, `TX`, `FAULT` — show only what you care about.
- **Port select** — with a multi-port workspace (or a bridge), pick one port or `ALL PORTS`.
- **ERRORS** — only frames that failed to decode or failed their checksum.
- **AUTO ON/OFF** — follow-the-tail. When you scroll up to study history, following pauses and a badge counts the frames you are missing; press **LIVE SNAP** (or scroll back to the bottom) to resume.

## Selecting frames

Click any row. The selection drives the whole workbench: the Protocol Dissector shows that frame's fields, the Hex Inspector highlights its bytes, and — with cursor mode OFF on the oscilloscope — the scope snaps its cursor to that frame's timestamp (see [Workflow B](oscilloscope.html#scope-click-sync-workflow-b)).

Arrow keys step the selection while the stream is paused; `Space` pauses/resumes the live capture.

## Virtualization

The stream renders only the visible window (plus a small overscan), so it stays smooth at hundreds of frames per second with a 10,000-frame buffer. The header shows which slice you are looking at: `ROWS 9862–9895 OF 10000`.

## Exporting what you see

The stream toolbar's export button offers **CSV**, **Saleae CSV**, **JSONL** and **PCAPNG** of the packets currently in the buffer (filters apply). See [Exports](exports.html) for the exact formats.

## Column widths

Drag the header separators to resize any column; double-click a separator to reset it. Layouts persist per browser.

## Tips

- Frames bypass nothing: what you see is what the wire carried, including bridge-forwarded bytes (shown as `TX` rows on the destination port) and fault-injected transmissions.
- The buffer holds the last 10,000 frames. Record with [REC](rec-vaults.html) if you need the whole session — the vault keeps everything.
