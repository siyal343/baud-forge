//! Headless entry point of BaudForge (FR-HAL, FR-STO-02, Milestone 1).
//!
//! Setup only: the argument surface is listed, no subcommand does work yet.

use std::process::ExitCode;

const USAGE: &str = "\
bforge <command>

Commands:
  help              Show this text
  version           Show the version
  record            Record a session to a .bflog file      (planned)
  replay            Send a .bflog session to a port        (planned)
  assert            Compare a session against a baseline   (planned)
  yield             Release a port so a flash tool can use it (planned)
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
        Some(other) => {
            eprintln!("error: unknown command `{other}`\n");
            eprint!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
