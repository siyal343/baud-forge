//! Framing pipeline and checksums (F1.4.1, F1.4.2, F1.4.6).
//!
//! Stage S3 implements delimiter and COBS framing plus three checksum engines.
//! SLIP, Intel HEX, sync-word and idle-gap framing are F1.4.3 to F1.4.5; the
//! [`Framing`] enum names them so a configuration can be validated before the
//! code that runs them exists.

pub mod checksum;
pub mod machine;

pub use checksum::{Checksum, crc8_atm, crc16_ccitt_false, crc32c};
pub use machine::{
    ByteMachine, Cobs, Delimiter, FrameError, cobs_decode, cobs_encode, machine_for,
};

/// Frame boundary rule of one port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Framing {
    /// Split on a single or multi-byte delimiter.
    Delimiter(Vec<u8>),
    /// Split on the zero byte, then COBS decode.
    Cobs,
    /// Split on `0xC0`, then SLIP decode (RFC 1055). F1.4.3.
    Slip,
    /// Intel HEX records. F1.4.3.
    IntelHex,
    /// Sync word, length field and trailing checksum. F1.4.4.
    HeaderLength {
        sync: Vec<u8>,
        length_offset: u8,
        length_width: LengthWidth,
        /// Added to the length field to get the total frame size.
        header_len_adjust: i32,
    },
    /// Split when the bus is silent for `micros` microseconds. F1.4.5.
    IdleGap { micros: u32 },
}

impl Framing {
    /// The name used in `.bforge.toml`.
    pub fn mode_name(&self) -> &'static str {
        match self {
            Self::Delimiter(_) => "delimiter",
            Self::Cobs => "cobs",
            Self::Slip => "slip",
            Self::IntelHex => "intel_hex",
            Self::HeaderLength { .. } => "header_length",
            Self::IdleGap { .. } => "idle_gap",
        }
    }

    /// True when this build can run the mode.
    pub fn is_implemented(&self) -> bool {
        matches!(self, Self::Delimiter(_) | Self::Cobs)
    }
}

/// Width and byte order of the length field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LengthWidth {
    U8,
    U16Le,
    U16Be,
    U32Le,
}

/// Every framing mode name a configuration may use.
pub const MODE_NAMES: [&str; 6] = [
    "delimiter",
    "cobs",
    "slip",
    "intel_hex",
    "header_length",
    "idle_gap",
];
