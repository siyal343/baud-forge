//! CLI surface for S4: argument errors, ports list, and a missing device.

use std::path::PathBuf;
use std::process::Command;

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bforge"))
}

fn write(name: &str, text: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("bforge-cli-s4-{}-{name}.toml", std::process::id()));
    std::fs::write(&path, text).unwrap();
    path
}

const WORKSPACE: &str = r#"
[workspace]
name = "cli-s4"
version = "1.0"

[[ports]]
id = "missing"
device_path = "COM999"
baud_rate = 115200
framing = { mode = "cobs", crc = "crc32c" }
"#;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(binary()).args(args).output().unwrap()
}

#[test]
fn ports_list_prints_a_table() {
    let output = run(&["ports", "list"]);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("device"), "{stdout}");
    assert!(stdout.contains("vid:pid"), "{stdout}");
}

#[test]
fn record_without_options_is_refused() {
    let output = run(&["record"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("record needs -c"), "{stderr}");
}

#[test]
fn record_names_a_device_it_cannot_bind() {
    let path = write("missing", WORKSPACE);
    let output = Command::new(binary())
        .args(["record", "-c"])
        .arg(&path)
        .args(["-o", "target/should-not-exist.bflog", "--duration", "500ms"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("no device matches port `missing`"),
        "{stderr}"
    );
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file("target/should-not-exist.bflog");
}

#[test]
fn replay_without_a_target_is_refused() {
    let output = run(&["replay", "no-such-vault.bflog"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no-such-vault.bflog"), "{stderr}");
}

#[test]
fn status_without_a_workspace_is_refused() {
    let output = run(&["status"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("status needs -c"), "{stderr}");
}

#[test]
fn status_reports_an_unbindable_port() {
    let path = write("status-missing", WORKSPACE);
    let output = Command::new(binary())
        .args(["status", "-c"])
        .arg(&path)
        .args(["--duration", "200ms"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no device matches"), "{stderr}");
    let _ = std::fs::remove_file(path);
}
