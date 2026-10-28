//! Contract test (F1.7.4): every field the workbench draws has a source.
//!
//! The UI guide fixes six bands. This test names, for each visible value, the JSON
//! pointer that feeds it, and fails when a pointer no longer resolves. A zone that
//! gains a field without a source fails here, not on a screen nobody has built yet.

use bforge_core::session::{Session, SessionPort};
use bforge_core::ui::CONTRACT_VERSION;
use bforge_hal::mock::MockTransport;
use serde_json::Value;
use std::time::{Duration, Instant};

/// Band, what it shows, and where the value comes from.
const ZONE_FIELDS: &[(&str, &str, &str)] = &[
    // 1. Hardware ribbon: port pill and pin matrix.
    ("ribbon", "device", "/ports/0/device"),
    ("ribbon", "baud rate", "/ports/0/baud_rate"),
    ("ribbon", "framing mode", "/ports/0/framing"),
    ("ribbon", "checksum", "/ports/0/checksum"),
    ("ribbon", "port state", "/ports/0/state"),
    ("ribbon", "CTS", "/ports/0/pins/cts"),
    ("ribbon", "DSR", "/ports/0/pins/dsr"),
    ("ribbon", "DCD", "/ports/0/pins/dcd"),
    ("ribbon", "RI", "/ports/0/pins/ri"),
    ("ribbon", "BREAK", "/ports/0/pins/break_state"),
    ("ribbon", "framing error", "/ports/0/pins/framing_error"),
    ("ribbon", "parity error", "/ports/0/pins/parity_error"),
    // 2. Left sidebar: ports and their health.
    ("sidebar", "port id", "/ports/0/id"),
    ("sidebar", "read errors", "/ports/0/read_errors"),
    // 3A. Stream and hex viewport.
    ("stream", "chunk count", "/ports/0/chunks"),
    ("stream", "byte count", "/ports/0/bytes"),
    // 3B. Telemetry and DVR scrubber.
    ("telemetry", "elapsed ms", "/session/elapsed_ms"),
    ("telemetry", "session start", "/session/started_epoch_ns"),
    // 4. Right inspector: decode health.
    ("inspector", "chunks in the session", "/session/chunks"),
    // 5. Command forge: none yet, FEEDS ARRIVE IN S5.
    // 6. Footer: vault, drops, throughput, ELF.
    ("footer", "vault path", "/session/vault"),
    ("footer", "vault bytes", "/session/file_bytes"),
    ("footer", "payload bytes", "/session/payload_bytes"),
    ("footer", "overruns", "/ports/0/overruns"),
    ("footer", "reader stalls", "/ports/0/stalls_ms"),
    ("footer", "firmware image", "/session/elf"),
    ("footer", "mode", "/session/mode"),
    // Header.
    ("header", "contract version", "/contract"),
];

fn resolve<'a>(value: &'a Value, pointer: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in pointer.trim_start_matches('/').split('/') {
        if part.is_empty() {
            continue;
        }
        current = match current {
            Value::Object(map) => map.get(part)?,
            Value::Array(items) => items.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

fn snapshot_json() -> Value {
    let ports = vec![SessionPort {
        id: "obc".to_string(),
        device: "COM8".to_string(),
        baud_rate: 115_200,
        framing: "cobs".to_string(),
        checksum: Some("crc32c".to_string()),
        transport: Box::new(MockTransport::stream(vec![7u8; 2_000])),
    }];
    let mut session = Session::start(ports, None, Some("/fw/obc.elf".to_string())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.chunks() == 0 && Instant::now() < deadline {
        session.pump_once().unwrap();
    }
    let snapshot = session.snapshot();
    let _ = session.seal();
    serde_json::to_value(&snapshot).unwrap()
}

#[test]
fn every_zone_field_resolves_in_the_snapshot() {
    let value = snapshot_json();
    let mut missing = Vec::new();
    for (band, element, pointer) in ZONE_FIELDS {
        if resolve(&value, pointer).is_none() {
            missing.push(format!("{band} / {element} -> {pointer}"));
        }
    }
    assert!(missing.is_empty(), "no source for: {missing:#?}");
}

#[test]
fn the_contract_version_is_stated() {
    let value = snapshot_json();
    assert_eq!(value["contract"], CONTRACT_VERSION);
    assert_eq!(CONTRACT_VERSION, 1);
}

#[test]
fn no_two_zone_fields_share_a_pointer_by_accident() {
    let mut seen: Vec<&str> = Vec::new();
    for (_, _, pointer) in ZONE_FIELDS {
        if seen.contains(pointer) {
            panic!("{pointer} feeds two elements; name the second one explicitly");
        }
        seen.push(pointer);
    }
}

#[test]
fn the_pin_view_is_all_booleans() {
    let value = snapshot_json();
    for pin in [
        "cts",
        "dsr",
        "dcd",
        "ri",
        "break_state",
        "framing_error",
        "parity_error",
    ] {
        let at = format!("/ports/0/pins/{pin}");
        assert!(
            resolve(&value, &at).is_some_and(Value::is_boolean),
            "{at} must be a boolean"
        );
    }
}

#[test]
fn the_numeric_fields_are_numbers() {
    let value = snapshot_json();
    for pointer in [
        "/ports/0/baud_rate",
        "/ports/0/chunks",
        "/ports/0/bytes",
        "/ports/0/overruns",
        "/ports/0/read_errors",
        "/ports/0/stalls_ms",
        "/session/chunks",
        "/session/payload_bytes",
        "/session/file_bytes",
        "/session/elapsed_ms",
    ] {
        assert!(
            resolve(&value, pointer).is_some_and(Value::is_number),
            "{pointer} must be a number"
        );
    }
}
