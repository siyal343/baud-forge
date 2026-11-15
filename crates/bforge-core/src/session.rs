//! Session: ports, pipelines and the vault, plus replay (F1.5.3, F1.5.4).
//!
//! One session owns a pipeline per port and one writer. The caller pumps it:
//! `pump_once` moves whatever is ready from the ports into the vault. That keeps
//! the recording path free of a second thread and keeps the counters honest.

use crate::contract::{
    BridgeView, CONTRACT_VERSION, EventBus, PinsView, PortView, ScriptActionView,
    ScriptAssertionView, ScriptBurstFrameView, ScriptDryRunView, ScriptFieldDiffView,
    ScriptStatusView, SessionView, UiEvent, UiSnapshot,
};
use crate::control::{ControlServer, ControlTarget};
use crate::fault::{FaultOutcome, FaultProfile, Injector};
pub use crate::pipeline::PinStep;
use crate::pipeline::{Pipeline, PipelineConfig, YieldRequest};
use crate::series::{SeriesSet, SeriesUpdate};
use crate::symbolize::symbolize;
use crate::tail::{Stream, TailError, TailRow, tail_config};
use crate::{BridgeConfig, PortConfig, ProjectConfig};
use bforge_dissect::{DissectorIr, SchemaSource};
use bforge_hal::tcp::{TcpConfig, TcpTransport};
use bforge_hal::uart::{UartConfig, UartTransport, available};
use bforge_hal::udp::{UdpConfig, UdpTransport};
use bforge_hal::{Direction, LineConfig, PinStateFlags, TransportDriver};
use bforge_script::{
    FaultPolicy, FrameMeta, FrameVerdict, HookKind, ScriptAction, ScriptRuntime, ScriptSnapshot,
    hex_of,
};
use bforge_storage::{LogHeader, LogReader, LogSummary, LogWriter, RawChunk, StorageError};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
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
    /// A port configuration cannot be used, for example a socket port with no address.
    Settings(String),
    /// A write was asked for a port that is not in this session.
    UnknownPort(String),
    /// A write did not reach the port.
    Write(String),
    /// A vault already exists at that path, and a monitor never overwrites one.
    VaultExists(String),
    /// A stop-recording request arrived with no active vault segment.
    NotRecording,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoDevice(id) => write!(f, "no device matches port `{id}`"),
            Self::Storage(error) => write!(f, "vault: {error}"),
            Self::NoPorts => write!(f, "no ports selected"),
            Self::Settings(message) => write!(f, "{message}"),
            Self::UnknownPort(port) => write!(f, "port `{port}` is not in this session"),
            Self::Write(message) => write!(f, "{message}"),
            Self::VaultExists(path) => write!(
                f,
                "a vault already exists at `{path}`; remove it, or pick another name"
            ),
            Self::NotRecording => write!(f, "this session is not recording a vault"),
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

/// Frames kept for the UI before the oldest is dropped. A browser that stops
/// reading must not grow the process.
const FRAME_QUEUE: usize = 4_096;

/// Chunks one pump call may move from one port. A source that outruns the pump
/// would otherwise keep `pump_once` inside its drain loop, and the snapshot, the
/// events and the vault position would stop being published.
const PUMP_BUDGET: usize = 1_024;

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
    control: Option<ControlServer>,
    yield_requests: Vec<(String, Arc<YieldRequest>)>,
    /// One entry per port, in port order. Empty until `enable_decode` is called.
    streams: Vec<Option<Stream>>,
    /// The reconnect/yield generation each port's framing machine was last
    /// reset at. A new generation invalidates the machine's buffered bytes
    /// (F-24): bytes from before a transport drop must not concatenate with
    /// the first bytes of the new connection.
    transport_generations: Vec<(u64, u64)>,
    /// Armed fault profiles, by port id. A send applies its port's profile.
    faults: std::sync::Mutex<std::collections::HashMap<String, Injector>>,
    /// The firmware image, when the workspace names one. Frames get address badges.
    image: Option<bforge_elf::ElfImage>,
    /// Port pairs joined by the engine.
    bridges: Vec<Bridge>,
    /// One set of counters per port, shared with its reader thread.
    outboxes: Vec<Outbox>,
    /// The HIL script, when the workspace names one or the API arms one.
    script: Option<ScriptRuntime>,
    /// Registered hook mask for `script`, used so legacy `on_frame` TX scripts
    /// never accidentally trigger on RX/MITM/raw-chunk paths.
    script_hooks: ScriptHooksMask,
    /// Source & options of the armed script, kept for `GET /api/script` and reset.
    script_spec: Option<ArmedScriptSpec>,
    /// Buffered `(level, message)` logs emitted by `bforge.log` or timer errors.
    script_logs: Vec<(String, String)>,
    /// Non-reentrancy depth guard around `bforge.send` execution.
    script_send_depth: u8,
    /// Monotonic sequence counter for script hook metadata outside RX slabs.
    script_seq: u64,
    /// The script applied to what arrives, before framing (D-84).
    rx_script: Option<ScriptRuntime>,
    /// One IR per port that can encode a typed frame, built with the decoders.
    encoders: Vec<Option<DissectorIr>>,
    /// Multi-port / multi-schema lookup table shared with Lua script runtimes.
    schemas: Arc<BTreeMap<String, DissectorIr>>,
    /// The decode configs `enable_decode` saw, so an uploaded schema can
    /// rebuild a port's stream with the same framing (spec 2.2).
    port_configs: Vec<crate::PortConfig>,
    /// One armed X/YMODEM transfer (spec 2.7), on the port it runs against.
    xfer: Option<crate::xmodem::XferSession>,
    frames: std::collections::VecDeque<TailRow>,
    frames_dropped: u64,
    /// Chunks the receive script dropped.
    chunks_received_dropped: u64,
    series: SeriesSet,
}

/// Hook families registered by the currently armed script.
#[derive(Debug, Default, Clone, Copy)]
struct ScriptHooksMask {
    tx: bool,
    rx: bool,
    raw_chunk: bool,
    mitm: bool,
}

impl ScriptHooksMask {
    fn from_hooks(hooks: &[String]) -> Self {
        Self {
            tx: hooks
                .iter()
                .any(|h| h == "on_frame" || h.starts_with("on_tx_frame:")),
            rx: hooks
                .iter()
                .any(|h| h.starts_with("on_rx_frame:") || h.starts_with("on_dissect:")),
            raw_chunk: hooks.iter().any(|h| h.starts_with("on_raw_chunk:")),
            mitm: hooks.iter().any(|h| h.starts_with("on_mitm_frame:")),
        }
    }
}

/// Compilation inputs remembered for `GET /api/script` and `reset_stats`.
#[derive(Debug, Clone)]
struct ArmedScriptSpec {
    source: Option<String>,
    path: Option<PathBuf>,
    name: String,
    policy: FaultPolicy,
    memory_limit_bytes: usize,
    seed: Option<u64>,
}

/// Cap queued `bforge.send` dispatches drained in a single `pump_once` call.
const MAX_SCRIPT_SENDS_PER_PUMP: usize = 16;

/// One bridge, resolved to port indices.
struct Bridge {
    view: BridgeView,
    a: usize,
    b: usize,
}

/// How much forwarded traffic may wait for one port before the bridge drops it.
const FORWARD_LIMIT: u64 = 1 << 20;

/// A port's transmit bookkeeping: what was posted, what landed, what was refused.
#[derive(Debug, Default)]
struct Outbox {
    posted: Arc<std::sync::atomic::AtomicU64>,
    settled: Arc<std::sync::atomic::AtomicU64>,
    failed: Arc<std::sync::atomic::AtomicU64>,
}

/// What a running session answers on the control socket.
struct SessionControl {
    requests: Vec<(String, Arc<YieldRequest>)>,
    vault: String,
    started: Instant,
}

impl ControlTarget for SessionControl {
    fn yield_port(&self, port: &str, duration: Duration) -> bool {
        match self.requests.iter().find(|(id, _)| id == port) {
            Some((_, request)) => {
                request.request(duration);
                true
            }
            None => false,
        }
    }

    fn status(&self) -> String {
        serde_json::json!({
            "ok": true,
            "vault": self.vault,
            "ports": self.requests.len(),
            "elapsed_ms": self.started.elapsed().as_millis() as u64,
        })
        .to_string()
    }
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
        let port_count = ports.len();
        let header = LogHeader {
            session_id: u128::from(started_epoch_ns) << 64 | u128::from(std::process::id()),
            start_epoch_ns: started_epoch_ns,
            config_hash: 0,
            port_table_offset: 256,
        };
        let (writer, vault) = match vault {
            Some(path) => {
                // A session that silently truncated yesterday's capture would be a
                // data-loss bug, not a convenience.
                let occupied = std::fs::metadata(path)
                    .map(|metadata| metadata.len() > 0)
                    .unwrap_or(false);
                if occupied {
                    return Err(SessionError::VaultExists(path.display().to_string()));
                }
                (
                    Some(LogWriter::create(path, header)?),
                    path.display().to_string(),
                )
            }
            None => (None, String::new()),
        };

