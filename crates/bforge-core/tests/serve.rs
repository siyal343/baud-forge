//! `bforge serve` end to end: a loopback HTTP surface over a real session.
//!
//! The device is a socket simulator, so this runs in CI with no hardware.

use bforge_core::serve::Server;
use bforge_core::session::{Session, session_ports_from_config};
use bforge_framer::cobs_encode;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// The 19-byte frame the fixture header describes, plus its CRC-32C.
fn imu_frame(sequence: u64) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&0xAA55u16.to_le_bytes());
    frame.push(3);
    frame.push((sequence & 0x07) as u8 | (((sequence >> 3) & 0x1F) as u8) << 3);
    frame.extend_from_slice(&(sequence as u32 * 1_000).to_le_bytes());
    frame.extend_from_slice(&(7_400u16 + (sequence % 800) as u16).to_be_bytes());
    frame.extend_from_slice(&(0.001f32 * (sequence % 1000) as f32).to_le_bytes());
    frame.extend_from_slice(&[1, 2, 3, 4]);
    frame.push(1);
    let crc = crc32c(&frame);
    frame.extend_from_slice(&crc.to_le_bytes());
    frame
}

fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0x82F6_3B78
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// A device on loopback that writes COBS frames with numeric fields.
fn device() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for index in 0..500u64 {
            let mut payload = cobs_encode(&imu_frame(index));
            payload.push(0);
            if stream.write_all(&payload).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(4));
        }
        std::thread::sleep(Duration::from_millis(500));
    });
    address
}

fn workspace(address: &str) -> bforge_core::ProjectConfig {
    let header = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../bforge-dissect/tests/fixtures/imu_packet.h")
        .display()
        .to_string()
        .replace('\\', "/");
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
framing = {{ mode = "cobs" }}
dissector = {{ type = "c_header", file = "{header}", root_struct = "ImuPacket" }}
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
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

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
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

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

        // Read until a snapshot and a frame arrive, then stop asking.
        let mut seen = String::new();
        let mut buffer = [0u8; 8192];
        while !(seen.contains("\"contract\":1")
            && seen.contains("event: frames")
            && seen.contains("event: series"))
        {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => seen.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Err(_) => break,
            }
            if seen.len() > 256 * 1024 {
                break;
            }
        }
        assert!(seen.contains("text/event-stream"), "{seen}");
        assert!(seen.contains("event: snapshot"), "{seen}");
        assert!(seen.contains("\"id\":\"sim\""), "the port row travels too");
        assert!(seen.contains("event: frames"), "frames reach the client");
        assert!(seen.contains("\"port\":\"sim\""), "a frame names its port");
        assert!(seen.contains("\"fields\":"), "a frame carries its fields");
        assert!(
            seen.contains("event: series"),
            "a numeric field becomes a series"
        );
        assert!(seen.contains("\"field\":"), "a series names its field");
        assert!(seen.contains("\"values\":"), "a series carries samples");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.clients_max >= 1, "{stats:?}");
}
