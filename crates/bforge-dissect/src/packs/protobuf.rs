//! Protobuf wire format, with and without a `.proto` schema (FR-DIS-02, D-112).
//!
//! A protobuf message on the wire does not carry field names, only field numbers
//! and wire types. Without a schema, fields decode as `field_<number>`. With a `.proto`
//! schema, fields decode with their schema names, signed ZigZag integers (`sint32`, `sint64`),
//! floats, doubles, enums, and nested submessages.
//!
//! ```text
//! key        (field_number << 3) | wire_type, as a varint
//! 0 varint   1 fixed64   2 length-delimited   5 fixed32
//! ```

use super::{field, require};
use crate::DecodedField;
use crate::exec::ExecError;
use std::collections::HashMap;

/// Nested messages are followed this far. A hostile frame must not become a stack overflow.
const MAX_DEPTH: usize = 8;

/// A parsed `.proto` schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProtoSchema {
    /// The root message to begin decoding from.
    pub root_message: String,
    /// Defined messages indexed by name.
    pub messages: HashMap<String, ProtoMessage>,
    /// Defined enums indexed by name.
    pub enums: HashMap<String, ProtoEnum>,
    /// Optional package declaration.
    pub package: Option<String>,
}

/// One message definition in a `.proto` schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProtoMessage {
    pub name: String,
    pub fields: HashMap<u32, ProtoField>,
}

/// One field defined in a protobuf message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoField {
    pub number: u32,
    pub name: String,
    pub kind: ProtoFieldKind,
    pub repeated: bool,
}

/// The logical type of a protobuf field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtoFieldKind {
    Int32,
    Int64,
    Uint32,
    Uint64,
    Sint32,
    Sint64,
    Bool,
    Fixed64,
    Sfixed64,
    Double,
    String,
    Bytes,
    Fixed32,
    Sfixed32,
    Float,
    Enum(String),
    Message(String),
    Map {
        key_type: String,
        value_type: String,
    },
    Named(String),
}

/// One enum definition in a `.proto` schema.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProtoEnum {
    pub name: String,
    pub variants: HashMap<i32, String>,
}

/// Parse a `.proto` definition without external dependencies.
pub fn parse_proto(text: &str, root: Option<&str>) -> Result<ProtoSchema, String> {
    let stripped = strip_comments(text);
    let tokens = tokenize(&stripped);
    let mut cursor = TokenCursor::new(&tokens);
    let mut schema = ProtoSchema::default();

    while let Some(tok) = cursor.peek() {
        match tok {
            "syntax" => {
                cursor.skip_until_semicolon_or_brace();
            }
            "package" => {
                cursor.next();
                let pkg = cursor
                    .next()
                    .ok_or_else(|| "expected package name".to_string())?
                    .to_string();
                cursor.expect(";")?;
                schema.package = Some(pkg);
            }
            "import" | "option" => {
                cursor.skip_until_semicolon_or_brace();
            }
            "enum" => {
                parse_enum(&mut cursor, &mut schema, None)?;
            }
            "message" => {
                parse_message(&mut cursor, &mut schema, None)?;
            }
            ";" => {
                cursor.next();
            }
            other => {
                return Err(format!("unexpected top-level token `{other}`"));
            }
        }
    }

    // Second pass: resolve Named(type_name) in fields against known messages and enums.
    let message_names: std::collections::HashSet<String> =
        schema.messages.keys().cloned().collect();
    let enum_names: std::collections::HashSet<String> = schema.enums.keys().cloned().collect();

    for msg in schema.messages.values_mut() {
        let msg_name = msg.name.clone();
        for field in msg.fields.values_mut() {
            if let ProtoFieldKind::Named(ref type_name) = field.kind {
                let resolved =
                    resolve_named_type(type_name, &msg_name, &message_names, &enum_names);
                field.kind = resolved;
            }
        }
    }

    // Select the root message.
    if let Some(root_name) = root {
        let clean = root_name.trim_start_matches('.');
        if schema.messages.contains_key(clean) {
            schema.root_message = clean.to_string();
        } else {
            let suffix = format!(".{clean}");
            if let Some(m) = schema.messages.keys().find(|k| k.ends_with(&suffix)) {
                schema.root_message = m.clone();
            } else {
                return Err(format!("message `{root_name}` not found in proto schema"));
            }
        }
    } else if schema.root_message.is_empty() {
        if let Some(first) = schema.messages.keys().next() {
            schema.root_message = first.clone();
        } else {
            return Err("no messages defined in proto schema".to_string());
        }
    }

    Ok(schema)
}

