//! Firmware symbolization (FR-SYM-01).
//!
//! Watches a configured `.elf` file and resolves addresses in incoming frames
//! to `file:line (function)` for the UI badge and the editor jump.
//!
//! Setup only: the contract exists, no ELF reading is implemented.

use std::path::Path;

pub use bforge_dissect::SourceLocation;

/// Reads symbols and debug information from a firmware image.
pub trait Symbolizer {
    /// Reload the image, for example after `cargo build` rewrote it.
    fn load(&mut self, elf: &Path) -> Result<(), SymbolizeError>;

    /// Resolve a code address. Return `None` when the address is unknown.
    fn resolve(&self, address: u64) -> Option<SourceLocation>;

    /// Decode a `defmt` or `pw_tokenizer` frame into readable text.
    fn decode_log_frame(&self, frame: &[u8]) -> Option<String>;
}

/// Symbolization failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolizeError {
    NotFound(String),
    Unreadable(String),
    Unsupported(String),
}
