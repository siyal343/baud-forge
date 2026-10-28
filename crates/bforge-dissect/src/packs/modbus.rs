//! Modbus RTU application data unit (FR-DIS-02).
//!
//! ```text
//! 0     slave address
//! 1     function code
//! 2..   data, laid out by the function
//! last 2  CRC-16/Modbus, little endian on the wire
//! ```
//!
//! The data layout depends on the function and on whether the frame is a request or
//! a response. The pack decodes the fields it can prove from the length: a request
//! is 8 bytes for the register functions, so a request and a response of the same
//! function cannot be confused. Anything else keeps address, function and CRC, which
//! is still enough to see which frame failed.

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;

/// Decode one Modbus RTU frame.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 4, "modbus frame")?;

    let slave = frame[0];
    let function = frame[1];
    let body_end = frame.len() - 2;
    let expected = u16::from_le_bytes([frame[body_end], frame[body_end + 1]]);
    let actual = crc16_modbus(&frame[..body_end]);

    let mut fields = vec![
        field("slave", 0, 1, slave.to_string(), Some(f64::from(slave))),
        field(
            "function",
            1,
            1,
            format!("0x{function:02X}"),
            Some(f64::from(function)),
        ),
        field(
            "function_name",
            1,
            1,
            function_name(function).to_string(),
            None,
        ),
        field(
            "data_bytes",
            2,
            (body_end.saturating_sub(2)) as u32,
            body_end.saturating_sub(2).to_string(),
            Some(body_end.saturating_sub(2) as f64),
        ),
        field(
            "crc16",
            body_end as u32,
            2,
            format!("0x{expected:04X}"),
            Some(f64::from(expected)),
        ),
        field(
            "crc16_valid",
            body_end as u32,
            2,
            (expected == actual).to_string(),
            None,
        ),
    ];

    // A CRC error on the wire is also reported by the exception layout below.
    if function & 0x80 != 0 && body_end >= 3 {
        fields.push(field(
            "exception",
            2,
            1,
            format!("0x{:02X} {}", frame[2], exception_name(frame[2])),
            Some(f64::from(frame[2])),
        ));
        return Ok(fields);
    }

    // Register requests are exactly 8 bytes: slave, function, four data bytes, CRC.
    if frame.len() == 8 && matches!(function, 0x01..=0x06) {
        let first = u16::from_be_bytes([frame[2], frame[3]]);
        let second = u16::from_be_bytes([frame[4], frame[5]]);
        let (first_name, second_name) = match function {
            0x01 | 0x02 => ("start_address", "quantity"),
            0x03 | 0x04 => ("start_register", "quantity"),
            0x05 | 0x06 => ("register", "value"),
            _ => ("first", "second"),
        };
        fields.push(field(
            first_name,
            2,
            2,
            first.to_string(),
            Some(f64::from(first)),
        ));
        fields.push(field(
            second_name,
            4,
            2,
            second.to_string(),
            Some(f64::from(second)),
        ));
        return Ok(fields);
    }

    // A read response starts with a byte count that must match the rest.
    if matches!(function, 0x01..=0x04) && body_end >= 3 {
        let count = frame[2] as usize;
        fields.push(field(
            "byte_count",
            2,
            1,
            count.to_string(),
            Some(count as f64),
        ));
        let expected_count = body_end.saturating_sub(3);
        if count != expected_count {
            fields.push(field(
                "byte_count_mismatch",
                2,
                1,
                format!("header says {count}, frame holds {expected_count}"),
                None,
            ));
        }
        return Ok(fields);
    }

    Ok(fields)
}

/// CRC-16/Modbus: polynomial 0xA001 reflected, initial value 0xFFFF.
fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for byte in data {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn function_name(function: u8) -> &'static str {
    match function {
        0x01 => "read coils",
        0x02 => "read discrete inputs",
        0x03 => "read holding registers",
        0x04 => "read input registers",
        0x05 => "write single coil",
        0x06 => "write single register",
        0x0F => "write multiple coils",
        0x10 => "write multiple registers",
        other if other & 0x80 != 0 => "exception",
        _ => "reserved",
    }
}

fn exception_name(code: u8) -> &'static str {
    match code {
        0x01 => "illegal function",
        0x02 => "illegal data address",
        0x03 => "illegal data value",
        0x04 => "slave device failure",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_crc(body: &[u8]) -> Vec<u8> {
        let crc = crc16_modbus(body);
        let mut frame = body.to_vec();
        frame.extend_from_slice(&crc.to_le_bytes());
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
    fn a_read_holding_registers_request_decodes() {
        // Slave 1, function 3, start 0x006B, quantity 3.
        let frame = with_crc(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]);
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "slave"), "1");
        assert_eq!(value_of(&fields, "function"), "0x03");
        assert_eq!(value_of(&fields, "function_name"), "read holding registers");
        assert_eq!(value_of(&fields, "start_register"), "107");
        assert_eq!(value_of(&fields, "quantity"), "3");
        assert_eq!(value_of(&fields, "crc16_valid"), "true");
    }

    #[test]
    fn a_read_response_counts_its_bytes() {
        // Slave 1, function 3, byte count 6, three registers.
        let frame = with_crc(&[0x01, 0x03, 0x06, 0x02, 0x2B, 0x00, 0x00, 0x00, 0x64]);
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "byte_count"), "6");
        assert_eq!(value_of(&fields, "data_bytes"), "7");
        assert!(
            !fields
                .iter()
                .any(|field| field.name == "byte_count_mismatch")
        );
    }

    #[test]
    fn a_broken_crc_is_reported() {
        let mut frame = with_crc(&[0x01, 0x06, 0x00, 0x01, 0x00, 0x03]);
        let last = frame.len() - 1;
        frame[last] ^= 0xFF;
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "crc16_valid"), "false");
    }

    #[test]
    fn an_exception_response_names_the_reason() {
        // Slave 1, function 0x83 (read holding registers, exception), code 2.
        let frame = with_crc(&[0x01, 0x83, 0x02]);
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "function_name"), "exception");
        assert!(value_of(&fields, "exception").contains("illegal data address"));
    }

    #[test]
    fn a_write_single_register_request_names_register_and_value() {
        let frame = with_crc(&[0x01, 0x06, 0x00, 0x01, 0x00, 0x03]);
        let fields = decode(&frame).unwrap();
        assert_eq!(value_of(&fields, "register"), "1");
        assert_eq!(value_of(&fields, "value"), "3");
    }

    #[test]
    fn a_short_frame_is_refused() {
        assert!(decode(&[0x01, 0x03]).is_err());
    }
}
