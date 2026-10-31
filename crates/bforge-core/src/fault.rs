//! Fault profiles on the transmit path (FR-FLT-01, spec 0022).
//!
//! A fault is applied to the bytes just before the reader writes them, so the
//! device under test sees the corruption and the engine still knows what it meant
//! to send. Every choice comes from one seed, so a failure reproduces exactly.
//!
//! `shortcut: transmit only, byte-accurate, no jitter; the MITM bridge and a
//! delayed write are separate features`.

use serde::{Deserialize, Serialize};

/// One armed profile. Every field defaults to "do not do this".
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FaultProfile {
    /// Probability that a given byte gets a bit error, 0.0 to 1.0.
    pub flip_rate: f64,
    /// Bits flipped when a fault fires on a byte. One is a single-event upset.
    pub burst: u8,
    /// Drop every Nth byte. Zero means never.
    pub drop_every: u32,
    /// Cut this many bytes off the end of each write. Zero means never.
    pub truncate: u8,
    /// Corrupt this many bytes at the end, which is where a CRC lives.
    pub corrupt_crc: u8,
    /// Hold the write this long before it leaves, 0 to 5000 ms (D-66).
    pub delay_ms: u16,
    /// Add up to this many milliseconds, drawn from the seed, so arrival times vary
    /// instead of repeating exactly (D-91).
    pub jitter_ms: u16,
    /// Seed for every random choice, so a run reproduces.
    pub seed: u64,
}

impl Default for FaultProfile {
    fn default() -> Self {
        Self {
            flip_rate: 0.0,
            burst: 1,
            drop_every: 0,
            truncate: 0,
            corrupt_crc: 0,
            delay_ms: 0,
            jitter_ms: 0,
            seed: 0x5EED_1234_ABCD_0001,
        }
    }
}

impl FaultProfile {
    /// A single-bit-flip profile at a probability, for a radiation test.
    pub fn bit_flip(rate: f64) -> Self {
        Self {
            flip_rate: rate.clamp(0.0, 1.0),
            burst: 1,
            ..Self::default()
        }
    }

    /// True when the profile cannot change a byte.
    pub fn is_off(&self) -> bool {
        self.flip_rate <= 0.0
            && self.drop_every == 0
            && self.truncate == 0
            && self.corrupt_crc == 0
            && self.delay_ms == 0
            && self.jitter_ms == 0
    }
}

/// What one write came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FaultOutcome {
    /// Bytes actually written.
    pub sent: usize,
    /// The engine should hold the write this long (D-66).
    pub delay: Option<std::time::Duration>,
    /// Bytes changed by this profile.
    pub bytes: usize,
    /// The write was dropped entirely.
    pub dropped: bool,
}

/// An armed profile plus its counters. Deterministic for a given seed.
#[derive(Debug)]
pub struct Injector {
    profile: FaultProfile,
    state: u64,
    /// Writes this injector has seen, for the report.
    pub writes: u64,
    /// Writes it changed.
    pub touched: u64,
    /// Writes it dropped.
    pub dropped: u64,
}

impl Injector {
    pub fn new(profile: FaultProfile) -> Self {
        Self {
            state: profile.seed | 1,
            profile,
            writes: 0,
            touched: 0,
            dropped: 0,
        }
    }

    pub fn profile(&self) -> FaultProfile {
        self.profile
    }

