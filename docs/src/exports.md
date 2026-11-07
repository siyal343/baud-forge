# Exports

BaudForge gets your data out in the formats the rest of your toolchain speaks — from spreadsheets to Wireshark to logic-analyzer software.

## Stream exports (Packet Stream toolbar)

Export the packets currently in the buffer (active filters apply):

| Format | What it is | Who opens it |
|---|---|---|
| **CSV** | `seq, timestamp_ns, seconds, port, direction, line_state, length, hex, text` — printable text quoted properly | Excel, Python (pandas), any diff tool |
| **Saleae CSV** | `Time [s], value, parity, error` — one row per byte, baud-aware spacing | Logic-analyzer workflows and comparisons |
| **JSONL** | One JSON object per line with hex + text | Scripted pipelines, jq, log shippers |
| **PCAPNG** | LinkType 147 (USER0) enhanced packet blocks, microsecond timestamps, port/direction in the payload header | Wireshark — dissect alongside real captures |

Timestamps are preserved at full resolution (`timestamp_ns`); the Saleae export spaces bytes by the configured baud rate so timing lines up with a real logic-analyzer capture of the same link.

## Vault export (engine-side)

The ribbon's **EXPORT** button writes a sealed vault beside itself in a portable format (the engine converts, then reports where the file went) — a review window has no download shelf, so the file is written where the vault lives.

## What exports contain

- **Everything the wire carried** — RX and TX rows alike, including bridge-forwarded traffic and fault-injected transmissions, exactly as shown in the stream.
- **Raw payload hex** per row plus the printable-ASCII rendering, so no tooling has to guess encodings.

## Tips

- PCAPNG + Wireshark is the fastest way to get a second opinion on timing from someone who does not have BaudForge.
- JSONL of a [REC vault](rec-vaults.html) plus its `<vault>.activity.jsonl` audit trail is a complete, replayable bug report.
