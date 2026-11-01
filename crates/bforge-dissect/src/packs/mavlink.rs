//! MAVLink v1 and v2 with XML dialect support (FR-DIS-02, D-56).
//!
//! ```text
//! v1  0xFE  len seq sysid compid msgid                    payload  crc16
//! v2  0xFD  len incompat compat seq sysid compid msgid(3) payload  crc16
//! ```
//!
//! The envelope is fixed and is decoded for every frame. When a dialect is loaded,
//! message payloads decode according to the dialect schema with enum label resolution
//! and field reordering. Without a dialect, four common messages decode by offset
//! and any other `msgid` keeps its id and displays the payload as hex.
//!
//! The checksum is X.25/CRC-16-MCRF4XX over the header and payload plus an 8-bit
//! `CRC_EXTRA` derived from the message definition.

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;
use std::collections::HashMap;

/// Length of the frame trailer.
const CRC_LEN: usize = 2;

/// A parsed MAVLink XML dialect schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MavlinkDialect {
    /// Message definitions indexed by message id.
    pub messages: HashMap<u32, MavMessage>,
    /// Enum definitions indexed by enum name.
    pub enums: HashMap<String, MavEnum>,
}

/// One message definition in a MAVLink dialect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MavMessage {
    /// MAVLink message ID.
    pub id: u32,
    /// Message name (e.g. "HEARTBEAT").
    pub name: String,
    /// CRC_EXTRA byte seed computed from base fields.
    pub crc_extra: u8,
    /// Length in bytes of the base (pre-extension) payload.
    pub base_payload_len: usize,
    /// Total length in bytes of the full payload including extensions.
    pub full_payload_len: usize,
    /// Ordered fields on the wire.
    pub fields: Vec<MavField>,
}

/// One field defined in a MAVLink message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MavField {
    /// Field name.
    pub name: String,
    /// Full type string (e.g. "uint32_t", "char[16]").
    pub type_str: String,
    /// Base element type name (e.g. "uint32_t", "char").
    pub base_type: String,
    /// Array element count if this is an array field.
    pub array_len: Option<usize>,
    /// Wire size of a single element in bytes.
    pub element_size: usize,
    /// Total wire size of the field in bytes.
    pub total_size: usize,
    /// Byte offset of the field within the message payload on the wire.
    pub wire_offset: usize,
    /// Whether this field was declared after the `<extensions/>` marker.
    pub is_extension: bool,
    /// Optional enum type name for value resolution.
    pub enum_name: Option<String>,
}

/// One enum definition in a MAVLink dialect.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MavEnum {
    /// Enum name.
    pub name: String,
    /// Entries indexed by numerical value.
    pub entries: HashMap<i64, String>,
}

/// X.25 CRC-16 (MCRF4XX) accumulator used by MAVLink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct X25Crc {
    crc: u16,
}

impl Default for X25Crc {
    fn default() -> Self {
        Self::new()
    }
}

impl X25Crc {
    /// Initialize with the standard seed 0xFFFF.
    pub fn new() -> Self {
        Self { crc: 0xFFFF }
    }

    /// Accumulate a single byte.
    pub fn accumulate_byte(&mut self, b: u8) {
        let mut tmp = b ^ (self.crc as u8);
        tmp ^= tmp.wrapping_shl(4);
        self.crc =
            (self.crc >> 8) ^ ((tmp as u16) << 8) ^ ((tmp as u16) << 3) ^ ((tmp as u16) >> 4);
    }

    /// Accumulate a byte slice.
    pub fn accumulate_slice(&mut self, data: &[u8]) {
        for &b in data {
            self.accumulate_byte(b);
        }
    }

    /// Retrieve the current 16-bit CRC.
    pub fn crc(&self) -> u16 {
        self.crc
    }

    /// Retrieve the folded 8-bit CRC_EXTRA value.
    pub fn crc_extra(&self) -> u8 {
        ((self.crc & 0xFF) ^ (self.crc >> 8)) as u8
    }
}

