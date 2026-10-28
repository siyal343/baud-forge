//! `bforge serve` end to end: a loopback HTTP surface over a real session.
//!
//! The device is a socket simulator, so this runs in CI with no hardware.

use bforge_core::serve::Server;
use bforge_core::session::{Session, session_ports_from_config};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// A device on loopback that writes one line every few milliseconds.
fn device() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for index in 0..500u32 {
            let line = format!("imu {index} 0.25\r\n");
            if stream.write_all(line.as_bytes()).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(4));
        }
        std::thread::sleep(Duration::from_millis(500));
    });
    address
}

fn workspace(address: &str) -> bforge_core::ProjectConfig {
    let text = format!(
        r#"
[workspace]
name = "serve"
version = "1.0"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{address}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}
"#
    );
    toml::from_str(&text).expect("workspace parses")
}

/// A request against the serve surface, with the body as text.
fn get(address: &str, path: &str) -> (String, String) {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    let mut text = String::new();
    let _ = stream.read_to_string(&mut text);
    let status = text.lines().next().unwrap_or_default().to_string();
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}

#[test]
fn the_contract_is_served_over_http_and_events_stream() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let session = Session::start(ports, None, None).expect("session");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        // Wait for the pump to have published at least one snapshot.
        std::thread::sleep(Duration::from_millis(400));

        let (status, body) = get(&address, "/api/health");
        assert!(status.contains("200"), "{status}");
        assert!(body.contains("\"contract\":1"), "{body}");

        let (status, body) = get(&address, "/api/snapshot");
        assert!(status.contains("200"), "{status}");
        assert!(body.contains("\"contract\":1"), "{body}");
        assert!(body.contains("\"id\":\"sim\""), "{body}");
        assert!(body.contains("\"elapsed_ms\":"), "{body}");

        let (status, body) = get(&address, "/");
        assert!(status.contains("200"), "{status}");
        assert!(body.contains("EventSource"), "the page streams events");

        let (status, _) = get(&address, "/api/nothing");
        assert!(status.contains("404"), "{status}");
    });

    let started = Instant::now();
    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(started.elapsed() >= Duration::from_millis(1500));
    assert!(stats.requests >= 4, "{stats:?}");
    assert!(stats.chunks > 0, "the session moved data: {stats:?}");
}

#[test]
fn an_event_source_receives_the_snapshot_without_asking() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let session = Session::start(ports, None, None).expect("session");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let mut stream = TcpStream::connect(&address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let request = "GET /api/events HTTP/1.1\r\nHost: test\r\nAccept: text/event-stream\r\n\r\n";
        stream.write_all(request.as_bytes()).unwrap();

        // Read until the first snapshot frame arrives, then stop asking.
        let mut seen = String::new();
        let mut buffer = [0u8; 4096];
        while !seen.contains("\"contract\":1") {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => seen.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Err(_) => break,
            }
            if seen.len() > 64 * 1024 {
                break;
            }
        }
        assert!(seen.contains("text/event-stream"), "{seen}");
        assert!(seen.contains("event: snapshot"), "{seen}");
        assert!(seen.contains("\"id\":\"sim\""), "the port row travels too");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.clients_max >= 1, "{stats:?}");
}
