//! A bridge joins two ports: a passive tap shares a timeline, a forwarding bridge
//! writes what one side receives to the other (FR-MITM-01, spec 0025).

use bforge_core::session::{Session, session_ports_from_config};
use bforge_core::{BridgeConfig, ProjectConfig};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A device on loopback: it writes a line every 10 ms and records what it receives.
fn device(name: &'static str) -> (String, Arc<Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        std::thread::spawn(move || {
            for index in 0..400 {
                if writer
                    .write_all(format!("{name} {index}\n").as_bytes())
                    .is_err()
                {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_millis(200));
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

fn workspace(left: &str, right: &str, forward: bool) -> ProjectConfig {
    let text = format!(
        r#"
[workspace]
name = "bridge"
version = "1.0"

[[ports]]
id = "obc"
transport = "tcp-client"
address = "{left}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}

[[ports]]
id = "eps"
transport = "tcp-client"
address = "{right}"
baud_rate = 115200
framing = {{ mode = "delimiter", delimiter = 10 }}

[[bridges]]
id = "link"
a = "obc"
b = "eps"
forward = {forward}
"#
    );
    toml::from_str(&text).expect("workspace parses")
}

fn wait_for(received: &Arc<Mutex<Vec<u8>>>, len: usize, timeout: Duration) -> Vec<u8> {
    let deadline = Instant::now() + timeout;
    loop {
        let seen = received.lock().unwrap().clone();
        if seen.len() >= len || Instant::now() >= deadline {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_forwarding_bridge_carries_bytes_both_ways() {
    let (left, left_in) = device("obc");
    let (right, right_in) = device("eps");
    let config = workspace(&left, &right, true);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session
        .enable_bridges(&[BridgeConfig {
            id: "link".into(),
            a: "obc".into(),
            b: "eps".into(),
            forward: true,
        }])
        .expect("bridges");

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        session.pump_once().expect("pump");
        std::thread::sleep(Duration::from_millis(2));
    }

    let got_right = wait_for(&right_in, 20, Duration::from_secs(2));
    let got_left = wait_for(&left_in, 20, Duration::from_secs(2));
    assert!(
        got_right.starts_with(b"obc "),
        "eps received what obc sent: {}",
        String::from_utf8_lossy(&got_right)
    );
    assert!(
        got_left.starts_with(b"eps "),
        "obc received what eps sent: {}",
        String::from_utf8_lossy(&got_left)
    );

    let snapshot = session.snapshot();
    assert_eq!(snapshot.bridges.len(), 1);
    assert!(snapshot.bridges[0].forward);
    assert!(
        snapshot.bridges[0].forwarded > 0,
        "{:?}",
        snapshot.bridges[0]
    );
    session.seal().expect("seal");
}

#[test]
fn a_passive_bridge_records_both_sides_and_sends_nothing() {
    let (left, left_in) = device("obc");
    let (right, right_in) = device("eps");
    let config = workspace(&left, &right, false);
    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, None, None).expect("session");
    session.enable_bridges(&config.bridges).expect("bridges");

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        session.pump_once().expect("pump");
        std::thread::sleep(Duration::from_millis(2));
    }

    assert!(
        wait_for(&right_in, 1, Duration::from_millis(300)).is_empty(),
        "nothing forwarded"
    );
    assert!(
        wait_for(&left_in, 1, Duration::from_millis(300)).is_empty(),
        "nothing forwarded"
    );
    let snapshot = session.snapshot();
    assert_eq!(snapshot.bridges[0].forwarded, 0);
    // Both sides are still recorded, which is what a tap is for.
    assert!(
        snapshot.ports.iter().all(|port| port.chunks > 0),
        "{:?}",
        snapshot.ports
    );
    session.seal().expect("seal");
}

#[test]
fn a_bridge_names_ports_that_exist() {
    let text = r#"
[workspace]
name = "bridge"
version = "1.0"

[[ports]]
id = "obc"
transport = "tcp-client"
address = "127.0.0.1:1"
baud_rate = 115200
framing = { mode = "delimiter", delimiter = 10 }

[[bridges]]
id = "link"
a = "obc"
b = "eps"
"#;
    let config: ProjectConfig = toml::from_str(text).expect("parses");
    let issues = config.validate();
    assert!(
        issues.iter().any(|issue| issue.path == "bridges[0].b"),
        "{issues:?}"
    );
}

#[test]
fn the_vault_records_both_directions_of_a_bridged_pair() {
    let (left, _left_in) = device("obc");
    let (right, _right_in) = device("eps");
    let config = workspace(&left, &right, true);
    let vault = std::env::temp_dir().join(format!("bforge-bridge-{}.bflog", std::process::id()));
    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));

    let ports = session_ports_from_config(&config, &[]).expect("ports");
    let mut session = Session::start(ports, Some(&vault), None).expect("session");
    session.enable_bridges(&config.bridges).expect("bridges");

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        session.pump_once().expect("pump");
        std::thread::sleep(Duration::from_millis(2));
    }
    session.seal().expect("seal");

    // The forwarded copies are in the vault as transmit, which is what makes a
    // bridged session auditable.
    let mut reader = bforge_storage::LogReader::open(&vault).expect("vault opens");
    let records = reader.window(0, 10_000).expect("window");
    let tx = records
        .iter()
        .filter(|record| record.chunk.direction == bforge_hal::Direction::Tx)
        .count();
    let rx = records
        .iter()
        .filter(|record| record.chunk.direction == bforge_hal::Direction::Rx)
        .count();
    assert!(tx > 0, "forwarded bytes are recorded as transmit");
    assert!(rx > 0, "arriving bytes are recorded as receive");

    // And a decoded window says which way each frame went.
    let port = config
        .ports
        .iter()
        .find(|port| port.id == "eps")
        .expect("eps");
    let rows = bforge_core::tail::decode_window(&mut reader, port, 0, 10_000).expect("decode");
    assert!(
        rows.iter()
            .any(|row| row.direction == bforge_hal::Direction::Tx),
        "a forwarded frame decodes as transmit"
    );

    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
}
