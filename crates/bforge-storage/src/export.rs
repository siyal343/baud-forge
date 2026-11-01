//! Vault export (FR-STO-02).
//!
//! Five formats, all written in one forward pass over the vault:
//!
//! - **CSV**: one row per record, the payload as hex and as text.
//! - **JSON Lines**: one object per record, the same fields.
//! - **Saleae Logic 2 CSV**: the columns its asynchronous serial analyser exports, so a
//!   capture here can be put beside an analyser capture of the same wire.
//! - **PCAPNG**: a Wireshark container, link type USER0, each packet
//!   `port u16, direction u8, payload`, timestamps in microseconds.
//! - **Parquet**: refused by name; see the note in `NEXT.md`.

use std::io::Write;

use crate::{ExportFormat, LogReader, LogRecord, StorageError};

/// What an export wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExportReport {
    pub records: u64,
    pub payload_bytes: u64,
}

/// Read `--format` as a name.
pub fn format_from_name(name: &str) -> Option<ExportFormat> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "csv" => ExportFormat::Csv,
        "jsonl" | "json-lines" | "ndjson" => ExportFormat::JsonLines,
        "saleae" | "saleae-csv" | "logic2" => ExportFormat::SaleaeCsv,
        "pcapng" | "pcap" | "wireshark" => ExportFormat::PcapNg,
        "parquet" => ExportFormat::Parquet,
        _ => return None,
    })
}

/// File extension for a format, for a default output name.
pub fn format_extension(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::PcapNg => "pcapng",
        ExportFormat::Csv => "csv",
        ExportFormat::Parquet => "parquet",
        ExportFormat::JsonLines => "jsonl",
        ExportFormat::SaleaeCsv => "saleae.csv",
    }
}

/// Names accepted by `--format`, for a usage line.
pub const FORMAT_NAMES: &str = "csv, jsonl, saleae, pcapng";

/// Write the whole vault in `format`.
///
/// Records stream in batches so a long capture does not load at once.
pub fn export(
    reader: &mut LogReader,
    format: ExportFormat,
    out: &mut impl Write,
) -> Result<ExportReport, StorageError> {
    if format == ExportFormat::Parquet {
        return Err(StorageError::Io(
            "parquet is not implemented; CSV and JSON Lines carry the same columns".to_string(),
        ));
    }

    let mut report = ExportReport::default();
    match format {
        ExportFormat::Csv => writeln!(
            out,
            "seq,timestamp_ns,seconds,port,direction,line_state,length,hex,text"
        ),
        ExportFormat::SaleaeCsv => writeln!(out, "Time [s], value, parity, error"),
        ExportFormat::PcapNg => write_pcapng_header(out),
        ExportFormat::JsonLines | ExportFormat::Parquet => Ok(()),
    }
    .map_err(io)?;

    let total = reader.chunks();
    let mut next = 0u64;
    while next < total {
        let batch = reader.window(next, 512)?;
        if batch.is_empty() {
            break;
        }
        for record in &batch {
            let written = match format {
                ExportFormat::PcapNg => write_pcapng_packet(out, record),
                ExportFormat::Csv => out.write_all(csv_row(record).as_bytes()),
                ExportFormat::JsonLines => out.write_all(json_line(record).as_bytes()),
                ExportFormat::SaleaeCsv => out.write_all(saleae_row(record).as_bytes()),
                ExportFormat::Parquet => unreachable!("refused above"),
            };
            written.map_err(io)?;
            report.records += 1;
            report.payload_bytes += record.payload.len() as u64;
        }
        next += batch.len() as u64;
    }

    out.flush().map_err(io)?;
    Ok(report)
}

fn csv_row(record: &LogRecord) -> String {
    let chunk = &record.chunk;
    format!(
        "{},{},{:.6},{},{},{},{},{},{}\n",
        chunk.seq_id,
        chunk.timestamp_ns,
        chunk.timestamp_ns as f64 / 1e9,
        chunk.port_id,
        direction_name(chunk.direction),
        chunk.line_state.0,
        record.payload.len(),
        hex(&record.payload),
        text(&record.payload),
    )
}

fn json_line(record: &LogRecord) -> String {
    let chunk = &record.chunk;
    format!(
        "{{\"seq\":{},\"timestamp_ns\":{},\"seconds\":{:.6},\"port\":{},\"direction\":\"{}\",\"line_state\":{},\"length\":{},\"hex\":\"{}\",\"text\":\"{}\"}}\n",
        chunk.seq_id,
        chunk.timestamp_ns,
        chunk.timestamp_ns as f64 / 1e9,
        chunk.port_id,
        direction_name(chunk.direction),
        chunk.line_state.0,
        record.payload.len(),
        hex(&record.payload),
        json_text(&record.payload),
    )
}

/// Saleae's asynchronous serial export: one row per value, time in seconds.
fn saleae_row(record: &LogRecord) -> String {
    format!(
        "{:.6}, {}, {}\n",
        record.chunk.timestamp_ns as f64 / 1e9,
        hex(&record.payload),
        line_state_note(record),
    )
}

/// Parity and error columns get a word only when the line said something.
fn line_state_note(record: &LogRecord) -> &'static str {
    use bforge_hal::PinStateFlags;
    let flags = record.chunk.line_state;
    if flags.contains(PinStateFlags::PARITY_ERR) {
        "parity error"
    } else if flags.contains(PinStateFlags::FRAMING_ERR) {
        "framing error"
    } else if flags.contains(PinStateFlags::BREAK) {
        "break"
    } else {
        ""
    }
}

