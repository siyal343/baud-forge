//! Byte machines (F1.4.1, F1.4.2): bytes in, complete frames out.
//!
//! A machine keeps the bytes of an unfinished frame between calls, so the caller
//! can hand it whatever the transport returned. Splitting the input at any
//! boundary must not change the frames, which the tests assert.

/// Anything that turns a byte stream into frames.
pub trait ByteMachine {
    /// Consume bytes and push every frame completed by this call.
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>);

    /// Bytes held back, waiting for the rest of a frame.
    fn pending(&self) -> usize;

    /// Drop partial data, for example after a reconnect or a settings change.
    fn reset(&mut self);
}

/// Why a framing mode could not be built from the configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    UnsupportedMode(String),
    MissingDelimiter,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedMode(mode) => write!(f, "framing mode `{mode}` is not supported yet"),
            Self::MissingDelimiter => write!(f, "framing mode `delimiter` needs a delimiter"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Build the machine named by a port configuration.
///
/// Modes not listed here belong to F1.4.3 to F1.4.5 and return
/// [`FrameError::UnsupportedMode`], so a configuration cannot silently fall back
/// to a mode the user did not ask for.
pub fn machine_for(
    mode: &str,
    delimiter: Option<&[u8]>,
    max_frame_bytes: usize,
) -> Result<Box<dyn ByteMachine>, FrameError> {
    match mode {
        "delimiter" => {
            let delimiter = delimiter.ok_or(FrameError::MissingDelimiter)?;
            Ok(Box::new(Delimiter::new(delimiter, max_frame_bytes)))
        }
        "cobs" => Ok(Box::new(Cobs::new(max_frame_bytes))),
        other => Err(FrameError::UnsupportedMode(other.to_string())),
    }
}

/// Splits on a single or multi-byte delimiter and drops the delimiter.
#[derive(Debug, Clone)]
pub struct Delimiter {
    delimiter: Vec<u8>,
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    dropped_overlong: u64,
}

impl Delimiter {
    pub fn new(delimiter: impl Into<Vec<u8>>, max_frame_bytes: usize) -> Self {
        let delimiter = delimiter.into();
        assert!(!delimiter.is_empty(), "a delimiter cannot be empty");
        Self {
            delimiter,
            buffer: Vec::new(),
            max_frame_bytes,
            dropped_overlong: 0,
        }
    }

    /// Frames dropped because they grew past the limit.
    pub fn dropped_overlong(&self) -> u64 {
        self.dropped_overlong
    }
}

impl ByteMachine for Delimiter {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        for &byte in bytes {
            self.buffer.push(byte);

            if self.buffer.ends_with(&self.delimiter) {
                let frame_len = self.buffer.len() - self.delimiter.len();
                if frame_len > 0 {
                    let mut frame = std::mem::take(&mut self.buffer);
                    frame.truncate(frame_len);
                    frames.push(frame);
                }
                self.buffer.clear();
                continue;
            }

            if self.buffer.len() > self.max_frame_bytes {
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

/// Splits on the zero byte, then removes COBS encoding.
#[derive(Debug, Clone)]
pub struct Cobs {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    dropped_overlong: u64,
    invalid_blocks: u64,
}

impl Cobs {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
            dropped_overlong: 0,
            invalid_blocks: 0,
        }
    }

    /// Blocks that were not valid COBS.
    pub fn invalid_blocks(&self) -> u64 {
        self.invalid_blocks
    }

    /// Blocks dropped because they grew past the limit.
    pub fn dropped_overlong(&self) -> u64 {
        self.dropped_overlong
    }
}

impl ByteMachine for Cobs {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        for &byte in bytes {
            if byte == 0 {
                if !self.buffer.is_empty() {
                    match cobs_decode(&self.buffer) {
                        Some(frame) if !frame.is_empty() => frames.push(frame),
                        Some(_) => {}
                        None => self.invalid_blocks += 1,
                    }
                    self.buffer.clear();
                }
                continue;
            }

            self.buffer.push(byte);
            if self.buffer.len() > self.max_frame_bytes + self.max_frame_bytes / 254 + 1 {
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

/// COBS decode one block, delimiter excluded. `None` means the block is invalid.
///
/// The code byte gives the distance to the next zero byte, plus one. A code of
/// 0xFF means the block continued for 254 bytes and no zero was removed.
pub fn cobs_decode(encoded: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        let code = encoded[index] as usize;
        index += 1;
        if code == 0 {
            return None;
        }
        let end = index + code - 1;
        if end > encoded.len() {
            return None;
        }
        out.extend_from_slice(&encoded[index..end]);
        index = end;
        if code != 0xFF && index < encoded.len() {
            out.push(0);
        }
    }
    Some(out)
}

/// COBS encode, delimiter excluded. The frame must not contain a zero byte.
pub fn cobs_encode(frame: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.len() + frame.len() / 254 + 1);
    let mut start = 0;
    while start <= frame.len() {
        let mut zero = start;
        while zero < frame.len() && frame[zero] != 0 && zero - start < 254 {
            zero += 1;
        }
        out.push((zero - start + 1) as u8);
        out.extend_from_slice(&frame[start..zero]);
        start = if zero < frame.len() && frame[zero] == 0 {
            zero + 1
        } else {
            zero
        };
        if zero == frame.len() {
            break;
        }
    }
    out
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
    fn delimiter_splits_across_calls() {
        let mut machine = Delimiter::new(b"\n".to_vec(), 1024);
        assert!(frames_of(&mut machine, b"hel").is_empty());
        assert_eq!(machine.pending(), 3);
        assert_eq!(
            frames_of(&mut machine, b"lo\nnext\n"),
            vec![b"hello".to_vec(), b"next".to_vec()]
        );
        assert_eq!(machine.pending(), 0);
    }

    #[test]
    fn multi_byte_delimiter_is_removed() {
        let mut machine = Delimiter::new(b"\r\n".to_vec(), 1024);
        assert!(frames_of(&mut machine, b"a\r").is_empty());
        assert_eq!(
            frames_of(&mut machine, b"\nb\r\n"),
            vec![b"a".to_vec(), b"b".to_vec()]
        );
    }

    #[test]
    fn empty_frames_and_overlong_frames_are_dropped() {
        let mut machine = Delimiter::new(b"\n".to_vec(), 8);
        assert_eq!(frames_of(&mut machine, b"\n\nok\n"), vec![b"ok".to_vec()]);
        assert!(frames_of(&mut machine, b"0123456789").is_empty());
        assert_eq!(machine.dropped_overlong(), 1);
        // The byte after the drop starts a new frame and waits for its delimiter.
        assert_eq!(machine.pending(), 1);
    }

    #[test]
    fn cobs_decodes_rfc_style_vectors() {
        assert_eq!(cobs_decode(&[0x01]), Some(vec![]));
        assert_eq!(cobs_decode(&[0x01, 0x01]), Some(vec![0]));
        assert_eq!(
            cobs_decode(&[0x06, b'1', b'2', b'3', b'4', b'5']),
            Some(b"12345".to_vec())
        );
        assert_eq!(
            cobs_decode(&[0x03, 0x11, 0x22, 0x02, 0x33]),
            Some(vec![0x11, 0x22, 0x00, 0x33])
        );
        assert_eq!(cobs_decode(&[0x00, 0x01]), None);
        assert_eq!(cobs_decode(&[0x03, 0x11]), None);
    }

    #[test]
    fn cobs_round_trips_including_the_254_byte_run() {
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0],
            vec![1, 2, 3],
            vec![0, 0, 0],
            vec![0x11, 0x22, 0x00, 0x33],
            (0..=255u8).cycle().take(300).collect(),
            vec![0xAA; 254],
            vec![0xAA; 255],
        ];
        for case in cases {
            let encoded = cobs_encode(&case);
            assert!(
                !encoded.contains(&0),
                "an encoded frame must not contain a zero byte"
            );
            assert_eq!(cobs_decode(&encoded), Some(case.clone()), "case {case:?}");
        }
    }

    #[test]
    fn cobs_machine_splits_on_zero_and_decodes() {
        let mut machine = Cobs::new(4096);
        let mut stream = cobs_encode(b"first");
        stream.push(0);
        stream.extend(cobs_encode(b"second"));
        stream.push(0);

        assert_eq!(
            frames_of(&mut machine, &stream),
            vec![b"first".to_vec(), b"second".to_vec()]
        );
        assert_eq!(machine.invalid_blocks(), 0);
    }

    #[test]
    fn cobs_machine_counts_an_invalid_block() {
        let mut machine = Cobs::new(4096);
        assert!(frames_of(&mut machine, &[0x05, 0x01, 0x00]).is_empty());
        assert_eq!(machine.invalid_blocks(), 1);
    }

    #[test]
    fn every_split_point_gives_the_same_frames() {
        let payload = b"alpha\nbeta\ngamma\n";
        let mut whole = Delimiter::new(b"\n".to_vec(), 1024);
        let expected = frames_of(&mut whole, payload);

        for split in 0..=payload.len() {
            let mut machine = Delimiter::new(b"\n".to_vec(), 1024);
            let mut frames = Vec::new();
            machine.feed(&payload[..split], &mut frames);
            machine.feed(&payload[split..], &mut frames);
            assert_eq!(frames, expected, "split at {split}");
        }
    }

    #[test]
    fn the_factory_names_only_the_implemented_modes() {
        assert!(machine_for("delimiter", Some(b"\n"), 1024).is_ok());
        assert!(machine_for("cobs", None, 1024).is_ok());
        assert_eq!(
            machine_for("delimiter", None, 1024).err(),
            Some(FrameError::MissingDelimiter)
        );
        assert_eq!(
            machine_for("slip", None, 1024).err(),
            Some(FrameError::UnsupportedMode("slip".to_string()))
        );
    }
}
