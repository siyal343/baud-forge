//! Socket transports end to end: a device simulator on loopback, no hardware.

use bforge_core::session::{Session, session_ports_from_config};
use bforge_core::tail::{Tail, TailConfig};
use bforge_framer::cobs_encode;
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn temp(name: &str, suffix: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "bforge-transport-{}-{name}.{suffix}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
    path
}

/// The 19-byte frame the fixture header describes, so the dissector can decode it.
fn imu_frame(version: u8) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&0xAA55u16.to_le_bytes());
    frame.push(version);
    frame.push(0b101);
    frame.extend_from_slice(&123_456u32.to_le_bytes());
    frame.extend_from_slice(&7_900u16.to_be_bytes());
    frame.extend_from_slice(&0.25f32.to_le_bytes());
    frame.extend_from_slice(&[1, 2, 3, 4]);
    frame.push(1);
    frame
}

/// A device that accepts one client and writes COBS frames.
fn device(frames: usize) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for index in 0..frames {
            let mut payload = cobs_encode(&imu_frame(index as u8));
            payload.push(0);
            if stream.write_all(&payload).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // Hold the connection open so the reader is not cut off mid-frame.
        std::thread::sleep(Duration::from_millis(500));
    });
    (address, handle)
}

fn tcp_config(address: &str, with_dissector: bool) -> bforge_core::ProjectConfig {
    let dissector = if with_dissector {
        format!(
            "dissector = {{ type = \"c_header\", file = \"{}\", root_struct = \"ImuPacket\" }}\n",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../bforge-dissect/tests/fixtures/imu_packet.h")
                .display()
                .to_string()
                .replace('\\', "/")
        )
    } else {
        String::new()
    };
    let text = format!(
        r#"
[workspace]
name = "tcp"
version = "1.0"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{address}"
baud_rate = 115200
framing = {{ mode = "cobs" }}
{dissector}"#
    );
    let config = bforge_core::parse(&text).unwrap();
    assert!(config.validate().is_empty(), "{:?}", config.validate());
    config
}

#[test]
fn a_session_records_from_a_tcp_device() {
    let (address, device) = device(6);
    let config = tcp_config(&address, false);
    let vault = temp("tcp", "bflog");
    let ports = session_ports_from_config(&config, &[]).unwrap();
    let mut session = Session::start(ports, Some(&vault), None).unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() < 3 && Instant::now() < deadline {
        session.pump_once().unwrap();
        std::thread::sleep(Duration::from_millis(2));
    }
    let summary = session.seal().unwrap();
    device.join().unwrap();

    assert!(summary.chunks >= 3, "recorded {} chunks", summary.chunks);
    assert!(summary.payload_bytes > 0);
    let _ = std::fs::remove_file(&vault);
}

#[test]
fn tail_decodes_frames_from_a_tcp_device() {
    let (address, device) = device(4);
    let config = tcp_config(&address, true);
    let ports = session_ports_from_config(&config, &[]).unwrap();
    let mut configs = std::collections::HashMap::new();
    configs.insert(
        "sim".to_string(),
        bforge_core::tail::tail_config(&config.ports[0]).unwrap(),
    );
    let mut tail: Tail = Tail::start(ports, configs).unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut rows = Vec::new();
    while rows.len() < 3 && Instant::now() < deadline {
        rows.extend(tail.pump());
        std::thread::sleep(Duration::from_millis(2));
    }
    tail.stop();
    device.join().unwrap();

    assert!(rows.len() >= 3, "decoded {} frames", rows.len());
    assert_eq!(rows[0].protocol.as_deref(), Some("C_STRUCT:ImuPacket"));
    let sync = rows[0]
        .fields
        .iter()
        .find(|field| field.name == "sync")
        .unwrap();
    assert_eq!(sync.value, "43605");
    let _: Option<&TailConfig> = None;
}