/// Parse a MAVLink dialect XML string into a `MavlinkDialect`.
pub fn parse_xml(xml: &str) -> Result<MavlinkDialect, String> {
    let clean = strip_processing_instructions(&strip_comments(xml));
    let mut dialect = MavlinkDialect::default();
    let mut current_enum: Option<(String, HashMap<i64, String>)> = None;
    let mut current_msg: Option<BuildingMessage> = None;

    let mut offset = 0;
    while let Some((tag, next_offset)) = next_tag(&clean, offset) {
        offset = next_offset;
        match tag {
            Tag::Open {
                name: "enum",
                attrs,
            } => {
                let enum_name = find_attr(&attrs, "name").unwrap_or_default().to_string();
                current_enum = Some((enum_name, HashMap::new()));
            }
            Tag::Close { name: "enum" } => {
                if let Some((name, entries)) = current_enum.take() {
                    dialect
                        .enums
                        .insert(name.clone(), MavEnum { name, entries });
                }
            }
            Tag::Open {
                name: "entry",
                attrs,
            }
            | Tag::SelfClosing {
                name: "entry",
                attrs,
            } => {
                if let Some((_, ref mut entries)) = current_enum {
                    let name = find_attr(&attrs, "name").unwrap_or_default().to_string();
                    if let Some(val_str) = find_attr(&attrs, "value")
                        && let Some(val) = parse_int(val_str)
                    {
                        entries.insert(val, name);
                    }
                }
            }
            Tag::Open {
                name: "message",
                attrs,
            } => {
                let id_str = find_attr(&attrs, "id")
                    .ok_or_else(|| "message missing id attribute".to_string())?;
                let id = parse_int(id_str)
                    .ok_or_else(|| format!("invalid message id `{id_str}`"))?
                    as u32;
                let name = find_attr(&attrs, "name").unwrap_or_default().to_string();
                current_msg = Some(BuildingMessage {
                    id,
                    name,
                    base_fields: Vec::new(),
                    ext_fields: Vec::new(),
                    in_extensions: false,
                });
            }
            Tag::Open {
                name: "extensions", ..
            }
            | Tag::SelfClosing {
                name: "extensions", ..
            } => {
                if let Some(ref mut msg) = current_msg {
                    msg.in_extensions = true;
                }
            }
            Tag::Open {
                name: "field",
                attrs,
            }
            | Tag::SelfClosing {
                name: "field",
                attrs,
            } => {
                if let Some(ref mut msg) = current_msg {
                    let type_str = find_attr(&attrs, "type")
                        .ok_or_else(|| "field missing type attribute".to_string())?;
                    let field_name = find_attr(&attrs, "name")
                        .ok_or_else(|| "field missing name attribute".to_string())?;
                    let enum_attr = find_attr(&attrs, "enum").map(|s| s.to_string());
                    let (base_type, array_len) = parse_field_type(type_str)?;
                    let element_size = element_size_of(&base_type)?;
                    let total_size = element_size * array_len.unwrap_or(1);

                    let field = MavField {
                        name: field_name.to_string(),
                        type_str: type_str.to_string(),
                        base_type,
                        array_len,
                        element_size,
                        total_size,
                        wire_offset: 0,
                        is_extension: msg.in_extensions,
                        enum_name: enum_attr,
                    };
                    if msg.in_extensions {
                        msg.ext_fields.push(field);
                    } else {
                        msg.base_fields.push(field);
                    }
                }
            }
            Tag::Close { name: "message" } => {
                if let Some(msg) = current_msg.take() {
                    let finished = finish_message(msg)?;
                    dialect.messages.insert(finished.id, finished);
                }
            }
            _ => {}
        }
    }

    Ok(dialect)
}

struct BuildingMessage {
    id: u32,
    name: String,
    base_fields: Vec<MavField>,
    ext_fields: Vec<MavField>,
    in_extensions: bool,
}

