//! Encoding a frame from named values (spec 0032).
//!
//! The dissector IR already says where every field lives and how wide it is, so the
//! same table can be written instead of read. That is what turns the command forge
//! from hex into a form, and it is the missing half of the SRS's "typed field pills".
//!
//! A field the caller did not name keeps its zero, which is what a firmware default
//! is. A name the schema does not have is an error: a typo must not send zeros.

use crate::{DissectorIr, IrOp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What a caller gives a field: a number, or the label of an enum variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Number(f64),
    Label(String),
}

impl Value {
    pub fn number(self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(value),
            Self::Label(_) => None,
        }
    }
}

/// What went wrong while encoding.
#[derive(Debug, Clone, PartialEq)]
pub enum EncodeError {
    /// A name the schema does not have.
    UnknownField(String),
    /// A value outside the field's width.
    OutOfRange { field: String, value: f64 },
    /// A float in an integer field, or the reverse.
    NotAWholeNumber { field: String, value: f64 },
    /// A label an enum does not carry.
    UnknownLabel { field: String, label: String },
    /// The schema has no fields at all.
    Empty,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownField(field) => {
                write!(formatter, "`{field}` is not a field of this schema")
            }
            Self::OutOfRange { field, value } => {
                write!(formatter, "`{value}` does not fit in `{field}`")
            }
            Self::NotAWholeNumber { field, value } => {
                write!(formatter, "`{field}` needs a whole number, not `{value}`")
            }
            Self::UnknownLabel { field, label } => {
                write!(formatter, "`{label}` is not a value of `{field}`")
            }
            Self::Empty => write!(formatter, "the schema has no fields"),
        }
    }
}

impl std::error::Error for EncodeError {}

/// Encode a frame. Fields the caller omits stay zero.
pub fn encode(ir: &DissectorIr, values: &BTreeMap<String, Value>) -> Result<Vec<u8>, EncodeError> {
    if ir.ops.is_empty() {
        return Err(EncodeError::Empty);
    }
    let size = ir.ops.iter().map(op_span).max().unwrap_or(0);
    let mut frame = vec![0u8; size];

    let mut used = Vec::new();
    for op in &ir.ops {
        write_op(op, &mut frame, values, "", &mut used)?;
    }

    // A name that matched nothing is a typo, and sending zeros would hide it.
    for name in values.keys() {
        if !used.iter().any(|used| used == name) {
            return Err(EncodeError::UnknownField(name.clone()));
        }
    }
    Ok(frame)
}

/// Last byte an operation touches, so the frame is long enough.
fn op_span(op: &IrOp) -> usize {
    match op {
        IrOp::UInt { offset, width, .. }
        | IrOp::Int { offset, width, .. }
        | IrOp::Float { offset, width, .. }
        | IrOp::Enum { offset, width, .. }
        | IrOp::Bitfield { offset, width, .. } => *offset as usize + width_of(*width, op),
        IrOp::Array {
            offset,
            count,
            element,
        } => *offset as usize + *count as usize * op_span(element),
        IrOp::Label { op, .. } => op_span(op),
    }
}

/// Bytes an operation occupies. Integer, float and enum widths are byte counts in
/// the IR; a bitfield's `width` is bits inside its unit.
fn width_of(width: u8, op: &IrOp) -> usize {
    match op {
        IrOp::Bitfield {
            bit_offset, width, ..
        } => (usize::from(*bit_offset) + usize::from(*width))
            .div_ceil(8)
            .max(1),
        _ => usize::from(width),
    }
}

