//! The engine state contract and event bus.
//!
//! Every state the engine publishes comes from here. External clients and the
//! headless CLI read the same types, so a counter cannot mean one thing on
//! a dashboard and another in CI.
//!
//! The contract version is fixed at 1. Add a field freely; change the meaning of
//! a field only with a new version.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};

/// Version of the snapshot and event format.
pub const CONTRACT_VERSION: u32 = 1;

/// Everything the window needs to draw one frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiSnapshot {
    pub contract: u32,
    pub session: SessionView,
    pub ports: Vec<PortView>,
    /// Port pairs joined by the engine (spec 0025).
    pub bridges: Vec<BridgeView>,
    pub transfers: Vec<TransferView>,
    /// Armed Lua 5.4 script status and telemetry, or `null` when disarmed.
    #[serde(default)]
    pub script: Option<ScriptStatusView>,
}

/// One bridge, as the ribbon draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeView {
    pub id: String,
    pub a: String,
    pub b: String,
    /// Bytes are written from one side to the other.
    pub forward: bool,
    /// Bytes forwarded so far, both directions.
    pub forwarded: u64,
    /// Bytes the bridge refused because the destination was too far behind.
    pub dropped: u64,
}

/// One live X/YMODEM transfer, as the transfer panel polls it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferView {
    pub port: String,
    pub name: String,
    /// `send` or `recv`.
    pub direction: String,
    /// `handshake`, `transferring`, `finishing`, `done` or `failed:reason`.
    pub phase: String,
    pub block: u32,
    pub total_blocks: u32,
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub retries: u32,
}

/// Session-level state: the mode strip, the vault line and the footer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionView {
    /// `idle`, `record` or `replay`.
    pub mode: String,
    /// Path of the vault, empty when nothing is recording.
    pub vault: String,
    pub file_bytes: u64,
    pub chunks: u64,
    pub payload_bytes: u64,
    pub elapsed_ms: u64,
    pub started_epoch_ns: u64,
    /// Firmware image used for symbolization, when configured.
    pub elf: Option<String>,
}

/// Port-level state: the hardware ribbon and the sidebar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortView {
    pub id: String,
    pub device: String,
    pub baud_rate: u32,
    /// Framing mode name, for example `cobs`.
    pub framing: String,
    pub checksum: Option<String>,
    /// `closed`, `open`, `reconnecting` or `yielded`.
    pub state: String,
    pub pins: PinsView,
    pub chunks: u64,
    pub bytes: u64,
    /// Slabs dropped because a non-logger consumer was full.
    pub overruns: u64,
    pub stalls_ms: f64,
    pub read_errors: u64,
}

/// The pin matrix: the inputs a line reports, and the outputs this session drove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PinsView {
    pub cts: bool,
    pub dsr: bool,
    pub dcd: bool,
    pub ri: bool,
    pub break_state: bool,
    pub framing_error: bool,
    pub parity_error: bool,
    /// DTR as this session drove it, not as the far end reports it.
    pub dtr: bool,
    /// RTS as this session drove it.
    pub rts: bool,
}

/// One change, in the order it happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UiEvent {
    Started {
        at_ms: u64,
        ports: usize,
        vault: String,
    },
    Stats {
        at_ms: u64,
        chunks: u64,
        payload_bytes: u64,
        /// Overruns for the port with the highest count.
        overruns: u64,
        /// Chunks per second since the previous stats event.
        chunks_per_sec: u64,
    },
    PortStateChanged {
        at_ms: u64,
        port: String,
        /// `closed`, `open`, `reconnecting` or `yielded`.
        state: String,
    },
    Overrun {
        at_ms: u64,
        port: String,
        total: u64,
    },
    DamagedTail {
        at_ms: u64,
        port: String,
    },
    Stopped {
        at_ms: u64,
        chunks: u64,
        payload_bytes: u64,
    },
    /// X/YMODEM transfer progress (spec 2.7).
    Transfer {
        at_ms: u64,
        port: String,
        name: String,
        /// `handshake`, `transferring`, `finishing`, `done` or `failed:reason`.
        phase: String,
        block: u32,
        total_blocks: u32,
        bytes_done: u64,
    },
}

/// One script assertion entry reported in script status and dry-run views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptAssertionView {
    pub name: String,
    pub passed: u64,
    pub failed: u64,
    pub last_error: Option<String>,
}

/// Live telemetry for the armed Lua 5.4 script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptStatusView {
    pub armed: bool,
    pub name: String,
    /// `"fail_open"` or `"fail_closed"`.
    pub policy: String,
    pub hooks: Vec<String>,
    pub invocations: u64,
    pub changed: u64,
    pub dropped: u64,
    pub delayed: u64,
    pub injected_tx: u64,
    pub failures: u64,
    pub logs_suppressed: u64,
    pub assertions_passed: u64,
    pub assertions_failed: u64,
    pub memory_bytes: usize,
    pub memory_limit_bytes: usize,
    pub last_instructions: u32,
    pub last_exec_us: u64,
    pub max_exec_us: u64,
    pub last_error: Option<String>,
    pub metrics: BTreeMap<String, String>,
    pub assertions: Vec<ScriptAssertionView>,
}

/// Field-level difference produced by a script hook during a dry run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptFieldDiffView {
    pub name: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Queued side-effect action emitted by a Lua script invocation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScriptActionView {
    Send {
        port: String,
        hex: String,
        delay_ms: u16,
    },
    SetPins {
        port: String,
        dtr: bool,
        rts: bool,
    },
    PulsePin {
        port: String,
        pin: String,
        delay_ms: u16,
    },
    Plot {
        series: String,
        value: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp_us: Option<u64>,
    },
    Log {
        level: String,
        message: String,
    },
}

/// One frame in a multi-frame burst returned by a script dry run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptBurstFrameView {
    pub hex: String,
    pub delay_ms: u16,
}

/// Result of running a Lua script hook against a single test frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptDryRunView {
    pub ok: bool,
    pub verdict: String,
    pub mutated: bool,
    pub input_hex: String,
    pub output_hex: String,
    pub delay_ms: u16,
    pub burst_frames: Vec<ScriptBurstFrameView>,
    pub field_diffs: Vec<ScriptFieldDiffView>,
    pub instructions: u32,
    pub exec_us: u64,
    pub memory_bytes: usize,
    pub actions: Vec<ScriptActionView>,
    pub metrics: BTreeMap<String, String>,
    pub assertions: Vec<ScriptAssertionView>,
    pub error: Option<String>,
}

/// Publishes an event to every current subscriber.
///
/// A subscriber that falls behind is dropped rather than allowed to stall the
/// publisher: the snapshot is always the source of truth, events are a hint.
#[derive(Debug, Default)]
pub struct EventBus {
    subscribers: Mutex<Vec<Sender<UiEvent>>>,
    /// The last event, replayed to a subscriber that joins late.
    last: Mutex<Option<UiEvent>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to every future event, and to the last one already published.
    pub fn subscribe(&self) -> Receiver<UiEvent> {
        let (sender, receiver) = channel();
        if let Some(last) = self.last.lock().unwrap().clone() {
            let _ = sender.send(last);
        }
        self.subscribers.lock().unwrap().push(sender);
        receiver
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().unwrap().len()
    }

    pub fn publish(&self, event: UiEvent) {
        *self.last.lock().unwrap() = Some(event.clone());
        let mut subscribers = self.subscribers.lock().unwrap();
        subscribers.retain(|sender| sender.send(event.clone()).is_ok());
    }
}
