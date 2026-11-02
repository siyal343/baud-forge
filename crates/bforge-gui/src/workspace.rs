//! Workspace Configuration and ELF Firmware Symbol Resolver.
//!
//! Manages persistent `.bforge.toml` project files and resolves
//! hexadecimal memory addresses from firmware crash dumps to source functions.

use std::path::Path;

/// Active workspace state corresponding to `.bforge.toml`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceState {
    pub name: String,
    pub file_path: Option<String>,
    pub primary_port: String,
    pub baud_rate: u32,
    pub framing: String,
    pub dissector_path: Option<String>,
    pub elf_path: Option<String>,
    pub vault_path: Option<String>,
    pub script_path: Option<String>,
    pub loaded_symbols_count: usize,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            name: "Default Workspace".to_string(),
            file_path: None,
            primary_port: "COM8".to_string(),
            baud_rate: 115200,
            framing: "delimiter".to_string(),
            dissector_path: None,
            elf_path: None,
            vault_path: None,
            script_path: None,
            loaded_symbols_count: 0,
        }
    }
}

impl WorkspaceState {
    /// Return default workspace configuration.
    pub fn default_state() -> Self {
        Self::default()
    }

    /// Export workspace state to a `.bforge.toml` format string.
    pub fn export_toml(&self) -> String {
        let config = bforge_core::ProjectConfig {
            workspace: bforge_core::WorkspaceMeta {
                name: self.name.clone(),
                version: "1.0".to_string(),
                elf_path: self.elf_path.clone(),
                watch_elf: self.elf_path.is_some(),
                script_path: self.script_path.clone(),
                rx_script_path: None,
            },
            ports: vec![bforge_core::PortConfig {
                id: if self.primary_port.is_empty() {
                    "primary".to_string()
                } else {
                    self.primary_port.clone()
                },
                match_vid_pid: None,
                match_serial: None,
                device_path: Some(self.primary_port.clone()),
                transport: Some("serial".to_string()),
                address: None,
                baud_rate: self.baud_rate,
                framing: bforge_core::FramingConfig {
                    mode: self.framing.clone(),
                    delimiter: if self.framing == "delimiter" {
                        Some(0x0A)
                    } else {
                        None
                    },
                    sync: None,
                    length_offset: None,
                    length_width: None,
                    length_adjust: None,
                    idle_gap_us: None,
                    max_frame: None,
                    crc: None,
                },
                dissector: self.dissector_path.as_ref().map(|path| {
                    bforge_core::DissectorConfig {
                        kind: "c_header".to_string(),
                        name: None,
                        file: Some(path.clone()),
                        root_struct: None,
                    }
                }),
                yield_on_sigusr1: false,
            }],
            bridges: vec![],
            commands: vec![],
            alerts: vec![],
            ui: None,
        };

        toml::to_string_pretty(&config).unwrap_or_else(|_| String::new())
    }

    /// Save workspace state to disk as `.bforge.toml`.
    pub fn save_to_file(&self, path: &Path) -> Result<(), String> {
        let content = self.export_toml();
        std::fs::write(path, content).map_err(|e| format!("Failed to write workspace: {e}"))
    }

    /// Load workspace state from a `.bforge.toml` file.
    pub fn load_from_file(&mut self, path: &Path) -> Result<(), String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read workspace file: {e}"))?;

        if let Ok(config) = bforge_core::parse(&content) {
            self.file_path = Some(path.to_string_lossy().to_string());
            self.name = config.workspace.name;
            self.elf_path = config.workspace.elf_path;
            self.script_path = config.workspace.script_path;

            if let Some(port) = config.ports.first() {
                self.primary_port = port
                    .device_path
                    .clone()
                    .unwrap_or_else(|| port.id.clone());
                self.baud_rate = port.baud_rate;
                self.framing = port.framing.mode.clone();
                self.dissector_path = port.dissector.as_ref().and_then(|d| d.file.clone());
            }
            return Ok(());
        }

        // Fallback for direct WorkspaceState serialization
        if let Ok(loaded) = toml::from_str::<WorkspaceState>(&content) {
            *self = loaded;
            self.file_path = Some(path.to_string_lossy().to_string());
            return Ok(());
        }

        Err("Failed to parse .bforge.toml configuration".to_string())
    }
}

/// Resolves firmware addresses and symbols using DWARF/ELF metadata.
pub struct ElfSymbolResolver {
    pub image: Option<bforge_elf::ElfImage>,
}

impl Default for ElfSymbolResolver {
    fn default() -> Self {
        Self { image: None }
    }
}

impl ElfSymbolResolver {
    /// Load firmware image from path and return function symbol count.
    pub fn load(&mut self, path: &Path) -> Result<usize, String> {
        let img = bforge_elf::ElfImage::load(path).map_err(|e| e.to_string())?;
        let count = img.functions().len();
        self.image = Some(img);
        Ok(count)
    }

    /// Alias for `load`.
    pub fn open(&mut self, path: &Path) -> Result<usize, String> {
        self.load(path)
    }

