//! `bforge serve` end to end: a loopback HTTP surface over a real session.
//!
//! The device is a socket simulator, so this runs in CI with no hardware.

use bforge_core::serve::Server;
use bforge_core::session::{Session, session_ports_from_config};
use bforge_framer::cobs_encode;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
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

/// A device that writes frames and records everything the engine sends it.
fn chatty_device() -> (String, Arc<Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        std::thread::spawn(move || {
            for index in 0..500u64 {
                let mut payload = cobs_encode(&imu_frame(index));
                payload.push(0);
                if writer.write_all(&payload).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(4));
            }
            std::thread::sleep(Duration::from_millis(500));
        });
        let mut buffer = [0u8; 256];
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 {
                return;
            }
            sink.lock().unwrap().extend_from_slice(&buffer[..count]);
        }
    });
    (address, received)
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

/// A POST with a JSON body against the serve surface.
fn post(address: &str, path: &str, body: &str) -> (String, String) {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
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
fn a_send_request_reaches_the_port_with_its_checksum() {
    let (device, received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let heard = received;

        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"AA 55 03"}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"sent\":3"), "{body}");

        // A checksum is appended little endian, four bytes for CRC-32C.
        let (status, body) = post(
            &address,
            "/api/send",
            r#"{"port":"sim","hex":"aa5503","crc":"crc32c"}"#,
        );
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"sent\":7"), "{body}");

        // A port that is not in the session is refused.
        let (status, body) = post(&address, "/api/send", r#"{"port":"nope","hex":"00"}"#);
        assert!(status.contains("404"), "{status} {body}");

        // Odd hex is a bad request, not a silent send.
        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"ABC"}"#);
        assert!(status.contains("400"), "{status} {body}");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            seen = heard.lock().unwrap().clone();
            if seen.len() >= 10 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.starts_with(&[0xAA, 0x55, 0x03]), "{seen:02X?}");
        assert_eq!(seen[3], 0xAA, "the second frame follows: {seen:02X?}");
        assert_eq!(seen.len(), 10, "3 bytes then 7 bytes: {seen:02X?}");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 4, "{stats:?}");
}

#[test]
fn an_armed_fault_changes_the_bytes_the_device_receives() {
    let (device, received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let heard = received;

        // Every byte gets exactly one bit flipped, with a fixed seed.
        let (status, body) = post(
            &address,
            "/api/fault",
            r#"{"port":"sim","kind":"bit_flip","flip_rate":1.0,"seed":7}"#,
        );
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"flip_rate\":1.0"), "{body}");

        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"0000"}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"fault_bytes\":2"), "{body}");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            seen = heard.lock().unwrap().clone();
            if seen.len() >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(seen.len(), 2, "{seen:02X?}");
        for (index, byte) in seen.iter().enumerate() {
            assert_eq!(
                byte.count_ones(),
                1,
                "byte {index} is one flipped bit: {byte:08b}"
            );
        }

        // Off leaves the port clean.
        let (status, body) = post(&address, "/api/fault", r#"{"port":"sim","kind":"off"}"#);
        assert!(status.contains("200"), "{status} {body}");
        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"00"}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"fault_bytes\":0"), "{body}");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 4, "{stats:?}");
}

#[test]
fn a_scrubber_reads_a_frame_window_from_the_vault() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let vault = std::env::temp_dir().join(format!("bforge-serve-{}.bflog", std::process::id()));
    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));

    let mut session =
        Session::start(ports, Some(&vault), None).expect("session records to the vault");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap())
        .expect("bind")
        .with_vault(bforge_core::serve::VaultSource {
            path: vault.clone(),
            ports: config.ports.clone(),
        });
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));

        let (status, body) = get(&address, "/api/vault");
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"records\":"), "{body}");
        assert!(body.contains("\"bytes\":"), "{body}");

        let (status, body) = get(&address, "/api/vault/frames?at=0&count=50");
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"rows\":["), "{body}");
        assert!(
            body.contains("\"port\":\"sim\""),
            "rows carry their port: {body}"
        );
        assert!(
            body.contains("C_STRUCT:ImuPacket"),
            "rows are decoded: {body}"
        );

        // A window past the end is empty, not an error.
        let (status, body) = get(&address, "/api/vault/frames?at=9999999&count=10");
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"rows\":[]"), "{body}");

        let _ = std::fs::remove_file(&vault);
        let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 3, "{stats:?}");
}

