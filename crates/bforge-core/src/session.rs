//! Session: ports, pipelines and the vault, plus replay (F1.5.3, F1.5.4).
//!
//! One session owns a pipeline per port and one writer. The caller pumps it:
//! `pump_once` moves whatever is ready from the ports into the vault. That keeps
//! the recording path free of a second thread and keeps the counters honest.

use crate::pipeline::{Pipeline, PipelineConfig};
use crate::ui::{CONTRACT_VERSION, EventBus, PinsView, PortView, SessionView, UiEvent, UiSnapshot};
use crate::{PortConfig, ProjectConfig};
use bforge_hal::uart::{UartConfig, UartTransport, available};
use bforge_hal::{LineConfig, PinStateFlags, TransportDriver};
use bforge_storage::{LogHeader, LogReader, LogSummary, LogWriter, RawChunk, StorageError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How often the pump publishes a stats event.
const STATS_INTERVAL: Duration = Duration::from_millis(250);

/// Failure to build or run a session.
#[derive(Debug)]
pub enum SessionError {
    /// No port in the workspace could be bound to a device.
    NoDevice(String),
    /// The vault could not be created or written.
    Storage(StorageError),
    /// Nothing to record: every requested port was filtered out.
    NoPorts,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoDevice(id) => write!(f, "no device matches port `{id}`"),
            Self::Storage(error) => write!(f, "vault: {error}"),
            Self::NoPorts => write!(f, "no ports selected"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<StorageError> for SessionError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl From<std::io::Error> for SessionError {
    fn from(error: std::io::Error) -> Self {
        Self::Storage(StorageError::Io(error.to_string()))
    }
}

/// One port, already bound to a transport.
pub struct SessionPort {
    pub id: String,
    pub device: String,
    pub baud_rate: u32,
    pub framing: String,
    pub checksum: Option<String>,
    pub transport: Box<dyn TransportDriver + Send>,
}

struct RunningPort {
    info: PortView,
    pipeline: Pipeline,
    logger: rtrb::Consumer<std::sync::Arc<crate::slab::Slab>>,
}

/// A recording session.
pub struct Session {
    mode: &'static str,
    ports: Vec<RunningPort>,
    writer: Option<LogWriter>,
    vault: String,
    started: Instant,
    started_epoch_ns: u64,
    chunks: u64,
    payload_bytes: u64,
    elf: Option<String>,
    bus: EventBus,
    last_stats: Instant,
    last_chunks: u64,
}

impl Session {
    /// Start one pipeline per port. `vault` empty means "do not write a file",
    /// which is what the status probe uses.
    pub fn start(
        ports: Vec<SessionPort>,
        vault: Option<&Path>,
        elf: Option<String>,
    ) -> Result<Self, SessionError> {
        if ports.is_empty() {
            return Err(SessionError::NoPorts);
        }

        let started_epoch_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0);
        let header = LogHeader {
            session_id: u128::from(started_epoch_ns) << 64 | u128::from(std::process::id()),
            start_epoch_ns: started_epoch_ns,
            config_hash: 0,
            port_table_offset: 256,
        };
        let (writer, vault) = match vault {
            Some(path) => (
                Some(LogWriter::create(path, header)?),
                path.display().to_string(),
            ),
            None => (None, String::new()),
        };

        let bus = EventBus::new();
        let mut running = Vec::with_capacity(ports.len());
        for (index, port) in ports.into_iter().enumerate() {
            let mut pipeline = Pipeline::start(
                PipelineConfig {
                    port_id: index as u16,
                    // A recorder has one consumer. Framing joins in S5.
                    consumers: 1,
                    ..Default::default()
                },
                port.transport,
            );
            let logger = pipeline.take_consumers().remove(0);
            running.push(RunningPort {
                info: PortView {
                    id: port.id,
                    device: port.device,
                    baud_rate: port.baud_rate,
                    framing: port.framing,
                    checksum: port.checksum,
                    state: "open".to_string(),
                    pins: PinsView::default(),
                    chunks: 0,
                    bytes: 0,
                    overruns: 0,
                    stalls_ms: 0.0,
                    read_errors: 0,
                },
                pipeline,
                logger,
            });
        }

        let session = Self {
            mode: "record",
            ports: running,
            writer,
            vault: vault.clone(),
            started: Instant::now(),
            started_epoch_ns,
            chunks: 0,
            payload_bytes: 0,
            elf,
            bus,
            last_stats: Instant::now(),
            last_chunks: 0,
        };
        session.bus.publish(UiEvent::Started {
            at_ms: 0,
            ports: session.ports.len(),
            vault,
        });
        Ok(session)
    }

    /// Subscribe to the event stream before pumping.
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<UiEvent> {
        self.bus.subscribe()
    }

    /// Move ready chunks into the vault. Returns how many moved.
    pub fn pump_once(&mut self) -> Result<usize, SessionError> {
        let mut moved = 0;
        for port in &mut self.ports {
            while let Ok(slab) = port.logger.pop() {
                let meta = slab.meta;
                if let Some(writer) = self.writer.as_mut() {
                    let chunk = RawChunk {
                        seq_id: meta.seq_id,
                        timestamp_ns: meta.timestamp_ns,
                        port_id: meta.port_id,
                        direction: meta.direction,
                        line_state: meta.line_state,
                        payload_offset: 0,
                        payload_len: meta.len,
                    };
                    writer.append(&chunk, slab.bytes())?;
                }
                self.chunks += 1;
                self.payload_bytes += u64::from(meta.len);
                moved += 1;
            }
        }
        self.refresh_ports();
        self.publish_stats_if_due();
        Ok(moved)
    }

    /// Pump until the deadline, publishing stats on a fixed interval.
    pub fn pump_until(&mut self, deadline: Instant) -> Result<(), SessionError> {
        loop {
            let moved = self.pump_once()?;
            if Instant::now() >= deadline {
                return Ok(());
            }
            if moved == 0 {
                std::thread::sleep(Duration::from_micros(500));
            }
        }
    }

    fn publish_stats_if_due(&mut self) {
        let now = Instant::now();
        if now.duration_since(self.last_stats) < STATS_INTERVAL {
            return;
        }
        let seconds = now.duration_since(self.last_stats).as_secs_f64();
        let delta = self.chunks - self.last_chunks;
        let overruns = self
            .ports
            .iter()
            .map(|port| port.info.overruns)
            .max()
            .unwrap_or(0);
        self.bus.publish(UiEvent::Stats {
            at_ms: self.started.elapsed().as_millis() as u64,
            chunks: self.chunks,
            payload_bytes: self.payload_bytes,
            overruns,
            chunks_per_sec: if seconds > 0.0 {
                (delta as f64 / seconds) as u64
            } else {
                0
            },
        });
        self.last_stats = now;
        self.last_chunks = self.chunks;
    }

    fn refresh_ports(&mut self) {
        for port in &mut self.ports {
            let stats = port.pipeline.stats();
            port.info.chunks = stats.chunks;
            port.info.bytes = stats.bytes;
            port.info.stalls_ms = stats.stalls_ns as f64 / 1.0e6;
            port.info.read_errors = stats.read_errors;
            port.info.pins = PinsView {
                cts: stats.line_state & PinStateFlags::CTS.0 != 0,
                dsr: stats.line_state & PinStateFlags::DSR.0 != 0,
                dcd: stats.line_state & PinStateFlags::DCD.0 != 0,
                ri: stats.line_state & PinStateFlags::RI.0 != 0,
                break_state: stats.line_state & PinStateFlags::BREAK.0 != 0,
                framing_error: stats.line_state & PinStateFlags::FRAMING_ERR.0 != 0,
                parity_error: stats.line_state & PinStateFlags::PARITY_ERR.0 != 0,
            };
            if stats.overruns > port.info.overruns {
                port.info.overruns = stats.overruns;
                self.bus.publish(UiEvent::Overrun {
                    at_ms: self.started.elapsed().as_millis() as u64,
                    port: port.info.id.clone(),
                    total: stats.overruns,
                });
            }
        }
    }

    /// The state the window draws.
    pub fn snapshot(&self) -> UiSnapshot {
        let (file_bytes, chunks, payload_bytes) = match self.writer.as_ref() {
            Some(writer) => (writer.position(), writer.chunks(), self.payload_bytes),
            None => (0, self.chunks, self.payload_bytes),
        };
        UiSnapshot {
            contract: CONTRACT_VERSION,
            session: SessionView {
                mode: self.mode.to_string(),
                vault: self.vault.clone(),
                file_bytes,
                chunks,
                payload_bytes,
                elapsed_ms: self.started.elapsed().as_millis() as u64,
                started_epoch_ns: self.started_epoch_ns,
                elf: self.elf.clone(),
            },
            ports: self.ports.iter().map(|port| port.info.clone()).collect(),
        }
    }

    /// Flush the vault, stop every pipeline, and report.
    pub fn seal(mut self) -> Result<LogSummary, SessionError> {
        self.pump_once()?;
        self.bus.publish(UiEvent::Stopped {
            at_ms: self.started.elapsed().as_millis() as u64,
            chunks: self.chunks,
            payload_bytes: self.payload_bytes,
        });
        for port in &mut self.ports {
            port.info.state = "closed".to_string();
        }
        let summary = match self.writer.take() {
            Some(writer) => writer.seal()?,
            None => LogSummary {
                path: PathBuf::new(),
                chunks: self.chunks,
                payload_bytes: self.payload_bytes,
                file_bytes: 0,
                segments: 0,
            },
        };
        for port in self.ports.drain(..) {
            port.pipeline.stop();
        }
        Ok(summary)
    }

    pub fn chunks(&self) -> u64 {
        self.chunks
    }

    pub fn port_count(&self) -> usize {
        self.ports.len()
    }
}

/// Resolve every configured port to a device and build its transport.
///
/// Binding by `device_path` works today. Binding by USB tuple compares the
/// identity the operating system reports; hotplug and reconnect are F1.2.5.
pub fn session_ports_from_config(
    project: &ProjectConfig,
    only: &[String],
) -> Result<Vec<SessionPort>, SessionError> {
    // A typo in `device_path` must fail at start, not after 3 seconds of silence.
    let enumerated = available();
    let strictly = enumerated.is_ok();
    let devices = enumerated.unwrap_or_default();
    let mut ports = Vec::new();

    for port in &project.ports {
        if !only.is_empty() && !only.contains(&port.id) {
            continue;
        }
        let Some(device) = resolve_device(port, &devices, strictly) else {
            return Err(SessionError::NoDevice(port.id.clone()));
        };
        ports.push(SessionPort {
            id: port.id.clone(),
            device: device.clone(),
            baud_rate: port.baud_rate,
            framing: port.framing.mode.clone(),
            checksum: port.framing.crc.clone(),
            transport: Box::new(UartTransport::new(UartConfig {
                device,
                line: LineConfig {
                    baud_rate: port.baud_rate,
                    ..Default::default()
                },
                read_timeout: Duration::from_millis(50),
            })),
        });
    }

    if ports.is_empty() {
        return Err(SessionError::NoPorts);
    }
    Ok(ports)
}

fn resolve_device(
    port: &PortConfig,
    devices: &[bforge_hal::DeviceId],
    strictly: bool,
) -> Option<String> {
    if let Some(path) = &port.device_path {
        if !strictly || devices.iter().any(|device| device.device_path == *path) {
            return Some(path.clone());
        }
        return None;
    }
    let wanted = port.match_vid_pid.as_ref()?;
    devices
        .iter()
        .find(|device| {
            device.vid_pid.as_deref() == Some(wanted.as_str())
                && port
                    .match_serial
                    .as_ref()
                    .is_none_or(|serial| device.serial.as_deref() == Some(serial.as_str()))
        })
        .map(|device| device.device_path.clone())
}

/// How to send a recorded session back out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReplayOptions {
    /// 1.0 keeps the original timing, 10.0 is ten times faster.
    pub speed: f64,
}

impl Default for ReplayOptions {
    fn default() -> Self {
        Self { speed: 1.0 }
    }
}

/// What a replay did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReplayReport {
    pub chunks: u64,
    pub payload_bytes: u64,
    pub elapsed: Duration,
    /// Largest lateness of a send against its scheduled time.
    pub max_lag_ms: f64,
}