fn finish_message(mut msg: BuildingMessage) -> Result<MavMessage, String> {
    // Sort base fields descending by element wire size.
    // Rust's slice::sort_by_key is stable, preserving XML declaration order for ties.
    msg.base_fields
        .sort_by_key(|a| std::cmp::Reverse(a.element_size));

    let crc_extra = compute_crc_extra(&msg.name, &msg.base_fields);

    let mut wire_offset = 0;
    let mut ordered = Vec::with_capacity(msg.base_fields.len() + msg.ext_fields.len());

    for mut f in msg.base_fields {
        f.wire_offset = wire_offset;
        wire_offset += f.total_size;
        ordered.push(f);
    }
    let base_payload_len = wire_offset;

    for mut f in msg.ext_fields {
        f.wire_offset = wire_offset;
        wire_offset += f.total_size;
        ordered.push(f);
    }
    let full_payload_len = wire_offset;

    Ok(MavMessage {
        id: msg.id,
        name: msg.name,
        crc_extra,
        base_payload_len,
        full_payload_len,
        fields: ordered,
    })
}

fn compute_crc_extra(msg_name: &str, reordered_base_fields: &[MavField]) -> u8 {
    let mut crc = X25Crc::new();
    crc.accumulate_slice(msg_name.as_bytes());
    crc.accumulate_byte(b' ');
    for field in reordered_base_fields {
        let type_name = if field.base_type == "uint8_t_mavlink_version" {
            "uint8_t"
        } else {
            &field.base_type
        };
        crc.accumulate_slice(type_name.as_bytes());
        crc.accumulate_byte(b' ');
        crc.accumulate_slice(field.name.as_bytes());
        crc.accumulate_byte(b' ');
        if let Some(arr_len) = field.array_len {
            crc.accumulate_byte(arr_len as u8);
        }
    }
    crc.crc_extra()
}

fn parse_field_type(type_str: &str) -> Result<(String, Option<usize>), String> {
    let type_str = type_str.trim();
    if let Some(open) = type_str.find('[') {
        let close = type_str
            .find(']')
            .ok_or_else(|| format!("unclosed array bracket in `{type_str}`"))?;
        let base = type_str[..open].trim().to_string();
        let len_str = type_str[open + 1..close].trim();
        let len = len_str
            .parse::<usize>()
            .map_err(|e| format!("invalid array length `{len_str}`: {e}"))?;
        Ok((base, Some(len)))
    } else {
        Ok((type_str.to_string(), None))
    }
}

fn element_size_of(base_type: &str) -> Result<usize, String> {
    match base_type {
        "uint64_t" | "int64_t" | "double" => Ok(8),
        "uint32_t" | "int32_t" | "float" => Ok(4),
        "uint16_t" | "int16_t" => Ok(2),
        "uint8_t" | "int8_t" | "char" | "uint8_t_mavlink_version" => Ok(1),
        other => Err(format!("unknown MAVLink type `{other}`")),
    }
}

fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok()
    } else {
        s.parse::<i64>().ok()
    }
}

fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 4..].find("-->") {
            rest = &rest[start + 4 + end + 3..];
        } else {
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn strip_processing_instructions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<?") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 2..].find("?>") {
            rest = &rest[start + 2 + end + 2..];
        } else {
            return out;
        }
    }
    out.push_str(rest);
    out
}

enum Tag<'a> {
    Open {
        name: &'a str,
        attrs: Vec<(&'a str, &'a str)>,
    },
    Close {
        name: &'a str,
    },
    SelfClosing {
        name: &'a str,
        attrs: Vec<(&'a str, &'a str)>,
    },
}

