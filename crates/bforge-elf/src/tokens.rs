//! Token decoding for Pigweed `pw_tokenizer` and Rust `defmt` (F3.6, D-42).
//!
//! Embedded loggers avoid sending text strings over low-speed serial links.
//! `pw_tokenizer` and `defmt` intern format strings in ELF sections or token tables
//! at compile time. The microcontroller transmits an integer token and compact binary
//! arguments.
//!
//! This module resolves token IDs to format strings and reconstructs human-readable
//! log messages. When a token is absent, it reports the raw bytes honestly without
//! guessing (Invariant I8).

use object::ObjectSymbol;
use std::collections::HashMap;

/// A decoded token log from a `pw_tokenizer` or `defmt` frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTokenLog {
    /// Token identifier or format string index.
    pub token: u32,
    /// Token domain name (e.g. empty, custom Pigweed domain, or "defmt").
    pub domain: String,
    /// Severity level when known (e.g. "trace", "debug", "info", "warn", "error").
    pub level: Option<String>,
    /// Reconstructed message with formatted arguments.
    pub message: String,
    /// Formatted argument strings in order of occurrence.
    pub args: Vec<String>,
}

/// Token decoding failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenDecodeError {
    /// Frame length is shorter than the minimum header or expected field.
    FrameTooShort(usize),
    /// Varint byte sequence exceeds 64 bits or is malformed.
    InvalidVarint,
    /// Frame ended before the required payload was satisfied.
    UnexpectedEof,
    /// Frame data is truncated.
    TruncatedData,
}

impl std::fmt::Display for TokenDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FrameTooShort(len) => write!(f, "frame length {len} is too short"),
            Self::InvalidVarint => write!(f, "invalid varint encoding"),
            Self::UnexpectedEof => write!(f, "unexpected end of frame data"),
            Self::TruncatedData => write!(f, "frame data is truncated"),
        }
    }
}

impl std::error::Error for TokenDecodeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PwEntry {
    domain: String,
    format_str: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DefmtEntry {
    level: Option<String>,
    format_str: String,
}

/// Token database holding interned strings for `pw_tokenizer` and `defmt`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TokenDatabase {
    pw_tokens: HashMap<u32, PwEntry>,
    defmt_tokens: HashMap<u32, DefmtEntry>,
}

impl TokenDatabase {
    /// Create an empty database.
    pub fn new() -> Self {
        Self::default()
    }

    /// True when the database contains no entries.
    pub fn is_empty(&self) -> bool {
        self.pw_tokens.is_empty() && self.defmt_tokens.is_empty()
    }

    /// Total number of interned token entries.
    pub fn len(&self) -> usize {
        self.pw_tokens.len() + self.defmt_tokens.len()
    }

    /// Number of Pigweed token entries.
    pub fn pw_len(&self) -> usize {
        self.pw_tokens.len()
    }

    /// Number of defmt token entries.
    pub fn defmt_len(&self) -> usize {
        self.defmt_tokens.len()
    }

    /// Insert a Pigweed token entry.
    pub fn insert_pw(&mut self, token: u32, domain: &str, format_str: &str) {
        self.pw_tokens.insert(
            token,
            PwEntry {
                domain: domain.to_string(),
                format_str: format_str.to_string(),
            },
        );
    }

    /// Insert a Rust defmt format entry.
    pub fn insert_defmt(&mut self, index: u32, level: Option<&str>, format_str: &str) {
        self.defmt_tokens.insert(
            index,
            DefmtEntry {
                level: level.map(str::to_string),
                format_str: format_str.to_string(),
            },
        );
    }

    /// Retrieve a Pigweed entry by token ID.
    pub fn get_pw(&self, token: u32) -> Option<(&str, &str)> {
        self.pw_tokens
            .get(&token)
            .map(|e| (e.domain.as_str(), e.format_str.as_str()))
    }

    /// Retrieve a defmt entry by index.
    pub fn get_defmt(&self, index: u32) -> Option<(Option<&str>, &str)> {
        self.defmt_tokens
            .get(&index)
            .map(|e| (e.level.as_deref(), e.format_str.as_str()))
    }

