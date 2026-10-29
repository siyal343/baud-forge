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
use crate::ui::UiEvent;
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

/// How long an event stream waits before it writes a keep-alive comment.
const EVENT_TICK: Duration = Duration::from_millis(500);

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
    bytes: Vec<u8>,
    reply: std::sync::mpsc::SyncSender<Result<crate::fault::FaultOutcome, String>>,
}

/// One `POST /api/fault`: arm a profile, or clear it with `None`.
#[derive(Debug)]
struct FaultJob {
    port: String,
    profile: Option<crate::fault::FaultProfile>,
    reply: std::sync::mpsc::SyncSender<Result<(), String>>,
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
            *client.frames.lock().unwrap() = Some(frame.to_string());
            true
        });
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

        let events = session.subscribe();
        let started = Instant::now();
        let mut published = Instant::now();
        loop {
            while let Ok(job) = send_rx.try_recv() {
                let result = session
                    .send(&job.port, job.bytes, Duration::from_secs(2))
                    .map_err(|error| error.to_string());
                let _ = job.reply.send(result);
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
            session.pump_once()?;
            let frames = session.take_frames();
            if !frames.is_empty() {
                shared.broadcast_frames(&sse("frames", &frames_json(&frames)));
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
        Ok(ServeStats {
            requests: shared.requests.load(Ordering::Relaxed),
            chunks: session.chunks(),
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
    // Writes take a body, so a POST is answered before the read-only guard.
    if method == "POST" && path == "/api/send" {
        let body = read_body(&mut reader, content_length);
        send(&mut stream, &shared, &body);
        return;
    }
    if method == "POST" && path == "/api/fault" {
        let body = read_body(&mut reader, content_length);
        fault(&mut stream, &shared, &body);
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

    match path {
        "/" | "/index.html" => respond(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            INDEX.as_bytes(),
        ),
        "/api/health" => {
            let body = format!(
                "{{\"ok\":true,\"service\":\"bforge-serve\",\"version\":\"{}\",\"contract\":{}}}",
                env!("CARGO_PKG_VERSION"),
                crate::ui::CONTRACT_VERSION
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
        "/api/events" => {
            if wants_body {
                stream_events(stream, shared, stop);
            } else {
                respond(&mut stream, "200 OK", "text/event-stream", b"");
            }
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"not found\n"),
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
    hex: String,
    /// Optional checksum appended after the bytes: `crc8`, `crc16_ccitt_false`
    /// or `crc32c`, little endian as the field would travel.
    crc: Option<String>,
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
    let mut bytes = match parse_hex(&request.hex) {
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
    };
    if let Some(name) = &request.crc {
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
                "{{\"port\":\"{port}\",\"sent\":{},\"fault_bytes\":{},\"dropped\":{}}}",
                outcome.sent, outcome.bytes, outcome.dropped
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
            other => {
                let body = format!(
                    "{{\"error\":\"`{other}` is not a fault kind; use bit_flip, drop, truncate, corrupt_crc or off\"}}"
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