fn direction_name(direction: bforge_hal::Direction) -> &'static str {
    use bforge_hal::Direction::*;
    match direction {
        Rx => "rx",
        Tx => "tx",
        MitmAToB => "a-b",
        MitmBToA => "b-a",
        InjectedFault => "fault",
    }
}

const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

/// Two uppercase digits per byte from a table. `format!` per byte allocated a `String` for
/// every digit pair, which made a 285 000 record export take twelve seconds.
fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX_DIGITS[(byte >> 4) as usize] as char);
        out.push(HEX_DIGITS[(byte & 0x0F) as usize] as char);
    }
    out
}

/// Printable ASCII, and a dot for anything else, so a CSV stays one row per record.
fn text(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| {
            if (0x20..0x7F).contains(&byte) {
                byte as char
            } else {
                '.'
            }
        })
        .collect()
}

/// The same, with the characters JSON needs escaped.
fn json_text(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &byte in bytes {
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            0x20..=0x7E => out.push(byte as char),
            _ => out.push('.'),
        }
    }
    out
}

/// Section header, one interface, and its options.
///
/// Link type 147 is USER0: Wireshark has no UART type, so each packet carries the port and
/// the direction in front of the bytes and is shown raw.
fn write_pcapng_header(out: &mut impl Write) -> std::io::Result<()> {
    // Section Header Block: type, length, byte order magic, version, section length.
    let mut shb = Vec::new();
    shb.extend_from_slice(&0x0A0D_0D0Au32.to_le_bytes());
    shb.extend_from_slice(&0u32.to_le_bytes()); // patched below
    shb.extend_from_slice(&0x1A2B_3C4Du32.to_le_bytes());
    shb.extend_from_slice(&1u16.to_le_bytes());
    shb.extend_from_slice(&0u16.to_le_bytes());
    shb.extend_from_slice(&u64::MAX.to_le_bytes());
    finish_block(&mut shb);
    out.write_all(&shb)?;

    // Interface Description Block: link type USER0, snap length, then two options.
    let mut idb = Vec::new();
    idb.extend_from_slice(&1u32.to_le_bytes());
    idb.extend_from_slice(&0u32.to_le_bytes()); // patched below
    idb.extend_from_slice(&147u16.to_le_bytes());
    idb.extend_from_slice(&0u16.to_le_bytes());
    idb.extend_from_slice(&262_144u32.to_le_bytes());
    push_option(&mut idb, 2, b"bforge-uart"); // if_name
    push_option(&mut idb, 9, &[6]); // if_tsresol, microseconds
    push_option(&mut idb, 0, &[]); // opt_endofopt
    finish_block(&mut idb);
    out.write_all(&idb)
}

fn write_pcapng_packet(out: &mut impl Write, record: &LogRecord) -> std::io::Result<()> {
    let mut data = Vec::with_capacity(record.payload.len() + 3);
    data.extend_from_slice(&record.chunk.port_id.to_le_bytes());
    data.push(direction_code(record.chunk.direction));
    data.extend_from_slice(&record.payload);

    let micros = record.chunk.timestamp_ns / 1_000;
    let mut epb = Vec::new();
    epb.extend_from_slice(&6u32.to_le_bytes()); // Enhanced Packet Block
    epb.extend_from_slice(&0u32.to_le_bytes()); // patched below
    epb.extend_from_slice(&0u32.to_le_bytes()); // interface id
    epb.extend_from_slice(&((micros >> 32) as u32).to_le_bytes());
    epb.extend_from_slice(&(micros as u32).to_le_bytes());
    epb.extend_from_slice(&(data.len() as u32).to_le_bytes());
    epb.extend_from_slice(&(data.len() as u32).to_le_bytes());
    epb.extend_from_slice(&data);
    while !epb.len().is_multiple_of(4) {
        epb.push(0);
    }
    finish_block(&mut epb);
    out.write_all(&epb)
}

/// Options are padded to four bytes; the code and length are little endian.
fn push_option(block: &mut Vec<u8>, code: u16, value: &[u8]) {
    block.extend_from_slice(&code.to_le_bytes());
    block.extend_from_slice(&(value.len() as u16).to_le_bytes());
    block.extend_from_slice(value);
    while !block.len().is_multiple_of(4) {
        block.push(0);
    }
}

/// Close a block: append the trailing length, then write both copies of it.
///
/// Every PCAPNG block is bracketed by its own length. The block must be four-byte aligned
/// before this call, and this call adds the last four bytes itself: patching a slot that
/// does not exist silently overwrites the field in front of it, which the section header
/// shows as a corrupted section length.
fn finish_block(block: &mut Vec<u8>) {
    block.extend_from_slice(&0u32.to_le_bytes());
    let len = block.len() as u32;
    block[4..8].copy_from_slice(&len.to_le_bytes());
    let end = block.len() - 4;
    block[end..].copy_from_slice(&len.to_le_bytes());
}

fn direction_code(direction: bforge_hal::Direction) -> u8 {
    use bforge_hal::Direction::*;
    match direction {
        Rx => 0,
        Tx => 1,
        MitmAToB => 2,
        MitmBToA => 3,
        InjectedFault => 4,
    }
}

fn io(error: std::io::Error) -> StorageError {
    StorageError::Io(error.to_string())
}
