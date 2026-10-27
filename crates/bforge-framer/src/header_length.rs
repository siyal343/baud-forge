//! Sync-word and length framing (F1.4.4).
//!
//! The machine hunts for a sync word, reads the length field that follows it, and
//! takes exactly that many bytes. A length that cannot be true is a resync, not a
//! crash, because a corrupted length must not be allowed to eat the stream.

use crate::{ByteMachine, DEFAULT_MAX_FRAME, LengthWidth};

/// Sync word, length field, and total-length adjustment.
#[derive(Debug, Clone)]
pub struct HeaderLength {
    sync: Vec<u8>,
    length_offset: usize,
    width: LengthWidth,
    /// Added to the length value to get the whole frame, sync word included.
    adjust: i32,
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    resyncs: u64,
}

impl HeaderLength {
    pub fn new(
        sync: Vec<u8>,
        length_offset: u8,
        width: LengthWidth,
        adjust: i32,
        max_frame_bytes: usize,
    ) -> Self {
        assert!(!sync.is_empty(), "a sync word cannot be empty");
        Self {
            sync,
            length_offset: usize::from(length_offset),
            width,
            adjust,
            buffer: Vec::new(),
            max_frame_bytes,
            resyncs: 0,
        }
    }

    /// Frames abandoned because the length field pointed outside the stream.
    pub fn resyncs(&self) -> u64 {
        self.resyncs
    }

    fn width_bytes(&self) -> usize {
        match self.width {
            LengthWidth::U8 => 1,
            LengthWidth::U16Le | LengthWidth::U16Be => 2,
            LengthWidth::U32Le => 4,
        }
    }

    /// Total frame size according to the length field, or `None` when impossible.
    fn total_len(&self) -> Option<usize> {
        let field_at = self.length_offset;
        let end = field_at.checked_add(self.width_bytes())?;
        if self.buffer.len() < end {
            return None;
        }
        let raw = match self.width {
            LengthWidth::U8 => u32::from(self.buffer[field_at]),
            LengthWidth::U16Le => u32::from(u16::from_le_bytes([
                self.buffer[field_at],
                self.buffer[field_at + 1],
            ])),
            LengthWidth::U16Be => u32::from(u16::from_be_bytes([
                self.buffer[field_at],
                self.buffer[field_at + 1],
            ])),
            LengthWidth::U32Le => u32::from_le_bytes([
                self.buffer[field_at],
                self.buffer[field_at + 1],
                self.buffer[field_at + 2],
                self.buffer[field_at + 3],
            ]),
        };
        let total = i64::from(raw) + i64::from(self.adjust);
        if total <= 0 || total > self.max_frame_bytes as i64 {
            return None;
        }
        Some(total as usize)
    }

    /// Drop bytes until the buffer starts with the sync word, or is too short to
    /// judge. Returns true when the buffer is aligned.
    fn align(&mut self) -> bool {
        if let Some(position) = find(&self.buffer, &self.sync) {
            if position > 0 {
                self.buffer.drain(..position);
            }
            true
        } else {
            // Keep the tail: the sync word may straddle two feeds.
            let keep = self.sync.len().saturating_sub(1).min(self.buffer.len());
            let drop = self.buffer.len() - keep;
            self.buffer.drain(..drop);
            false
        }
    }
}

impl ByteMachine for HeaderLength {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        self.buffer.extend_from_slice(bytes);

