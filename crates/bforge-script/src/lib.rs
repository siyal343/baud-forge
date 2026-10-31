//! Fault injection and the HIL script runtime (ADR-004, FR-FLT-01, FR-SCR-01).
//!
//! Setup only: the configuration types and the hooks exist, no runtime is
//! embedded. The Lua VM is added in Milestone 4.

use bforge_dissect::DissectedFrame;

pub mod frame;
pub mod runtime;

pub use runtime::{FrameVerdict, ScriptError, ScriptRuntime};

/// Built-in fault primitives that do not need a script (FR-FLT-01).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FaultProfile {
    /// Bit error rate, `1e-9` to `1e-3`. Zero disables bit flips.
    pub bit_error_rate: f64,
    /// Drop every N-th frame, counted per channel.
    pub drop_every_nth: Option<u32>,
    /// Cut the frame after this many bytes.
    pub truncate_at: Option<usize>,
    /// Corrupt the trailing checksum byte.
    pub corrupt_checksum: bool,
    /// Synthetic delay range in milliseconds, `0` to `5000`.
    pub jitter_ms: Option<(u16, u16)>,
}

/// Result of applying a fault profile to one frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FaultOutcome {
    Forward { bytes: Vec<u8>, delay_ms: u16 },
    Drop,
}

/// Applies a [`FaultProfile`] to the frames of one channel.
#[derive(Debug, Clone, Default)]
pub struct FaultInjector {
    pub profile: FaultProfile,
}

/// Role of a two-port bridge (FR-MITM-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeMode {
    /// Two RX-only ports merged into one chronological view.
    PassiveTap,
    /// Bytes routed both ways through the fault engine.
    ActiveInline,
}

/// One side of a MITM channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    ATapA,
    BTapB,
    AToB,
    BToA,
}

/// Events the embedded Lua runtime subscribes to (FR-SCR-01).
pub enum ScriptHook<'a> {
    OnMitmFrame {
        channel: Channel,
        frame: &'a DissectedFrame,
    },
    OnAlert {
        name: &'a str,
    },
}
