//! Declarative dissection engine (ADR-003, FR-DIS-01, FR-DIS-02).
//!
//! A schema source compiles into [`DissectorIr`]. The runtime executes the IR
//! against a frame, so a new protocol never needs a rebuild of the binary.
//!
//! S11 implements the IR executor and a C header parser for packed structs.
//! Protocol packs (CCSDS, CSP, MAVLink, Modbus) and Protobuf are F3.3 and F3.4.

pub mod cheader;
pub mod exec;
pub mod packs;

use bforge_storage::RawChunk;
use serde::{Deserialize, Serialize};

/// Where a dissector schema comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SchemaSource {
    /// Packed structs in a C header, parsed with `tree-sitter-c`.
    CHeader { file: String, root_struct: String },
    /// Protobuf message descriptor.
    Protobuf { file: String, message: String },
    /// Kaitai Struct definition.
    Kaitai { file: String, type_name: String },
}

/// Native protocol pack (FR-DIS-02).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Protocol {
    CcsdsSpacePacket,
    CcsdsTm,
    CcsdsTc,
    EcssPus,
    CspV1,
    CspV2,
    MavlinkV1,
    MavlinkV2,
    ModbusRtu,
}

/// Compiled schema, executed per frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DissectorIr {
    pub schema: SchemaSource,
    pub ops: Vec<IrOp>,
}

/// One unpack step of a compiled schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IrOp {
    /// Read an unsigned integer of the given width.
    UInt {
        offset: u32,
        width: u8,
        big_endian: bool,
    },
    /// Read a signed integer of the given width.
    Int {
        offset: u32,
        width: u8,
        big_endian: bool,
    },
    /// Read an IEEE-754 float of 32 or 64 bits.
    Float {
        offset: u32,
        width: u8,
        big_endian: bool,
    },
    /// Read `width` bits starting at `bit_offset` inside the storage unit at
    /// `offset`. Bits count from the least significant bit of the unit.
    Bitfield {
        offset: u32,
        bit_offset: u8,
        width: u8,
        big_endian: bool,
    },
    /// Read a fixed-length array of nested fields.
    Array {
        offset: u32,
        count: u16,
        element: Box<IrOp>,
    },
    /// Read an integer and map it to a label when the value matches.
    Enum {
        offset: u32,
        width: u8,
        variants: Vec<(i64, String)>,
        big_endian: bool,
    },
    /// Name the field produced by the wrapped operation.
    Label { name: String, op: Box<IrOp> },
}

/// Outcome of a checksum check (FR-FRM-01).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrcValidation {
    Valid,
    Invalid { expected: u32, actual: u32 },
    NotApplicable,
}

/// One node of the decoded field tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecodedField {
    pub name: String,
    /// Absolute byte offset of the field in the frame.
    pub byte_offset: u32,
    pub byte_len: u32,
    /// Scaled value for the UI, already unit-converted.
    pub value: String,
    /// The same value as a number, when it is one, so a plot can use it.
    pub value_num: Option<f64>,
    pub children: Vec<DecodedField>,
}

/// Output of the framing and dissection stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DissectedFrame {
    pub frame_id: u64,
    pub port_id: u16,
    pub start_timestamp_ns: u64,
    pub end_timestamp_ns: u64,
    /// Time elapsed since the previous frame on the same port.
    pub delta_ns: u64,
    pub raw_bytes: Vec<u8>,
    pub crc_status: CrcValidation,
    /// For example `CCSDS_TM`, `MODBUS_RTU` or `C_STRUCT:ImuPacket`.
    pub protocol_tag: String,
    pub fields: Vec<DecodedField>,
    pub elf_annotations: Vec<SourceLocation>,
}

/// Resolved firmware source position (FR-SYM-01).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub file: String,
    pub line: u32,
    pub function: String,
    pub address: u64,
}

/// What the dissector stage returns for one input chunk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DissectOutcome {
    Frame(Box<DissectedFrame>),
    /// Not enough bytes yet, wait for the next chunk.
    Incomplete,
    /// No dissector matched this port.
    Unmatched(RawChunk),
}