        loop {
            if !self.align() {
                return;
            }
            let Some(total) = self.total_len() else {
                // Either the length field is not here yet, or the value is absurd.
                if self.buffer.len() >= self.length_offset + self.width_bytes() {
                    self.resyncs += 1;
                    self.buffer.drain(..1);
                    continue;
                }
                return;
            };
            if self.buffer.len() < total {
                return;
            }
            let frame: Vec<u8> = self.buffer.drain(..total).collect();
            frames.push(frame);
        }
    }

    fn pending(&self) -> usize {
        self.buffer.len()
    }

    fn reset(&mut self) {
        self.buffer.clear();
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Build the machine a `.bforge.toml` port asks for.
pub fn header_length_default(sync: impl Into<Vec<u8>>) -> HeaderLength {
    // Sync word at 0, length at 2 as a big-endian u16 counting the payload only.
    HeaderLength::new(sync.into(), 2, LengthWidth::U16Be, 4, DEFAULT_MAX_FRAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames_of(machine: &mut dyn ByteMachine, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        machine.feed(bytes, &mut frames);
        frames
    }

    /// Sync AA 55, length u8 at offset 2 counting payload only, so total = len + 3.
    fn machine() -> HeaderLength {
        HeaderLength::new(vec![0xAA, 0x55], 2, LengthWidth::U8, 3, 1024)
    }

    #[test]
    fn frames_split_on_the_length_field() {
        let mut machine = machine();
        let stream = [0xAA, 0x55, 2, 0x01, 0x02, 0xAA, 0x55, 1, 0x03];
        assert_eq!(
            frames_of(&mut machine, &stream),
            vec![vec![0xAA, 0x55, 2, 0x01, 0x02], vec![0xAA, 0x55, 1, 0x03],]
        );
        assert_eq!(machine.resyncs(), 0);
    }

    #[test]
    fn a_frame_split_across_feeds_is_reassembled() {
        let mut machine = machine();
        let stream = [0xAA, 0x55, 2, 0x01, 0x02, 0xAA, 0x55, 1, 0x03];
        let mut frames = Vec::new();
        for byte in stream {
            machine.feed(&[byte], &mut frames);
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(machine.pending(), 0);
    }

    #[test]
    fn noise_before_the_sync_word_is_discarded() {
        let mut machine = machine();
        let mut stream = vec![0x00, 0x11, 0x22];
        stream.extend([0xAA, 0x55, 1, 0x09]);
        assert_eq!(
            frames_of(&mut machine, &stream),
            vec![vec![0xAA, 0x55, 1, 0x09]]
        );
    }

    #[test]
    fn an_impossible_length_triggers_a_resync() {
        let mut machine = machine();
        // Length 200 with a limit of 1024 is allowed, so use a limit that refuses it.
        let mut small = HeaderLength::new(vec![0xAA, 0x55], 2, LengthWidth::U8, 3, 64);
        let stream = [0xAA, 0x55, 200, 0x00, 0xAA, 0x55, 1, 0x09];
        let frames = frames_of(&mut small, &stream);
        assert_eq!(frames, vec![vec![0xAA, 0x55, 1, 0x09]]);
        assert!(small.resyncs() >= 1);
        // The original machine with room to spare would still hold the 203 bytes.
        assert!(frames_of(&mut machine, &stream).is_empty());
    }

    #[test]
    fn u16_and_u32_lengths_read_in_the_right_order() {
        let mut little = HeaderLength::new(vec![0x7E], 1, LengthWidth::U16Le, 3, 64);
        let stream = [0x7E, 0x02, 0x00, 0x31, 0x32];
        assert_eq!(frames_of(&mut little, &stream), vec![stream.to_vec()]);

        let mut big = HeaderLength::new(vec![0x7E], 1, LengthWidth::U16Be, 3, 64);
        let stream = [0x7E, 0x00, 0x02, 0x31, 0x32];
        assert_eq!(frames_of(&mut big, &stream), vec![stream.to_vec()]);

        let mut word = HeaderLength::new(vec![0x7E], 1, LengthWidth::U32Le, 5, 64);
        let stream = [0x7E, 0x02, 0x00, 0x00, 0x00, 0x31, 0x32];
        assert_eq!(frames_of(&mut word, &stream), vec![stream.to_vec()]);
    }

    #[test]
    fn the_default_helper_agrees_with_its_documented_layout() {
        let mut machine = header_length_default([0xCA, 0xFE]);
        // Sync, u16 big-endian payload length 2, then two payload bytes.
        let stream = [0xCA, 0xFE, 0x00, 0x02, 0x42, 0x43];
        assert_eq!(frames_of(&mut machine, &stream), vec![stream.to_vec()]);
    }
}
