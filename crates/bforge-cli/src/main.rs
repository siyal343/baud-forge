//! Headless entry point of BaudForge (S4).
//!
//! `ports list`, `record`, `replay`, `status`, `config check`.

use bforge_core::ProjectConfig;
use bforge_core::session::{ReplayOptions, Session, replay_to, session_ports_from_config};
use bforge_hal::uart::{UartConfig, UartTransport, available};
use bforge_hal::{LineConfig, TransportDriver};
use bforge_storage::LogReader;
use std::path::Path;
use std::process::ExitCode;
use std::time::{Duration, Instant};

const USAGE: &str = "\
bforge <command>

Commands:
  help                          Show this text
  version                       Show the version
  config check <file>           Validate a .bforge.toml workspace
  ports list [-c <file>]        List serial ports and the workspace match
  record -c <file> -o <file>    Record the workspace into a .bflog vault
         [--port <id>]... [--duration 5s] [--json] [--watch]
  replay <vault> --to <device>  Send a vault back out of a port
         [--baud 115200] [--speed 1.0]
         or: -c <file> --port <id>
  status -c <file>              Print the UI state contract as JSON
         [--duration 1s] [--watch]
  serve -c <file>               Serve the UI contract over loopback HTTP
         [--addr 127.0.0.1:7717] [--vault <file>] [--duration 1h]
  tail -c <file>                Frame and decode a live port
         [--port <id>]... [--duration 5s] [--fields] [--json]
  assert <vault> -r <rules>     Check a vault against a TOML rule file
         [-c <workspace> --port <id>] [--json]
  vault info <vault>            Report records, bytes, index source, damage
  vault repair <vault>          Truncate a killed session to its last record
  yield -c <file> --port <id>   Release the port so a flash tool can use it
         [--for 30s]

`record` runs until the duration ends, or until Enter is pressed when no
duration is given.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str);

    match command {
        None | Some("help") | Some("-h") | Some("--help") => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("version") | Some("-V") | Some("--version") => {
            println!("bforge {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("config") => match args.get(1).map(String::as_str) {
            Some("check") => match args.get(2) {
                Some(path) => check_config(path),
                None => usage_error("config check needs a file"),
            },
            _ => usage_error("config needs the `check` subcommand"),
        },
        Some("ports") => ports(&args[1..]),
        Some("record") => record(&args[1..]),
        Some("replay") => replay(&args[1..]),
        Some("status") => status(&args[1..]),
        Some("serve") => serve(&args[1..]),
        Some("tail") => tail(&args[1..]),
        Some("assert") => assert_vault(&args[1..]),
        Some("vault") => vault(&args[1..]),
        Some("yield") => yield_port(&args[1..]),
        Some(other) => usage_error(&format!("unknown command `{other}`")),
    }
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}\n");
    eprint!("{USAGE}");
    ExitCode::FAILURE
}

/// The smallest argument reader that covers this CLI.
struct Args {
    rest: Vec<String>,
}

impl Args {
    fn new(args: &[String]) -> Self {
        Self {
            rest: args.to_vec(),
        }
    }

    /// Remove `--name value` and return the value.
    fn value(&mut self, name: &str) -> Option<String> {
        let index = self.rest.iter().position(|arg| arg == name)?;
        if index + 1 >= self.rest.len() {
            return None;
        }
        let value = self.rest.remove(index + 1);
        self.rest.remove(index);
        Some(value)
    }

    /// Remove every `--name value` pair.
    fn values(&mut self, name: &str) -> Vec<String> {
        let mut found = Vec::new();
        while let Some(value) = self.value(name) {
            found.push(value);
        }
        found
    }

    fn flag(&mut self, name: &str) -> bool {
        match self.rest.iter().position(|arg| arg == name) {
            Some(index) => {
                self.rest.remove(index);
                true
            }
            None => false,
        }
    }

    fn positional(&mut self) -> Option<String> {
        if self.rest.is_empty() {
            None
        } else {
            Some(self.rest.remove(0))
        }
    }

    fn unknown(&self) -> Option<&String> {
        self.rest.iter().find(|arg| arg.starts_with("--"))
    }
}

fn parse_duration(text: &str) -> Option<Duration> {
    let text = text.trim();
    if let Some(value) = text.strip_suffix("ms") {
        return value.parse().ok().map(Duration::from_millis);
    }
    if let Some(value) = text.strip_suffix('s') {
        let seconds: f64 = value.parse().ok()?;
        return Some(Duration::from_secs_f64(seconds));
    }
    text.parse().ok().map(Duration::from_secs)
}

