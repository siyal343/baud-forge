//! The UI state contract (F1.7.1, F1.7.2).
//!
//! Every state the six workbench bands draw comes from here. The GUI and the
//! headless CLI read the same types, so a counter cannot mean one thing on
//! screen and another in CI.
//!
//! The contract version is fixed at 1. Add a field freely; change the meaning of
//! a field only with a new version.

use serde::{Deserialize, Serialize};
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

/// The pin matrix. Inputs only; DTR and RTS are outputs and arrive with F1.2.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PinsView {
    pub cts: bool,
    pub dsr: bool,
    pub dcd: bool,
    pub ri: bool,
    pub break_state: bool,
    pub framing_error: bool,
    pub parity_error: bool,
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
