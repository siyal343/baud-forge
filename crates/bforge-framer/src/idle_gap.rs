//! Idle-gap framing (F1.4.5).
//!
//! A Modbus RTU frame ends when the line has been quiet for 3.5 character times.
//! That makes the boundary a function of time, not of a byte, so the machine takes
//! its clock from the caller: `tick` advances it and `feed` never reads a clock of
//! its own. A test can therefore decide exactly when the bus went quiet.

use crate::{ByteMachine, DEFAULT_MAX_FRAME};

/// Splits a stream where silence exceeds a gap.
#[derive(Debug, Clone)]
pub struct IdleGap {
    gap_ns: u64,
    buffer: Vec<u8>,
    last_ns: Option<u64>,
    /// Bytes that arrived since the previous tick.
    bytes_since_tick: usize,
    /// When the last byte of that interval is taken to have arrived.
    last_byte_ns: Option<u64>,
    max_frame_bytes: usize,
    dropped_overlong: u64,
}

impl IdleGap {
    pub fn new(gap_ns: u64, max_frame_bytes: usize) -> Self {
        assert!(gap_ns > 0, "an idle gap must be longer than zero");
        Self {
            gap_ns,
            buffer: Vec::new(),
            last_ns: None,
            bytes_since_tick: 0,
            last_byte_ns: None,
            max_frame_bytes,
            dropped_overlong: 0,
        }
    }

    /// The gap for a UART setting: 3.5 character times, rounded up to a
    /// nanosecond. One character is a start bit, the data bits, a parity bit when
    /// there is one, and the stop bits.
    pub fn for_uart(baud_rate: u32, bits_per_char: u32) -> Self {
        assert!(baud_rate > 0, "baud rate must be positive");
        let char_ns = 1_000_000_000u64 / u64::from(baud_rate) * u64::from(bits_per_char.max(1));
        Self::new(char_ns * 35 / 10, DEFAULT_MAX_FRAME)
    }

    pub fn gap_ns(&self) -> u64 {
        self.gap_ns
    }

    pub fn dropped_overlong(&self) -> u64 {
        self.dropped_overlong
    }

    /// Advance the clock. Call this before `feed` for every slab.
    ///
    /// A tick that follows an interval with bytes records the last byte as
    /// arriving now. A tick that follows silence of at least one gap emits the
    /// frame, so detection lags the real silence by at most one tick.
    pub fn tick_at(&mut self, now_ns: u64, frames: &mut Vec<Vec<u8>>) {
        if self.bytes_since_tick > 0 {
            self.last_byte_ns = Some(now_ns);
            self.bytes_since_tick = 0;
        } else if let Some(last_byte) = self.last_byte_ns {
            let quiet = now_ns.saturating_sub(last_byte);
            if quiet >= self.gap_ns && !self.buffer.is_empty() {
                frames.push(std::mem::take(&mut self.buffer));
            }
        }
        self.last_ns = Some(now_ns);
    }
}

impl ByteMachine for IdleGap {
    fn feed(&mut self, bytes: &[u8], frames: &mut Vec<Vec<u8>>) {
        if bytes.is_empty() {
            return;
        }
        self.buffer.extend_from_slice(bytes);
        self.bytes_since_tick += bytes.len();
        if self.buffer.len() > self.max_frame_bytes {
            self.dropped_overlong += 1;
            self.buffer.clear();
        }
        let _ = frames;
    }

    fn tick(&mut self, now_ns: u64, frames: &mut Vec<Vec<u8>>) {
        self.tick_at(now_ns, frames);
    }

    fn pending(&self) -> usize {
        self.buffer.len()
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.last_ns = None;
        self.bytes_since_tick = 0;
        self.last_byte_ns = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_longer_than_the_gap_ends_a_frame() {
        let mut machine = IdleGap::new(1_000_000, 1024);
        let mut frames = Vec::new();

        machine.tick_at(0, &mut frames);
        machine.feed(b"abc", &mut frames);
        // The tick that sees bytes records the last byte and emits nothing.
        machine.tick_at(500_000, &mut frames);
        assert!(frames.is_empty());

        machine.tick_at(1_000_000, &mut frames);
        assert!(frames.is_empty(), "0.5 ms of quiet is not a gap");

        machine.tick_at(1_500_000, &mut frames);
        assert_eq!(frames, vec![b"abc".to_vec()]);
        assert_eq!(machine.pending(), 0);
    }

    #[test]
    fn bytes_after_the_gap_start_a_new_frame() {
        let mut machine = IdleGap::new(1_000, 1024);
        let mut frames = Vec::new();
        machine.tick_at(0, &mut frames);
        machine.feed(b"a", &mut frames);
        machine.tick_at(5_000, &mut frames);
        machine.tick_at(7_000, &mut frames);
        assert_eq!(frames, vec![b"a".to_vec()]);

        machine.feed(b"b", &mut frames);
        machine.tick_at(8_000, &mut frames);
        assert_eq!(machine.pending(), 1);
    }

    #[test]
    fn a_gap_with_no_data_emits_nothing() {
        let mut machine = IdleGap::new(1_000, 1024);
        let mut frames = Vec::new();
        machine.tick_at(0, &mut frames);
        machine.tick_at(10_000, &mut frames);
        machine.tick_at(20_000, &mut frames);
        assert!(frames.is_empty());
    }

    #[test]
    fn the_gap_comes_from_the_line_settings() {
        // 115200 baud, 10 bits per character: 86.8 us per character, so 3.5
        // characters is 303.8 us. The arithmetic truncates each step.
        let machine = IdleGap::for_uart(115_200, 10);
        assert_eq!(machine.gap_ns(), 303_800);
        // 9600 baud, 11 bits with parity: 1.145826 ms per character.
        let machine = IdleGap::for_uart(9_600, 11);
        assert_eq!(machine.gap_ns(), 4_010_391);
    }

    #[test]
    fn an_overlong_run_is_dropped() {
        let mut machine = IdleGap::new(1_000, 8);
        let mut frames = Vec::new();
        machine.tick_at(0, &mut frames);
        machine.feed(&[1u8; 12], &mut frames);
        assert_eq!(machine.dropped_overlong(), 1);
        machine.tick_at(9_999, &mut frames);
        assert!(frames.is_empty());
    }
}
