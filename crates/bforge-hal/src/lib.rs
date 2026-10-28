//! Transport abstraction (FR-HAL-01 to FR-HAL-04).
//!
//! Every transport backend implements [`TransportDriver`]. All higher layers
//! (loggers, framers, dissectors, plots) use the trait only, so a feature that
//! works on UART works the same on RTT, CAN or TCP.
//!
//! Setup only for the real drivers. [`mock`] is complete and drives the tests.

use serde::{Deserialize, Serialize};

pub mod mock;
pub mod tcp;
pub mod uart;
pub mod udp;

/// Minimum accepted baud rate (FR-HAL-01).
pub const MIN_BAUD: u32 = 110;
/// Maximum accepted baud rate (FR-HAL-01).
pub const MAX_BAUD: u32 = 12_000_000;
/// Maximum number of concurrent transports (ADR-002).
pub const MAX_PORTS: u16 = 64;

/// Direction of a byte chunk in the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Direction {
    Rx,
    Tx,
    MitmAToB,
    MitmBToA,
    InjectedFault,
}

/// Serial line and error state, packed as a bitmask (FR-HAL-04).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PinStateFlags(pub u16);

impl PinStateFlags {
    pub const CTS: Self = Self(1 << 0);
    pub const DSR: Self = Self(1 << 1);
    pub const DCD: Self = Self(1 << 2);
    pub const RI: Self = Self(1 << 3);
    pub const BREAK: Self = Self(1 << 4);
    pub const FRAMING_ERR: Self = Self(1 << 5);
    pub const PARITY_ERR: Self = Self(1 << 6);
    /// Output pin, driven by `set_pins`.
    pub const DTR: Self = Self(1 << 7);
    /// Output pin, driven by `set_pins`.
    pub const RTS: Self = Self(1 << 8);

    /// True when every bit of `other` is set.
    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Set every bit of `other`.
    pub fn insert(&mut self, other: Self) {
        self.0 |= other.0;
    }
}

impl PortState {
    /// The name used in the status contract.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::Reconnecting => "reconnecting",
            Self::Yielded => "yielded",
        }
    }
}

/// Lifecycle state of one transport (FR-HAL-03).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PortState {
    #[default]
    Closed,
    Open,
    Reconnecting,
    /// File handle released on purpose so a flash tool can use the port.
    Yielded,
}

/// Parity setting of a UART line (FR-HAL-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Parity {
    None,
    Odd,
    Even,
    Mark,
    Space,
}

/// Stop bit setting of a UART line (FR-HAL-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopBits {
    One,
    OneAndHalf,
    Two,
}

/// Line settings of a UART transport (FR-HAL-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineConfig {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: StopBits,
}

impl Default for LineConfig {
    fn default() -> Self {
        Self {
            baud_rate: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: StopBits::One,
        }
    }
}

/// Invalid line settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineError {
    BaudOutOfRange(u32),
    DataBitsOutOfRange(u8),
}

/// One device as the operating system reports it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeviceId {
    /// USB identity as `vvvv:pppp`, for example `0403:6010`.
    pub vid_pid: Option<String>,
    pub serial: Option<String>,
    pub interface_index: Option<u8>,
    pub port_path: Option<String>,
    /// OS device path, for example `/dev/ttyACM0` or `COM4`.
    pub device_path: String,
}

/// Binding rule for a port (FR-HAL-02).
///
/// The tuple is matched in the order VID:PID, serial, interface, port path.
/// When no tuple field is set, the OS device path is the fallback.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PortMatch {
    pub vid_pid: Option<String>,
    pub serial: Option<String>,
    pub interface_index: Option<u8>,
    pub port_path: Option<String>,
    pub device_path: Option<String>,
}

/// Error returned by a transport operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportError {
    NotOpen,
    Disconnected,
    Io(String),
    Unsupported(&'static str),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOpen => write!(f, "transport is not open"),
            Self::Disconnected => write!(f, "transport is disconnected"),
            Self::Io(message) => write!(f, "io error: {message}"),
            Self::Unsupported(what) => write!(f, "{what} is not supported by this transport"),
        }
    }
}

impl std::error::Error for TransportError {}

/// Contract for every transport backend (FR-HAL-01).
///
/// The methods stay synchronous and object safe, so a port registry can hold
/// `Box<dyn TransportDriver>`.
pub trait TransportDriver {
    fn open(&mut self) -> Result<(), TransportError>;
    fn close(&mut self);
    /// Read available bytes into `out`. Return the byte count, 0 when idle.
    fn read_slab(&mut self, out: &mut [u8]) -> Result<usize, TransportError>;
    fn write_frame(&mut self, frame: &[u8]) -> Result<(), TransportError>;
    /// Drive DTR and RTS (FR-HAL-04).
    fn set_pins(&mut self, pins: PinStateFlags) -> Result<(), TransportError>;
    /// Read CTS, DSR, DCD and RI (FR-HAL-04). Takes `&mut self` because the
    /// platform calls behind it do.
    fn read_pins(&mut self) -> Result<PinStateFlags, TransportError>;
    fn state(&self) -> PortState;
}
