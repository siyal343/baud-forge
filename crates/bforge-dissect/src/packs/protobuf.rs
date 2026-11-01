//! Protobuf wire format, without a `.proto` file.
//!
//! A protobuf message does not carry its field names, only field numbers and wire types, so
//! this pack prints what the bytes prove: `field_3` is a varint with the value 150, `field_5`
//! is a nested message with two fields of its own. Most of the meaning in a protobuf capture
//! is the shape, and the shape is visible without the schema.
//!
//! ```text
//! key        (field_number << 3) | wire_type, as a varint
//! 0 varint   1 fixed64   2 length-delimited   5 fixed32
//! ```
//!
//! Groups (wire types 3 and 4) were removed from proto3 and are reported as theirs, not
//! guessed at.

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;

/// Nested messages are followed this far. A hostile frame must not become a stack overflow.
const MAX_DEPTH: usize = 8;

/// Decode one protobuf message.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 1, "protobuf message")?;
    let (mut fields, consumed, stopped) = decode_at(frame, 0, MAX_DEPTH);
    if consumed < frame.len() {
        // A frame that starts with something that is not a field is not protobuf, and it
        // says so. Once one field has parsed, the rest is a truncated tail: keep what is
        // true and mark the remainder.
        if let Some(error) = stopped.clone()
            && consumed == 0
        {
            return Err(error);
        }
        // Trailing bytes are common when a capture starts mid-message, and a truncated
        // field is what a dropped byte looks like.
        let rest = &frame[consumed..];
        let mut note = field(
            "unparsed",
            consumed as u32,
            rest.len() as u32,
            hex(rest),
            None,
        );
        if let Some(error) = stopped {
            note.value = format!("{error}: {}", note.value);
        }
        fields.push(note);
    } else if let Some(error) = stopped {
        return Err(error);
    }
    Ok(fields)
}

/// Read fields from `start`: what parsed, how many bytes it used, and why it stopped.
fn decode_at(
    frame: &[u8],
    start: usize,
    depth: usize,
) -> (Vec<DecodedField>, usize, Option<ExecError>) {
    let mut fields = Vec::new();
    let mut at = start;
    while at < frame.len() {
        match read_field(frame, at, depth) {
            Ok((decoded, used)) => {
                fields.push(decoded);
                at += used;
            }
            Err(error) => return (fields, at - start, Some(error)),
        }
    }
    (fields, at - start, None)
}

/// One field: its value and how many bytes it occupied, key included.
fn read_field(frame: &[u8], at: usize, depth: usize) -> Result<(DecodedField, usize), ExecError> {
    let (key, mut used) = varint(frame, at)?;
    let number = key >> 3;
    let wire = (key & 0x07) as u8;
    if number == 0 {
        return Err(ExecError::Unsupported(
            "a protobuf field number of zero is not valid".to_string(),
        ));
    }
    let name = format!("field_{number}");
    let offset = (at + used) as u32;

    let decoded = match wire {
        0 => {
            let (value, read) = varint(frame, at + used)?;
            used += read;
            decoded(&name, offset, read as u32, "varint", value as f64, None)
        }
        1 => {
            let body = at + used;
            require(frame, body + 8, "protobuf fixed64")?;
            let raw = u64::from_le_bytes(frame[body..body + 8].try_into().unwrap());
            used += 8;
            decoded(
                &name,
                offset,
                8,
                &format!("fixed64 {raw}"),
                raw as f64,
                Some(format!("0x{raw:016X}")),
            )
        }
        5 => {
            let body = at + used;
            require(frame, body + 4, "protobuf fixed32")?;
            let raw = u32::from_le_bytes(frame[body..body + 4].try_into().unwrap());
            used += 4;
            decoded(
                &name,
                offset,
                4,
                &format!("fixed32 {raw}"),
                f64::from(raw),
                Some(format!("0x{raw:08X}")),
            )
        }
        2 => {
            let (len, read) = varint(frame, at + used)?;
            used += read;
            let body = at + used;
            let len = len as usize;
            require(frame, body + len, "protobuf length-delimited field")?;
            used += len;
            length_field(&name, offset, &frame[body..body + len], depth)
        }
        3 | 4 => {
            return Err(ExecError::Unsupported(format!(
                "protobuf group wire type {wire} on {name} was removed in proto3"
            )));
        }
        other => {
            return Err(ExecError::Unsupported(format!(
                "protobuf wire type {other} on {name} is not defined"
            )));
        }
    };
    Ok((decoded, used))
}

