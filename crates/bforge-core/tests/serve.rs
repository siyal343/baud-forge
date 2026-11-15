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

/// A script can change one field of a typed frame and keep the rest (D-83).
#[test]
fn a_script_changes_a_field_and_the_device_sees_it() {
    let (device, received) = chatty_device();
    let script = std::env::temp_dir().join(format!("bforge-fields-{}.lua", std::process::id()));
    std::fs::write(
        &script,
        r#"
        bforge.on_frame(function(frame)
          frame:set("v_batt_mv", 7500)
          frame:recalc_crc("crc32c")
          return frame
        end)
        "#,
    )
    .unwrap();

    let workspace = format!(
        r#"
[workspace]
name = "fields"
version = "1.0"
script_path = "{}"

[[ports]]
id = "sim"
transport = "tcp-client"
address = "{device}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}
dissector = {{ type = "c_header", file = "{header}", root_struct = "ImuPacket" }}
"#,
        script.display().to_string().replace('\\', "/"),
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
    session.enable_script(&script).expect("script loads");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let heard = received;
        let (status, body) = post(
            &address,
            "/api/send",
            r#"{"port":"sim","values":{"sync":43605,"version":3,"v_batt_mv":7400,"mode":1}}"#,
        );
        assert!(status.contains("200"), "{status} {body}");

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
        assert_eq!(
            u16::from_be_bytes([seen[8], seen[9]]),
            7500,
            "the script set the battery: {seen:02X?}"
        );
        assert_eq!(&seen[0..2], &[0x55, 0xAA], "the sync word is untouched");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    let _ = std::fs::remove_file(&script);
    assert!(stats.requests >= 1, "{stats:?}");
}

/// The ribbon's Yield button has a route, and it releases the port.
#[test]
fn a_yield_request_releases_the_port() {
    let (device, _received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let session = Session::start(ports, None, None).expect("session");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let (status, body) = post(&address, "/api/yield", r#"{"port":"sim","seconds":1}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"yielded_seconds\":1"), "{body}");

        let (status, body) = post(&address, "/api/yield", r#"{"port":"nope"}"#);
        assert!(status.contains("404"), "{status} {body}");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 2, "{stats:?}");
}

/// The ribbon's RECLAIM button has a route, and it cancels a pending window.
#[test]
fn a_reclaim_request_ends_the_yield() {
    let (device, _received) = chatty_device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let session = Session::start(ports, None, None).expect("session");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        // Surrender the port for far longer than the test will ever run.
        let (status, body) = post(&address, "/api/yield", r#"{"port":"sim","seconds":30}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"yielded_seconds\":30"), "{body}");

        // Reclaim: the window ends now, not when the 30 s run out.
        let (status, body) = post(&address, "/api/yield/reclaim", r#"{"port":"sim"}"#);
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"reclaimed\":true"), "{body}");

        // An unknown port says so instead of pretending.
        let (status, body) = post(&address, "/api/yield/reclaim", r#"{"port":"nope"}"#);
        assert!(status.contains("404"), "{status} {body}");
    });

    let stats = server
        .run(session, Some(Duration::from_secs(3)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 3, "{stats:?}");
}

/// The scrubber can seek by time, which is what a timeline in seconds needs.
#[test]
fn a_vault_window_can_be_seeked_by_time() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let vault = std::env::temp_dir().join(format!("bforge-time-{}.bflog", std::process::id()));
    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));

    let mut session = Session::start(ports, Some(&vault), None).expect("session");
    session.enable_decode(&config.ports).expect("decode");
    let server = Server::bind("127.0.0.1:0".parse().unwrap())
        .expect("bind")
        .with_vault(bforge_core::serve::VaultSource {
            path: vault.clone(),
            ports: config.ports.clone(),
        });
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));

        let (status, body) = get(&address, "/api/vault");
        assert!(status.contains("200"), "{status} {body}");
        assert!(
            body.contains("\"duration_ms\":"),
            "a timeline needs the span: {body}"
        );

        let (status, body) = get(&address, "/api/vault/frames?t_ms=0&count=20");
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"rows\":["), "{body}");

        // A time past the end lands on the last record rather than failing.
        let (status, body) = get(&address, "/api/vault/frames?t_ms=99999999&count=5");
        assert!(status.contains("200"), "{status} {body}");

        let _ = std::fs::remove_file(&vault);
        let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 3, "{stats:?}");
}

