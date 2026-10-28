//! CCSDS Space Packet with an ECSS PUS secondary header (FR-DIS-02).
//!
//! Primary header, six bytes:
//!
//! ```text
//! 0..2  version (3) | type (1) | secondary header flag (1) | APID (11)
//! 2..4  sequence flags (2) | sequence count (14)
//! 4..6  packet data length (16), one less than the bytes that follow
//! ```
//!
//! When the secondary header flag is set, the payload starts with the PUS header:
//! version (4), time reference status (4), service (8), subservice (8).

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;

/// Which direction the packet claims to travel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Telemetry,
    Telecommand,
}

impl Direction {
    fn code(self) -> u8 {
        match self {
            Self::Telemetry => 0,
            Self::Telecommand => 1,
        }
    }
}

/// Decode one space packet.
pub fn decode(frame: &[u8], direction: Direction) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 6, "ccsds primary header")?;

    let word = u16::from_be_bytes([frame[0], frame[1]]);
    let version = (word >> 13) & 0x07;
    let packet_type = ((word >> 12) & 0x01) as u8;
    let secondary_header = (word >> 11) & 0x01 == 1;
    let apid = word & 0x07FF;

    let sequence = u16::from_be_bytes([frame[2], frame[3]]);
    let sequence_flags = (sequence >> 14) & 0x03;
    let sequence_count = sequence & 0x3FFF;
    let declared = u16::from_be_bytes([frame[4], frame[5]]) as usize + 1;

    let mut fields = vec![
        field(
            "version",
            0,
            2,
            version.to_string(),
            Some(f64::from(version)),
        ),
        field(
            "type",
            0,
            2,
            if packet_type == 0 { "TM" } else { "TC" }.to_string(),
            Some(f64::from(packet_type)),
        ),
        field(
            "type_matches_pack",
            0,
            2,
            (packet_type == direction.code()).to_string(),
            None,
        ),
        field("secondary_header", 0, 2, secondary_header.to_string(), None),
        field("apid", 0, 2, apid.to_string(), Some(f64::from(apid))),
        field(
            "sequence_flags",
            2,
            2,
            sequence_flag_name(sequence_flags).to_string(),
            Some(f64::from(sequence_flags)),
        ),
        field(
            "sequence_count",
            2,
            2,
            sequence_count.to_string(),
            Some(f64::from(sequence_count)),
        ),
        field(
            "data_length",
            4,
            2,
            declared.to_string(),
            Some(declared as f64),
        ),
    ];

    let available = frame.len().saturating_sub(6);
    fields.push(field(
        "payload_bytes_present",
        6,
        available as u32,
        available.to_string(),
        Some(available as f64),
    ));
    if available != declared {
        fields.push(field(
            "length_mismatch",
            4,
            2,
            format!("header says {declared}, frame holds {available}"),
            None,
        ));
    }

    let mut payload_at = 6;
    if secondary_header {
        require(frame, 9, "pus secondary header")?;
        let pus = frame[6];
        fields.push(field(
            "pus.version",
            6,
            1,
            ((pus >> 4) & 0x0F).to_string(),
            Some(f64::from((pus >> 4) & 0x0F)),
        ));
        fields.push(field(
            "pus.time_reference",
            6,
            1,
            (pus & 0x0F).to_string(),
            Some(f64::from(pus & 0x0F)),
        ));
        fields.push(field(
            "service_type",
            7,
            1,
            frame[7].to_string(),
            Some(f64::from(frame[7])),
        ));
        fields.push(field(
            "service_subtype",
            8,
            1,
            frame[8].to_string(),
            Some(f64::from(frame[8])),
        ));
        payload_at = 9;
    }

    let user_data = frame.len().saturating_sub(payload_at);
    fields.push(field(
        "user_data_bytes",
        payload_at as u32,
        user_data as u32,
        user_data.to_string(),
        Some(user_data as f64),
    ));
    Ok(fields)
}

fn sequence_flag_name(flags: u16) -> &'static str {
    match flags {
        0b00 => "continuation",
        0b01 => "first",
        0b10 => "last",
        _ => "standalone",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// APID 0x123, sequence count 7, standalone, PUS service 3 subservice 25, and two
    /// bytes of user data.
    fn telemetry_packet() -> Vec<u8> {
        let mut frame = Vec::new();
        // Version 0, type 0 (telemetry), secondary header present, APID 0x123.
        let word: u16 = (1 << 11) | 0x0123;
        frame.extend_from_slice(&word.to_be_bytes());
        frame.extend_from_slice(&((0b11u16 << 14) | 7).to_be_bytes());
        // PUS header 3 bytes plus 2 bytes of user data is 5, so the length is 4.
        frame.extend_from_slice(&4u16.to_be_bytes());
        frame.push(0x10); // PUS version 1, time reference 0
        frame.push(3); // service: housekeeping
        frame.push(25); // subservice
        frame.extend_from_slice(&[0xBE, 0xEF]);
        frame
    }

    fn value_of(fields: &[DecodedField], name: &str) -> String {
        fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("no field {name} in {fields:?}"))
            .value
            .clone()
    }

    #[test]
    fn a_telemetry_packet_decodes_field_by_field() {
        let fields = decode(&telemetry_packet(), Direction::Telemetry).unwrap();
        assert_eq!(value_of(&fields, "version"), "0");
        assert_eq!(value_of(&fields, "type"), "TM");
        assert_eq!(value_of(&fields, "type_matches_pack"), "true");
        assert_eq!(value_of(&fields, "secondary_header"), "true");
        assert_eq!(value_of(&fields, "apid"), "291");
        assert_eq!(value_of(&fields, "sequence_flags"), "standalone");
        assert_eq!(value_of(&fields, "sequence_count"), "7");
        assert_eq!(value_of(&fields, "data_length"), "5");
        assert_eq!(value_of(&fields, "payload_bytes_present"), "5");
        assert_eq!(value_of(&fields, "pus.version"), "1");
        assert_eq!(value_of(&fields, "service_type"), "3");
        assert_eq!(value_of(&fields, "service_subtype"), "25");
        assert_eq!(value_of(&fields, "user_data_bytes"), "2");
        assert!(!fields.iter().any(|field| field.name == "length_mismatch"));
    }

    #[test]
    fn a_declared_length_that_does_not_match_is_flagged_not_hidden() {
        let mut frame = telemetry_packet();
        frame.push(0x00);
        let fields = decode(&frame, Direction::Telemetry).unwrap();
        let mismatch = fields
            .iter()
            .find(|field| field.name == "length_mismatch")
            .expect("a length mismatch");
        assert!(mismatch.value.contains('5'), "{}", mismatch.value);
        assert!(mismatch.value.contains('6'), "{}", mismatch.value);
    }

    #[test]
    fn a_telemetry_pack_marks_a_telecommand() {
        let mut frame = telemetry_packet();
        frame[0] |= 0b0001_0000;
        let fields = decode(&frame, Direction::Telemetry).unwrap();
        assert_eq!(value_of(&fields, "type_matches_pack"), "false");
    }

    #[test]
    fn a_short_frame_names_what_is_missing() {
        let error = decode(&[0x08, 0x23], Direction::Telemetry).unwrap_err();
        assert!(
            error.to_string().contains("ccsds primary header"),
            "{error}"
        );
    }
}
