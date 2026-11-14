//! CubeSat Space Protocol, version 1 (FR-DIS-02).
//!
//! The first word packs six fields, most significant bit first:
//!
//! ```text
//! bits 31..30  priority
//! bits 29..25  source address
//! bits 24..20  destination address
//! bits 19..14  destination port
//! bits 13..8   source port
//! bits  7..0   flags
//! ```
//!
//! A CRC-32 is optional in CSP and sits in the last four bytes of the frame. The
//! flags byte says whether it is present, so the pack verifies it only when the
//! sender claims one.

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;

/// Decode one CSP v1 packet.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 4, "csp header")?;

    let word = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
    let priority = ((word >> 30) & 0x03) as u8;
    let source = ((word >> 25) & 0x1F) as u8;
    let destination = ((word >> 20) & 0x1F) as u8;
    let destination_port = ((word >> 14) & 0x3F) as u8;
    let source_port = ((word >> 8) & 0x3F) as u8;
    let flags = (word & 0xFF) as u8;

    let mut fields = vec![
        field(
            "priority",
            0,
            4,
            priority.to_string(),
            Some(f64::from(priority)),
        ),
        field("source", 0, 4, source.to_string(), Some(f64::from(source))),
        field(
            "destination",
            0,
            4,
            destination.to_string(),
            Some(f64::from(destination)),
        ),
        field(
            "destination_port",
            0,
            4,
            destination_port.to_string(),
            Some(f64::from(destination_port)),
        ),
        field(
            "source_port",
            0,
            4,
            source_port.to_string(),
            Some(f64::from(source_port)),
        ),
        field(
            "flags",
            3,
            1,
            format!("0x{flags:02X}"),
            Some(f64::from(flags)),
        ),
    ];

    // CSP flag bit 0 (CRCT) asks for a CRC-32 over everything before it.
    let crc_present = flags & 0x01 != 0;
    let payload_end = if crc_present {
        frame.len().saturating_sub(4)
    } else {
        frame.len()
    };
    let payload_bytes = payload_end.saturating_sub(4);
    fields.push(field(
        "payload_bytes",
        4,
        payload_bytes as u32,
        payload_bytes.to_string(),
        Some(payload_bytes as f64),
    ));

    if crc_present {
        require(frame, 8, "csp crc32")?;
        // libCSP writes the checksum big-endian (`htobe32` before the memcpy in
        // `csp_crc32_append`), and before CSP 2.1 it covers the payload only,
        // not the four header bytes.
        let expected = u32::from_be_bytes([
            frame[payload_end],
            frame[payload_end + 1],
            frame[payload_end + 2],
            frame[payload_end + 3],
        ]);
        let actual = crc32(&frame[4..payload_end]);
        fields.push(field(
            "crc32",
            payload_end as u32,
            4,
            format!("0x{expected:08X}"),
            Some(f64::from(expected)),
        ));
        fields.push(field(
            "crc32_valid",
            payload_end as u32,
            4,
            (expected == actual).to_string(),
            None,
        ));
    }

    Ok(fields)
}

/// CRC-32 as libCSP computes it: the reflected IEEE polynomial (0xEDB88320)
/// with initial value 0xFFFFFFFF and a final xor — the same algorithm zlib
/// uses, whose published check value for "123456789" is 0xCBF43926. The old
/// MSB-first no-xor variant here judged every genuine frame invalid.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
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

    /// Priority 1, source 5, destination 9, destination port 12, source port 3.
    fn header() -> u32 {
        (1u32 << 30) | (5 << 25) | (9 << 20) | (12 << 14) | (3 << 8)
    }

    fn value_of(fields: &[DecodedField], name: &str) -> String {
        fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("no field {name}"))
            .value
            .clone()
    }

    #[test]
    fn a_csp_header_decodes_every_field() {
        let frame = header().to_be_bytes();
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "priority"), "1");
        assert_eq!(value_of(&fields, "source"), "5");
        assert_eq!(value_of(&fields, "destination"), "9");
        assert_eq!(value_of(&fields, "destination_port"), "12");
        assert_eq!(value_of(&fields, "source_port"), "3");
        assert_eq!(value_of(&fields, "flags"), "0x00");
        assert_eq!(value_of(&fields, "payload_bytes"), "0");
    }

    #[test]
    fn the_crc_matches_the_libcsp_reference() {
        // The check value every CRC-32/ISO-HDLC implementation (zlib, libCSP)
        // publishes for "123456789". This anchors the algorithm to the
        // reference instead of to this pack's own fixture.
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn payload_bytes_are_counted_and_a_crc_is_verified_when_asked_for() {
        let mut frame = (header() | 0x01).to_be_bytes().to_vec(); // CRCT flag set
        frame.extend_from_slice(b"abc");
        // libCSP: payload only, big-endian on the wire.
        let crc = crc32(&frame[4..]);
        frame.extend_from_slice(&crc.to_be_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "payload_bytes"), "3");
        assert_eq!(value_of(&fields, "crc32_valid"), "true");
    }

    #[test]
    fn a_swapped_crc_endian_is_reported_as_invalid() {
        let mut frame = (header() | 0x01).to_be_bytes().to_vec();
        frame.extend_from_slice(b"abc");
        let crc = crc32(&frame[4..]);
        frame.extend_from_slice(&crc.swap_bytes().to_be_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "crc32_valid"), "false");
    }

    #[test]
    fn a_wrong_crc_is_reported_as_invalid() {
        let mut frame = (header() | 0x01).to_be_bytes().to_vec();
        frame.extend_from_slice(b"abc");
        frame.extend_from_slice(&0xDEAD_BEEFu32.to_be_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "crc32_valid"), "false");
        assert_eq!(value_of(&fields, "crc32"), "0xDEADBEEF");
    }

    #[test]
    fn a_frame_too_short_for_a_crc_says_so() {
        let frame = (header() | 0x01).to_be_bytes();
        let error = decode(&frame).unwrap_err();
        assert!(error.to_string().contains("csp crc32"), "{error}");
    }
}
