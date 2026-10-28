//! Native protocol packs (F3.4).
//!
//! A pack decodes a frame from a published specification, without a schema file.
//! Each one is judged on a hand-built fixture that follows the standard, because a
//! pack that is subtly wrong is worse than no pack at all: it prints confident
//! numbers from the wrong bits.
//!
//! `DecodedField` carries absolute byte offsets, so the hex pane can still point at
//! the bytes a field came from.

pub mod ccsds;
pub mod csp;
pub mod modbus;

use crate::DecodedField;
use crate::exec::ExecError;

/// A protocol the tool understands without a schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pack {
    /// CCSDS Space Packet, telemetry direction, with an optional ECSS PUS header.
    CcsdsTm,
    /// CCSDS Space Packet, telecommand direction.
    CcsdsTc,
    /// CubeSat Space Protocol, version 1.
    Csp,
    /// Modbus RTU application data unit.
    ModbusRtu,
}

impl Pack {
    /// Read a pack name from a workspace file.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "ccsds_tm" => Some(Self::CcsdsTm),
            "ccsds_tc" => Some(Self::CcsdsTc),
            "csp" => Some(Self::Csp),
            "modbus_rtu" => Some(Self::ModbusRtu),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::CcsdsTm => "ccsds_tm",
            Self::CcsdsTc => "ccsds_tc",
            Self::Csp => "csp",
            Self::ModbusRtu => "modbus_rtu",
        }
    }

    /// The tag a row shows for this pack.
    pub fn tag(self) -> &'static str {
        match self {
            Self::CcsdsTm => "CCSDS_TM",
            Self::CcsdsTc => "CCSDS_TC",
            Self::Csp => "CSP",
            Self::ModbusRtu => "MODBUS_RTU",
        }
    }

    pub fn decode(self, frame: &[u8]) -> Result<Vec<DecodedField>, ExecError> {
        match self {
            Self::CcsdsTm => ccsds::decode(frame, ccsds::Direction::Telemetry),
            Self::CcsdsTc => ccsds::decode(frame, ccsds::Direction::Telecommand),
            Self::Csp => csp::decode(frame),
            Self::ModbusRtu => modbus::decode(frame),
        }
    }
}

/// Every pack name a workspace may use.
pub const PACK_NAMES: [&str; 4] = ["ccsds_tm", "ccsds_tc", "csp", "modbus_rtu"];

/// Build one field with no children.
pub(crate) fn field(
    name: &str,
    offset: u32,
    len: u32,
    value: String,
    value_num: Option<f64>,
) -> DecodedField {
    DecodedField {
        name: name.to_string(),
        byte_offset: offset,
        byte_len: len,
        value,
        value_num,
        children: Vec::new(),
    }
}

/// The frame must hold at least this many bytes.
pub(crate) fn require(frame: &[u8], need: usize, what: &str) -> Result<(), ExecError> {
    if frame.len() < need {
        return Err(ExecError::Bounds {
            field: what.to_string(),
            need: need as u32,
            have: frame.len(),
        });
    }
    Ok(())
}
