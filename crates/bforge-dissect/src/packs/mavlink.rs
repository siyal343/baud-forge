//! MAVLink v1 and v2 (FR-DIS-02, D-56).
//!
//! ```text
//! v1  0xFE  len seq sysid compid msgid                    payload  crc16
//! v2  0xFD  len incompat compat seq sysid compid msgid(3) payload  crc16
//! ```
//!
//! The envelope is fixed and is decoded for every frame. The message bodies need a dialect,
//! so four messages that every autopilot speaks are decoded by field offset, and any other
//! `msgid` keeps its id and shows the payload as hex. A wrong offset prints a confident
//! number from the wrong bytes, which is worse than an unanswered question.
//!
//! The checksum is X.25/CRC-16-MCRF4XX over the header and payload **plus a CRC_EXTRA byte**
//! that comes from the dialect, so this pack reports the checksum it read and does not claim
//! to have verified it.

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;

/// Length of the frame trailer.
const CRC_LEN: usize = 2;

/// Decode one MAVLink frame.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 8, "mavlink frame")?;
    let magic = frame[0];
    let version = match magic {
        0xFE => 1u8,
        0xFD => 2u8,
        other => {
            return Err(ExecError::Unsupported(format!(
                "0x{other:02X} is not a MAVLink start byte (0xFE v1, 0xFD v2)"
            )));
        }
    };

    let payload_len = frame[1] as usize;
    let (header_len, seq_at, msgid, msgid_at) = if version == 1 {
        require(frame, 6, "mavlink v1 header")?;
        (6usize, 2usize, u32::from(frame[5]), 5usize)
    } else {
        require(frame, 10, "mavlink v2 header")?;
        let id = u32::from(frame[7]) | (u32::from(frame[8]) << 8) | (u32::from(frame[9]) << 16);
        (10usize, 4usize, id, 7usize)
    };

    let payload_at = header_len;
    require(
        frame,
        payload_at + payload_len + CRC_LEN,
        "mavlink payload and checksum",
    )?;

    let mut fields = vec![
        field(
            "version",
            0,
            1,
            format!("v{version}"),
            Some(f64::from(version)),
        ),
        field(
            "payload_len",
            1,
            1,
            payload_len.to_string(),
            Some(payload_len as f64),
        ),
    ];
    if version == 2 {
        let incompat = frame[2];
        let compat = frame[3];
        fields.push(field(
            "incompat_flags",
            2,
            1,
            format!("0x{incompat:02X}"),
            Some(f64::from(incompat)),
        ));
        fields.push(field(
            "compat_flags",
            3,
            1,
            format!("0x{compat:02X}"),
            Some(f64::from(compat)),
        ));
        // A set incompatibility flag means the frame uses a feature this reader may not
        // know, so saying so is part of reading it correctly.
        if incompat & 0x01 != 0 {
            fields.push(field(
                "signed",
                2,
                1,
                "frame is signed; the signature follows the checksum".to_string(),
                None,
            ));
        }
    }
    fields.push(field(
        "sequence",
        seq_at as u32,
        1,
        frame[seq_at].to_string(),
        Some(f64::from(frame[seq_at])),
    ));
    fields.push(field(
        "system_id",
        (seq_at + 1) as u32,
        1,
        frame[seq_at + 1].to_string(),
        Some(f64::from(frame[seq_at + 1])),
    ));
    fields.push(field(
        "component_id",
        (seq_at + 2) as u32,
        1,
        frame[seq_at + 2].to_string(),
        Some(f64::from(frame[seq_at + 2])),
    ));
    fields.push(field(
        "msgid",
        msgid_at as u32,
        version as u32,
        format!("{msgid} ({})", message_name(msgid)),
        Some(f64::from(msgid)),
    ));

    let payload = &frame[payload_at..payload_at + payload_len];
    match decode_body(msgid, payload, payload_at as u32) {
        Some(body) => fields.extend(body),
        None => fields.push(field(
            "payload",
            payload_at as u32,
            payload_len as u32,
            hex(payload),
            None,
        )),
    }

    let crc_at = payload_at + payload_len;
    let crc = u16::from_le_bytes([frame[crc_at], frame[crc_at + 1]]);
    fields.push(field(
        "checksum",
        crc_at as u32,
        2,
        format!("0x{crc:04X} (needs the dialect's CRC_EXTRA to verify)"),
        Some(f64::from(crc)),
    ));
    Ok(fields)
}

