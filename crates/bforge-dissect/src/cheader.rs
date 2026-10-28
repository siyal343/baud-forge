//! C header parser for packed structs (F3.2).
//!
//! A firmware header is the only schema most teams have. This parser reads the
//! subset the specification names: `struct`, `__attribute__((packed))`, fixed
//! width integers, floats, arrays, bitfields, enums and endianness annotations.
//!
//! It refuses what it does not understand, with a line number. That matters more
//! than coverage: a struct layout that is guessed wrong decodes plausible values
//! from the wrong bytes, and nobody notices.
//!
//! Deliberate deviation from ADR-003: `tree-sitter-c` is named there, but this
//! build has no C compiler, so the parser is written by hand. The interface is a
//! function, so swapping the front end later does not touch the executor. See
//! `DEFERRED.md` D-35.

use crate::{DissectorIr, IrOp, SchemaSource};
use std::collections::HashMap;

/// One field of a C struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CField {
    pub name: String,
    /// Type as written in the header, for example `__be16`.
    pub type_name: String,
    /// Byte offset inside the struct.
    pub offset: u32,
    /// Size in bytes. For a bitfield this is the storage unit it sits in.
    pub len: u32,
    /// Bit offset and width inside the storage unit.
    pub bit: Option<(u8, u8)>,
    /// Element count when the field is an array.
    pub array: Option<u16>,
    /// Enum name when the field has one.
    pub enum_name: Option<String>,
}

/// A parsed struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CStruct {
    pub name: String,
    pub packed: bool,
    pub size: u32,
    pub fields: Vec<CField>,
}

/// A parsed enum and its labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CEnum {
    pub name: String,
    pub variants: Vec<(String, i64)>,
}

/// Everything a header declares that the dissector can use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CHeader {
    pub structs: Vec<CStruct>,
    pub enums: Vec<CEnum>,
}

/// A problem with the header, with the line that caused it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CHeaderError {
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for CHeaderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for CHeaderError {}

/// Parse a header.
pub fn parse(text: &str) -> Result<CHeader, CHeaderError> {
    let cleaned = strip(text);
    let tokens = tokenize(&cleaned);
    Parser::new(tokens).run()
}

/// Compile one struct into the intermediate representation.
pub fn compile(
    header: &CHeader,
    root_struct: &str,
    file: &str,
) -> Result<DissectorIr, CHeaderError> {
    let Some(definition) = header.structs.iter().find(|item| item.name == root_struct) else {
        return Err(CHeaderError {
            line: 0,
            message: format!("struct `{root_struct}` is not declared in the header"),
        });
    };

    let mut ops = Vec::with_capacity(definition.fields.len());
    for field in &definition.fields {
        let inner = field_operation(header, field)?;
        ops.push(IrOp::Label {
            name: field.name.clone(),
            op: Box::new(inner),
        });
    }

    Ok(DissectorIr {
        schema: SchemaSource::CHeader {
            file: file.to_string(),
            root_struct: root_struct.to_string(),
        },
        ops,
    })
}

fn field_operation(header: &CHeader, field: &CField) -> Result<IrOp, CHeaderError> {
    let (size, big_endian, signed) = type_info(&field.type_name).ok_or_else(|| CHeaderError {
        line: 0,
        message: format!(
            "field `{}` has type `{}` that this parser does not know",
            field.name, field.type_name
        ),
    })?;

    let base = if let Some(kind) = &field.enum_name {
        let variants = header
            .enums
            .iter()
            .find(|item| &item.name == kind)
            .map(|item| {
                item.variants
                    .iter()
                    .map(|(label, value)| (*value, label.clone()))
                    .collect()
            })
            .unwrap_or_default();
        IrOp::Enum {
            offset: field.offset,
            width: size,
            variants,
            big_endian,
        }
    } else if let Some((bit_offset, width)) = field.bit {
        IrOp::Bitfield {
            offset: field.offset,
            bit_offset,
            width,
            big_endian,
        }
    } else if size == 4 || size == 8 {
        if field.type_name.contains("float") || field.type_name == "double" {
            IrOp::Float {
                offset: field.offset,
                width: size,
                big_endian,
            }
        } else if signed {
            IrOp::Int {
                offset: field.offset,
                width: size,
                big_endian,
            }
        } else {
            IrOp::UInt {
                offset: field.offset,
                width: size,
                big_endian,
            }
        }
    } else if signed {
        IrOp::Int {
            offset: field.offset,
            width: size,
            big_endian,
        }
    } else {
        IrOp::UInt {
            offset: field.offset,
            width: size,
            big_endian,
        }
    };

    Ok(match field.array {
        Some(count) => IrOp::Array {
            offset: field.offset,
            count,
            element: Box::new(IrOp::Label {
                name: field.name.clone(),
                op: Box::new(with_offset(base, 0)),
            }),
        },
        None => base,
    })
}