/// A length-delimited field is a message when it decodes as one, and a string when it prints.
fn length_field(name: &str, offset: u32, body: &[u8], depth: usize) -> DecodedField {
    if depth > 0 {
        let (children, consumed, stopped) = decode_at(body, 0, depth - 1);
        if stopped.is_none() && consumed == body.len() && !children.is_empty() {
            let mut parent = field(
                name,
                offset,
                body.len() as u32,
                format!("message, {} field(s)", children.len()),
                None,
            );
            parent.children = children;
            return parent;
        }
    }

    let text = std::str::from_utf8(body)
        .ok()
        .filter(|text| text.chars().all(|ch| !ch.is_control()));
    match text {
        Some(text) => field(name, offset, body.len() as u32, format!("\"{text}\""), None),
        None => field(name, offset, body.len() as u32, hex(body), None),
    }
}

fn decoded(
    name: &str,
    offset: u32,
    len: u32,
    kind: &str,
    number: f64,
    also: Option<String>,
) -> DecodedField {
    let text = match also {
        Some(also) => format!("{kind} {number:.0} ({also})"),
        None => format!("{kind} {number:.0}"),
    };
    field(name, offset, len, text, Some(number))
}

/// A varint, base 128, little endian groups, high bit set on every byte but the last.
fn varint(frame: &[u8], at: usize) -> Result<(u64, usize), ExecError> {
    let mut value = 0u64;
    let mut shift = 0u32;
    let mut used = 0usize;
    loop {
        let index = at + used;
        if index >= frame.len() {
            return Err(ExecError::Bounds {
                field: "protobuf varint".to_string(),
                need: (used + 1) as u32,
                have: frame.len().saturating_sub(at),
            });
        }
        let byte = frame[index];
        value |= u64::from(byte & 0x7F) << shift;
        used += 1;
        if byte & 0x80 == 0 {
            return Ok((value, used));
        }
        shift += 7;
        if shift >= 64 {
            return Err(ExecError::Unsupported(
                "a protobuf varint longer than ten bytes is not valid".to_string(),
            ));
        }
    }
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

    #[test]
    fn a_varint_field_reads_as_its_number() {
        // The example from the protobuf documentation: field 1, varint, 150.
        let fields = decode(&[0x08, 0x96, 0x01]).unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].name, "field_1");
        assert_eq!(value_of(&fields, "field_1"), "varint 150");
        assert_eq!(fields[0].byte_offset, 1);
        assert_eq!(fields[0].byte_len, 2);
    }

    #[test]
    fn a_printable_payload_reads_as_a_string() {
        // field 2, length-delimited, "abc".
        let fields = decode(&[0x12, 0x03, b'a', b'b', b'c']).unwrap();
        assert_eq!(value_of(&fields, "field_2"), "\"abc\"");
    }

    #[test]
    fn a_binary_payload_reads_as_hex() {
        let fields = decode(&[0x12, 0x02, 0x00, 0xFF]).unwrap();
        assert_eq!(value_of(&fields, "field_2"), "00 FF");
    }

    #[test]
    fn a_length_delimited_field_that_parses_is_a_nested_message() {
        // field 3, length-delimited: [field 1 varint 1][field 2 varint 2].
        let fields = decode(&[0x1A, 0x04, 0x08, 0x01, 0x10, 0x02]).unwrap();
        assert_eq!(fields.len(), 1);
        let nested = &fields[0];
        assert_eq!(nested.value, "message, 2 field(s)");
        assert_eq!(nested.children.len(), 2);
        assert_eq!(nested.children[0].value, "varint 1");
        assert_eq!(nested.children[1].value, "varint 2");
    }

    #[test]
    fn fixed_width_fields_keep_their_hex() {
        let mut frame = vec![0x09]; // field 1, fixed64
        frame.extend_from_slice(&1u64.to_le_bytes());
        frame.push(0x15); // field 2, fixed32
        frame.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());

        let fields = decode(&frame).unwrap();
        assert!(value_of(&fields, "field_1").contains("0x0000000000000001"));
        assert!(value_of(&fields, "field_2").contains("0xDEADBEEF"));
    }

    #[test]
    fn trailing_bytes_are_reported_rather_than_failing() {
        // One good field, then a key with no value behind it.
        let fields = decode(&[0x08, 0x01, 0x10]).unwrap();
        assert_eq!(value_of(&fields, "field_1"), "varint 1");
        let rest = value_of(&fields, "unparsed");
        assert!(rest.ends_with("10"), "{rest}");
        assert!(rest.contains("needs 1 bytes"), "{rest}");
    }

    #[test]
    fn a_truncated_varint_says_what_it_needed() {
        let error = decode(&[0x08, 0x80]).unwrap_err();
        assert!(error.to_string().contains("protobuf varint"), "{error}");
    }

    #[test]
    fn a_group_is_refused_by_name() {
        let error = decode(&[0x0B]).unwrap_err();
        assert!(error.to_string().contains("proto3"), "{error}");
    }

    #[test]
    fn a_field_number_of_zero_is_refused() {
        let error = decode(&[0x00, 0x01]).unwrap_err();
        assert!(
            error.to_string().contains("field number of zero"),
            "{error}"
        );
    }
}
