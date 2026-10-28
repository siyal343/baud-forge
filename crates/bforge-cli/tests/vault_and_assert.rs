//! `bforge assert` and `bforge vault` end to end (F1.5.5, F1.3.5, F1.3.7).
//!
//! The tests build a vault with the storage writer, so they run without hardware.

use bforge_hal::{Direction, PinStateFlags};
use bforge_storage::{LogHeader, LogWriter, RawChunk};
use std::path::PathBuf;
use std::process::{Command, Output};

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bforge"))
}

fn temp(name: &str, suffix: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "bforge-cli-s6-{}-{name}.{suffix}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(bforge_storage::index_path(&path));
    path
}

/// Ten records, the fifth holding the boot banner a check will look for.
fn build_vault(path: &std::path::Path) -> u64 {
    let mut writer = LogWriter::create(path, LogHeader::default()).unwrap();
    let mut payload_bytes = 0u64;
    for seq in 0..10u64 {
        let mut bytes = format!("record {seq}: idle\n").into_bytes();
        if seq == 4 {
            bytes = b"record 4: load:0x403cbf10 len:0x9f4\n\xAA\x55\x01\x02".to_vec();
        }
        payload_bytes += bytes.len() as u64;
        writer
            .append(
                &RawChunk {
                    seq_id: seq,
                    timestamp_ns: seq * 1_000_000,
                    port_id: 0,
                    direction: Direction::Rx,
                    line_state: PinStateFlags::default(),
                    payload_offset: 0,
                    payload_len: bytes.len() as u32,
                },
                &bytes,
            )
            .unwrap();
    }
    writer.seal().unwrap();
    payload_bytes
}

fn write_rules(name: &str, text: &str) -> PathBuf {
    let path = temp(name, "toml");
    std::fs::write(&path, text).unwrap();
    path
}

fn run(args: &[String]) -> Output {
    Command::new(binary()).args(args).output().unwrap()
}

#[test]
fn checks_pass_on_a_matching_vault() {
    let vault = temp("pass", "bflog");
    let payload_bytes = build_vault(&vault);
    let rules = write_rules(
        "pass-rules",
        r#"
        [[checks]]
        name = "boot banner"
        kind = "contains"
        value = "load:0x"

        [[checks]]
        name = "sync bytes"
        kind = "contains_hex"
        value = "AA 55 01"

        [[checks]]
        name = "record count"
        kind = "chunks"
        min = 10
        max = 10

        [[checks]]
        name = "payload size"
        kind = "bytes"
        min = 1
        max = 100000
        "#,
    );

    let output = run(&[
        "assert".into(),
        vault.display().to_string(),
        "-r".into(),
        rules.display().to_string(),
        "--json".into(),
    ]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["chunks"], 10);
    assert_eq!(value["payload_bytes"], payload_bytes);
    assert_eq!(value["checks"].as_array().unwrap().len(), 4);
    for check in value["checks"].as_array().unwrap() {
        assert_eq!(check["passed"], true, "{check}");
    }

    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(&rules);
}

#[test]
fn a_missing_string_fails_the_run() {
    let vault = temp("fail", "bflog");
    build_vault(&vault);
    let rules = write_rules(
        "fail-rules",
        r#"
        [[checks]]
        name = "absent"
        kind = "contains"
        value = "no such banner"

        [[checks]]
        name = "count"
        kind = "chunks"
        min = 100
        "#,
    );

    let output = run(&[
        "assert".into(),
        vault.display().to_string(),
        "-r".into(),
        rules.display().to_string(),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("FAIL contains"), "{stdout}");
    assert!(stdout.contains("0 of 2 checks passed"), "{stdout}");

    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(&rules);
}

#[test]
fn a_rule_typo_is_refused_before_the_vault_is_read() {
    let rules = write_rules(
        "typo-rules",
        r#"
        [[checks]]
        name = "typo"
        kind = "regex"
        value = "x"
        "#,
    );
    let output = run(&[
        "assert".into(),
        "no-such-vault.bflog".into(),
        "-r".into(),
        rules.display().to_string(),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("is not a check"), "{stdout}");
    let _ = std::fs::remove_file(&rules);
}

#[test]
fn vault_info_reports_the_index_and_damage() {
    let vault = temp("info", "bflog");
    build_vault(&vault);
    let output = run(&["vault".into(), "info".into(), vault.display().to_string()]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("records      10"), "{stdout}");
    assert!(stdout.contains("index        persisted"), "{stdout}");
    assert!(stdout.contains("damaged tail false"), "{stdout}");
    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
}

#[test]
fn vault_repair_cuts_a_partial_record() {
    let vault = temp("repair", "bflog");
    build_vault(&vault);

    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&vault)
        .unwrap();
    let full = file.metadata().unwrap().len();
    file.set_len(full - 9).unwrap();
    drop(file);

    let damaged = run(&["vault".into(), "info".into(), vault.display().to_string()]);
    assert!(String::from_utf8_lossy(&damaged.stdout).contains("damaged tail true"));

    let repaired = run(&["vault".into(), "repair".into(), vault.display().to_string()]);
    let stdout = String::from_utf8_lossy(&repaired.stdout);
    assert!(repaired.status.success(), "{stdout}");
    assert!(stdout.contains("kept 9 records"), "{stdout}");

    let after = run(&["vault".into(), "info".into(), vault.display().to_string()]);
    assert!(String::from_utf8_lossy(&after.stdout).contains("damaged tail false"));

    let _ = std::fs::remove_file(&vault);
    let _ = std::fs::remove_file(bforge_storage::index_path(&vault));
}
