//! `.bflog` reader with a sparse seek index (F1.3.5, F1.3.6, F1.3.7).
//!
//! Opening a file uses the index the writer saved beside it. When that index is
//! missing or does not match the file, the reader scans the record headers once
//! and builds the same index in memory. Either way memory stays constant and a
//! window read touches only the records it returns.
//!
//! A file that ends in a partial record opens successfully and reports
//! `damaged_tail`; [`repair`] truncates it back to the last complete record.

use crate::format::{HEADER_LEN, LogHeader, RECORD_HEADER_LEN, decode_record};
use crate::{RawChunk, SparseIndex, StorageError, index};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One decoded record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRecord {
    pub chunk: RawChunk,
    pub payload: Vec<u8>,
}

/// Random access to a sealed or in-progress `.bflog` file.
#[derive(Debug)]
pub struct LogReader {
    file: File,
    header: LogHeader,
    chunks: u64,
    payload_bytes: u64,
    file_bytes: u64,
    index: SparseIndex,
    damaged_tail: bool,
    index_source: IndexSource,
}

/// Where the sparse index came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexSource {
    /// Read from `<vault>.bfidx`, which the writer saved.
    Persisted,
    /// Built by scanning the record headers at open.
    Scanned,
}

/// What a repair did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairReport {
    pub path: PathBuf,
    pub kept_chunks: u64,
    pub removed_bytes: u64,
}

impl std::fmt::Display for IndexSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Persisted => write!(f, "persisted"),
            Self::Scanned => write!(f, "scanned"),
        }
    }
}

impl LogReader {
    /// Open a session and index it. A truncated last record is not an error:
    /// the reader stops at the last complete record and sets `damaged_tail`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        let mut file = File::open(path)?;
        let file_bytes = file.metadata()?.len();

        let mut header_bytes = [0u8; HEADER_LEN];
        file.read_exact(&mut header_bytes)?;
        let header = LogHeader::decode(&header_bytes)?;

        let mut reader = Self {
            file,
            header,
            chunks: 0,
            payload_bytes: 0,
            file_bytes,
            index: SparseIndex::default(),
            damaged_tail: false,
            index_source: IndexSource::Scanned,
        };