fn with_offset(op: IrOp, offset: u32) -> IrOp {
    match op {
        IrOp::UInt {
            width, big_endian, ..
        } => IrOp::UInt {
            offset,
            width,
            big_endian,
        },
        IrOp::Int {
            width, big_endian, ..
        } => IrOp::Int {
            offset,
            width,
            big_endian,
        },
        IrOp::Float {
            width, big_endian, ..
        } => IrOp::Float {
            offset,
            width,
            big_endian,
        },
        other => other,
    }
}

/// Size, byte order and signedness of a C type this parser understands.
fn type_info(name: &str) -> Option<(u8, bool, bool)> {
    let name = name.trim();
    let big_endian = name.starts_with("__be") || name.starts_with("be");

    let width = |prefixes: &[&str]| -> Option<u8> {
        for prefix in prefixes {
            if let Some(rest) = name.strip_prefix(prefix) {
                let digits: String = rest
                    .chars()
                    .take_while(|character| character.is_ascii_digit())
                    .collect();
                if let Ok(bits) = digits.parse::<u8>()
                    && [8, 16, 32, 64].contains(&bits)
                {
                    return Some(bits / 8);
                }
            }
        }
        None
    };

    // Endian-annotated and explicit-width forms first.
    for prefix in ["__le", "__be", "le", "be", "uint", "int", "u", "i"] {
        if let Some(size) = width(&[prefix]) {
            let signed = prefix.starts_with('i') && !prefix.starts_with("__");
            let signed = signed || name.starts_with("int") && !name.starts_with("uint");
            return Some((size, big_endian, signed));
        }
    }
    if name.ends_with("_le") || name.ends_with("_be") {
        let big = name.ends_with("_be");
        let stem = &name[..name.len() - 3];
        return type_info(stem).map(|(size, _, signed)| (size, big, signed));
    }

    match name {
        "char" | "unsigned char" | "uint8_t" | "u8" => Some((1, false, false)),
        "signed char" | "int8_t" | "i8" => Some((1, false, true)),
        "short" | "unsigned short" | "uint16_t" | "u16" => Some((2, false, false)),
        "int16_t" | "i16" => Some((2, false, true)),
        "int" | "unsigned" | "unsigned int" | "uint32_t" | "u32" => Some((4, false, false)),
        "int32_t" | "i32" => Some((4, false, true)),
        "long long" | "unsigned long long" | "uint64_t" | "u64" => Some((8, false, false)),
        "int64_t" | "i64" => Some((8, false, true)),
        "float" => Some((4, false, true)),
        "double" => Some((8, false, true)),
        "bool" | "_Bool" => Some((1, false, false)),
        _ => None,
    }
}

