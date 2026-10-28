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
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The page served at `/`, replaced by the real frontend when it lands.
const INDEX: &str = include_str!("serve/index.html");

/// How long the pump waits before it re-publishes the snapshot.
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(200);

/// Frames a client may fall behind before a frame is dropped for it.
const CLIENT_BACKLOG: usize = 256;

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

/// State shared with the connection threads.
#[derive(Debug, Default)]
struct Shared {
    /// The newest snapshot as JSON. The snapshot is the source of truth; a client
    /// that misses an event is corrected by the next one of these.
    snapshot: Mutex<String>,
    clients: Mutex<Vec<std::sync::mpsc::SyncSender<String>>>,
    requests: AtomicU64,
    clients_max: AtomicU64,
}

impl Shared {
    fn set_snapshot(&self, json: String) {
        *self.snapshot.lock().unwrap() = json.clone();
        self.broadcast(&sse("snapshot", &json));
    }

    /// Hand one frame to every connected client. A client that is full misses this
    /// frame and keeps its place; a client that is gone is removed.
    fn broadcast(&self, frame: &str) {
        let mut clients = self.clients.lock().unwrap();
        let count = clients.len() as u64;
        self.clients_max.fetch_max(count, Ordering::Relaxed);
        clients.retain(|client| match client.try_send(frame.to_string()) {
            Ok(()) | Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
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

        let events = session.subscribe();
        let started = Instant::now();
        let mut published = Instant::now();
        loop {
            session.pump_once()?;
            while let Ok(event) = events.try_recv() {
                shared.broadcast(&sse("ui", &event_json(&event)));
            }
            if published.elapsed() >= SNAPSHOT_INTERVAL {
                let json = serde_json::to_string(&session.snapshot()).unwrap_or_default();
                shared.set_snapshot(json);
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
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) => break,
            Ok(_) if header.trim().is_empty() => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            b"GET only\n",
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
    shared.clients.lock().unwrap().push(sender);
    while !stop.load(Ordering::Relaxed) {
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(frame) => {
                if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                // A comment keeps the connection warm and notices a closed client.
                if stream.write_all(b": keep-alive\n\n").is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
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