fn next_tag<'a>(input: &'a str, mut offset: usize) -> Option<(Tag<'a>, usize)> {
    while offset < input.len() {
        let rel_open = input[offset..].find('<')?;
        let open_idx = offset + rel_open;
        let rel_close = input[open_idx..].find('>')?;
        let close_idx = open_idx + rel_close;
        let content = input[open_idx + 1..close_idx].trim();
        let next_offset = close_idx + 1;

        if content.starts_with('!') {
            offset = next_offset;
            continue;
        }

        if let Some(name) = content.strip_prefix('/') {
            return Some((Tag::Close { name: name.trim() }, next_offset));
        }

        let is_self_closing = content.ends_with('/');
        let body = if is_self_closing {
            content[..content.len() - 1].trim()
        } else {
            content
        };

        let mut parts = body.splitn(2, |c: char| c.is_whitespace());
        let tag_name = parts.next().unwrap_or("").trim();
        let attr_str = parts.next().unwrap_or("");
        let attrs = parse_attrs(attr_str);

        if is_self_closing {
            return Some((
                Tag::SelfClosing {
                    name: tag_name,
                    attrs,
                },
                next_offset,
            ));
        } else {
            return Some((
                Tag::Open {
                    name: tag_name,
                    attrs,
                },
                next_offset,
            ));
        }
    }
    None
}

fn parse_attrs(mut s: &str) -> Vec<(&str, &str)> {
    let mut attrs = Vec::new();
    while !s.is_empty() {
        s = s.trim_start();
        if s.is_empty() {
            break;
        }
        let key_end = s
            .find(|c: char| c == '=' || c.is_whitespace() || c == '/')
            .unwrap_or(s.len());
        let key = &s[..key_end];
        s = s[key_end..].trim_start();
        if s.starts_with('=') {
            s = s[1..].trim_start();
            if s.starts_with('"') || s.starts_with('\'') {
                let quote = s.chars().next().unwrap();
                s = &s[quote.len_utf8()..];
                let val_end = s.find(quote).unwrap_or(s.len());
                let val = &s[..val_end];
                attrs.push((key, val));
                s = if val_end < s.len() {
                    &s[val_end + quote.len_utf8()..]
                } else {
                    ""
                };
            } else {
                let val_end = s.find(|c: char| c.is_whitespace()).unwrap_or(s.len());
                let val = &s[..val_end];
                attrs.push((key, val));
                s = &s[val_end..];
            }
        }
    }
    attrs
}

fn find_attr<'a>(attrs: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// Decode one MAVLink frame without a dialect, using built-in definitions for the common four.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    decode_with_dialect(frame, &MavlinkDialect::default())
}

/// Decode one MAVLink frame with an XML dialect schema.
pub fn decode_with_dialect(
    frame: &[u8],
    dialect: &MavlinkDialect,
) -> Result<Vec<DecodedField>, ExecError> {
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

    let msg_name = if let Some(msg) = dialect.messages.get(&msgid) {
        msg.name.as_str()
    } else {
        message_name(msgid)
    };
    fields.push(field(
        "msgid",
        msgid_at as u32,
        version as u32,
        format!("{msgid} ({msg_name})"),
        Some(f64::from(msgid)),
    ));

    let raw_payload = &frame[payload_at..payload_at + payload_len];

    if let Some(msg_def) = dialect.messages.get(&msgid) {
        let mut padded;
        let effective_payload = if version == 2 && raw_payload.len() < msg_def.full_payload_len {
            padded = raw_payload.to_vec();
            padded.resize(msg_def.full_payload_len, 0);
            &padded[..]
        } else {
            raw_payload
        };
        fields.extend(decode_dialect_payload(
            msg_def,
            dialect,
            effective_payload,
            payload_at as u32,
            raw_payload.len(),
        ));
    } else {
        match decode_body(msgid, raw_payload, payload_at as u32, version == 2) {
            Some(body) => fields.extend(body),
            None => fields.push(field(
                "payload",
                payload_at as u32,
                payload_len as u32,
                hex(raw_payload),
                None,
            )),
        }
    }

    let crc_at = payload_at + payload_len;
    let crc = u16::from_le_bytes([frame[crc_at], frame[crc_at + 1]]);

    let crc_extra = if let Some(msg) = dialect.messages.get(&msgid) {
        Some(msg.crc_extra)
    } else {
        match msgid {
            0 => Some(50),
            24 => Some(24),
            30 => Some(39),
            33 => Some(104),
            _ => None,
        }
    };

    if let Some(extra) = crc_extra {
        let mut hasher = X25Crc::new();
        hasher.accumulate_slice(&frame[1..payload_at + payload_len]);
        hasher.accumulate_byte(extra);
        let expected = hasher.crc();
        if crc == expected {
            fields.push(field(
                "checksum",
                crc_at as u32,
                2,
                format!("0x{crc:04X} (valid)"),
                Some(f64::from(crc)),
            ));
            fields.push(field(
                "crc_status",
                crc_at as u32,
                2,
                "valid".to_string(),
                Some(1.0),
            ));
        } else {
            fields.push(field(
                "checksum",
                crc_at as u32,
                2,
                format!("0x{crc:04X} (invalid, expected 0x{expected:04X})"),
                Some(f64::from(crc)),
            ));
            fields.push(field(
                "crc_status",
                crc_at as u32,
                2,
                "invalid".to_string(),
                Some(0.0),
            ));
        }
    } else {
        fields.push(field(
            "checksum",
            crc_at as u32,
            2,
            format!("0x{crc:04X} (needs the dialect's CRC_EXTRA to verify)"),
            Some(f64::from(crc)),
        ));
        fields.push(field(
            "crc_status",
            crc_at as u32,
            2,
            "unverified".to_string(),
            None,
        ));
    }

    Ok(fields)
}