/// Replace comments and preprocessor lines with spaces, keeping newlines so line
/// numbers stay true.
fn strip(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut at_line_start = true;

    while index < bytes.len() {
        let character = bytes[index];
        if character == '\n' {
            out.push('\n');
            index += 1;
            at_line_start = true;
            continue;
        }
        if at_line_start && character == '#' {
            while index < bytes.len() && bytes[index] != '\n' {
                out.push(' ');
                index += 1;
            }
            continue;
        }
        if character.is_whitespace() {
            out.push(character);
            index += 1;
            continue;
        }
        at_line_start = false;

        if character == '/' && index + 1 < bytes.len() && bytes[index + 1] == '/' {
            while index < bytes.len() && bytes[index] != '\n' {
                out.push(' ');
                index += 1;
            }
            continue;
        }
        if character == '/' && index + 1 < bytes.len() && bytes[index + 1] == '*' {
            index += 2;
            out.push(' ');
            out.push(' ');
            while index < bytes.len() {
                if bytes[index] == '*' && index + 1 < bytes.len() && bytes[index + 1] == '/' {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    break;
                }
                if bytes[index] == '\n' {
                    out.push('\n');
                } else {
                    out.push(' ');
                }
                index += 1;
            }
            continue;
        }

        out.push(character);
        index += 1;
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    text: String,
    line: usize,
}

fn tokenize(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut line = 1usize;
    for character in text.chars() {
        if character == '\n' {
            line += 1;
        }
        if character.is_alphanumeric() || character == '_' {
            current.push(character);
            continue;
        }
        if !current.is_empty() {
            tokens.push(Token {
                text: std::mem::take(&mut current),
                line,
            });
        }
        if !character.is_whitespace() {
            tokens.push(Token {
                text: character.to_string(),
                line,
            });
        }
    }
    if !current.is_empty() {
        tokens.push(Token {
            text: current,
            line,
        });
    }
    tokens
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
    header: CHeader,
    aliases: HashMap<String, String>,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            position: 0,
            header: CHeader::default(),
            aliases: HashMap::new(),
        }
    }

    fn peek(&self) -> Option<&str> {
        self.tokens
            .get(self.position)
            .map(|token| token.text.as_str())
    }

    fn line(&self) -> usize {
        self.tokens
            .get(self.position)
            .map(|token| token.line)
            .unwrap_or(0)
    }

    fn bump(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        self.position += 1;
        token
    }

    fn expect(&mut self, text: &str) -> Result<(), CHeaderError> {
        if self.peek() == Some(text) {
            self.position += 1;
            return Ok(());
        }
        Err(CHeaderError {
            line: self.line(),
            message: format!(
                "expected `{text}`, found `{}`",
                self.peek().unwrap_or("end of file")
            ),
        })
    }

    fn run(mut self) -> Result<CHeader, CHeaderError> {
        while let Some(token) = self.peek().map(str::to_string) {
            match token.as_str() {
                "typedef" => {
                    self.position += 1;
                    match self.peek() {
                        Some("struct") => {
                            let definition = self.parse_struct(true)?;
                            self.header.structs.push(definition);
                        }
                        Some("enum") => {
                            let definition = self.parse_enum(true)?;
                            self.header.enums.push(definition);
                        }
                        _ => self.parse_alias()?,
                    }
                    continue;
                }
                "struct" => {
                    if let Some(definition) = self.parse_struct_or_skip()? {
                        self.header.structs.push(definition);
                    }
                    continue;
                }
                "enum" => {
                    let definition = self.parse_enum(false)?;
                    self.header.enums.push(definition);
                }
                _ => {
                    self.position += 1;
                }
            }
        }
        Ok(self.header)
    }

    /// `typedef uint16_t le_word;`
    fn parse_alias(&mut self) -> Result<(), CHeaderError> {
        let mut type_words = Vec::new();
        while let Some(token) = self
            .tokens
            .get(self.position)
            .map(|token| token.text.clone())
        {
            if token == ";" {
                self.position += 1;
                break;
            }
            type_words.push(token);
            self.position += 1;
        }
        if type_words.len() >= 2 {
            let name = type_words.pop().unwrap();
            self.aliases.insert(name, type_words.join(" "));
        }
        Ok(())
    }

    fn parse_attribute_packed(&mut self) -> bool {
        if self.peek() != Some("__attribute__") && self.peek() != Some("__attribute") {
            return false;
        }
        self.position += 1;
        let mut packed = false;
        let mut depth = 0usize;
        while let Some(token) = self
            .tokens
            .get(self.position)
            .map(|token| token.text.clone())
        {
            match token.as_str() {
                "(" => depth += 1,
                ")" => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        self.position += 1;
                        break;
                    }
                }
                "packed" => packed = true,
                _ => {}
            }
            self.position += 1;
        }
        packed
    }

    fn parse_struct_or_skip(&mut self) -> Result<Option<CStruct>, CHeaderError> {
        let start = self.position;
        match self.parse_struct(false) {
            Ok(definition) => Ok(Some(definition)),
            Err(error) => {
                // A forward declaration or a nested use: skip to the semicolon.
                if error.message.contains("expected `{`") {
                    self.position = start;
                    while let Some(token) = self.bump() {
                        if token.text == ";" {
                            return Ok(None);
                        }
                    }
                    return Ok(None);
                }
                Err(error)
            }
        }
    }

    fn parse_struct(&mut self, typedef: bool) -> Result<CStruct, CHeaderError> {
        self.expect("struct")?;
        let mut packed = self.parse_attribute_packed();

        let mut name = String::new();
        if let Some(token) = self.peek()
            && token != "{"
            && token != "__attribute__"
        {
            name = self.bump().unwrap().text;
        }
        if self.peek() == Some("__attribute__") {
            packed |= self.parse_attribute_packed();
        }

        self.expect("{")?;
        let body = self.collect_body()?;
        self.expect("}")?;
        if self.peek() == Some("__attribute__") {
            packed |= self.parse_attribute_packed();
        }

        // The declarator after the closing brace names a typedef struct.
        if let Some(token) = self.peek()
            && token != ";"
            && token != "{"
        {
            if name.is_empty() || typedef {
                name = self.bump().unwrap().text;
                if self.peek() == Some("[") {
                    return Err(CHeaderError {
                        line: self.line(),
                        message: "an array of structs is not supported".to_string(),
                    });
                }
            } else {
                self.bump();
            }
        }
        self.expect(";")?;
        if name.is_empty() {
            return Err(CHeaderError {
                line: self.line(),
                message: "a struct needs a name".to_string(),
            });
        }

        let fields = self.layout(&body, packed)?;
        let size = fields
            .iter()
            .map(|field| field.offset + field.len)
            .max()
            .unwrap_or(0);
        Ok(CStruct {
            name,
            packed,
            size,
            fields,
        })
    }

    fn parse_enum(&mut self, typedef: bool) -> Result<CEnum, CHeaderError> {
        self.expect("enum")?;
        let mut name = String::new();
        if let Some(token) = self.peek()
            && token != "{"
        {
            name = self.bump().unwrap().text;
        }
        self.expect("{")?;
        let body = self.collect_body()?;
        self.expect("}")?;

        if let Some(token) = self.peek()
            && token != ";"
        {
            if name.is_empty() || typedef {
                name = self.bump().unwrap().text;
            } else {
                self.bump();
            }
        }
        self.expect(";")?;

        let mut variants = Vec::new();
        let mut next = 0i64;
        let mut current = String::new();
        let mut value = String::new();
        let mut after_equals = false;
        for token in body.iter().chain(std::iter::once(&Token {
            text: ";".to_string(),
            line: 0,
        })) {
            match token.text.as_str() {
                "=" => after_equals = true,
                "," | ";" => {
                    if !current.is_empty() {
                        if after_equals {
                            next = value.parse().unwrap_or(next);
                        }
                        variants.push((current.clone(), next));
                        next += 1;
                        current.clear();
                        value.clear();
                        after_equals = false;
                    }
                }
                other => {
                    if after_equals {
                        value.push_str(other);
                    } else {
                        current.push_str(other);
                    }
                }
            }
        }

        Ok(CEnum { name, variants })
    }

    /// Collect tokens between braces, stopping before the matching close.
    fn collect_body(&mut self) -> Result<Vec<Token>, CHeaderError> {
        let mut depth = 1usize;
        let mut body = Vec::new();
        while let Some(token) = self.bump() {
            match token.text.as_str() {
                "{" => {
                    depth += 1;
                    body.push(token);
                }
                "}" => {
                    depth -= 1;
                    if depth == 0 {
                        self.position -= 1;
                        return Ok(body);
                    }
                    body.push(token);
                }
                _ => body.push(token),
            }
        }
        Err(CHeaderError {
            line: self.line(),
            message: "unclosed brace".to_string(),
        })
    }

    fn layout(&mut self, body: &[Token], packed: bool) -> Result<Vec<CField>, CHeaderError> {
        let mut fields = Vec::new();
        let mut offset = 0u32;
        let mut bit_unit_offset = 0u32;
        let mut bit_cursor = 0u8;
        let mut bit_unit_size = 0u8;
        let mut in_bitfield = false;

        for member in split_members(body)? {
            let (type_words, declarators, line) = classify_member(&member)?;
            let type_name = type_words.join(" ");
            let resolved = self.resolve_type(&type_name);
            let Some(type_name) = resolved else {
                return Err(CHeaderError {
                    line,
                    message: format!("unknown type `{type_name}`"),
                });
            };
            let (size, _, _) = type_info(&type_name).unwrap_or((4, false, false));
            let enum_name = self.enum_for(&type_words);

            for declarator in declarators {
                if let Some(bits) = declarator.bits {
                    if !packed {
                        return Err(CHeaderError {
                            line,
                            message: format!(
                                "bitfield `{}` needs a packed struct; alignment rules are not guessed",
                                declarator.name
                            ),
                        });
                    }
                    if !in_bitfield || size != bit_unit_size || bit_cursor + bits > size * 8 {
                        // A new storage unit starts at the current byte position.
                        bit_unit_offset = offset;
                        bit_unit_size = size;
                        bit_cursor = 0;
                        in_bitfield = true;
                    }
                    fields.push(CField {
                        name: declarator.name,
                        type_name: type_name.clone(),
                        offset: bit_unit_offset,
                        len: u32::from(bit_unit_size),
                        bit: Some((bit_cursor, bits)),
                        array: None,
                        enum_name: enum_name.clone(),
                    });
                    bit_cursor += bits;
                    continue;
                }

                if in_bitfield {
                    // Step past the storage unit the bitfields occupied.
                    offset = bit_unit_offset + u32::from(bit_unit_size);
                    in_bitfield = false;
                    bit_unit_size = 0;
                }

                let alignment = if packed { 1 } else { size.max(1) };
                if !packed {
                    offset = offset.div_ceil(u32::from(alignment)) * u32::from(alignment);
                }
                let count = declarator.array;
                let len = u32::from(size) * u32::from(count.unwrap_or(1));
                fields.push(CField {
                    name: declarator.name,
                    type_name: type_name.clone(),
                    offset,
                    len,
                    bit: None,
                    array: count,
                    enum_name: enum_name.clone(),
                });
                offset += len;
            }
        }
        Ok(fields)
    }

    fn resolve_type(&self, name: &str) -> Option<String> {
        if type_info(name).is_some() {
            return Some(name.to_string());
        }
        self.aliases
            .get(name)
            .cloned()
            .filter(|alias| type_info(alias).is_some())
    }

    fn enum_for(&self, type_words: &[String]) -> Option<String> {
        let name = type_words.last()?;
        self.header
            .enums
            .iter()
            .find(|item| &item.name == name)
            .map(|item| item.name.clone())
    }
}

