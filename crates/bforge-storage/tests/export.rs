//! Export tests (FR-STO-02): each format writes what it claims, from one vault.

use bforge_hal::{Direction, PinStateFlags};
use bforge_storage::{
    ExportFormat, LogHeader, LogReader, LogWriter, RawChunk, export, format_extension,
    format_from_name,
};

/// Three records: printable text, a binary payload, and a line with a parity error.
fn sample_vault(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(name);
    let _ = std::fs::remove_file(&path);
    let mut writer = LogWriter::create(&path, LogHeader::default()).unwrap();
    let start = 1_700_000_000_000_000_000u64;
    let rows: [(Direction, u16, &[u8]); 3] = [
        (Direction::Rx, 0, b"OK\r\n"),
        (Direction::Tx, 0, &[0x00, 0xFF, 0x10]),
        (Direction::Rx, 1, b"?\n"),
    ];
    for (index, (direction, port, payload)) in rows.iter().enumerate() {
        let line_state = if index == 2 {
            PinStateFlags::PARITY_ERR
        } else {
            PinStateFlags::default()
        };
        writer
            .append(
                &RawChunk {
                    seq_id: index as u64,
                    timestamp_ns: start + index as u64 * 10_000_000,
                    port_id: *port,
                    direction: *direction,
                    line_state,
                    payload_offset: 0,
                    payload_len: payload.len() as u32,
                },
                payload,
            )
            .unwrap();
    }
    writer.seal().unwrap();
    path
}

fn exported(name: &str, format: ExportFormat) -> String {
    let path = sample_vault(name);
    let mut reader = LogReader::open(&path).unwrap();
    let mut out = Vec::new();
    let report = export(&mut reader, format, &mut out).unwrap();
    assert_eq!(report.records, 3, "{name}");
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn format_names_and_extensions_agree() {
    for (name, format) in [
        ("csv", ExportFormat::Csv),
        ("jsonl", ExportFormat::JsonLines),
        ("saleae", ExportFormat::SaleaeCsv),
        ("pcapng", ExportFormat::PcapNg),
        ("parquet", ExportFormat::Parquet),
    ] {
        assert_eq!(format_from_name(name), Some(format), "{name}");
        assert_eq!(
            format_from_name(&name.to_uppercase()),
            Some(format),
            "{name}"
        );
        assert!(!format_extension(format).is_empty(), "{name}");
    }
    assert_eq!(format_from_name("xlsx"), None);
}

#[test]
fn csv_has_one_row_per_record_with_hex_and_text() {
    let text = exported("export-csv.bflog", ExportFormat::Csv);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 4, "header and three records: {text}");
    assert!(lines[0].starts_with("seq,timestamp_ns,seconds,port,direction"));
    // The printable payload shows as text; the binary one shows dots beside its hex.
    assert!(lines[1].contains(",rx,"), "{}", lines[1]);
    assert!(lines[1].ends_with(",4F4B0D0A,OK.."), "{}", lines[1]);
    assert!(lines[2].contains(",00FF10,..."), "{}", lines[2]);
    // The third record carries the parity error in its line state.
    let flags: u16 = lines[3].split(',').nth(5).unwrap().parse().unwrap();
    assert_eq!(
        flags & PinStateFlags::PARITY_ERR.0,
        PinStateFlags::PARITY_ERR.0
    );
}

#[test]
fn json_lines_parses_and_names_the_direction() {
    let text = exported("export-jsonl.bflog", ExportFormat::JsonLines);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 3, "{text}");
    let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(first["direction"], "rx");
    assert_eq!(first["hex"], "4F4B0D0A");
    assert_eq!(first["port"], 0);
    let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
    assert_eq!(second["direction"], "tx");
    assert_eq!(second["length"], 3);
    // Two records ten milliseconds apart read as 0.010000 s.
    let seconds = second["seconds"].as_f64().unwrap() - first["seconds"].as_f64().unwrap();
    assert!((seconds - 0.01).abs() < 1e-6, "{seconds}");
}

#[test]
fn saleae_export_keeps_the_analyser_columns() {
    let text = exported("export-saleae.bflog", ExportFormat::SaleaeCsv);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "Time [s], value, parity, error");
    assert!(lines[3].contains("parity error"), "{text}");
    assert!(lines[1].contains("4F4B0D0A"), "{}", lines[1]);
}

#[test]
fn pcapng_writes_a_section_an_interface_and_three_packets() {
    let path = sample_vault("export-pcapng.bflog");
    let mut reader = LogReader::open(&path).unwrap();
    let mut out = Vec::new();
    export(&mut reader, ExportFormat::PcapNg, &mut out).unwrap();

    assert_eq!(&out[0..4], &0x0A0D_0D0Au32.to_le_bytes(), "section header");
    assert_eq!(
        &out[8..12],
        &0x1A2B_3C4Du32.to_le_bytes(),
        "byte order magic"
    );
    // The section length must survive: patching the trailing length over it corrupts it.
    assert_eq!(
        &out[16..24],
        &u64::MAX.to_le_bytes(),
        "section length unknown"
    );

    // Walk the blocks: type at 0, length at 4, and the length repeated at the end.
    let mut at = 0usize;
    let mut kinds = Vec::new();
    while at + 12 <= out.len() {
        let kind = u32::from_le_bytes(out[at..at + 4].try_into().unwrap());
        let len = u32::from_le_bytes(out[at + 4..at + 8].try_into().unwrap()) as usize;
        assert!(
            len >= 12 && at + len <= out.len(),
            "block at {at} length {len}"
        );
        let end = u32::from_le_bytes(out[at + len - 4..at + len].try_into().unwrap()) as usize;
        assert_eq!(end, len, "block at {at} ends with its own length");
        kinds.push(kind);
        at += len;
    }
    assert_eq!(at, out.len(), "blocks cover the file exactly");
    assert_eq!(kinds[0], 0x0A0D_0D0A);
    assert_eq!(kinds[1], 1, "one interface");
    assert_eq!(
        kinds.iter().filter(|&&kind| kind == 6).count(),
        3,
        "three packets"
    );

    // The interface says USER0: link type is the first field of an interface block body.
    let mut at = 0usize;
    while at + 16 <= out.len() {
        let kind = u32::from_le_bytes(out[at..at + 4].try_into().unwrap());
        let len = u32::from_le_bytes(out[at + 4..at + 8].try_into().unwrap()) as usize;
        if kind == 1 {
            let linktype = u16::from_le_bytes(out[at + 8..at + 10].try_into().unwrap());
            assert_eq!(linktype, 147, "USER0");
            return;
        }
        at += len;
    }
    panic!("no interface block in {} bytes", out.len());
}

#[test]
fn parquet_is_refused_by_name() {
    let path = sample_vault("export-parquet.bflog");
    let mut reader = LogReader::open(&path).unwrap();
    let mut out = Vec::new();
    let error = export(&mut reader, ExportFormat::Parquet, &mut out).unwrap_err();
    assert!(format!("{error}").contains("not implemented"), "{error}");
    assert!(out.is_empty());
}
