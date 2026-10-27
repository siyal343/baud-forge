//! `.bflog` reader with a sparse seek index (F1.3.6).
//!
//! Opening a file scans the record headers once and keeps one index entry per
//! 1024 chunks, so a window read touches only the records it returns. Memory
//! stays constant, whatever the file size.

use crate::format::{HEADER_LEN, LogHeader, RECORD_HEADER_LEN, decode_record};
use crate::{RawChunk, SparseIndex, StorageError};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

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
}

impl LogReader {
    /// Open a session and index it. A truncated last record is not an error:
    /// the reader stops at the last complete record and sets `damaged_tail`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let mut file = File::open(path.as_ref())?;
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
        };
        reader.scan()?;
        Ok(reader)
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
    pub fn window(&mut self, frame_id: u64, count: usize) -> Result<Vec<LogRecord>, StorageError> {
        let mut records = Vec::with_capacity(count);
        for offset in 0..count as u64 {
            match self.read_at(frame_id + offset)? {
                Some(record) => records.push(record),
                None => break,
            }
        }
        Ok(records)
    }

    fn read_record_at(&mut self, position: u64) -> Result<RawChunk, StorageError> {
        let mut header = [0u8; RECORD_HEADER_LEN];
        self.file.seek(SeekFrom::Start(position))?;
        self.file.read_exact(&mut header)?;
        decode_record(&header)
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
