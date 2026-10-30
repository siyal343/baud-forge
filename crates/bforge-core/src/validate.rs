//! Semantic validation of `.bforge.toml` (F1.5.1).
//!
//! The parser reports syntax errors with a line and a column. This module reports
//! the mistakes a parser cannot see: a port id that appears twice, a baud rate no
//! UART accepts, a framing mode this build cannot run, a command aimed at a port
//! that does not exist.
//!
//! Each issue carries a path such as `ports[1].baud_rate`, so an editor can point
//! at the line even though this crate does not track spans.

use crate::ProjectConfig;
use bforge_framer::MODE_NAMES;
use bforge_framer::checksum::Checksum;
use bforge_hal::{MAX_BAUD, MIN_BAUD};

/// Field types a command template may use.
const FIELD_TYPES: [&str; 15] = [
    "u8", "u16_le", "u16_be", "u32_le", "u32_be", "i8", "i16_le", "i16_be", "i32_le", "i32_be",
    "f32_le", "f32_be", "f64_le", "f64_be", "enum",
];

/// One problem with a workspace file, and where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigIssue {
    pub path: String,
    pub message: String,
}

impl ConfigIssue {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ConfigIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl ProjectConfig {
    /// Check the workspace for mistakes. An empty list means the file is usable.
    pub fn validate(&self) -> Vec<ConfigIssue> {
        let mut issues = Vec::new();

        if self.workspace.name.trim().is_empty() {
            issues.push(ConfigIssue::new("workspace.name", "must not be empty"));
        }
        if let Some(script) = self.workspace.script_path.as_deref() {
            if script.trim().is_empty() {
                issues.push(ConfigIssue::new(
                    "workspace.script_path",
                    "must not be empty",
                ));
            } else if !std::path::Path::new(script).exists() {
                issues.push(ConfigIssue::new(
                    "workspace.script_path",
                    format!("`{script}` does not exist"),
                ));
            }
        }
        if self.workspace.watch_elf && self.workspace.elf_path.is_none() {
            issues.push(ConfigIssue::new(
                "workspace.elf_path",
                "watch_elf is true, so elf_path is required",
            ));
        }

        self.validate_ports(&mut issues);
        self.validate_bridges(&mut issues);
        self.validate_commands(&mut issues);
        self.validate_alerts(&mut issues);
        issues
    }

    fn validate_ports(&self, issues: &mut Vec<ConfigIssue>) {
        for (index, port) in self.ports.iter().enumerate() {
            let at = format!("ports[{index}]");

            if port.id.trim().is_empty() {
                issues.push(ConfigIssue::new(format!("{at}.id"), "must not be empty"));
            } else if self.ports[..index].iter().any(|other| other.id == port.id) {
                issues.push(ConfigIssue::new(
                    format!("{at}.id"),
                    format!("`{}` is defined more than once", port.id),
                ));
            }

            if !(MIN_BAUD..=MAX_BAUD).contains(&port.baud_rate) {
                issues.push(ConfigIssue::new(
                    format!("{at}.baud_rate"),
                    format!("{} is outside {MIN_BAUD} to {MAX_BAUD}", port.baud_rate),
                ));
            }

            if !MODE_NAMES.contains(&port.framing.mode.as_str()) {
                issues.push(ConfigIssue::new(
                    format!("{at}.framing.mode"),
                    format!(
                        "`{}` is not a framing mode; use one of {}",
                        port.framing.mode,
                        MODE_NAMES.join(", ")
                    ),
                ));
            } else {
                validate_framing_settings(&at, &port.framing, issues);
            }

            if let Some(dissector) = &port.dissector {
                let at_dissector = format!("{at}.dissector");
                match dissector.kind.as_str() {
                    "c_header" => {
                        if dissector.file.is_none() {
                            issues.push(ConfigIssue::new(
                                format!("{at_dissector}.file"),
                                "a c_header dissector needs the header file",
                            ));
                        }
                        if dissector.root_struct.is_none() {
                            issues.push(ConfigIssue::new(
                                format!("{at_dissector}.root_struct"),
                                "a c_header dissector needs root_struct",
                            ));
                        }
                    }
                    "native" => match dissector.name.as_deref() {
                        Some(name) if bforge_dissect::packs::Pack::from_name(name).is_some() => {}
                        Some(name) => issues.push(ConfigIssue::new(
                            format!("{at_dissector}.name"),
                            format!(
                                "`{name}` is not a pack; use {}",
                                bforge_dissect::packs::PACK_NAMES.join(", ")
                            ),
                        )),
                        None => issues.push(ConfigIssue::new(
                            format!("{at_dissector}.name"),
                            format!(
                                "a native dissector needs a name; use {}",
                                bforge_dissect::packs::PACK_NAMES.join(", ")
                            ),
                        )),
                    },
                    other => issues.push(ConfigIssue::new(
                        format!("{at_dissector}.type"),
                        format!("`{other}` is not a dissector; use c_header or native"),
                    )),
                }
            }

            if let Some(name) = &port.framing.crc
                && Checksum::from_name(name).is_none()
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.framing.crc"),
                    format!(
                        "`{name}` is not a checksum; use crc8_atm, crc16_ccitt_false or crc32c"
                    ),
                ));
            }

