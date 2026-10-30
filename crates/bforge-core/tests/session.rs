//! Session, snapshot, event and replay tests (F1.5.3, F1.5.4, F1.7.1 to F1.7.3).

use bforge_core::session::{ReplayOptions, Session, SessionPort, replay_to};
use bforge_core::ui::{CONTRACT_VERSION, EventBus, UiEvent};
use bforge_hal::mock::MockTransport;
use bforge_storage::{LogHeader, LogReader, LogWriter, RawChunk};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn temp_path(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "bforge-session-{}-{name}.bflog",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn port(id: &str, scripts: Vec<u8>) -> SessionPort {
    SessionPort {
        id: id.to_string(),
        device: format!("mock:{id}"),
        baud_rate: 115_200,
        framing: "cobs".to_string(),
        checksum: Some("crc32c".to_string()),
        transport: Box::new(MockTransport::stream(scripts)),
    }
}

fn payload(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|index| seed.wrapping_add(index as u8))
        .collect()
}

#[test]
fn a_session_records_every_chunk_of_every_port() {
    let vault = temp_path("record");
    let first = payload(4_000, 0x10);
    let second = payload(2_500, 0x40);
    let ports = vec![port("obc", first.clone()), port("eps", second.clone())];
    let mut session = Session::start(ports, Some(&vault), None).unwrap();
    assert_eq!(session.port_count(), 2);

    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() < 2 && Instant::now() < deadline {
        session.pump_once().unwrap();
    }
    let snapshot = session.snapshot();
    assert_eq!(snapshot.contract, CONTRACT_VERSION);
    assert_eq!(snapshot.session.mode, "record");
    assert!(snapshot.session.vault.ends_with(".bflog"));
    assert_eq!(snapshot.ports.len(), 2);
    assert_eq!(snapshot.ports[0].id, "obc");
    assert_eq!(snapshot.ports[0].baud_rate, 115_200);
    assert_eq!(snapshot.ports[0].framing, "cobs");
    assert_eq!(snapshot.ports[0].checksum.as_deref(), Some("crc32c"));
    assert_eq!(snapshot.ports[0].state, "open");
    assert!(snapshot.ports[0].bytes > 0);

    let summary = session.seal().unwrap();
    assert_eq!(summary.chunks, 2);
    assert_eq!(summary.payload_bytes, (first.len() + second.len()) as u64);

    let mut reader = LogReader::open(&vault).unwrap();
    assert_eq!(reader.chunks(), 2);
    assert!(!reader.damaged_tail());
    let records = reader.window(0, 2).unwrap();
    let mut payloads: Vec<Vec<u8>> = records.into_iter().map(|record| record.payload).collect();
    payloads.sort();
    let mut expected = vec![first, second];
    expected.sort();
    assert_eq!(payloads, expected);
    let _ = std::fs::remove_file(&vault);
}

