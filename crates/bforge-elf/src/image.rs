//! Loading a firmware image and resolving addresses into it.

use crate::{SourceLocation, SymbolizeError};
use object::{Object, ObjectSymbol};
use std::path::{Path, PathBuf};

/// One function symbol from the image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Function {
    /// Name as the image stores it. Rust names arrive mangled; demangling is D-44.
    pub name: String,
    pub address: u64,
    /// Size as the image records it, or 0 when it does not.
    pub size: u64,
}

/// A loaded ELF, PE or Mach-O image with its DWARF line table.
pub struct ElfImage {
    path: PathBuf,
    loader: addr2line::Loader,
    functions: Vec<Function>,
    /// Address range covered by the function symbols. An address outside it is
    /// not code in this image, and the line lookup is not asked about it.
    span: Option<(u64, u64)>,
}

impl std::fmt::Debug for ElfImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ElfImage")
            .field("path", &self.path)
            .field("functions", &self.functions.len())
            .finish()
    }
}

impl ElfImage {
    /// Read the image once. Both the symbols and the line table are used from it.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, SymbolizeError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(SymbolizeError::NotFound(path.display().to_string()));
        }

        let bytes =
            std::fs::read(path).map_err(|error| SymbolizeError::Unreadable(error.to_string()))?;
        let object = object::File::parse(&*bytes)
            .map_err(|error| SymbolizeError::Unreadable(error.to_string()))?;

        let mut functions = Vec::new();
        for symbol in object.symbols().chain(object.dynamic_symbols()) {
            if symbol.kind() != object::SymbolKind::Text || symbol.address() == 0 {
                continue;
            }
            let Ok(name) = symbol.name() else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            functions.push(Function {
                name: name.to_string(),
                address: symbol.address(),
                size: symbol.size(),
            });
        }
        functions.sort_by_key(|function| function.address);
        functions.dedup_by_key(|function| function.address);

        let loader = addr2line::Loader::new(path)
            .map_err(|error| SymbolizeError::Unreadable(error.to_string()))?;

        let span = match (functions.first(), functions.last()) {
            (Some(first), Some(last)) => {
                Some((first.address, last.address.saturating_add(last.size.max(1))))
            }
            _ => None,
        };

        Ok(Self {
            path: path.to_path_buf(),
            loader,
            functions,
            span,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn functions(&self) -> &[Function] {
        &self.functions
    }

    /// Resolve an address to a file, a line and the enclosing function.
    ///
    /// `None` means the image has no line information for the address, which is
    /// normal for a stripped image or for a pointer that is not code.
    pub fn resolve(&self, address: u64) -> Option<SourceLocation> {
        // A crash log can print any number. Outside the image's code span there is
        // nothing to resolve, and asking the line table there is wasted work.
        let (low, high) = self.span?;
        if address < low || address >= high {
            return None;
        }
        let location = self.loader.find_location(address).ok().flatten()?;
        let file = location.file?;
        Some(SourceLocation {
            file: file.to_string(),
            line: location.line.unwrap_or(0),
            function: self
                .nearest_function(address)
                .map(|function| function.name.clone())
                .unwrap_or_default(),
            address,
        })
    }

    /// The function whose range covers the address, falling back to the closest
    /// function below it when the image records no size.
    pub fn nearest_function(&self, address: u64) -> Option<&Function> {
        let index = self
            .functions
            .partition_point(|function| function.address <= address);
        index.checked_sub(1).and_then(|index| {
            let function = &self.functions[index];
            if function.size == 0 || address < function.address + function.size {
                Some(function)
            } else {
                None
            }
        })
    }

    /// True when the image carries a line table, so a resolution can succeed.
    pub fn has_line_info(&self) -> bool {
        self.functions
            .iter()
            .take(256)
            .any(|function| self.resolve(function.address).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn this_binary() -> ElfImage {
        let path = std::env::current_exe().expect("a test binary path");
        ElfImage::load(path).expect("the test binary is a readable image")
    }

    #[test]
    fn the_test_binary_has_function_symbols() {
        let image = this_binary();
        assert!(
            image.functions().len() > 10,
            "found {} symbols",
            image.functions().len()
        );
        assert!(image.path().is_file());
        let addresses: Vec<u64> = image
            .functions()
            .iter()
            .map(|function| function.address)
            .collect();
        assert!(
            addresses.windows(2).all(|pair| pair[0] <= pair[1]),
            "symbols must be sorted for the binary search"
        );
    }

    #[test]
    fn a_symbol_resolves_to_a_rust_source_line() {
        let image = this_binary();
        let resolved = image
            .functions()
            .iter()
            .take(4_000)
            .find_map(|function| image.resolve(function.address));
        let location = resolved.expect("at least one symbol has line information");
        assert!(
            location.file.ends_with(".rs"),
            "resolved to {}",
            location.file
        );
        assert!(location.line > 0, "{location:?}");
        assert!(!location.function.is_empty(), "{location:?}");
    }

    #[test]
    fn an_address_inside_a_function_finds_that_function() {
        let image = this_binary();
        let target = image
            .functions()
            .iter()
            .find(|function| function.name.contains("nearest_function"))
            .or_else(|| image.functions().last())
            .expect("a function");
        let found = image.nearest_function(target.address).expect("a function");
        assert_eq!(found.address, target.address);
    }

    #[test]
    fn a_wild_address_resolves_to_nothing() {
        let image = this_binary();
        assert!(image.resolve(0xdead_beef_dead_beef).is_none());
        assert!(image.resolve(u64::MAX).is_none());
    }

    #[test]
    fn a_missing_file_is_reported_by_name() {
        let error = ElfImage::load("no-such-firmware.elf").unwrap_err();
        assert_eq!(
            error,
            SymbolizeError::NotFound("no-such-firmware.elf".to_string())
        );
        assert!(error.to_string().contains("no-such-firmware.elf"));
    }

    #[test]
    fn a_file_that_is_not_an_image_is_refused() {
        let path = std::env::temp_dir().join(format!("bforge-notelf-{}.bin", std::process::id()));
        std::fs::write(&path, b"this is not an image").unwrap();
        let error = ElfImage::load(&path).unwrap_err();
        assert!(matches!(error, SymbolizeError::Unreadable(_)), "{error}");
        let _ = std::fs::remove_file(path);
    }
}
