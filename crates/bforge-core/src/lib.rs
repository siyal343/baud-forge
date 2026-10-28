//! Coordinator, workspace configuration (PART IV) and the SPMC pipeline (S1).
//!
//! One `.bforge.toml` file per project holds the ports, the dissectors, the
//! command buttons and the alerts. Engineers commit it, so every machine runs
//! the same setup.
//!
//! Setup only: the schema parses, nothing acts on it yet.

pub mod assert;
pub mod mem;
pub mod pipeline;
pub mod session;
pub mod slab;
pub mod ui;
pub mod validate;

pub use validate::ConfigIssue;

use serde::{Deserialize, Serialize};

/// A complete `.bforge.toml` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub workspace: WorkspaceMeta,
    #[serde(default)]
    pub ports: Vec<PortConfig>,
    #[serde(default)]
    pub commands: Vec<CommandConfig>,
    #[serde(default)]
    pub alerts: Vec<AlertConfig>,
}

/// The `[workspace]` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    pub name: String,
    pub version: String,
    /// Firmware image used for symbolization (FR-SYM-01).
    pub elf_path: Option<String>,
    #[serde(default)]
    pub watch_elf: bool,
}

/// One `[[ports]]` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortConfig {
    pub id: String,
    /// USB identity as `vvvv:pppp` (FR-HAL-02).
    pub match_vid_pid: Option<String>,
    pub match_serial: Option<String>,
    /// OS device path used when the USB tuple does not match.
    pub device_path: Option<String>,
    pub baud_rate: u32,
    pub framing: FramingConfig,
    pub dissector: Option<DissectorConfig>,
    /// Release the port when a local IPC request asks for it (FR-HAL-03).
    #[serde(default)]
    pub yield_on_sigusr1: bool,
}

/// The `framing = { ... }` table of a port.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FramingConfig {
    /// `delimiter`, `cobs`, `slip`, `intel_hex`, `header_length` or `idle_gap`.
    pub mode: String,
    pub delimiter: Option<u32>,
    /// `crc8`, `crc16_ccitt_false` or `crc32c`.
    pub crc: Option<String>,
}

/// The `dissector = { ... }` table of a port.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DissectorConfig {
    /// `c_header`, `protobuf`, `kaitai` or a native pack name.
    #[serde(rename = "type")]
    pub kind: String,
    pub file: Option<String>,
    pub root_struct: Option<String>,
}

/// One `[[commands]]` entry: a parameterized frame the user can send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandConfig {
    pub name: String,
    pub hotkey: Option<String>,
    pub port: String,
    /// Checksum appended to the assembled frame.
    pub append_crc: Option<String>,
    #[serde(default)]
    pub fields: Vec<CommandField>,
}

/// One field of a command template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandField {
    pub name: String,
    /// Type name such as `u8`, `u16_be`, `u32_le` or `enum`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Default value. Kept as a raw TOML value, the type says how to read it.
    pub default: Option<toml::Value>,
    /// Allowed labels for an `enum` field.
    pub options: Option<toml::Value>,
}

/// One `[[alerts]]` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertConfig {
    pub name: String,
    /// Condition expression, for example `dead_man_timer('port', 2500)`.
    pub condition: String,
    /// Actions such as `pulse_pin:RTS:100ms` or `webhook:https://...`.
    #[serde(default)]
    pub actions: Vec<String>,
}

/// Parse a `.bforge.toml` document.
///
/// shortcut: schema only, no semantic validation yet. Duplicate port IDs,
/// baud limits and unknown references are checked when the loader lands.
pub fn parse(text: &str) -> Result<ProjectConfig, toml::de::Error> {
    toml::from_str(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = include_str!("../examples/cubesat.bforge.toml");

    #[test]
    fn example_workspace_parses() {
        let config = parse(EXAMPLE).expect("example config must parse");
        assert_eq!(config.workspace.name, "CubeSat-OBC-Validation");
        assert!(config.workspace.watch_elf);

        assert_eq!(config.ports.len(), 1);
        let port = &config.ports[0];
        assert_eq!(port.id, "obc_telemetry");
        assert_eq!(port.baud_rate, 2_000_000);
        assert_eq!(port.framing.mode, "cobs");
        assert_eq!(
            port.dissector.as_ref().unwrap().root_struct.as_deref(),
            Some("ObcTelemetryFrame")
        );

        let command = &config.commands[0];
        assert_eq!(command.hotkey.as_deref(), Some("Ctrl+Shift+S"));
        assert_eq!(command.fields[2].kind, "enum");
        assert!(command.fields[2].options.is_some());

        assert_eq!(config.alerts.len(), 1);
        assert_eq!(config.alerts[0].actions.len(), 2);
    }
}
