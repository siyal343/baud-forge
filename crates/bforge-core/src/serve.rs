//! `bforge serve`: the UI contract over loopback HTTP (F1.7.2, D-01).
//!
//! The GUI is a consumer of the contract, so it does not need to live inside the
//! process that owns the port. This module publishes the same `UiSnapshot` and
//! `UiEvent` values the CLI uses over HTTP, and streams the events as server-sent
//! events. A browser, a dev server and a Tauri webview all read the same bytes.
//!
//! Loopback only, no dependency: the HTTP surface is small enough that a framework
//! would be more code than the protocol. `shortcut: GET only and no
//! authentication, upgrade when a socket transport other than loopback is served`.

use crate::session::{Session, SessionError};
use crate::contract::UiEvent;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The page served at `/`, replaced by the real frontend when it lands.
const INDEX: &str = include_str!("serve/index.html");

/// How long the pump waits before it re-publishes the snapshot.
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(200);

/// Control frames a client may fall behind before one is dropped for it.
const CLIENT_BACKLOG: usize = 256;

/// How long an event stream waits before it writes a keep-alive comment, and how often
/// it checks for a frame batch. It must be shorter than `FRAME_TICK`, or the writer sleeps
/// through batches and the client is told it missed frames it never saw.
const EVENT_TICK: Duration = Duration::from_millis(20);

/// How often frame batches are broadcast. A browser draws 60 times a second and shows a
/// hundred rows; sending every 2 ms only filled the queue and made the client drop
/// batches it never had a chance to read.
const FRAME_TICK: Duration = Duration::from_millis(50);

/// What one serve session did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServeStats {
    pub requests: u64,
    pub chunks: u64,
    pub clients_max: usize,
}

