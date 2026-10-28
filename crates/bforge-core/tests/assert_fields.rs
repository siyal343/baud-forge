//! Assert on decoded fields, with raw bytes still the only thing stored (D-15).

use bforge_core::assert::{evaluate, parse_rules, validate_rules};
use bforge_core::tail::{TailRow, decode_vault};
use bforge_framer::cobs_encode;
use bforge_hal::{Direction, PinStateFlags};
use bforge_storage::{LogHeader, LogReader, LogWriter, RawChunk};
use std::path::PathBuf;

fn temp(name: &str, suffix: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "bforge-assert-{}-{name}.{suffix}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
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

fn imu_frame(version: u8, millivolts: u16, gyro: f32) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&0xAA55u16.to_le_bytes());
    frame.push(version);
    frame.push(0b101);
    frame.extend_from_slice(&millivolts.to_be_bytes());
    frame.extend_from_slice(&gyro.to_le_bytes());
    frame
}

/// A vault holding three COBS frames, written the way a recorder writes one.
fn build_vault(path: &std::path::Path, frames: &[Vec<u8>]) -> LogReader {
    let mut writer = LogWriter::create(path, LogHeader::default()).unwrap();
    for (index, frame) in frames.iter().enumerate() {
        let mut payload = cobs_encode(frame);
        payload.push(0);
        writer
            .append(
                &RawChunk {
                    seq_id: index as u64,
                    timestamp_ns: index as u64 * 20_000_000,
                    port_id: 0,
                    direction: Direction::Rx,
                    line_state: PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: payload.len() as u32,
                },
                &payload,
            )
            .unwrap();
    }
    writer.seal().unwrap();
    LogReader::open(path).unwrap()
}

fn workspace(header: &str) -> bforge_core::ProjectConfig {
    let text = format!(
        r#"
[workspace]
name = "assert-fields"
version = "1.0"

[[ports]]
id = "imu"
device_path = "COM1"
baud_rate = 115200
framing = {{ mode = "cobs" }}
dissector = {{ type = "c_header", file = "{}", root_struct = "ImuPacket" }}
"#,
        header.replace('\\', "/")
    );
    let config = bforge_core::parse(&text).unwrap();
    assert!(config.validate().is_empty(), "{:?}", config.validate());
    config
}

#[test]
fn a_vault_decodes_through_the_workspace_schema() {
    let header = temp("imu", "h");
    std::fs::write(&header, HEADER).unwrap();
    let vault = temp("decode", "bflog");
    let config = workspace(header.to_str().unwrap());
    let mut reader = build_vault(
        &vault,
        &[
            imu_frame(3, 8_190, -0.042),
            imu_frame(4, 7_950, 0.5),
            imu_frame(5, 8_100, 0.1),
        ],
    );

    let rows: Vec<TailRow> = decode_vault(&mut reader, &config.ports[0]).unwrap();
    assert_eq!(rows.len(), 3, "three frames");
    assert_eq!(rows[0].protocol.as_deref(), Some("C_STRUCT:ImuPacket"));
    let version = rows[1]
        .fields
        .iter()
        .find(|field| field.name == "version")
        .unwrap();
    assert_eq!(version.value, "4");

    let _ = std::fs::remove_file(header);
    let _ = std::fs::remove_file(vault);
}

#[test]
fn field_and_protocol_checks_pass_on_decoded_frames() {
    let header = temp("imu-pass", "h");
    std::fs::write(&header, HEADER).unwrap();
    let vault = temp("pass", "bflog");
    let config = workspace(header.to_str().unwrap());
    let mut reader = build_vault(
        &vault,
        &[imu_frame(3, 8_190, -0.042), imu_frame(3, 8_100, 0.2)],
    );
    let rows = decode_vault(&mut reader, &config.ports[0]).unwrap();

    let rules = parse_rules(
        r#"
        [[checks]]
        name = "sync"
        kind = "field"
        value = "sync"
        equals = "43605"

        [[checks]]
        name = "battery in range"
        kind = "field"
        value = "v_batt_mv"
        min = 7400
        max = 8200

        [[checks]]
        name = "the header matched"
        kind = "protocol"
        value = "C_STRUCT:ImuPacket"
        "#,
    )
    .unwrap();
    assert!(validate_rules(&rules).is_empty());

    let report = evaluate(&vault.display().to_string(), &mut reader, &rules, &rows).unwrap();
    assert!(report.passed(), "{report:#?}");

    let _ = std::fs::remove_file(header);
    let _ = std::fs::remove_file(vault);
}

#[test]
fn a_field_outside_its_range_fails_with_the_range_it_saw() {
    let header = temp("imu-fail", "h");
    std::fs::write(&header, HEADER).unwrap();
    let vault = temp("fail", "bflog");
    let config = workspace(header.to_str().unwrap());
    let mut reader = build_vault(&vault, &[imu_frame(3, 8_190, -0.042)]);
    let rows = decode_vault(&mut reader, &config.ports[0]).unwrap();

    let rules = parse_rules(
        r#"
        [[checks]]
        name = "battery"
        kind = "field"
        value = "v_batt_mv"
        min = 9000
        "#,
    )
    .unwrap();
    let report = evaluate(&vault.display().to_string(), &mut reader, &rules, &rows).unwrap();
    assert!(!report.passed());
    assert!(
        report.checks[0].detail.contains("8190"),
        "{:?}",
        report.checks[0]
    );

    let _ = std::fs::remove_file(header);
    let _ = std::fs::remove_file(vault);
}

#[test]
fn a_field_check_without_decoded_frames_says_what_is_missing() {
    let vault = temp("rows-none", "bflog");
    let mut reader = build_vault(&vault, &[imu_frame(3, 8_190, 0.0)]);
    let rules = parse_rules(
        r#"
        [[checks]]
        name = "sync"
        kind = "field"
        value = "sync"
        equals = "43605"
        "#,
    )
    .unwrap();
    let report = evaluate(&vault.display().to_string(), &mut reader, &rules, &[]).unwrap();
    assert!(!report.passed());
    assert!(
        report.checks[0].detail.contains("-c"),
        "{:?}",
        report.checks[0]
    );

    let _ = std::fs::remove_file(vault);
}

#[test]
fn a_field_rule_needs_something_to_compare() {
    let rules = parse_rules(
        r#"
        [[checks]]
        name = "vague"
        kind = "field"
        value = "sync"
        "#,
    )
    .unwrap();
    let problems = validate_rules(&rules);
    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("equals, min or max"), "{problems:?}");
}