/// Decode one protobuf message without a schema.
pub fn decode(frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
    decode_with_schema(frame, &ProtoSchema::default())
}

/// Decode one protobuf message using a `.proto` schema.
pub fn decode_with_schema(
    frame: &[u8],
    schema: &ProtoSchema,
) -> Result<Vec<DecodedField>, ExecError> {
    require(frame, 1, "protobuf message")?;
    let root_msg = schema.messages.get(&schema.root_message);
    let (mut fields, consumed, stopped) = decode_at_schema(frame, 0, MAX_DEPTH, root_msg, schema);
    if consumed < frame.len() {
        if let Some(error) = stopped.clone()
            && consumed == 0
        {
            return Err(error);
        }
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
fn decode_at_schema(
    frame: &[u8],
    start: usize,
    depth: usize,
    current_msg: Option<&ProtoMessage>,
    schema: &ProtoSchema,
) -> (Vec<DecodedField>, usize, Option<ExecError>) {
    let mut fields = Vec::new();
    let mut at = start;
    while at < frame.len() {
        match read_field_schema(frame, at, depth, current_msg, schema) {
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
fn read_field_schema(
    frame: &[u8],
    at: usize,
    depth: usize,
    current_msg: Option<&ProtoMessage>,
    schema: &ProtoSchema,
) -> Result<(DecodedField, usize), ExecError> {
    let (key, mut used) = varint(frame, at)?;
    let number = (key >> 3) as u32;
    let wire = (key & 0x07) as u8;
    if number == 0 {
        return Err(ExecError::Unsupported(
            "a protobuf field number of zero is not valid".to_string(),
        ));
    }

    let proto_field = current_msg.and_then(|m| m.fields.get(&number));
    let name = match proto_field {
        Some(f) => f.name.clone(),
        None => format!("field_{number}"),
    };
    let offset = (at + used) as u32;

    let decoded = match wire {
        0 => {
            let (value, read) = varint(frame, at + used)?;
            used += read;
            match proto_field.map(|f| &f.kind) {
                Some(ProtoFieldKind::Sint32) => {
                    let un = value as u32;
                    let zz = ((un >> 1) as i32) ^ (-((un & 1) as i32));
                    field(
                        &name,
                        offset,
                        read as u32,
                        zz.to_string(),
                        Some(f64::from(zz)),
                    )
                }
                Some(ProtoFieldKind::Sint64) => {
                    let zz = ((value >> 1) as i64) ^ (-((value & 1) as i64));
                    field(&name, offset, read as u32, zz.to_string(), Some(zz as f64))
                }
                Some(ProtoFieldKind::Int32) => {
                    let v = value as i32;
                    field(
                        &name,
                        offset,
                        read as u32,
                        v.to_string(),
                        Some(f64::from(v)),
                    )
                }
                Some(ProtoFieldKind::Int64) => {
                    let v = value as i64;
                    field(&name, offset, read as u32, v.to_string(), Some(v as f64))
                }
                Some(ProtoFieldKind::Uint32) => {
                    let v = value as u32;
                    field(
                        &name,
                        offset,
                        read as u32,
                        v.to_string(),
                        Some(f64::from(v)),
                    )
                }
                Some(ProtoFieldKind::Uint64) => field(
                    &name,
                    offset,
                    read as u32,
                    value.to_string(),
                    Some(value as f64),
                ),
                Some(ProtoFieldKind::Bool) => {
                    let b = value != 0;
                    field(
                        &name,
                        offset,
                        read as u32,
                        b.to_string(),
                        Some(if b { 1.0 } else { 0.0 }),
                    )
                }
                Some(ProtoFieldKind::Enum(enum_name)) => {
                    let raw = value as i32;
                    let label = schema
                        .enums
                        .get(enum_name)
                        .and_then(|e| e.variants.get(&raw));
                    let text = match label {
                        Some(l) => format!("{l} ({raw})"),
                        None => raw.to_string(),
                    };
                    field(&name, offset, read as u32, text, Some(f64::from(raw)))
                }
                _ => decoded(&name, offset, read as u32, "varint", value as f64, None),
            }
        }
        1 => {
            let body = at + used;
            require(frame, body + 8, "protobuf fixed64")?;
            used += 8;
            match proto_field.map(|f| &f.kind) {
                Some(ProtoFieldKind::Double) => {
                    let raw = f64::from_le_bytes(frame[body..body + 8].try_into().unwrap());
                    field(&name, offset, 8, format_float64(raw), Some(raw))
                }
                Some(ProtoFieldKind::Sfixed64) => {
                    let raw = i64::from_le_bytes(frame[body..body + 8].try_into().unwrap());
                    field(&name, offset, 8, raw.to_string(), Some(raw as f64))
                }
                _ => {
                    let raw = u64::from_le_bytes(frame[body..body + 8].try_into().unwrap());
                    decoded(
                        &name,
                        offset,
                        8,
                        &format!("fixed64 {raw}"),
                        raw as f64,
                        Some(format!("0x{raw:016X}")),
                    )
                }
            }
        }
        5 => {
            let body = at + used;
            require(frame, body + 4, "protobuf fixed32")?;
            used += 4;
            match proto_field.map(|f| &f.kind) {
                Some(ProtoFieldKind::Float) => {
                    let raw = f32::from_le_bytes(frame[body..body + 4].try_into().unwrap());
                    let val = f64::from(raw);
                    field(&name, offset, 4, format_float32(raw), Some(val))
                }
                Some(ProtoFieldKind::Sfixed32) => {
                    let raw = i32::from_le_bytes(frame[body..body + 4].try_into().unwrap());
                    field(&name, offset, 4, raw.to_string(), Some(f64::from(raw)))
                }
                _ => {
                    let raw = u32::from_le_bytes(frame[body..body + 4].try_into().unwrap());
                    decoded(
                        &name,
                        offset,
                        4,
                        &format!("fixed32 {raw}"),
                        f64::from(raw),
                        Some(format!("0x{raw:08X}")),
                    )
                }
            }
        }
        2 => {
            let (len, read) = varint(frame, at + used)?;
            used += read;
            let body = at + used;
            let len = len as usize;
            require(frame, body + len, "protobuf length-delimited field")?;
            used += len;
            length_field_schema(
                &name,
                offset,
                &frame[body..body + len],
                depth,
                proto_field,
                schema,
            )
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
fn length_field_schema(
    name: &str,
    offset: u32,
    body: &[u8],
    depth: usize,
    proto_field: Option<&ProtoField>,
    schema: &ProtoSchema,
) -> DecodedField {
    if depth > 0 {
        let target_msg = match proto_field.map(|f| &f.kind) {
            Some(ProtoFieldKind::Message(msg_name)) => schema.messages.get(msg_name),
            _ => None,
        };

        if let Some(msg) = target_msg {
            let (children, consumed, stopped) =
                decode_at_schema(body, 0, depth - 1, Some(msg), schema);
            if stopped.is_none() && consumed == body.len() {
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
        } else if proto_field.is_none() {
            let (children, consumed, stopped) = decode_at_schema(body, 0, depth - 1, None, schema);
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
    }

    if let Some(ProtoFieldKind::Bytes) = proto_field.map(|f| &f.kind) {
        return field(name, offset, body.len() as u32, hex(body), None);
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

fn format_float32(value: f32) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value == value.trunc() && value.abs() < 1e7 {
        return format!("{value:.1}");
    }
    let text = format!("{value:.6}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0.0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn format_float64(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value == value.trunc() && value.abs() < 1e15 {
        return format!("{value:.1}");
    }
    let text = format!("{value:.6}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() {
        "0.0".to_string()
    } else {
        trimmed.to_string()
    }
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

// ---------------------------------------------------------------------------
// .proto Parser
// ---------------------------------------------------------------------------

fn strip_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let len = chars.len();
    let mut in_quote = false;
    let mut quote_char = '"';

    while i < len {
        let c = chars[i];
        if in_quote {
            out.push(c);
            if c == '\\' && i + 1 < len {
                i += 1;
                out.push(chars[i]);
            } else if c == quote_char {
                in_quote = false;
            }
            i += 1;
            continue;
        }

        if c == '"' || c == '\'' {
            in_quote = true;
            quote_char = c;
            out.push(c);
            i += 1;
            continue;
        }

        if c == '/' && i + 1 < len {
            if chars[i + 1] == '/' {
                i += 2;
                while i < len && chars[i] != '\n' {
                    i += 1;
                }
                out.push('\n');
                continue;
            } else if chars[i + 1] == '*' {
                i += 2;
                while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
                out.push(' ');
                continue;
            }
        }

        out.push(c);
        i += 1;
    }
    out
}

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let len = chars.len();

    while i < len {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        if c == '"' || c == '\'' {
            let quote = c;
            let mut s = String::new();
            i += 1;
            while i < len && chars[i] != quote {
                if chars[i] == '\\' && i + 1 < len {
                    i += 1;
                    s.push(chars[i]);
                } else {
                    s.push(chars[i]);
                }
                i += 1;
            }
            if i < len && chars[i] == quote {
                i += 1;
            }
            tokens.push(s);
            continue;
        }

        if matches!(
            c,
            '{' | '}' | ';' | '=' | '<' | '>' | '(' | ')' | '[' | ']' | ','
        ) {
            tokens.push(c.to_string());
            i += 1;
            continue;
        }

        let mut word = String::new();
        while i < len {
            let c = chars[i];
            if c.is_whitespace()
                || matches!(
                    c,
                    '{' | '}' | ';' | '=' | '<' | '>' | '(' | ')' | '[' | ']' | ',' | '"' | '\''
                )
            {
                break;
            }
            word.push(c);
            i += 1;
        }
        if !word.is_empty() {
            tokens.push(word);
        }
    }
    tokens
}

struct TokenCursor<'a> {
    tokens: &'a [String],
    pos: usize,
}

impl<'a> TokenCursor<'a> {
    fn new(tokens: &'a [String]) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&'a str> {
        self.tokens.get(self.pos).map(|s| s.as_str())
    }

    fn next(&mut self) -> Option<&'a str> {
        let t = self.tokens.get(self.pos).map(|s| s.as_str());
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn expect(&mut self, expected: &str) -> Result<(), String> {
        match self.next() {
            Some(t) if t == expected => Ok(()),
            Some(other) => Err(format!("expected `{expected}`, found `{other}`")),
            None => Err(format!("expected `{expected}`, found end of input")),
        }
    }

    fn skip_until_semicolon_or_brace(&mut self) {
        let mut brace_depth: usize = 0;
        let mut bracket_depth: usize = 0;
        while let Some(tok) = self.peek() {
            match tok {
                "{" => {
                    brace_depth += 1;
                    self.pos += 1;
                }
                "}" => {
                    if brace_depth == 0 {
                        break;
                    }
                    brace_depth -= 1;
                    self.pos += 1;
                }
                "[" => {
                    bracket_depth += 1;
                    self.pos += 1;
                }
                "]" => {
                    bracket_depth = bracket_depth.saturating_sub(1);
                    self.pos += 1;
                }
                ";" if brace_depth == 0 && bracket_depth == 0 => {
                    self.pos += 1;
                    break;
                }
                _ => {
                    self.pos += 1;
                }
            }
        }
    }
}

fn parse_enum(
    cursor: &mut TokenCursor,
    schema: &mut ProtoSchema,
    parent: Option<&str>,
) -> Result<(), String> {
    cursor.expect("enum")?;
    let name = cursor
        .next()
        .ok_or_else(|| "expected enum name".to_string())?
        .to_string();
    let full_name = match parent {
        Some(p) => format!("{p}.{name}"),
        None => match &schema.package {
            Some(pkg) => format!("{pkg}.{name}"),
            None => name.clone(),
        },
    };
    cursor.expect("{")?;
    let mut variants = HashMap::new();

    while let Some(tok) = cursor.peek() {
        if tok == "}" {
            cursor.next();
            break;
        }
        if tok == ";" {
            cursor.next();
            continue;
        }
        if tok == "option" || tok == "reserved" {
            cursor.skip_until_semicolon_or_brace();
            continue;
        }

        let label = cursor
            .next()
            .ok_or_else(|| "expected enum label".to_string())?
            .to_string();
        cursor.expect("=")?;
        let num_str = cursor
            .next()
            .ok_or_else(|| format!("expected number for enum {label}"))?;
        let num: i32 = if num_str == "-" {
            let next_num = cursor
                .next()
                .ok_or_else(|| "expected number after '-'".to_string())?;
            -next_num
                .parse::<i32>()
                .map_err(|e| format!("invalid enum number `-{next_num}`: {e}"))?
        } else {
            num_str
                .parse::<i32>()
                .map_err(|e| format!("invalid enum number `{num_str}`: {e}"))?
        };

        skip_field_options(cursor)?;
        cursor.expect(";")?;
        variants.entry(num).or_insert(label);
    }

    let proto_enum = ProtoEnum {
        name: full_name.clone(),
        variants,
    };
    schema.enums.insert(full_name.clone(), proto_enum.clone());
    if full_name != name {
        schema.enums.entry(name).or_insert(proto_enum);
    }
    Ok(())
}

fn parse_message(
    cursor: &mut TokenCursor,
    schema: &mut ProtoSchema,
    parent: Option<&str>,
) -> Result<String, String> {
    cursor.expect("message")?;
    let name = cursor
        .next()
        .ok_or_else(|| "expected message name".to_string())?
        .to_string();
    let full_name = match parent {
        Some(p) => format!("{p}.{name}"),
        None => match &schema.package {
            Some(pkg) => format!("{pkg}.{name}"),
            None => name.clone(),
        },
    };
    cursor.expect("{")?;
    let mut fields = HashMap::new();

    while let Some(tok) = cursor.peek() {
        if tok == "}" {
            cursor.next();
            break;
        }
        if tok == ";" {
            cursor.next();
            continue;
        }
        if tok == "message" {
            parse_message(cursor, schema, Some(&full_name))?;
            continue;
        }
        if tok == "enum" {
            parse_enum(cursor, schema, Some(&full_name))?;
            continue;
        }
        if tok == "reserved" || tok == "option" {
            cursor.skip_until_semicolon_or_brace();
            continue;
        }
        if tok == "oneof" {
            cursor.next();
            let _oneof_name = cursor
                .next()
                .ok_or_else(|| "expected oneof name".to_string())?;
            cursor.expect("{")?;
            while let Some(otok) = cursor.peek() {
                if otok == "}" {
                    cursor.next();
                    break;
                }
                if otok == ";" {
                    cursor.next();
                    continue;
                }
                parse_field(cursor, &mut fields, false)?;
            }
            continue;
        }
        if tok == "map" {
            cursor.next();
            cursor.expect("<")?;
            let key_type = cursor
                .next()
                .ok_or_else(|| "expected map key type".to_string())?
                .to_string();
            cursor.expect(",")?;
            let val_type = cursor
                .next()
                .ok_or_else(|| "expected map value type".to_string())?
                .to_string();
            cursor.expect(">")?;
            let field_name = cursor
                .next()
                .ok_or_else(|| "expected map field name".to_string())?
                .to_string();
            cursor.expect("=")?;
            let num_str = cursor
                .next()
                .ok_or_else(|| "expected map field number".to_string())?;
            let number = num_str
                .parse::<u32>()
                .map_err(|e| format!("invalid field number `{num_str}`: {e}"))?;
            skip_field_options(cursor)?;
            cursor.expect(";")?;
            fields.insert(
                number,
                ProtoField {
                    number,
                    name: field_name,
                    kind: ProtoFieldKind::Map {
                        key_type,
                        value_type: val_type,
                    },
                    repeated: true,
                },
            );
            continue;
        }

        let mut repeated = false;
        if tok == "repeated" {
            repeated = true;
            cursor.next();
        } else if tok == "optional" || tok == "required" {
            cursor.next();
        }

        parse_field(cursor, &mut fields, repeated)?;
    }

    let proto_msg = ProtoMessage {
        name: full_name.clone(),
        fields,
    };
    schema.messages.insert(full_name.clone(), proto_msg.clone());
    if full_name != name {
        schema.messages.entry(name.clone()).or_insert(proto_msg);
    }
    if parent.is_none() && schema.root_message.is_empty() {
        schema.root_message = full_name.clone();
    }
    Ok(full_name)
}

fn parse_field(
    cursor: &mut TokenCursor,
    fields: &mut HashMap<u32, ProtoField>,
    repeated: bool,
) -> Result<(), String> {
    let type_name = cursor
        .next()
        .ok_or_else(|| "expected field type".to_string())?
        .to_string();
    let field_name = cursor
        .next()
        .ok_or_else(|| "expected field name".to_string())?
        .to_string();
    cursor.expect("=")?;
    let num_str = cursor
        .next()
        .ok_or_else(|| "expected field number".to_string())?;
    let number = num_str
        .parse::<u32>()
        .map_err(|e| format!("invalid field number `{num_str}`: {e}"))?;
    skip_field_options(cursor)?;
    cursor.expect(";")?;

    let kind = resolve_field_kind(&type_name);
    fields.insert(
        number,
        ProtoField {
            number,
            name: field_name,
            kind,
            repeated,
        },
    );
    Ok(())
}

fn skip_field_options(cursor: &mut TokenCursor) -> Result<(), String> {
    if cursor.peek() == Some("[") {
        cursor.next();
        let mut depth = 1;
        while let Some(tok) = cursor.next() {
            if tok == "[" {
                depth += 1;
            } else if tok == "]" {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
        }
        if depth != 0 {
            return Err("unclosed field options `[`".to_string());
        }
    }
    Ok(())
}

fn resolve_field_kind(type_name: &str) -> ProtoFieldKind {
    match type_name {
        "int32" => ProtoFieldKind::Int32,
        "int64" => ProtoFieldKind::Int64,
        "uint32" => ProtoFieldKind::Uint32,
        "uint64" => ProtoFieldKind::Uint64,
        "sint32" => ProtoFieldKind::Sint32,
        "sint64" => ProtoFieldKind::Sint64,
        "bool" => ProtoFieldKind::Bool,
        "fixed64" => ProtoFieldKind::Fixed64,
        "sfixed64" => ProtoFieldKind::Sfixed64,
        "double" => ProtoFieldKind::Double,
        "string" => ProtoFieldKind::String,
        "bytes" => ProtoFieldKind::Bytes,
        "fixed32" => ProtoFieldKind::Fixed32,
        "sfixed32" => ProtoFieldKind::Sfixed32,
        "float" => ProtoFieldKind::Float,
        other => ProtoFieldKind::Named(other.to_string()),
    }
}

fn resolve_named_type(
    type_name: &str,
    scope: &str,
    message_names: &std::collections::HashSet<String>,
    enum_names: &std::collections::HashSet<String>,
) -> ProtoFieldKind {
    let clean = type_name.trim_start_matches('.');

    // 1. In current scope: scope.clean
    let scoped = format!("{scope}.{clean}");
    if message_names.contains(&scoped) {
        return ProtoFieldKind::Message(scoped);
    }
    if enum_names.contains(&scoped) {
        return ProtoFieldKind::Enum(scoped);
    }

    // 2. Exact match: clean
    if message_names.contains(clean) {
        return ProtoFieldKind::Message(clean.to_string());
    }
    if enum_names.contains(clean) {
        return ProtoFieldKind::Enum(clean.to_string());
    }

    // 3. Suffix match: any message or enum ending with .clean
    let suffix = format!(".{clean}");
    if let Some(m) = message_names.iter().find(|k| k.ends_with(&suffix)) {
        return ProtoFieldKind::Message(m.clone());
    }
    if let Some(e) = enum_names.iter().find(|k| k.ends_with(&suffix)) {
        return ProtoFieldKind::Enum(e.clone());
    }

    // Default fallback: Message
    ProtoFieldKind::Message(clean.to_string())
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

    #[test]
    fn schema_names_fields_and_nested_messages() {
        let proto = r#"
            syntax = "proto3";
            package test;

            message Header {
                uint32 seq = 1;
            }

            message Telemetry {
                Header header = 1;
                string device_id = 2;
                float voltage = 3;
            }
        "#;

        let schema = parse_proto(proto, Some("Telemetry")).expect("schema parses");

        let mut frame = vec![0x0A, 0x02, 0x08, 42, 0x12, 0x05];
        frame.extend_from_slice(b"DEV01");
        frame.push(0x1D);
        frame.extend_from_slice(&3.3f32.to_le_bytes());

        let fields = decode_with_schema(&frame, &schema).expect("decodes");
        assert_eq!(fields.len(), 3);

        assert_eq!(fields[0].name, "header");
        assert_eq!(fields[0].children.len(), 1);
        assert_eq!(fields[0].children[0].name, "seq");
        assert_eq!(fields[0].children[0].value, "42");
        assert_eq!(fields[0].children[0].value_num, Some(42.0));

        assert_eq!(fields[1].name, "device_id");
        assert_eq!(fields[1].value, "\"DEV01\"");

        assert_eq!(fields[2].name, "voltage");
        assert_eq!(fields[2].value, "3.3");
        assert_eq!(fields[2].value_num, Some(f64::from(3.3f32)));
    }

    #[test]
    fn schema_resolves_enum_labels_and_zigzag_sint32() {
        let proto = r#"
            syntax = "proto3";

            enum State {
                UNKNOWN = 0;
                STARTING = 1;
                RUNNING = 2;
                STOPPED = 3;
            }

            message StatusPacket {
                sint32 temp_delta = 1;
                State state = 2;
                sint64 alt_delta = 3;
            }
        "#;

        let schema = parse_proto(proto, None).expect("schema parses");

        // Zigzag:
        // temp_delta = -5 -> zigzag is 9 (0x09)
        // state = RUNNING (2) -> varint 2 (0x02)
        // alt_delta = -1 -> zigzag is 1 (0x01)
        let frame = vec![0x08, 0x09, 0x10, 0x02, 0x18, 0x01];

        let fields = decode_with_schema(&frame, &schema).expect("decodes");
        assert_eq!(fields.len(), 3);

        assert_eq!(fields[0].name, "temp_delta");
        assert_eq!(fields[0].value, "-5");
        assert_eq!(fields[0].value_num, Some(-5.0));

        assert_eq!(fields[1].name, "state");
        assert_eq!(fields[1].value, "RUNNING (2)");
        assert_eq!(fields[1].value_num, Some(2.0));

        assert_eq!(fields[2].name, "alt_delta");
        assert_eq!(fields[2].value, "-1");
        assert_eq!(fields[2].value_num, Some(-1.0));
    }

    #[test]
    fn unknown_field_in_schema_falls_back_to_field_number() {
        let proto = r#"
            syntax = "proto3";

            message Simple {
                uint32 known = 1;
            }
        "#;

        let schema = parse_proto(proto, None).expect("schema parses");

        // Frame with field 1 (known = 150) and field 99 (unknown = 42)
        let frame = vec![0x08, 0x96, 0x01, 0x98, 0x06, 0x2A];

        let fields = decode_with_schema(&frame, &schema).expect("decodes");
        assert_eq!(fields.len(), 2);

        assert_eq!(fields[0].name, "known");
        assert_eq!(fields[0].value, "150");
        assert_eq!(fields[0].value_num, Some(150.0));

        assert_eq!(fields[1].name, "field_99");
        assert_eq!(fields[1].value, "varint 42");
        assert_eq!(fields[1].value_num, Some(42.0));
    }

    #[test]
    fn pack_decode_with_and_without_schema() {
        use crate::packs::Pack;

        let frame = [0x08, 0x96, 0x01]; // field 1, varint 150

        // Without schema
        let pack_raw = Pack::Protobuf;
        let fields_raw = pack_raw.decode(&frame).expect("decodes");
        assert_eq!(fields_raw[0].name, "field_1");
        assert_eq!(fields_raw[0].value, "varint 150");

        // With schema
        let proto = "syntax = \"proto3\"; message Msg { uint32 count = 1; }";
        let schema = parse_proto(proto, None).expect("parses");
        let pack_schema = Pack::ProtobufSchema(schema);
        let fields_schema = pack_schema.decode(&frame).expect("decodes");
        assert_eq!(fields_schema[0].name, "count");
        assert_eq!(fields_schema[0].value, "150");
    }

    #[test]
    fn nested_message_defined_inside_message() {
        let proto = r#"
            message Outer {
                message Inner {
                    int32 code = 1;
                }
                Inner inner = 1;
            }
        "#;
        let schema = parse_proto(proto, None).expect("schema parses");
        let frame = [0x0A, 0x02, 0x08, 0x07];
        let fields = decode_with_schema(&frame, &schema).expect("decodes");
        assert_eq!(fields[0].name, "inner");
        assert_eq!(fields[0].children[0].name, "code");
        assert_eq!(fields[0].children[0].value, "7");
    }

    #[test]
    fn comments_reserved_options_and_map() {
        let proto = r#"
            // Header comment
            syntax = "proto3";
            /* Multi-line
               comment */
            package demo;
            option java_package = "com.demo";

            message MapPacket {
                reserved 2, 5 to 8;
                reserved "old_field";
                int32 id = 1 [json_name = "id_num"];
                map<string, int32> scores = 3;
            }
        "#;
        let schema = parse_proto(proto, None).expect("schema parses");
        assert_eq!(schema.root_message, "demo.MapPacket");
        let msg = schema
            .messages
            .get("demo.MapPacket")
            .or_else(|| schema.messages.get("MapPacket"))
            .unwrap();
        assert_eq!(msg.fields.get(&1).unwrap().name, "id");
        assert_eq!(msg.fields.get(&3).unwrap().name, "scores");
    }
}