/// The messages decoded by offset, and nothing else.
fn decode_body(msgid: u32, payload: &[u8], base: u32) -> Option<Vec<DecodedField>> {
    match msgid {
        // 0 HEARTBEAT: custom_mode u32, type, autopilot, base_mode, system_status, version.
        0 if payload.len() >= 9 => Some(vec![
            number("custom_mode", base, payload, 0, 4),
            byte("type", base, payload, 4),
            byte("autopilot", base, payload, 5),
            byte("base_mode", base, payload, 6),
            byte("system_status", base, payload, 7),
            byte("mavlink_version", base, payload, 8),
        ]),
        // 30 ATTITUDE: time_boot_ms, roll, pitch, yaw, rollspeed, pitchspeed, yawspeed.
        30 if payload.len() >= 28 => Some(vec![
            number("time_boot_ms", base, payload, 0, 4),
            real("roll", base, payload, 4),
            real("pitch", base, payload, 8),
            real("yaw", base, payload, 12),
            real("rollspeed", base, payload, 16),
            real("pitchspeed", base, payload, 20),
            real("yawspeed", base, payload, 24),
        ]),
        // 33 GLOBAL_POSITION_INT: time_boot_ms, lat, lon, alt, relative_alt, vx, vy, vz, hdg.
        33 if payload.len() >= 28 => Some(vec![
            number("time_boot_ms", base, payload, 0, 4),
            signed("lat", base, payload, 4, 4),
            signed("lon", base, payload, 8, 4),
            signed("alt", base, payload, 12, 4),
            signed("relative_alt", base, payload, 16, 4),
            signed("vx", base, payload, 20, 2),
            signed("vy", base, payload, 22, 2),
            signed("vz", base, payload, 24, 2),
            number("hdg", base, payload, 26, 2),
        ]),
        // 24 GPS_RAW_INT: time_usec, fix_type, lat, lon, alt, eph, epv, vel, cog, satellites.
        24 if payload.len() >= 30 => Some(vec![
            number("time_usec", base, payload, 0, 8),
            byte("fix_type", base, payload, 8),
            signed("lat", base, payload, 9, 4),
            signed("lon", base, payload, 13, 4),
            signed("alt", base, payload, 17, 4),
            number("eph", base, payload, 21, 2),
            number("epv", base, payload, 23, 2),
            number("vel", base, payload, 25, 2),
            number("cog", base, payload, 27, 2),
            byte("satellites_visible", base, payload, 29),
        ]),
        _ => None,
    }
}

/// Message names, so a `msgid` of 30 reads as something a person can search for.
fn message_name(msgid: u32) -> &'static str {
    match msgid {
        0 => "HEARTBEAT",
        1 => "SYS_STATUS",
        2 => "SYSTEM_TIME",
        24 => "GPS_RAW_INT",
        30 => "ATTITUDE",
        33 => "GLOBAL_POSITION_INT",
        74 => "VFR_HUD",
        76 => "COMMAND_LONG",
        77 => "COMMAND_ACK",
        253 => "STATUSTEXT",
        _ => "unknown",
    }
}

fn number(name: &str, base: u32, payload: &[u8], at: usize, width: usize) -> DecodedField {
    let raw = le(payload, at, width);
    field(
        name,
        base + at as u32,
        width as u32,
        raw.to_string(),
        Some(raw as f64),
    )
}

fn signed(name: &str, base: u32, payload: &[u8], at: usize, width: usize) -> DecodedField {
    let raw = le(payload, at, width);
    // Two's complement, widened to i64 so the width does not have to be matched.
    let value = match width {
        1 => f64::from(raw as u8 as i8),
        2 => f64::from(raw as u16 as i16),
        4 => f64::from(raw as u32 as i32),
        _ => raw as f64,
    };
    field(
        name,
        base + at as u32,
        width as u32,
        format!("{value:.0}"),
        Some(value),
    )
}

fn byte(name: &str, base: u32, payload: &[u8], at: usize) -> DecodedField {
    field(
        name,
        base + at as u32,
        1,
        payload[at].to_string(),
        Some(f64::from(payload[at])),
    )
}

/// A 32-bit float, which is how MAVLink sends angles and speeds.
fn real(name: &str, base: u32, payload: &[u8], at: usize) -> DecodedField {
    let bits = le(payload, at, 4) as u32;
    let value = f32::from_bits(bits);
    field(
        name,
        base + at as u32,
        4,
        format!("{value:.4}"),
        Some(f64::from(value)),
    )
}