/// Send a recorded session out of a transport, keeping the original gaps
/// between chunks.
pub fn replay_to(
    reader: &mut LogReader,
    transport: &mut dyn TransportDriver,
    options: ReplayOptions,
) -> Result<ReplayReport, SessionError> {
    let speed = if options.speed > 0.0 {
        options.speed
    } else {
        1.0
    };
    transport
        .open()
        .map_err(|error| SessionError::Storage(StorageError::Io(error.to_string())))?;

    let total = reader.chunks();
    let mut first_timestamp = None;
    let mut report = ReplayReport {
        chunks: 0,
        payload_bytes: 0,
        elapsed: Duration::ZERO,
        max_lag_ms: 0.0,
    };
    let started = Instant::now();

    for seq in 0..total {
        let Some(record) = reader.read_at(seq)? else {
            break;
        };
        let base = *first_timestamp.get_or_insert(record.chunk.timestamp_ns);
        let offset_ns = record.chunk.timestamp_ns.saturating_sub(base);
        let due = Duration::from_nanos((offset_ns as f64 / speed) as u64);

        let elapsed = started.elapsed();
        if due > elapsed {
            std::thread::sleep(due - elapsed);
        } else {
            report.max_lag_ms = report
                .max_lag_ms
                .max((elapsed - due).as_secs_f64() * 1000.0);
        }

        transport
            .write_frame(&record.payload)
            .map_err(|error| SessionError::Storage(StorageError::Io(error.to_string())))?;
        report.chunks += 1;
        report.payload_bytes += record.payload.len() as u64;
    }

    report.elapsed = started.elapsed();
    transport.close();
    Ok(report)
}
