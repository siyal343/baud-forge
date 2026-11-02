//! Declarative protocol dissector lab and packet decoding engine.

use std::fs;
use std::path::Path;

/// One decoded field node in the packet tree.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedField {
    pub name: String,
    pub type_name: String,
    pub value_str: String,
    pub byte_offset: usize,
    pub byte_len: usize,
    pub children: Vec<DecodedField>,
}

/// Fully decoded packet with schema metadata and verification badges.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedPacket {
    pub schema_name: String,
    pub sync_valid: bool,
    pub crc_valid: bool,
    pub payload_len: usize,
    pub fields: Vec<DecodedField>,
}

/// Dissector schema source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DissectorSchema {
    BuiltinImu,
    CustomCHeader(String),
    CustomProtobuf(String),
}

impl Default for DissectorSchema {
    fn default() -> Self {
        Self::BuiltinImu
    }
}

/// IEEE 802.3 CRC-32 (Ethernet polynomial 0xEDB88320).
pub fn compute_crc32_ieee(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

/// Decode raw bytes according to the active dissector schema.
pub fn decode_packet(bytes: &[u8], schema: &DissectorSchema) -> Option<DecodedPacket> {
    if bytes.is_empty() {
        return None;
    }

    match schema {
        DissectorSchema::BuiltinImu => decode_builtin_imu(bytes),
        DissectorSchema::CustomCHeader(source) => decode_custom_c_header(bytes, source),
        DissectorSchema::CustomProtobuf(source) => decode_custom_protobuf(bytes, source),
    }
}

/// Built-in IMU schema: Decodes 48-byte packets:
/// - Offset 0..2: sync (uint16_t, 0xBADE)
/// - Offset 2..6: seq (uint32_t)
/// - Offset 6..18: accel (struct { float x, float y, float z })
/// - Offset 18..30: gyro (struct { float p, float q, float r })
/// - Offset 30..42: quat (struct { float w, float x, float y, float z })
/// - Offset 42..44: temp_raw (int16_t / 100.0)
/// - Offset 44..48: crc32 (uint32_t, verified with CRC-32/Castagnoli or IEEE)
fn decode_builtin_imu(bytes: &[u8]) -> Option<DecodedPacket> {
    if bytes.len() < 48 {
        return None;
    }

    // 1. Sync word (Offset 0..2)
    let sync_raw = [bytes[0], bytes[1]];
    let sync_le = u16::from_le_bytes(sync_raw);
    let sync_be = u16::from_be_bytes(sync_raw);
    let sync_valid = sync_raw == [0xBA, 0xDE] || sync_le == 0xBADE || sync_be == 0xBADE;
    let sync_val_str = format!("0x{:02X}{:02X}", sync_raw[0], sync_raw[1]);

    let sync_field = DecodedField {
        name: "sync".to_string(),
        type_name: "uint16_t".to_string(),
        value_str: if sync_valid {
            format!("{sync_val_str} [MATCH]")
        } else {
            sync_val_str
        },
        byte_offset: 0,
        byte_len: 2,
        children: Vec::new(),
    };

    // 2. Sequence Counter (Offset 2..6)
    let seq = u32::from_le_bytes(bytes[2..6].try_into().unwrap());
    let seq_field = DecodedField {
        name: "seq".to_string(),
        type_name: "uint32_t".to_string(),
        value_str: seq.to_string(),
        byte_offset: 2,
        byte_len: 4,
        children: Vec::new(),
    };

    // 3. Accelerometer (Offset 6..18: float x, y, z)
    let ax = f32::from_le_bytes(bytes[6..10].try_into().unwrap());
    let ay = f32::from_le_bytes(bytes[10..14].try_into().unwrap());
    let az = f32::from_le_bytes(bytes[14..18].try_into().unwrap());
    let accel_field = DecodedField {
        name: "accel".to_string(),
        type_name: "struct Vec3f".to_string(),
        value_str: format!("[{ax:+.3}, {ay:+.3}, {az:+.3}] m/s²"),
        byte_offset: 6,
        byte_len: 12,
        children: vec![
            DecodedField {
                name: "x".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{ax:+.4} m/s²"),
                byte_offset: 6,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "y".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{ay:+.4} m/s²"),
                byte_offset: 10,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "z".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{az:+.4} m/s²"),
                byte_offset: 14,
                byte_len: 4,
                children: Vec::new(),
            },
        ],
    };

    // 4. Gyroscope (Offset 18..30: float p, q, r)
    let gp = f32::from_le_bytes(bytes[18..22].try_into().unwrap());
    let gq = f32::from_le_bytes(bytes[22..26].try_into().unwrap());
    let gr = f32::from_le_bytes(bytes[26..30].try_into().unwrap());
    let gyro_field = DecodedField {
        name: "gyro".to_string(),
        type_name: "struct Vec3f".to_string(),
        value_str: format!("[{gp:+.3}, {gq:+.3}, {gr:+.3}] rad/s"),
        byte_offset: 18,
        byte_len: 12,
        children: vec![
            DecodedField {
                name: "p".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{gp:+.4} rad/s"),
                byte_offset: 18,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "q".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{gq:+.4} rad/s"),
                byte_offset: 22,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "r".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{gr:+.4} rad/s"),
                byte_offset: 26,
                byte_len: 4,
                children: Vec::new(),
            },
        ],
    };

    // 5. Quaternion (Offset 30..42: struct { float w, float x, float y, float z })
    let q0 = f32::from_le_bytes(bytes[30..34].try_into().unwrap());
    let q1 = f32::from_le_bytes(bytes[34..38].try_into().unwrap());
    let q2 = f32::from_le_bytes(bytes[38..42].try_into().unwrap());
    let sum_sq = q0 * q0 + q1 * q1 + q2 * q2;
    let qw = if sum_sq <= 1.0 {
        (1.0 - sum_sq).sqrt()
    } else {
        1.0
    };
    let (qx, qy, qz) = (q0, q1, q2);
    let quat_field = DecodedField {
        name: "quat".to_string(),
        type_name: "struct Quat4f".to_string(),
        value_str: format!("[{qw:+.4}, {qx:+.4}, {qy:+.4}, {qz:+.4}]"),
        byte_offset: 30,
        byte_len: 12,
        children: vec![
            DecodedField {
                name: "w".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{qw:+.4}"),
                byte_offset: 30,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "x".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{qx:+.4}"),
                byte_offset: 30,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "y".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{qy:+.4}"),
                byte_offset: 34,
                byte_len: 4,
                children: Vec::new(),
            },
            DecodedField {
                name: "z".to_string(),
                type_name: "float".to_string(),
                value_str: format!("{qz:+.4}"),
                byte_offset: 38,
                byte_len: 4,
                children: Vec::new(),
            },
        ],
    };

    // 6. Raw Temperature (Offset 42..44: int16_t / 100.0)
    let temp_raw = i16::from_le_bytes(bytes[42..44].try_into().unwrap());
    let temp_deg_c = (temp_raw as f32) / 100.0;
    let temp_field = DecodedField {
        name: "temp_raw".to_string(),
        type_name: "int16_t".to_string(),
        value_str: format!("{temp_deg_c:.2} °C ({temp_raw})"),
        byte_offset: 42,
        byte_len: 2,
        children: Vec::new(),
    };

    // 7. CRC32 Checksum (Offset 44..48: uint32_t, Castagnoli or IEEE)
    let expected_crc = u32::from_le_bytes(bytes[44..48].try_into().unwrap());
    let expected_crc_be = u32::from_be_bytes(bytes[44..48].try_into().unwrap());

    let payload_to_crc = &bytes[0..44];
    let crc_castagnoli = bforge_framer::checksum::crc32c(payload_to_crc);
    let crc_ieee = compute_crc32_ieee(payload_to_crc);

    let crc_valid = expected_crc == crc_castagnoli
        || expected_crc == crc_ieee
        || expected_crc_be == crc_castagnoli
        || expected_crc_be == crc_ieee;

    let crc_field = DecodedField {
        name: "crc32".to_string(),
        type_name: "uint32_t".to_string(),
        value_str: format!(
            "0x{expected_crc:08X} [{}]",
            if crc_valid {
                "CRC32 OK"
            } else {
                "CRC MISMATCH"
            }
        ),
        byte_offset: 44,
        byte_len: 4,
        children: Vec::new(),
    };

    Some(DecodedPacket {
        schema_name: "Built-in IMU 9-DoF (48B)".to_string(),
        sync_valid,
        crc_valid,
        payload_len: 48,
        fields: vec![
            sync_field,
            seq_field,
            accel_field,
            gyro_field,
            quat_field,
            temp_field,
            crc_field,
        ],
    })
}

/// Decodes packet using custom C header definition.
fn decode_custom_c_header(bytes: &[u8], source: &str) -> Option<DecodedPacket> {
    let code = if Path::new(source).is_file() {
        fs::read_to_string(source).unwrap_or_else(|_| source.to_string())
    } else {
        source.to_string()
    };

    // First attempt full C struct parsing and compilation via bforge-dissect
    if let Ok(c_header) = bforge_dissect::cheader::parse(&code) {
        if let Some(first_struct) = c_header.structs.first() {
            let root_name = first_struct.name.clone();
            if let Ok(ir) = bforge_dissect::cheader::compile(&c_header, &root_name, "custom.h") {
                if let Ok(dissect_fields) = bforge_dissect::exec::execute(&ir, bytes) {
                    let fields = dissect_fields
                        .into_iter()
                        .map(|f| convert_dissect_field(f, first_struct))
                        .collect::<Vec<_>>();

                    let sync_valid = fields.first().map_or(true, |f| f.value_str != "0x0000");
                    let crc_valid = true;

                    return Some(DecodedPacket {
                        schema_name: format!("C Struct: {root_name}"),
                        sync_valid,
                        crc_valid,
                        payload_len: bytes.len(),
                        fields,
                    });
                }
            }
        }
    }

    // Direct sequential primitive decoder fallback
    let primitive_fields = parse_primitive_c_struct(&code, bytes);
    if !primitive_fields.is_empty() {
        let sync_valid = true;
        let crc_valid = true;
        return Some(DecodedPacket {
            schema_name: "C Header (Primitive Types)".to_string(),
            sync_valid,
            crc_valid,
            payload_len: bytes.len(),
            fields: primitive_fields,
        });
    }

    None
}

/// Helper converting bforge-dissect field into GUI DecodedField.
fn convert_dissect_field(
    field: bforge_dissect::DecodedField,
    struct_def: &bforge_dissect::cheader::CStruct,
) -> DecodedField {
    let type_name = struct_def
        .fields
        .iter()
        .find(|m| m.name == field.name)
        .map(|m| m.type_name.clone())
        .unwrap_or_else(|| match field.byte_len {
            1 => "uint8_t".to_string(),
            2 => "uint16_t".to_string(),
            4 => "uint32_t".to_string(),
            8 => "uint64_t".to_string(),
            _ => "raw".to_string(),
        });

    let children = field
        .children
        .into_iter()
        .map(|child| convert_dissect_field(child, struct_def))
        .collect();

    DecodedField {
        name: field.name,
        type_name,
        value_str: field.value,
        byte_offset: field.byte_offset as usize,
        byte_len: field.byte_len as usize,
        children,
    }
}

/// Parses sequential primitives from C header text:
/// uint8/uint16/uint32/int8/int16/int32/float/double.
fn parse_primitive_c_struct(code: &str, bytes: &[u8]) -> Vec<DecodedField> {
    let mut fields = Vec::new();
    let mut offset = 0;

    for line in code.lines() {
        let clean = line.trim();
        if clean.starts_with("//") || clean.starts_with('#') || clean.is_empty() {
            continue;
        }

        let parts: Vec<&str> = clean
            .trim_end_matches(';')
            .split_whitespace()
            .collect();

        if parts.len() >= 2 {
            let t = parts[0];
            let name = parts[1].trim_matches(|c: char| !c.is_alphanumeric() && c != '_');

            match t {
                "uint8" | "uint8_t" | "u8" | "char" | "unsigned char" => {
                    if offset + 1 <= bytes.len() {
                        let val = bytes[offset];
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "uint8_t".to_string(),
                            value_str: format!("{val} (0x{val:02X})"),
                            byte_offset: offset,
                            byte_len: 1,
                            children: Vec::new(),
                        });
                        offset += 1;
                    }
                }
                "int8" | "int8_t" | "i8" | "signed char" => {
                    if offset + 1 <= bytes.len() {
                        let val = bytes[offset] as i8;
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "int8_t".to_string(),
                            value_str: format!("{val}"),
                            byte_offset: offset,
                            byte_len: 1,
                            children: Vec::new(),
                        });
                        offset += 1;
                    }
                }
                "uint16" | "uint16_t" | "u16" | "unsigned short" => {
                    if offset + 2 <= bytes.len() {
                        let val = u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "uint16_t".to_string(),
                            value_str: format!("{val} (0x{val:04X})"),
                            byte_offset: offset,
                            byte_len: 2,
                            children: Vec::new(),
                        });
                        offset += 2;
                    }
                }
                "int16" | "int16_t" | "i16" | "short" => {
                    if offset + 2 <= bytes.len() {
                        let val = i16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "int16_t".to_string(),
                            value_str: format!("{val}"),
                            byte_offset: offset,
                            byte_len: 2,
                            children: Vec::new(),
                        });
                        offset += 2;
                    }
                }
                "uint32" | "uint32_t" | "u32" | "unsigned int" | "uint" => {
                    if offset + 4 <= bytes.len() {
                        let val = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "uint32_t".to_string(),
                            value_str: format!("{val} (0x{val:08X})"),
                            byte_offset: offset,
                            byte_len: 4,
                            children: Vec::new(),
                        });
                        offset += 4;
                    }
                }
                "int32" | "int32_t" | "i32" | "int" => {
                    if offset + 4 <= bytes.len() {
                        let val = i32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "int32_t".to_string(),
                            value_str: format!("{val}"),
                            byte_offset: offset,
                            byte_len: 4,
                            children: Vec::new(),
                        });
                        offset += 4;
                    }
                }
                "float" => {
                    if offset + 4 <= bytes.len() {
                        let val = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "float".to_string(),
                            value_str: format!("{val:+.4}"),
                            byte_offset: offset,
                            byte_len: 4,
                            children: Vec::new(),
                        });
                        offset += 4;
                    }
                }
                "double" => {
                    if offset + 8 <= bytes.len() {
                        let val = f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
                        fields.push(DecodedField {
                            name: name.to_string(),
                            type_name: "double".to_string(),
                            value_str: format!("{val:+.6}"),
                            byte_offset: offset,
                            byte_len: 8,
                            children: Vec::new(),
                        });
                        offset += 8;
                    }
                }
                _ => {}
            }
        }
    }

    fields
}

