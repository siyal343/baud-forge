//! Local control plane (F1.2.6): let another program borrow the port.
//!
//! A flasher cannot open a port that BaudForge holds. The tool therefore listens on
//! a loopback socket and publishes the address as one small file per device:
//!
//! ```text
//! <temp>/bforge-COM8.endpoint   ->  "127.0.0.1:54321"
//! ```
//!
//! `bforge yield --port <id>` reads that file, sends one JSON line, and gets one
//! JSON line back. Loopback TCP is not a UNIX socket, but it is the same contract
//! on Windows, macOS and Linux with no extra dependency, and the address never
//! leaves this machine.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// What a session can be asked to do.
pub trait ControlTarget: Send + Sync {
    /// Release `port` for `duration`. False when the port is not in this session.
    fn yield_port(&self, port: &str, duration: Duration) -> bool;
    /// One JSON object describing what is running.
    fn status(&self) -> String;
}

/// Where the endpoint file for a device lives.
///
/// The device name is part of the file name, so `bforge yield` finds the session
/// that holds the port without a daemon or a registry.
pub fn endpoint_path(device: &str) -> PathBuf {
    let slug: String = device
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect();
    std::env::temp_dir().join(format!("bforge-{slug}.endpoint"))
}

/// The endpoint file contents for one device, or `None` when no session holds it.
pub fn discover(device: &str) -> Option<SocketAddr> {
    let text = std::fs::read_to_string(endpoint_path(device)).ok()?;
    text.trim().parse().ok()
}

/// Serves control requests for one session.
pub struct ControlServer {
    address: SocketAddr,
    files: Vec<PathBuf>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ControlServer {
    /// Bind a loopback port and publish it for every device in `devices`.
    pub fn start(
        devices: &[String],
        target: Arc<dyn ControlTarget>,
        request_timeout: Duration,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));

        let mut files = Vec::new();
        for device in devices {
            let path = endpoint_path(device);
            std::fs::write(&path, address.to_string())?;
            files.push(path);
        }

        let thread_stop = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        let _ = serve(stream, target.as_ref(), request_timeout);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(20)),
                }
            }
        });

        Ok(Self {
            address,
            files,
            stop,
            thread: Some(thread),
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        for file in &self.files {
            let _ = std::fs::remove_file(file);
        }
    }
}

fn serve(
    mut stream: TcpStream,
    target: &dyn ControlTarget,
    request_timeout: Duration,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(request_timeout))?;
    stream.set_write_timeout(Some(request_timeout))?;

    let mut line = String::new();
    BufReader::new(stream.try_clone()?).read_line(&mut line)?;
    let reply = handle(&line, target);
    stream.write_all(reply.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

/// One request in, one reply out. Exposed so a test can drive it without a socket.
pub fn handle(line: &str, target: &dyn ControlTarget) -> String {
    let value: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(value) => value,
        Err(_) => return error("request is not JSON"),
    };
    let command = value
        .get("cmd")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();

    match command {
        "yield" => {
            let Some(port) = value.get("port").and_then(serde_json::Value::as_str) else {
                return error("yield needs a port");
            };
            let seconds = value
                .get("seconds")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(30);
            if target.yield_port(port, Duration::from_secs(seconds)) {
                format!(
                    "{{\"ok\":true,\"state\":\"yielded\",\"port\":\"{port}\",\"seconds\":{seconds}}}"
                )
            } else {
                error(&format!("port `{port}` is not in this session"))
            }
        }
        "status" => target.status(),
        other => error(&format!("unknown command `{other}`")),
    }
}

fn error(message: &str) -> String {
    format!("{{\"ok\":false,\"error\":{}}}", json_string(message))
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Send one request to a session and return its reply line.
pub fn request(address: SocketAddr, line: &str) -> std::io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
    Ok(reply.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        yielded: Mutex<Vec<(String, Duration)>>,
    }

    impl ControlTarget for Fake {
        fn yield_port(&self, port: &str, duration: Duration) -> bool {
            if port != "known" {
                return false;
            }
            self.yielded
                .lock()
                .unwrap()
                .push((port.to_string(), duration));
            true
        }

        fn status(&self) -> String {
            "{\"ok\":true,\"ports\":1}".to_string()
        }
    }

    fn fake() -> Fake {
        Fake {
            yielded: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn a_yield_request_reaches_the_target() {
        let target = fake();
        let reply = handle(r#"{"cmd":"yield","port":"known","seconds":12}"#, &target);
        assert!(reply.contains("\"ok\":true"), "{reply}");
        assert!(reply.contains("\"seconds\":12"), "{reply}");
        let seen = target.yielded.lock().unwrap();
        assert_eq!(seen[0].0, "known");
        assert_eq!(seen[0].1, Duration::from_secs(12));
    }

    #[test]
    fn an_unknown_port_and_a_bad_request_are_refused() {
        let target = fake();
        let reply = handle(r#"{"cmd":"yield","port":"other"}"#, &target);
        assert!(reply.contains("\"ok\":false"), "{reply}");
        assert!(reply.contains("is not in this session"), "{reply}");

        let reply = handle("not json", &target);
        assert!(reply.contains("not JSON"), "{reply}");

        let reply = handle(r#"{"cmd":"dance"}"#, &target);
        assert!(reply.contains("unknown command"), "{reply}");
    }

    #[test]
    fn status_is_passed_through() {
        let target = fake();
        assert_eq!(handle(r#"{"cmd":"status"}"#, &target), target.status());
    }

    #[test]
    fn the_endpoint_file_is_keyed_by_device() {
        let path = endpoint_path("COM8");
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "bforge-COM8.endpoint"
        );
        let path = endpoint_path("/dev/ttyACM0");
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "bforge-_dev_ttyACM0.endpoint"
        );
    }

    #[test]
    fn a_session_publishes_its_address_and_removes_it_on_drop() {
        let device = format!("MOCK{}", std::process::id());
        let target: Arc<dyn ControlTarget> = Arc::new(fake());
        let server = ControlServer::start(
            std::slice::from_ref(&device),
            target,
            Duration::from_secs(2),
        )
        .unwrap();

        let address = discover(&device).expect("the endpoint is published");
        assert_eq!(address, server.address());

        let reply = request(address, r#"{"cmd":"status"}"#).unwrap();
        assert!(reply.contains("\"ok\":true"), "{reply}");

        drop(server);
        assert!(discover(&device).is_none(), "the endpoint file is removed");
    }
}
