//! Editor jump (F3.5): the command a click runs.
//!
//! Building the string is the testable part. Running it is a decision for the
//! window, which must also decide what happens when the editor is not installed.

use crate::SourceLocation;

/// Editor that the badge can open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Editor {
    VsCode,
    Clion,
}

impl Editor {
    /// Read an editor from a workspace setting.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "code" | "vscode" | "vs-code" => Some(Self::VsCode),
            "clion" => Some(Self::Clion),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::VsCode => "code",
            Self::Clion => "clion",
        }
    }

    /// The command that opens `location`, with the file shell-quoted so a path
    /// with a space survives.
    pub fn command(self, location: &SourceLocation) -> String {
        let file = quote(&location.file);
        match self {
            Self::VsCode => format!("code --goto {}:{}", file, location.line),
            Self::Clion => format!("clion --line {} {}", location.line, file),
        }
    }
}

fn quote(path: &str) -> String {
    if path.contains(' ') || path.contains('\'') {
        format!("\"{}\"", path.replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(file: &str, line: u32) -> SourceLocation {
        SourceLocation {
            file: file.to_string(),
            line,
            function: "pid_update".to_string(),
            address: 0x0800_412a,
        }
    }

    #[test]
    fn vscode_uses_goto() {
        let command = Editor::VsCode.command(&location("src/flight_ctrl.c", 184));
        assert_eq!(command, "code --goto src/flight_ctrl.c:184");
    }

    #[test]
    fn clion_uses_line_then_file() {
        let command = Editor::Clion.command(&location("src/flight_ctrl.c", 184));
        assert_eq!(command, "clion --line 184 src/flight_ctrl.c");
    }

    #[test]
    fn a_path_with_a_space_is_quoted() {
        let command = Editor::VsCode.command(&location("C:\\My Project\\main.c", 7));
        assert_eq!(command, "code --goto \"C:\\My Project\\main.c\":7");
    }

    #[test]
    fn names_round_trip_and_reject_typos() {
        assert_eq!(Editor::from_name("code"), Some(Editor::VsCode));
        assert_eq!(Editor::from_name("clion"), Some(Editor::Clion));
        assert_eq!(Editor::from_name("vim"), None);
        assert_eq!(Editor::VsCode.name(), "code");
    }
}
