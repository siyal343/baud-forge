//! IR executor (F3.1): run a compiled schema over one frame.
//!
//! Every read is bounds checked against the frame, and the error names the field
//! and the offsets, because a dissector that silently reads past the end is worse
//! than one that says which struct is too short for the frame it was given.

use crate::{CrcValidation, DecodedField, DissectedFrame, DissectorIr, IrOp};
use bforge_storage::RawChunk;

/// Why a frame could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    /// The frame is shorter than the schema needs.
    Bounds {
        field: String,
        need: u32,
        have: usize,
    },
    /// The schema contains an operation this build cannot run.
    Unsupported(String),
    /// A width that is not 1, 2, 4 or 8 bytes.
    BadWidth { field: String, width: u8 },
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bounds { field, need, have } => write!(
                f,
                "field `{field}` needs {need} bytes but the frame has {have}"
            ),
            Self::Unsupported(what) => write!(f, "{what} is not supported by the executor"),
            Self::BadWidth { field, width } => {
                write!(f, "field `{field}` has width {width}, not 1, 2, 4 or 8")
            }
        }
    }
}

impl std::error::Error for ExecError {}

/// Decode a frame with a compiled schema.
pub fn execute(ir: &DissectorIr, frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    let mut fields = Vec::new();
    for op in &ir.ops {
        run(op, 0, frame, &mut fields)?;
    }
    Ok(fields)
}

/// Decode and wrap the result as a frame, with no checksum opinion.
///
/// The caller decides the protocol tag and the checksum status, because only it
/// knows where the checksum sits for this schema.
pub fn execute_frame(
    ir: &DissectorIr,
    chunk: &RawChunk,
    tag: &str,
    frame_bytes: Vec<u8>,
) -> Result<DissectedFrame, ExecError> {
    let fields = execute(ir, &frame_bytes)?;
    Ok(DissectedFrame {
        frame_id: chunk.seq_id,
        port_id: chunk.port_id,
        start_timestamp_ns: chunk.timestamp_ns,
        end_timestamp_ns: chunk.timestamp_ns,
        delta_ns: 0,
        raw_bytes: frame_bytes,
        crc_status: CrcValidation::NotApplicable,
        protocol_tag: tag.to_string(),
        fields,
        elf_annotations: Vec::new(),
    })
}

fn run(op: &IrOp, base: usize, frame: &[u8], out: &mut Vec<DecodedField>) -> Result<(), ExecError> {
    match op {
        IrOp::Label { name, op } => {
            let mut children = Vec::new();
            run_named(op, base, frame, name, &mut children)?;
            let fields = children;
            out.extend(fields);
        }
        other => {
            let mut children = Vec::new();
            run_named(other, base, frame, "", &mut children)?;
            out.extend(children);
        }
    }
    Ok(())
}

