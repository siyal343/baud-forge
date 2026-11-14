//! SLIP framing, RFC 1055 (F1.4.3).
//!
//! `END` (0xC0) ends a frame. Inside a frame, `END` and `ESC` are sent as a pair:
//! `ESC` followed by `ESC_END` or `ESC_ESC`. A frame that holds a raw `END` byte
//! would split in two, which is why the escape exists.

use crate::{ByteMachine, DEFAULT_MAX_FRAME};

/// Frame delimiter.
pub const END: u8 = 0xC0;
/// Escape byte.
pub const ESC: u8 = 0xDB;
/// Escaped `END`.
pub const ESC_END: u8 = 0xDC;
/// Escaped `ESC`.
pub const ESC_ESC: u8 = 0xDD;

/// Splits on `END` and removes SLIP escapes.
#[derive(Debug, Clone)]
pub struct Slip {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    invalid_frames: u64,
    dropped_overlong: u64,
}

impl Slip {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
            invalid_frames: 0,
            dropped_overlong: 0,
        }
    }

    pub fn with_default_limit() -> Self {
        Self::new(DEFAULT_MAX_FRAME)
    }

    /// Frames dropped because an escape sequence was invalid.
    pub fn invalid_frames(&self) -> u64 {
        self.invalid_frames
    }

    /// Frames dropped because they grew past the limit.
    pub fn dropped_overlong(&self) -> u64 {
        self.dropped_overlong
    }
}

impl ByteMachine for Slip {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        for &byte in bytes {
            if byte == END {
                if !self.buffer.is_empty() {
                    match unescape(&self.buffer) {
                        // The limit is on the DECODED frame: escape expansion
                        // means the wire bytes can outnumber it, so a frame
                        // within the decoded limit must survive (F-26).
                        Some(frame) if !frame.is_empty() && frame.len() <= self.max_frame_bytes => {
                            frames.push(frame)
                        }
                        Some(frame) if frame.len() > self.max_frame_bytes => {
                            self.dropped_overlong += 1;
                        }
                        Some(_) => {}
                        None => self.invalid_frames += 1,
                    }
                    self.buffer.clear();
                }
                continue;
            }

            self.buffer.push(byte);
            // A SLIP-encoded frame never exceeds twice its decoded size, so
            // this wire bound cannot drop a frame the decoded limit accepts.
            if self.buffer.len() > self.max_frame_bytes.saturating_mul(2) {
                self.dropped_overlong += 1;
                self.buffer.clear();
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

/// Encode a frame as SLIP, including the trailing `END`.
pub fn slip_encode(frame: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.len() + 2);
    for &byte in frame {
        match byte {
            END => out.extend_from_slice(&[ESC, ESC_END]),
            ESC => out.extend_from_slice(&[ESC, ESC_ESC]),
            other => out.push(other),
        }
    }
    out.push(END);
    out
}

fn unescape(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        let byte = raw[index];
        index += 1;
        if byte != ESC {
            out.push(byte);
            continue;
        }
        let escaped = *raw.get(index)?;
        index += 1;
        match escaped {
            ESC_END => out.push(END),
            ESC_ESC => out.push(ESC),
            _ => return None,
        }
    }
    Some(out)
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
    fn end_splits_frames_and_empty_frames_vanish() {
        let mut machine = Slip::new(1024);
        assert_eq!(
            frames_of(&mut machine, &[b'a', b'b', END, END, b'c', END]),
            vec![b"ab".to_vec(), b"c".to_vec()]
        );
    }

    #[test]
    fn escapes_round_trip() {
        let original = vec![END, ESC, b'x', END, ESC];
        let encoded = slip_encode(&original);
        assert!(encoded[..encoded.len() - 1].iter().all(|byte| *byte != END));
        let mut machine = Slip::new(1024);
        assert_eq!(frames_of(&mut machine, &encoded), vec![original]);
    }

    #[test]
    fn a_bad_escape_costs_one_frame_not_the_stream() {
        let mut machine = Slip::new(1024);
        let mut stream = vec![b'a', ESC, b'?', END];
        stream.extend(slip_encode(b"next"));
        assert_eq!(frames_of(&mut machine, &stream), vec![b"next".to_vec()]);
        assert_eq!(machine.invalid_frames(), 1);
    }

    #[test]
    fn every_split_point_gives_the_same_frames() {
        let mut payload = slip_encode(b"one");
        payload.extend(slip_encode(b"two\xC0"));
        payload.extend(slip_encode(b"three"));
        let mut whole = Slip::new(1024);
        let expected = frames_of(&mut whole, &payload);
        assert_eq!(expected.len(), 3);
        for split in 0..=payload.len() {
            let mut machine = Slip::new(1024);
            let mut frames = Vec::new();
            machine.feed(&payload[..split], &mut frames);
            machine.feed(&payload[split..], &mut frames);
            assert_eq!(frames, expected, "split at {split}");
        }
    }

    #[test]
    fn an_overlong_frame_is_dropped_and_counted() {
        // The limit is on the decoded frame: 12 bytes exceed the 8-byte limit
        // even though they carry no escapes.
        let mut stream = vec![7u8; 12];
        stream.push(END);
        let mut machine = Slip::new(8);
        assert!(frames_of(&mut machine, &stream).is_empty());
        assert_eq!(machine.dropped_overlong(), 1);
    }

    #[test]
    fn escape_expansion_does_not_drop_a_frame_within_the_decoded_limit() {
        // Nine END bytes encode to 18 wire bytes for a 13-byte frame; the old
        // bound counted wire bytes against the decoded limit, dropped the
        // frame, then unescaped the surviving tail into a bogus one (F-26).
        let decoded: Vec<u8> = std::iter::once(b'A')
            .chain(std::iter::repeat(END).take(9))
            .chain([b'B', b'C', b'D'])
            .collect();
        let encoded = slip_encode(&decoded);
        let mut machine = Slip::new(16);
        assert_eq!(frames_of(&mut machine, &encoded), vec![decoded]);
        assert_eq!(machine.dropped_overlong(), 0);
    }
}