/// Decodes protobuf wire format tags and primitives.
fn decode_custom_protobuf(bytes: &[u8], source: &str) -> Option<DecodedPacket> {
    let mut fields = Vec::new();
    let mut offset = 0;

    while offset < bytes.len() {
        let tag_offset = offset;
        let (key, key_len) = decode_varint(&bytes[offset..])?;
        offset += key_len;

        let field_num = key >> 3;
        let wire_type = key & 0x07;

        match wire_type {
            0 => {
                // Varint
                let (val, val_len) = decode_varint(&bytes[offset..])?;
                offset += val_len;
                fields.push(DecodedField {
                    name: format!("field_{field_num}"),
                    type_name: "varint".to_string(),
                    value_str: format!("{val} (0x{val:X})"),
                    byte_offset: tag_offset,
                    byte_len: offset - tag_offset,
                    children: Vec::new(),
                });
            }
            1 => {
                // 64-bit
                if offset + 8 > bytes.len() {
                    break;
                }
                let bits = u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
                let f_val = f64::from_bits(bits);
                offset += 8;
                fields.push(DecodedField {
                    name: format!("field_{field_num}"),
                    type_name: "fixed64/double".to_string(),
                    value_str: format!("{f_val:+.4} (bits 0x{bits:016X})"),
                    byte_offset: tag_offset,
                    byte_len: offset - tag_offset,
                    children: Vec::new(),
                });
            }
            2 => {
                // Length-delimited
                let (len, len_bytes) = decode_varint(&bytes[offset..])?;
                offset += len_bytes;
                let len = len as usize;
                if offset + len > bytes.len() {
                    break;
                }
                let payload = &bytes[offset..offset + len];
                offset += len;
                let ascii_opt = std::str::from_utf8(payload).ok();
                let val_str = if let Some(s) = ascii_opt {
                    format!("\"{s}\"")
                } else {
                    format!("<{} bytes binary>", payload.len())
                };

                fields.push(DecodedField {
                    name: format!("field_{field_num}"),
                    type_name: "length_delimited".to_string(),
                    value_str: val_str,
                    byte_offset: tag_offset,
                    byte_len: offset - tag_offset,
                    children: Vec::new(),
                });
            }
            5 => {
                // 32-bit
                if offset + 4 > bytes.len() {
                    break;
                }
                let bits = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
                let f_val = f32::from_bits(bits);
                offset += 4;
                fields.push(DecodedField {
                    name: format!("field_{field_num}"),
                    type_name: "fixed32/float".to_string(),
                    value_str: format!("{f_val:+.4} (bits 0x{bits:08X})"),
                    byte_offset: tag_offset,
                    byte_len: offset - tag_offset,
                    children: Vec::new(),
                });
            }
            _ => {
                // Unknown wire type, cannot proceed cleanly
                break;
            }
        }
    }

    if fields.is_empty() {
        return None;
    }

    let schema_title = if source.is_empty() {
        "Protobuf Wire Stream".to_string()
    } else {
        format!("Protobuf: {source}")
    };

    Some(DecodedPacket {
        schema_name: schema_title,
        sync_valid: true,
        crc_valid: true,
        payload_len: bytes.len(),
        fields,
    })
}