/// The script runs on the transmit path: the device receives what the script made,
/// not what was posted.
#[test]
fn a_script_rewrites_what_the_device_receives() {
    let (device, received) = chatty_device();
    let script = std::env::temp_dir().join(format!("bforge-script-{}.lua", std::process::id()));
    std::fs::write(
        &script,
        r#"
        bforge.on_frame(function(frame)
          local bytes = bforge.unhex(frame)
          bytes[#bytes] = bytes[#bytes] ~ 0xFF
          return bforge.hex(bytes)
        end)
        "#,
    )
    .unwrap();
    let workspace = format!(
        r#"
[workspace]
name = "script"
version = "1.0"
script_path = "{}"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{device}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}
"#,
        script.display().to_string().replace('\\', "/")
    );
    let config: bforge_core::ProjectConfig = toml::from_str(&workspace).expect("workspace");
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_script(&script).expect("the script loads");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let cleanup = script.clone();
    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let heard = received;
        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"01 02 03"}"#);
        assert!(status.contains("200"), "{status} {body}");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            seen = heard.lock().unwrap().clone();
            if seen.len() >= 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            seen,
            vec![0x01, 0x02, 0x03 ^ 0xFF],
            "the last byte was flipped"
        );
        let _ = std::fs::remove_file(&cleanup);
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 1, "{stats:?}");
}

/// A typed send is encoded with the same schema the decoder uses.
#[test]
fn values_are_encoded_with_the_port_schema() {
    let (device, received) = chatty_device();
    let workspace = format!(
        r#"
[workspace]
name = "typed"
version = "1.0"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{device}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}
dissector = {{ type = "c_header", file = "{header}", root_struct = "ImuPacket" }}
"#,
        header = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../bforge-dissect/tests/fixtures/imu_packet.h")
            .display()
            .to_string()
            .replace('\\', "/")
    );
    let config: bforge_core::ProjectConfig = toml::from_str(&workspace).expect("workspace");
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let heard = received;

        // 19 bytes from named values: no hex, no manual byte offsets.
        let (status, body) = post(
            &address,
            "/api/send",
            r#"{"port":"sim","values":{"sync":43605,"version":3,"flags":5,"channel":9,"v_batt_mv":7400,"gyro_z":0.25,"mode":1}}"#,
        );
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"sent\":19"), "{body}");

        // A name the schema does not have is refused, not sent as zeros.
        let (status, body) = post(
            &address,
            "/api/send",
            r#"{"port":"sim","values":{"v_bat_mv":7400}}"#,
        );
        assert!(status.contains("409"), "{status} {body}");
        assert!(body.contains("v_bat_mv"), "{body}");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            seen = heard.lock().unwrap().clone();
            if seen.len() >= 19 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(seen.len() >= 19, "{seen:02X?}");
        // sync 0xAA55 little endian, version 3, then flags|channel<<3, then the battery.
        assert_eq!(&seen[0..3], &[0x55, 0xAA, 0x03], "{seen:02X?}");
        assert_eq!(seen[3], 5 | (9 << 3), "bitfields share byte 3");
        assert_eq!(&seen[8..10], &[0x1C, 0xE8], "big endian battery");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 2, "{stats:?}");
}

/// A client that cannot keep up is told that it is seeing a sample (D-81).
#[test]
fn a_slow_client_is_told_its_frames_were_sampled() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        // Connect from a device that produces faster than this reader drains: the
        // test client reads nothing for a moment, so batches are replaced.
        let mut stream = TcpStream::connect(&address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .write_all(b"GET /api/events HTTP/1.1\r\nHost: test\r\n\r\n")
            .unwrap();
        std::thread::sleep(Duration::from_millis(900));

        let mut seen = String::new();
        let mut buffer = [0u8; 8192];
        while !seen.contains("event: sampled") {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => seen.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Err(_) => break,
            }
            if seen.len() > 512 * 1024 {
                break;
            }
        }
        assert!(
            seen.contains("event: sampled"),
            "the client is told it missed frames"
        );
        assert!(seen.contains("\"missed\":"), "{seen}");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.clients_max >= 1, "{stats:?}");
}