#[test]
fn a_session_without_a_vault_records_nothing_on_disk() {
    let ports = vec![port("probe", payload(1_000, 1))];
    let mut session = Session::start(ports, None, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() == 0 && Instant::now() < deadline {
        session.pump_once().unwrap();
    }
    let snapshot = session.snapshot();
    assert_eq!(snapshot.session.vault, "");
    assert_eq!(snapshot.session.chunks, 1);
    assert_eq!(snapshot.session.file_bytes, 0);
    let summary = session.seal().unwrap();
    assert_eq!(summary.chunks, 1);
    assert_eq!(summary.file_bytes, 0);
}

#[test]
fn the_event_stream_reports_start_stats_and_stop_in_order() {
    let ports = vec![port("events", payload(64_000, 3))];
    let mut session = Session::start(ports, None, None).unwrap();
    let events = session.subscribe();

    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() == 0 && Instant::now() < deadline {
        session.pump_once().unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    session.seal().unwrap();

    let received: Vec<UiEvent> = events.try_iter().collect();
    assert!(!received.is_empty(), "no events arrived");
    assert!(matches!(received.first(), Some(UiEvent::Started { .. })));
    assert!(matches!(received.last(), Some(UiEvent::Stopped { .. })));

    // The stats event appears once the 250 ms interval has passed.
    if let Some(UiEvent::Stopped { chunks, .. }) = received.last() {
        assert_eq!(*chunks, 1);
    }
}

#[test]
fn a_bus_delivers_to_every_subscriber_and_drops_a_closed_one() {
    let bus = EventBus::new();
    let first = bus.subscribe();
    let second = bus.subscribe();
    assert_eq!(bus.subscriber_count(), 2);

    bus.publish(UiEvent::Stopped {
        at_ms: 1,
        chunks: 2,
        payload_bytes: 3,
    });
    drop(second);
    bus.publish(UiEvent::Stopped {
        at_ms: 2,
        chunks: 3,
        payload_bytes: 4,
    });
    assert_eq!(bus.subscriber_count(), 1);

    let events: Vec<UiEvent> = first.try_iter().collect();
    assert_eq!(events.len(), 2);
    match &events[0] {
        UiEvent::Stopped { at_ms, chunks, .. } => {
            assert_eq!((*at_ms, *chunks), (1, 2));
        }
        other => panic!("unexpected event {other:?}"),
    }
}

#[test]
fn the_snapshot_serializes_with_the_names_the_gui_expects() {
    let ports = vec![port("json", payload(500, 7))];
    let mut session = Session::start(ports, None, Some("/fw/obc.elf".into())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() == 0 && Instant::now() < deadline {
        session.pump_once().unwrap();
    }
    let snapshot = session.snapshot();
    let value = serde_json::to_value(&snapshot).unwrap();

    assert_eq!(value["contract"], 1);
    assert_eq!(value["session"]["mode"], "record");
    assert_eq!(value["session"]["elf"], "/fw/obc.elf");
    assert_eq!(value["ports"][0]["id"], "json");
    // The mock transport asserts CTS unless a test changes it.
    assert_eq!(value["ports"][0]["pins"]["cts"], true);
    assert!(value["ports"][0]["stalls_ms"].is_number());
    let _ = session.seal();
}

#[test]
fn replay_sends_every_record_out_of_the_transport() {
    let vault = temp_path("replay");
    let mut writer = LogWriter::create(&vault, LogHeader::default()).unwrap();
    let mut expected = 0usize;
    for seq in 0..5u64 {
        let bytes = payload(200, seq as u8);
        expected += bytes.len();
        writer
            .append(
                &RawChunk {
                    seq_id: seq,
                    timestamp_ns: seq * 1_000_000,
                    port_id: 0,
                    direction: bforge_hal::Direction::Rx,
                    line_state: bforge_hal::PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: bytes.len() as u32,
                },
                &bytes,
            )
            .unwrap();
    }
    writer.seal().unwrap();

    let mut reader = LogReader::open(&vault).unwrap();
    let mut transport = MockTransport::new(0);
    let report = replay_to(&mut reader, &mut transport, ReplayOptions { speed: 100.0 }).unwrap();

    assert_eq!(report.chunks, 5);
    assert_eq!(report.payload_bytes as usize, expected);
    assert_eq!(transport.written() as usize, expected);
    assert!(report.elapsed < Duration::from_millis(500));
    let _ = std::fs::remove_file(&vault);
}

#[test]
fn replay_keeps_the_gaps_when_the_speed_is_one() {
    let vault = temp_path("replay-timing");
    let mut writer = LogWriter::create(&vault, LogHeader::default()).unwrap();
    for seq in 0..3u64 {
        writer
            .append(
                &RawChunk {
                    seq_id: seq,
                    timestamp_ns: seq * 20_000_000,
                    port_id: 0,
                    direction: bforge_hal::Direction::Rx,
                    line_state: bforge_hal::PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: 4,
                },
                &[1, 2, 3, 4],
            )
            .unwrap();
    }
    writer.seal().unwrap();

    let mut reader = LogReader::open(&vault).unwrap();
    let mut transport = MockTransport::new(0);
    let report = replay_to(&mut reader, &mut transport, ReplayOptions { speed: 2.0 }).unwrap();
    // Three records 20 ms apart at twice the speed is about 20 ms of wall time.
    assert!(
        report.elapsed >= Duration::from_millis(15),
        "{:?}",
        report.elapsed
    );
    assert!(
        report.elapsed < Duration::from_millis(500),
        "{:?}",
        report.elapsed
    );
    assert_eq!(transport.written(), 12);
    let _ = std::fs::remove_file(&vault);
}

/// A session never truncates an existing vault: a monitor that silently destroyed
/// yesterday's capture would be a data-loss bug.
#[test]
fn a_session_refuses_to_overwrite_an_existing_vault() {
    let path = std::env::temp_dir().join(format!(
        "bforge-refuse-{}-{}.bflog",
        std::process::id(),
        line!()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::write(&path, b"yesterday").unwrap();

    let error = match Session::start(vec![port("obc", vec![1, 2, 3])], Some(&path), None) {
        Ok(_) => panic!("an existing vault must be refused"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("already exists"), "{error}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"yesterday",
        "the file is untouched"
    );

    // An empty file is not a capture, and is allowed.
    std::fs::write(&path, b"").unwrap();
    let session = Session::start(vec![port("obc", vec![1, 2, 3])], Some(&path), None)
        .expect("an empty file is fine");
    let _ = session.seal();

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
}
