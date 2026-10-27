//! `bforge config check` surface (F1.5.1).

use std::path::PathBuf;
use std::process::Command;

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bforge"))
}

fn write(name: &str, text: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("bforge-cli-{}-{name}.toml", std::process::id()));
    std::fs::write(&path, text).unwrap();
    path
}

const VALID: &str = r#"
[workspace]
name = "cli-check"
version = "1.0"

[[ports]]
id = "p1"
device_path = "COM8"
baud_rate = 115200
framing = { mode = "cobs", crc = "crc32c" }
"#;

#[test]
fn a_valid_workspace_exits_zero() {
    let path = write("valid", VALID);
    let output = Command::new(binary())
        .args(["config", "check"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ok, 1 port(s)"), "{stdout}");
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_semantic_problem_exits_one_and_names_the_path() {
    let broken = VALID.replace("baud_rate = 115200", "baud_rate = 1");
    let path = write("broken", &broken);
    let output = Command::new(binary())
        .args(["config", "check"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ports[0].baud_rate"), "{stdout}");
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_syntax_error_reports_the_line() {
    let path = write("syntax", "[workspace\nname = \"x\"");
    let output = Command::new(binary())
        .args(["config", "check"])
        .arg(&path)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("error:"), "{stderr}");
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_missing_file_exits_one() {
    let output = Command::new(binary())
        .args(["config", "check", "no-such-workspace.toml"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("cannot read"), "{stderr}");
}
