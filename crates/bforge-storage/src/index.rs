//! Persisted sparse index (F1.3.5).
//!
//! Scanning every record header on open costs one seek per record, so a 100 GB
//! vault is slow to open. The writer therefore saves its own index beside the
//! vault as `<vault>.bfidx`, and the reader uses it when it matches the file.
//!
//! The file is a rebuildable cache. A missing, truncated or stale index is not an
//! error: the reader scans and moves on.

use crate::IndexEntry;
use std::path::{Path, PathBuf};

/// Index file signature.
pub const INDEX_MAGIC: [u8; 6] = *b"BFIX\x01\x00";
/// Version of the index layout.
pub const INDEX_VERSION: u16 = 1;
/// Size of the index header.
pub const INDEX_HEADER_LEN: usize = 32;
/// Size of one index entry.
pub const INDEX_ENTRY_LEN: usize = 24;

/// Where the index for a vault lives.
pub fn index_path(vault: &Path) -> PathBuf {
    let mut path = vault.as_os_str().to_owned();
    path.push(".bfidx");
    PathBuf::from(path)
}

/// Serialize an index. `data_len` ties it to one exact vault, and `chunks` lets
/// the reader state the record count without scanning.
pub fn encode(data_len: u64, chunks: u64, entries: &[IndexEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(INDEX_HEADER_LEN + entries.len() * INDEX_ENTRY_LEN);
    out.extend_from_slice(&INDEX_MAGIC);
    out.extend_from_slice(&INDEX_VERSION.to_le_bytes());
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&chunks.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.resize(INDEX_HEADER_LEN, 0);

    for entry in entries {
        out.extend_from_slice(&entry.timestamp_ns.to_le_bytes());
        out.extend_from_slice(&entry.frame_id.to_le_bytes());
        out.extend_from_slice(&entry.file_offset.to_le_bytes());
    }
    out
}

/// Read an index. `None` means unusable: wrong magic, wrong version, short file,
/// or a count that does not match the length.
pub fn decode(bytes: &[u8]) -> Option<(u64, u64, Vec<IndexEntry>)> {
    if bytes.len() < INDEX_HEADER_LEN || bytes[0..6] != INDEX_MAGIC {
        return None;
    }
    if u16::from_le_bytes(bytes[6..8].try_into().ok()?) != INDEX_VERSION {
        return None;
    }
    let data_len = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let chunks = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let count = u32::from_le_bytes(bytes[24..28].try_into().ok()?) as usize;
    if bytes.len() != INDEX_HEADER_LEN + count * INDEX_ENTRY_LEN {
        return None;
    }

    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        let at = INDEX_HEADER_LEN + index * INDEX_ENTRY_LEN;
        entries.push(IndexEntry {
            timestamp_ns: u64::from_le_bytes(bytes[at..at + 8].try_into().ok()?),
            frame_id: u64::from_le_bytes(bytes[at + 8..at + 16].try_into().ok()?),
            file_offset: u64::from_le_bytes(bytes[at + 16..at + 24].try_into().ok()?),
        });
    }
    Some((data_len, chunks, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_round_trips() {
        let entries = vec![
            IndexEntry {
                timestamp_ns: 10,
                frame_id: 0,
                file_offset: 256,
            },
            IndexEntry {
                timestamp_ns: 20,
                frame_id: 1024,
                file_offset: 40_000,
            },
        ];
        let bytes = encode(100_000, 2_048, &entries);
        assert_eq!(bytes.len(), INDEX_HEADER_LEN + 2 * INDEX_ENTRY_LEN);
        assert_eq!(decode(&bytes), Some((100_000, 2_048, entries)));
    }

    #[test]
    fn a_damaged_index_is_refused() {
        let entries = vec![IndexEntry {
            timestamp_ns: 1,
            frame_id: 0,
            file_offset: 256,
        }];
        let mut bytes = encode(1_000, 1, &entries);
        assert!(decode(&bytes[..10]).is_none());

        bytes[0] = b'X';
        assert!(decode(&bytes).is_none());

        let mut wrong_version = encode(1_000, 1, &entries);
        wrong_version[6] = 9;
        assert!(decode(&wrong_version).is_none());

        let mut short = encode(1_000, 1, &entries);
        short.pop();
        assert!(decode(&short).is_none());
    }

    #[test]
    fn the_index_sits_beside_the_vault() {
        assert_eq!(
            index_path(Path::new("run.bflog")),
            PathBuf::from("run.bflog.bfidx")
        );
    }
}
