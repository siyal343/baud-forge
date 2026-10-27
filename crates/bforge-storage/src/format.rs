//! `.bflog` byte layout (FR-STO-01): file header and chunk record.

use crate::StorageError;
use bforge_hal::{Direction, PinStateFlags};

/// File signature of a `.bflog` container.
pub const MAGIC: [u8; 6] = *b"BFLG\x01\x00";
/// Size of the file header in bytes.
pub const HEADER_LEN: usize = 256;
/// Size of one chunk record header in bytes. Payload follows it directly.
pub const RECORD_HEADER_LEN: usize = 32;
/// Size of one data segment.
pub const SEGMENT_LEN: usize = 64 * 1024 * 1024;
/// One index entry per 1024 chunks.
pub const INDEX_STRIDE: u64 = 1024;

/// First 256 bytes of a `.bflog` file (FR-STO-01).
///
/// `offset` in the layout below is from the start of the file:
///
/// ```text
/// 0..6    magic BFLG\x01\x00
/// 6..22   session id, u128 little endian
/// 22..30  start of the session, Unix epoch nanoseconds, u64
/// 30..38  hash of the workspace configuration, u64
/// 38..46  file offset of the port descriptor table, u64
/// 46..256 zero, reserved
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LogHeader {
    pub session_id: u128,
    pub start_epoch_ns: u64,
    pub config_hash: u64,
    pub port_table_offset: u64,
}

impl LogHeader {
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0..6].copy_from_slice(&MAGIC);
        out[6..22].copy_from_slice(&self.session_id.to_le_bytes());
        out[22..30].copy_from_slice(&self.start_epoch_ns.to_le_bytes());
        out[30..38].copy_from_slice(&self.config_hash.to_le_bytes());
        out[38..46].copy_from_slice(&self.port_table_offset.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, StorageError> {
        if bytes.len() < HEADER_LEN {
            return Err(StorageError::ShortHeader(bytes.len()));
        }
        if bytes[0..6] != MAGIC {
            return Err(StorageError::BadMagic);
        }
        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&bytes[6..22]);
        Ok(Self {
            session_id: u128::from_le_bytes(session_id),
            start_epoch_ns: u64::from_le_bytes(bytes[22..30].try_into().unwrap()),
            config_hash: u64::from_le_bytes(bytes[30..38].try_into().unwrap()),
            port_table_offset: u64::from_le_bytes(bytes[38..46].try_into().unwrap()),
        })
    }
}

/// One record header. `payload_offset` is filled in by the writer.
///
/// ```text
/// 0..8    seq id, u64
/// 8..16   timestamp, nanoseconds, u64
/// 16..18  port id, u16
/// 18      direction, u8
/// 19..21  line state bitmask, u16
/// 21..24  zero, reserved
/// 24..28  payload length, u32
/// 28..32  zero, reserved
/// ```
pub fn encode_record(chunk: &crate::RawChunk) -> [u8; RECORD_HEADER_LEN] {
    let mut out = [0u8; RECORD_HEADER_LEN];
    out[0..8].copy_from_slice(&chunk.seq_id.to_le_bytes());
    out[8..16].copy_from_slice(&chunk.timestamp_ns.to_le_bytes());
    out[16..18].copy_from_slice(&chunk.port_id.to_le_bytes());
    out[18] = direction_code(chunk.direction);
    out[19..21].copy_from_slice(&chunk.line_state.0.to_le_bytes());
    out[24..28].copy_from_slice(&chunk.payload_len.to_le_bytes());
    out
}

/// Decode a record header. The payload offset is the file position of the
/// header plus `RECORD_HEADER_LEN`, which the reader sets.
pub fn decode_record(bytes: &[u8]) -> Result<crate::RawChunk, StorageError> {
    if bytes.len() < RECORD_HEADER_LEN {
        return Err(StorageError::Truncated);
    }
    let direction = direction_from_code(bytes[18])?;
    Ok(crate::RawChunk {
        seq_id: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        timestamp_ns: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        port_id: u16::from_le_bytes(bytes[16..18].try_into().unwrap()),
        direction,
        line_state: PinStateFlags(u16::from_le_bytes(bytes[19..21].try_into().unwrap())),
        payload_offset: 0,
        payload_len: u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
    })
}

fn direction_code(direction: Direction) -> u8 {
    match direction {
        Direction::Rx => 0,
        Direction::Tx => 1,
        Direction::MitmAToB => 2,
        Direction::MitmBToA => 3,
        Direction::InjectedFault => 4,
    }
}

fn direction_from_code(code: u8) -> Result<Direction, StorageError> {
    Ok(match code {
        0 => Direction::Rx,
        1 => Direction::Tx,
        2 => Direction::MitmAToB,
        3 => Direction::MitmBToA,
        4 => Direction::InjectedFault,
        other => return Err(StorageError::BadDirection(other)),
    })
}