/// Execute one operation and push exactly one field.
fn run_named(
    op: &IrOp,
    base: usize,
    frame: &[u8],
    name: &str,
    out: &mut Vec<DecodedField>,
) -> Result<(), ExecError> {
    match op {
        IrOp::Label { name, op } => run_named(op, base, frame, name, out),
        IrOp::UInt {
            offset,
            width,
            big_endian,
        } => {
            let at = checked(base, *offset, *width, u32::from(*width), name, frame)?;
            let value = read_uint(&frame[at..at + usize::from(*width)], *big_endian);
            out.push(field(
                name,
                absolute(base, *offset),
                u32::from(*width),
                value.to_string(),
                Some(value as f64),
            ));
            Ok(())
        }
        IrOp::Int {
            offset,
            width,
            big_endian,
        } => {
            let at = checked(base, *offset, *width, u32::from(*width), name, frame)?;
            let value = read_int(&frame[at..at + usize::from(*width)], *big_endian);
            out.push(field(
                name,
                absolute(base, *offset),
                u32::from(*width),
                value.to_string(),
                Some(value as f64),
            ));
            Ok(())
        }
        IrOp::Float {
            offset,
            width,
            big_endian,
        } => {
            let at = checked(base, *offset, *width, u32::from(*width), name, frame)?;
            let value = match (*width, *big_endian) {
                (4, false) => f64::from(f32::from_le_bytes(frame[at..at + 4].try_into().unwrap())),
                (4, true) => f64::from(f32::from_be_bytes(frame[at..at + 4].try_into().unwrap())),
                (8, false) => f64::from_le_bytes(frame[at..at + 8].try_into().unwrap()),
                (8, true) => f64::from_be_bytes(frame[at..at + 8].try_into().unwrap()),
                (other, _) => {
                    return Err(ExecError::BadWidth {
                        field: name.to_string(),
                        width: other,
                    });
                }
            };
            out.push(field(
                name,
                absolute(base, *offset),
                u32::from(*width),
                format_float(value),
                Some(value),
            ));
            Ok(())
        }
        IrOp::Bitfield {
            offset,
            bit_offset,
            width,
            big_endian,
        } => {
            let unit_bytes = u32::from(bit_offset.saturating_add(*width))
                .div_ceil(8)
                .max(1);
            let at = checked(base, *offset, unit_bytes as u8, unit_bytes, name, frame)?;
            let unit = read_uint(&frame[at..at + unit_bytes as usize], *big_endian);
            let mask = if *width >= 64 {
                u64::MAX
            } else {
                (1u64 << *width) - 1
            };
            // Bit numbering runs from the least significant bit of the unit, which
            // is how a packed C bitfield lays out on little-endian firmware.
            let shift = if *big_endian {
                unit_bytes * 8 - u32::from(*bit_offset) - u32::from(*width)
            } else {
                u32::from(*bit_offset)
            };
            let value = (unit >> shift) & mask;
            out.push(field(
                name,
                absolute(base, *offset),
                unit_bytes,
                value.to_string(),
                Some(value as f64),
            ));
            Ok(())
        }
        IrOp::Enum {
            offset,
            width,
            variants,
            big_endian,
        } => {
            let at = checked(base, *offset, *width, u32::from(*width), name, frame)?;
            let raw = read_uint(&frame[at..at + usize::from(*width)], *big_endian) as i64;
            let label = variants
                .iter()
                .find(|(value, _)| *value == raw)
                .map(|(_, label)| label.clone())
                .unwrap_or_else(|| raw.to_string());
            out.push(field(
                name,
                absolute(base, *offset),
                u32::from(*width),
                label,
                Some(raw as f64),
            ));
            Ok(())
        }
        IrOp::Array {
            offset,
            count,
            element,
        } => {
            let element_size = size_of(element);
            let total = u32::from(*count)
                .checked_mul(element_size)
                .ok_or_else(|| ExecError::Unsupported("array is too large".to_string()))?;
            checked(base, *offset, 0, total, name, frame)?;

            let mut children = Vec::new();
            for index in 0..u32::from(*count) {
                let at = base + *offset as usize + index as usize * element_size as usize;
                run_element(element, at, frame, &mut children)?;
            }
            out.push(DecodedField {
                name: name.to_string(),
                byte_offset: absolute(base, *offset),
                byte_len: total,
                value: format!("[{} items]", count),
                value_num: None,
                children,
            });
            Ok(())
        }
    }
}

fn run_element(
    op: &IrOp,
    base: usize,
    frame: &[u8],
    out: &mut Vec<DecodedField>,
) -> Result<(), ExecError> {
    match op {
        IrOp::Label { name, op } => {
            let mut one = Vec::new();
            run_named(op, base, frame, name, &mut one)?;
            out.extend(one);
            Ok(())
        }
        other => run_named(other, base, frame, "", out),
    }
}