        let bus = EventBus::new();
        let mut yield_requests = Vec::new();
        let mut devices = Vec::new();
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
            yield_requests.push((port.id.clone(), pipeline.yield_handle()));
            if !devices.contains(&port.device) {
                devices.push(port.device.clone());
            }
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

        let control = ControlServer::start(
            &devices,
            Arc::new(SessionControl {
                requests: yield_requests.clone(),
                vault: vault.clone(),
                started: Instant::now(),
            }),
            Duration::from_secs(10),
        )
        .ok();

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
            control,
            yield_requests,
            streams: Vec::new(),
            transport_generations: Vec::new(),
            faults: std::sync::Mutex::new(std::collections::HashMap::new()),
            image: None,
            bridges: Vec::new(),
            outboxes: std::iter::repeat_with(Outbox::default)
                .take(port_count)
                .collect(),
            script: None,
            script_hooks: ScriptHooksMask::default(),
            script_spec: None,
            script_logs: Vec::new(),
            script_send_depth: 0,
            script_seq: 0,
            rx_script: None,
            encoders: Vec::new(),
            schemas: Arc::new(BTreeMap::new()),
            port_configs: Vec::new(),
            xfer: None,
            frames: std::collections::VecDeque::new(),
            frames_dropped: 0,
            chunks_received_dropped: 0,
            series: SeriesSet::new(),
        };
        session.bus.publish(UiEvent::Started {
            at_ms: 0,
            ports: session.ports.len(),
            vault,
        });
        Ok(session)
    }

    /// Begin writing a new vault segment mid-session (workbench REC pill).
    ///
    /// A session may hold one writer at a time; the same no-clobber rule as
    /// [`Session::start`] applies, so a REC press can never truncate a capture.
    pub fn start_recording(&mut self, path: &Path) -> Result<(), SessionError> {
        if self.writer.is_some() {
            return Err(SessionError::VaultExists(self.vault.clone()));
        }
        let occupied = std::fs::metadata(path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
        if occupied {
            return Err(SessionError::VaultExists(path.display().to_string()));
        }
        let header = LogHeader {
            session_id: u128::from(self.started_epoch_ns) << 64 | u128::from(std::process::id()),
            start_epoch_ns: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos() as u64)
                .unwrap_or(0),
            config_hash: 0,
            port_table_offset: 256,
        };
        // A bare REC press uses a default `vaults/…` path; create the parent
        // directory instead of failing because the folder does not exist yet.
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        self.writer = Some(LogWriter::create(path, header)?);
        self.vault = path.display().to_string();
        self.bus.publish(UiEvent::Started {
            at_ms: self.started.elapsed().as_millis() as u64,
            ports: self.ports.len(),
            vault: self.vault.clone(),
        });
        Ok(())
    }

    /// Flush and seal the current vault segment, returning its path.
    pub fn stop_recording(&mut self) -> Result<String, SessionError> {
        match self.writer.take() {
            Some(writer) => {
                let summary = writer.seal()?;
                let path = self.vault.clone();
                self.vault = String::new();
                self.bus.publish(UiEvent::Stopped {
                    at_ms: self.started.elapsed().as_millis() as u64,
                    chunks: summary.chunks,
                    payload_bytes: summary.payload_bytes,
                });
                Ok(path)
            }
            None => Err(SessionError::NotRecording),
        }
    }

    /// A session with no ports and no writer, for reading a finished vault.
    ///
    /// The engine still serves the contract and the frame window; nothing records, so a
    /// review cannot damage the file it opens. The vault itself is registered with the
    /// server, not with this session.
    pub fn review() -> Self {
        Self {
            mode: "review",
            ports: Vec::new(),
            writer: None,
            vault: String::new(),
            started: Instant::now(),
            started_epoch_ns: 0,
            chunks: 0,
            payload_bytes: 0,
            elf: None,
            bus: EventBus::new(),
            last_stats: Instant::now(),
            last_chunks: 0,
            control: None,
            yield_requests: Vec::new(),
            streams: Vec::new(),
            transport_generations: Vec::new(),
            faults: std::sync::Mutex::new(std::collections::HashMap::new()),
            image: None,
            bridges: Vec::new(),
            outboxes: Vec::new(),
            script: None,
            script_hooks: ScriptHooksMask::default(),
            script_spec: None,
            script_logs: Vec::new(),
            script_send_depth: 0,
            script_seq: 0,
            rx_script: None,
            encoders: Vec::new(),
            schemas: Arc::new(BTreeMap::new()),
            port_configs: Vec::new(),
            xfer: None,
            frames: std::collections::VecDeque::new(),
            frames_dropped: 0,
            chunks_received_dropped: 0,
            series: SeriesSet::new(),
        }
    }

    /// Subscribe to the event stream before pumping.
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<UiEvent> {
        self.bus.subscribe()
    }

    /// Join port pairs. A passive bridge only puts both sides in one timeline; a
    /// forwarding bridge also writes what one side receives to the other.
    pub fn enable_bridges(&mut self, bridges: &[BridgeConfig]) -> Result<(), SessionError> {
        let mut resolved = Vec::with_capacity(bridges.len());
        for bridge in bridges {
            let find = |id: &str| self.ports.iter().position(|port| port.info.id == id);
            let (Some(a), Some(b)) = (find(&bridge.a), find(&bridge.b)) else {
                return Err(SessionError::Settings(format!(
                    "bridge `{}` names a port that is not in this workspace",
                    bridge.id
                )));
            };
            resolved.push(Bridge {
                view: BridgeView {
                    id: bridge.id.clone(),
                    a: bridge.a.clone(),
                    b: bridge.b.clone(),
                    forward: bridge.forward,
                    forwarded: 0,
                    dropped: 0,
                },
                a,
                b,
            });
        }
        self.bridges = resolved;
        Ok(())
    }

    /// Load the HIL script that runs on every transmitted frame.
    pub fn enable_script(&mut self, path: &Path) -> Result<(), SessionError> {
        let runtime = ScriptRuntime::load(path)
            .map_err(|error| SessionError::Settings(format!("script: {error}")))?;
        let source = std::fs::read_to_string(path).ok();
        let snap = runtime.snapshot();
        let spec = ArmedScriptSpec {
            source,
            path: Some(path.to_path_buf()),
            name: path.display().to_string(),
            policy: snap.policy,
            memory_limit_bytes: snap.memory_limit_bytes,
            seed: None,
        };
        self.install_script(runtime, spec);
        Ok(())
    }

    /// Compile and arm an inline Lua 5.4 script from source text.
    pub fn arm_script_source(
        &mut self,
        source: &str,
        name: &str,
        policy: &str,
        memory_limit_bytes: Option<usize>,
        seed: Option<u64>,
    ) -> Result<ScriptStatusView, SessionError> {
        let parsed_policy = parse_fault_policy(policy)?;
        let limit = memory_limit_bytes.unwrap_or(bforge_script::DEFAULT_MEMORY_LIMIT_BYTES);
        let effective_name = if name.trim().is_empty() {
            "inline.lua"
        } else {
            name.trim()
        };
        let runtime =
            ScriptRuntime::compile_with_options(source, effective_name, parsed_policy, limit, seed)
                .map_err(|error| SessionError::Settings(error.to_string()))?;
        let actual_limit = runtime.snapshot().memory_limit_bytes;
        let spec = ArmedScriptSpec {
            source: Some(source.to_string()),
            path: None,
            name: effective_name.to_string(),
            policy: parsed_policy,
            memory_limit_bytes: actual_limit,
            seed,
        };
        self.install_script(runtime, spec);
        Ok(self.script_status().expect("script armed above"))
    }

    /// Disarm the active HIL script and clear its runtime state.
    pub fn disarm_script(&mut self) {
        self.script = None;
        self.script_hooks = ScriptHooksMask::default();
        self.script_spec = None;
    }

    /// Reset telemetry counters, assertions, and metrics by re-creating the armed VM.
    pub fn reset_script_stats(&mut self) -> Option<ScriptStatusView> {
        let spec = self.script_spec.clone()?;
        let runtime = if let Some(source) = &spec.source {
            ScriptRuntime::compile_with_options(
                source,
                &spec.name,
                spec.policy,
                spec.memory_limit_bytes,
                spec.seed,
            )
            .ok()
        } else if let Some(path) = &spec.path {
            ScriptRuntime::load(path).ok()
        } else {
            None
        };
        if let Some(runtime) = runtime {
            self.install_script(runtime, spec);
        }
        self.script_status()
    }

    /// Live telemetry view for the currently armed script, if any.
    pub fn script_status(&self) -> Option<ScriptStatusView> {
        let script = self.script.as_ref()?;
        let fallback = self.script_spec.as_ref().map(|spec| spec.name.as_str());
        Some(script_snapshot_to_view(script.snapshot(), fallback))
    }

    /// Source code of the currently armed script, when known.
    pub fn script_source(&self) -> Option<String> {
        self.script_spec
            .as_ref()
            .and_then(|spec| spec.source.clone())
    }

    /// Execute an arbitrary Lua script against one synthetic frame in isolation.
    #[allow(clippy::too_many_arguments)]
    pub fn dry_run_script(
        &self,
        source: &str,
        name: &str,
        policy: &str,
        seed: Option<u64>,
        port: &str,
        direction: &str,
        bridge: Option<&str>,
        bytes: &[u8],
        seq_id: Option<u64>,
        timestamp_us: Option<u64>,
    ) -> Result<ScriptDryRunView, SessionError> {
        let parsed_policy = parse_fault_policy(policy)?;
        let (hook_kind, dir_label) = parse_hook_direction(direction)?;
        let port_ir = if port.is_empty() {
            self.encoders.iter().find_map(|ir| ir.clone())
        } else {
            self.schemas
                .get(port)
                .or_else(|| self.schemas.get(&format!("port:{port}")))
                .cloned()
        };
        let meta = FrameMeta {
            port: port.to_string(),
            direction: dir_label.to_string(),
            seq_id: seq_id.unwrap_or(1),
            timestamp_us: timestamp_us.unwrap_or_else(|| self.started.elapsed().as_micros() as u64),
            bridge: bridge.filter(|s| !s.is_empty()).map(str::to_string),
        };
        let effective_name = if name.trim().is_empty() {
            "inline.lua"
        } else {
            name.trim()
        };
        let report = ScriptRuntime::dry_run(
            source,
            effective_name,
            parsed_policy,
            seed,
            Arc::clone(&self.schemas),
            port_ir,
            &meta,
            hook_kind,
            bytes,
        )
        .map_err(|error| SessionError::Settings(error.to_string()))?;
        Ok(dry_run_report_to_view(hex_of(bytes), report))
    }

    /// Drain buffered `(level, message)` logs emitted by `bforge.log` or timer errors.
    pub fn take_script_logs(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.script_logs)
    }

    fn install_script(&mut self, runtime: ScriptRuntime, spec: ArmedScriptSpec) {
        let runtime = runtime.with_schemas(Arc::clone(&self.schemas));
        let hooks = runtime.snapshot().hooks;
        self.script_hooks = ScriptHooksMask::from_hooks(&hooks);
        self.script_spec = Some(spec);
        self.script = Some(runtime);
        self.drain_script_actions();
    }

    /// Rebuild the shared multi-port/multi-schema lookup table and sync it onto
    /// armed script runtimes.
    fn rebuild_schema_map(&mut self) {
        let mut map = BTreeMap::new();
        for (index, slot) in self.encoders.iter().enumerate() {
            let Some(ir) = slot.as_ref() else {
                continue;
            };
            if let Some(port) = self.ports.get(index) {
                map.insert(port.info.id.clone(), ir.clone());
                map.insert(format!("port:{}", port.info.id), ir.clone());
            }
            let schema_name = match &ir.schema {
                SchemaSource::CHeader { root_struct, .. } => root_struct,
                SchemaSource::Protobuf { message, .. } => message,
                SchemaSource::Kaitai { type_name, .. } => type_name,
            };
            if !schema_name.is_empty() {
                map.insert(schema_name.clone(), ir.clone());
                map.insert(format!("schema:{schema_name}"), ir.clone());
                map.insert(format!("C_STRUCT:{schema_name}"), ir.clone());
            }
        }
        self.schemas = Arc::new(map);
        if let Some(script) = self.script.take() {
            self.script = Some(script.with_schemas(Arc::clone(&self.schemas)));
        }
        if let Some(rx_script) = self.rx_script.take() {
            self.rx_script = Some(rx_script.with_schemas(Arc::clone(&self.schemas)));
        }
    }

    /// Load the script that runs on what arrives, before framing.
    pub fn enable_rx_script(&mut self, path: &Path) -> Result<(), SessionError> {
        let runtime = ScriptRuntime::load(path)
            .map_err(|error| SessionError::Settings(format!("rx script: {error}")))?;
        self.rx_script = Some(runtime.with_schemas(Arc::clone(&self.schemas)));
        Ok(())
    }

    /// Script counters, for a report: changed, dropped and failed frames.
    pub fn script_report(&self) -> Option<(u64, u64, u64)> {
        self.script
            .as_ref()
            .map(|script| (script.changed, script.dropped, script.failures))
    }

    /// Load a firmware image so decoded addresses become function names.
    pub fn enable_symbols(&mut self, path: &Path) -> Result<(), SessionError> {
        let image = bforge_elf::ElfImage::load(path)
            .map_err(|error| SessionError::Settings(format!("{}: {error}", path.display())))?;
        self.image = Some(image);
        Ok(())
    }

    /// Apply a dialect parsed from UPLOADED text to one port's live stream
    /// (spec 2.2). The framing machine is rebuilt from the port's original
    /// config; only the dissector is swapped. Takes effect on the next chunk.
    pub fn apply_schema_text(
        &mut self,
        port_id: &str,
        kind: &str,
        text: &str,
        root: Option<&str>,
    ) -> Result<(), SessionError> {
        let index = self
            .ports
            .iter()
            .position(|port| port.info.id == port_id)
            .ok_or_else(|| SessionError::UnknownPort(port_id.to_string()))?;
        let mut config = self
            .port_configs
            .iter()
            .find(|config| config.id == port_id)
            .cloned()
            .ok_or_else(|| {
                SessionError::Settings(format!("port `{port_id}` has no decode config to override"))
            })?;
        config.dissector = Some(crate::DissectorConfig {
            kind: kind.to_string(),
            name: None,
            file: None,
            root_struct: root.map(|value| value.to_string()),
        });
        let machine = crate::tail::framing_machine(&config)
            .map_err(|error| SessionError::Settings(error.to_string()))?;
        let decoder = crate::tail::decoder_from_text(kind, text, root)
            .map_err(|error| SessionError::Settings(error.to_string()))?;
        if self.encoders.len() < self.ports.len() {
            self.encoders.resize(self.ports.len(), None);
        }
        self.encoders[index] = match &decoder {
            crate::tail::Decoder::Ir { ir, .. } => Some((**ir).clone()),
            _ => None,
        };
        self.streams[index] = Some(Stream::new(
            port_id,
            crate::tail::TailConfig {
                machine,
                dissector: Some(decoder),
            },
        ));
        self.rebuild_schema_map();
        Ok(())
    }

    /// Arm an X/YMODEM transfer on a port (spec 2.7). While armed, the port's
    /// raw bytes feed the state machine instead of the vault and streams.
    #[allow(clippy::too_many_arguments)]
    pub fn start_transfer(
        &mut self,
        port_id: &str,
        direction: crate::xmodem::XferDirection,
        mode: crate::xmodem::XferMode,
        name: String,
        data: Vec<u8>,
        expected_len: Option<usize>,
    ) -> Result<(), SessionError> {
        if self.xfer.is_some() {
            return Err(SessionError::Settings(
                "a transfer is already armed; cancel it first".into(),
            ));
        }
        if !self.ports.iter().any(|port| port.info.id == port_id) {
            return Err(SessionError::UnknownPort(port_id.to_string()));
        }
        let now = Instant::now();
        let mut session =
            crate::xmodem::XferSession::new(port_id, direction, mode, name, data, now);
        session.expected_len = expected_len;
        self.xfer = Some(session);
        Ok(())
    }

    /// Cancel the armed transfer, sending CAN CAN to the device.
    pub fn cancel_transfer(&mut self, port_id: &str) -> Result<(), SessionError> {
        match self.xfer.take() {
            Some(xfer) if xfer.port_id == port_id => {
                // CAN CAN aborts the device side of the protocol.
                let _ = self.send(port_id, vec![0x18, 0x18], Duration::from_secs(2));
                Ok(())
            }
            Some(xfer) => {
                self.xfer = Some(xfer);
                Err(SessionError::UnknownPort(port_id.to_string()))
            }
            None => Err(SessionError::Settings("no transfer armed".into())),
        }
    }

    /// The armed transfer's status, if any.
    pub fn transfer_status(&self, port_id: &str) -> Option<crate::contract::TransferView> {
        let xfer = self.xfer.as_ref()?;
        if xfer.port_id != port_id {
            return None;
        }
        let phase = match &xfer.phase {
            crate::xmodem::XferPhase::Handshake => "handshake".to_string(),
            crate::xmodem::XferPhase::Transferring => "transferring".to_string(),
            crate::xmodem::XferPhase::Finishing => "finishing".to_string(),
            crate::xmodem::XferPhase::Done => "done".to_string(),
            crate::xmodem::XferPhase::Failed(reason) => format!("failed:{reason}"),
        };
        Some(crate::contract::TransferView {
            port: xfer.port_id.clone(),
            name: xfer.name.clone(),
            direction: match xfer.direction {
                crate::xmodem::XferDirection::Send => "send".into(),
                crate::xmodem::XferDirection::Recv => "recv".into(),
            },
            phase,
            block: xfer.block,
            total_blocks: xfer.total_blocks(),
            bytes_done: xfer.bytes_done,
            total_bytes: xfer.data.len() as u64,
            retries: xfer.retries,
        })
    }

    /// The bytes a finished receive collected, draining them from the session.
    pub fn take_transfer_data(&mut self, port_id: &str) -> Result<Vec<u8>, SessionError> {
        match self.xfer.take() {
            Some(xfer)
                if xfer.port_id == port_id
                    && xfer.direction == crate::xmodem::XferDirection::Recv
                    && xfer.phase == crate::xmodem::XferPhase::Done =>
            {
                Ok(xfer.data)
            }
            Some(xfer) => {
                self.xfer = Some(xfer);
                Err(SessionError::Settings(
                    "transfer is not a finished receive".into(),
                ))
            }
            None => Err(SessionError::Settings("no transfer armed".into())),
        }
    }

    /// Feed the armed transfer one raw chunk and tick its timeouts. Returns
    /// the bytes the engine must transmit back to the device, if any.
    fn drive_transfer(&mut self, port_index: usize, chunk: &[u8]) -> Vec<u8> {
        let Some(xfer) = self.xfer.as_mut() else {
            return Vec::new();
        };
        if xfer.port_id != self.ports[port_index].info.id {
            return Vec::new();
        }
        let now = Instant::now();
        let mut out: Vec<u8> = Vec::new();
        if !chunk.is_empty() {
            xfer.on_chunk(chunk, now, &mut |bytes| out.extend_from_slice(&bytes));
        }
        xfer.tick(now, &mut |bytes| out.extend_from_slice(&bytes));
        if let Some(xfer) = self.xfer.as_ref()
            && xfer.phase == crate::xmodem::XferPhase::Done
        {
            self.bus.publish(UiEvent::Transfer {
                at_ms: self.started.elapsed().as_millis() as u64,
                port: xfer.port_id.clone(),
                name: xfer.name.clone(),
                phase: "done".into(),
                block: xfer.block,
                total_blocks: xfer.total_blocks(),
                bytes_done: xfer.bytes_done,
            });
        }
        out
    }

    /// Frame and decode the bytes as they pass, for a UI that shows frames.
    ///
    /// The vault stays raw: this is a second view of the same chunks, not a change
    /// to what is recorded. A port without a config is left undecoded.
    pub fn enable_decode(&mut self, configs: &[PortConfig]) -> Result<(), TailError> {
        // Stash the configs so a later schema upload can rebuild a stream
        // with the same framing but a new dissector (spec 2.2).
        self.port_configs = configs.to_vec();
        let mut streams = Vec::with_capacity(self.ports.len());
        for port in &self.ports {
            match configs.iter().find(|config| config.id == port.info.id) {
                Some(config) => {
                    streams.push(Some(Stream::new(&port.info.id, tail_config(config)?)))
                }
                None => streams.push(None),
            }
        }
        self.streams = streams;
        self.encoders = self
            .ports
            .iter()
            .map(|port| {
                configs
                    .iter()
                    .find(|config| config.id == port.info.id)
                    .and_then(crate::tail::encoder_ir)
            })
            .collect();
        self.rebuild_schema_map();
        Ok(())
    }

    /// Encode a frame from named values and send it.
    ///
    /// This is the typed half of the send path: the same schema that decodes a frame
    /// writes one, so a form and a decoder cannot drift apart.
    pub fn send_values(
        &mut self,
        port: &str,
        values: &std::collections::BTreeMap<String, bforge_dissect::encoder::Value>,
        wait: Duration,
    ) -> Result<FaultOutcome, SessionError> {
        let index = self
            .ports
            .iter()
            .position(|running| running.info.id == port)
            .ok_or_else(|| SessionError::UnknownPort(port.to_string()))?;
        let Some(ir) = self.encoders.get(index).and_then(|ir| ir.as_ref()) else {
            return Err(SessionError::Settings(format!(
                "port `{port}` has no C header schema to encode with"
            )));
        };
        let bytes = bforge_dissect::encoder::encode(ir, values)
            .map_err(|error| SessionError::Settings(error.to_string()))?;
        self.send(port, bytes, wait)
    }

    /// Take the frames completed since the last call, oldest first.
    fn push_frame(&mut self, row: TailRow) {
        if self.frames.len() >= FRAME_QUEUE {
            self.frames.pop_front();
            self.frames_dropped += 1;
        }
        self.frames.push_back(row);
    }

    pub fn take_frames(&mut self) -> Vec<TailRow> {
        self.frames.drain(..).collect()
    }

    /// Frames thrown away because the reader did not keep up.
    pub fn frames_dropped(&self) -> u64 {
        self.frames_dropped
    }

    /// Drive DTR and RTS, or pulse them, so a board can be reset from the workbench.
    ///
    /// The reader thread performs the change: it owns the transport.
    pub fn set_pins(
        &self,
        port: &str,
        dtr: bool,
        rts: bool,
        pulse: Option<Duration>,
    ) -> Result<(), SessionError> {
        let index = self.port_index(port)?;
        let running = &self.ports[index];
        let mut pins = PinStateFlags(0);
        if dtr {
            pins.insert(PinStateFlags::DTR);
        }
        if rts {
            pins.insert(PinStateFlags::RTS);
        }
        running
            .pipeline
            .set_pins(pins, pulse, Duration::from_secs(2))
            .map_err(SessionError::Write)
    }

    /// Run a timed sequence of pin changes on a port's reader thread.
    ///
    /// Executes the steps in order without starving reads between steps.
    /// Returns the updated [`PinsView`].
    pub fn run_pin_sequence(
        &mut self,
        port: &str,
        steps: Vec<PinStep>,
    ) -> Result<PinsView, SessionError> {
        let index = self.port_index(port)?;
        let running = &mut self.ports[index];
        let pins_out = running
            .pipeline
            .run_pin_sequence(steps)
            .map_err(SessionError::Write)?;
        let stats = running.pipeline.stats();
        let view = PinsView {
            cts: stats.line_state & PinStateFlags::CTS.0 != 0,
            dsr: stats.line_state & PinStateFlags::DSR.0 != 0,
            dcd: stats.line_state & PinStateFlags::DCD.0 != 0,
            ri: stats.line_state & PinStateFlags::RI.0 != 0,
            break_state: stats.line_state & PinStateFlags::BREAK.0 != 0,
            framing_error: stats.line_state & PinStateFlags::FRAMING_ERR.0 != 0,
            parity_error: stats.line_state & PinStateFlags::PARITY_ERR.0 != 0,
            dtr: pins_out & PinStateFlags::DTR.0 != 0,
            rts: pins_out & PinStateFlags::RTS.0 != 0,
        };
        running.info.pins = view;
        Ok(view)
    }

    /// Send bytes to a port and report how many the transport accepted.
    ///
    /// The reader thread performs the write: it owns the transport, so a write from
    /// another thread would race it.
    pub fn send(
        &mut self,
        port: &str,
        bytes: Vec<u8>,
        wait: Duration,
    ) -> Result<FaultOutcome, SessionError> {
        let index = self.port_index(port)?;
        let Some((bytes, mut outcome)) = self.apply_fault_profile(port, bytes) else {
            return Ok(dropped_outcome());
        };

        // The script sees what the fault profile made of the frame, which is what
        // would leave the engine if the script said nothing.
        let verdict = if self.script_hooks.tx && self.script_send_depth == 0 {
            self.run_script_tx_hook(port, &bytes)
        } else {
            FrameVerdict::Send(bytes)
        };
        let result = self.write_tx_verdict(index, verdict, &mut outcome, 0, Some(wait));
        self.drain_script_actions();
        result
    }

    /// Send bytes with pacing between chunks on the port's reader thread.
    ///
    /// Paced sending breaks large byte buffers into chunks with delay between them
    /// so the receiver does not overrun, while servicing reads between chunks.
    pub fn send_paced(
        &mut self,
        port: &str,
        bytes: &[u8],
        chunk_size: usize,
        pace_ms: u64,
    ) -> Result<FaultOutcome, SessionError> {
        let index = self.port_index(port)?;
        let Some((bytes, mut outcome)) = self.apply_fault_profile(port, bytes.to_vec()) else {
            return Ok(dropped_outcome());
        };

        let verdict = if self.script_hooks.tx && self.script_send_depth == 0 {
            self.run_script_tx_hook(port, &bytes)
        } else {
            FrameVerdict::Send(bytes)
        };

        let pace = Duration::from_millis(pace_ms);
        let settled = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicU64::new(0));
        let pipeline = &self.ports[index].pipeline;

        let result = match verdict {
            FrameVerdict::Drop => Ok(dropped_outcome()),
            FrameVerdict::Send(next) => {
                outcome.sent = next.len();
                post_after_paced(
                    pipeline,
                    next,
                    chunk_size,
                    pace,
                    outcome.delay,
                    &settled,
                    &failed,
                )
                .map(|()| outcome)
            }
            FrameVerdict::Delay {
                bytes: next,
                delay_ms,
            } => {
                outcome.delay = combine_delay(outcome.delay, delay_ms);
                outcome.sent = next.len();
                post_after_paced(
                    pipeline,
                    next,
                    chunk_size,
                    pace,
                    outcome.delay,
                    &settled,
                    &failed,
                )
                .map(|()| outcome)
            }
            FrameVerdict::Burst(frames) => {
                if frames.is_empty() {
                    Ok(dropped_outcome())
                } else {
                    let mut total_sent = 0usize;
                    let mut max_delay = outcome.delay;
                    for (frame_bytes, frame_delay_ms) in frames {
                        let initial_delay = combine_delay(outcome.delay, frame_delay_ms);
                        if let Some(d) = initial_delay {
                            max_delay = Some(max_delay.map_or(d, |cur| cur.max(d)));
                        }
                        total_sent += frame_bytes.len();
                        post_after_paced(
                            pipeline,
                            frame_bytes,
                            chunk_size,
                            pace,
                            initial_delay,
                            &settled,
                            &failed,
                        )?;
                    }
                    outcome.sent = total_sent;
                    outcome.delay = max_delay;
                    Ok(outcome)
                }
            }
        };
        self.drain_script_actions();
        result
    }

    fn port_index(&self, port: &str) -> Result<usize, SessionError> {
        if (port == "*" || port.is_empty()) && !self.ports.is_empty() {
            return Ok(0);
        }
        self.ports
            .iter()
            .position(|running| running.info.id == port)
            .ok_or_else(|| SessionError::UnknownPort(port.to_string()))
    }

    fn apply_fault_profile(&self, port: &str, bytes: Vec<u8>) -> Option<(Vec<u8>, FaultOutcome)> {
        let mut faults = self.faults.lock().unwrap();
        match faults.get_mut(port) {
            Some(injector) => injector.apply(bytes),
            None => {
                let sent = bytes.len();
                Some((
                    bytes,
                    FaultOutcome {
                        sent,
                        delay: None,
                        bytes: 0,
                        dropped: false,
                    },
                ))
            }
        }
    }

    fn next_script_seq(&mut self) -> u64 {
        self.script_seq = self.script_seq.saturating_add(1);
        self.script_seq
    }

    fn run_script_tx_hook(&mut self, port: &str, bytes: &[u8]) -> FrameVerdict {
        let seq_id = self.next_script_seq();
        let timestamp_us = self.started.elapsed().as_micros() as u64;
        let Some(script) = self.script.as_mut() else {
            return FrameVerdict::Send(bytes.to_vec());
        };
        let meta = FrameMeta {
            port: port.to_string(),
            direction: "tx".to_string(),
            seq_id,
            timestamp_us,
            bridge: None,
        };
        script.run_with_meta(HookKind::Tx, &meta, bytes)
    }

    fn write_tx_verdict(
        &self,
        port_index: usize,
        verdict: FrameVerdict,
        outcome: &mut FaultOutcome,
        extra_delay_ms: u16,
        sync_wait: Option<Duration>,
    ) -> Result<FaultOutcome, SessionError> {
        let pipeline = &self.ports[port_index].pipeline;
        match verdict {
            FrameVerdict::Drop => Ok(dropped_outcome()),
            FrameVerdict::Send(bytes) => {
                let due = combine_delay(outcome.delay, extra_delay_ms);
                outcome.delay = due;
                dispatch_single_tx(pipeline, bytes, outcome, due, sync_wait)?;
                Ok(*outcome)
            }
            FrameVerdict::Delay { bytes, delay_ms } => {
                let due = combine_delay(outcome.delay, extra_delay_ms.saturating_add(delay_ms));
                outcome.delay = due;
                dispatch_single_tx(pipeline, bytes, outcome, due, sync_wait)?;
                Ok(*outcome)
            }
            FrameVerdict::Burst(frames) => {
                if frames.is_empty() {
                    return Ok(dropped_outcome());
                }
                let settled = Arc::new(AtomicU64::new(0));
                let failed = Arc::new(AtomicU64::new(0));
                let mut total_sent = 0usize;
                let mut max_delay = outcome.delay;
                for (frame_bytes, frame_delay_ms) in frames {
                    let due =
                        combine_delay(outcome.delay, extra_delay_ms.saturating_add(frame_delay_ms));
                    if let Some(d) = due {
                        max_delay = Some(max_delay.map_or(d, |cur| cur.max(d)));
                    }
                    total_sent += frame_bytes.len();
                    pipeline
                        .post_after(frame_bytes, Arc::clone(&settled), Arc::clone(&failed), due)
                        .map_err(SessionError::Write)?;
                }
                outcome.sent = total_sent;
                outcome.delay = max_delay;
                Ok(*outcome)
            }
        }
    }

    fn send_from_script(
        &mut self,
        port: &str,
        bytes: Vec<u8>,
        delay_ms: u16,
        run_tx_hooks: bool,
    ) -> Result<FaultOutcome, SessionError> {
        let index = self.port_index(port)?;
        let resolved_port = self.ports[index].info.id.clone();
        let Some((bytes, mut outcome)) = self.apply_fault_profile(&resolved_port, bytes) else {
            return Ok(dropped_outcome());
        };
        let verdict = if run_tx_hooks && self.script_send_depth == 0 && self.script_hooks.tx {
            self.script_send_depth += 1;
            let result = self.run_script_tx_hook(&resolved_port, &bytes);
            self.script_send_depth -= 1;
            result
        } else {
            FrameVerdict::Send(bytes)
        };
        self.write_tx_verdict(index, verdict, &mut outcome, delay_ms, None)
    }

    /// Arm a fault profile on a port. Sends through that port are changed from now
    /// on, and the seed makes the changes reproducible.
    pub fn arm_fault(&mut self, port: &str, profile: FaultProfile) -> Result<(), SessionError> {
        if !self.ports.iter().any(|running| running.info.id == port) {
            return Err(SessionError::UnknownPort(port.to_string()));
        }
        self.faults
            .lock()
            .unwrap()
            .insert(port.to_string(), Injector::new(profile));
        Ok(())
    }

    /// Disarm the profile on a port.
    pub fn disarm_fault(&mut self, port: &str) {
        self.faults.lock().unwrap().remove(port);
    }

    /// Take the numeric samples added since the last call.
    pub fn take_series(&mut self) -> Vec<SeriesUpdate> {
        self.series.take()
    }

    /// The series the decoder has seen, for a client that asks what it can plot.
    pub fn series_keys(&self) -> Vec<(String, String)> {
        self.series.keys()
    }

    /// Move ready chunks into the vault. Returns how many moved.
    pub fn pump_once(&mut self) -> Result<usize, SessionError> {
        // A reconnect (or a yield/reclaim cycle) invalidates whatever the
        // framing machine buffered: drop it before any post-reconnect slab is
        // fed, checked before the drain so the reset always wins the race (F-24).
        if self.transport_generations.len() < self.ports.len() {
            self.transport_generations.resize(self.ports.len(), (0, 0));
        }
        for index in 0..self.ports.len() {
            let stats = self.ports[index].pipeline.stats();
            let generation = (stats.reconnects, stats.yields);
            if generation != self.transport_generations[index] {
                self.transport_generations[index] = generation;
                if let Some(Some(stream)) = self.streams.get_mut(index) {
                    stream.reset_machine();
                }
            }
        }
        let mut moved = 0;
        let mut crossed: Vec<Vec<u8>> = vec![Vec::new(); self.ports.len()];
        #[allow(clippy::needless_range_loop)] // `crossed` exists only to be indexed here
        for index in 0..self.ports.len() {
            let mut taken = 0;
            while taken < PUMP_BUDGET {
                let Ok(slab) = self.ports[index].logger.pop() else {
                    break;
                };
                taken += 1;

                // An armed X/YMODEM transfer consumes the port's raw bytes
                // directly (spec 2.7): transfer traffic is protocol noise, not
                // session data, so it bypasses the vault and the decoders.
                if self
                    .xfer
                    .as_ref()
                    .is_some_and(|x| x.port_id == self.ports[index].info.id)
                {
                    let reply = self.drive_transfer(index, slab.bytes());
                    if !reply.is_empty() {
                        let port_id = self.ports[index].info.id.clone();
                        self.send(&port_id, reply, Duration::from_secs(2))?;
                    }
                    continue;
                }

                // A receive script sees the bytes before the vault and the decoder,
                // so a test can prove the host rejects what is corrupted (D-84).
                let rx_meta = FrameMeta {
                    port: self.ports[index].info.id.clone(),
                    direction: "rx".to_string(),
                    seq_id: slab.meta.seq_id,
                    timestamp_us: slab.meta.timestamp_ns / 1_000,
                    bridge: None,
                };
                let chunks_after_rx_script = match self.rx_script.as_mut() {
                    Some(script) => {
                        match script.run_with_meta(HookKind::Rx, &rx_meta, slab.bytes()) {
                            FrameVerdict::Send(next) | FrameVerdict::Delay { bytes: next, .. } => {
                                vec![next]
                            }
                            FrameVerdict::Drop => {
                                self.chunks_received_dropped += 1;
                                continue;
                            }
                            FrameVerdict::Burst(frames) => {
                                frames.into_iter().map(|(bytes, _)| bytes).collect()
                            }
                        }
                    }
                    None => vec![slab.bytes().to_vec()],
                };
                let raw_chunks = if self.script_hooks.raw_chunk {
                    let mut out = Vec::new();
                    for chunk in chunks_after_rx_script {
                        if let Some(script) = self.script.as_mut() {
                            match script.run_with_meta(HookKind::RawChunk, &rx_meta, &chunk) {
                                FrameVerdict::Send(next)
                                | FrameVerdict::Delay { bytes: next, .. } => out.push(next),
                                FrameVerdict::Drop => {
                                    self.chunks_received_dropped += 1;
                                }
                                FrameVerdict::Burst(frames) => {
                                    out.extend(frames.into_iter().map(|(bytes, _)| bytes));
                                }
                            }
                        } else {
                            out.push(chunk);
                        }
                    }
                    if out.is_empty() {
                        continue;
                    }
                    out
                } else {
                    chunks_after_rx_script
                };
                let meta = slab.meta;
                for payload in raw_chunks {
                    if let Some(writer) = self.writer.as_mut() {
                        let chunk = RawChunk {
                            seq_id: meta.seq_id,
                            timestamp_ns: meta.timestamp_ns,
                            port_id: meta.port_id,
                            direction: meta.direction,
                            line_state: meta.line_state,
                            payload_offset: 0,
                            payload_len: payload.len() as u32,
                        };
                        writer.append(&chunk, &payload)?;
                    }
                    if let Some(bridge) = self
                        .bridges
                        .iter()
                        .find(|bridge| bridge.a == index || bridge.b == index)
                        && bridge.view.forward
                    {
                        let bridge_bytes = if self.script_hooks.raw_chunk {
                            payload.as_slice()
                        } else {
                            slab.bytes()
                        };
                        crossed[index].extend_from_slice(bridge_bytes);
                    }
                    let rows = self
                        .streams
                        .get_mut(index)
                        .and_then(|slot| slot.as_mut())
                        .map(|stream| stream.feed(meta.timestamp_ns, &payload))
                        .unwrap_or_default();
                    for row in rows {
                        if self.script_hooks.rx && self.script.is_some() {
                            let frame_meta = FrameMeta {
                                port: self.ports[index].info.id.clone(),
                                direction: "rx".to_string(),
                                seq_id: meta.seq_id,
                                timestamp_us: meta.timestamp_ns / 1_000,
                                bridge: None,
                            };
                            let verdict = self.script.as_mut().unwrap().run_with_meta(
                                HookKind::Rx,
                                &frame_meta,
                                &row.raw,
                            );
                            match verdict {
                                FrameVerdict::Drop => continue,
                                FrameVerdict::Send(next)
                                | FrameVerdict::Delay { bytes: next, .. } => {
                                    let mut row = row;
                                    if next != row.raw
                                        && let Some(Some(stream)) = self.streams.get(index)
                                    {
                                        stream.redecode_row(&mut row, next);
                                    }
                                    self.emit_rx_row(row);
                                }
                                FrameVerdict::Burst(frames) => {
                                    for (bytes, _delay_ms) in frames {
                                        let mut cloned = row.clone();
                                        if bytes != cloned.raw
                                            && let Some(Some(stream)) = self.streams.get(index)
                                        {
                                            stream.redecode_row(&mut cloned, bytes);
                                        }
                                        self.emit_rx_row(cloned);
                                    }
                                }
                            }
                        } else {
                            self.emit_rx_row(row);
                        }
                    }
                    self.chunks += 1;
                    self.payload_bytes += payload.len() as u64;
                    moved += 1;
                }
            }
        }
        // Drive transfer timeouts/handshake polling once per pump cycle.
        let armed = self
            .xfer
            .as_ref()
            .map(|xfer| (xfer.port_id.clone(), xfer.phase.clone()))
            .filter(|(port_id, _)| self.ports.iter().any(|port| port.info.id == *port_id));
        if let Some((port_id, _)) = armed {
            let index = self
                .ports
                .iter()
                .position(|port| port.info.id == port_id)
                .unwrap();
            let reply = self.drive_transfer(index, &[]);
            if !reply.is_empty() {
                self.send(&port_id, reply, Duration::from_secs(2))?;
            }
        }
        self.forward(&mut crossed)?;
        if self.script.is_some() {
            let now_ms = self.started.elapsed().as_millis() as u64;
            match self.script.as_mut().unwrap().tick_timers(now_ms) {
                Ok(actions) => self.apply_script_actions(actions),
                Err(error) => self
                    .script_logs
                    .push(("error".to_string(), format!("script timer error: {error}"))),
            }
            self.drain_script_actions();
        }
        // A scrubber reads the vault from another thread, so what is appended must
        // reach the operating system now, not when the 64 KiB buffer fills.
        if moved > 0
            && let Some(writer) = self.writer.as_mut()
        {
            writer.flush()?;
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
        // A review has no ports and no writer, so a stats event every interval is noise.
        if self.ports.is_empty() && self.writer.is_none() {
            return;
        }
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
        let at_ms = self.started.elapsed().as_millis() as u64;
        let mut changes = Vec::new();
        for port in &mut self.ports {
            let stats = port.pipeline.stats();
            let state = stats.state.as_str().to_string();
            if port.info.state != state {
                port.info.state = state.clone();
                changes.push((port.info.id.clone(), state));
            }
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
                dtr: stats.pins_out & PinStateFlags::DTR.0 != 0,
                rts: stats.pins_out & PinStateFlags::RTS.0 != 0,
            };
            if stats.overruns > port.info.overruns {
                port.info.overruns = stats.overruns;
                self.bus.publish(UiEvent::Overrun {
                    at_ms,
                    port: port.info.id.clone(),
                    total: stats.overruns,
                });
            }
        }
        for (port, state) in changes {
            self.bus
                .publish(UiEvent::PortStateChanged { at_ms, port, state });
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
            bridges: self
                .bridges
                .iter()
                .map(|bridge| bridge.view.clone())
                .collect(),
            transfers: self
                .xfer
                .as_ref()
                .and_then(|x| self.transfer_status(&x.port_id))
                .into_iter()
                .collect(),
            script: self.script_status(),
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

    /// Release a port so a flash tool can use it. False when the id is unknown.
    pub fn yield_port(&self, port: &str, duration: Duration) -> bool {
        match self.yield_requests.iter().find(|(id, _)| id == port) {
            Some((_, request)) => {
                request.request(duration);
                true
            }
            None => false,
        }
    }

    /// Take a yielded port back before its window ends. False when unknown.
    /// Harmless when the port is not currently yielded.
    pub fn end_yield(&self, port: &str) -> bool {
        match self.yield_requests.iter().find(|(id, _)| id == port) {
            Some((_, request)) => {
                request.cancel();
                true
            }
            None => false,
        }
    }

    /// Where a client can reach this session's control plane, if it has one.
    pub fn control_address(&self) -> Option<std::net::SocketAddr> {
        self.control.as_ref().map(ControlServer::address)
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

        let transport_name = port.transport.as_deref().unwrap_or("serial");
        let (device, transport): (String, Box<dyn TransportDriver + Send>) = match transport_name {
            "serial" => {
                let Some(device) = resolve_device(port, &devices, strictly) else {
                    return Err(SessionError::NoDevice(port.id.clone()));
                };
                let transport = UartTransport::new(UartConfig {
                    device: device.clone(),
                    line: LineConfig {
                        baud_rate: port.baud_rate,
                        ..Default::default()
                    },
                    read_timeout: Duration::from_millis(50),
                });
                (device, Box::new(transport))
            }
            "tcp-client" | "tcp-server" | "udp" => {
                let address = port.address.clone().ok_or_else(|| {
                    SessionError::Settings(format!(
                        "port `{}` uses `{transport_name}` and needs an address",
                        port.id
                    ))
                })?;
                let transport: Box<dyn TransportDriver + Send> = match transport_name {
                    "tcp-client" => Box::new(TcpTransport::new(TcpConfig::client(address.clone()))),
                    "tcp-server" => Box::new(TcpTransport::new(TcpConfig::server(address.clone()))),
                    _ => Box::new(UdpTransport::new(UdpConfig::new(address.clone(), None))),
                };
                (address, transport)
            }
            other => {
                return Err(SessionError::Settings(format!(
                    "port `{}` names transport `{other}`, which is not serial, tcp-client, tcp-server or udp",
                    port.id
                )));
            }
        };

        ports.push(SessionPort {
            id: port.id.clone(),
            device,
            baud_rate: port.baud_rate,
            framing: port.framing.mode.clone(),
            checksum: port.framing.crc.clone(),
            transport,
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

/// Resolve a frame's plausible addresses against the loaded image.
fn symbolize_for(image: &bforge_elf::ElfImage, row: &TailRow) -> Vec<crate::tail::SymbolHit> {
    let fields: Vec<(String, Option<f64>)> = row
        .fields
        .iter()
        .map(|field| (field.name.clone(), field.value_num))
        .collect();
    symbolize(&fields, |address| {
        image.resolve(address).map(|location| {
            let line = (location.line > 0).then_some(location.line);
            let file = (!location.file.is_empty()).then_some(location.file);
            (location.function, file, line)
        })
    })
}

impl Session {
    /// Post what one side received to the other side, and record the copy.
    ///
    /// Nothing waits here: the reader writes on its own thread, and how much has
    /// landed is kept in per-port counters. A port that stops accepting therefore
    /// costs a queue, not the pump.
    fn forward(&mut self, crossed: &mut [Vec<u8>]) -> Result<(), SessionError> {
        if self.bridges.is_empty() {
            return Ok(());
        }
        let now_ns = self.started.elapsed().as_nanos() as u64;
        for bridge_index in 0..self.bridges.len() {
            let (a, b) = (self.bridges[bridge_index].a, self.bridges[bridge_index].b);
            let bridge_id = self.bridges[bridge_index].view.id.clone();
            for (from, to) in [(a, b), (b, a)] {
                if crossed[from].is_empty() {
                    continue;
                }
                let bytes = std::mem::take(&mut crossed[from]);
                let items: Vec<(Vec<u8>, Option<Duration>)> =
                    if self.script_hooks.mitm && self.script.is_some() {
                        let seq_id = self.next_script_seq();
                        let direction = if from == a {
                            "mitm_a_to_b"
                        } else {
                            "mitm_b_to_a"
                        };
                        let meta = FrameMeta {
                            port: self.ports[from].info.id.clone(),
                            direction: direction.to_string(),
                            seq_id,
                            timestamp_us: now_ns / 1_000,
                            bridge: Some(bridge_id.clone()),
                        };
                        match self.script.as_mut().unwrap().run_with_meta(
                            HookKind::Mitm,
                            &meta,
                            &bytes,
                        ) {
                            FrameVerdict::Drop => {
                                self.bridges[bridge_index].view.dropped += bytes.len() as u64;
                                continue;
                            }
                            FrameVerdict::Send(next) => vec![(next, None)],
                            FrameVerdict::Delay {
                                bytes: next,
                                delay_ms,
                            } => vec![(
                                next,
                                (delay_ms > 0).then(|| Duration::from_millis(u64::from(delay_ms))),
                            )],
                            FrameVerdict::Burst(frames) => frames
                                .into_iter()
                                .map(|(frame_bytes, delay_ms)| {
                                    (
                                        frame_bytes,
                                        (delay_ms > 0)
                                            .then(|| Duration::from_millis(u64::from(delay_ms))),
                                    )
                                })
                                .collect(),
                        }
                    } else {
                        vec![(bytes, None)]
                    };

                for (item_bytes, due) in items {
                    let len = item_bytes.len() as u64;
                    let (settled, failed, waiting) = {
                        let outbox = &self.outboxes[to];
                        let posted = outbox.posted.load(std::sync::atomic::Ordering::Relaxed);
                        let settled_n = outbox.settled.load(std::sync::atomic::Ordering::Relaxed);
                        let failed_n = outbox.failed.load(std::sync::atomic::Ordering::Relaxed);
                        (
                            Arc::clone(&outbox.settled),
                            Arc::clone(&outbox.failed),
                            posted.saturating_sub(settled_n).saturating_sub(failed_n),
                        )
                    };
                    if waiting + len > FORWARD_LIMIT {
                        self.bridges[bridge_index].view.dropped += len;
                        continue;
                    }
                    self.ports[to]
                        .pipeline
                        .post_after(item_bytes.clone(), settled, failed, due)
                        .map_err(|error| {
                            SessionError::Write(format!(
                                "bridge `{}` could not reach `{}`: {error}",
                                bridge_id, self.ports[to].info.id
                            ))
                        })?;
                    self.outboxes[to]
                        .posted
                        .fetch_add(len, std::sync::atomic::Ordering::Relaxed);
                    self.bridges[bridge_index].view.forwarded += len;
                    // The workbench shows what left the engine, not only what arrived: a
                    // bridged session that looked receive-only was D-79.
                    let row = crate::tail::sent_row(&self.ports[to].info.id, now_ns, &item_bytes);
                    self.push_frame(row);
                    // The vault records what the engine was told to send, so a bridged
                    // session is auditable; `failed` says how much a transport refused.
                    if let Some(writer) = self.writer.as_mut() {
                        let chunk = RawChunk {
                            seq_id: self.chunks,
                            timestamp_ns: now_ns,
                            port_id: to as u16,
                            direction: Direction::Tx,
                            line_state: PinStateFlags::default(),
                            payload_offset: 0,
                            payload_len: item_bytes.len() as u32,
                        };
                        writer.append(&chunk, &item_bytes)?;
                        writer.flush()?;
                        self.chunks += 1;
                        self.payload_bytes += len;
                    }
                }
            }
        }
        Ok(())
    }

    fn emit_rx_row(&mut self, mut row: TailRow) {
        if let Some(image) = &self.image {
            row.symbols = symbolize_for(image, &row);
        }
        self.series.sample(&row);
        self.push_frame(row);
    }

    fn drain_script_actions(&mut self) {
        let Some(actions) = self.script.as_mut().map(ScriptRuntime::drain_actions) else {
            return;
        };
        self.apply_script_actions(actions);
    }

    fn apply_script_actions(&mut self, actions: Vec<ScriptAction>) {
        if actions.is_empty() {
            return;
        }
        let mut sends_dispatched = 0usize;
        for action in actions {
            match action {
                ScriptAction::Send {
                    port,
                    bytes,
                    delay_ms,
                    run_tx_hooks,
                } => {
                    if sends_dispatched >= MAX_SCRIPT_SENDS_PER_PUMP {
                        if sends_dispatched == MAX_SCRIPT_SENDS_PER_PUMP {
                            sends_dispatched += 1;
                            self.script_logs.push((
                                "warn".to_string(),
                                format!(
                                    "script send budget ({MAX_SCRIPT_SENDS_PER_PUMP}/pump) exceeded; dropping excess sends"
                                ),
                            ));
                        }
                        continue;
                    }
                    sends_dispatched += 1;
                    if let Err(error) = self.send_from_script(&port, bytes, delay_ms, run_tx_hooks)
                    {
                        self.script_logs.push((
                            "warn".to_string(),
                            format!("script send on `{port}` failed: {error}"),
                        ));
                    }
                }
                ScriptAction::SetPins { port, dtr, rts } => {
                    if let Err(error) = self.set_pins(&port, dtr, rts, None) {
                        self.script_logs.push((
                            "warn".to_string(),
                            format!("script set_pins on `{port}` failed: {error}"),
                        ));
                    }
                }
                ScriptAction::PulsePin {
                    port,
                    pin,
                    duration_ms,
                } => {
                    if let Err(error) = self.pulse_pin_from_script(&port, &pin, duration_ms) {
                        self.script_logs.push((
                            "warn".to_string(),
                            format!("script pulse_pin on `{port}` failed: {error}"),
                        ));
                    }
                }
                ScriptAction::Plot { series, value, .. } => {
                    let field = if series.starts_with("script:") {
                        series
                    } else {
                        format!("script:{series}")
                    };
                    self.series.push_custom("script", &field, value);
                }
                ScriptAction::Log { level, message } => {
                    self.script_logs.push((level, message));
                }
            }
        }
    }

    fn pulse_pin_from_script(
        &mut self,
        port: &str,
        pin: &str,
        duration_ms: u16,
    ) -> Result<(), SessionError> {
        let wait_ms = u64::from(duration_ms.max(1));
        let steps = if pin.eq_ignore_ascii_case("DTR") {
            vec![
                PinStep {
                    dtr: Some(true),
                    rts: None,
                    wait_ms,
                },
                PinStep {
                    dtr: Some(false),
                    rts: None,
                    wait_ms: 0,
                },
            ]
        } else if pin.eq_ignore_ascii_case("RTS") {
            vec![
                PinStep {
                    dtr: None,
                    rts: Some(true),
                    wait_ms,
                },
                PinStep {
                    dtr: None,
                    rts: Some(false),
                    wait_ms: 0,
                },
            ]
        } else {
            return Err(SessionError::Settings(format!(
                "unknown pin `{pin}` for pulse_pin (expected DTR or RTS)"
            )));
        };
        self.run_pin_sequence(port, steps).map(|_| ())
    }
}

fn dropped_outcome() -> FaultOutcome {
    FaultOutcome {
        sent: 0,
        delay: None,
        bytes: 0,
        dropped: true,
    }
}

fn combine_delay(existing: Option<Duration>, delay_ms: u16) -> Option<Duration> {
    if delay_ms == 0 {
        return existing;
    }
    let added = Duration::from_millis(u64::from(delay_ms));
    Some(existing.map_or(added, |base| base + added))
}

fn dispatch_single_tx(
    pipeline: &Pipeline,
    bytes: Vec<u8>,
    outcome: &mut FaultOutcome,
    due: Option<Duration>,
    sync_wait: Option<Duration>,
) -> Result<(), SessionError> {
    match (due, sync_wait) {
        (None, Some(wait)) => {
            outcome.sent = pipeline.write(bytes, wait).map_err(SessionError::Write)?;
        }
        (delay, _) => {
            let settled = Arc::new(AtomicU64::new(0));
            let failed = Arc::new(AtomicU64::new(0));
            outcome.sent = bytes.len();
            pipeline
                .post_after(bytes, settled, failed, delay)
                .map_err(SessionError::Write)?;
        }
    }
    Ok(())
}

fn post_after_paced(
    pipeline: &Pipeline,
    bytes: Vec<u8>,
    chunk_size: usize,
    pace: Duration,
    initial_delay: Option<Duration>,
    settled: &Arc<AtomicU64>,
    failed: &Arc<AtomicU64>,
) -> Result<(), SessionError> {
    let mut due = initial_delay;
    if chunk_size == 0 || bytes.len() <= chunk_size {
        return pipeline
            .post_after(bytes, Arc::clone(settled), Arc::clone(failed), due)
            .map_err(SessionError::Write);
    }
    for chunk_start in (0..bytes.len()).step_by(chunk_size) {
        let chunk_end = (chunk_start + chunk_size).min(bytes.len());
        pipeline
            .post_after(
                bytes[chunk_start..chunk_end].to_vec(),
                Arc::clone(settled),
                Arc::clone(failed),
                due,
            )
            .map_err(SessionError::Write)?;
        due = Some(due.map_or(pace, |delay| delay + pace));
    }
    Ok(())
}

fn parse_fault_policy(policy: &str) -> Result<FaultPolicy, SessionError> {
    match policy.trim() {
        "" | "fail_open" => Ok(FaultPolicy::FailOpen),
        "fail_closed" => Ok(FaultPolicy::FailClosed),
        other => Err(SessionError::Settings(format!(
            "unknown script fault policy `{other}`; expected fail_open or fail_closed"
        ))),
    }
}

fn parse_hook_direction(direction: &str) -> Result<(HookKind, &'static str), SessionError> {
    match direction.trim() {
        "" | "tx" | "tx_frame" => Ok((HookKind::Tx, "tx")),
        "rx" | "rx_frame" => Ok((HookKind::Rx, "rx")),
        "raw" | "raw_chunk" => Ok((HookKind::RawChunk, "rx")),
        "mitm" | "mitm_a_to_b" => Ok((HookKind::Mitm, "mitm_a_to_b")),
        "mitm_b_to_a" => Ok((HookKind::Mitm, "mitm_b_to_a")),
        other => Err(SessionError::Settings(format!(
            "unknown script hook direction `{other}`"
        ))),
    }
}

fn script_snapshot_to_view(snap: ScriptSnapshot, fallback_name: Option<&str>) -> ScriptStatusView {
    let name = if snap.path.is_empty() {
        fallback_name.unwrap_or("inline.lua").to_string()
    } else {
        snap.path
    };
    let policy = match snap.policy {
        FaultPolicy::FailOpen => "fail_open",
        FaultPolicy::FailClosed => "fail_closed",
    }
    .to_string();
    let assertions = snap
        .assertions
        .into_iter()
        .map(|a| ScriptAssertionView {
            name: a.name,
            passed: a.passed,
            failed: a.failed,
            last_error: a.last_error,
        })
        .collect();
    ScriptStatusView {
        armed: true,
        name,
        policy,
        hooks: snap.hooks,
        invocations: snap.invocations,
        changed: snap.changed,
        dropped: snap.dropped,
        delayed: snap.delayed,
        injected_tx: snap.injected_tx,
        failures: snap.failures,
        logs_suppressed: snap.logs_suppressed,
        assertions_passed: snap.assertions_passed,
        assertions_failed: snap.assertions_failed,
        memory_bytes: snap.memory_bytes,
        memory_limit_bytes: snap.memory_limit_bytes,
        last_instructions: snap.last_instructions,
        last_exec_us: snap.last_exec_us,
        max_exec_us: snap.max_exec_us,
        last_error: snap.last_error,
        metrics: snap.metrics,
        assertions,
    }
}

fn script_action_to_view(action: ScriptAction) -> ScriptActionView {
    match action {
        ScriptAction::Send {
            port,
            bytes,
            delay_ms,
            ..
        } => ScriptActionView::Send {
            port,
            hex: hex_of(&bytes),
            delay_ms,
        },
        ScriptAction::SetPins { port, dtr, rts } => ScriptActionView::SetPins { port, dtr, rts },
        ScriptAction::PulsePin {
            port,
            pin,
            duration_ms,
        } => ScriptActionView::PulsePin {
            port,
            pin,
            delay_ms: duration_ms,
        },
        ScriptAction::Plot {
            series,
            value,
            timestamp_us,
        } => ScriptActionView::Plot {
            series,
            value,
            timestamp_us,
        },
        ScriptAction::Log { level, message } => ScriptActionView::Log { level, message },
    }
}

fn dry_run_report_to_view(
    input_hex: String,
    report: bforge_script::DryRunReport,
) -> ScriptDryRunView {
    ScriptDryRunView {
        ok: report.error.is_none(),
        verdict: report.verdict,
        mutated: report.mutated,
        input_hex,
        output_hex: hex_of(&report.output_bytes),
        delay_ms: report.delay_ms,
        burst_frames: report
            .burst_frames
            .into_iter()
            .map(|(bytes, delay_ms)| ScriptBurstFrameView {
                hex: hex_of(&bytes),
                delay_ms,
            })
            .collect(),
        field_diffs: report
            .field_diffs
            .into_iter()
            .map(|diff| ScriptFieldDiffView {
                name: diff.name,
                before: diff.before,
                after: diff.after,
            })
            .collect(),
        instructions: report.instructions,
        exec_us: report.exec_us,
        memory_bytes: report.memory_bytes,
        actions: report
            .actions
            .into_iter()
            .map(script_action_to_view)
            .collect(),
        metrics: report.metrics,
        assertions: report
            .assertions
            .into_iter()
            .map(|a| ScriptAssertionView {
                name: a.name,
                passed: a.passed,
                failed: a.failed,
                last_error: a.last_error,
            })
            .collect(),
        error: report.error,
    }
}