        // A saved index that matches this exact file saves the whole scan.
        if reader.load_persisted_index(path) {
            reader.index_source = IndexSource::Persisted;
        } else {
            reader.scan()?;
        }
        Ok(reader)
    }

    /// Where the sparse index came from.
    pub fn index_source(&self) -> IndexSource {
        self.index_source
    }

    fn load_persisted_index(&mut self, path: &Path) -> bool {
        let Ok(bytes) = std::fs::read(index::index_path(path)) else {
            return false;
        };
        let Some((data_len, chunks, entries)) = index::decode(&bytes) else {
            return false;
        };
        if data_len != self.file_bytes {
            return false;
        }
        // Every record is 32 bytes of header plus payload, so the payload total
        // follows from the file length and the record count.
        let overhead = HEADER_LEN as u64 + chunks * RECORD_HEADER_LEN as u64;
        if self.file_bytes < overhead {
            return false;
        }
        self.chunks = chunks;
        self.payload_bytes = self.file_bytes - overhead;
        self.index = SparseIndex::from_entries(entries);
        true
    }

    pub fn header(&self) -> LogHeader {
        self.header
    }

    /// Number of complete records.
    pub fn chunks(&self) -> u64 {
        self.chunks
    }

    pub fn payload_bytes(&self) -> u64 {
        self.payload_bytes
    }

    pub fn file_bytes(&self) -> u64 {
        self.file_bytes
    }

    pub fn index_entries(&self) -> usize {
        self.index.len()
    }

    /// True when the file ends in a partial record, for example after a crash.
    pub fn damaged_tail(&self) -> bool {
        self.damaged_tail
    }

    /// Read one record by its position in the file, counting from zero.
    ///
    /// The seek key is the record ordinal, not the chunk sequence: every port
    /// starts its own sequence at zero, so the sequence in a record is unique
    /// only within that port. `chunk.seq_id` is carried through untouched.
    /// The first record at or after `timestamp_ns`, or the last record if the time is
    /// past the end. This is what a timeline in seconds seeks with.
    pub fn seek_time(&mut self, timestamp_ns: u64) -> Result<Option<u64>, StorageError> {
        if self.chunks == 0 {
            return Ok(None);
        }
        let (mut ordinal, mut position) = match self.index.seek_time(timestamp_ns) {
            Some(entry) => (entry.frame_id, entry.file_offset),
            None => (0, HEADER_LEN as u64),
        };
        while ordinal < self.chunks {
            let chunk = self.read_record_at(position)?;
            if chunk.timestamp_ns >= timestamp_ns {
                return Ok(Some(ordinal));
            }
            position += RECORD_HEADER_LEN as u64 + chunk.payload_len as u64;
            ordinal += 1;
        }
        Ok(Some(self.chunks.saturating_sub(1)))
    }

    /// The newest timestamp in the file, for the timeline's right edge.
    ///
    /// The sparse index only holds every stride-th record, and a short session has no
    /// entries at all, so the last record is read directly rather than trusted to an
    /// index that may not reach it.
    pub fn last_timestamp_ns(&mut self) -> u64 {
        if self.chunks == 0 {
            return 0;
        }
        match self.read_at(self.chunks - 1) {
            Ok(Some(record)) => record.chunk.timestamp_ns,
            _ => 0,
        }
    }

    pub fn read_at(&mut self, frame_id: u64) -> Result<Option<LogRecord>, StorageError> {
        if frame_id >= self.chunks {
            return Ok(None);
        }
        let (mut ordinal, mut position) = match self.index.seek_frame(frame_id) {
            Some(entry) => (entry.frame_id, entry.file_offset),
            None => (0, HEADER_LEN as u64),
        };

        while ordinal <= frame_id {
            let chunk = self.read_record_at(position)?;
            let len = chunk.payload_len as u64;
            let payload_offset = position + RECORD_HEADER_LEN as u64;
            if ordinal == frame_id {
                let mut payload = vec![0u8; len as usize];
                self.file.seek(SeekFrom::Start(payload_offset))?;
                self.file.read_exact(&mut payload)?;
                let record = LogRecord {
                    chunk: RawChunk {
                        payload_offset,
                        ..chunk
                    },
                    payload,
                };
                return Ok(Some(record));
            }
            position = payload_offset + len;
            ordinal += 1;
        }
        Ok(None)
    }

    /// Read `count` records starting at record `frame_id`, clipped to the end.
    /// Records `frame_id .. frame_id + count`, read in one forward pass.
    ///
    /// Reading record by record would walk from the sparse index on every call,
    /// which turns a whole-vault decode into a quadratic one: a ten-minute capture
    /// took minutes per check before this.
    pub fn window(&mut self, frame_id: u64, count: usize) -> Result<Vec<LogRecord>, StorageError> {
        if frame_id >= self.chunks || count == 0 {
            return Ok(Vec::new());
        }
        let (mut ordinal, mut position) = match self.index.seek_frame(frame_id) {
            Some(entry) => (entry.frame_id, entry.file_offset),
            None => (0, HEADER_LEN as u64),
        };

        // Skip to the first record the caller asked for, without reading payloads.
        while ordinal < frame_id {
            let chunk = self.read_record_at(position)?;
            position += RECORD_HEADER_LEN as u64 + chunk.payload_len as u64;
            ordinal += 1;
        }

        let mut records = Vec::with_capacity(count);
        while ordinal < frame_id + count as u64 && ordinal < self.chunks {
            let chunk = self.read_record_at(position)?;
            let len = chunk.payload_len as u64;
            let payload_offset = position + RECORD_HEADER_LEN as u64;
            let mut payload = vec![0u8; len as usize];
            self.file.seek(SeekFrom::Start(payload_offset))?;
            self.file.read_exact(&mut payload)?;
            records.push(LogRecord {
                chunk: RawChunk {
                    payload_offset,
                    ..chunk
                },
                payload,
            });
            position = payload_offset + len;
            ordinal += 1;
        }
        Ok(records)
    }

    fn read_record_at(&mut self, position: u64) -> Result<RawChunk, StorageError> {
        let mut header = [0u8; RECORD_HEADER_LEN];
        self.file.seek(SeekFrom::Start(position))?;
        self.file.read_exact(&mut header)?;
        decode_record(&header)
    }

    /// Bytes of complete records. Anything after this is a partial record.
    fn complete_bytes(&self) -> u64 {
        HEADER_LEN as u64 + self.chunks * RECORD_HEADER_LEN as u64 + self.payload_bytes
    }

    fn scan(&mut self) -> Result<(), StorageError> {
        let mut position = HEADER_LEN as u64;
        loop {
            if position + RECORD_HEADER_LEN as u64 > self.file_bytes {
                self.damaged_tail = position < self.file_bytes;
                return Ok(());
            }
            let chunk = match self.read_record_at(position) {
                Ok(chunk) => chunk,
                Err(_) => {
                    self.damaged_tail = true;
                    return Ok(());
                }
            };
            let payload_len = chunk.payload_len as u64;
            let next = position + RECORD_HEADER_LEN as u64 + payload_len;
            if next > self.file_bytes {
                self.damaged_tail = true;
                return Ok(());
            }
            self.index.push(self.chunks, chunk.timestamp_ns, position);
            self.chunks += 1;
            self.payload_bytes += payload_len;
            position = next;
        }
    }
}

/// Truncate a vault back to its last complete record, so the partial tail of a
/// killed session cannot confuse anything that reads the file later.
///
/// The scan is always fresh here: a stale index must not decide how much of a
/// damaged file to keep. The saved index is removed after the repair.
pub fn repair(path: impl AsRef<Path>) -> Result<RepairReport, StorageError> {
    let path = path.as_ref();
    let mut reader = LogReader::open(path)?;
    // Force a scan, even when a persisted index claims to know the file.
    reader.index = SparseIndex::default();
    reader.chunks = 0;
    reader.payload_bytes = 0;
    reader.damaged_tail = false;
    reader.scan()?;

    let keep = reader.complete_bytes();
    let removed = reader.file_bytes.saturating_sub(keep);
    if removed > 0 {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        file.set_len(keep)?;
        file.sync_data()?;
        let _ = std::fs::remove_file(index::index_path(path));
    }

    Ok(RepairReport {
        path: path.to_path_buf(),
        kept_chunks: reader.chunks,
        removed_bytes: removed,
    })
}
