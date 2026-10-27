//! Session vault (FR-STO-01, FR-STO-02).
//!
//! Raw bytes reach the `.bflog` file before any framing or filtering. The file
//! is append only, so a later dissector can re-read historical evidence.
//!
//! ```text
//! offset 0    256-byte file header
//! offset 256  data blocks: RawChunk headers + payloads
//! ...         sparse index: one entry every 1024 frames
//! ```
//!
//! Setup only: the format types exist, the writer and exporters do not.

use bforge_hal::{Direction, PinStateFlags};
use serde::{Deserialize, Serialize};

/// File signature of a `.bflog` container.
pub const MAGIC: [u8; 6] = *b"BFLG\x01\x00";
/// Size of the file header in bytes.
pub const HEADER_LEN: usize = 256;
/// Size of one data segment.
pub const SEGMENT_LEN: usize = 64 * 1024 * 1024;
/// One index entry per 1024 frames.
pub const INDEX_STRIDE: u64 = 1024;

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
    /// Byte offset of the payload in the memory-mapped slab.
    pub payload_offset: u64,
    /// Length of the raw bytes in this chunk.
    pub payload_len: u32,
}

/// First 256 bytes of a `.bflog` file (FR-STO-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LogHeader {
    pub session_id: u128,
    /// Start of the session as Unix epoch nanoseconds.
    pub start_epoch_ns: u64,
    /// Hash of the workspace configuration that produced the session.
    pub config_hash: u64,
    /// File offset of the port descriptor table.
    pub port_table_offset: u64,
}

/// One sparse index entry (FR-STO-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexEntry {
    pub timestamp_ns: u64,
    pub frame_id: u64,
    pub file_offset: u64,
}

/// Sparse timestamp index that gives O(log N) seek (FR-STO-01).
#[derive(Debug, Clone, Default)]
pub struct SparseIndex {
    /// Filled by the session writer, in frame order.
    pub entries: Vec<IndexEntry>,
}

/// Export formats offered for a recorded session (FR-STO-02).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportFormat {
    PcapNg,
    Csv,
    Parquet,
    JsonLines,
    SaleaeCsv,
}
