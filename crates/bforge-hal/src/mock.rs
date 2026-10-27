//! Mock transport and PRBS-31 source (F1.1.6).
//!
//! Used by unit tests and by the stress harness. The first 8 bytes of every
//! block carry a little-endian chunk sequence, so a consumer can prove that no
//! block was lost. The rest of the block is PRBS-31, so a gap is detectable from
//! the payload alone.

use crate::{PinStateFlags, PortState, TransportDriver, TransportError};
use std::time::Instant;

/// n-bit pseudo-random bit sequence, polynomial x^31 + x^28 + 1.
#[derive(Debug, Clone)]
pub struct Prbs31 {
    state: u32,
}

impl Prbs31 {
    /// The seed must not be zero, because zero is the lock-up state.
    pub fn new(seed: u32) -> Self {
        assert!(seed != 0, "PRBS-31 seed must not be zero");
        Self {
            state: seed & 0x7fff_ffff,
        }
    }

    pub fn next_bit(&mut self) -> u8 {
        let bit = ((self.state >> 30) ^ (self.state >> 27)) & 1;
        self.state = ((self.state << 1) | bit) & 0x7fff_ffff;
        bit as u8
    }

    pub fn next_byte(&mut self) -> u8 {
        let mut byte = 0u8;
        for _ in 0..8 {
            byte = (byte << 1) | self.next_bit();
        }
        byte
    }

    pub fn fill(&mut self, out: &mut [u8]) {
        for slot in out {
            *slot = self.next_byte();
        }
    }
}

/// A transport that invents bytes at a fixed rate.
///
/// A rate of 0 means "as fast as the caller asks", which keeps unit tests quick.
/// A paced transport holds bytes back until `min_block` of them are due, which
/// keeps the slab count realistic; a slow consumer then gets one large block
/// instead of many small ones, so the byte count still matches `rate × elapsed`.
#[derive(Debug)]
pub struct MockTransport {
    rate_bytes_per_sec: u64,
    started: Instant,
    emitted: u64,
    seq: u64,
    prbs: Prbs31,
    state: PortState,
    pins: PinStateFlags,
    written: u64,
    min_block: usize,
}

impl MockTransport {
    pub fn new(rate_bytes_per_sec: u64) -> Self {
        Self::with_seed(rate_bytes_per_sec, 0x7fff_fffe)
    }

    pub fn with_seed(rate_bytes_per_sec: u64, seed: u32) -> Self {
        Self {
            rate_bytes_per_sec,
            started: Instant::now(),
            emitted: 0,
            seq: 0,
            prbs: Prbs31::new(seed),
            state: PortState::Closed,
            pins: PinStateFlags::CTS,
            written: 0,
            min_block: 4096,
        }
    }

    /// Number of blocks produced since `open`.
    pub fn blocks(&self) -> u64 {
        self.seq
    }

    /// Bytes handed to the caller since `open`.
    pub fn emitted(&self) -> u64 {
        self.emitted
    }

    /// Bytes handed to `write_frame` since `open`.
    pub fn written(&self) -> u64 {
        self.written
    }
}

impl TransportDriver for MockTransport {
    fn open(&mut self) -> Result<(), TransportError> {
        self.state = PortState::Open;
        self.started = Instant::now();
        self.emitted = 0;
        Ok(())
    }

    fn close(&mut self) {
        self.state = PortState::Closed;
    }

    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError> {
        if self.state != PortState::Open {
            return Err(TransportError::NotOpen);
        }

        let want = if self.rate_bytes_per_sec == 0 {
            out.len() as u64
        } else {
            let due =
                self.started.elapsed().as_nanos() as u64 * self.rate_bytes_per_sec / 1_000_000_000;
            let pending = due.saturating_sub(self.emitted);
            if pending < self.min_block as u64 {
                return Ok(0);
            }
            pending
        };
        let len = want.min(out.len() as u64) as usize;
        if len == 0 {
            return Ok(0);
        }

        let body = if len >= 8 {
            out[..8].copy_from_slice(&self.seq.to_le_bytes());
            self.seq += 1;
            8
        } else {
            0
        };
        self.prbs.fill(&mut out[body..len]);
        self.emitted += len as u64;
        Ok(len)
    }

    fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError> {
        self.written += frame.len() as u64;
        Ok(())
    }

    fn set_pins(&mut self, pins: PinStateFlags) -> Result<(), TransportError> {
        self.pins = pins;
        Ok(())
    }

    fn read_pins(&self) -> Result<PinStateFlags, TransportError> {
        Ok(self.pins)
    }

    fn state(&self) -> PortState {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_is_deterministic_for_a_seed() {
        let mut a = Prbs31::new(0x1234_5678);
        let mut b = Prbs31::new(0x1234_5678);
        let mut c = Prbs31::new(0x1234_5679);
        let (mut left, mut right, mut other) = ([0u8; 256], [0u8; 256], [0u8; 256]);
        a.fill(&mut left);
        b.fill(&mut right);
        c.fill(&mut other);
        assert_eq!(left, right);
        assert_ne!(left, other);
    }

    #[test]
    fn the_sequence_does_not_lock_up_or_flatten() {
        let mut prbs = Prbs31::new(1);
        let mut ones = 0u32;
        for _ in 0..1_000_000 {
            ones += prbs.next_bit() as u32;
        }
        assert_ne!(prbs.next_bit(), 2, "the register must keep a valid state");
        // A locked or flattened generator lands far outside this band.
        let ratio = ones as f64 / 1_000_000.0;
        assert!((0.45..=0.55).contains(&ratio), "ratio {ratio}");
    }

    #[test]
    fn block_carries_its_sequence_in_the_first_eight_bytes() {
        let mut transport = MockTransport::new(0);
        transport.open().unwrap();
        let mut buf = vec![0u8; 4096];
        for expected in 0..3u64 {
            let len = transport.read_slab(&mut buf).unwrap();
            assert_eq!(len, 4096);
            let seq = u64::from_le_bytes(buf[..8].try_into().unwrap());
            assert_eq!(seq, expected);
        }
        assert_eq!(transport.blocks(), 3);
        assert_eq!(transport.emitted(), 3 * 4096);
    }

    #[test]
    fn paced_transport_delivers_the_configured_rate() {
        let mut transport = MockTransport::new(1_000_000);
        transport.open().unwrap();
        let mut buf = vec![0u8; 64 * 1024];

        let started = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut total = 0usize;
        for _ in 0..3 {
            total += transport.read_slab(&mut buf).unwrap();
        }
        let elapsed = started.elapsed().as_secs_f64();
        let expected = 1_000_000.0 * elapsed;
        let tolerance = expected * 0.2 + 8.0;
        assert!(
            (total as f64 - expected).abs() <= tolerance,
            "read {total} bytes in {elapsed:.4} s, expected about {expected:.0}"
        );
    }

    #[test]
    fn reads_require_an_open_port() {
        let mut transport = MockTransport::new(0);
        let mut buf = vec![0u8; 64];
        assert_eq!(transport.read_slab(&mut buf), Err(TransportError::NotOpen));
    }
}