/// Size in bytes of one operation.
pub fn size_of(op: &IrOp) -> u32 {
    match op {
        IrOp::UInt { width, .. } | IrOp::Int { width, .. } | IrOp::Float { width, .. } => {
            u32::from(*width)
        }
        IrOp::Enum { width, .. } => u32::from(*width),
        IrOp::Bitfield {
            bit_offset, width, ..
        } => u32::from(bit_offset.saturating_add(*width))
            .div_ceil(8)
            .max(1),
        IrOp::Array { count, element, .. } => u32::from(*count) * size_of(element),
        IrOp::Label { op, .. } => size_of(op),
    }
}

fn checked(
    base: usize,
    offset: u32,
    width: u8,
    need: u32,
    name: &str,
    frame: &[u8],
) -> Result<usize, ExecError> {
    let _ = width;
    let at = base
        .checked_add(offset as usize)
        .ok_or_else(|| ExecError::Bounds {
            field: name.to_string(),
            need,
            have: frame.len(),
        })?;
    let end = at
        .checked_add(need as usize)
        .ok_or_else(|| ExecError::Bounds {
            field: name.to_string(),
            need,
            have: frame.len(),
        })?;
    if end > frame.len() {
        return Err(ExecError::Bounds {
            field: name.to_string(),
            need: end as u32,
            have: frame.len(),
        });
    }
    Ok(at)
}

fn read_uint(bytes: &[u8], big_endian: bool) -> u64 {
    let mut buffer = [0u8; 8];
    if big_endian {
        // Big endian puts the most significant byte first, so pad at the front.
        buffer[8 - bytes.len()..].copy_from_slice(bytes);
        u64::from_be_bytes(buffer)
    } else {
        // Little endian starts at the least significant byte.
        buffer[..bytes.len()].copy_from_slice(bytes);
        u64::from_le_bytes(buffer)
    }
}

fn read_int(bytes: &[u8], big_endian: bool) -> i64 {
    let raw = read_uint(bytes, big_endian);
    let bits = bytes.len() * 8;
    if bits == 64 {
        return raw as i64;
    }
    let shift = 64 - bits;
    ((raw << shift) as i64) >> shift
}

/// Offsets in the schema are relative to the enclosing element; the tree reports
/// absolute positions, because the hex pane highlights bytes of the whole frame.
fn absolute(base: usize, offset: u32) -> u32 {
    (base + offset as usize) as u32
}

fn field(name: &str, offset: u32, len: u32, value: String, value_num: Option<f64>) -> DecodedField {
    DecodedField {
        name: name.to_string(),
        byte_offset: offset,
        byte_len: len,
        value,
        value_num,
        children: Vec::new(),
    }
}