fn load_config(path: &str) -> Result<ProjectConfig, ExitCode> {
    let text = std::fs::read_to_string(Path::new(path)).map_err(|error| {
        eprintln!("error: cannot read {path}: {error}");
        ExitCode::FAILURE
    })?;
    let config = bforge_core::parse(&text).map_err(|error| {
        eprintln!("error: {path}: {error}");
        ExitCode::FAILURE
    })?;
    let issues = config.validate();
    if !issues.is_empty() {
        for issue in &issues {
            println!("{path}: {issue}");
        }
        eprintln!("{} problem(s) in {path}", issues.len());
        return Err(ExitCode::FAILURE);
    }
    Ok(config)
}

fn check_config(path: &str) -> ExitCode {
    match load_config(path) {
        Ok(config) => {
            println!(
                "{path}: ok, {} port(s), {} command(s), {} alert(s)",
                config.ports.len(),
                config.commands.len(),
                config.alerts.len()
            );
            ExitCode::SUCCESS
        }
        Err(code) => code,
    }
}

fn ports(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let _ = args.flag("list");
    let config_path = args.value("-c");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }

    let config = match config_path.as_deref().map(load_config).transpose() {
        Ok(config) => config,
        Err(code) => return code,
    };

    let devices = match available() {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("error: cannot enumerate ports: {error}");
            return ExitCode::FAILURE;
        }
    };

    println!(
        "{:<10} {:<10} {:<20} {:<18} state",
        "device", "vid:pid", "serial", "workspace port"
    );
    for device in devices {
        let matched = config.as_ref().and_then(|config| {
            config
                .ports
                .iter()
                .find(|port| matches(port, &device))
                .map(|port| port.id.clone())
        });
        let state = if matched.is_some() { "bound" } else { "-" };
        println!(
            "{:<10} {:<10} {:<20} {:<18} {}",
            device.device_path,
            device.vid_pid.unwrap_or_else(|| "-".into()),
            device.serial.unwrap_or_else(|| "-".into()),
            matched.unwrap_or_else(|| "-".into()),
            state
        );
    }
    ExitCode::SUCCESS
}

fn matches(port: &bforge_core::PortConfig, device: &bforge_hal::DeviceId) -> bool {
    if let Some(path) = &port.device_path {
        return path == &device.device_path;
    }
    if let Some(tuple) = &port.match_vid_pid {
        if device.vid_pid.as_deref() != Some(tuple.as_str()) {
            return false;
        }
        return port
            .match_serial
            .as_ref()
            .is_none_or(|serial| device.serial.as_deref() == Some(serial.as_str()));
    }
    false
}

fn record(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let config_path = args.value("-c");
    let out = args.value("-o");
    let only = args.values("--port");
    let duration = args.value("--duration");
    let json = args.flag("--json");
    let watch = args.flag("--watch");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let (Some(config_path), Some(out)) = (config_path, out) else {
        return usage_error("record needs -c <workspace> and -o <vault>");
    };
    let duration = match duration.as_deref() {
        Some(text) => match parse_duration(text) {
            Some(duration) => Some(duration),
            None => return usage_error("--duration needs 500ms, 5s or a number of seconds"),
        },
        None => None,
    };

    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(code) => return code,
    };
    let ports = match session_ports_from_config(&config, &only) {
        Ok(ports) => ports,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut session = match Session::start(
        ports,
        Some(Path::new(&out)),
        config.workspace.elf_path.clone(),
    ) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };

    let events = session.subscribe();
    let stop = stop_signal(duration);
    println!("recording {} port(s) into {out}", session.port_count());

    let mut last_report = Instant::now();
    loop {
        match session.pump_once() {
            Ok(0) => std::thread::sleep(Duration::from_millis(2)),
            Ok(_) => {}
            Err(error) => {
                eprintln!("error: {error}");
                return ExitCode::FAILURE;
            }
        }
        if watch {
            while let Ok(event) = events.try_recv() {
                println!("{}", serde_json::to_string(&event).unwrap_or_default());
            }
        }
        if stop() {
            break;
        }
        if !json && last_report.elapsed() > Duration::from_secs(1) {
            let snapshot = session.snapshot();
            println!(
                "{:>6.1}s  {} chunks  {:.2} MB",
                snapshot.session.elapsed_ms as f64 / 1000.0,
                snapshot.session.chunks,
                snapshot.session.payload_bytes as f64 / 1_000_000.0
            );
            last_report = Instant::now();
        }
    }

    let snapshot_before = session.snapshot();
    match session.seal() {
        Ok(summary) => {
            let seconds = snapshot_before.session.elapsed_ms as f64 / 1000.0;
            println!(
                "\nsealed {}: {} chunks, {} bytes in {:.2} s ({:.0} B/s), {} segment(s)",
                summary.path.display(),
                summary.chunks,
                summary.payload_bytes,
                seconds,
                summary.payload_bytes as f64 / seconds.max(0.001),
                summary.segments
            );
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&snapshot_before).unwrap()
                );
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