    /// Parse Pigweed binary entries from `.pw_tokenizer.entries`.
    ///
    /// Layout per entry:
    /// - Magic `0x495A_54FE` (`[0xFE, 0x54, 0x5A, 0x49]`)
    /// - 4-byte LE token `u32`
    /// - 4-byte LE domain length `u32`
    /// - 4-byte LE string length `u32`
    /// - `domain_len` bytes
    /// - `string_len` bytes
    /// - Padded to 4-byte alignment
    pub fn load_pw_entries(&mut self, data: &[u8]) -> usize {
        let mut count = 0;
        let mut offset = 0;
        while offset + 16 <= data.len() {
            let magic = u32::from_le_bytes([
                data[offset],
                data[offset + 1],
                data[offset + 2],
                data[offset + 3],
            ]);
            if magic != 0x495A_54FE {
                offset += 1;
                continue;
            }

            let token = u32::from_le_bytes([
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7],
            ]);
            let domain_len = u32::from_le_bytes([
                data[offset + 8],
                data[offset + 9],
                data[offset + 10],
                data[offset + 11],
            ]) as usize;
            let string_len = u32::from_le_bytes([
                data[offset + 12],
                data[offset + 13],
                data[offset + 14],
                data[offset + 15],
            ]) as usize;

            let domain_start = offset + 16;
            let string_start = domain_start + domain_len;
            let entry_end = string_start + string_len;

            if entry_end > data.len() {
                break;
            }

            let domain = String::from_utf8_lossy(&data[domain_start..string_start]).to_string();
            let format_str = String::from_utf8_lossy(&data[string_start..entry_end]).to_string();

            self.insert_pw(token, &domain, &format_str);
            count += 1;

            let total_len = 16 + domain_len + string_len;
            let aligned_len = (total_len + 3) & !3;
            offset += aligned_len;
        }
        count
    }

    /// Parse Pigweed CSV token database lines.
    ///
    /// Accepts 2-column (`token,string`), 3-column (`token,domain,string`), or
    /// standard Pigweed 4-column (`token,date_removed,domain,string`) formats.
    pub fn parse_pw_csv(&mut self, csv_text: &str) -> usize {
        let mut count = 0;
        for line in csv_text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let fields = parse_csv_line(trimmed);
            if fields.is_empty() {
                continue;
            }
            // Skip header row if present
            if fields[0].eq_ignore_ascii_case("token") {
                continue;
            }

            let token_str = fields[0].trim_start_matches("0x").trim_start_matches("0X");
            let Ok(token) =
                u32::from_str_radix(token_str, 16).or_else(|_| fields[0].parse::<u32>())
            else {
                continue;
            };

            let (domain, format_str) = match fields.len() {
                2 => ("", fields[1].as_str()),
                3 => (fields[1].as_str(), fields[2].as_str()),
                4.. => (fields[2].as_str(), fields[3].as_str()),
                _ => continue,
            };

            let clean_str = unquote(format_str);
            self.insert_pw(token, domain, &clean_str);
            count += 1;
        }
        count
    }

    /// Parse `.defmt` section records from an ELF binary.
    pub fn load_defmt_section(&mut self, data: &[u8]) -> usize {
        let mut count = 0;
        let s = String::from_utf8_lossy(data);
        let mut seq_index = 0u32;
        for part in s.split(['\0', '\n']) {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            if part.starts_with('{') && part.contains("\"data\"") {
                if self.load_defmt_json_entry(part, Some(seq_index)) {
                    count += 1;
                    seq_index += 1;
                }
            } else {
                self.insert_defmt(seq_index, None, part);
                count += 1;
                seq_index += 1;
            }
        }
        count
    }

    /// Inspect symbol table for defmt metadata strings.
    pub fn load_symbols<'data, T: object::Object<'data>>(&mut self, object: &T) -> usize {
        let mut count = 0;
        for symbol in object.symbols().chain(object.dynamic_symbols()) {
            let Ok(name) = symbol.name() else { continue };
            if name.starts_with('{')
                && name.ends_with('}')
                && name.contains("\"data\"")
                && self.load_defmt_json_entry(name, None)
            {
                count += 1;
            }
        }
        count
    }

    fn load_defmt_json_entry(&mut self, json_str: &str, fallback_index: Option<u32>) -> bool {
        let tag = extract_json_string(json_str, "tag");
        let data = extract_json_string(json_str, "data");
        let explicit_index = extract_json_number(json_str, "index")
            .or_else(|| extract_json_number(json_str, "id"))
            .map(|n| n as u32);

        let Some(format_str) = data else {
            return false;
        };

        let index = match (explicit_index, fallback_index) {
            (Some(idx), _) => idx,
            (None, Some(idx)) => idx,
            (None, None) => return false,
        };

        let level = tag.as_deref().and_then(parse_defmt_level);
        self.insert_defmt(index, level, &format_str);
        true
    }

    /// Decode a Pigweed `pw_tokenizer` binary frame.
    ///
    /// First 4 bytes are the little-endian token ID. Remaining bytes are
    /// ZigZag varint integers and length-prefixed strings.
    pub fn decode_pw(&self, frame: &[u8]) -> Result<DecodedTokenLog, TokenDecodeError> {
        if frame.len() < 4 {
            return Err(TokenDecodeError::FrameTooShort(frame.len()));
        }

        let token = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
        let raw_args = &frame[4..];

        let Some(entry) = self.pw_tokens.get(&token) else {
            // Invariant I8: Never guess when absent. Report ID and raw argument bytes honestly.
            let raw_args_hex = raw_args.iter().map(|b| format!("0x{b:02x}")).collect();
            let raw_desc = if raw_args.is_empty() {
                String::new()
            } else {
                format!(" (raw: {:02x?})", raw_args)
            };
            return Ok(DecodedTokenLog {
                token,
                domain: String::new(),
                level: None,
                message: format!("unknown token 0x{token:08x}{raw_desc}"),
                args: raw_args_hex,
            });
        };

        let (message, args) = format_printf(&entry.format_str, raw_args)?;

        Ok(DecodedTokenLog {
            token,
            domain: entry.domain.clone(),
            level: None,
            message,
            args,
        })
    }

    /// Decode a `defmt` frame without a timestamp prefix.
    pub fn decode_defmt(&self, frame: &[u8]) -> Result<DecodedTokenLog, TokenDecodeError> {
        self.decode_defmt_frame(frame, false)
    }

    /// Decode a `defmt` frame with an expected LEB128 timestamp following the index.
    pub fn decode_defmt_with_timestamp(
        &self,
        frame: &[u8],
    ) -> Result<DecodedTokenLog, TokenDecodeError> {
        self.decode_defmt_frame(frame, true)
    }

    /// Decode a `defmt` frame with optional timestamp support.
    pub fn decode_defmt_frame(
        &self,
        frame: &[u8],
        has_timestamp: bool,
    ) -> Result<DecodedTokenLog, TokenDecodeError> {
        let (index, mut offset) = read_leb128_u32(frame)?;

        let timestamp = if has_timestamp {
            let (ts, ts_len) = read_leb128_u64(&frame[offset..])?;
            offset += ts_len;
            Some(ts)
        } else {
            None
        };

        let raw_args = &frame[offset..];

        let Some(entry) = self.defmt_tokens.get(&index) else {
            // Invariant I8: Never guess when absent. Report ID and raw argument bytes honestly.
            let raw_args_hex = raw_args.iter().map(|b| format!("0x{b:02x}")).collect();
            let raw_desc = if raw_args.is_empty() {
                String::new()
            } else {
                format!(" (raw: {:02x?})", raw_args)
            };
            return Ok(DecodedTokenLog {
                token: index,
                domain: "defmt".to_string(),
                level: None,
                message: format!("unknown defmt index {index}{raw_desc}"),
                args: raw_args_hex,
            });
        };

        let (body, args) = format_defmt(&entry.format_str, raw_args)?;
        let message = match timestamp {
            Some(ts) => format!("[{ts}] {body}"),
            None => body,
        };

        Ok(DecodedTokenLog {
            token: index,
            domain: "defmt".to_string(),
            level: entry.level.clone(),
            message,
            args,
        })
    }
}