/// A delayed write is held by the reader and lands late, without blocking anything.
#[test]
fn a_delay_fault_holds_the_frame_and_still_reports_it() {
    let (device, received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let heard = received;

        let (status, body) = post(
            &address,
            "/api/fault",
            r#"{"port":"sim","kind":"delay","delay_ms":300}"#,
        );
        assert!(status.contains("200"), "{status} {body}");

        let started = Instant::now();
        let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"01 02 03"}"#);
        let answering = started.elapsed();
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"delay_ms\":300"), "{body}");
        assert!(
            answering < Duration::from_millis(150),
            "the send answered in {answering:?}, so it waited for the delay"
        );

        // Nothing has left yet, and then it does.
        let early = heard.lock().unwrap().len();
        assert!(early < 3, "bytes left before the delay ended: {early}");
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut landed = Vec::new();
        while Instant::now() < deadline {
            landed = heard.lock().unwrap().clone();
            if landed.len() >= 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            landed,
            vec![0x01, 0x02, 0x03],
            "the frame left after the delay"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(250),
            "the frame left after {:?}",
            started.elapsed()
        );
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 2, "{stats:?}");
}

/// A receive script changes what the host decodes, not what it sends.
#[test]
fn an_rx_script_changes_what_the_decoder_sees() {
    // A device that sends lower-case text lines.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        for index in 0..200u32 {
            if stream
                .write_all(format!("hello {index}\n").as_bytes())
                .is_err()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(200));
    });

    let script = std::env::temp_dir().join(format!("bforge-rx-{}.lua", std::process::id()));
    std::fs::write(
        &script,
        r#"
        bforge.on_frame(function(frame)
          local bytes = bforge.unhex(frame)
          for index = 1, #bytes do
            if bytes[index] >= 97 and bytes[index] <= 122 then
              bytes[index] = bytes[index] - 32
            end
          end
          return bforge.hex(bytes)
        end)
        "#,
    )
    .unwrap();

    let workspace = format!(
        r#"
[workspace]
name = "rx"
version = "1.0"
rx_script_path = "{}"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{address}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}
"#,
        script.display().to_string().replace('\\', "/")
    );
    let config: bforge_core::ProjectConfig = toml::from_str(&workspace).expect("workspace");
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");
    session.enable_rx_script(&script).expect("rx script loads");

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        session.pump_once().expect("pump");
        std::thread::sleep(Duration::from_millis(2));
    }
    let rows = session.take_frames();
    session.seal().expect("seal");
    let _ = std::fs::remove_file(&script);

    assert!(!rows.is_empty(), "frames arrived");
    let first = &rows[0];
    assert!(
        first.text.starts_with("HELLO"),
        "the receive script uppercased it: {:?}",
        first.text
    );
}

/// Jitter spreads the hold instead of repeating one number.
#[test]
fn a_jitter_span_varies_the_delay_the_engine_reports() {
    let (device, _received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let session = Session::start(ports, None, None).expect("session");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let (status, body) = post(
            &address,
            "/api/fault",
            r#"{"port":"sim","kind":"delay","delay_ms":0,"jitter_ms":40,"seed":9}"#,
        );
        assert!(status.contains("200"), "{status} {body}");

        let mut delays = Vec::new();
        for _ in 0..8 {
            let (status, body) = post(&address, "/api/send", r#"{"port":"sim","hex":"00"}"#);
            assert!(status.contains("200"), "{status} {body}");
            let reported = body
                .split("\"delay_ms\":")
                .nth(1)
                .and_then(|rest| rest.trim_end_matches('}').parse::<u64>().ok())
                .expect("a delay in the reply");
            assert!(reported <= 40, "delay {reported} outside the span");
            delays.push(reported);
        }
        let distinct: std::collections::BTreeSet<_> = delays.iter().collect();
        assert!(
            distinct.len() > 1,
            "every frame had the same hold: {delays:?}"
        );
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 8, "{stats:?}");
}
