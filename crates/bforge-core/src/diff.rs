//! Compare two recorded session vaults (A1, FR-STO-01).
//!
//! Engineers compare a broken session against a known good one. This module finds
//! decoded fields that changed, frames that vanished or appeared, and the first
//! record where the sessions diverge.
//!
//! When a workspace configuration is available, frames are decoded and compared
//! field by field. When no configuration is available, raw records are compared
//! byte by byte.

use crate::ProjectConfig;
use crate::tail::{DecodeError, Stream, TailRow, tail_config};
use bforge_storage::{LogReader, StorageError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Maximum number of changed fields kept in a diff report.
const MAX_CHANGED_FIELDS: usize = 64;

/// One field difference between two decoded frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldDiff {
    pub frame_index: usize,
    pub port: String,
    pub field_name: String,
    pub value_a: String,
    pub value_b: String,
}

/// The first record or frame where two vaults diverge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Divergence {
    pub index: usize,
    pub timestamp_us_a: u64,
    pub timestamp_us_b: u64,
    pub port: String,
    pub reason: String,
    pub field_diffs: Vec<FieldDiff>,
}

/// Result of comparing two session vaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffReport {
    pub records_a: u64,
    pub records_b: u64,
    pub frames_a: usize,
    pub frames_b: usize,
    pub identical: bool,
    pub first_divergence: Option<Divergence>,
    pub changed_fields: Vec<FieldDiff>,
    pub missing_from_a: usize,
    pub missing_from_b: usize,
}

/// Why session diff could not complete.
#[derive(Debug)]
pub enum DiffError {
    Storage(StorageError),
    Decode(DecodeError),
    Config(String),
    Io(std::io::Error),
}

impl std::fmt::Display for DiffError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(err) => write!(f, "storage: {err}"),
            Self::Decode(err) => write!(f, "decode: {err}"),
            Self::Config(msg) => write!(f, "config: {msg}"),
            Self::Io(err) => write!(f, "io: {err}"),
        }
    }
}

impl std::error::Error for DiffError {}

impl From<StorageError> for DiffError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl From<DecodeError> for DiffError {
    fn from(error: DecodeError) -> Self {
        Self::Decode(error)
    }
}

impl From<std::io::Error> for DiffError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Locate a sidecar `.bforge.toml` next to a vault file.
fn locate_sidecar(path: &Path) -> Option<PathBuf> {
    let sidecar = path.with_extension("bforge.toml");
    if sidecar.is_file() {
        return Some(sidecar);
    }
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        let parent = path.parent().unwrap_or_else(|| Path::new(""));
        let sidecar_alt = parent.join(format!("{file_name}.bforge.toml"));
        if sidecar_alt.is_file() {
            return Some(sidecar_alt);
        }
    }
    None
}

/// Decode all frames from a vault using the workspace ports.
fn decode_frames(
    reader: &mut LogReader,
    config: &ProjectConfig,
) -> Result<Vec<TailRow>, DecodeError> {
    let mut streams: Vec<Stream> = Vec::with_capacity(config.ports.len());
    for port in &config.ports {
        let cfg = tail_config(port)?;
        streams.push(Stream::new(&port.id, cfg));
    }

    let mut rows = Vec::new();
    let total_chunks = reader.chunks();
    let mut frame_index = 0u64;

    while frame_index < total_chunks {
        let window = reader.window(frame_index, 256)?;
        if window.is_empty() {
            break;
        }
        for record in &window {
            let stream_idx = (record.chunk.port_id as usize).min(streams.len().saturating_sub(1));
            if let Some(stream) = streams.get_mut(stream_idx) {
                for mut row in stream.feed(record.chunk.timestamp_ns, &record.payload) {
                    row.direction = record.chunk.direction;
                    rows.push(row);
                }
            }
        }
        frame_index += window.len() as u64;
    }
    Ok(rows)
}

