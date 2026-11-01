# 0044 Export

Status: accepted (1 November 2026). Closes the missing half of FR-STO-02.

## Problem

Nothing could get a capture out of the tool. A person could record, scrub, plot and assert a
session, and then had no way to put the bytes in a spreadsheet, in Wireshark, or beside a logic
analyser trace. `ExportFormat` had existed as an enum since the storage crate was written, with
no implementation behind it.

## Scope

Five formats over a whole vault, in one forward pass:

| Format | Shape |
| --- | --- |
| `csv` | one row per record: seq, timestamp, seconds, port, direction, line state, length, hex, text |
| `jsonl` | the same fields as one object per line |
| `saleae` | `Time [s], value, parity, error`, the columns Saleae's asynchronous serial analyser writes |
| `pcapng` | a Wireshark section and interface, one enhanced packet block per record |
| `parquet` | refused by name, because nothing needs it yet |

Three ways to reach it: the CLI, a route on the engine, and a control in the window's ribbon.

## Behaviour

1. `bforge export <vault> --format csv|jsonl|saleae|pcapng [--out <file>]`. The format defaults
   to `csv` and the output name to the vault's stem with the format's extension.
2. Records stream in batches of 512, so a long capture is never held in memory.
3. Text columns keep printable ASCII and show every other byte as a dot, so one record stays
   one CSV row. JSON has the same rule, with `"` and `\` escaped.
4. PCAPNG uses link type **147 (USER0)**, because Wireshark has no UART type. Each packet is
   `port u16 little endian, direction u8, payload`. Timestamps are microseconds, declared in an
   `if_tsresol` option, and the interface is named `bforge-uart`.
5. `parquet` returns an error that names CSV and JSON Lines as the equivalent, rather than
   writing a file that is not Parquet.
6. `GET /api/vault/export?format=…` answers the same bytes as an attachment, with a
   `Content-Disposition` filename taken from the vault and a type per format. An unknown name
   is a `400` that lists the names.
7. `export…` in the ribbon offers the four formats. In a browser it follows the route; in the
   window the shell writes the file beside the vault and prints the path in the header, because
   a webview has no download shelf.
8. `--query "export=csv"` records for four seconds and then saves, so one launch produces a
   file for a script.

## Measured

A 30.8 MB vault, 285 740 records, 21.6 MB of payload:

| Format | Time | Output |
| --- | --- | --- |
| csv | 12.0 s | 76.7 MB |
| jsonl | 8.4 s | 103.4 MB |
| pcapng | 5.8 s | 31.9 MB |

The PCAPNG output was checked with an independent parser, not only with its own test: one
section, one interface, 285 740 packet blocks, a block walk that lands exactly on the file
length, monotonic timestamps, and the first packet's bytes equal to the first CSV row's hex.

## Two bugs this stage found

1. **The block writer corrupted the section header.** The trailing length was patched into a
   slot that did not exist, which overwrote the last four bytes of the section-length field.
   Every block now appends its own trailing length before the two copies are written.
2. **PCAPNG reported zero records** while writing 31.9 MB, because a `continue` skipped the
   counter. The count is now incremented after the write, whatever the format.

A third came from a flaky CI run rather than from this code: a socket accepted from a
non-blocking listener inherits that mode on macOS, so the control server's first read returned
`WouldBlock` and replied with nothing. See `crates/bforge-core/src/control.rs`.

## Test

`crates/bforge-storage/tests/export.rs`, six tests: name and extension agreement, CSV rows with
hex and text, JSON Lines parsing back, the Saleae columns, the PCAPNG block walk with its
section length intact, and Parquet refused.

```sh
cargo test -p bforge-storage --test export
```

## Measured through the window

Two runs against the live engine:

| Path | Result |
| --- | --- |
| route, while recording | `200`, `text/csv`, `bforge-gui-1793520375.csv`, 47 354 records, 6.7 MB |
| ribbon control, Saleae | `wrote C:\...forge-gui-1793520598.saleae.csv`, 2 757 records, 180 kB |

## Limits, recorded

- Export walks the reader record by record, and the reader seeks per payload. A sequential
  cursor would remove the seeks; see the deferred entry.
- The route builds the body in memory. A capture larger than the server's memory would fail;
  chunked writing is the next step if that ever happens.
- Timestamps come from the vault, so a capture recorded with a zero epoch exports times that
  start at zero.
