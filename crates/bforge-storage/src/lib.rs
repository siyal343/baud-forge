//! Session vault (FR-STO-01, FR-STO-02).
//!
//! Raw bytes reach the `.bflog` file before any framing or filtering. The file
//! is append only, so a later dissector can re-read historical evidence.
//!
//! ```text
//! offset 0    256-byte file header
//! offset 256  chunk records: 32-byte header + payload
//! ```
//!
//! S2 scope: header, record, writer, reader. Compression, the persisted index
//! and full crash recovery are F1.3.4, F1.3.5 and F1.3.7. The reader builds its
//! sparse index in memory on open, at one entry per 1024 chunks.

pub mod format;
pub mod index;
pub mod reader;
pub mod writer;

use bforge_hal::{Direction, PinStateFlags};
use serde::{Deserialize, Serialize};

pub use format::LogHeader;
pub use format::{HEADER_LEN, INDEX_STRIDE, MAGIC, RECORD_HEADER_LEN, SEGMENT_LEN};
pub use index::{INDEX_MAGIC, index_path};
pub use reader::{IndexSource, LogReader, LogRecord, RepairReport, repair};
pub use writer::{LogSummary, LogWriter};

/// Fundamental atomic unit of the SPMC pipeline (ADR-002).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawChunk {
    /// Monotonically increasing chunk counter.
    pub seq_id: u64,
    /// Monotonic hardware or OS nanosecond timestamp.
    pub timestamp_ns: u64,
    /// Source transport ID.
    pub port_id: u16,
    pub direction: Direction,
    /// CTS, DSR, DCD, RI, BREAK and error bits sampled with the data.
    pub line_state: PinStateFlags,
    /// Byte offset of the payload in the file.
    pub payload_offset: u64,
    /// Length of the raw bytes in this chunk.
    pub payload_len: u32,
}

/// One sparse index entry (FR-STO-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexEntry {
    pub timestamp_ns: u64,
    pub frame_id: u64,
    pub file_offset: u64,
}

/// Sparse index that gives an O(log N) seek (FR-STO-01).
#[derive(Debug, Clone, Default)]
pub struct SparseIndex {
    entries: Vec<IndexEntry>,
}

impl SparseIndex {
    /// Build an index from entries that were read from a file.
    pub fn from_entries(entries: Vec<IndexEntry>) -> Self {
        Self { entries }
    }

    /// The entries, in file order.
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }

    /// Keep one entry per [`INDEX_STRIDE`] chunks.
    pub fn push(&mut self, frame_id: u64, timestamp_ns: u64, file_offset: u64) {
        if !frame_id.is_multiple_of(INDEX_STRIDE) {
            return;
        }
        self.entries.push(IndexEntry {
            timestamp_ns,
            frame_id,
            file_offset,
        });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Newest entry at or before `timestamp_ns`.
    pub fn seek(&self, timestamp_ns: u64) -> Option<IndexEntry> {
        let cut = self
            .entries
            .partition_point(|entry| entry.timestamp_ns <= timestamp_ns);
        cut.checked_sub(1).map(|index| self.entries[index])
    }

    /// Newest entry at or before `frame_id`.
    pub fn seek_frame(&self, frame_id: u64) -> Option<IndexEntry> {
        let cut = self
            .entries
            .partition_point(|entry| entry.frame_id <= frame_id);
        cut.checked_sub(1).map(|index| self.entries[index])
    }
}

/// Export formats offered for a recorded session (FR-STO-02).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    PcapNg,
    Csv,
    Parquet,
    JsonLines,
    SaleaeCsv,
}

/// Storage failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    BadMagic,
    ShortHeader(usize),
    Truncated,
    BadDirection(u8),
    Io(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadMagic => write!(f, "not a .bflog file: bad magic bytes"),
            Self::ShortHeader(len) => write!(f, "header needs {HEADER_LEN} bytes, got {len}"),
            Self::Truncated => write!(f, "record is truncated"),
            Self::BadDirection(code) => write!(f, "unknown direction code {code}"),
            Self::Io(message) => write!(f, "io error: {message}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
