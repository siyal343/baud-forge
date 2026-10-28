//! `bforge tail`: frames in, decoded rows out (S8 engine half).
//!
//! This is the read path the window will consume. Bytes arrive from the pipeline,
//! the port's framing machine cuts them into frames, and the port's dissector (if
//! it has one) turns each frame into a field tree. The rows carry byte offsets, so
//! a viewport can highlight what a field came from.

use crate::PortConfig;
use crate::pipeline::{Pipeline, PipelineConfig};
use crate::session::SessionPort;
use crate::slab::{ChunkMeta, Slab};
use bforge_dissect::{DecodedField, DissectorIr, cheader, exec};
use bforge_framer::{ByteMachine, HeaderLength, IdleGap, LengthWidth, machine_for};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Default frame limit, matching [`bforge_framer::DEFAULT_MAX_FRAME`].
const DEFAULT_MAX_FRAME: usize = 64 * 1024;

/// How a port is framed and, when it has one, decoded.
pub struct TailConfig {
    pub machine: Box<dyn ByteMachine>,
    /// Compiled schema and the tag to show, for example `C_STRUCT:ImuPacket`.
    pub dissector: Option<(DissectorIr, String)>,
}

impl std::fmt::Debug for TailConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TailConfig")
            .field("pending", &self.machine.pending())
            .field("dissector", &self.dissector.as_ref().map(|(_, tag)| tag))
            .finish()
    }
}

/// Why a tail could not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TailError {
    NoPorts,
    UnknownPort(String),
    Settings(String),
}

impl std::fmt::Display for TailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoPorts => write!(f, "no ports selected"),
            Self::UnknownPort(id) => write!(f, "port `{id}` is not in the workspace"),
            Self::Settings(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for TailError {}

/// One field of a decoded frame, flattened for a terminal.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FieldRow {
    pub name: String,
    pub offset: u32,
    pub len: u32,
    pub value: String,
}

/// One frame as the viewport would show it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TailRow {
    pub port: String,
    pub timestamp_us: u64,
    /// Time since the previous frame on this port.
    pub delta_us: u64,
    pub len: usize,
    /// Bytes as spaced hex, shortened for display.
    pub hex: String,
    /// Printable text when the frame is mostly text, otherwise empty.
    pub text: String,
    pub protocol: Option<String>,
    pub fields: Vec<FieldRow>,
    /// Set when the frame matched the schema but could not be decoded.
    pub decode_error: Option<String>,
}

struct Port {
    id: String,
    pipeline: Pipeline,
    logger: rtrb::Consumer<Arc<Slab>>,
    machine: Box<dyn ByteMachine>,
    dissector: Option<(DissectorIr, String)>,
    last_ns: Option<u64>,
}

/// Running tail over one or more ports.
pub struct Tail {
    ports: Vec<Port>,
    started: Instant,
}

impl std::fmt::Debug for Tail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tail")
            .field("ports", &self.ports.len())
            .field("elapsed", &self.started.elapsed())
            .finish()
    }
}

impl Tail {
    /// Start one pipeline per port. `configs` is keyed by port id.
    pub fn start(
        ports: Vec<SessionPort>,
        mut configs: HashMap<String, TailConfig>,
    ) -> Result<Self, TailError> {
        if ports.is_empty() {
            return Err(TailError::NoPorts);
        }
        let mut running = Vec::with_capacity(ports.len());
        for (index, port) in ports.into_iter().enumerate() {
            let Some(config) = configs.remove(&port.id) else {
                return Err(TailError::UnknownPort(port.id));
            };
            let mut pipeline = Pipeline::start(
                PipelineConfig {
                    port_id: index as u16,
                    consumers: 1,
                    ..Default::default()
                },
                port.transport,
            );
            let logger = pipeline.take_consumers().remove(0);
            running.push(Port {
                id: port.id,
                pipeline,
                logger,
                machine: config.machine,
                dissector: config.dissector,
                last_ns: None,
            });
        }
        Ok(Self {
            ports: running,
            started: Instant::now(),
        })
    }