fn parse_defmt_level(tag: &str) -> Option<&'static str> {
    match tag {
        "defmt_trace" | "trace" => Some("trace"),
        "defmt_debug" | "debug" => Some("debug"),
        "defmt_info" | "info" => Some("info"),
        "defmt_warn" | "warn" => Some("warn"),
        "defmt_error" | "error" => Some("error"),
        _ => None,
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('"') && s.ends_with('"') && s.len() >= 2 {
        s[1..s.len() - 1].replace("\"\"", "\"")
    } else {
        s.to_string()
    }
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                current.push('"');
                i += 2;
                continue;
            } else {
                in_quotes = !in_quotes;
            }
        } else if c == ',' && !in_quotes {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    fields.push(current.trim().to_string());
    fields
}

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\"");
    let key_pos = json.find(&pattern)?;
    let after_key = &json[key_pos + pattern.len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = after_key[colon_pos + 1..].trim_start();
    if !after_colon.starts_with('"') {
        return None;
    }
    let content = &after_colon[1..];
    let mut result = String::new();
    let mut chars = content.chars();
    let mut escaped = false;
    for c in chars.by_ref() {
        if escaped {
            match c {
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                other => {
                    result.push('\\');
                    result.push(other);
                }
            }
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some(result);
        } else {
            result.push(c);
        }
    }
    None
}

fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{key}\"");
    let key_pos = json.find(&pattern)?;
    let after_key = &json[key_pos + pattern.len()..];
    let colon_pos = after_key.find(':')?;
    let after_colon = after_key[colon_pos + 1..].trim_start();
    let num_str: String = after_colon
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    num_str.parse().ok()
}

fn read_varint_u64(bytes: &[u8], offset: &mut usize) -> Result<u64, TokenDecodeError> {
    let mut result: u64 = 0;
    let mut shift = 0;
    while *offset < bytes.len() {
        let byte = bytes[*offset];
        *offset += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if (byte & 0x80) == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err(TokenDecodeError::InvalidVarint);
        }
    }
    Err(TokenDecodeError::UnexpectedEof)
}

fn decode_zigzag64(val: u64) -> i64 {
    ((val >> 1) as i64) ^ (-((val & 1) as i64))
}

fn read_leb128_u32(bytes: &[u8]) -> Result<(u32, usize), TokenDecodeError> {
    let mut offset = 0;
    let val = read_varint_u64(bytes, &mut offset)?;
    if val > u32::MAX as u64 {
        return Err(TokenDecodeError::InvalidVarint);
    }
    Ok((val as u32, offset))
}

fn read_leb128_u64(bytes: &[u8]) -> Result<(u64, usize), TokenDecodeError> {
    let mut offset = 0;
    let val = read_varint_u64(bytes, &mut offset)?;
    Ok((val, offset))
}

/// Format printf-style format strings for `pw_tokenizer`.
fn format_printf(
    format_str: &str,
    args_data: &[u8],
) -> Result<(String, Vec<String>), TokenDecodeError> {
    let mut message = String::with_capacity(format_str.len() * 2);
    let mut args = Vec::new();
    let mut offset = 0;

    let chars: Vec<char> = format_str.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '%' {
            if i + 1 < chars.len() && chars[i + 1] == '%' {
                message.push('%');
                i += 2;
                continue;
            }

            let spec_start = i;
            i += 1;

            let mut width: Option<usize> = None;
            let mut zero_pad = false;

            if i < chars.len() && chars[i] == '0' {
                zero_pad = true;
                i += 1;
            }

            let width_start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i > width_start {
                width = format_str[width_start..i].parse().ok();
            }

            if i < chars.len() && chars[i] == '.' {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }

            while i < chars.len() && matches!(chars[i], 'l' | 'h' | 'z' | 'j' | 't') {
                i += 1;
            }

            if i >= chars.len() {
                message.push_str(&format_str[spec_start..]);
                break;
            }

            let conv = chars[i];
            i += 1;

            match conv {
                'd' | 'i' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let signed = decode_zigzag64(raw);
                    let formatted = match (width, zero_pad) {
                        (Some(w), true) if signed >= 0 => format!("{signed:0w$}"),
                        (Some(w), _) => format!("{signed:w$}"),
                        (None, _) => format!("{signed}"),
                    };
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                'u' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let signed = decode_zigzag64(raw);
                    let unsigned = signed as u64;
                    let formatted = match (width, zero_pad) {
                        (Some(w), true) => format!("{unsigned:0w$}"),
                        (Some(w), false) => format!("{unsigned:w$}"),
                        (None, _) => format!("{unsigned}"),
                    };
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                'x' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let signed = decode_zigzag64(raw);
                    let unsigned = signed as u64;
                    let formatted = match (width, zero_pad) {
                        (Some(w), true) => format!("{unsigned:0w$x}"),
                        (Some(w), false) => format!("{unsigned:w$x}"),
                        (None, _) => format!("{unsigned:x}"),
                    };
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                'X' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let signed = decode_zigzag64(raw);
                    let unsigned = signed as u64;
                    let formatted = match (width, zero_pad) {
                        (Some(w), true) => format!("{unsigned:0w$X}"),
                        (Some(w), false) => format!("{unsigned:w$X}"),
                        (None, _) => format!("{unsigned:X}"),
                    };
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                's' => {
                    if offset >= args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let raw_len = args_data[offset];
                    offset += 1;
                    let len = (raw_len & 0x7F) as usize;
                    let end = offset + len;
                    if end > args_data.len() {
                        return Err(TokenDecodeError::TruncatedData);
                    }
                    let s = match std::str::from_utf8(&args_data[offset..end]) {
                        Ok(valid) => valid.to_string(),
                        Err(_) => String::from_utf8_lossy(&args_data[offset..end]).to_string(),
                    };
                    offset = end;
                    message.push_str(&s);
                    args.push(s);
                }
                'c' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let ch = (decode_zigzag64(raw) as u8) as char;
                    message.push(ch);
                    args.push(ch.to_string());
                }
                'p' => {
                    let raw = read_varint_u64(args_data, &mut offset)?;
                    let ptr = decode_zigzag64(raw) as u64;
                    let formatted = format!("0x{ptr:x}");
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                _ => {
                    message.push_str(&format_str[spec_start..i]);
                }
            }
        } else {
            message.push(chars[i]);
            i += 1;
        }
    }

    Ok((message, args))
}