    /// SplitMix64: small, fast and enough for a fault generator.
    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in [0, 1).
    fn chance(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// The hold for this frame: the base delay plus a draw inside the jitter span.
    fn delay(&mut self) -> Option<std::time::Duration> {
        let profile = self.profile;
        if profile.delay_ms == 0 && profile.jitter_ms == 0 {
            return None;
        }
        let extra = if profile.jitter_ms == 0 {
            0
        } else {
            (self.next() % (u64::from(profile.jitter_ms) + 1)) as u16
        };
        Some(std::time::Duration::from_millis(u64::from(
            profile.delay_ms + extra,
        )))
    }

    /// Apply the profile to what was meant to go out. `None` means the write is
    /// dropped and nothing leaves the port.
    pub fn apply(&mut self, bytes: Vec<u8>) -> Option<(Vec<u8>, FaultOutcome)> {
        self.writes += 1;
        let profile = self.profile;
        let delay = self.delay();
        if profile.is_off() {
            let sent = bytes.len();
            return Some((
                bytes,
                FaultOutcome {
                    sent,
                    delay,
                    bytes: 0,
                    dropped: false,
                },
            ));
        }

        let mut out = Vec::with_capacity(bytes.len());
        let mut changed = 0usize;
        for (index, byte) in bytes.into_iter().enumerate() {
            if profile.drop_every > 0 && (index as u32 + 1).is_multiple_of(profile.drop_every) {
                changed += 1;
                continue;
            }
            let mut value = byte;
            if profile.flip_rate > 0.0 && self.chance() < profile.flip_rate {
                for _ in 0..profile.burst.max(1) {
                    let bit = (self.next() % 8) as u32;
                    value ^= 1 << bit;
                }
                changed += 1;
            }
            out.push(value);
        }

        if profile.truncate > 0 {
            let keep = out.len().saturating_sub(profile.truncate as usize);
            changed += out.len() - keep;
            out.truncate(keep);
        }

        if profile.corrupt_crc > 0 && !out.is_empty() {
            let count = (profile.corrupt_crc as usize).min(out.len());
            for offset in 1..=count {
                let position = out.len() - offset;
                out[position] ^= 0xFF;
                changed += 1;
            }
        }

        if out.is_empty() {
            self.dropped += 1;
            return None;
        }
        if changed > 0 {
            self.touched += 1;
        }
        let sent = out.len();
        Some((
            out,
            FaultOutcome {
                sent,
                delay,
                bytes: changed,
                dropped: false,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_off_profile_changes_nothing() {
        let mut injector = Injector::new(FaultProfile::default());
        let (bytes, outcome) = injector.apply(vec![1, 2, 3, 4]).expect("sent");
        assert_eq!(bytes, vec![1, 2, 3, 4]);
        assert_eq!(outcome.bytes, 0);
        assert_eq!(injector.touched, 0);
    }

    #[test]
    fn a_certain_flip_changes_exactly_one_bit_per_byte() {
        let mut injector = Injector::new(FaultProfile {
            flip_rate: 1.0,
            burst: 1,
            ..FaultProfile::default()
        });
        let original = vec![0x00u8, 0xFF, 0xAA];
        let (bytes, outcome) = injector.apply(original.clone()).expect("sent");
        assert_eq!(bytes.len(), original.len());
        for (before, after) in original.iter().zip(&bytes) {
            let difference = before ^ after;
            assert_eq!(difference.count_ones(), 1, "{before:02X} -> {after:02X}");
        }
        assert_eq!(outcome.bytes, 3);
    }

    #[test]
    fn the_same_seed_gives_the_same_faults() {
        let profile = FaultProfile::bit_flip(0.5);
        let mut first = Injector::new(profile);
        let mut second = Injector::new(profile);
        let payload: Vec<u8> = (0..64).collect();
        let (a, _) = first.apply(payload.clone()).expect("sent");
        let (b, _) = second.apply(payload).expect("sent");
        assert_eq!(a, b);
    }

    #[test]
    fn dropping_every_second_byte_removes_half() {
        let mut injector = Injector::new(FaultProfile {
            drop_every: 2,
            ..FaultProfile::default()
        });
        let (bytes, outcome) = injector.apply(vec![1, 2, 3, 4, 5, 6]).expect("sent");
        assert_eq!(bytes, vec![1, 3, 5]);
        assert_eq!(outcome.bytes, 3);
    }

    #[test]
    fn truncation_cuts_the_end_and_a_full_truncation_drops_the_write() {
        let mut injector = Injector::new(FaultProfile {
            truncate: 2,
            ..FaultProfile::default()
        });
        let (bytes, _) = injector.apply(vec![1, 2, 3, 4, 5]).expect("sent");
        assert_eq!(bytes, vec![1, 2, 3]);

        let mut injector = Injector::new(FaultProfile {
            truncate: 9,
            ..FaultProfile::default()
        });
        assert!(injector.apply(vec![1, 2, 3]).is_none());
        assert_eq!(injector.dropped, 1);
    }

    #[test]
    fn a_jitter_span_varies_the_hold_but_stays_inside_it() {
        let profile = FaultProfile {
            delay_ms: 10,
            jitter_ms: 5,
            ..FaultProfile::default()
        };
        let mut injector = Injector::new(profile);
        let mut seen = Vec::new();
        for _ in 0..64 {
            let (_, outcome) = injector.apply(vec![1, 2, 3]).expect("sent");
            let delay = outcome.delay.expect("a hold is asked for").as_millis() as u64;
            assert!((10..=15).contains(&delay), "delay {delay} outside the span");
            seen.push(delay);
        }
        assert!(
            seen.iter().any(|delay| *delay != seen[0]),
            "every frame had the same hold: {seen:?}"
        );
    }

    #[test]
    fn the_same_seed_gives_the_same_jitter() {
        let profile = FaultProfile {
            delay_ms: 5,
            jitter_ms: 20,
            ..FaultProfile::default()
        };
        let draw = |seed| {
            let mut injector = Injector::new(FaultProfile { seed, ..profile });
            (0..16)
                .map(|_| {
                    injector
                        .apply(vec![1])
                        .expect("sent")
                        .1
                        .delay
                        .expect("held")
                        .as_millis() as u64
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(draw(7), draw(7));
        assert_ne!(draw(7), draw(8), "a different seed is a different run");
    }

    #[test]
    fn a_corrupt_crc_touches_only_the_tail() {
        let mut injector = Injector::new(FaultProfile {
            corrupt_crc: 2,
            ..FaultProfile::default()
        });
        let (bytes, outcome) = injector.apply(vec![1, 2, 3, 4, 5, 6]).expect("sent");
        assert_eq!(&bytes[..4], &[1, 2, 3, 4]);
        assert_eq!(&bytes[4..], &[5 ^ 0xFF, 6 ^ 0xFF]);
        assert_eq!(outcome.bytes, 2);
    }
}