/// FR-STO-02 over HTTP: the vault leaves as a file, with the name and type a client saves.
#[test]
fn a_vault_exports_over_http_with_a_filename() {
    let device = device();
    let config = workspace(&device);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let vault =
        std::env::temp_dir().join(format!("bforge-serve-export-{}.bflog", std::process::id()));
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

        let (status, body) = get(&address, "/api/vault/export?format=csv");
        assert!(status.contains("200"), "{status} {body}");
        assert!(
            body.starts_with("seq,timestamp_ns,seconds,port,direction"),
            "a CSV header: {body}"
        );
        assert!(body.lines().count() > 2, "rows after the header: {body}");

        let (status, body) = get(&address, "/api/vault/export?format=jsonl");
        assert!(status.contains("200"), "{status} {body}");
        assert!(
            body.starts_with("{\"seq\":0,"),
            "a JSON object per line: {body}"
        );

        // A name nobody defined is a client error that says what the names are.
        let (status, body) = get(&address, "/api/vault/export?format=xlsx");
        assert!(status.contains("400"), "{status} {body}");
        assert!(body.contains("csv, jsonl"), "{body}");

        let _ = std::fs::remove_file(&vault);
        let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 3, "{stats:?}");
}

/// Review mode: a vault with no workspace beside it still reads as rows.
#[test]
fn a_vault_without_a_workspace_reads_as_records() {
    let path = std::env::temp_dir().join(format!("bforge-review-{}.bflog", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let mut writer =
        bforge_storage::LogWriter::create(&path, bforge_storage::LogHeader::default()).unwrap();
    for index in 0..5u64 {
        writer
            .append(
                &bforge_storage::RawChunk {
                    seq_id: index,
                    timestamp_ns: 1_000_000 * (index + 1),
                    port_id: 0,
                    direction: bforge_hal::Direction::Rx,
                    line_state: bforge_hal::PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: 3,
                },
                b"abc",
            )
            .unwrap();
    }
    writer.seal().unwrap();

    let server = Server::bind("127.0.0.1:0".parse().unwrap())
        .expect("bind")
        .with_vault(bforge_core::serve::VaultSource {
            path: path.clone(),
            ports: Vec::new(),
        });
    let address = server.local_addr().unwrap().to_string();
    let session = Session::review();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let (status, body) = get(&address, "/api/vault/frames?at=0&count=10");
        assert!(status.contains("200"), "{status} {body}");
        assert!(body.contains("\"port\":\"port 0\""), "{body}");
        assert!(body.contains("\"len\":3"), "{body}");
        assert!(body.contains("\"hex\":\"61 62 63\""), "{body}");
        assert!(
            body.contains("\"fields\":[]"),
            "nothing is decoded without a workspace: {body}"
        );
        let _ = std::fs::remove_file(&path);
    });

    let stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
    assert!(stats.requests >= 1, "{stats:?}");
}

#[test]
fn devices_and_quick_connect_and_export() {
    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();
    let session = Session::review();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));

        // GET /api/devices
        let (status, body) = get(&address, "/api/devices");
        assert!(status.contains("200"), "devices status: {status}");
        assert!(
            body.starts_with('[') && body.ends_with(']'),
            "devices body: {body}"
        );

        // POST /api/quick-connect — an honest 501: a running session's ports
        // are fixed (the desktop launcher's Tauri quick-connect is the path
        // that opens one). The requested config is still recorded, which the
        // export checks below depend on.
        let (status, body) = post(
            &address,
            "/api/quick-connect",
            r#"{"device":"COM99","baud_rate":115200,"framing":"delimiter"}"#,
        );
        assert!(status.contains("501"), "quick-connect status: {status}");
        assert!(body.contains("\"ok\":false"), "quick-connect body: {body}");
        assert!(
            body.contains("ports are fixed"),
            "quick-connect body: {body}"
        );

        // POST /api/workspace/export
        let (status, body) = post(&address, "/api/workspace/export", "{}");
        assert!(status.contains("200"), "export status: {status}");
        assert!(body.contains("\"toml\":"), "export body: {body}");
        assert!(body.contains("COM99"), "export contains device: {body}");
        assert!(body.contains("serial0"), "export contains port: {body}");

        // GET /api/workspace/export
        let (status, body) = get(&address, "/api/workspace/export");
        assert!(status.contains("200"), "get export status: {status}");
        assert!(body.contains("\"toml\":"), "get export body: {body}");
    });

    let _stats = server
        .run(session, Some(Duration::from_secs(2)))
        .expect("serve");
    client.join().expect("client");
}