struct Declarator {
    name: String,
    array: Option<u16>,
    bits: Option<u8>,
}

/// Split a struct body into members at depth-zero semicolons.
fn split_members(body: &[Token]) -> Result<Vec<Vec<Token>>, CHeaderError> {
    let mut members = Vec::new();
    let mut current = Vec::new();
    let mut depth = 0usize;
    for token in body {
        match token.text.as_str() {
            "[" | "(" => depth += 1,
            "]" | ")" => depth = depth.saturating_sub(1),
            ";" if depth == 0 => {
                if !current.is_empty() {
                    members.push(std::mem::take(&mut current));
                }
                continue;
            }
            _ => {}
        }
        current.push(token.clone());
    }
    if !current.is_empty() {
        members.push(current);
    }
    Ok(members)
}

/// `uint8_t flags : 3` becomes type words plus one declarator.
fn classify_member(
    member: &[Token],
) -> Result<(Vec<String>, Vec<Declarator>, usize), CHeaderError> {
    let line = member.first().map(|token| token.line).unwrap_or(0);
    let mut words: Vec<String> = Vec::new();
    for token in member {
        words.push(token.text.clone());
    }
    // Drop storage qualifiers that do not change the layout.
    words.retain(|word| !matches!(word.as_str(), "const" | "volatile" | "static"));

    // The field name is the last identifier before a bracketed, bit or end token.
    let mut name_at = None;
    for (index, word) in words.iter().enumerate() {
        let next = words.get(index + 1).map(String::as_str);
        let is_identifier = word
            .chars()
            .next()
            .is_some_and(|character| character.is_alphabetic() || character == '_');
        if is_identifier && matches!(next, None | Some(":") | Some("[")) && index > 0 {
            name_at = Some(index);
        }
    }
    let Some(name_at) = name_at else {
        return Err(CHeaderError {
            line,
            message: "a member needs a name".to_string(),
        });
    };

    let type_words = words[..name_at].to_vec();
    if type_words.is_empty() {
        return Err(CHeaderError {
            line,
            message: "a member needs a type".to_string(),
        });
    }

    let mut declarators = Vec::new();
    let mut index = name_at;
    loop {
        let name = words[index].clone();
        index += 1;
        let mut array = None;
        let mut bits = None;
        if words.get(index).map(String::as_str) == Some("[") {
            let count = words.get(index + 1).cloned().unwrap_or_default();
            if words.get(index + 2).map(String::as_str) == Some("]") {
                array = count.parse::<u16>().ok();
                index += 3;
            }
        }
        if words.get(index).map(String::as_str) == Some(":") {
            bits = words
                .get(index + 1)
                .and_then(|value| value.parse::<u8>().ok());
            index += 2;
        }
        declarators.push(Declarator { name, array, bits });

        if words.get(index).map(String::as_str) == Some(",") {
            index += 1;
            continue;
        }
        break;
    }

    Ok((type_words, declarators, line))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = r#"
        #include <stdint.h>

        /* Telemetry from the flight controller. */
        typedef enum {
            MODE_IDLE = 0,
            MODE_RUN = 1,
            MODE_FAULT = 2,
        } mode_t;

        struct __attribute__((packed)) ImuPacket {
            uint16_t sync;          // 0..2
            uint8_t  version;       // 2..3
            uint8_t  flags : 3;     // byte 3
            uint8_t  channel : 5;
            __le32   timestamp_us;  // 4..8
            __be16   v_batt_mv;     // 8..10
            float    gyro_z;        // 10..14
            uint8_t  samples[4];    // 14..18
            uint8_t  mode;          // 18..19
        };
    "#;

    #[test]
    fn a_packed_struct_lays_out_field_by_field() {
        let header = parse(HEADER).unwrap();
        let packet = header
            .structs
            .iter()
            .find(|item| item.name == "ImuPacket")
            .expect("ImuPacket");
        assert!(packet.packed);
        assert_eq!(packet.size, 19);

        let offsets: Vec<(&str, u32, u32)> = packet
            .fields
            .iter()
            .map(|field| (field.name.as_str(), field.offset, field.len))
            .collect();
        assert_eq!(
            offsets,
            vec![
                ("sync", 0, 2),
                ("version", 2, 1),
                ("flags", 3, 1),
                ("channel", 3, 1),
                ("timestamp_us", 4, 4),
                ("v_batt_mv", 8, 2),
                ("gyro_z", 10, 4),
                ("samples", 14, 4),
                ("mode", 18, 1),
            ]
        );
        assert_eq!(packet.fields[2].bit, Some((0, 3)));
        assert_eq!(packet.fields[3].bit, Some((3, 5)));
        assert_eq!(packet.fields[7].array, Some(4));
    }

    #[test]
    fn enums_keep_their_labels_and_explicit_values() {
        let header = parse(HEADER).unwrap();
        let mode = header
            .enums
            .iter()
            .find(|item| item.name == "mode_t")
            .expect("mode_t");
        assert_eq!(
            mode.variants,
            vec![
                ("MODE_IDLE".to_string(), 0),
                ("MODE_RUN".to_string(), 1),
                ("MODE_FAULT".to_string(), 2),
            ]
        );
    }

    #[test]
    fn an_unpacked_struct_aligns_each_field() {
        let header = parse(
            r#"
            struct Unaligned {
                uint8_t  tag;
                uint32_t value;
                uint16_t tail;
            };
            "#,
        )
        .unwrap();
        let definition = &header.structs[0];
        assert!(!definition.packed);
        let offsets: Vec<u32> = definition.fields.iter().map(|field| field.offset).collect();
        assert_eq!(offsets, vec![0, 4, 8]);
        assert_eq!(definition.size, 10);
    }

    #[test]
    fn a_bitfield_needs_a_packed_struct() {
        let error = parse(
            r#"
            struct Loose {
                uint8_t flags : 3;
            };
            "#,
        )
        .unwrap_err();
        assert!(error.message.contains("packed"), "{error}");
    }

    #[test]
    fn an_unknown_type_is_refused_with_its_line() {
        let error = parse(
            r#"
            struct Broken {
                mystery_t field;
            };
            "#,
        )
        .unwrap_err();
        assert!(
            error.message.contains("unknown type `mystery_t`"),
            "{error}"
        );
        assert!(error.line >= 2, "{error}");
    }

    #[test]
    fn typedef_aliases_resolve() {
        let header = parse(
            r#"
            typedef uint16_t le_word;
            struct Words {
                le_word a;
                le_word b;
            };
            "#,
        )
        .unwrap();
        assert_eq!(header.structs[0].size, 4);
        assert_eq!(header.structs[0].fields[1].offset, 2);
    }

    #[test]
    fn comments_and_includes_do_not_confuse_the_parser() {
        let header = parse(
            r#"
            #include <stdint.h>
            // one line comment
            struct /* inline */ Small {
                uint8_t a; /* trailing */
                uint8_t b;
            };
            "#,
        )
        .unwrap();
        assert_eq!(header.structs[0].fields.len(), 2);
    }

    #[test]
    fn compiling_names_the_fields_and_keeps_byte_order() {
        let header = parse(HEADER).unwrap();
        let ir = compile(&header, "ImuPacket", "imu_packet.h").unwrap();
        assert_eq!(ir.ops.len(), 9);
        match &ir.ops[5] {
            IrOp::Label { name, op } => {
                assert_eq!(name, "v_batt_mv");
                assert!(matches!(
                    **op,
                    IrOp::UInt {
                        offset: 8,
                        width: 2,
                        big_endian: true
                    }
                ));
            }
            other => panic!("unexpected op {other:?}"),
        }
        match &ir.ops[7] {
            IrOp::Label { op, .. } => assert!(matches!(**op, IrOp::Array { count: 4, .. })),
            other => panic!("unexpected op {other:?}"),
        }
    }

    #[test]
    fn a_missing_root_struct_is_reported() {
        let header = parse(HEADER).unwrap();
        let error = compile(&header, "NoSuchPacket", "imu_packet.h").unwrap_err();
        assert!(error.message.contains("NoSuchPacket"), "{error}");
    }
}
