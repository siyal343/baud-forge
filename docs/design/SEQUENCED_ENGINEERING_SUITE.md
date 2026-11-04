# Sequenced Engineering Suite

Status: implemented and verified (November 2026).
Implements the 4-step sequence:
- **Path A**: Multi-Format Vault Exporter ([`specs/0044-export.md`](../specs/0044-export.md))
- **Path B**: XMODEM & YMODEM File Transfer Rig ([`specs/0056-xymodem.md`](../specs/0056-xymodem.md))
- **Path C**: Firmware ELF Symbol & Crash Trace Inspector ([`specs/0035-demangled-names.md`](../specs/0035-demangled-names.md), [`specs/0055-token-decoding.md`](../specs/0055-token-decoding.md))
- **Path D**: Runtime Protocol & Schema Dialect Loader ([`specs/0053-proto-schema.md`](../specs/0053-proto-schema.md), [`specs/0054-mavlink-xml.md`](../specs/0054-mavlink-xml.md))

---

## 1. Path A: Multi-Format Vault Exporter (`specs/0044`)

The vault exporter provides seamless capture data egress to industry tools:

| Format | Target Extension | Protocol Header & Columns | Primary Consumer |
| :--- | :--- | :--- | :--- |
| **Wireshark PCAP-NG** | `.pcapng` | Section Header + Interface ID (LinkType 147 `USER0`), microsecond resolution, `port u16` + `direction u8` + payload | Wireshark network protocol analyzer |
| **Saleae Logic CSV** | `.saleae.csv` | `Time [s], value, parity, error` | Saleae Logic 2 asynchronous serial analyzer |
| **Standard CSV** | `.csv` | `seq,timestamp_ns,seconds,port,direction,line_state,length,hex,text` | Python / pandas, Excel, Jupyter |
| **JSON Lines** | `.jsonl` | One valid JSON object per record with escaped ASCII | ETL pipelines, cloud storage |
| **Apache Parquet** | `.parquet` | Refused by name per spec 0044 with guidance to use CSV/JSONL | Documented limitation |

### Implementation Details:
- **Rust Engine Route**: Updated `fn vault_export` and `fn vault_info` in [`crates/bforge-core/src/serve.rs`](../../crates/bforge-core/src/serve.rs) to accept `?path=<path>` query parameters, enabling export of arbitrary `.bflog` vaults as well as active recording vaults.
- **Frontend Dialog**: Implemented [`ui/src/components/VaultExportModal.tsx`](../../ui/src/components/VaultExportModal.tsx) with CAD aesthetic, live format selector cards, record statistics, and dual-mode export:
  1. *Disk Vault Export*: Streams byte-identical sequential forward pass directly from Rust storage engine.
  2. *Live Stream Buffer Export*: Generates binary PCAP-NG, Saleae CSV, or NDJSON directly from client-side viewport memory.
- **Ribbon Integration**: Added high-visibility `EXPORT` action button beside `REC` in [`ui/src/components/GlobalRibbon.tsx`](../../ui/src/components/GlobalRibbon.tsx).

---

## 2. Path B: XMODEM & YMODEM File Transfer Rig (`specs/0056`)

Provides in-app flashing and telemetry dumping without requiring external terminal utilities:

### Supported Dialects:
- `XMODEM-CRC`: 128-byte data blocks, `'C'` (0x43) handshake polling, CRC-16/XMODEM polynomial `0x1021`.
- `XMODEM-1K`: 1024-byte data blocks for high-speed bootloader flashing.
- `XMODEM-Checksum`: 128-byte data blocks with legacy 8-bit sum checksum and `NAK` (0x15) start handshake.
- `YMODEM`: Batch transfers with Block 0 metadata (filename, decimal byte length), 1024-byte blocks, and double `EOT` termination.

### Telemetry & Safety Controls:
- **Automatic Port Yield**: Automatically engages Flash-Yield (`POST /api/yield`) before beginning transfer to release serial handles from stream ingestion.
- **Abort Sequence**: Transmits two consecutive `CAN` bytes (`0x18 0x18`) immediately on user abort or sequence complement mismatch.
- **Telemetry Readout**: Block counter (`#X of Y`), byte transfer progress bar, real-time speed calculation (`KB/s`), retry count, and wire frame preview.
- **Panel Location**: Docked in [`ui/src/components/FileTransferView.tsx`](../../ui/src/components/FileTransferView.tsx) within the lower workstation deck.

---

## 3. Path C: Firmware ELF Symbol & Crash Trace Inspector (`specs/0035`, `specs/0055`)

Resolves raw crash addresses, ESP32 panic logs, and compact logging tokens to human-readable source locations:

### Capabilities:
- **Demangled Symbol Resolution**: Implements Rust symbol demangling (removing compiler hashes and expanding generics like `std::env::var::<&str>`) while preserving C symbols (`app_main`).
- **Crash Backtrace Scanner**: Automatically extracts pointers (`0x42001484`) from pasted panic traces, resolving each stack frame to source file path, line number, and function name.
- **Format Token Database (`specs/0055`)**:
  - Pigweed `pw_tokenizer`: Extracts format strings and decodes ZigZag varints.
  - Rust `defmt`: Decodes LEB128 indices and typed format placeholders (`{}`, `{:?}`, `{:x}`).
- **Panel Location**: Docked in [`ui/src/components/ElfSymbolView.tsx`](../../ui/src/components/ElfSymbolView.tsx) tabbed beside Protocol Dissector.

---

## 4. Path D: Runtime Protocol & Schema Dialect Loader (`specs/0053`, `specs/0054`)

Allows users to load custom binary packet dialects into BaudForge at runtime:

### Supported Dialect Formats:
1. **Protobuf (`.proto`)**:
   - Parses syntax `proto2` and `proto3`, line comments, message blocks, nested enums, and scalar fields.
   - Decodes ZigZag signed integers (`sint32`, `sint64`) and formats enums as `LABEL (N)`.
2. **MAVLink Dialect XML (`.xml`)**:
   - Parses `<mavlink>` message specifications.
   - Computes official `CRC_EXTRA` seed bytes via X.25 CRC-16.
   - Reorders base fields by element wire size (8, 4, 2, 1 byte) before extension fields.
   - Validates trailing frame checksums against `CRC_EXTRA`.
3. **C Header Structs (`.h`)**:
   - Parses packed struct definitions with native endianness and bitfields.

### Interactive Sandboxing:
- Integrated live wire byte dissector with field tree preview.
- One-click "APPLY TO WORKSPACE" action to configure runtime framing.
- **Panel Location**: Docked in [`ui/src/components/SchemaDialectView.tsx`](../../ui/src/components/SchemaDialectView.tsx).

---

## 5. Verification & Build Summary

- **TypeScript Engine**: Clean build with zero errors across all components (`pnpm run build` in `ui/`).
- **Engine Core**: Verified clean compilation of `crates/bforge-core`.
- **Desktop Shell**: Embedded assets refreshed in `crates/bforge-desktop`.