fn decode_dialect_payload(
    msg: &MavMessage,
    dialect: &MavlinkDialect,
    payload: &[u8],
    base_offset: u32,
    raw_payload_len: usize,
) -> Vec<DecodedField> {
    let mut fields = Vec::with_capacity(msg.fields.len());
    for field_def in &msg.fields {
        if field_def.is_extension && field_def.wire_offset >= raw_payload_len {
            // Extension field omitted on the wire.
            continue;
        }

        let at = field_def.wire_offset;
        let width = field_def.total_size;
        let field_abs_offset = base_offset + at as u32;

        if at + width > payload.len() {
            continue;
        }

        let slice = &payload[at..at + width];

        if field_def.base_type == "char" {
            if field_def.array_len.is_some() {
                let text_bytes: Vec<u8> = slice.iter().take_while(|&&b| b != 0).copied().collect();
                let val_str = String::from_utf8_lossy(&text_bytes).trim().to_string();
                fields.push(field(
                    &field_def.name,
                    field_abs_offset,
                    width as u32,
                    val_str,
                    None,
                ));
            } else {
                let b = slice[0];
                fields.push(field(
                    &field_def.name,
                    field_abs_offset,
                    1,
                    (b as char).to_string(),
                    Some(f64::from(b)),
                ));
            }
            continue;
        }

        if let Some(arr_len) = field_def.array_len {
            let elem_sz = field_def.element_size;
            let mut element_strs = Vec::with_capacity(arr_len);
            for i in 0..arr_len {
                let elem_at = at + i * elem_sz;
                if elem_at + elem_sz <= payload.len() {
                    let elem_slice = &payload[elem_at..elem_at + elem_sz];
                    element_strs.push(format_element(&field_def.base_type, elem_slice));
                }
            }
            let text = format!("[{}]", element_strs.join(", "));
            fields.push(field(
                &field_def.name,
                field_abs_offset,
                width as u32,
                text,
                None,
            ));
            continue;
        }

        let (text, num_val) = match field_def.base_type.as_str() {
            "float" => {
                let bits = u32::from_le_bytes(slice.try_into().unwrap());
                let val = f32::from_bits(bits);
                (format!("{val:.4}"), Some(f64::from(val)))
            }
            "double" => {
                let bits = u64::from_le_bytes(slice.try_into().unwrap());
                let val = f64::from_bits(bits);
                (format!("{val:.4}"), Some(val))
            }
            "int8_t" => {
                let val = (slice[0] as i8) as i64;
                (
                    resolve_enum_or_int(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "int16_t" => {
                let val = i16::from_le_bytes(slice.try_into().unwrap()) as i64;
                (
                    resolve_enum_or_int(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "int32_t" => {
                let val = i32::from_le_bytes(slice.try_into().unwrap()) as i64;
                (
                    resolve_enum_or_int(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "int64_t" => {
                let val = i64::from_le_bytes(slice.try_into().unwrap());
                (
                    resolve_enum_or_int(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "uint8_t" | "uint8_t_mavlink_version" => {
                let val = slice[0] as u64;
                (
                    resolve_enum_or_uint(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "uint16_t" => {
                let val = u16::from_le_bytes(slice.try_into().unwrap()) as u64;
                (
                    resolve_enum_or_uint(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "uint32_t" => {
                let val = u32::from_le_bytes(slice.try_into().unwrap()) as u64;
                (
                    resolve_enum_or_uint(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            "uint64_t" => {
                let val = u64::from_le_bytes(slice.try_into().unwrap());
                (
                    resolve_enum_or_uint(val, field_def.enum_name.as_deref(), dialect),
                    Some(val as f64),
                )
            }
            _ => (hex(slice), None),
        };

        fields.push(field(
            &field_def.name,
            field_abs_offset,
            width as u32,
            text,
            num_val,
        ));
    }
    fields
}

fn resolve_enum_or_uint(val: u64, enum_name: Option<&str>, dialect: &MavlinkDialect) -> String {
    if let Some(ename) = enum_name
        && let Some(mav_enum) = dialect.enums.get(ename)
        && let Some(entry_name) = mav_enum.entries.get(&(val as i64))
    {
        return format!("{val} ({entry_name})");
    }
    val.to_string()
}

fn resolve_enum_or_int(val: i64, enum_name: Option<&str>, dialect: &MavlinkDialect) -> String {
    if let Some(ename) = enum_name
        && let Some(mav_enum) = dialect.enums.get(ename)
        && let Some(entry_name) = mav_enum.entries.get(&val)
    {
        return format!("{val} ({entry_name})");
    }
    val.to_string()
}

fn format_element(base_type: &str, slice: &[u8]) -> String {
    match base_type {
        "float" => {
            let val = f32::from_bits(u32::from_le_bytes(slice.try_into().unwrap()));
            format!("{val:.4}")
        }
        "double" => {
            let val = f64::from_bits(u64::from_le_bytes(slice.try_into().unwrap()));
            format!("{val:.4}")
        }
        "int8_t" => ((slice[0] as i8) as i64).to_string(),
        "int16_t" => (i16::from_le_bytes(slice.try_into().unwrap()) as i64).to_string(),
        "int32_t" => (i32::from_le_bytes(slice.try_into().unwrap()) as i64).to_string(),
        "int64_t" => i64::from_le_bytes(slice.try_into().unwrap()).to_string(),
        "uint8_t" | "uint8_t_mavlink_version" => (slice[0] as u64).to_string(),
        "uint16_t" => (u16::from_le_bytes(slice.try_into().unwrap()) as u64).to_string(),
        "uint32_t" => (u32::from_le_bytes(slice.try_into().unwrap()) as u64).to_string(),
        "uint64_t" => u64::from_le_bytes(slice.try_into().unwrap()).to_string(),
        _ => hex(slice),
    }
}

/// The messages decoded by offset, and nothing else.
fn decode_body(
    msgid: u32,
    raw_payload: &[u8],
    base: u32,
    is_v2: bool,
) -> Option<Vec<DecodedField>> {
    let mut padded;
    let payload = if is_v2 {
        let need = match msgid {
            0 => 9,
            24 => 30,
            30 => 28,
            33 => 28,
            _ => 0,
        };
        if need > 0 && raw_payload.len() < need {
            padded = raw_payload.to_vec();
            padded.resize(need, 0);
            &padded[..]
        } else {
            raw_payload
        }
    } else {
        raw_payload
    };

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
        // 24 GPS_RAW_INT: time_usec, lat, lon, alt, eph, epv, vel, cog, fix_type, satellites.
        24 if payload.len() >= 30 => Some(vec![
            number("time_usec", base, payload, 0, 8),
            signed("lat", base, payload, 8, 4),
            signed("lon", base, payload, 12, 4),
            signed("alt", base, payload, 16, 4),
            number("eph", base, payload, 20, 2),
            number("epv", base, payload, 22, 2),
            number("vel", base, payload, 24, 2),
            number("cog", base, payload, 26, 2),
            byte("fix_type", base, payload, 28),
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

    #[test]
    fn crc_extra_matches_standard_for_builtin_messages() {
        let mut crc = X25Crc::new();
        crc.accumulate_slice(b"HEARTBEAT uint32_t custom_mode uint8_t type uint8_t autopilot uint8_t base_mode uint8_t system_status uint8_t mavlink_version ");
        assert_eq!(crc.crc_extra(), 50);

        let mut crc = X25Crc::new();
        crc.accumulate_slice(b"GPS_RAW_INT uint64_t time_usec int32_t lat int32_t lon int32_t alt uint16_t eph uint16_t epv uint16_t vel uint16_t cog uint8_t fix_type uint8_t satellites_visible ");
        assert_eq!(crc.crc_extra(), 24);

        let mut crc = X25Crc::new();
        crc.accumulate_slice(b"ATTITUDE uint32_t time_boot_ms float roll float pitch float yaw float rollspeed float pitchspeed float yawspeed ");
        assert_eq!(crc.crc_extra(), 39);

        let mut crc = X25Crc::new();
        crc.accumulate_slice(b"GLOBAL_POSITION_INT uint32_t time_boot_ms int32_t lat int32_t lon int32_t alt int32_t relative_alt int16_t vx int16_t vy int16_t vz uint16_t hdg ");
        assert_eq!(crc.crc_extra(), 104);
    }

    #[test]
    fn xml_dialect_reorders_fields_by_element_width_and_decodes_custom_message() {
        let xml = r#"<?xml version="1.0"?>
        <mavlink>
            <enums>
                <enum name="SENSOR_STATUS">
                    <entry value="0" name="OFF"/>
                    <entry value="1" name="OK"/>
                    <entry value="2" name="ERROR"/>
                </enum>
            </enums>
            <messages>
                <message id="1234" name="SENSOR_DATA">
                    <description>Custom sensor telemetry message</description>
                    <field type="uint8_t" name="status" enum="SENSOR_STATUS">Sensor status</field>
                    <field type="uint32_t" name="timestamp">Timestamp ms</field>
                    <field type="char[16]" name="sensor_name">Name</field>
                    <field type="float" name="reading">Reading</field>
                    <extensions/>
                    <field type="uint16_t" name="flags">Extension flags</field>
                </message>
            </messages>
        </mavlink>"#;

        let dialect = parse_xml(xml).expect("XML parse must succeed");
        let msg = dialect
            .messages
            .get(&1234)
            .expect("message 1234 must exist");
        assert_eq!(msg.name, "SENSOR_DATA");

        // Verify base fields reordered:
        // uint32_t timestamp (offset 0, width 4)
        // float reading      (offset 4, width 4)
        // uint8_t status     (offset 8, width 1)
        // char[16] sensor_name (offset 9, width 16)
        // extensions:
        // uint16_t flags     (offset 25, width 2)
        assert_eq!(msg.base_payload_len, 25);
        assert_eq!(msg.full_payload_len, 27);
        assert_eq!(msg.fields[0].name, "timestamp");
        assert_eq!(msg.fields[0].wire_offset, 0);
        assert_eq!(msg.fields[1].name, "reading");
        assert_eq!(msg.fields[1].wire_offset, 4);
        assert_eq!(msg.fields[2].name, "status");
        assert_eq!(msg.fields[2].wire_offset, 8);
        assert_eq!(msg.fields[3].name, "sensor_name");
        assert_eq!(msg.fields[3].wire_offset, 9);
        assert_eq!(msg.fields[4].name, "flags");
        assert_eq!(msg.fields[4].wire_offset, 25);
        assert!(msg.fields[4].is_extension);

        // Build a v2 frame for message 1234
        let mut payload = Vec::new();
        payload.extend_from_slice(&123_456u32.to_le_bytes()); // timestamp at 0
        payload.extend_from_slice(&24.5f32.to_le_bytes()); // reading at 4
        payload.push(1); // status = 1 (OK) at 8
        let mut name_bytes = [0u8; 16];
        let name_str = b"Barometer";
        name_bytes[..name_str.len()].copy_from_slice(name_str);
        payload.extend_from_slice(&name_bytes); // sensor_name at 9
        payload.extend_from_slice(&0x00FFu16.to_le_bytes()); // flags at 25

        // v2 header: 0xFD, len (27), incompat (0), compat (0), seq (5), sys (1), comp (1), msgid (1234 in 3 bytes)
        let mut frame = vec![0xFD, payload.len() as u8, 0, 0, 5, 1, 1];
        frame.extend_from_slice(&(1234u32).to_le_bytes()[..3]);
        frame.extend_from_slice(&payload);

        // Calculate and append valid CRC
        let mut hasher = X25Crc::new();
        hasher.accumulate_slice(&frame[1..]);
        hasher.accumulate_byte(msg.crc_extra);
        let crc = hasher.crc();
        frame.extend_from_slice(&crc.to_le_bytes());

        let fields = decode_with_dialect(&frame, &dialect).expect("frame must decode");
        assert_eq!(value_of(&fields, "msgid"), "1234 (SENSOR_DATA)");
        assert_eq!(value_of(&fields, "timestamp"), "123456");
        assert_eq!(value_of(&fields, "reading"), "24.5000");
        assert_eq!(value_of(&fields, "status"), "1 (OK)");
        assert_eq!(value_of(&fields, "sensor_name"), "Barometer");
        assert_eq!(value_of(&fields, "flags"), "255");
        assert_eq!(value_of(&fields, "crc_status"), "valid");
        assert!(value_of(&fields, "checksum").contains("(valid)"));
    }

    #[test]
    fn v2_zero_trimmed_payload_and_bad_crc_are_reported() {
        let xml = r#"<mavlink>
            <messages>
                <message id="555" name="TRIMMED_DEMO">
                    <field type="uint32_t" name="count">Count</field>
                    <field type="uint16_t" name="tail_a">Tail A</field>
                    <field type="uint16_t" name="tail_b">Tail B</field>
                </message>
            </messages>
        </mavlink>"#;
        let dialect = parse_xml(xml).expect("XML parse ok");
        let msg = dialect.messages.get(&555).unwrap();
        assert_eq!(msg.full_payload_len, 8); // 4 + 2 + 2

        // Truncate payload on wire to 4 bytes: tail_a and tail_b are zero and trimmed
        let mut trimmed_payload = Vec::new();
        trimmed_payload.extend_from_slice(&42u32.to_le_bytes()); // count = 42

        let mut frame = vec![0xFD, trimmed_payload.len() as u8, 0, 0, 10, 1, 1];
        frame.extend_from_slice(&(555u32).to_le_bytes()[..3]);
        frame.extend_from_slice(&trimmed_payload);

        let mut hasher = X25Crc::new();
        hasher.accumulate_slice(&frame[1..]);
        hasher.accumulate_byte(msg.crc_extra);
        let valid_crc = hasher.crc();
        frame.extend_from_slice(&valid_crc.to_le_bytes());

        let fields = decode_with_dialect(&frame, &dialect).unwrap();
        assert_eq!(value_of(&fields, "count"), "42");
        assert_eq!(value_of(&fields, "tail_a"), "0");
        assert_eq!(value_of(&fields, "tail_b"), "0");
        assert_eq!(value_of(&fields, "crc_status"), "valid");

        // Corrupt the CRC by 1
        let last_idx = frame.len() - 1;
        frame[last_idx] ^= 0xFF;
        let fields_bad = decode_with_dialect(&frame, &dialect).unwrap();
        assert_eq!(value_of(&fields_bad, "crc_status"), "invalid");
        assert!(value_of(&fields_bad, "checksum").contains("invalid, expected 0x"));
    }
}