fn write_op(
    op: &IrOp,
    frame: &mut [u8],
    values: &BTreeMap<String, Value>,
    prefix: &str,
    used: &mut Vec<String>,
) -> Result<(), EncodeError> {
    match op {
        IrOp::Label { name, op } => {
            let full = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}.{name}")
            };
            // An array's element labels repeat; the caller names them `x.0`, `x.1`.
            if matches!(**op, IrOp::Array { .. }) {
                write_op(op, frame, values, &full, used)
            } else {
                write_leaf(&full, op, frame, values, used)
            }
        }
        IrOp::Array {
            offset,
            count,
            element,
        } => {
            let stride = op_span(element);
            for index in 0..*count as usize {
                let mut shifted = (**element).clone();
                shift(&mut shifted, *offset as usize + index * stride);
                write_op(&shifted, frame, values, &format!("{prefix}{index}"), used)?;
                if let IrOp::Label { name, .. } = &shifted {
                    // `prefix` carries the array name; the index is the last segment.
                    used.push(format!("{prefix}{index}"));
                    let _ = name;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn write_leaf(
    name: &str,
    op: &IrOp,
    frame: &mut [u8],
    values: &BTreeMap<String, Value>,
    used: &mut Vec<String>,
) -> Result<(), EncodeError> {
    let Some(value) = values.get(name) else {
        return Ok(());
    };
    used.push(name.to_string());
    let offset = offset_of(op) as usize;
    match op {
        IrOp::UInt {
            width, big_endian, ..
        } => {
            let number = number(name, value)?;
            let whole = whole(name, number)?;
            let bits = u32::from(*width) * 8;
            if whole < 0 || (bits < 128 && whole >= 1i128 << bits) {
                return Err(EncodeError::OutOfRange {
                    field: name.to_string(),
                    value: number,
                });
            }
            write_uint(frame, offset, *width, *big_endian, whole as u128);
        }
        IrOp::Int {
            width, big_endian, ..
        } => {
            let number = number(name, value)?;
            let whole = whole(name, number)?;
            let bits = u32::from(*width) * 8;
            let limit = 1i128 << (bits - 1);
            if whole < -limit || whole >= limit {
                return Err(EncodeError::OutOfRange {
                    field: name.to_string(),
                    value: number,
                });
            }
            let mask = if bits >= 128 {
                u128::MAX
            } else {
                (1u128 << bits) - 1
            };
            write_uint(frame, offset, *width, *big_endian, (whole as u128) & mask);
        }
        IrOp::Float {
            width, big_endian, ..
        } => {
            let number = number(name, value)?;
            if *width == 64 {
                write_bytes(frame, offset, &number.to_bits().to_le_bytes(), *big_endian);
            } else {
                let narrow = number as f32;
                write_bytes(frame, offset, &narrow.to_bits().to_le_bytes(), *big_endian);
            }
        }
        IrOp::Enum {
            width,
            variants,
            big_endian,
            ..
        } => {
            // A label is matched case-insensitively, so `MODE_RUN` and `mode_run` both
            // work; a number is taken as the raw value.
            let whole = match value {
                Value::Number(number) => whole(name, *number)?,
                Value::Label(label) => variants
                    .iter()
                    .find(|(_, name)| name.eq_ignore_ascii_case(label))
                    .map(|(value, _)| i128::from(*value))
                    .ok_or_else(|| EncodeError::UnknownLabel {
                        field: name.to_string(),
                        label: label.clone(),
                    })?,
            };
            let bits = u32::from(*width) * 8;
            if whole < 0 || whole >= 1i128 << bits {
                return Err(EncodeError::OutOfRange {
                    field: name.to_string(),
                    value: whole as f64,
                });
            }
            write_uint(frame, offset, *width, *big_endian, whole as u128);
        }
        IrOp::Bitfield {
            bit_offset,
            width,
            big_endian,
            ..
        } => {
            let number = number(name, value)?;
            let whole = whole(name, number)?;
            if whole < 0 || whole >= 1i128 << *width {
                return Err(EncodeError::OutOfRange {
                    field: name.to_string(),
                    value: number,
                });
            }
            let unit = width_of(*width, op);
            let mut storage = read_uint(frame, offset, unit as u8, *big_endian);
            let mask = ((1u128 << width) - 1) << bit_offset;
            storage = (storage & !mask) | (((whole as u128) << bit_offset) & mask);
            write_uint(frame, offset, unit as u8, *big_endian, storage);
        }
        _ => {}
    }
    Ok(())
}

/// A label where a number is needed is a mistake the caller can see.
fn number(name: &str, value: &Value) -> Result<f64, EncodeError> {
    match value {
        Value::Number(number) => Ok(*number),
        Value::Label(label) => Err(EncodeError::UnknownLabel {
            field: name.to_string(),
            label: label.clone(),
        }),
    }
}

fn whole(name: &str, value: f64) -> Result<i128, EncodeError> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(EncodeError::NotAWholeNumber {
            field: name.to_string(),
            value,
        });
    }
    Ok(value as i128)
}

fn offset_of(op: &IrOp) -> u32 {
    match op {
        IrOp::UInt { offset, .. }
        | IrOp::Int { offset, .. }
        | IrOp::Float { offset, .. }
        | IrOp::Enum { offset, .. }
        | IrOp::Bitfield { offset, .. }
        | IrOp::Array { offset, .. } => *offset,
        IrOp::Label { op, .. } => op_span_offset(op),
    }
}

fn op_span_offset(op: &IrOp) -> u32 {
    offset_of(op)
}

fn shift(op: &mut IrOp, by: usize) {
    match op {
        IrOp::UInt { offset, .. }
        | IrOp::Int { offset, .. }
        | IrOp::Float { offset, .. }
        | IrOp::Bitfield { offset, .. }
        | IrOp::Enum { offset, .. }
        | IrOp::Array { offset, .. } => *offset += by as u32,
        IrOp::Label { op, .. } => shift(op, by),
    }
}

fn read_uint(frame: &[u8], offset: usize, bytes: u8, big_endian: bool) -> u128 {
    let bytes = usize::from(bytes);
    let mut value = 0u128;
    for index in 0..bytes {
        let at = if big_endian {
            offset + index
        } else {
            offset + bytes - 1 - index
        };
        value = (value << 8) | u128::from(frame.get(at).copied().unwrap_or(0));
    }
    value
}

fn write_uint(frame: &mut [u8], offset: usize, bytes: u8, big_endian: bool, value: u128) {
    let bytes = usize::from(bytes);
    for index in 0..bytes {
        let byte = ((value >> (index * 8)) & 0xFF) as u8;
        let at = if big_endian {
            offset + bytes - 1 - index
        } else {
            offset + index
        };
        if let Some(slot) = frame.get_mut(at) {
            *slot = byte;
        }
    }
}

fn write_bytes(frame: &mut [u8], offset: usize, bytes: &[u8], big_endian: bool) {
    for (index, byte) in bytes.iter().enumerate() {
        let at = if big_endian {
            offset + bytes.len() - 1 - index
        } else {
            offset + index
        };
        if let Some(slot) = frame.get_mut(at) {
            *slot = *byte;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cheader;

    fn imu() -> DissectorIr {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/imu_packet.h");
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = cheader::parse(&text).expect("parses");
        cheader::compile(&header, "ImuPacket", path).expect("compiles")
    }

    fn values(pairs: &[(&str, f64)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), Value::Number(*value)))
            .collect()
    }

    #[test]
    fn a_frame_round_trips_through_the_same_schema() {
        let ir = imu();
        let given = values(&[
            ("sync", 43605.0),
            ("version", 3.0),
            ("flags", 5.0),
            ("channel", 9.0),
            ("timestamp_us", 1234.0),
            ("v_batt_mv", 7400.0),
            ("gyro_z", 0.25),
            ("mode", 1.0),
        ]);
        let frame = encode(&ir, &given).expect("encodes");
        assert_eq!(frame.len(), 19);

        let fields = crate::exec::execute(&ir, &frame).expect("decodes");
        let flat = |name: &str| {
            fields
                .iter()
                .find(|field| field.name == name)
                .and_then(|field| field.value_num)
        };
        assert_eq!(flat("sync"), Some(43605.0));
        assert_eq!(flat("version"), Some(3.0));
        assert_eq!(flat("flags"), Some(5.0));
        assert_eq!(flat("channel"), Some(9.0));
        assert_eq!(flat("v_batt_mv"), Some(7400.0));
        assert!((flat("gyro_z").unwrap() - 0.25).abs() < 1e-6);
        assert_eq!(flat("mode"), Some(1.0));
    }

    #[test]
    fn omitted_fields_are_zero() {
        let ir = imu();
        let frame = encode(&ir, &values(&[("version", 3.0)])).expect("encodes");
        assert_eq!(frame[2], 3);
        assert_eq!(frame[0], 0, "sync keeps its zero");
    }

    #[test]
    fn a_typo_is_an_error_not_a_frame_of_zeros() {
        let ir = imu();
        let error = encode(&ir, &values(&[("v_bat_mv", 7400.0)])).expect_err("unknown");
        assert_eq!(error, EncodeError::UnknownField("v_bat_mv".to_string()));
    }

    #[test]
    fn a_value_outside_its_width_is_refused() {
        let ir = imu();
        let error = encode(&ir, &values(&[("version", 300.0)])).expect_err("too big");
        assert!(matches!(error, EncodeError::OutOfRange { .. }));
    }

    #[test]
    fn a_fraction_in_an_integer_field_is_refused() {
        let ir = imu();
        let error = encode(&ir, &values(&[("v_batt_mv", 7400.5)])).expect_err("fraction");
        assert!(matches!(error, EncodeError::NotAWholeNumber { .. }));
    }

    #[test]
    fn big_endian_and_bitfields_are_written_where_they_belong() {
        let ir = imu();
        let frame = encode(
            &ir,
            &values(&[
                ("v_batt_mv", 0x1CE8 as f64),
                ("flags", 5.0),
                ("channel", 9.0),
            ]),
        )
        .expect("encodes");
        // Big endian on the wire, so the high byte comes first.
        assert_eq!(&frame[8..10], &[0x1C, 0xE8]);
        // flags is bits 0..3 and channel bits 3..8 of byte 3.
        assert_eq!(frame[3], 5 | (9 << 3));
    }

    fn mode_packet() -> DissectorIr {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mode_packet.h");
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = cheader::parse(&text).expect("parses");
        cheader::compile(&header, "ModePacket", path).expect("compiles")
    }

    #[test]
    fn an_enum_takes_its_label_in_any_case() {
        let ir = mode_packet();
        for label in ["MODE_RUN", "mode_run", "Mode_Run"] {
            let mut given = values(&[("sync", 43605.0)]);
            given.insert("mode".to_string(), Value::Label(label.to_string()));
            let frame = encode(&ir, &given).expect("encodes");
            let fields = crate::exec::execute(&ir, &frame).expect("decodes");
            let mode = fields
                .iter()
                .find(|field| field.name == "mode")
                .expect("mode");
            assert_eq!(mode.value, "MODE_RUN", "{label} did not resolve");
        }
    }

    #[test]
    fn an_enum_named_through_a_typedef_takes_its_label_too() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mode_packet.h");
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = cheader::parse(&text).expect("parses");
        let ir = cheader::compile(&header, "TypedefPacket", path).expect("compiles");

        let mut given = values(&[("sync", 43605.0), ("flags", 1.0)]);
        given.insert("state".to_string(), Value::Label("state_on".to_string()));
        let frame = encode(&ir, &given).expect("encodes");
        let fields = crate::exec::execute(&ir, &frame).expect("decodes");
        let state = fields
            .iter()
            .find(|field| field.name == "state")
            .expect("state");
        assert_eq!(state.value, "STATE_ON");
        assert_eq!(
            state.byte_len, 4,
            "an enum is four bytes without -fshort-enums"
        );
    }

    #[test]
    fn an_enum_label_the_schema_does_not_have_is_refused() {
        let ir = mode_packet();
        let mut given = values(&[]);
        given.insert("mode".to_string(), Value::Label("MODE_WOBBLE".to_string()));
        let error = encode(&ir, &given).expect_err("unknown label");
        assert_eq!(
            error,
            EncodeError::UnknownLabel {
                field: "mode".to_string(),
                label: "MODE_WOBBLE".to_string()
            }
        );
    }

    #[test]
    fn a_label_in_an_integer_field_is_refused() {
        let ir = imu();
        let mut given = values(&[]);
        given.insert("version".to_string(), Value::Label("three".to_string()));
        let error = encode(&ir, &given).expect_err("a label is not a number");
        assert!(matches!(error, EncodeError::UnknownLabel { .. }));
    }

    #[test]
    fn the_schema_size_matches_the_decoder() {
        let ir = imu();
        let frame = encode(&ir, &BTreeMap::new()).expect("encodes");
        assert_eq!(frame.len(), 19, "no field may be left out of the frame");
    }
}
