import pathlib

p = pathlib.Path("crates/bforge-core/src/serve.rs")
s = p.read_text(encoding="utf-8")

old_shared = '''struct Shared {
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
}'''

new_shared = '''/// One connected client. Control frames (snapshot, ui, series) and the frame batch
/// travel separately: a slow client must lose frames, never the snapshot that
/// corrects them.
struct Client {
    control: std::sync::mpsc::SyncSender<String>,
    /// The newest frame batch this client has not read yet. A new batch replaces
    /// an unread one, so memory stays at one batch per client.
    frames: Mutex<Option<String>>,
}

struct Shared {
    /// The newest snapshot as JSON. The snapshot is the source of truth; a client
    /// that misses an event is corrected by the next one of these.
    snapshot: Mutex<String>,
    clients: Mutex<Vec<Arc<Client>>>,
    requests: AtomicU64,
    clients_max: AtomicU64,
}

impl Shared {
    fn set_snapshot(&self, json: String) {
        *self.snapshot.lock().unwrap() = json.clone();
        self.broadcast(&sse("snapshot", &json));
    }

    /// Hand a control frame to every connected client. A client that is full misses
    /// this frame and keeps its place; a client that is gone is removed.
    fn broadcast(&self, frame: &str) {
        self.broadcast_with(frame, |client| client.control.try_send(frame.to_string()));
    }

    /// Hand a frame batch to every client, replacing an unread one.
    fn broadcast_frames(&self, frame: &str) {
        self.broadcast_with(frame, |client| {
            *client.frames.lock().unwrap() = Some(frame.to_string());
            Ok(())
        });
    }

    fn broadcast_with(
        &self,
        _frame: &str,
        send: impl Fn(&Client) -> Result<(), TrySendError<String>>,
    ) {
        let mut clients = self.clients.lock().unwrap();
        let count = clients.len() as u64;
        self.clients_max.fetch_max(count, Ordering::Relaxed);
        clients.retain(|client| match send(client) {
            Ok(()) | Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        });
    }
}'''

assert old_shared in s
s = s.replace(old_shared, new_shared)

# The frames broadcast now replaces an unread batch.
s = s.replace("shared.broadcast(&sse(\"frames\", &frames_json(&frames)));",
              "shared.broadcast_frames(&sse(\"frames\", &frames_json(&frames)));")

# The event stream loop reads control frames and the frame slot on a short tick.
old_stream = '''    let (sender, receiver) = sync_channel(CLIENT_BACKLOG);
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
                if stream.write_all(b": keep-alive\\n\\n").is_err() {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }'''

new_stream = '''    let (sender, receiver) = sync_channel(CLIENT_BACKLOG);
    let client = Arc::new(Client {
        control: sender,
        frames: Mutex::new(None),
    });
    shared.clients.lock().unwrap().push(Arc::clone(&client));

    while !stop.load(Ordering::Relaxed) {
        while let Ok(frame) = receiver.try_recv() {
            if stream.write_all(frame.as_bytes()).is_err() {
                return;
            }
        }
        let batch = client.frames.lock().unwrap().take();
        if let Some(batch) = batch {
            if stream.write_all(batch.as_bytes()).is_err() {
                return;
            }
        }
        if stream.flush().is_err() {
            return;
        }
        if receiver.recv_timeout(EVENT_TICK).is_err() {
            match receiver.try_recv() {
                Ok(frame) => {
                    if stream.write_all(frame.as_bytes()).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    // A comment keeps the connection warm and notices a closed client.
                    if stream.write_all(b": keep-alive\\n\\n").is_err() {
                        return;
                    }
                }
            }
        }
    }'''

assert old_stream in s
s = s.replace(old_stream, new_stream)

s = s.replace("""/// Frames a client may fall behind before a frame is dropped for it.
const CLIENT_BACKLOG: usize = 256;""",
"""/// Control frames a client may fall behind before one is dropped for it.
const CLIENT_BACKLOG: usize = 256;

/// How long an event stream waits before it writes the pending frame batch.
const EVENT_TICK: Duration = Duration::from_millis(50);""")

s = s.replace("use std::sync::mpsc::{RecvTimeoutError, TrySendError, sync_channel};",
              "use std::sync::mpsc::{TrySendError, sync_channel};")

p.write_text(s, encoding="utf-8")
print("ok")