#[test]
fn script_http_lifecycle_compile_dry_run_arm_reset_disarm_and_snapshot() {
    let dev = device();
    let config = workspace(&dev);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let lua_script = r#"
        bforge.on_rx_frame("sim", function(frame)
            local acc = 0
            for i = 1, 400 do acc = acc + i end
            frame:set("v_batt_mv", 9123)
            frame:recalc_crc("crc32c")
            bforge.metric("batt_override", 9123)
            bforge.assert(frame.port == "sim", "valid_imu")
            bforge.plot("lua_v_batt", 9123)
            bforge.log("rx rewritten")
            return frame
        end)
    "#;
    let sample_hex: String = imu_frame(3)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));

        // 1. Disarmed initially
        let (status, body) = get(&address, "/api/script");
        assert!(status.contains("200"), "{status} {body}");
        let initial: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(initial["ok"], true);
        assert!(initial["source"].is_null(), "{body}");
        assert!(initial["status"].is_null(), "{body}");

        let (status, body) = get(&address, "/api/snapshot");
        assert!(status.contains("200"), "{status}");
        let snap: bforge_core::contract::UiSnapshot = serde_json::from_str(&body).unwrap();
        assert!(snap.script.is_none());

        // 2. Compile failure returns HTTP 400
        let (status, body) = post(
            &address,
            "/api/script",
            r#"{"action":"compile","source":"local = "}"#,
        );
        assert!(
            status.contains("400"),
            "compile fail status: {status} {body}"
        );
        let compile_err: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(compile_err["ok"], false);
        assert!(compile_err["error"].is_string());

        // 3. Valid compile returns HTTP 200 and hook list
        let compile_req = serde_json::json!({
            "action": "compile",
            "name": "rx_rewrite.lua",
            "source": lua_script,
        });
        let (status, body) = post(&address, "/api/script", &compile_req.to_string());
        assert!(status.contains("200"), "compile ok status: {status} {body}");
        let compiled: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(compiled["ok"], true);
        assert!(
            compiled["hooks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|h| h == "on_rx_frame:sim"),
            "{body}"
        );

        // 4. test_frame dry-run returns diff, metrics, assertions, plot/log actions
        let test_req = serde_json::json!({
            "action": "test_frame",
            "name": "rx_rewrite.lua",
            "port": "sim",
            "direction": "rx",
            "hex": sample_hex,
            "source": lua_script,
        });
        let (status, body) = post(&address, "/api/script", &test_req.to_string());
        assert!(status.contains("200"), "test_frame status: {status} {body}");
        let dry: bforge_core::contract::ScriptDryRunView =
            serde_json::from_str(&body).expect("dry run json");
        assert!(dry.ok, "{body}");
        assert_eq!(dry.verdict, "send");
        assert!(dry.mutated);
        assert_ne!(dry.input_hex, dry.output_hex);
        assert!(dry.instructions > 0);
        assert!(dry.memory_bytes > 0);
        assert!(
            dry.field_diffs
                .iter()
                .any(|d| d.name == "v_batt_mv" && d.after.as_deref() == Some("9123")),
            "expected v_batt_mv field diff: {:?}",
            dry.field_diffs
        );
        assert_eq!(
            dry.metrics.get("batt_override").map(String::as_str),
            Some("9123")
        );
        assert!(
            dry.assertions
                .iter()
                .any(|a| a.name == "valid_imu" && a.passed == 1 && a.failed == 0),
            "{:?}",
            dry.assertions
        );
        assert!(dry.actions.iter().any(|a| matches!(
            a,
            bforge_core::contract::ScriptActionView::Plot { series, value, .. }
                if series == "lua_v_batt" && (*value - 9123.0).abs() < 1e-6
        )));
        assert!(dry.actions.iter().any(|a| matches!(
            a,
            bforge_core::contract::ScriptActionView::Log { level, message }
                if level == "info" && message == "rx rewritten"
        )));

        // 5. Arm invalid returns 400; arm valid returns 200
        let (status, _) = post(
            &address,
            "/api/script",
            r#"{"action":"arm","source":"function broken("}"#,
        );
        assert!(status.contains("400"), "arm invalid status: {status}");

        let arm_req = serde_json::json!({
            "action": "arm",
            "name": "rx_rewrite.lua",
            "policy": "fail_open",
            "source": lua_script,
        });
        let (status, body) = post(&address, "/api/script", &arm_req.to_string());
        assert!(status.contains("200"), "arm ok status: {status} {body}");
        let armed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(armed["ok"], true);
        assert_eq!(armed["status"]["armed"], true);
        assert_eq!(armed["status"]["name"], "rx_rewrite.lua");

        // Wait for live RX frames to invoke the armed hook
        std::thread::sleep(Duration::from_millis(250));

        let (status, body) = get(&address, "/api/script");
        assert!(status.contains("200"), "{status}");
        let live: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(live["source"], lua_script);
        assert!(
            live["status"]["invocations"].as_u64().unwrap_or(0) > 0,
            "{body}"
        );
        assert!(
            live["status"]["changed"].as_u64().unwrap_or(0) > 0,
            "{body}"
        );
        assert_eq!(live["status"]["metrics"]["batt_override"], "9123");

        let (status, body) = get(&address, "/api/snapshot");
        assert!(status.contains("200"), "{status}");
        let snap: bforge_core::contract::UiSnapshot = serde_json::from_str(&body).unwrap();
        let snap_script = snap.script.expect("snapshot.script populated when armed");
        assert!(snap_script.armed);
        assert!(snap_script.invocations > 0);

        let (status, logs_body) = get(&address, "/api/logs?limit=200");
        assert!(status.contains("200"), "{status}");
        assert!(
            logs_body.contains("rx rewritten"),
            "script log missing: {logs_body}"
        );

        // 6. reset_stats clears invocations immediately
        let (status, body) = post(&address, "/api/script", r#"{"action":"reset_stats"}"#);
        assert!(status.contains("200"), "{status} {body}");
        let reset_val: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reset_val["ok"], true);
        assert_eq!(reset_val["status"]["invocations"], 0, "{body}");

        // 7. disarm clears armed state and snapshot.script
        let (status, body) = post(&address, "/api/script", r#"{"action":"disarm"}"#);
        assert!(status.contains("200"), "{status} {body}");
        let disarm_val: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(disarm_val["ok"], true);
        assert!(disarm_val["status"].is_null());

        let (status, body) = get(&address, "/api/snapshot");
        assert!(status.contains("200"), "{status}");
        let snap: bforge_core::contract::UiSnapshot = serde_json::from_str(&body).unwrap();
        assert!(snap.script.is_none());

        let _ = post(&address, "/api/session/stop", "{}");
    });

    server
        .run(session, Some(Duration::from_secs(4)))
        .expect("serve");
    client.join().expect("client");
}

