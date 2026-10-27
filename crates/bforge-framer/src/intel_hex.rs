//! Intel HEX framing (F1.4.3).
//!
//! A record is one text line: `:` then two hex digits per byte, ending with a
//! checksum byte. The frame a machine emits is the line without `:` and without
//! the line ending, because that is what a decoder can re-checksum without
//! worrying about transport noise.

use crate::{ByteMachine, DEFAULT_MAX_FRAME};

/// Splits on line endings and keeps only lines that start with `:`.
#[derive(Debug, Clone)]
pub struct IntelHex {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    invalid_lines: u64,
}

impl IntelHex {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
            invalid_lines: 0,
        }
    }

    pub fn with_default_limit() -> Self {
        Self::new(DEFAULT_MAX_FRAME)
    }

    /// Lines dropped because they did not start with `:` or were too long.
    pub fn invalid_lines(&self) -> u64 {
        self.invalid_lines
    }
}

impl ByteMachine for IntelHex {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        for &byte in bytes {
            if byte != b'\n' {
                self.buffer.push(byte);
                if self.buffer.len() > self.max_frame_bytes {
                    self.invalid_lines += 1;
                    self.buffer.clear();
                }
                continue;
            }

            if self.buffer.last() == Some(&b'\r') {
                self.buffer.pop();
            }
            let line = std::mem::take(&mut self.buffer);
            match line.first() {
                Some(b':') if line.len() > 1 => frames.push(line[1..].to_vec()),
                Some(_) | None => {
                    if !line.is_empty() {
                        self.invalid_lines += 1;
                    }
                }
            }
        }
    }

    fn pending(&self) -> usize {
        self.buffer.len()
    }

    fn reset(&mut self) {
        self.buffer.clear();
    }
}

/// One decoded Intel HEX record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HexRecord {
    /// Number of data bytes in the record.
    pub byte_count: u8,
    /// Load address of the first data byte.
    pub address: u16,
    /// 0 data, 1 end of file, 2 extended segment, 4 extended linear, 5 start linear.
    pub record_type: u8,
    pub data: Vec<u8>,
    /// True when the checksum in the record matches its contents.
    pub checksum_valid: bool,
}

/// Decode one record, with or without the leading `:`.
pub fn parse_record(text: &[u8]) -> Option<HexRecord> {
    let text = text.strip_prefix(b":").unwrap_or(text);
    if text.len() < 10 || !text.len().is_multiple_of(2) {
        return None;
    }

    let mut bytes = Vec::with_capacity(text.len() / 2);
    let (pairs, _) = text.as_chunks::<2>();
    for [high, low] in pairs {
        bytes.push((hex_value(*high)? << 4) | hex_value(*low)?);
    }

    let byte_count = bytes[0] as usize;
    if bytes.len() != byte_count + 5 {
        return None;
    }
    let sum = bytes.iter().fold(0u8, |acc, byte| acc.wrapping_add(*byte));
    Some(HexRecord {
        byte_count: bytes[0],
        address: u16::from_be_bytes([bytes[1], bytes[2]]),
        record_type: bytes[3],
        data: bytes[4..4 + byte_count].to_vec(),
        checksum_valid: sum == 0,
    })
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames_of(machine: &mut dyn ByteMachine, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        machine.feed(bytes, &mut frames);
        frames
    }

    #[test]
    fn records_split_on_line_endings_and_lose_the_colon() {
        let mut machine = IntelHex::new(1024);
        let stream = b":10010000214601360121470136007EFE09D2190140\r\n:00000001FF\r\n";
        let frames = frames_of(&mut machine, stream);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], b"10010000214601360121470136007EFE09D2190140");
        assert_eq!(frames[1], b"00000001FF");
        assert_eq!(machine.invalid_lines(), 0);
    }

    #[test]
    fn a_line_without_a_colon_is_counted_and_dropped() {
        let mut machine = IntelHex::new(1024);
        assert!(frames_of(&mut machine, b"garbage\r\n").is_empty());
        assert_eq!(machine.invalid_lines(), 1);
    }

    #[test]
    fn a_record_decodes_with_a_valid_checksum() {
        let record = parse_record(b":10010000214601360121470136007EFE09D2190140").unwrap();
        assert_eq!(record.byte_count, 16);
        assert_eq!(record.address, 0x0100);
        assert_eq!(record.record_type, 0);
        assert_eq!(record.data.len(), 16);
        assert!(record.checksum_valid);

        let end = parse_record(b":00000001FF").unwrap();
        assert_eq!(end.byte_count, 0);
        assert_eq!(end.record_type, 1);
        assert!(end.checksum_valid);
    }

    #[test]
    fn a_damaged_record_reports_an_invalid_checksum() {
        let record = parse_record(b":10010000214601360121470136007EFE09D2190141").unwrap();
        assert!(!record.checksum_valid);
    }

    #[test]
    fn malformed_text_is_refused() {
        assert!(parse_record(b":10").is_none());
        assert!(parse_record(b":ZZZ").is_none());
        // Byte count says 16, the line carries 3.
        assert!(parse_record(b":10010203").is_none());
    }
}