/// Little endian, any width up to eight bytes.
fn le(payload: &[u8], at: usize, width: usize) -> u64 {
    let mut value = 0u64;
    for index in 0..width {
        value |= u64::from(payload[at + index]) << (8 * index);
    }
    value
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of(fields: &[DecodedField], name: &str) -> String {
        fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("no field `{name}` in {fields:?}"))
            .value
            .clone()
    }

    /// A v1 HEARTBEAT: quadrotor, ArduPilot, armed, system 1, component 1.
    fn heartbeat_v1() -> Vec<u8> {
        let mut frame = vec![0xFE, 9, 42, 1, 1, 0];
        frame.extend_from_slice(&0x0000_0004u32.to_le_bytes()); // custom_mode
        frame.push(2); // MAV_TYPE_QUADROTOR
        frame.push(3); // MAV_AUTOPILOT_ARDUPILOTMEGA
        frame.push(0x81); // base_mode: armed + custom
        frame.push(4); // MAV_STATE_ACTIVE
        frame.push(3); // mavlink_version
        frame.extend_from_slice(&0x1234u16.to_le_bytes()); // checksum
        frame
    }

    #[test]
    fn a_heartbeat_reads_its_header_and_its_modes() {
        let fields = decode(&heartbeat_v1()).unwrap();
        assert_eq!(value_of(&fields, "version"), "v1");
        assert_eq!(value_of(&fields, "payload_len"), "9");
        assert_eq!(value_of(&fields, "sequence"), "42");
        assert_eq!(value_of(&fields, "system_id"), "1");
        assert_eq!(value_of(&fields, "component_id"), "1");
        assert_eq!(value_of(&fields, "msgid"), "0 (HEARTBEAT)");
        assert_eq!(value_of(&fields, "type"), "2");
        assert_eq!(value_of(&fields, "autopilot"), "3");
        assert_eq!(value_of(&fields, "base_mode"), "129");
        assert_eq!(value_of(&fields, "mavlink_version"), "3");
        assert!(
            value_of(&fields, "checksum").contains("0x1234"),
            "{fields:?}"
        );
    }

    #[test]
    fn a_v2_frame_carries_its_flags_and_a_three_byte_message_id() {
        let mut frame = vec![0xFD, 9, 0x00, 0x00, 7, 1, 1, 0, 0, 0];
        frame.extend_from_slice(&0u32.to_le_bytes());
        frame.extend_from_slice(&[2, 3, 0x81, 4, 3]);
        frame.extend_from_slice(&0u16.to_le_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "version"), "v2");
        assert_eq!(value_of(&fields, "incompat_flags"), "0x00");
        assert_eq!(value_of(&fields, "sequence"), "7");
        assert_eq!(value_of(&fields, "msgid"), "0 (HEARTBEAT)");
        assert_eq!(value_of(&fields, "system_status"), "4");
    }

    #[test]
    fn attitude_floats_read_as_degrees() {
        let mut frame = vec![0xFE, 28, 1, 1, 1, 30];
        frame.extend_from_slice(&1000u32.to_le_bytes()); // time_boot_ms
        for angle in [0.5f32, -0.25, 1.5, 0.0, 0.0, 0.125] {
            frame.extend_from_slice(&angle.to_le_bytes());
        }
        frame.extend_from_slice(&0u16.to_le_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "msgid"), "30 (ATTITUDE)");
        assert_eq!(value_of(&fields, "time_boot_ms"), "1000");
        assert_eq!(value_of(&fields, "roll"), "0.5000");
        assert_eq!(value_of(&fields, "pitch"), "-0.2500");
        assert_eq!(value_of(&fields, "yawspeed"), "0.1250");
    }

    #[test]
    fn a_signed_latitude_reads_as_negative() {
        let mut frame = vec![0xFE, 28, 1, 1, 1, 33];
        frame.extend_from_slice(&0u32.to_le_bytes());
        frame.extend_from_slice(&(-355_000_000i32).to_le_bytes()); // lat
        frame.extend_from_slice(&1_490_000_000i32.to_le_bytes()); // lon
        frame.extend_from_slice(&500_000i32.to_le_bytes()); // alt
        frame.extend_from_slice(&10_000i32.to_le_bytes()); // relative_alt
        frame.extend_from_slice(&1i16.to_le_bytes());
        frame.extend_from_slice(&2i16.to_le_bytes());
        frame.extend_from_slice(&(-3i16).to_le_bytes());
        frame.extend_from_slice(&180u16.to_le_bytes());
        frame.extend_from_slice(&0u16.to_le_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "msgid"), "33 (GLOBAL_POSITION_INT)");
        assert_eq!(value_of(&fields, "lat"), "-355000000");
        assert_eq!(value_of(&fields, "lon"), "1490000000");
        assert_eq!(value_of(&fields, "vz"), "-3");
        assert_eq!(value_of(&fields, "hdg"), "180");
    }

    #[test]
    fn an_unknown_message_keeps_its_id_and_its_bytes() {
        let mut frame = vec![0xFE, 3, 1, 1, 1, 200];
        frame.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        frame.extend_from_slice(&0u16.to_le_bytes());

        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "msgid"), "200 (unknown)");
        assert_eq!(value_of(&fields, "payload"), "AA BB CC");
    }

    #[test]
    fn a_short_frame_names_what_is_missing() {
        let error = decode(&[0xFE, 9, 0, 1, 1, 0]).unwrap_err();
        assert!(error.to_string().contains("mavlink"), "{error}");
    }

    #[test]
    fn a_frame_that_does_not_start_with_a_magic_byte_is_refused() {
        let error = decode(&[0x55, 9, 0, 1, 1, 0, 0, 0]).unwrap_err();
        assert!(error.to_string().contains("start byte"), "{error}");
    }
}