/// Format placeholder format strings for `defmt`.
fn format_defmt(
    format_str: &str,
    args_data: &[u8],
) -> Result<(String, Vec<String>), TokenDecodeError> {
    let mut message = String::with_capacity(format_str.len() * 2);
    let mut args = Vec::new();
    let mut offset = 0;

    let chars: Vec<char> = format_str.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '{' {
            if i + 1 < chars.len() && chars[i + 1] == '{' {
                message.push('{');
                i += 2;
                continue;
            }

            let close = match chars[i..].iter().position(|&c| c == '}') {
                Some(pos) => i + pos,
                None => {
                    message.push('{');
                    i += 1;
                    continue;
                }
            };
            let spec: String = chars[i + 1..close].iter().collect();
            let spec = spec.trim();
            i = close + 1;

            let trimmed = spec.trim_start_matches(':').trim_start_matches('=').trim();

            match trimmed {
                "u8" => {
                    if offset >= args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = args_data[offset];
                    offset += 1;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "i8" => {
                    if offset >= args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = args_data[offset] as i8;
                    offset += 1;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "u16" => {
                    if offset + 2 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = u16::from_le_bytes([args_data[offset], args_data[offset + 1]]);
                    offset += 2;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "i16" => {
                    if offset + 2 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = i16::from_le_bytes([args_data[offset], args_data[offset + 1]]);
                    offset += 2;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "u32" => {
                    if offset + 4 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = u32::from_le_bytes([
                        args_data[offset],
                        args_data[offset + 1],
                        args_data[offset + 2],
                        args_data[offset + 3],
                    ]);
                    offset += 4;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "i32" => {
                    if offset + 4 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = i32::from_le_bytes([
                        args_data[offset],
                        args_data[offset + 1],
                        args_data[offset + 2],
                        args_data[offset + 3],
                    ]);
                    offset += 4;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "u64" => {
                    if offset + 8 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let bytes: [u8; 8] = args_data[offset..offset + 8]
                        .try_into()
                        .map_err(|_| TokenDecodeError::UnexpectedEof)?;
                    let val = u64::from_le_bytes(bytes);
                    offset += 8;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "i64" => {
                    if offset + 8 > args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let bytes: [u8; 8] = args_data[offset..offset + 8]
                        .try_into()
                        .map_err(|_| TokenDecodeError::UnexpectedEof)?;
                    let val = i64::from_le_bytes(bytes);
                    offset += 8;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                "bool" => {
                    if offset >= args_data.len() {
                        return Err(TokenDecodeError::UnexpectedEof);
                    }
                    let val = args_data[offset] != 0;
                    offset += 1;
                    let formatted = if val { "true" } else { "false" };
                    message.push_str(formatted);
                    args.push(formatted.to_string());
                }
                "str" => {
                    let len = read_varint_u64(args_data, &mut offset)? as usize;
                    let end = offset + len;
                    if end > args_data.len() {
                        return Err(TokenDecodeError::TruncatedData);
                    }
                    let s = match std::str::from_utf8(&args_data[offset..end]) {
                        Ok(valid) => valid.to_string(),
                        Err(_) => String::from_utf8_lossy(&args_data[offset..end]).to_string(),
                    };
                    offset = end;
                    message.push_str(&s);
                    args.push(s);
                }
                "x" | ":x" | "02x" | "04x" | "08x" => {
                    let val = read_varint_u64(args_data, &mut offset)?;
                    let formatted = format!("{val:x}");
                    message.push_str(&formatted);
                    args.push(formatted);
                }
                _ => {
                    // Untyped {} or {:?}
                    let val = read_varint_u64(args_data, &mut offset)?;
                    let formatted = val.to_string();
                    message.push_str(&formatted);
                    args.push(formatted);
                }
            }
        } else if chars[i] == '}' {
            if i + 1 < chars.len() && chars[i + 1] == '}' {
                message.push('}');
                i += 2;
                continue;
            }
            message.push('}');
            i += 1;
        } else {
            message.push(chars[i]);
            i += 1;
        }
    }

    Ok((message, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pw_tokenizer_binary_section_parses_and_formats_zigzag_and_string_args() {
        let mut db = TokenDatabase::new();

        // Hand-build a .pw_tokenizer.entries section:
        // Magic: 0x495A_54FE -> [0xFE, 0x54, 0x5A, 0x49]
        // Token: 0x1234_5678 -> [0x78, 0x56, 0x34, 0x12]
        // Domain length: 4   -> [0x04, 0x00, 0x00, 0x00]
        // String length: 26  -> [0x1A, 0x00, 0x00, 0x00]
        // Domain bytes: "TEST" (4 bytes)
        // String bytes: "Temp: %d C, mode: %s, 0x%X" (26 bytes)
        // Entry size = 16 + 4 + 26 = 46 bytes.
        // Aligned size = (46 + 3) & !3 = 48 bytes (2 bytes padding).
        let mut section = Vec::new();
        section.extend_from_slice(&[0xFE, 0x54, 0x5A, 0x49]); // Magic
        section.extend_from_slice(&0x1234_5678u32.to_le_bytes()); // Token
        section.extend_from_slice(&4u32.to_le_bytes()); // Domain len
        let format_bytes = b"Temp: %d C, mode: %s, 0x%X";
        section.extend_from_slice(&(format_bytes.len() as u32).to_le_bytes()); // String len
        section.extend_from_slice(b"TEST"); // Domain
        section.extend_from_slice(format_bytes); // Format string
        section.extend_from_slice(&[0x00, 0x00]); // 2 bytes padding

        let loaded = db.load_pw_entries(&section);
        assert_eq!(loaded, 1);
        assert_eq!(db.pw_len(), 1);
        assert_eq!(
            db.get_pw(0x1234_5678),
            Some(("TEST", "Temp: %d C, mode: %s, 0x%X"))
        );

        // Encode a frame:
        // Token: 0x1234_5678 (4 bytes)
        // Arg 1 (%d): -5 -> ZigZag is 9 -> varint [0x09]
        // Arg 2 (%s): "NORMAL" (len 6, not truncated: 0x06, b"NORMAL")
        // Arg 3 (%X): 255 -> ZigZag is 510 (0x01FE) -> varint [0xFE, 0x03]
        let mut frame = Vec::new();
        frame.extend_from_slice(&0x1234_5678u32.to_le_bytes());
        frame.push(0x09); // -5
        frame.push(0x06); // string len
        frame.extend_from_slice(b"NORMAL");
        frame.extend_from_slice(&[0xFE, 0x03]); // 255

        let decoded = db.decode_pw(&frame).expect("decoding succeeded");
        assert_eq!(decoded.token, 0x1234_5678);
        assert_eq!(decoded.domain, "TEST");
        assert_eq!(decoded.level, None);
        assert_eq!(decoded.message, "Temp: -5 C, mode: NORMAL, 0xFF");
        assert_eq!(decoded.args, vec!["-5", "NORMAL", "FF"]);
    }

    #[test]
    fn defmt_frame_resolves_leb128_index_and_formats_typed_placeholders() {
        let mut db = TokenDatabase::new();
        // Insert defmt format string with LEB128 index 300 (0x012C -> [0xAC, 0x02])
        db.insert_defmt(
            300,
            Some("info"),
            "Boot step {:u8}: sensor={:u16}, delta={:i32}, active={:bool}, tag={:str}, raw={:x}",
        );

        // Frame structure:
        // LEB128 index: 300 -> [0xAC, 0x02]
        // u8: 42 -> [0x2A]
        // u16: 1200 -> [0xB0, 0x04]
        // i32: -20 -> 0xFFFF_FFEC -> [0xEC, 0xFF, 0xFF, 0xFF]
        // bool: true -> [0x01]
        // str: "imu" (len 3 -> varint [0x03], b"imu")
        // x: 0xABCD -> varint [0xCD, 0xD7, 0x02]
        let mut frame = Vec::new();
        frame.extend_from_slice(&[0xAC, 0x02]); // Index 300
        frame.push(42); // {:u8}
        frame.extend_from_slice(&1200u16.to_le_bytes()); // {:u16}
        frame.extend_from_slice(&(-20i32).to_le_bytes()); // {:i32}
        frame.push(1); // {:bool}
        frame.push(3); // {:str} len
        frame.extend_from_slice(b"imu");
        frame.extend_from_slice(&[0xCD, 0xD7, 0x02]); // 0xABCD as varint

        let decoded = db.decode_defmt(&frame).expect("defmt frame decodes");
        assert_eq!(decoded.token, 300);
        assert_eq!(decoded.domain, "defmt");
        assert_eq!(decoded.level.as_deref(), Some("info"));
        assert_eq!(
            decoded.message,
            "Boot step 42: sensor=1200, delta=-20, active=true, tag=imu, raw=abcd"
        );
        assert_eq!(
            decoded.args,
            vec!["42", "1200", "-20", "true", "imu", "abcd"]
        );
    }

    #[test]
    fn unknown_token_reports_id_and_raw_argument_bytes_honestly() {
        let db = TokenDatabase::new();

        // pw_tokenizer unknown token test:
        let pw_frame = [0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33];
        let pw_log = db
            .decode_pw(&pw_frame)
            .expect("decoding unknown pw token succeeds");
        assert_eq!(pw_log.token, 0xDDCC_BBAA);
        assert_eq!(pw_log.level, None);
        assert!(
            pw_log.message.contains("ddccbbaa") || pw_log.message.contains("DDCCBBAA"),
            "{}",
            pw_log.message
        );
        assert_eq!(pw_log.args, vec!["0x11", "0x22", "0x33"]);

        // defmt unknown index test:
        let defmt_frame = [0x7F, 0x44, 0x55]; // Index 127, raw args [0x44, 0x55]
        let defmt_log = db
            .decode_defmt(&defmt_frame)
            .expect("decoding unknown defmt succeeds");
        assert_eq!(defmt_log.token, 127);
        assert_eq!(defmt_log.level, None);
        assert!(defmt_log.message.contains("127"), "{}", defmt_log.message);
        assert_eq!(defmt_log.args, vec!["0x44", "0x55"]);
    }

    #[test]
    fn pw_tokenizer_csv_parsing_and_formatting() {
        let mut db = TokenDatabase::new();
        let csv = r#"
# Token database comment
token,date_removed,domain,string
00000001,,"","System initialized"
00000002,,"RF","Packet received: %d bytes, rssi=%d"
"#;
        let loaded = db.parse_pw_csv(csv);
        assert_eq!(loaded, 2);
        assert_eq!(db.pw_len(), 2);

        let frame = [0x01, 0x00, 0x00, 0x00];
        let decoded = db.decode_pw(&frame).unwrap();
        assert_eq!(decoded.message, "System initialized");
        assert!(decoded.args.is_empty());
    }

    #[test]
    fn defmt_frame_with_timestamp() {
        let mut db = TokenDatabase::new();
        db.insert_defmt(1, Some("warn"), "voltage drop {:u16} mV");

        // Frame: index 1 ([0x01]), timestamp 5000 (LEB128: [0x88, 0x27]), u16 3300 ([0xE4, 0x0C])
        let frame = [0x01, 0x88, 0x27, 0xE4, 0x0C];
        let decoded = db.decode_defmt_with_timestamp(&frame).unwrap();
        assert_eq!(decoded.token, 1);
        assert_eq!(decoded.level.as_deref(), Some("warn"));
        assert_eq!(decoded.message, "[5000] voltage drop 3300 mV");
        assert_eq!(decoded.args, vec!["3300"]);
    }

    #[test]
    fn short_frame_returns_error() {
        let db = TokenDatabase::new();
        let frame = [0x01, 0x02];
        let err = db.decode_pw(&frame).unwrap_err();
        assert_eq!(err, TokenDecodeError::FrameTooShort(2));
    }
}
