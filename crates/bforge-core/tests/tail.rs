//! `bforge tail` end to end: bytes to frames to decoded rows (S8 engine half).

use bforge_core::session::SessionPort;
use bforge_core::tail::{Tail, TailError, tail_config};
use bforge_framer::cobs_encode;
use bforge_hal::mock::MockTransport;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn temp(name: &str, suffix: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "bforge-tail-{}-{name}.{suffix}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

const HEADER: &str = r#"
#include <stdint.h>

struct __attribute__((packed)) ImuPacket {
    uint16_t sync;
    uint8_t  version;
    uint8_t  flags : 3;
    uint8_t  channel : 5;
    __be16   v_batt_mv;
    float    gyro_z;
};
"#;

fn imu_frame(sync: u16, version: u8, flags: u8, channel: u8, mv: u16, gyro: f32) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&sync.to_le_bytes());
    frame.push(version);
    frame.push(flags | (channel << 3));
    frame.extend_from_slice(&mv.to_be_bytes());
    frame.extend_from_slice(&gyro.to_le_bytes());
    frame
}

fn config_text(header: &str, framing: &str, dissector: bool) -> String {
    let dissector = if dissector {
        format!(
            "dissector = {{ type = \"c_header\", file = \"{}\", root_struct = \"ImuPacket\" }}\n",
            header.replace('\\', "/")
        )
    } else {
        String::new()
    };
    format!(
        r#"
[workspace]
name = "tail-test"
version = "1.0"

[[ports]]
id = "probe"
device_path = "mock"
baud_rate = 115200
{framing}
{dissector}"#
    )
}

fn port(stream: Vec<u8>) -> SessionPort {
    SessionPort {
        id: "probe".to_string(),
        device: "mock".to_string(),
        baud_rate: 115_200,
        framing: "cobs".to_string(),
        checksum: None,
        transport: Box::new(MockTransport::stream(stream)),
    }
}

fn drain(mut tail: Tail, wanted: usize) -> Vec<bforge_core::tail::TailRow> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut rows = Vec::new();
    while rows.len() < wanted && Instant::now() < deadline {
        rows.extend(tail.pump());
        if rows.len() < wanted {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    tail.stop();
    rows
}

#[test]
fn a_cobs_port_decodes_each_frame_through_its_header() {
    let header = temp("imu", "h");
    std::fs::write(&header, HEADER).unwrap();
    let text = config_text(
        header.to_str().unwrap(),
        "framing = { mode = \"cobs\" }",
        true,
    );
    let project = bforge_core::parse(&text).unwrap();
    assert!(project.validate().is_empty(), "{:?}", project.validate());
    let tail_config = tail_config(&project.ports[0]).unwrap();

    let mut stream = cobs_encode(&imu_frame(0xAA55, 3, 5, 18, 8_190, -0.042));
    stream.push(0);
    stream.extend(cobs_encode(&imu_frame(0xAA55, 4, 1, 2, 7_000, 0.5)));
    stream.push(0);

    let mut configs = HashMap::new();
    configs.insert("probe".to_string(), tail_config);
    let tail = Tail::start(vec![port(stream)], configs).unwrap();
    let rows = drain(tail, 2);

    assert_eq!(rows.len(), 2, "{rows:#?}");
    let first = &rows[0];
    assert_eq!(first.port, "probe");
    assert_eq!(first.len, 10);
    assert_eq!(first.protocol.as_deref(), Some("C_STRUCT:ImuPacket"));
    assert_eq!(first.decode_error, None);

    let field = |name: &str| {
        first
            .fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("no field {name} in {:?}", first.fields))
            .value
            .clone()
    };
    assert_eq!(field("sync"), "43605");
    assert_eq!(field("version"), "3");
    assert_eq!(field("flags"), "5");
    assert_eq!(field("channel"), "18");
    assert_eq!(field("v_batt_mv"), "8190");
    assert_eq!(field("gyro_z"), "-0.042");

    let second = &rows[1];
    assert_eq!(
        second
            .fields
            .iter()
            .find(|field| field.name == "version")
            .unwrap()
            .value,
        "4"
    );
    let _ = std::fs::remove_file(header);
}

#[test]
fn a_port_without_a_dissector_shows_bytes_and_text() {
    let header = temp("plain", "h");
    let text = config_text(
        header.to_str().unwrap(),
        "framing = { mode = \"delimiter\", delimiter = 0x0A }",
        false,
    );
    let project = bforge_core::parse(&text).unwrap();
    let tail_config = tail_config(&project.ports[0]).unwrap();

    let mut configs = HashMap::new();
    configs.insert("probe".to_string(), tail_config);
    let tail = Tail::start(vec![port(b"boot ok\nsecond line\n".to_vec())], configs).unwrap();
    let rows = drain(tail, 2);

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].text, "boot ok");
    assert_eq!(rows[0].hex, "62 6F 6F 74 20 6F 6B");
    assert_eq!(rows[0].protocol, None);
    assert!(rows[0].fields.is_empty());
    assert_eq!(rows[1].text, "second line");
    let _ = std::fs::remove_file(header);
}

#[test]
fn a_sync_word_port_frames_without_a_dissector() {
    let header = temp("sync", "h");
    let text = config_text(
        header.to_str().unwrap(),
        "framing = { mode = \"header_length\", sync = \"AA 55\", length_offset = 2, length_width = \"u8\", length_adjust = 3 }",
        false,
    );
    let project = bforge_core::parse(&text).unwrap();
    assert!(project.validate().is_empty(), "{:?}", project.validate());
    let tail_config = tail_config(&project.ports[0]).unwrap();

    let mut stream = vec![0xAA, 0x55, 2, 0x10, 0x11];
    stream.extend([0xAA, 0x55, 1, 0x20]);

    let mut configs = HashMap::new();
    configs.insert("probe".to_string(), tail_config);
    let tail = Tail::start(vec![port(stream)], configs).unwrap();
    let rows = drain(tail, 2);

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].hex, "AA 55 02 10 11");
    assert_eq!(rows[1].hex, "AA 55 01 20");
    let _ = std::fs::remove_file(header);
}

#[test]
fn a_port_missing_from_the_configs_is_named() {
    let error = Tail::start(vec![port(vec![1, 2, 3])], HashMap::new()).unwrap_err();
    assert_eq!(error, TailError::UnknownPort("probe".to_string()));
    assert!(error.to_string().contains("probe"));
}

#[test]
fn a_bad_framing_setting_is_reported_before_start() {
    let header = temp("bad", "h");
    let text = config_text(
        header.to_str().unwrap(),
        "framing = { mode = \"idle_gap\" }",
        false,
    );
    let project = bforge_core::parse(&text).unwrap();
    // The validator refuses it, and the tail builder refuses it too, because the
    // builder may be reached from a caller that did not validate.
    assert!(!project.validate().is_empty());
    let error = tail_config(&project.ports[0]).unwrap_err();
    assert!(matches!(error, TailError::Settings(_)), "{error}");
    assert!(error.to_string().contains("idle_gap_us"), "{error}");
    let _ = std::fs::remove_file(header);
}

#[test]
fn a_dissector_file_that_is_missing_is_named() {
    let text = config_text("no-such-header.h", "framing = { mode = \"cobs\" }", true);
    let project = bforge_core::parse(&text).unwrap();
    let error = tail_config(&project.ports[0]).unwrap_err();
    assert!(error.to_string().contains("no-such-header.h"), "{error}");
}