#[test]
fn framed_rx_hook_redecodes_and_emits_script_plot_series_over_sse() {
    let dev = device();
    let config = workspace(&dev);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");
    session
        .arm_script_source(
            r#"
            bforge.on_rx_frame("sim", function(frame)
                frame:set("v_batt_mv", 8888)
                frame:recalc_crc("crc32c")
                bforge.plot("custom_batt", 8888)
                return frame
            end)
            "#,
            "rx_plot.lua",
            "fail_open",
            None,
            None,
        )
        .expect("arm script");

    let server = Server::bind("127.0.0.1:0".parse().unwrap()).expect("bind");
    let address = server.local_addr().unwrap().to_string();

    let client = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        let mut stream = TcpStream::connect(&address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let req = "GET /api/events HTTP/1.1\r\nHost: test\r\nAccept: text/event-stream\r\n\r\n";
        stream.write_all(req.as_bytes()).unwrap();

        let mut seen = String::new();
        let mut buf = [0u8; 8192];
        while !(seen.contains("8888") && seen.contains("script:custom_batt")) {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => seen.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
            if seen.len() > 256 * 1024 {
                break;
            }
        }
        assert!(
            seen.contains("8888"),
            "expected redecoded field 8888 in SSE: {seen}"
        );
        assert!(
            seen.contains("\"port\":\"script\"")
                && seen.contains("\"field\":\"script:custom_batt\""),
            "expected script plot series in SSE: {seen}"
        );
        let _ = post(&address, "/api/session/stop", "{}");
    });

    server
        .run(session, Some(Duration::from_secs(4)))
        .expect("serve");
    client.join().expect("client");
}