            let transport = port.transport.as_deref().unwrap_or("serial");
            match transport {
                "serial" => {
                    if port.match_vid_pid.is_none() && port.device_path.is_none() {
                        issues.push(ConfigIssue::new(
                            format!("{at}.match_vid_pid"),
                            "a serial port needs match_vid_pid or device_path, or it binds to nothing",
                        ));
                    }
                }
                "tcp-client" | "tcp-server" | "udp" => match port.address.as_deref() {
                    None => issues.push(ConfigIssue::new(
                        format!("{at}.address"),
                        format!("transport `{transport}` needs an address"),
                    )),
                    Some(address) if !address.contains(':') => issues.push(ConfigIssue::new(
                        format!("{at}.address"),
                        format!("`{address}` is not `host:port`"),
                    )),
                    Some(_) => {}
                },
                other => issues.push(ConfigIssue::new(
                    format!("{at}.transport"),
                    format!(
                        "`{other}` is not a transport; use serial, tcp-client, tcp-server or udp"
                    ),
                )),
            }
            if let Some(tuple) = &port.match_vid_pid
                && !is_valid_tuple(tuple)
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.match_vid_pid"),
                    format!("`{tuple}` is not `vvvv:pppp` in hexadecimal"),
                ));
            }
        }
    }

    fn validate_bridges(&self, issues: &mut Vec<ConfigIssue>) {
        for (index, bridge) in self.bridges.iter().enumerate() {
            let at = format!("bridges[{index}]");
            if bridge.id.trim().is_empty() {
                issues.push(ConfigIssue::new(format!("{at}.id"), "must not be empty"));
            } else if self.bridges[..index]
                .iter()
                .any(|other| other.id == bridge.id)
            {
                issues.push(ConfigIssue::new(format!("{at}.id"), "is used twice"));
            }
            for (side, id) in [("a", &bridge.a), ("b", &bridge.b)] {
                if !self.ports.iter().any(|port| &port.id == id) {
                    issues.push(ConfigIssue::new(
                        format!("{at}.{side}"),
                        format!("`{id}` is not a port in this workspace"),
                    ));
                }
            }
            if bridge.a == bridge.b {
                issues.push(ConfigIssue::new(
                    format!("{at}.b"),
                    "a bridge needs two different ports",
                ));
            }
            let ports = [&bridge.a, &bridge.b];
            let earlier = &self.bridges[..index];
            if earlier
                .iter()
                .any(|other| ports.iter().any(|id| id == &&other.a || id == &&other.b))
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.a"),
                    "a port may be in only one bridge",
                ));
            }
        }
    }

    fn validate_commands(&self, issues: &mut Vec<ConfigIssue>) {
        for (index, command) in self.commands.iter().enumerate() {
            let at = format!("commands[{index}]");

            if command.name.trim().is_empty() {
                issues.push(ConfigIssue::new(format!("{at}.name"), "must not be empty"));
            } else if self.commands[..index]
                .iter()
                .any(|other| other.name == command.name)
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.name"),
                    format!("`{}` is defined more than once", command.name),
                ));
            }

            if !self.ports.iter().any(|port| port.id == command.port) {
                issues.push(ConfigIssue::new(
                    format!("{at}.port"),
                    format!("`{}` is not a port in this workspace", command.port),
                ));
            }

            if let Some(hotkey) = &command.hotkey
                && self.commands[..index]
                    .iter()
                    .any(|other| other.hotkey.as_deref() == Some(hotkey))
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.hotkey"),
                    format!("`{hotkey}` is already bound to another command"),
                ));
            }

            if let Some(name) = &command.append_crc
                && Checksum::from_name(name).is_none()
            {
                issues.push(ConfigIssue::new(
                    format!("{at}.append_crc"),
                    format!("`{name}` is not a checksum"),
                ));
            }

            if command.fields.is_empty() {
                issues.push(ConfigIssue::new(
                    format!("{at}.fields"),
                    "a command needs at least one field",
                ));
            }
            for (field_index, field) in command.fields.iter().enumerate() {
                let field_at = format!("{at}.fields[{field_index}]");
                if field.name.trim().is_empty() {
                    issues.push(ConfigIssue::new(
                        format!("{field_at}.name"),
                        "must not be empty",
                    ));
                }
                if command.fields[..field_index]
                    .iter()
                    .any(|other| other.name == field.name)
                {
                    issues.push(ConfigIssue::new(
                        format!("{field_at}.name"),
                        format!("`{}` appears twice", field.name),
                    ));
                }
                if !FIELD_TYPES.contains(&field.kind.as_str()) {
                    issues.push(ConfigIssue::new(
                        format!("{field_at}.type"),
                        format!("`{}` is not a field type", field.kind),
                    ));
                }
                if field.kind == "enum" && field.options.is_none() {
                    issues.push(ConfigIssue::new(
                        format!("{field_at}.options"),
                        "an enum field needs options",
                    ));
                }
            }
        }
    }

    fn validate_alerts(&self, issues: &mut Vec<ConfigIssue>) {
        for (index, alert) in self.alerts.iter().enumerate() {
            let at = format!("alerts[{index}]");
            if alert.name.trim().is_empty() {
                issues.push(ConfigIssue::new(format!("{at}.name"), "must not be empty"));
            }
            if alert.condition.trim().is_empty() {
                issues.push(ConfigIssue::new(
                    format!("{at}.condition"),
                    "an alert needs a condition",
                ));
            }
            if alert.actions.is_empty() {
                issues.push(ConfigIssue::new(
                    format!("{at}.actions"),
                    "an alert needs at least one action",
                ));
            }
        }
    }
}