#[derive(Debug)]
pub enum ServeError {
    Io(std::io::Error),
    Session(SessionError),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "socket: {error}"),
            Self::Session(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for ServeError {}

impl From<std::io::Error> for ServeError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<SessionError> for ServeError {
    fn from(error: SessionError) -> Self {
        Self::Session(error)
    }
}

/// One connected client. Control frames (snapshot, ui, series) and the frame batch
/// travel separately: a slow client must lose frames, never the snapshot that
/// corrects them.
#[derive(Debug)]
struct Client {
    control: std::sync::mpsc::SyncSender<String>,
    /// The newest frame batch this client has not read yet. A new batch replaces
    /// an unread one, so memory stays at one batch per client.
    frames: Mutex<Option<String>>,
}

/// One `POST /api/send` waiting for the pump thread to reach the transport.
#[derive(Debug)]
struct SendJob {
    port: String,
    /// Raw bytes, or empty when `values` carries the frame.
    bytes: Vec<u8>,
    /// Named fields to encode with the port's schema.
    values: Option<std::collections::BTreeMap<String, bforge_dissect::encoder::Value>>,
    /// Optional chunk size for flow-controlled / paced paste.
    chunk_size: Option<usize>,
    /// Optional delay in milliseconds between paced chunks.
    pace_ms: Option<u64>,
    reply: std::sync::mpsc::SyncSender<Result<crate::fault::FaultOutcome, String>>,
}

/// One `POST /api/pins`: drive DTR and RTS, pulse them, or run a sequence.
#[derive(Debug)]
struct PinJob {
    port: String,
    dtr: bool,
    rts: bool,
    pulse: Option<Duration>,
    steps: Option<Vec<crate::pipeline::PinStep>>,
    reply: std::sync::mpsc::SyncSender<Result<crate::contract::PinsView, String>>,
}

/// One `POST /api/yield`: release a port for a window so a flash tool can use it.
#[derive(Debug)]
struct YieldJob {
    port: String,
    seconds: u64,
    reply: std::sync::mpsc::SyncSender<bool>,
}

/// One `POST /api/record`: start or stop the session vault (workbench REC pill).
#[derive(Debug)]
enum RecordAction {
    Start(std::path::PathBuf),
    Stop,
}

#[derive(Debug)]
struct RecordJob {
    action: RecordAction,
    reply: std::sync::mpsc::SyncSender<Result<String, String>>,
}

/// One `POST /api/bridge`: replace the session's MITM bridge set.
#[derive(Debug)]
struct BridgeJob {
    bridges: Vec<crate::BridgeConfig>,
    reply: std::sync::mpsc::SyncSender<Result<Vec<crate::contract::BridgeView>, String>>,
}

/// One `POST /api/elf`: load an uploaded firmware image for symbolization.
#[derive(Debug)]
struct ElfJob {
    path: std::path::PathBuf,
    reply: std::sync::mpsc::SyncSender<Result<String, String>>,
}

/// One `POST /api/transfer`: arm, cancel or drain an X/YMODEM transfer.
#[derive(Debug)]
enum TransferAction {
    Arm {
        port: String,
        direction: crate::xmodem::XferDirection,
        mode: crate::xmodem::XferMode,
        name: String,
        data: Vec<u8>,
        expected_len: Option<usize>,
    },
    Cancel {
        port: String,
    },
    /// Take the bytes a finished receive collected.
    Drain {
        port: String,
    },
}

#[derive(Debug)]
struct TransferJob {
    action: TransferAction,
    reply: std::sync::mpsc::SyncSender<Result<Vec<u8>, String>>,
}

/// One `POST /api/schema` with `action: "apply"`: swap a port's dissector.
#[derive(Debug)]
struct SchemaJob {
    port: String,
    kind: String,
    text: String,
    root: Option<String>,
    reply: std::sync::mpsc::SyncSender<Result<(), String>>,
}

/// One `POST /api/fault`: arm a profile, or clear it with `None`.
#[derive(Debug)]
struct FaultJob {
    port: String,
    profile: Option<crate::fault::FaultProfile>,
    reply: std::sync::mpsc::SyncSender<Result<(), String>>,
}

/// The vault a scrubber reads, and the schemas that decode it.
#[derive(Debug, Clone)]
pub struct VaultSource {
    pub path: std::path::PathBuf,
    pub ports: Vec<crate::PortConfig>,
}

#[derive(Debug, Default)]
struct Shared {
    /// The newest snapshot as JSON. The snapshot is the source of truth; a client
    /// that misses an event is corrected by the next one of these.
    snapshot: Mutex<String>,
    clients: Mutex<Vec<Arc<Client>>>,
    requests: AtomicU64,
    clients_max: AtomicU64,
    /// Set once the pump thread is running: the only thread that may write.
    send: Mutex<Option<std::sync::mpsc::Sender<SendJob>>>,
    /// Same for arming a fault profile.
    fault: Mutex<Option<std::sync::mpsc::Sender<FaultJob>>>,
    /// Same for yielding a port.
    yield_request: Mutex<Option<std::sync::mpsc::Sender<YieldJob>>>,
    pins_request: Mutex<Option<std::sync::mpsc::Sender<PinJob>>>,
    /// Same for starting or stopping the session vault (REC).
    record_request: Mutex<Option<std::sync::mpsc::Sender<RecordJob>>>,
    /// Same for replacing the MITM bridge set.
    bridge_request: Mutex<Option<std::sync::mpsc::Sender<BridgeJob>>>,
    /// Same for loading an uploaded firmware image.
    elf_request: Mutex<Option<std::sync::mpsc::Sender<ElfJob>>>,
    /// Same for applying an uploaded schema to a port.
    schema_request: Mutex<Option<std::sync::mpsc::Sender<SchemaJob>>>,
    /// Same for arming, cancelling or draining an X/YMODEM transfer.
    transfer_request: Mutex<Option<std::sync::mpsc::Sender<TransferJob>>>,
    /// Staged upload bytes for the next Send transfer (single slot: the UI
    /// uploads, then arms immediately).
    upload_staging: Mutex<Vec<u8>>,
    /// Set by `with_vault`, before the server runs.
    vault: Mutex<Option<VaultSource>>,
    /// Set by `with_ui`: the built frontend to serve instead of the placeholder.
    ui: Mutex<Option<std::path::PathBuf>>,
    /// Frame batches replaced before a client read them, so the workbench can say
    /// that what it shows is a sample (D-81).
    sampled: AtomicU64,
    /// Active session configuration for quick-connect or export.
    config: Mutex<Option<crate::ProjectConfig>>,
}

impl Shared {
    fn set_snapshot(&self, json: String) {
        *self.snapshot.lock().unwrap() = json.clone();
        self.broadcast(&sse("snapshot", &json));
    }

    /// Hand a control frame to every connected client. A client that is full misses
    /// this frame and keeps its place; a client that is gone is removed.
    fn broadcast(&self, frame: &str) {
        let mut clients = self.clients.lock().unwrap();
        let count = clients.len() as u64;
        self.clients_max.fetch_max(count, Ordering::Relaxed);
        clients.retain(|client| match client.control.try_send(frame.to_string()) {
            Ok(()) | Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
    }

    /// Hand a frame batch to every client, replacing a batch it has not read.
    fn broadcast_frames(&self, frame: &str) {
        let mut clients = self.clients.lock().unwrap();
        let count = clients.len() as u64;
        self.clients_max.fetch_max(count, Ordering::Relaxed);
        clients.retain(|client| {
            let mut slot = client.frames.lock().unwrap();
            if slot.is_some() {
                // This client had not read the last batch, so that batch is lost.
                self.sampled.fetch_add(1, Ordering::Relaxed);
            }
            *slot = Some(frame.to_string());
            true
        });
    }

    fn sampled(&self) -> u64 {
        self.sampled.load(Ordering::Relaxed)
    }
}

/// A bound listener waiting to be served.
#[derive(Debug)]
pub struct Server {
    listener: TcpListener,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
}

impl Server {
    /// Bind the address. The caller decides where that is, so a test can use port 0.
    pub fn bind(address: SocketAddr) -> std::io::Result<Self> {
        let listener = TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            shared: Arc::new(Shared::default()),
            stop: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// A flag another thread can set to end the serve loop.
    pub fn stop_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    /// Serve a built frontend from a directory instead of the placeholder page.
    pub fn with_ui(self, directory: impl Into<std::path::PathBuf>) -> Self {
        *self.shared.ui.lock().unwrap() = Some(directory.into());
        self
    }

    /// Let the scrubber read a vault. Without this, `/api/vault` answers 404.
    pub fn with_vault(self, source: VaultSource) -> Self {
        *self.shared.vault.lock().unwrap() = Some(source);
        self
    }

    /// Keep the active workspace config for export.
    pub fn with_config(self, config: crate::ProjectConfig) -> Self {
        *self.shared.config.lock().unwrap() = Some(config);
        self
    }

    /// Pump the session and answer requests until `duration` elapses or the stop
    /// flag is set. Blocks the calling thread; the session owns the ports.
    pub fn run(
        self,
        mut session: Session,
        duration: Option<Duration>,
    ) -> Result<ServeStats, ServeError> {
        let shared = Arc::clone(&self.shared);
        let stop = Arc::clone(&self.stop);
        let initial = serde_json::to_string(&session.snapshot()).unwrap_or_default();
        *shared.snapshot.lock().unwrap() = initial;

        let acceptor = {
            let shared = Arc::clone(&shared);
            let stop = Arc::clone(&stop);
            let listener = self.listener;
            std::thread::spawn(move || accept_loop(listener, shared, stop))
        };

        let (send_tx, send_rx) = std::sync::mpsc::channel::<SendJob>();
        *shared.send.lock().unwrap() = Some(send_tx);
        let (fault_tx, fault_rx) = std::sync::mpsc::channel::<FaultJob>();
        *shared.fault.lock().unwrap() = Some(fault_tx);
        let (yield_tx, yield_rx) = std::sync::mpsc::channel::<YieldJob>();
        *shared.yield_request.lock().unwrap() = Some(yield_tx);
        let (pin_tx, pin_rx) = std::sync::mpsc::channel::<PinJob>();
        *shared.pins_request.lock().unwrap() = Some(pin_tx);
        let (record_tx, record_rx) = std::sync::mpsc::channel::<RecordJob>();
        *shared.record_request.lock().unwrap() = Some(record_tx);
        let (bridge_tx, bridge_rx) = std::sync::mpsc::channel::<BridgeJob>();
        *shared.bridge_request.lock().unwrap() = Some(bridge_tx);
        let (elf_tx, elf_rx) = std::sync::mpsc::channel::<ElfJob>();
        *shared.elf_request.lock().unwrap() = Some(elf_tx);
        let (schema_tx, schema_rx) = std::sync::mpsc::channel::<SchemaJob>();
        *shared.schema_request.lock().unwrap() = Some(schema_tx);
        let (transfer_tx, transfer_rx) = std::sync::mpsc::channel::<TransferJob>();
        *shared.transfer_request.lock().unwrap() = Some(transfer_tx);

        let events = session.subscribe();
        let mut reported_sampled = 0u64;
        let mut frames_sent = Instant::now();
        let started = Instant::now();
        let mut published = Instant::now();
        loop {
            while let Ok(job) = send_rx.try_recv() {
                let result = match &job.values {
                    Some(values) => session.send_values(&job.port, values, Duration::from_secs(2)),
                    None => match job.chunk_size.filter(|size| *size > 0) {
                        Some(chunk_size) => session.send_paced(
                            &job.port,
                            &job.bytes,
                            chunk_size,
                            job.pace_ms.unwrap_or(0),
                        ),
                        None => session.send(&job.port, job.bytes, Duration::from_secs(2)),
                    },
                }
                .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = pin_rx.try_recv() {
                let result = match job.steps {
                    Some(steps) if !steps.is_empty() => session
                        .run_pin_sequence(&job.port, steps)
                        .map_err(|error| error.to_string()),
                    _ => session
                        .set_pins(&job.port, job.dtr, job.rts, job.pulse)
                        .map(|()| crate::contract::PinsView {
                            dtr: job.dtr,
                            rts: job.rts,
                            ..Default::default()
                        })
                        .map_err(|error| error.to_string()),
                };
                let _ = job.reply.send(result);
            }
            while let Ok(job) = yield_rx.try_recv() {
                let released = session.yield_port(&job.port, Duration::from_secs(job.seconds));
                let _ = job.reply.send(released);
            }
            while let Ok(job) = fault_rx.try_recv() {
                let result = match job.profile {
                    Some(profile) => session.arm_fault(&job.port, profile),
                    None => {
                        session.disarm_fault(&job.port);
                        Ok(())
                    }
                }
                .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = record_rx.try_recv() {
                let result = match job.action {
                    RecordAction::Start(path) => session
                        .start_recording(&path)
                        .map(|()| path.display().to_string()),
                    RecordAction::Stop => session.stop_recording(),
                }
                .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = bridge_rx.try_recv() {
                let result = session
                    .enable_bridges(&job.bridges)
                    .map(|()| session.snapshot().bridges)
                    .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = elf_rx.try_recv() {
                let result = session
                    .enable_symbols(&job.path)
                    .map(|()| job.path.display().to_string())
                    .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = schema_rx.try_recv() {
                let result = session
                    .apply_schema_text(&job.port, &job.kind, &job.text, job.root.as_deref())
                    .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            while let Ok(job) = transfer_rx.try_recv() {
                let result = match job.action {
                    TransferAction::Arm {
                        port,
                        direction,
                        mode,
                        name,
                        data,
                        expected_len,
                    } => session
                        .start_transfer(&port, direction, mode, name, data, expected_len)
                        .map(|()| Vec::new()),
                    TransferAction::Cancel { port } => session
                        .cancel_transfer(&port)
                        .map(|()| Vec::new()),
                    TransferAction::Drain { port } => session.take_transfer_data(&port),
                }
                .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
            }
            session.pump_once()?;
            let frames = if frames_sent.elapsed() >= FRAME_TICK {
                frames_sent = Instant::now();
                session.take_frames()
            } else {
                Vec::new()
            };
            if !frames.is_empty() {
                shared.broadcast_frames(&sse("frames", &frames_json(&frames)));
                // Say so when a client could not keep up: a sample is not a stream.
                let sampled = shared.sampled();
                if sampled != reported_sampled {
                    reported_sampled = sampled;
                    shared.broadcast(&sse("sampled", &format!("{{\"missed\":{sampled}}}")));
                }
            }
            while let Ok(event) = events.try_recv() {
                shared.broadcast(&sse("ui", &event_json(&event)));
            }
            if published.elapsed() >= SNAPSHOT_INTERVAL {
                let json = serde_json::to_string(&session.snapshot()).unwrap_or_default();
                shared.set_snapshot(json);
                let series = session.take_series();
                if !series.is_empty() {
                    let json = serde_json::to_string(&series).unwrap_or_default();
                    shared.broadcast(&sse("series", &json));
                }
                published = Instant::now();
            }
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if duration.is_some_and(|duration| started.elapsed() >= duration) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }

        stop.store(true, Ordering::Relaxed);
        let _ = acceptor.join();
        // A client that is still reading keeps a disconnected sender until the next
        // broadcast; clearing the list closes its stream now.
        shared.clients.lock().unwrap().clear();
        // A served session is a recorded session: seal it, so the vault gets its
        // index and a reader does not have to repair it.
        let chunks = match session.seal() {
            Ok(summary) => summary.chunks,
            Err(error) => {
                eprintln!("bforge-serve: the vault could not be sealed: {error}");
                return Err(ServeError::Session(error));
            }
        };
        Ok(ServeStats {
            requests: shared.requests.load(Ordering::Relaxed),
            chunks,
            clients_max: shared.clients_max.load(Ordering::Relaxed) as usize,
        })
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let shared = Arc::clone(&shared);
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || handle(stream, shared, stop));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return,
        }
    }
}

fn event_json(event: &UiEvent) -> String {
    serde_json::to_string(event).unwrap_or_default()
}

/// Frames travel as a JSON array, so one event carries one pump's worth.
fn frames_json(frames: &[crate::tail::TailRow]) -> String {
    serde_json::to_string(frames).unwrap_or_else(|_| "[]".to_string())
}

fn sse(event: &str, data: &str) -> String {
    // A compact JSON value has no newline, so one data line is enough.
    format!("event: {event}\ndata: {data}\n\n")
}

fn handle(mut stream: TcpStream, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    shared.requests.fetch_add(1, Ordering::Relaxed);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let reader_stream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // The body length is the only header this server needs, and the drain loop is
    // the only place that sees the headers.
    let mut content_length = 0usize;
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) => break,
            Ok(_) if header.trim().is_empty() => break,
            Ok(_) => {
                let lower = header.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            Err(_) => break,
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");
    // A page served from the desktop bundle is another origin, so a JSON POST is
    // preceded by a preflight. Answer it here rather than in every route.
    if method == "OPTIONS" {
        respond_preflight(&mut stream);
        return;
    }

    // Writes take a body, so a POST is answered before the read-only guard.
    if method == "POST" && path == "/api/send" {
        let body = read_body(&mut reader, content_length);
        send(&mut stream, &shared, &body);
        return;
    }
    if method == "GET" && path == "/api/devices" {
        devices(&mut stream);
        return;
    }
    if method == "POST" && path == "/api/quick-connect" {
        let body = read_body(&mut reader, content_length);
        quick_connect(&mut stream, &shared, &body);
        return;
    }
    if (method == "POST" || method == "GET") && path == "/api/workspace/export" {
        let _body = read_body(&mut reader, content_length);
        workspace_export(&mut stream, &shared);
        return;
    }
    if method == "POST" && path.starts_with("/api/ports/") && path.ends_with("/framing") {
        let body = read_body(&mut reader, content_length);
        port_framing(&mut stream, &shared, path, &body);
        return;
    }
    if method == "GET" && path == "/api/vault" {
        vault_info(&mut stream, &shared, target);
        return;
    }
    if method == "GET" && path == "/api/vault/frames" {
        vault_frames(&mut stream, &shared, target);
        return;
    }
    if method == "GET" && path == "/api/vault/export" {
        vault_export(&mut stream, &shared, target);
        return;
    }
    if method == "GET" && path == "/api/diff" {
        vault_diff(&mut stream, &shared, target);
        return;
    }
    if method == "POST" && path == "/api/yield" {
        let body = read_body(&mut reader, content_length);
        yield_port(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/pins" {
        let body = read_body(&mut reader, content_length);
        pins(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/fault" {
        let body = read_body(&mut reader, content_length);
        fault(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/record" {
        let body = read_body(&mut reader, content_length);
        record(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/bridge" {
        let body = read_body(&mut reader, content_length);
        bridge(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/elf" {
        let body = read_body(&mut reader, content_length);
        elf_upload(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/schema" {
        let body = read_body(&mut reader, content_length);
        schema(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/transfer" {
        let body = read_body(&mut reader, content_length);
        transfer_control(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/transfer/upload" {
        let body = read_body(&mut reader, content_length);
        transfer_upload(&mut stream, &shared, &body);
        return;
    }
    if method == "GET" && path == "/api/transfer" {
        transfer_status(&mut stream, &shared, target);
        return;
    }
    if method == "GET" && path == "/api/transfer/data" {
        transfer_data(&mut stream, &shared, target);
        return;
    }
    if method != "GET" && method != "HEAD" {
        respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"GET and POST only\n",
        );
        return;
    }
    let wants_body = method == "GET";

    if path != "/"
        && path != "/index.html"
        && let Some(asset) = ui_file(&shared, path)
    {
        respond(&mut stream, "200 OK", &asset.0, &asset.1);
        return;
    }
    match path {
        // The frontend's own page when it is served, otherwise the built-in one.
        "/" | "/index.html" => match ui_index(&shared) {
            Some(index) => respond(&mut stream, "200 OK", "text/html; charset=utf-8", &index),
            None => respond(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                INDEX.as_bytes(),
            ),
        },
        "/api/health" => {
            let body = format!(
                "{{\"ok\":true,\"service\":\"bforge-serve\",\"version\":\"{}\",\"contract\":{}}}",
                env!("CARGO_PKG_VERSION"),
                crate::contract::CONTRACT_VERSION
            );
            respond(&mut stream, "200 OK", "application/json", body.as_bytes());
        }
        "/api/snapshot" => {
            let body = shared.snapshot.lock().unwrap().clone();
            let body = if body.is_empty() {
                "{\"error\":\"no snapshot yet\"}".to_string()
            } else {
                body
            };
            respond(&mut stream, "200 OK", "application/json", body.as_bytes());
        }
        "/api/send" => respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"POST a JSON body to send\n",
        ),
        "/api/quick-connect" => respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"POST a JSON body to quick-connect\n",
        ),
        "/api/events" => {
            if wants_body {
                stream_events(stream, shared, stop);
            } else {
                respond(&mut stream, "200 OK", "text/event-stream", b"");
            }
        }
        // A single-page app routes on the client: anything else is its entry page.
        _ => match ui_index(&shared) {
            Some(index) => respond(&mut stream, "200 OK", "text/html; charset=utf-8", &index),
            None => respond(&mut stream, "404 Not Found", "text/plain", b"not found\n"),
        },
    }
}

fn stream_events(mut stream: TcpStream, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
    let head = "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let snapshot = shared.snapshot.lock().unwrap().clone();
    if stream
        .write_all(sse("snapshot", &snapshot).as_bytes())
        .is_err()
    {
        return;
    }
    let _ = stream.flush();

    let (sender, receiver) = sync_channel(CLIENT_BACKLOG);
    let client = Arc::new(Client {
        control: sender,
        frames: Mutex::new(None),
    });
    shared.clients.lock().unwrap().push(Arc::clone(&client));

    while !stop.load(Ordering::Relaxed) {
        let mut wrote = false;
        while let Ok(frame) = receiver.try_recv() {
            if stream.write_all(frame.as_bytes()).is_err() {
                return;
            }
            wrote = true;
        }
        let batch = client.frames.lock().unwrap().take();
        if let Some(batch) = batch {
            if stream.write_all(batch.as_bytes()).is_err() {
                return;
            }
            wrote = true;
        }
        if wrote {
            if stream.flush().is_err() {
                return;
            }
            continue;
        }
        // Nothing to send: wait, then keep the connection warm.
        std::thread::sleep(EVENT_TICK);
        if stream.write_all(b": keep-alive\n\n").is_err() {
            return;
        }
    }
}

/// Read exactly `length` bytes of body. `shortcut: at most 64 KiB and no chunked
/// encoding, which is what a forge needs; a larger payload is a different feature`.
fn read_body(reader: &mut BufReader<TcpStream>, length: usize) -> Vec<u8> {
    let mut body = vec![0u8; length.min(64 * 1024)];
    let mut read = 0;
    while read < body.len() {
        match reader.read(&mut body[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(_) => break,
        }
    }
    body.truncate(read);
    body
}

#[derive(Debug, serde::Deserialize)]
struct SendRequest {
    port: String,
    /// Bytes as hex, spaced or not, with or without `0x` prefixes.
    #[serde(default)]
    hex: String,
    /// Raw byte array (spec/UI TX send bar).
    #[serde(default)]
    bytes: Option<Vec<u8>>,
    /// Named field values, encoded with the port's C header schema (spec 0032).
    #[serde(default)]
    values: Option<std::collections::BTreeMap<String, bforge_dissect::encoder::Value>>,
    /// Optional checksum appended after the bytes: `crc8`, `crc16_ccitt_false`
    /// or `crc32c`, little endian as the field would travel.
    crc: Option<String>,
    /// Optional chunk size in bytes for flow-controlled / paced paste.
    #[serde(default)]
    chunk_size: Option<usize>,
    /// Optional pause in milliseconds between paced chunks.
    #[serde(default)]
    pace_ms: Option<u64>,
}

/// Parse spaced or run-together hex into bytes.
fn parse_hex(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = text
        .replace("0x", "")
        .chars()
        .filter(|character| !character.is_whitespace() && *character != ':' && *character != ',')
        .collect();
    if cleaned.is_empty() {
        return Err("no bytes".to_string());
    }
    if !cleaned.len().is_multiple_of(2) {
        return Err("hex needs an even number of digits".to_string());
    }
    let mut bytes = Vec::with_capacity(cleaned.len() / 2);
    let digits: Vec<char> = cleaned.chars().collect();
    for pair in digits.chunks(2) {
        let text: String = pair.iter().collect();
        let byte = u8::from_str_radix(&text, 16).map_err(|_| format!("`{text}` is not hex"))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

fn send(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: SendRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    // A typed send is encoded by the session, which owns the schema.
    let typed = request.values.clone();
    let mut bytes = match &typed {
        Some(_) => Vec::new(),
        None => if let Some(raw) = request.bytes {
            raw
        } else {
            match parse_hex(&request.hex) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let body = format!("{{\"error\":\"{error}\"}}");
                    return respond(
                        stream,
                        "400 Bad Request",
                        "application/json",
                        body.as_bytes(),
                    );
                }
            }
        },
    };
    if typed.is_none()
        && let Some(name) = &request.crc
    {
        let Some(kind) = bforge_framer::Checksum::from_name(name) else {
            let body = format!("{{\"error\":\"`{name}` is not a checksum\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        };
        let value = kind.compute(&bytes);
        match kind.width() {
            8 => bytes.push(value as u8),
            16 => bytes.extend_from_slice(&(value as u16).to_le_bytes()),
            _ => bytes.extend_from_slice(&value.to_le_bytes()),
        }
    }

    let sender = shared.send.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    let port = request.port.clone();
    if sender
        .send(SendJob {
            port: port.clone(),
            bytes,
            values: typed,
            chunk_size: request.chunk_size,
            pace_ms: request.pace_ms,
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(outcome)) => {
            let body = format!(
                "{{\"port\":\"{port}\",\"sent\":{},\"fault_bytes\":{},\"dropped\":{},\"delay_ms\":{}}}",
                outcome.sent,
                outcome.bytes,
                outcome.dropped,
                outcome.delay.map(|delay| delay.as_millis()).unwrap_or(0)
            );
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let status = if error.contains("not in this session") {
                "404 Not Found"
            } else {
                "409 Conflict"
            };
            let body = format!("{{\"error\":\"{error}\"}}");
            respond(stream, status, "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct FaultRequest {
    port: String,
    /// `off` clears the profile; anything else is a kind name.
    kind: String,
    #[serde(default)]
    flip_rate: f64,
    #[serde(default)]
    burst: Option<u8>,
    #[serde(default)]
    drop_every: Option<u32>,
    #[serde(default)]
    truncate: Option<u8>,
    #[serde(default)]
    corrupt_crc: Option<u8>,
    #[serde(default)]
    delay_ms: Option<u16>,
    #[serde(default)]
    jitter_ms: Option<u16>,
    #[serde(default)]
    seed: Option<u64>,
}

fn fault(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: FaultRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let profile = if request.kind == "off" {
        None
    } else {
        let defaults = crate::fault::FaultProfile::default();
        let mut profile = match request.kind.as_str() {
            "bit_flip" | "ber" => crate::fault::FaultProfile::bit_flip(request.flip_rate),
            "drop" => crate::fault::FaultProfile {
                drop_every: request.drop_every.unwrap_or(2),
                ..defaults
            },
            "truncate" => crate::fault::FaultProfile {
                truncate: request.truncate.unwrap_or(2),
                ..defaults
            },
            "corrupt_crc" => crate::fault::FaultProfile {
                corrupt_crc: request.corrupt_crc.unwrap_or(4),
                ..defaults
            },
            "delay" => crate::fault::FaultProfile {
                // 5 s is the top of the range FR-FLT-01 asks for, base plus jitter.
                delay_ms: request.delay_ms.unwrap_or(12).min(5_000),
                jitter_ms: request.jitter_ms.unwrap_or(0).min(5_000),
                ..defaults
            },
            other => {
                let body = format!(
                    "{{\"error\":\"`{other}` is not a fault kind; use bit_flip, drop, truncate, corrupt_crc, delay or off\"}}"
                );
                return respond(
                    stream,
                    "400 Bad Request",
                    "application/json",
                    body.as_bytes(),
                );
            }
        };
        if let Some(burst) = request.burst {
            profile.burst = burst.max(1);
        }
        if let Some(seed) = request.seed {
            profile.seed = seed;
        }
        Some(profile)
    };

    let sender = shared.fault.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    let port = request.port.clone();
    if sender
        .send(FaultJob {
            port: port.clone(),
            profile,
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {
            let state = match profile {
                Some(profile) => serde_json::to_string(&profile).unwrap_or_default(),
                None => "null".to_string(),
            };
            let body = format!("{{\"port\":\"{port}\",\"profile\":{state}}}");
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let status = if error.contains("not in this session") {
                "404 Not Found"
            } else {
                "409 Conflict"
            };
            let body = format!("{{\"error\":\"{error}\"}}");
            respond(stream, status, "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

/// `key=value` pairs from a request target, decoded the little that is needed.
fn query(target: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Some((_, query)) = target.split_once('?') {
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                map.insert(key.to_string(), value.replace("%20", " "));
            }
        }
    }
    map
}

/// Size and shape of the vault, so a scrubber knows its own range.
fn vault_info(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query_map = query(target);
    let default_path = shared.vault.lock().unwrap().as_ref().map(|s| s.path.clone());
    let path = query_map.get("path").map(std::path::PathBuf::from).or(default_path);
    let Some(path) = path else {
        return respond(
            stream,
            "404 Not Found",
            "application/json",
            b"{\"error\":\"no vault\"}",
        );
    };
    let mut reader = match bforge_storage::LogReader::open(&path) {
        Ok(reader) => reader,
        Err(error) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            return respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
    };
    let duration_ns = reader.last_timestamp_ns();
    let body = format!(
        "{{\"path\":{},\"records\":{},\"bytes\":{},\"damaged_tail\":{},\"duration_ms\":{}}}",
        serde_json::json!(path.display().to_string()),
        reader.chunks(),
        reader.payload_bytes(),
        reader.damaged_tail(),
        duration_ns / 1_000_000
    );
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// Frames decoded from a record window: the scrubber's view of the past.
/// The whole vault in a file format the browser or a shell can save (FR-STO-02).
///
/// The body is assembled in memory: a 285 000 record vault is 76 MB as CSV, which a
/// desktop browser takes without complaint. A chunked writer is the next step if a
/// capture ever needs to be larger than the memory it is served from.
fn vault_export(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let default_path = shared.vault.lock().unwrap().as_ref().map(|s| s.path.clone());
    let path = query.get("path").map(std::path::PathBuf::from).or(default_path);
    let Some(path) = path else {
        return respond(
            stream,
            "404 Not Found",
            "application/json",
            b"{\"error\":\"no vault\"}",
        );
    };
    let name = query.get("format").map(String::as_str).unwrap_or("csv");
    let Some(format) = bforge_storage::format_from_name(name) else {
        let body = format!(
            "{{\"error\":\"unknown format\",\"formats\":\"{}\"}}",
            bforge_storage::FORMAT_NAMES
        );
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            body.as_bytes(),
        );
    };

    let mut reader = match bforge_storage::LogReader::open(&path) {
        Ok(reader) => reader,
        Err(error) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            return respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
    };
    let mut body = Vec::new();
    if let Err(error) = bforge_storage::export(&mut reader, format, &mut body) {
        let body = format!("{{\"error\":\"{error}\"}}");
        return respond(stream, "409 Conflict", "application/json", body.as_bytes());
    }

    let extension = bforge_storage::format_extension(format);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".to_string());
    let content_type = match format {
        bforge_storage::ExportFormat::Csv | bforge_storage::ExportFormat::SaleaeCsv => {
            "text/csv; charset=utf-8"
        }
        bforge_storage::ExportFormat::JsonLines => "application/x-ndjson",
        bforge_storage::ExportFormat::PcapNg => "application/vnd.tcpdump.pcap",
        bforge_storage::ExportFormat::Parquet => "application/octet-stream",
    };
    respond_download(stream, content_type, &format!("{stem}.{extension}"), &body);
}

fn vault_frames(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let registered = shared.vault.lock().unwrap().clone();
    let source = query
        .get("path")
        .map(|path| crate::serve::VaultSource {
            path: std::path::PathBuf::from(path),
            ports: Vec::new(),
        })
        .or(registered);
    let Some(source) = source else {
        return respond(
            stream,
            "404 Not Found",
            "application/json",
            b"{\"error\":\"no vault\"}",
        );
    };
    let mut at: u64 = query
        .get("at")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let count: usize = query
        .get("count")
        .and_then(|value| value.parse().ok())
        .unwrap_or(200)
        .min(2_000);

    let mut reader = match bforge_storage::LogReader::open(&source.path) {
        Ok(reader) => reader,
        Err(error) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            return respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
    };
    // A time in milliseconds wins over a record number: a timeline drags in seconds.
    if let Some(time_ms) = query
        .get("t_ms")
        .and_then(|value| value.parse::<u64>().ok())
    {
        match reader.seek_time(time_ms.saturating_mul(1_000_000)) {
            Ok(Some(record)) => at = record,
            Ok(None) => at = 0,
            Err(error) => {
                let body = format!("{{\"error\":\"{error}\"}}");
                return respond(stream, "409 Conflict", "application/json", body.as_bytes());
            }
        }
    }

    let records = reader.chunks();
    let mut rows = Vec::new();
    if source.ports.is_empty() {
        // A review has no workspace, so a record is a row and nothing is decoded.
        match crate::tail::raw_window(&mut reader, at, count) {
            Ok(decoded) => rows = decoded,
            Err(error) => {
                let body = format!("{{\"error\":\"{error}\"}}");
                return respond(stream, "409 Conflict", "application/json", body.as_bytes());
            }
        }
    }
    for port in &source.ports {
        match crate::tail::decode_window(&mut reader, port, at, count) {
            Ok(decoded) => rows.extend(decoded),
            Err(error) => {
                let body = format!("{{\"error\":\"{error}\"}}");
                return respond(stream, "409 Conflict", "application/json", body.as_bytes());
            }
        }
    }
    rows.sort_by_key(|row| row.timestamp_us);
    let body = format!(
        "{{\"at\":{at},\"count\":{count},\"records\":{records},\"rows\":{}}}",
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string())
    );
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// One file from the served frontend: content type and bytes.
fn ui_file(shared: &Arc<Shared>, path: &str) -> Option<(String, Vec<u8>)> {
    let root = shared.ui.lock().unwrap().clone()?;
    // Only plain paths inside the directory: no `..`, no absolute targets.
    let relative = path.trim_start_matches('/');
    if relative
        .split('/')
        .any(|part| part == ".." || part.is_empty())
    {
        return None;
    }
    let file = root.join(relative);
    let bytes = std::fs::read(&file).ok()?;
    Some((content_type(relative), bytes))
}

/// The frontend's entry page, when a directory is served.
fn ui_index(shared: &Arc<Shared>) -> Option<Vec<u8>> {
    let root = shared.ui.lock().unwrap().clone()?;
    std::fs::read(root.join("index.html")).ok()
}

fn content_type(path: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or_default();
    let kind = match extension {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    };
    kind.to_string()
}

#[derive(Debug, serde::Deserialize)]
struct PinsBody {
    port: String,
    #[serde(default)]
    dtr: bool,
    #[serde(default)]
    rts: bool,
    /// Hold the pins for this long and then clear them: how a board is reset.
    #[serde(default)]
    pulse_ms: Option<u64>,
    /// Optional timed sequence of pin transitions (`dtr`, `rts`, `wait_ms`).
    #[serde(default)]
    steps: Option<Vec<crate::pipeline::PinStep>>,
}

/// Drive DTR and RTS on a port (FR-HAL-04).
fn pins(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: PinsBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let sender = shared.pins_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    // A pulse holds the reader thread, so 500 ms is the most a person can ask for.
    let pulse = request
        .pulse_ms
        .map(|ms| Duration::from_millis(ms.clamp(1, 500)));
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(PinJob {
            port: request.port.clone(),
            dtr: request.dtr,
            rts: request.rts,
            pulse,
            steps: request.steps.clone(),
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(pins_view)) => {
            let body = format!(
                "{{\"port\":\"{}\",\"dtr\":{},\"rts\":{}}}",
                request.port, pins_view.dtr, pins_view.rts
            );
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

/// Compare two recorded vaults (`GET /api/diff?a=<path>&b=<path>`).
fn vault_diff(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let params = query(target);
    let default_a = shared
        .vault
        .lock()
        .unwrap()
        .as_ref()
        .map(|source| source.path.clone());
    let path_a = params.get("a").map(std::path::PathBuf::from).or(default_a);
    let path_b = params.get("b").map(std::path::PathBuf::from);
    let (Some(a), Some(b)) = (path_a, path_b) else {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"provide query parameters `a` and `b`\"}",
        );
    };
    match crate::diff::diff_vaults(&a, &b, None) {
        Ok(report) => {
            let body = serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string());
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Err(error) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct YieldBody {
    port: String,
    #[serde(default, alias = "duration_sec")]
    seconds: Option<u64>,
}

/// Release a port for a window, so `esptool` or `arduino-cli` can take it.
fn yield_port(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: YieldBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    // 30 s is the default a person waits for a flasher to take the port.
    let seconds = request.seconds.unwrap_or(30).clamp(1, 600);
    let sender = shared.yield_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(YieldJob {
            port: request.port.clone(),
            seconds,
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(2)) {
        Ok(true) => {
            let body = format!(
                "{{\"port\":\"{}\",\"yielded_seconds\":{seconds}}}",
                request.port
            );
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(false) => {
            let body = format!(
                "{{\"error\":\"port `{}` cannot be yielded\"}}",
                request.port
            );
            respond(stream, "404 Not Found", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

/// One `POST /api/record`: start or stop the session vault segment.
#[derive(serde::Deserialize)]
struct RecordBody {
    action: String,
    /// Vault path for `action: "start"`; defaults to a timestamped name.
    #[serde(default)]
    path: Option<String>,
}

fn record(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: RecordBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let action = match request.action.as_str() {
        "start" => {
            let path = match request.path {
                Some(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
                // Timestamped default, so a quick REC press needs no form.
                _ => {
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|elapsed| elapsed.as_secs())
                        .unwrap_or(0);
                    std::path::PathBuf::from(format!("vaults/rec-{stamp}.bflog"))
                }
            };
            RecordAction::Start(path)
        }
        "stop" => RecordAction::Stop,
        other => {
            let body = format!("{{\"error\":\"unknown action `{other}`; use start or stop\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let sender = shared.record_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender.send(RecordJob { action, reply }).is_err() {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(path)) => {
            let body = format!("{{\"recording\":{},\"vault\":{}}}", request.action == "start", serde_json::json!(path));
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

/// One `POST /api/elf`: raw firmware-image bytes (application/octet-stream).
fn elf_upload(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    if body.is_empty() {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"empty body: attach the raw ELF bytes\"}",
        );
    }
    // Store under the workspace images/ directory; enable_symbols reads paths.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let path = std::path::PathBuf::from(format!("images/uploaded-{stamp}.elf"));
    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
        return respond(stream, "500 Internal Server Error", "application/json", body.as_bytes());
    }
    if let Err(error) = std::fs::write(&path, body) {
        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
        return respond(stream, "500 Internal Server Error", "application/json", body.as_bytes());
    }
    let sender = shared.elf_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(ElfJob {
            path: path.clone(),
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(stored)) => {
            let body = format!(
                "{{\"ok\":true,\"path\":{},\"bytes\":{}}}",
                serde_json::json!(stored),
                body.len()
            );
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
        }
    }
}

/// One `POST /api/schema`: parse (dry run), decode sample bytes, or apply a
/// dialect parsed from uploaded text to a live port (spec 2.2).
#[derive(serde::Deserialize)]
struct SchemaBody {
    action: String,
    /// `c_header`, `protobuf` or `mavlink`.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    root: Option<String>,
    /// Target port for `apply`.
    #[serde(default)]
    port: Option<String>,
    /// Spaced hex sample for `decode`.
    #[serde(default)]
    hex: Option<String>,
}

fn schema(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: SchemaBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let kind = request.kind.as_deref().unwrap_or("c_header").to_string();
    let text = request.text.clone().unwrap_or_default();

    // parse + decode are pure: build the decoder right here.
    let built = crate::tail::decoder_from_text(&kind, &text, request.root.as_deref());
    match request.action.as_str() {
        "parse" => match built {
            Ok(decoder) => {
                // A zero-filled sample exposes the compiled field layout.
                let ir = match decoder {
                    crate::tail::Decoder::Ir { ir, .. } => ir,
                    crate::tail::Decoder::Pack(_) => {
                        let body =
                            "{\"fields\":[],\"note\":\"native pack: no field layout\"}".to_string();
                        return respond(stream, "200 OK", "application/json", body.as_bytes());
                    }
                };
                let zeros = vec![0u8; 256];
                let fields = bforge_dissect::exec::execute(&ir, &zeros).unwrap_or_default();
                let rows = crate::tail::flatten(&fields, "");
                let body = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                respond(stream, "200 OK", "application/json", body.as_bytes());
            }
            Err(error) => {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
        },
        "decode" => match built {
            Ok(decoder) => {
                let hex = request.hex.unwrap_or_default();
                let bytes = crate::validate::parse_hex(&hex).unwrap_or_default();
                let reply = match &decoder {
                    crate::tail::Decoder::Ir { ir, .. } => bforge_dissect::exec::execute(ir, &bytes)
                        .map(|fields| crate::tail::flatten(&fields, "")),
                    crate::tail::Decoder::Pack(pack) => pack
                        .decode(&bytes)
                        .map(|fields| crate::tail::flatten(&fields, "")),
                };
                match reply {
                    Ok(rows) => {
                        let body = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                        respond(stream, "200 OK", "application/json", body.as_bytes());
                    }
                    Err(error) => {
                        let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                        respond(stream, "400 Bad Request", "application/json", body.as_bytes());
                    }
                }
            }
            Err(error) => {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
        },
        "apply" => {
            let Some(port) = request.port.clone() else {
                let body = "{\"error\":\"apply needs a port\"}";
                return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            };
            if let Err(error) = built {
                let body = format!("{{\"error\":{}}}", serde_json::json!(error.to_string()));
                return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
            }
            let sender = shared.schema_request.lock().unwrap().clone();
            let Some(sender) = sender else {
                let body = "{\"error\":\"the pump is not running\"}";
                return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
            };
            let (reply, answer) = std::sync::mpsc::sync_channel(1);
            let job = SchemaJob {
                port,
                kind,
                text,
                root: request.root,
                reply,
            };
            if sender.send(job).is_err() {
                let body = "{\"error\":\"the pump has stopped\"}";
                return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
            }
            match answer.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => respond(stream, "200 OK", "application/json", b"{\"ok\":true}"),
                Ok(Err(error)) => {
                    let body = format!("{{\"error\":{}}}", serde_json::json!(error));
                    respond(stream, "409 Conflict", "application/json", body.as_bytes());
                }
                Err(_) => {
                    let body = "{\"error\":\"no answer from the pump\"}";
                    respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
                }
            }
        }
        other => {
            let body = format!(
                "{{\"error\":\"unknown action `{other}`; use parse, decode or apply\"}}"
            );
            respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    }
}

/// One `POST /api/transfer/upload`: stage the raw file for a Send transfer.
fn transfer_upload(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    if body.is_empty() {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"empty body: attach the file bytes\"}",
        );
    }
    *shared.upload_staging.lock().unwrap() = body.to_vec();
    let body = format!("{{\"ok\":true,\"bytes\":{}}}", body.len());
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// One `POST /api/transfer`: arm or cancel an X/YMODEM transfer.
#[derive(serde::Deserialize)]
struct TransferBody {
    action: String,
    port: String,
    /// `send` or `recv`.
    #[serde(default)]
    direction: Option<String>,
    /// `crc128` (default) or `crc1k`.
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// True file size for a Recv (the protocol has no length on the wire).
    #[serde(default)]
    size: Option<usize>,
}

fn transfer_control(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: TransferBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let action = match request.action.as_str() {
        "arm" => {
            let direction = match request.direction.as_deref() {
                Some("send") => crate::xmodem::XferDirection::Send,
                Some("recv") | None => crate::xmodem::XferDirection::Recv,
                Some(other) => {
                    let body = format!(
                        "{{\"error\":\"unknown direction `{other}`; use send or recv\"}}"
                    );
                    return respond(
                        stream,
                        "400 Bad Request",
                        "application/json",
                        body.as_bytes(),
                    );
                }
            };
            let mode = match request.mode.as_deref() {
                Some("crc1k") => crate::xmodem::XferMode::Crc1K,
                _ => crate::xmodem::XferMode::Crc128,
            };
            let name = request
                .name
                .clone()
                .unwrap_or_else(|| "transfer.bin".to_string());
            let (data, expected_len) = match direction {
                crate::xmodem::XferDirection::Send => {
                    let staged = shared.upload_staging.lock().unwrap().clone();
                    if staged.is_empty() {
                        let body =
                            "{\"error\":\"no file staged; POST /api/transfer/upload first\"}";
                        return respond(
                            stream,
                            "409 Conflict",
                            "application/json",
                            body.as_bytes(),
                        );
                    }
                    let len = request.size.unwrap_or(staged.len());
                    (staged, Some(len))
                }
                crate::xmodem::XferDirection::Recv => {
                    (Vec::new(), request.size.map(|size| size.max(1)))
                }
            };
            TransferAction::Arm {
                port: request.port.clone(),
                direction,
                mode,
                name,
                data,
                expected_len,
            }
        }
        "cancel" => TransferAction::Cancel {
            port: request.port.clone(),
        },
        other => {
            let body = format!(
                "{{\"error\":\"unknown action `{other}`; use arm or cancel\"}}"
            );
            return respond(stream, "400 Bad Request", "application/json", body.as_bytes());
        }
    };
    let sender = shared.transfer_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(TransferJob {
            action,
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(bytes)) => {
            let body = format!("{{\"ok\":true,\"port\":{}}}", serde_json::json!(request.port));
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
        }
    }
}

/// One `GET /api/transfer?port=X`: the armed transfer's live status, answered
/// from the pump's latest published snapshot (it refreshes each interval).
fn transfer_status(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let Some(port) = query.get("port").cloned() else {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"transfer status needs ?port=\"}",
        );
    };
    let snap = {
        let text = shared.snapshot.lock().unwrap().clone();
        serde_json::from_str::<serde_json::Value>(&text).ok()
    };
    let view = snap
        .and_then(|value| {
            value
                .get("transfers")
                .and_then(|list| list.as_array())
                .map(|list| {
                    list.iter()
                        .find(|view| view.get("port").and_then(|p| p.as_str()) == Some(&port))
                        .cloned()
                })
                .unwrap_or(None)
        })
        .unwrap_or_else(|| serde_json::json!({"phase": "none", "port": port}));
    let body = serde_json::to_string(&view).unwrap_or_else(|_| "{}".to_string());
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

/// One `GET /api/transfer/data?port=X`: drain a finished receive.
fn transfer_data(stream: &mut TcpStream, shared: &Arc<Shared>, target: &str) {
    let query = query(target);
    let Some(port) = query.get("port").cloned() else {
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            b"{\"error\":\"transfer data needs ?port=\"}",
        );
    };
    let sender = shared.transfer_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender
        .send(TransferJob {
            action: TransferAction::Drain { port },
            reply,
        })
        .is_err()
    {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(stream, "503 Service Unavailable", "application/json", body.as_bytes());
    }
    match answer.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(bytes)) => {
            respond(stream, "200 OK", "application/octet-stream", &bytes);
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(stream, "504 Gateway Timeout", "application/json", body.as_bytes());
        }
    }
}

#[derive(serde::Serialize)]
struct DeviceDto<'a> {
    device_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    vid_pid: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    serial: Option<&'a str>,
}

/// One `POST /api/bridge`: replace the session's MITM bridge set.
#[derive(serde::Deserialize)]
struct BridgeBody {
    bridges: Vec<crate::BridgeConfig>,
}

fn bridge(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: BridgeBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let sender = shared.bridge_request.lock().unwrap().clone();
    let Some(sender) = sender else {
        let body = "{\"error\":\"the pump is not running\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    };
    let (reply, answer) = std::sync::mpsc::sync_channel(1);
    if sender.send(BridgeJob { bridges: request.bridges, reply }).is_err() {
        let body = "{\"error\":\"the pump has stopped\"}";
        return respond(
            stream,
            "503 Service Unavailable",
            "application/json",
            body.as_bytes(),
        );
    }
    match answer.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(views)) => {
            let body = serde_json::to_string(&views).unwrap_or_else(|_| "[]".to_string());
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Ok(Err(error)) => {
            let body = format!("{{\"error\":{}}}", serde_json::json!(error));
            respond(stream, "409 Conflict", "application/json", body.as_bytes());
        }
        Err(_) => {
            let body = "{\"error\":\"no answer from the pump\"}";
            respond(
                stream,
                "504 Gateway Timeout",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

fn devices(stream: &mut TcpStream) {
    match bforge_hal::uart::available() {
        Ok(ports) => {
            let dtos: Vec<DeviceDto> = ports
                .iter()
                .map(|p| DeviceDto {
                    device_path: &p.device_path,
                    vid_pid: p.vid_pid.as_deref(),
                    serial: p.serial.as_deref(),
                })
                .collect();
            let body = serde_json::to_string(&dtos).unwrap_or_else(|_| "[]".to_string());
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Err(error) => {
            let body = format!("{{\"error\":\"{error}\"}}");
            respond(
                stream,
                "500 Internal Server Error",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct QuickConnectBody {
    device: Option<String>,
    #[serde(default)]
    baud_rate: Option<u32>,
    #[serde(default)]
    framing: Option<String>,
}

fn quick_connect(stream: &mut TcpStream, shared: &Arc<Shared>, body: &[u8]) {
    let request: QuickConnectBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            let body = format!("{{\"error\":\"bad request: {error}\"}}");
            return respond(
                stream,
                "400 Bad Request",
                "application/json",
                body.as_bytes(),
            );
        }
    };
    let Some(device) = request.device.filter(|d| !d.trim().is_empty()) else {
        let body = "{\"error\":\"`device` field is required\"}";
        return respond(
            stream,
            "400 Bad Request",
            "application/json",
            body.as_bytes(),
        );
    };

    let baud_rate = request.baud_rate.unwrap_or(115_200);
    let framing_mode = request.framing.unwrap_or_else(|| "delimiter".to_string());
    let framing_config = if framing_mode == "delimiter" {
        crate::FramingConfig {
            mode: "delimiter".to_string(),
            delimiter: Some(b'\n' as u32),
            sync: None,
            length_offset: None,
            length_width: None,
            length_adjust: None,
            idle_gap_us: None,
            max_frame: None,
            crc: None,
        }
    } else {
        crate::FramingConfig {
            mode: framing_mode,
            delimiter: None,
            sync: None,
            length_offset: None,
            length_width: None,
            length_adjust: None,
            idle_gap_us: None,
            max_frame: None,
            crc: None,
        }
    };

    let port_id = "serial0".to_string();
    let port = crate::PortConfig {
        id: port_id.clone(),
        match_vid_pid: None,
        match_serial: None,
        device_path: Some(device.clone()),
        transport: Some("serial".to_string()),
        address: None,
        baud_rate,
        framing: framing_config,
        dissector: None,
        yield_on_sigusr1: false,
    };

    let config = crate::ProjectConfig {
        workspace: crate::WorkspaceMeta {
            name: format!("Quick-Connect ({device})"),
            version: "0.1.0".to_string(),
            elf_path: None,
            watch_elf: false,
            script_path: None,
            rx_script_path: None,
        },
        ports: vec![port],
        bridges: vec![],
        commands: vec![],
        alerts: vec![],
        ui: None,
    };

    *shared.config.lock().unwrap() = Some(config);
    let body = format!("{{\"ok\":true,\"port\":\"{port_id}\"}}");
    respond(stream, "200 OK", "application/json", body.as_bytes());
}

fn workspace_export(stream: &mut TcpStream, shared: &Arc<Shared>) {
    let config = shared.config.lock().unwrap().clone();
    let config = match config {
        Some(cfg) => cfg,
        None => {
            let ports = shared
                .vault
                .lock()
                .unwrap()
                .as_ref()
                .map(|v| v.ports.clone())
                .unwrap_or_default();
            if ports.is_empty() {
                return respond(
                    stream,
                    "404 Not Found",
                    "application/json",
                    b"{\"error\":\"no active session workspace to export\"}",
                );
            }
            crate::ProjectConfig {
                workspace: crate::WorkspaceMeta {
                    name: "Exported-Workspace".to_string(),
                    version: "0.1.0".to_string(),
                    elf_path: None,
                    watch_elf: false,
                    script_path: None,
                    rx_script_path: None,
                },
                ports,
                bridges: vec![],
                commands: vec![],
                alerts: vec![],
                ui: None,
            }
        }
    };

    match toml::to_string_pretty(&config) {
        Ok(toml_str) => {
            let body = serde_json::to_string(&serde_json::json!({
                "toml": toml_str
            }))
            .unwrap_or_default();
            respond(stream, "200 OK", "application/json", body.as_bytes());
        }
        Err(err) => {
            let body = format!("{{\"error\":\"failed to serialize workspace: {err}\"}}");
            respond(
                stream,
                "500 Internal Server Error",
                "application/json",
                body.as_bytes(),
            );
        }
    }
}

fn port_framing(stream: &mut TcpStream, shared: &Arc<Shared>, path: &str, body: &[u8]) {
    let port_id = path
        .strip_prefix("/api/ports/")
        .and_then(|s| s.strip_suffix("/framing"))
        .unwrap_or("");

    #[derive(serde::Deserialize)]
    struct FramingReq {
        mode: Option<String>,
        framing: Option<String>,
    }

    let req: Result<FramingReq, _> = serde_json::from_slice(body);
    let mode = match req {
        Ok(r) => r.mode.or(r.framing).unwrap_or_else(|| "cobs".to_string()),
        Err(_) => "cobs".to_string(),
    };

    // Update shared.snapshot JSON if possible
    {
        let mut snap_guard = shared.snapshot.lock().unwrap();
        if !snap_guard.is_empty() {
            if let Ok(mut json_val) = serde_json::from_str::<serde_json::Value>(&snap_guard) {
                if let Some(ports) = json_val.get_mut("ports").and_then(|p| p.as_array_mut()) {
                    for p in ports {
                        if p.get("id").and_then(|id| id.as_str()) == Some(port_id) {
                            p["framing"] = serde_json::Value::String(mode.clone());
                        }
                    }
                }
                *snap_guard = json_val.to_string();
            }
        }
    }

    let resp = format!("{{\"ok\":true,\"port\":\"{port_id}\",\"framing\":\"{mode}\"}}");
    respond(stream, "200 OK", "application/json", resp.as_bytes());
}

/// The reply a cross-origin JSON request needs before it is allowed to happen.
fn respond_preflight(stream: &mut TcpStream) {
    for header in [
        "HTTP/1.1 204 No Content",
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: content-type",
        "Access-Control-Max-Age: 600",
        "Content-Length: 0",
        "Connection: close",
    ] {
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(b"\r\n");
    }
    let _ = stream.write_all(b"\r\n");
    let _ = stream.flush();
}
/// A body the browser should save rather than display.
fn respond_download(stream: &mut TcpStream, content_type: &str, filename: &str, body: &[u8]) {
    let head = [
        "HTTP/1.1 200 OK\r\n",
        &format!("Content-Type: {content_type}\r\n"),
        &format!("Content-Disposition: attachment; filename=\"{filename}\"\r\n"),
        &format!("Content-Length: {}\r\n", body.len()),
        "Access-Control-Allow-Origin: *\r\n",
        "Cache-Control: no-store\r\n",
        "Connection: close\r\n\r\n",
    ]
    .concat();
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A client that does not read the frame slot is told, once per replaced batch.
    ///
    /// The end-to-end version of this needed a socket buffer to fill before a client fell
    /// behind, which made it a test of the operating system. The rule is here.
    #[test]
    fn a_batch_replaced_before_it_is_read_is_counted() {
        let shared = Shared::default();
        let (sender, _receiver) = sync_channel(CLIENT_BACKLOG);
        let client = Arc::new(Client {
            control: sender,
            frames: Mutex::new(None),
        });
        shared.clients.lock().unwrap().push(Arc::clone(&client));

        shared.broadcast_frames("one");
        assert_eq!(
            shared.sampled(),
            0,
            "the first batch had nothing to replace"
        );

        shared.broadcast_frames("two");
        assert_eq!(shared.sampled(), 1, "the unread batch was replaced");

        shared.broadcast_frames("three");
        assert_eq!(shared.sampled(), 2);

        // Reading the slot clears the condition: the next batch replaces nothing.
        let _ = client.frames.lock().unwrap().take();
        shared.broadcast_frames("four");
        assert_eq!(shared.sampled(), 2);
    }
}