#[test]
fn mitm_bridge_and_tx_delay_hooks_work_end_to_end() {
    let listener_a = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr_a = listener_a.local_addr().unwrap().to_string();
    std::thread::spawn(move || {
        let (mut s, _) = listener_a.accept().unwrap();
        let _ = s.write_all(b"ping\n");
        std::thread::sleep(Duration::from_secs(2));
    });

    let listener_b = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr_b = listener_b.local_addr().unwrap().to_string();
    let received_b = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink_b = Arc::clone(&received_b);
    std::thread::spawn(move || {
        let (mut s, _) = listener_b.accept().unwrap();
        let mut buf = [0u8; 128];
        while let Ok(n) = s.read(&mut buf) {
            if n == 0 {
                break;
            }
            sink_b.lock().unwrap().extend_from_slice(&buf[..n]);
        }
    });

    let workspace = format!(
        r#"
[workspace]
name = "mitm-script"
version = "1.0"

[[ports]]
id = "a"
transport = "tcp-client"
address = "{addr_a}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}

[[ports]]
id = "b"
transport = "tcp-client"
address = "{addr_b}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}

[[bridges]]
id = "link"
a = "a"
b = "b"
forward = true
"#
    );
    let config: bforge_core::ProjectConfig = toml::from_str(&workspace).expect("workspace");
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_decode(&config.ports).expect("decode");
    session.enable_bridges(&config.bridges).expect("bridges");
    session
        .arm_script_source(
            r#"
            bforge.on_mitm_frame("*", function(frame)
                bforge.metric("mitm_dir", frame.direction)
                frame:set_bytes("70 6f 6e 67 0a")
                return frame:delay_ms(25)
            end)
            bforge.on_tx_frame("b", function(frame)
                frame:set_bytes("74 78 6f 6b 0a")
                return frame:delay_ms(15)
            end)
            "#,
            "mitm_tx.lua",
            "fail_open",
            None,
            None,
        )
        .expect("arm script");

    // Trigger TX delay hook explicitly on port b
    let outcome = session
        .send("b", b"hello\n".to_vec(), Duration::from_secs(1))
        .expect("send tx");
    assert!(outcome.delay.is_some(), "expected tx delay outcome");

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        session.pump_once().expect("pump");
        let got = String::from_utf8_lossy(&received_b.lock().unwrap()).to_string();
        if got.contains("pong\n") && got.contains("txok\n") {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    let status = session.script_status().expect("script status");
    session.seal().expect("seal");

    let got = String::from_utf8_lossy(&received_b.lock().unwrap()).to_string();
    assert!(got.contains("txok\n"), "missing tx rewrite: {got:?}");
    assert!(got.contains("pong\n"), "missing mitm rewrite: {got:?}");
    assert!(!got.contains("ping\n"), "original ping leaked: {got:?}");
    assert!(
        status.delayed >= 2,
        "expected >=2 delayed verdicts: {status:?}"
    );
    assert_eq!(
        status.metrics.get("mitm_dir").map(String::as_str),
        Some("mitm_a_to_b")
    );
}