/// Settings a framing mode needs beyond its name.
fn validate_framing_settings(
    at: &str,
    framing: &crate::FramingConfig,
    issues: &mut Vec<ConfigIssue>,
) {
    if let Some(limit) = framing.max_frame
        && !(8..=1024 * 1024).contains(&limit)
    {
        issues.push(ConfigIssue::new(
            format!("{at}.framing.max_frame"),
            format!("{limit} is outside 8 to 1048576"),
        ));
    }

    match framing.mode.as_str() {
        "delimiter" => match framing.delimiter {
            None => issues.push(ConfigIssue::new(
                format!("{at}.framing.delimiter"),
                "mode `delimiter` needs a delimiter byte",
            )),
            Some(byte) if byte > 255 => issues.push(ConfigIssue::new(
                format!("{at}.framing.delimiter"),
                format!("{byte} is not a byte; use 0 to 255"),
            )),
            Some(_) => {}
        },
        "header_length" => {
            match framing.sync.as_deref().map(parse_hex) {
                Some(Some(bytes)) if (1..=8).contains(&bytes.len()) => {}
                _ => issues.push(ConfigIssue::new(
                    format!("{at}.framing.sync"),
                    "mode `header_length` needs a sync word of 1 to 8 bytes, for example `AA 55`",
                )),
            }
            if framing.length_offset.is_none() {
                issues.push(ConfigIssue::new(
                    format!("{at}.framing.length_offset"),
                    "mode `header_length` needs the offset of the length field",
                ));
            }
            match framing.length_width.as_deref() {
                Some("u8" | "u16_le" | "u16_be" | "u32_le") => {}
                Some(other) => issues.push(ConfigIssue::new(
                    format!("{at}.framing.length_width"),
                    format!("`{other}` is not a length width; use u8, u16_le, u16_be or u32_le"),
                )),
                None => issues.push(ConfigIssue::new(
                    format!("{at}.framing.length_width"),
                    "mode `header_length` needs the width of the length field",
                )),
            }
        }
        "idle_gap" => match framing.idle_gap_us {
            Some(0) | None => issues.push(ConfigIssue::new(
                format!("{at}.framing.idle_gap_us"),
                "mode `idle_gap` needs a silence of at least 1 us",
            )),
            Some(_) => {}
        },
        _ => {}
    }
}

/// Parse `AA 55` or `AA5501` into bytes.
pub fn parse_hex(text: &str) -> Option<Vec<u8>> {
    let cleaned: String = text.split_whitespace().collect::<Vec<_>>().join("");
    let cleaned = cleaned.trim_start_matches("0x");
    if cleaned.is_empty() || !cleaned.len().is_multiple_of(2) {
        return None;
    }
    let (pairs, _) = cleaned.as_bytes().as_chunks::<2>();
    let mut out = Vec::with_capacity(pairs.len());
    for [high, low] in pairs {
        let high = (*high as char).to_digit(16)?;
        let low = (*low as char).to_digit(16)?;
        out.push((high as u8) << 4 | low as u8);
    }
    Some(out)
}

fn is_valid_tuple(tuple: &str) -> bool {
    let Some((vid, pid)) = tuple.split_once(':') else {
        return false;
    };
    vid.len() == 4 && pid.len() == 4 && tuple.chars().all(|c| c == ':' || c.is_ascii_hexdigit())
}
