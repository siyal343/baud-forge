//! Headless entry point of BaudForge.
//!
//! S3 surface: `bforge config check` validates a workspace file and reports every
//! problem with its path. `record`, `replay`, `assert` and `yield` are S4.

use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "\
bforge <command>

Commands:
  help                        Show this text
  version                     Show the version
  config check <file>         Validate a .bforge.toml workspace
  record                      Record a session to a .bflog file      (planned)
  replay                      Send a .bflog session to a port        (planned)
  assert                      Compare a session against a baseline   (planned)
  yield                       Release a port so a flash tool can use it (planned)
";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);

    match args.next().as_deref() {
        None | Some("help") | Some("-h") | Some("--help") => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("version") | Some("-V") | Some("--version") => {
            println!("bforge {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("config") => match args.next().as_deref() {
            Some("check") => match args.next() {
                Some(path) => check_config(&path),
                None => usage_error("config check needs a file"),
            },
            _ => usage_error("config needs the `check` subcommand"),
        },
        Some(other) => usage_error(&format!("unknown command `{other}`")),
    }
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}\n");
    eprint!("{USAGE}");
    ExitCode::FAILURE
}

fn check_config(path: &str) -> ExitCode {
    let text = match std::fs::read_to_string(Path::new(path)) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("error: cannot read {path}: {error}");
            return ExitCode::FAILURE;
        }
    };

    let config = match bforge_core::parse(&text) {
        Ok(config) => config,
        Err(error) => {
            // The parser carries the line and the column of a syntax error.
            eprintln!("error: {path}: {error}");
            return ExitCode::FAILURE;
        }
    };

    let issues = config.validate();
    if issues.is_empty() {
        println!(
            "{path}: ok, {} port(s), {} command(s), {} alert(s)",
            config.ports.len(),
            config.commands.len(),
            config.alerts.len()
        );
        return ExitCode::SUCCESS;
    }

    for issue in &issues {
        println!("{path}: {issue}");
    }
    eprintln!("{} problem(s) in {path}", issues.len());
    ExitCode::FAILURE
}