/// Helper decoding a protobuf unsigned varint.
fn decode_varint(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut result = 0u64;
    let mut shift = 0;
    for (i, &b) in bytes.iter().enumerate().take(10) {
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((result, i + 1));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_builtin_imu_48b() {
        let mut packet = Vec::with_capacity(48);
        // Sync 0xBADE
        packet.extend_from_slice(&[0xBA, 0xDE]);
        // Seq 1024
        packet.extend_from_slice(&1024u32.to_le_bytes());
        // Accel: x=0.01, y=0.02, z=9.81
        packet.extend_from_slice(&0.01f32.to_le_bytes());
        packet.extend_from_slice(&0.02f32.to_le_bytes());
        packet.extend_from_slice(&9.81f32.to_le_bytes());
        // Gyro: p=0.1, q=0.2, r=0.3
        packet.extend_from_slice(&0.1f32.to_le_bytes());
        packet.extend_from_slice(&0.2f32.to_le_bytes());
        packet.extend_from_slice(&0.3f32.to_le_bytes());
        // Quat: 3 floats x=0.0, y=0.7071, z=0.0
        packet.extend_from_slice(&0.0f32.to_le_bytes());
        packet.extend_from_slice(&0.7071f32.to_le_bytes());
        packet.extend_from_slice(&0.0f32.to_le_bytes());
        // Temp raw: 3650 (36.50 C)
        packet.extend_from_slice(&3650i16.to_le_bytes());
        // CRC32 Castagnoli
        let crc = bforge_framer::checksum::crc32c(&packet);
        packet.extend_from_slice(&crc.to_le_bytes());

        assert_eq!(packet.len(), 48);

        let decoded = decode_packet(&packet, &DissectorSchema::BuiltinImu).expect("Failed to decode IMU packet");
        assert_eq!(decoded.schema_name, "Built-in IMU 9-DoF (48B)");
        assert!(decoded.sync_valid, "Sync word should be valid");
        assert!(decoded.crc_valid, "CRC32 should be valid");
        assert_eq!(decoded.payload_len, 48);
        assert_eq!(decoded.fields.len(), 7);

        // Check fields
        assert_eq!(decoded.fields[0].name, "sync");
        assert_eq!(decoded.fields[0].byte_offset, 0);
        assert_eq!(decoded.fields[0].byte_len, 2);

        assert_eq!(decoded.fields[1].name, "seq");
        assert_eq!(decoded.fields[1].value_str, "1024");
        assert_eq!(decoded.fields[1].byte_offset, 2);
        assert_eq!(decoded.fields[1].byte_len, 4);

        assert_eq!(decoded.fields[2].name, "accel");
        assert_eq!(decoded.fields[2].children.len(), 3);
        assert_eq!(decoded.fields[2].byte_offset, 6);
        assert_eq!(decoded.fields[2].byte_len, 12);

        assert_eq!(decoded.fields[3].name, "gyro");
        assert_eq!(decoded.fields[3].children.len(), 3);
        assert_eq!(decoded.fields[3].byte_offset, 18);
        assert_eq!(decoded.fields[3].byte_len, 12);

        assert_eq!(decoded.fields[4].name, "quat");
        assert_eq!(decoded.fields[4].children.len(), 4);
        assert_eq!(decoded.fields[4].byte_offset, 30);
        assert_eq!(decoded.fields[4].byte_len, 12);

        assert_eq!(decoded.fields[5].name, "temp_raw");
        assert!(decoded.fields[5].value_str.contains("36.50 °C"));
        assert_eq!(decoded.fields[5].byte_offset, 42);
        assert_eq!(decoded.fields[5].byte_len, 2);

        assert_eq!(decoded.fields[6].name, "crc32");
        assert!(decoded.fields[6].value_str.contains("CRC32 OK"));
        assert_eq!(decoded.fields[6].byte_offset, 44);
        assert_eq!(decoded.fields[6].byte_len, 4);
    }

    #[test]
    fn test_decode_custom_c_header_primitives() {
        let header_str = r#"
            uint16_t sync_marker;
            uint32_t packet_id;
            float temperature;
            double latitude;
        "#;

        let mut data = Vec::new();
        data.extend_from_slice(&0xABCDu16.to_le_bytes());
        data.extend_from_slice(&42u32.to_le_bytes());
        data.extend_from_slice(&25.5f32.to_le_bytes());
        data.extend_from_slice(&37.7749f64.to_le_bytes());

        let decoded = decode_packet(
            &data,
            &DissectorSchema::CustomCHeader(header_str.to_string()),
        )
        .expect("Failed to decode custom C header packet");

        assert_eq!(decoded.fields.len(), 4);
        assert_eq!(decoded.fields[0].name, "sync_marker");
        assert_eq!(decoded.fields[0].type_name, "uint16_t");
        assert_eq!(decoded.fields[1].name, "packet_id");
        assert_eq!(decoded.fields[2].name, "temperature");
        assert_eq!(decoded.fields[3].name, "latitude");
    }

    #[test]
    fn test_decode_protobuf_wire_format() {
        let mut data = Vec::new();
        // Field 1, wire type 0 (varint): value 150
        data.push((1 << 3) | 0);
        data.extend_from_slice(&[0x96, 0x01]);
        // Field 2, wire type 2 (string): "test"
        data.push((2 << 3) | 2);
        data.push(4);
        data.extend_from_slice(b"test");

        let decoded = decode_packet(
            &data,
            &DissectorSchema::CustomProtobuf("test.proto".to_string()),
        )
        .expect("Failed to decode protobuf packet");

        assert_eq!(decoded.fields.len(), 2);
        assert_eq!(decoded.fields[0].name, "field_1");
        assert!(decoded.fields[0].value_str.contains("150"));
        assert_eq!(decoded.fields[1].name, "field_2");
        assert_eq!(decoded.fields[1].value_str, "\"test\"");
    }
}