fn format_float(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value == value.trunc() && value.abs() < 1e15 {
        return format!("{value:.1}");
    }
    // Six decimals is enough for the engineering units a frame carries, and the
    // trailing zeros are noise in a packet tree.
    let text = format!("{value:.6}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SchemaSource;

    fn ir(ops: Vec<IrOp>) -> DissectorIr {
        DissectorIr {
            schema: SchemaSource::CHeader {
                file: "test.h".to_string(),
                root_struct: "Test".to_string(),
            },
            ops,
        }
    }

    fn named(name: &str, op: IrOp) -> IrOp {
        IrOp::Label {
            name: name.to_string(),
            op: Box::new(op),
        }
    }

    #[test]
    fn integers_and_floats_decode_with_the_right_byte_order() {
        let mut frame = Vec::new();
        frame.extend_from_slice(&0xAA55u16.to_le_bytes()); // 0..2
        frame.extend_from_slice(&0x0102u16.to_be_bytes()); // 2..4
        frame.extend_from_slice(&(-2i16).to_le_bytes()); // 4..6
        frame.extend_from_slice(&(-0.042f32).to_le_bytes()); // 6..10

        let schema = ir(vec![
            named(
                "sync",
                IrOp::UInt {
                    offset: 0,
                    width: 2,
                    big_endian: false,
                },
            ),
            named(
                "big",
                IrOp::UInt {
                    offset: 2,
                    width: 2,
                    big_endian: true,
                },
            ),
            named(
                "signed",
                IrOp::Int {
                    offset: 4,
                    width: 2,
                    big_endian: false,
                },
            ),
            named(
                "gyro_z",
                IrOp::Float {
                    offset: 6,
                    width: 4,
                    big_endian: false,
                },
            ),
        ]);
        let fields = execute(&schema, &frame).unwrap();
        assert_eq!(fields[0].value, "43605");
        assert_eq!(fields[1].value, "258");
        assert_eq!(fields[2].value, "-2");
        let gyro: f64 = fields[3].value_num.unwrap();
        assert!((gyro + 0.042).abs() < 1e-6);
        assert_eq!(fields[3].byte_offset, 6);
        assert_eq!(fields[3].byte_len, 4);
    }

    #[test]
    fn bitfields_read_from_the_low_bits_of_their_unit() {
        // flags:3 at bit 0, channel:5 at bit 3, in byte 0.
        let schema = ir(vec![
            named(
                "flags",
                IrOp::Bitfield {
                    offset: 0,
                    bit_offset: 0,
                    width: 3,
                    big_endian: false,
                },
            ),
            named(
                "channel",
                IrOp::Bitfield {
                    offset: 0,
                    bit_offset: 3,
                    width: 5,
                    big_endian: false,
                },
            ),
        ]);
        let fields = execute(&schema, &[0b1001_0101]).unwrap();
        assert_eq!(fields[0].value, "5");
        assert_eq!(fields[1].value, "18");
    }

    #[test]
    fn enums_map_to_labels_and_fall_back_to_the_number() {
        let schema = ir(vec![named(
            "mode",
            IrOp::Enum {
                offset: 0,
                width: 1,
                variants: vec![(0, "IDLE".into()), (1, "RUN".into()), (2, "FAULT".into())],
                big_endian: false,
            },
        )]);
        assert_eq!(execute(&schema, &[1]).unwrap()[0].value, "RUN");
        assert_eq!(execute(&schema, &[9]).unwrap()[0].value, "9");
    }

    #[test]
    fn an_array_decodes_each_element() {
        let schema = ir(vec![IrOp::Array {
            offset: 1,
            count: 3,
            element: Box::new(named(
                "sample",
                IrOp::UInt {
                    offset: 0,
                    width: 1,
                    big_endian: false,
                },
            )),
        }]);
        let fields = execute(&schema, &[0xFF, 7, 8, 9]).unwrap();
        assert_eq!(fields[0].byte_len, 3);
        let values: Vec<&str> = fields[0]
            .children
            .iter()
            .map(|child| child.value.as_str())
            .collect();
        assert_eq!(values, vec!["7", "8", "9"]);
    }

    #[test]
    fn a_short_frame_names_the_field_that_does_not_fit() {
        let schema = ir(vec![named(
            "timestamp",
            IrOp::UInt {
                offset: 4,
                width: 4,
                big_endian: true,
            },
        )]);
        let error = execute(&schema, &[0; 6]).unwrap_err();
        assert_eq!(
            error,
            ExecError::Bounds {
                field: "timestamp".to_string(),
                need: 8,
                have: 6
            }
        );
        assert!(error.to_string().contains("timestamp"));
    }

    #[test]
    fn a_bad_float_width_is_refused() {
        let schema = ir(vec![named(
            "odd",
            IrOp::Float {
                offset: 0,
                width: 3,
                big_endian: false,
            },
        )]);
        assert_eq!(
            execute(&schema, &[0; 8]).unwrap_err(),
            ExecError::BadWidth {
                field: "odd".to_string(),
                width: 3
            }
        );
    }

    #[test]
    fn sizes_match_the_operations() {
        let array = IrOp::Array {
            offset: 0,
            count: 4,
            element: Box::new(IrOp::UInt {
                offset: 0,
                width: 2,
                big_endian: false,
            }),
        };
        assert_eq!(size_of(&array), 8);
        assert_eq!(
            size_of(&IrOp::Bitfield {
                offset: 0,
                bit_offset: 3,
                width: 5,
                big_endian: false
            }),
            1
        );
    }
}
