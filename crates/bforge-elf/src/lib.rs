//! Firmware symbolization (F3.5).
//!
//! A crash log prints addresses. This module turns one into a place in the source:
//! a file, a line and a function, using the DWARF line table of the firmware image
//! and its symbol table as a fallback. It never guesses: an address that the image
//! does not describe returns `None`, and the caller shows the raw hex.
//!
//! S12 scope: load, resolve, scan a text stream for pointers, and build the editor
//! command. The file watch and the defmt/pw_tokenizer decoders are D-43 and D-42.

pub mod editor;
pub mod image;
pub mod scan;

pub use bforge_dissect::SourceLocation;
pub use editor::Editor;
pub use image::{ElfImage, Function};
pub use scan::{AddressHit, scan_pointers};

/// Symbolization failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymbolizeError {
    NotFound(String),
    Unreadable(String),
    Unsupported(String),
}

impl std::fmt::Display for SymbolizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(path) => write!(f, "{path} does not exist"),
            Self::Unreadable(message) => write!(f, "cannot read the image: {message}"),
            Self::Unsupported(what) => write!(f, "{what} is not supported"),
        }
    }
}

impl std::error::Error for SymbolizeError {}