/// Compare two `.bflog` vaults.
///
/// When `config` is `None`, check for sidecars `<vault_stem>.bforge.toml` next to
/// `a` or `b`. If found, use that configuration. If no configuration is found,
/// compare raw records.
/// Open a vault, tolerating the transient share violations Windows file
/// watchers (antivirus, search indexing) hold on freshly written captures.
/// Three tries spread over ~300 ms; a genuinely missing file still fails fast
/// on the first try's error path. The path rides in the error — "cannot find
/// the file" without WHICH file answers nothing.
fn open_with_retry(path: &Path) -> Result<LogReader, DiffError> {
    let mut last: Option<DiffError> = None;
    for attempt in 0..3 {
        match LogReader::open(path) {
            Ok(reader) => return Ok(reader),
            Err(error) => {
                // Still a storage error — just one that carries the path, so
                // "cannot find the file" says WHICH file. Rewrapping as `Io`
                // would misreport a storage-layer failure.
                last = Some(DiffError::Storage(StorageError::Io(format!(
                    "{}: {}",
                    path.display(),
                    error
                ))));
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
    }
    Err(last.expect("at least one open attempt was made"))
}

pub fn diff_vaults(
    a: &Path,
    b: &Path,
    config: Option<&ProjectConfig>,
) -> Result<DiffReport, DiffError> {
    let mut reader_a = open_with_retry(a)?;
    let mut reader_b = open_with_retry(b)?;

    let sidecar_config;
    let active_config = match config {
        Some(cfg) => Some(cfg),
        None => {
            let sidecar_path = locate_sidecar(a).or_else(|| locate_sidecar(b));
            if let Some(path) = sidecar_path {
                let text = std::fs::read_to_string(&path)?;
                sidecar_config =
                    crate::parse(&text).map_err(|e| DiffError::Config(e.to_string()))?;
                Some(&sidecar_config)
            } else {
                None
            }
        }
    };

    let records_a = reader_a.chunks();
    let records_b = reader_b.chunks();

    if let Some(cfg) = active_config.filter(|c| !c.ports.is_empty()) {
        let rows_a = decode_frames(&mut reader_a, cfg)?;
        let rows_b = decode_frames(&mut reader_b, cfg)?;
        diff_decoded_frames(records_a, records_b, &rows_a, &rows_b)
    } else {
        diff_raw_records(&mut reader_a, &mut reader_b, records_a, records_b)
    }
}

/// Compare decoded rows frame by frame.
fn diff_decoded_frames(
    records_a: u64,
    records_b: u64,
    rows_a: &[TailRow],
    rows_b: &[TailRow],
) -> Result<DiffReport, DiffError> {
    let frames_a = rows_a.len();
    let frames_b = rows_b.len();
    let min_frames = frames_a.min(frames_b);

    let mut identical = true;
    let mut first_divergence: Option<Divergence> = None;
    let mut changed_fields: Vec<FieldDiff> = Vec::new();

    for i in 0..min_frames {
        let row_a = &rows_a[i];
        let row_b = &rows_b[i];

        if row_a.port != row_b.port {
            identical = false;
            if first_divergence.is_none() {
                first_divergence = Some(Divergence {
                    index: i,
                    timestamp_us_a: row_a.timestamp_us,
                    timestamp_us_b: row_b.timestamp_us,
                    port: row_a.port.clone(),
                    reason: format!("port mismatch: `{}` != `{}`", row_a.port, row_b.port),
                    field_diffs: Vec::new(),
                });
            }
            continue;
        }

        if row_a.direction != row_b.direction {
            identical = false;
            if first_divergence.is_none() {
                first_divergence = Some(Divergence {
                    index: i,
                    timestamp_us_a: row_a.timestamp_us,
                    timestamp_us_b: row_b.timestamp_us,
                    port: row_a.port.clone(),
                    reason: format!(
                        "direction mismatch: {:?} != {:?}",
                        row_a.direction, row_b.direction
                    ),
                    field_diffs: Vec::new(),
                });
            }
            continue;
        }

        let mut frame_diffs = Vec::new();
        for fa in &row_a.fields {
            if let Some(fb) = row_b.fields.iter().find(|f| f.name == fa.name) {
                if fa.value != fb.value {
                    frame_diffs.push(FieldDiff {
                        frame_index: i,
                        port: row_a.port.clone(),
                        field_name: fa.name.clone(),
                        value_a: fa.value.clone(),
                        value_b: fb.value.clone(),
                    });
                }
            } else {
                frame_diffs.push(FieldDiff {
                    frame_index: i,
                    port: row_a.port.clone(),
                    field_name: fa.name.clone(),
                    value_a: fa.value.clone(),
                    value_b: "<missing>".to_string(),
                });
            }
        }
        for fb in &row_b.fields {
            if !row_a.fields.iter().any(|f| f.name == fb.name) {
                frame_diffs.push(FieldDiff {
                    frame_index: i,
                    port: row_b.port.clone(),
                    field_name: fb.name.clone(),
                    value_a: "<missing>".to_string(),
                    value_b: fb.value.clone(),
                });
            }
        }

        if !frame_diffs.is_empty() {
            identical = false;
            if first_divergence.is_none() {
                let reason = format!(
                    "field `{}` changed: `{}` -> `{}`",
                    frame_diffs[0].field_name, frame_diffs[0].value_a, frame_diffs[0].value_b
                );
                first_divergence = Some(Divergence {
                    index: i,
                    timestamp_us_a: row_a.timestamp_us,
                    timestamp_us_b: row_b.timestamp_us,
                    port: row_a.port.clone(),
                    reason,
                    field_diffs: frame_diffs.clone(),
                });
            }
            for diff in frame_diffs {
                if changed_fields.len() < MAX_CHANGED_FIELDS {
                    changed_fields.push(diff);
                }
            }
        } else if row_a.hex != row_b.hex {
            identical = false;
            if first_divergence.is_none() {
                let reason = if row_a.len != row_b.len {
                    format!(
                        "frame payload length mismatch: {} vs {} bytes",
                        row_a.len, row_b.len
                    )
                } else {
                    "frame payload bytes differ".to_string()
                };
                first_divergence = Some(Divergence {
                    index: i,
                    timestamp_us_a: row_a.timestamp_us,
                    timestamp_us_b: row_b.timestamp_us,
                    port: row_a.port.clone(),
                    reason,
                    field_diffs: Vec::new(),
                });
            }
        }
    }

    let missing_from_a = frames_b.saturating_sub(frames_a);
    let missing_from_b = frames_a.saturating_sub(frames_b);

    if missing_from_a > 0 {
        identical = false;
        if first_divergence.is_none() {
            let row = &rows_b[frames_a];
            first_divergence = Some(Divergence {
                index: frames_a,
                timestamp_us_a: 0,
                timestamp_us_b: row.timestamp_us,
                port: row.port.clone(),
                reason: format!("vault b has {missing_from_a} extra frame(s)"),
                field_diffs: Vec::new(),
            });
        }
    } else if missing_from_b > 0 {
        identical = false;
        if first_divergence.is_none() {
            let row = &rows_a[frames_b];
            first_divergence = Some(Divergence {
                index: frames_b,
                timestamp_us_a: row.timestamp_us,
                timestamp_us_b: 0,
                port: row.port.clone(),
                reason: format!("vault a has {missing_from_b} extra frame(s)"),
                field_diffs: Vec::new(),
            });
        }
    }

    Ok(DiffReport {
        records_a,
        records_b,
        frames_a,
        frames_b,
        identical,
        first_divergence,
        changed_fields,
        missing_from_a,
        missing_from_b,
    })
}

/// Compare raw records record by record.
fn diff_raw_records(
    reader_a: &mut LogReader,
    reader_b: &mut LogReader,
    records_a: u64,
    records_b: u64,
) -> Result<DiffReport, DiffError> {
    let min_records = records_a.min(records_b);
    let frames_a = records_a as usize;
    let frames_b = records_b as usize;

    let mut identical = true;
    let mut first_divergence: Option<Divergence> = None;
    let changed_fields = Vec::new();

    let mut cursor = 0u64;
    while cursor < min_records {
        let count = (min_records - cursor).min(256) as usize;
        let win_a = reader_a.window(cursor, count)?;
        let win_b = reader_b.window(cursor, count)?;

        for (offset, (rec_a, rec_b)) in win_a.iter().zip(win_b.iter()).enumerate() {
            let idx = (cursor + offset as u64) as usize;
            let mut reason = None;

            if rec_a.chunk.port_id != rec_b.chunk.port_id {
                reason = Some(format!(
                    "port mismatch: {} != {}",
                    rec_a.chunk.port_id, rec_b.chunk.port_id
                ));
            } else if rec_a.chunk.direction != rec_b.chunk.direction {
                reason = Some(format!(
                    "direction mismatch: {:?} != {:?}",
                    rec_a.chunk.direction, rec_b.chunk.direction
                ));
            } else if rec_a.payload != rec_b.payload {
                if rec_a.payload.len() != rec_b.payload.len() {
                    reason = Some(format!(
                        "payload length mismatch: {} vs {} bytes",
                        rec_a.payload.len(),
                        rec_b.payload.len()
                    ));
                } else {
                    let diff_offset = rec_a
                        .payload
                        .iter()
                        .zip(rec_b.payload.iter())
                        .position(|(b1, b2)| b1 != b2)
                        .unwrap_or(0);
                    reason = Some(format!("payload byte mismatch at offset {diff_offset}"));
                }
            }

            if let Some(r) = reason {
                identical = false;
                if first_divergence.is_none() {
                    first_divergence = Some(Divergence {
                        index: idx,
                        timestamp_us_a: rec_a.chunk.timestamp_ns / 1_000,
                        timestamp_us_b: rec_b.chunk.timestamp_ns / 1_000,
                        port: format!("port {}", rec_a.chunk.port_id),
                        reason: r,
                        field_diffs: Vec::new(),
                    });
                }
            }
        }
        cursor += count as u64;
    }

    let missing_from_a = (records_b.saturating_sub(records_a)) as usize;
    let missing_from_b = (records_a.saturating_sub(records_b)) as usize;

    if missing_from_a > 0 {
        identical = false;
        if first_divergence.is_none() {
            let next_rec = reader_b.read_at(records_a)?.map(|r| {
                (
                    r.chunk.timestamp_ns / 1_000,
                    format!("port {}", r.chunk.port_id),
                )
            });
            let (ts, port) = next_rec.unwrap_or((0, "unknown".to_string()));
            first_divergence = Some(Divergence {
                index: records_a as usize,
                timestamp_us_a: 0,
                timestamp_us_b: ts,
                port,
                reason: format!("vault b has {missing_from_a} extra record(s)"),
                field_diffs: Vec::new(),
            });
        }
    } else if missing_from_b > 0 {
        identical = false;
        if first_divergence.is_none() {
            let next_rec = reader_a.read_at(records_b)?.map(|r| {
                (
                    r.chunk.timestamp_ns / 1_000,
                    format!("port {}", r.chunk.port_id),
                )
            });
            let (ts, port) = next_rec.unwrap_or((0, "unknown".to_string()));
            first_divergence = Some(Divergence {
                index: records_b as usize,
                timestamp_us_a: ts,
                timestamp_us_b: 0,
                port,
                reason: format!("vault a has {missing_from_b} extra record(s)"),
                field_diffs: Vec::new(),
            });
        }
    }

    Ok(DiffReport {
        records_a,
        records_b,
        frames_a,
        frames_b,
        identical,
        first_divergence,
        changed_fields,
        missing_from_a,
        missing_from_b,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bforge_framer::cobs_encode;
    use bforge_hal::{Direction, PinStateFlags};
    use bforge_storage::{LogHeader, LogWriter, RawChunk};

    fn temp_path(name: &str, suffix: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "bforge-diff-test-{}-{name}.{suffix}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(bforge_storage::index_path(&path));
        path
    }

    const HEADER: &str = r#"
#include <stdint.h>
struct __attribute__((packed)) ImuPacket {
    uint16_t sync;
    uint8_t  version;
    uint8_t  flags : 3;
    uint8_t  channel : 5;
    __be16   v_batt_mv;
    float    gyro_z;
};
"#;

    fn imu_frame(version: u8, millivolts: u16, gyro: f32) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(&0xAA55u16.to_le_bytes());
        frame.push(version);
        frame.push(0b101);
        frame.extend_from_slice(&millivolts.to_be_bytes());
        frame.extend_from_slice(&gyro.to_le_bytes());
        frame
    }

    fn write_vault(path: &Path, frames: &[Vec<u8>]) {
        let mut writer = LogWriter::create(path, LogHeader::default()).unwrap();
        for (index, frame) in frames.iter().enumerate() {
            let mut payload = cobs_encode(frame);
            payload.push(0);
            writer
                .append(
                    &RawChunk {
                        seq_id: index as u64,
                        timestamp_ns: (index as u64 + 1) * 10_000_000,
                        port_id: 0,
                        direction: Direction::Rx,
                        line_state: PinStateFlags::default(),
                        payload_offset: 0,
                        payload_len: payload.len() as u32,
                    },
                    &payload,
                )
                .unwrap();
        }
        writer.seal().unwrap();
    }

    fn test_config(header_path: &Path) -> ProjectConfig {
        let text = format!(
            r#"
[workspace]
name = "diff-test"
version = "1.0"

[[ports]]
id = "imu"
device_path = "COM1"
baud_rate = 115200
framing = {{ mode = "cobs" }}
dissector = {{ type = "c_header", file = "{}", root_struct = "ImuPacket" }}
"#,
            header_path.to_str().unwrap().replace('\\', "/")
        );
        crate::parse(&text).expect("valid config")
    }

    #[test]
    fn two_identical_vaults_report_no_divergence() {
        let header_file = temp_path("ident", "h");
        std::fs::write(&header_file, HEADER).unwrap();
        let config = test_config(&header_file);

        let frames = vec![
            imu_frame(1, 8000, 0.0),
            imu_frame(1, 8010, 0.1),
            imu_frame(1, 8020, 0.2),
        ];

        let vault_a = temp_path("ident_a", "bflog");
        let vault_b = temp_path("ident_b", "bflog");
        write_vault(&vault_a, &frames);
        write_vault(&vault_b, &frames);

        let report = diff_vaults(&vault_a, &vault_b, Some(&config)).unwrap();
        assert!(report.identical);
        assert_eq!(report.records_a, 3);
        assert_eq!(report.records_b, 3);
        assert_eq!(report.frames_a, 3);
        assert_eq!(report.frames_b, 3);
        assert!(report.first_divergence.is_none());
        assert!(report.changed_fields.is_empty());
        assert_eq!(report.missing_from_a, 0);
        assert_eq!(report.missing_from_b, 0);

        // Also test without config (raw mode)
        let raw_report = diff_vaults(&vault_a, &vault_b, None).unwrap();
        assert!(raw_report.identical);
        assert_eq!(raw_report.records_a, 3);
        assert_eq!(raw_report.records_b, 3);
        assert!(raw_report.first_divergence.is_none());

        let _ = std::fs::remove_file(&header_file);
        let _ = std::fs::remove_file(&vault_a);
        let _ = std::fs::remove_file(&vault_b);
    }

    #[test]
    fn changed_field_names_the_record_and_field() {
        let header_file = temp_path("field", "h");
        std::fs::write(&header_file, HEADER).unwrap();
        let config = test_config(&header_file);

        let frames_a = vec![
            imu_frame(1, 8000, 0.0),
            imu_frame(1, 8100, 0.1),
            imu_frame(1, 8200, 0.2),
        ];
        let frames_b = vec![
            imu_frame(1, 8000, 0.0),
            imu_frame(1, 7500, 0.1), // changed v_batt_mv
            imu_frame(1, 8200, 0.2),
        ];

        let vault_a = temp_path("field_a", "bflog");
        let vault_b = temp_path("field_b", "bflog");
        write_vault(&vault_a, &frames_a);
        write_vault(&vault_b, &frames_b);

        let report = diff_vaults(&vault_a, &vault_b, Some(&config)).unwrap();
        assert!(!report.identical);
        let div = report.first_divergence.as_ref().expect("first divergence");
        assert_eq!(div.index, 1);
        assert!(div.reason.contains("v_batt_mv"));
        assert_eq!(div.field_diffs.len(), 1);
        assert_eq!(div.field_diffs[0].field_name, "v_batt_mv");
        assert_eq!(div.field_diffs[0].value_a, "8100");
        assert_eq!(div.field_diffs[0].value_b, "7500");

        assert_eq!(report.changed_fields.len(), 1);
        assert_eq!(report.changed_fields[0].frame_index, 1);
        assert_eq!(report.changed_fields[0].field_name, "v_batt_mv");
        assert_eq!(report.changed_fields[0].value_a, "8100");
        assert_eq!(report.changed_fields[0].value_b, "7500");

        let _ = std::fs::remove_file(&header_file);
        let _ = std::fs::remove_file(&vault_a);
        let _ = std::fs::remove_file(&vault_b);
    }

    #[test]
    fn shorter_vault_reports_missing_records() {
        let header_file = temp_path("short", "h");
        std::fs::write(&header_file, HEADER).unwrap();
        let config = test_config(&header_file);

        let frames_a = vec![
            imu_frame(1, 8000, 0.0),
            imu_frame(1, 8100, 0.1),
            imu_frame(1, 8200, 0.2),
        ];
        let frames_b = vec![imu_frame(1, 8000, 0.0), imu_frame(1, 8100, 0.1)];

        let vault_a = temp_path("short_a", "bflog");
        let vault_b = temp_path("short_b", "bflog");
        write_vault(&vault_a, &frames_a);
        write_vault(&vault_b, &frames_b);

        let report = diff_vaults(&vault_a, &vault_b, Some(&config)).unwrap();
        assert!(!report.identical);
        assert_eq!(report.missing_from_b, 1);
        assert_eq!(report.missing_from_a, 0);
        let div = report.first_divergence.as_ref().expect("divergence");
        assert_eq!(div.index, 2);

        // Also in raw mode
        let raw_report = diff_vaults(&vault_a, &vault_b, None).unwrap();
        assert!(!raw_report.identical);
        assert_eq!(raw_report.missing_from_b, 1);
        assert_eq!(raw_report.missing_from_a, 0);

        let _ = std::fs::remove_file(&header_file);
        let _ = std::fs::remove_file(&vault_a);
        let _ = std::fs::remove_file(&vault_b);
    }
}
