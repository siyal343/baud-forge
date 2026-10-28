//! Append-only `.bflog` writer (FR-STO-01, F1.3.3).
//!
//! One file, no compression yet. Each chunk is a 32-byte record header followed
//! by its payload. The writer flushes and syncs when it crosses a 64 MB segment
//! boundary, and always on `seal`, so a lost tail is at most one segment.

use crate::format::{HEADER_LEN, LogHeader, RECORD_HEADER_LEN, SEGMENT_LEN, encode_record};
use crate::{RawChunk, SparseIndex, index};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// What landed on disk when a session was sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogSummary {
    pub path: PathBuf,
    pub chunks: u64,
    pub payload_bytes: u64,
    pub file_bytes: u64,
    pub segments: u32,
}

/// Writes one session. `seal` or drop both flush; only `seal` reports.
#[derive(Debug)]
pub struct LogWriter {
    path: PathBuf,
    file: BufWriter<File>,
    offset: u64,
    chunks: u64,
    payload_bytes: u64,
    segments: u32,
    index: SparseIndex,
    sealed: bool,
}

impl LogWriter {
    /// Create the file, write the 256-byte header, and return a writer.
    pub fn create(path: impl AsRef<Path>, header: LogHeader) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)?;
        let mut file = BufWriter::with_capacity(64 * 1024, file);
        file.write_all(&header.encode())?;
        Ok(Self {
            path,
            file,
            offset: HEADER_LEN as u64,
            chunks: 0,
            payload_bytes: 0,
            segments: 1,
            index: SparseIndex::default(),
            sealed: false,
        })
    }

    /// Append one chunk. Returns the record offset in the file.
    pub fn append(&mut self, chunk: &RawChunk, payload: &[u8]) -> std::io::Result<u64> {
        assert!(!self.sealed, "append after seal");
        assert_eq!(
            chunk.payload_len as usize,
            payload.len(),
            "payload length must match the record"
        );

        let record_offset = self.offset;
        self.file.write_all(&encode_record(chunk))?;
        self.file.write_all(payload)?;

        // Keyed by the record ordinal: every port starts its sequence at zero.
        self.index
            .push(self.chunks, chunk.timestamp_ns, record_offset);
        self.offset += (RECORD_HEADER_LEN + payload.len()) as u64;
        self.chunks += 1;
        self.payload_bytes += payload.len() as u64;

        if self.offset >= u64::from(self.segments) * SEGMENT_LEN as u64 {
            self.segments += 1;
            self.flush_and_sync()?;
        }
        Ok(record_offset)
    }

    /// Bytes written so far, header included.
    pub fn position(&self) -> u64 {
        self.offset
    }

    pub fn chunks(&self) -> u64 {
        self.chunks
    }

    /// Flush, sync, save the index, and report what the session contains.
    ///
    /// The index is a cache: if saving it fails, the session is still sealed and
    /// the reader will scan. Losing the file must not lose the data.
    pub fn seal(mut self) -> std::io::Result<LogSummary> {
        self.flush_and_sync()?;
        self.save_index();
        self.sealed = true;
        Ok(LogSummary {
            path: self.path.clone(),
            chunks: self.chunks,
            payload_bytes: self.payload_bytes,
            file_bytes: self.offset,
            segments: self.segments,
        })
    }

    fn save_index(&self) {
        let bytes = index::encode(self.offset, self.chunks, self.index.entries());
        let _ = std::fs::write(index::index_path(&self.path), bytes);
    }

    fn flush_and_sync(&mut self) -> std::io::Result<()> {
        self.file.flush()?;
        self.file.get_ref().sync_data()
    }
}

impl Drop for LogWriter {
    fn drop(&mut self) {
        if !self.sealed {
            let _ = self.file.flush();
        }
    }
}