    pub fn port_count(&self) -> usize {
        self.ports.len()
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Take whatever is ready and return the frames it completed.
    pub fn pump(&mut self) -> Vec<TailRow> {
        let mut rows = Vec::new();
        for port in &mut self.ports {
            while let Ok(slab) = port.logger.pop() {
                let meta = slab.meta;
                // The clock is the chunk timestamp: an idle-gap machine needs it
                // before the bytes that follow the silence.
                let mut frames = Vec::new();
                port.machine.tick(meta.timestamp_ns, &mut frames);
                port.machine.feed(slab.bytes(), &mut frames);
                for frame in frames {
                    rows.push(port.row(&meta, frame));
                }
            }
        }
        rows
    }

    pub fn stop(mut self) {
        for port in self.ports.drain(..) {
            port.pipeline.stop();
        }
    }
}

impl Port {
    fn row(&mut self, meta: &ChunkMeta, frame: Vec<u8>) -> TailRow {
        let row = build_row(
            &self.id,
            meta.timestamp_ns,
            self.last_ns,
            self.dissector.as_ref(),
            frame,
        );
        self.last_ns = Some(meta.timestamp_ns);
        row
    }
}

/// One row, shared by the live tail and the vault decoder.
fn build_row(
    port: &str,
    timestamp_ns: u64,
    previous_ns: Option<u64>,
    dissector: Option<&(DissectorIr, String)>,
    frame: Vec<u8>,
) -> TailRow {
    let delta_us = match previous_ns {
        Some(previous) => timestamp_ns.saturating_sub(previous) / 1_000,
        None => 0,
    };

    let mut row = TailRow {
        port: port.to_string(),
        timestamp_us: timestamp_ns / 1_000,
        delta_us,
        len: frame.len(),
        hex: hex_preview(&frame),
        text: text_preview(&frame),
        protocol: None,
        fields: Vec::new(),
        decode_error: None,
    };

    if let Some((ir, tag)) = dissector {
        row.protocol = Some(tag.clone());
        match exec::execute(ir, &frame) {
            Ok(fields) => row.fields = flatten(&fields, ""),
            Err(error) => row.decode_error = Some(error.to_string()),
        }
    }
    row
}

/// Why a vault could not be decoded.
#[derive(Debug)]
pub enum DecodeError {
    Settings(TailError),
    Storage(bforge_storage::StorageError),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Settings(error) => write!(f, "{error}"),
            Self::Storage(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DecodeError {}

impl From<TailError> for DecodeError {
    fn from(error: TailError) -> Self {
        Self::Settings(error)
    }
}

impl From<bforge_storage::StorageError> for DecodeError {
    fn from(error: bforge_storage::StorageError) -> Self {
        Self::Storage(error)
    }
}

/// Decode a recorded vault with the framing and dissector of one port.
///
/// The vault keeps raw bytes only, on purpose: the recording is evidence, and a
/// later schema must be able to re-read it. Framing therefore happens here, when
/// someone asks a question about the session.
pub fn decode_vault(
    reader: &mut bforge_storage::LogReader,
    port: &PortConfig,
) -> Result<Vec<TailRow>, DecodeError> {
    let config = tail_config(port)?;
    let mut machine = config.machine;
    let dissector = config.dissector;
    let mut rows = Vec::new();
    let mut previous_ns: Option<u64> = None;
    let mut frame_index = 0u64;

    while frame_index < reader.chunks() {
        let window = reader.window(frame_index, 256)?;
        if window.is_empty() {
            break;
        }
        for record in &window {
            let mut frames = Vec::new();
            machine.tick(record.chunk.timestamp_ns, &mut frames);
            machine.feed(&record.payload, &mut frames);
            for frame in frames {
                rows.push(build_row(
                    &port.id,
                    record.chunk.timestamp_ns,
                    previous_ns,
                    dissector.as_ref(),
                    frame,
                ));
                previous_ns = Some(record.chunk.timestamp_ns);
            }
        }
        frame_index += window.len() as u64;
    }
    Ok(rows)
}

/// Build the framing machine and dissector a configured port asks for.
pub fn tail_config(port: &PortConfig) -> Result<TailConfig, TailError> {
    let framing = &port.framing;
    let limit = framing.max_frame.unwrap_or(DEFAULT_MAX_FRAME);

    let machine: Box<dyn ByteMachine> = match framing.mode.as_str() {
        "delimiter" => {
            let byte = framing.delimiter.unwrap_or(b'\n' as u32) as u8;
            machine_for("delimiter", Some(&[byte]), limit)
                .map_err(|error| TailError::Settings(error.to_string()))?
        }
        "cobs" => machine_for("cobs", None, limit)
            .map_err(|error| TailError::Settings(error.to_string()))?,
        "slip" => machine_for("slip", None, limit)
            .map_err(|error| TailError::Settings(error.to_string()))?,
        "intel_hex" => machine_for("intel_hex", None, limit)
            .map_err(|error| TailError::Settings(error.to_string()))?,
        "header_length" => {
            let sync = framing
                .sync
                .as_deref()
                .and_then(crate::validate::parse_hex)
                .ok_or_else(|| TailError::Settings("header_length needs a sync word".into()))?;
            let width = match framing.length_width.as_deref() {
                Some("u8") => LengthWidth::U8,
                Some("u16_le") => LengthWidth::U16Le,
                Some("u16_be") => LengthWidth::U16Be,
                Some("u32_le") => LengthWidth::U32Le,
                other => {
                    return Err(TailError::Settings(format!(
                        "length width `{}` is not u8, u16_le, u16_be or u32_le",
                        other.unwrap_or("none")
                    )));
                }
            };
            Box::new(HeaderLength::new(
                sync,
                framing.length_offset.unwrap_or(0),
                width,
                framing.length_adjust.unwrap_or(0),
                limit,
            ))
        }
        "idle_gap" => {
            let micros = framing
                .idle_gap_us
                .filter(|micros| *micros > 0)
                .ok_or_else(|| TailError::Settings("idle_gap needs idle_gap_us".into()))?;
            Box::new(IdleGap::new(u64::from(micros) * 1_000, limit))
        }
        other => {
            return Err(TailError::Settings(format!(
                "framing mode `{other}` is not known"
            )));
        }
    };

    let dissector = match &port.dissector {
        None => None,
        Some(specification) if specification.kind == "c_header" => {
            let file = specification
                .file
                .as_deref()
                .ok_or_else(|| TailError::Settings("c_header needs a file".into()))?;
            let root = specification
                .root_struct
                .as_deref()
                .ok_or_else(|| TailError::Settings("c_header needs a root_struct".into()))?;
            let text = std::fs::read_to_string(file)
                .map_err(|error| TailError::Settings(format!("cannot read {file}: {error}")))?;
            let header = cheader::parse(&text)
                .map_err(|error| TailError::Settings(format!("{file}: {error}")))?;
            let ir = cheader::compile(&header, root, file)
                .map_err(|error| TailError::Settings(format!("{file}: {error}")))?;
            Some((ir, format!("C_STRUCT:{root}")))
        }
        Some(specification) => {
            return Err(TailError::Settings(format!(
                "dissector type `{}` on port `{}` is not supported yet",
                specification.kind, port.id
            )));
        }
    };

    Ok(TailConfig { machine, dissector })
}

fn flatten(fields: &[DecodedField], prefix: &str) -> Vec<FieldRow> {
    let mut rows = Vec::new();
    for field in fields {
        let name = if prefix.is_empty() {
            field.name.clone()
        } else {
            format!("{prefix}.{}", field.name)
        };
        if field.children.is_empty() {
            rows.push(FieldRow {
                name,
                offset: field.byte_offset,
                len: field.byte_len,
                value: field.value.clone(),
            });
        } else {
            rows.extend(flatten(&field.children, &name));
        }
    }
    rows
}

fn hex_preview(bytes: &[u8]) -> String {
    const SHOWN: usize = 24;
    let mut text = String::with_capacity(SHOWN * 3);
    for (index, byte) in bytes.iter().take(SHOWN).enumerate() {
        if index > 0 {
            text.push(' ');
        }
        text.push_str(&format!("{byte:02X}"));
    }
    if bytes.len() > SHOWN {
        text.push_str(" ...");
    }
    text
}

fn text_preview(bytes: &[u8]) -> String {
    const SHOWN: usize = 48;
    let printable = bytes
        .iter()
        .filter(|byte| byte.is_ascii_graphic() || **byte == b' ' || **byte == b'\t')
        .count();
    if bytes.is_empty() || printable * 10 < bytes.len() * 8 {
        return String::new();
    }
    bytes
        .iter()
        .take(SHOWN)
        .map(|byte| {
            if byte.is_ascii_graphic() || *byte == b' ' || *byte == b'\t' {
                *byte as char
            } else {
                '.'
            }
        })
        .collect()
}