    /// Resolve an address to a function symbol.
    pub fn resolve(&self, addr: u64) -> Option<bforge_elf::Function> {
        let img = self.image.as_ref()?;
        if let Some(func) = img.nearest_function(addr) {
            return Some(func.clone());
        }
        if let Some(loc) = img.resolve(addr) {
            if !loc.function.is_empty() {
                return Some(bforge_elf::Function {
                    name: loc.function,
                    address: loc.address,
                    size: 0,
                });
            }
        }
        None
    }

    /// Resolve an address to source location (file, line, function).
    pub fn resolve_location(&self, addr: u64) -> Option<bforge_dissect::SourceLocation> {
        self.image.as_ref()?.resolve(addr)
    }

    /// Annotate hexadecimal addresses in a log line with resolved function names.
    ///
    /// For example: `0x42001a40` -> `0x42001a40 [app_main]`.
    pub fn annotate_line(&self, line: &str) -> String {
        let Some(_) = self.image.as_ref() else {
            return line.to_string();
        };

        let hits = bforge_elf::scan_pointers(line);
        if hits.is_empty() {
            return line.to_string();
        }

        let mut result = line.to_string();
        // Traverse backwards so insertions do not invalidate earlier offsets
        for hit in hits.iter().rev() {
            if let Some(func) = self.resolve(hit.address) {
                if !func.name.is_empty() {
                    let insert_pos = hit.byte_offset + hit.text.len();
                    if insert_pos <= result.len() && result.is_char_boundary(insert_pos) {
                        result.insert_str(insert_pos, &format!(" [{}]", func.name));
                    }
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_and_load_toml() {
        let ws = WorkspaceState {
            name: "Telemetry Rig".to_string(),
            file_path: None,
            primary_port: "COM5".to_string(),
            baud_rate: 921600,
            framing: "cobs".to_string(),
            dissector_path: Some("./schemas/telemetry.h".to_string()),
            elf_path: Some("./firmware/app.elf".to_string()),
            vault_path: None,
            script_path: Some("./scripts/filter.lua".to_string()),
            loaded_symbols_count: 512,
        };

        let exported = ws.export_toml();
        assert!(exported.contains("Telemetry Rig"));
        assert!(exported.contains("COM5"));
        assert!(exported.contains("921600"));
        assert!(exported.contains("cobs"));
        assert!(exported.contains("telemetry.h"));

        // Round-trip through file
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_bforge_workspace.bforge.toml");
        ws.save_to_file(&test_file).expect("save must succeed");

        let mut loaded_ws = WorkspaceState::default();
        loaded_ws.load_from_file(&test_file).expect("load must succeed");

        assert_eq!(loaded_ws.name, "Telemetry Rig");
        assert_eq!(loaded_ws.primary_port, "COM5");
        assert_eq!(loaded_ws.baud_rate, 921600);
        assert_eq!(loaded_ws.framing, "cobs");
        assert_eq!(loaded_ws.dissector_path, Some("./schemas/telemetry.h".to_string()));
        assert_eq!(loaded_ws.elf_path, Some("./firmware/app.elf".to_string()));
        assert_eq!(loaded_ws.script_path, Some("./scripts/filter.lua".to_string()));

        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_symbol_resolver_empty() {
        let resolver = ElfSymbolResolver::default();
        assert!(resolver.image.is_none());
        assert_eq!(resolver.resolve(0x42001000), None);
        assert_eq!(
            resolver.annotate_line("Panic at 0x42001000 in thread"),
            "Panic at 0x42001000 in thread"
        );
    }

    #[test]
    fn test_symbol_resolver_with_current_binary() {
        let exe = std::env::current_exe().expect("current exe");
        let mut resolver = ElfSymbolResolver::default();
        let res = resolver.load(&exe);
        assert!(res.is_ok(), "loading current test binary must succeed");
        let count = res.unwrap();
        // Count depends on whether debug symbols are preserved in PE/ELF
        assert_eq!(count, resolver.image.as_ref().unwrap().functions().len());

        // Test annotate line does not crash
        let line = "Address: 0x0000000010000000";
        let annotated = resolver.annotate_line(line);
        assert!(!annotated.is_empty());

        if let Some(func) = resolver.image.as_ref().and_then(|img| img.functions().first()) {
            let sample_line = format!("Crash at 0x{:08x} in task", func.address);
            let annotated_sample = resolver.annotate_line(&sample_line);
            assert!(
                annotated_sample.contains(&func.name),
                "Expected annotated line to contain function name: {}",
                annotated_sample
            );
        }
    }

    #[test]
    fn test_export_toml_validates_as_project_config() {
        let ws = WorkspaceState::default();
        let toml_str = ws.export_toml();
        let parsed = bforge_core::parse(&toml_str);
        assert!(
            parsed.is_ok(),
            "Generated TOML must be valid ProjectConfig: {:?}",
            parsed.err()
        );
        let cfg = parsed.unwrap();
        assert_eq!(cfg.workspace.name, "Default Workspace");
        assert_eq!(cfg.ports.len(), 1);
        assert_eq!(cfg.ports[0].baud_rate, 115200);
    }
}
