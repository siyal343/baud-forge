//! Framing pipeline and checksums (FR-FRM-01).
//!
//! Setup only: the framing rules are listed, no algorithm is implemented.

/// Frame boundary rule of one port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Framing {
    /// Split on a single or multi-byte delimiter.
    Delimiter(Vec<u8>),
    /// Split on the zero byte, then COBS decode.
    Cobs,
    /// Split on `0xC0`, then SLIP decode (RFC 1055).
    Slip,
    IntelHex,
    /// Sync word, length field and trailing checksum.
    HeaderLength {
        sync: Vec<u8>,
        length_offset: u8,
        length_width: LengthWidth,
        /// Added to the length field to get the total frame size.
        header_len_adjust: i32,
    },
    /// Split when the bus is silent for `micros` microseconds.
    IdleGap { micros: u32 },
}

/// Width and byte order of the length field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthWidth {
    U8,
    U16Le,
    U16Be,
    U32Le,
}

/// Checksum engine named by a port configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checksum {
    Crc8Atm,
    Crc16CcittFalse,
    Crc32c,
}