/// A stop condition: a deadline, or Enter on standard input.
fn stop_signal(duration: Option<Duration>) -> impl Fn() -> bool {
    let deadline = duration.map(|duration| Instant::now() + duration);
    let pressed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    if deadline.is_none() {
        let pressed = std::sync::Arc::clone(&pressed);
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
            pressed.store(true, std::sync::atomic::Ordering::Relaxed);
        });
    }
    move || {
        deadline.is_some_and(|deadline| Instant::now() >= deadline)
            || pressed.load(std::sync::atomic::Ordering::Relaxed)
    }
}

fn replay(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let vault = args.positional();
    let to = args.value("--to");
    let baud = args
        .value("--baud")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(115_200);
    let speed = args
        .value("--speed")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(1.0);
    let config_path = args.value("-c");
    let port_id = args.value("--port");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let Some(vault) = vault else {
        return usage_error("replay needs a vault file");
    };

    let mut reader = match LogReader::open(&vault) {
        Ok(reader) => reader,
        Err(error) => {
            eprintln!("error: {vault}: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut transport: Box<dyn TransportDriver> = if let Some(device) = to {
        Box::new(UartTransport::new(UartConfig {
            device,
            line: LineConfig {
                baud_rate: baud,
                ..Default::default()
            },
            read_timeout: Duration::from_millis(50),
        }))
    } else {
        let (Some(config_path), Some(port_id)) = (config_path, port_id) else {
            return usage_error("replay needs --to <device>, or -c <workspace> --port <id>");
        };
        let config = match load_config(&config_path) {
            Ok(config) => config,
            Err(code) => return code,
        };
        match session_ports_from_config(&config, std::slice::from_ref(&port_id)) {
            Ok(mut ports) => ports.remove(0).transport,
            Err(error) => {
                eprintln!("error: {error}");
                return ExitCode::FAILURE;
            }
        }
    };

    println!(
        "replaying {vault}: {} chunks at speed {speed}",
        reader.chunks()
    );
    match replay_to(&mut reader, transport.as_mut(), ReplayOptions { speed }) {
        Ok(report) => {
            println!(
                "sent {} chunks, {} bytes in {:.2} s, worst lateness {:.1} ms",
                report.chunks,
                report.payload_bytes,
                report.elapsed.as_secs_f64(),
                report.max_lag_ms
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn serve(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let config_path = args.value("-c");
    let address = args
        .value("--addr")
        .unwrap_or_else(|| "127.0.0.1:7717".to_string());
    let vault = args.value("--vault").map(std::path::PathBuf::from);
    let duration = args
        .value("--duration")
        .as_deref()
        .and_then(parse_duration)
        .unwrap_or(Duration::from_secs(3600));
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let Some(config_path) = config_path else {
        return usage_error("serve needs -c <workspace>");
    };
    let address = match address.parse() {
        Ok(address) => address,
        Err(_) => return usage_error(&format!("`{address}` is not an address")),
    };
    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(code) => return code,
    };
    let ports = match session_ports_from_config(&config, &[]) {
        Ok(ports) => ports,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    let server = match bforge_core::serve::Server::bind(address) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    let local = match server.local_addr() {
        Ok(local) => local,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    let session = match Session::start(ports, vault.as_deref(), config.workspace.elf_path.clone()) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!("serving http://{local}");
    println!("  page      http://{local}/");
    println!("  snapshot  http://{local}/api/snapshot");
    println!("  events    http://{local}/api/events");
    match server.run(session, Some(duration)) {
        Ok(stats) => {
            println!(
                "served {} requests, {} chunks, up to {} event clients",
                stats.requests, stats.chunks, stats.clients_max
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn status(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let config_path = args.value("-c");
    let duration = args
        .value("--duration")
        .as_deref()
        .and_then(parse_duration)
        .unwrap_or(Duration::from_secs(1));
    let watch = args.flag("--watch");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let Some(config_path) = config_path else {
        return usage_error("status needs -c <workspace>");
    };

    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(code) => return code,
    };
    let ports = match session_ports_from_config(&config, &[]) {
        Ok(ports) => ports,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut session = match Session::start(ports, None, config.workspace.elf_path.clone()) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };

    let events = session.subscribe();
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        match session.pump_once() {
            Ok(0) => std::thread::sleep(Duration::from_millis(2)),
            Ok(_) => {}
            Err(error) => {
                eprintln!("error: {error}");
                return ExitCode::FAILURE;
            }
        }
        if watch {
            while let Ok(event) = events.try_recv() {
                println!("{}", serde_json::to_string(&event).unwrap_or_default());
            }
        }
    }

    if !watch {
        let snapshot = session.snapshot();
        println!("{}", serde_json::to_string_pretty(&snapshot).unwrap());
    }
    let _ = session.seal();
    ExitCode::SUCCESS
}

fn assert_vault(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let vault = args.positional();
    let rules_path = args.value("-r");
    let config_path = args.value("-c");
    let port_id = args.value("--port");
    let json = args.flag("--json");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let (Some(vault), Some(rules_path)) = (vault, rules_path) else {
        return usage_error("assert needs a vault and -r <rules>");
    };

    let rules_text = match std::fs::read_to_string(&rules_path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("error: cannot read {rules_path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let rules = match bforge_core::assert::parse_rules(&rules_text) {
        Ok(rules) => rules,
        Err(error) => {
            eprintln!("error: {rules_path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let problems = bforge_core::assert::validate_rules(&rules);
    if !problems.is_empty() {
        for problem in &problems {
            println!("{rules_path}: {problem}");
        }
        eprintln!("{} problem(s) in {rules_path}", problems.len());
        return ExitCode::FAILURE;
    }

    let mut reader = match LogReader::open(&vault) {
        Ok(reader) => reader,
        Err(error) => {
            eprintln!("error: {vault}: {error}");
            return ExitCode::FAILURE;
        }
    };
    // Decode the vault with the workspace schema when one is given. The vault
    // itself stays raw: framing is applied here, at the question.
    let rows = match config_path {
        None => Vec::new(),
        Some(path) => {
            let config = match load_config(&path) {
                Ok(config) => config,
                Err(code) => return code,
            };
            let port = match port_id.as_deref() {
                Some(id) => config.ports.iter().find(|port| port.id == id),
                None => config.ports.first(),
            };
            let Some(port) = port else {
                eprintln!("error: {path} has no port to decode with");
                return ExitCode::FAILURE;
            };
            match bforge_core::tail::decode_vault(&mut reader, port) {
                Ok(rows) => rows,
                Err(error) => {
                    eprintln!("error: cannot decode {vault}: {error}");
                    return ExitCode::FAILURE;
                }
            }
        }
    };

    let report = match bforge_core::assert::evaluate(&vault, &mut reader, &rules, &rows) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("error: {vault}: {error}");
            return ExitCode::FAILURE;
        }
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!(
            "{vault}: {} chunks, {} bytes, {} decoded frame(s)",
            report.chunks,
            report.payload_bytes,
            rows.len()
        );
        for check in &report.checks {
            println!(
                "  {} {:<10} {}  {}",
                if check.passed { "PASS" } else { "FAIL" },
                check.kind,
                check.name,
                check.detail
            );
        }
        println!(
            "{} of {} checks passed",
            report.checks.len() - report.failures(),
            report.checks.len()
        );
    }

    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn vault(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    match args.positional().as_deref() {
        Some("info") => vault_info(&mut args),
        Some("repair") => vault_repair(&mut args),
        Some(other) => usage_error(&format!("unknown vault command `{other}`")),
        None => usage_error("vault needs `info` or `repair` and a file"),
    }
}

fn vault_info(args: &mut Args) -> ExitCode {
    let Some(path) = args.positional() else {
        return usage_error("vault info needs a file");
    };
    let reader = match LogReader::open(&path) {
        Ok(reader) => reader,
        Err(error) => {
            eprintln!("error: {path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!("{path}");
    println!("  records      {}", reader.chunks());
    println!("  payload      {} bytes", reader.payload_bytes());
    println!("  file         {} bytes", reader.file_bytes());
    println!(
        "  index        {} ({})",
        reader.index_source(),
        reader.index_entries()
    );
    println!("  damaged tail {}", reader.damaged_tail());
    if reader.damaged_tail() {
        println!("  run `bforge vault repair {path}` to cut the partial record");
    }
    ExitCode::SUCCESS
}

fn vault_repair(args: &mut Args) -> ExitCode {
    let Some(path) = args.positional() else {
        return usage_error("vault repair needs a file");
    };
    match bforge_storage::repair(&path) {
        Ok(report) => {
            println!(
                "{path}: kept {} records, removed {} bytes",
                report.kept_chunks, report.removed_bytes
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {path}: {error}");
            ExitCode::FAILURE
        }
    }
}

fn tail(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let config_path = args.value("-c");
    let only = args.values("--port");
    let duration = args
        .value("--duration")
        .as_deref()
        .and_then(parse_duration)
        .unwrap_or(Duration::from_secs(5));
    let show_fields = args.flag("--fields");
    let json = args.flag("--json");
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let Some(config_path) = config_path else {
        return usage_error("tail needs -c <workspace>");
    };

    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(code) => return code,
    };
    let ports = match session_ports_from_config(&config, &only) {
        Ok(ports) => ports,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut configs = std::collections::HashMap::new();
    for port in &config.ports {
        if !only.is_empty() && !only.contains(&port.id) {
            continue;
        }
        match bforge_core::tail::tail_config(port) {
            Ok(tail) => {
                configs.insert(port.id.clone(), tail);
            }
            Err(error) => {
                eprintln!("error: port `{}`: {error}", port.id);
                return ExitCode::FAILURE;
            }
        }
    }

    let mut tail = match bforge_core::tail::Tail::start(ports, configs) {
        Ok(tail) => tail,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };

    if !json {
        eprintln!(
            "tailing {} port(s) for {:.1} s, press Enter to stop",
            tail.port_count(),
            duration.as_secs_f64()
        );
    }

    let stop = stop_signal(Some(duration));
    let mut frames = 0usize;
    loop {
        let rows = tail.pump();
        if rows.is_empty() {
            std::thread::sleep(Duration::from_millis(2));
        }
        for row in rows {
            frames += 1;
            if json {
                println!("{}", serde_json::to_string(&row).unwrap_or_default());
            } else {
                print_row(&row, show_fields);
            }
        }
        if stop() {
            break;
        }
    }
    let elapsed = tail.elapsed();
    tail.stop();
    if !json {
        eprintln!(
            "{frames} frame(s) in {:.1} s ({:.1} frames/s)",
            elapsed.as_secs_f64(),
            frames as f64 / elapsed.as_secs_f64().max(0.001)
        );
    }
    ExitCode::SUCCESS
}

fn print_row(row: &bforge_core::tail::TailRow, show_fields: bool) {
    let body = if row.text.is_empty() {
        row.hex.clone()
    } else {
        row.text.replace('\n', " ")
    };
    println!(
        "{:>10.3}s +{:>7.0}us {:<10} {:>5}B {:<20} {}",
        row.timestamp_us as f64 / 1e6,
        row.delta_us,
        row.port,
        row.len,
        row.protocol.clone().unwrap_or_default(),
        body
    );
    if let Some(error) = &row.decode_error {
        println!("             decode error: {error}");
    }
    if show_fields {
        for field in &row.fields {
            println!(
                "             {:<24} +0x{:02x} {:>2}B  {}",
                field.name, field.offset, field.len, field.value
            );
        }
    }
}

fn yield_port(args: &[String]) -> ExitCode {
    let mut args = Args::new(args);
    let config_path = args.value("-c");
    let port_id = args.value("--port");
    let seconds = args
        .value("--for")
        .as_deref()
        .and_then(parse_duration)
        .unwrap_or(Duration::from_secs(30));
    if let Some(unknown) = args.unknown() {
        return usage_error(&format!("unknown option `{unknown}`"));
    }
    let (Some(config_path), Some(port_id)) = (config_path, port_id) else {
        return usage_error("yield needs -c <workspace> and --port <id>");
    };

    let config = match load_config(&config_path) {
        Ok(config) => config,
        Err(code) => return code,
    };
    let Some(port) = config.ports.iter().find(|port| port.id == port_id) else {
        eprintln!("error: `{port_id}` is not a port in {config_path}");
        return ExitCode::FAILURE;
    };
    let Some(device) = port.device_path.clone().or_else(|| {
        bforge_core::session::session_ports_from_config(&config, std::slice::from_ref(&port_id))
            .ok()
            .and_then(|mut ports| ports.pop().map(|port| port.device))
    }) else {
        eprintln!("error: cannot resolve the device for `{port_id}`");
        return ExitCode::FAILURE;
    };

    let Some(address) = bforge_core::control::discover(&device) else {
        eprintln!(
            "error: no running session holds {device}; start `bforge record` or `bforge tail` first"
        );
        return ExitCode::FAILURE;
    };

    let request = format!(
        "{{\"cmd\":\"yield\",\"port\":\"{port_id}\",\"seconds\":{}}}",
        seconds.as_secs()
    );
    match bforge_core::control::request(address, &request) {
        Ok(reply) => {
            println!("{reply}");
            if reply.contains("\"ok\":true") {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("error: cannot reach the session at {address}: {error}");
            ExitCode::FAILURE
        }
    }
}
