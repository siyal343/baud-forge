//! Checksum engines (F1.4.6).
//!
//! Published check values for the ASCII string `123456789` are asserted in the
//! tests, so a change to any engine is caught immediately.

/// A checksum named by a port configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checksum {
    /// CRC-8/ATM, polynomial 0x07, initial value 0x00.
    Crc8Atm,
    /// CRC-16/CCITT-FALSE, polynomial 0x1021, initial value 0xFFFF.
    Crc16CcittFalse,
    /// CRC-32C, Castagnoli, reflected polynomial 0x82F63B78.
    Crc32c,
}

impl Checksum {
    /// Read a checksum name from a `.bforge.toml` port.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "crc8" | "crc8_atm" => Some(Self::Crc8Atm),
            "crc16" | "crc16_ccitt_false" => Some(Self::Crc16CcittFalse),
            "crc32c" => Some(Self::Crc32c),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Crc8Atm => "crc8_atm",
            Self::Crc16CcittFalse => "crc16_ccitt_false",
            Self::Crc32c => "crc32c",
        }
    }

    /// Width in bits, so a caller can cut the value to size before it writes it.
    pub fn width(self) -> u8 {
        match self {
            Self::Crc8Atm => 8,
            Self::Crc16CcittFalse => 16,
            Self::Crc32c => 32,
        }
    }

    /// Compute the checksum over `data`, right-aligned in a `u32`.
    pub fn compute(self, data: &[u8]) -> u32 {
        match self {
            Self::Crc8Atm => u32::from(crc8_atm(data)),
            Self::Crc16CcittFalse => u32::from(crc16_ccitt_false(data)),
            Self::Crc32c => crc32c(data),
        }
    }
}

/// CRC-8/ATM: polynomial 0x07, initial value 0x00.
pub fn crc8_atm(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &byte in data {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF.
pub fn crc16_ccitt_false(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &byte in data {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// CRC-32C (Castagnoli): reflected polynomial 0x82F63B78.
pub fn crc32c(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x82F6_3B78
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_check_values() {
        let data = b"123456789";
        assert_eq!(crc8_atm(data), 0xF4);
        assert_eq!(crc16_ccitt_false(data), 0x29B1);
        assert_eq!(crc32c(data), 0xE306_9283);
    }

    #[test]
    fn names_round_trip_and_reject_typos() {
        for checksum in [
            Checksum::Crc8Atm,
            Checksum::Crc16CcittFalse,
            Checksum::Crc32c,
        ] {
            assert_eq!(Checksum::from_name(checksum.name()), Some(checksum));
        }
        assert_eq!(Checksum::from_name("crc32"), None);
        assert_eq!(Checksum::from_name("CRC32C"), None);
    }

    #[test]
    fn compute_matches_the_engine_and_the_width() {
        let data = b"123456789";
        assert_eq!(Checksum::Crc8Atm.compute(data), 0xF4);
        assert_eq!(Checksum::Crc16CcittFalse.compute(data), 0x29B1);
        assert_eq!(Checksum::Crc32c.compute(data), 0xE306_9283);
        assert_eq!(Checksum::Crc8Atm.width(), 8);
        assert_eq!(Checksum::Crc32c.width(), 32);
    }

    #[test]
    fn a_changed_byte_changes_every_checksum() {
        let original = b"bforge frame";
        let mut damaged = *original;
        damaged[4] ^= 0x01;
        for checksum in [
            Checksum::Crc8Atm,
            Checksum::Crc16CcittFalse,
            Checksum::Crc32c,
        ] {
            assert_ne!(
                checksum.compute(original),
                checksum.compute(&damaged),
                "{} missed a single bit flip",
                checksum.name()
            );
        }
    }
}
