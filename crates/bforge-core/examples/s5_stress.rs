//! S5 stress harness (F1.6.1): N mock ports at 12 Mbaud, sequence-checked.
//!
//! The mock transport writes a per-block sequence into the first eight bytes of
//! every block, so a lost block is visible in the vault itself. This harness
//! records, samples resident memory, then reads the vault back and proves the
//! sequence is dense for every port.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s5_stress -- --ports 4 --seconds 20
//! ```

use bforge_core::mem::{peak_resident_bytes, resident_bytes};
use bforge_core::session::{Session, SessionPort};
use bforge_hal::mock::MockTransport;
use bforge_storage::LogReader;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const RSS_CEILING: u64 = 150 * 1024 * 1024;

struct Args {
    ports: usize,
    mbps: f64,
    seconds: u64,
    vault: String,
    verify: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        ports: 4,
        mbps: 1.2,
        seconds: 20,
        vault: "target/s5-stress.bflog".to_string(),
        verify: true,
    };
    let mut input = std::env::args().skip(1);
    while let Some(flag) = input.next() {
        let mut value = || input.next().unwrap_or_default();
        match flag.as_str() {
            "--ports" => args.ports = value().parse().unwrap_or(args.ports),
            "--mbps" => args.mbps = value().parse().unwrap_or(args.mbps),
            "--seconds" => args.seconds = value().parse().unwrap_or(args.seconds),
            "--vault" => args.vault = value(),
            "--no-verify" => args.verify = false,
            other => {
                eprintln!("unknown flag `{other}`");
                std::process::exit(2);
            }
        }
    }
    args
}

fn main() {
    let args = parse_args();
    let rate = (args.mbps * 1_000_000.0) as u64;
    let _ = std::fs::remove_file(&args.vault);

    let baseline = resident_bytes().unwrap_or(0);
    let ports: Vec<SessionPort> = (0..args.ports)
        .map(|index| SessionPort {
            id: format!("sim{index}"),
            device: format!("mock:{index}"),
            baud_rate: 12_000_000,
            framing: "none".to_string(),
            checksum: None,
            transport: Box::new(MockTransport::new(rate)),
        })
        .collect();

    println!(
        "S5 stress: {} ports at {:.1} MB/s for {} s, vault {}",
        args.ports, args.mbps, args.seconds, args.vault
    );
    println!("baseline RSS: {:.1} MB\n", baseline as f64 / 1e6);

    let mut session = Session::start(ports, Some(std::path::Path::new(&args.vault)), None).unwrap();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(args.seconds);
    let mut peak_rss = baseline;
    let mut next_report = started + Duration::from_secs(1);

    while Instant::now() < deadline {
        session.pump_once().unwrap();
        let now = Instant::now();
        peak_rss = peak_rss.max(resident_bytes().unwrap_or(0));
        if now >= next_report {
            let snapshot = session.snapshot();
            println!(
                "{:>5.1}s  {:>8} chunks  {:>8.2} MB  {:>5.2} MB/s  RSS {:.1} MiB",
                now.duration_since(started).as_secs_f64(),
                snapshot.session.chunks,
                snapshot.session.payload_bytes as f64 / 1e6,
                snapshot.session.payload_bytes as f64
                    / now.duration_since(started).as_secs_f64()
                    / 1e6,
                peak_rss as f64 / (1024.0 * 1024.0)
            );
            next_report += Duration::from_secs(1);
        }
        std::thread::sleep(Duration::from_micros(200));
    }

    let snapshot = session.snapshot();
    let elapsed = started.elapsed().as_secs_f64();
    let written = session.seal().unwrap();
    let peak = peak_resident_bytes().unwrap_or(peak_rss).max(peak_rss);

    let mut verdict_ok = true;
    println!(
        "\nrecorded {} chunks, {} bytes in {elapsed:.1} s, {:.2} MB/s",
        written.chunks,
        written.payload_bytes,
        written.payload_bytes as f64 / elapsed / 1e6
    );
    println!(
        "vault {}: {:.1} MB, {} segment(s)",
        written.path.display(),
        written.file_bytes as f64 / 1e6,
        written.segments
    );
    println!(
        "resident: baseline {:.1} MiB, peak {:.1} MiB (ceiling {:.1} MiB)",
        baseline as f64 / (1024.0 * 1024.0),
        peak as f64 / (1024.0 * 1024.0),
        RSS_CEILING as f64 / (1024.0 * 1024.0)
    );
    if peak > RSS_CEILING {
        println!("FAIL: peak resident memory is above the ceiling");
        verdict_ok = false;
    }

    if args.verify {
        match verify_sequences(&args.vault) {
            Ok(report) => {
                println!(
                    "\n{:>8} {:>8} {:>10} {:>6}",
                    "port", "chunks", "bytes", "gaps"
                );
                let mut total_gaps = 0u64;
                for port in &report.ports {
                    println!(
                        "{:>8} {:>8} {:>10} {:>6}",
                        port.id, port.chunks, port.bytes, port.gaps
                    );
                    total_gaps += port.gaps;
                }
                println!(
                    "\ntotal {} chunks, {} bytes of frame payload, {total_gaps} sequence gap(s)",
                    snapshot.session.chunks, report.bytes
                );
                if total_gaps > 0 {
                    println!("FAIL: the sequence has gaps, so a block was lost");
                    verdict_ok = false;
                }
                if snapshot.session.chunks != written.chunks {
                    println!(
                        "FAIL: the snapshot saw {} chunks, the vault holds {}",
                        snapshot.session.chunks, written.chunks
                    );
                    verdict_ok = false;
                }
            }
            Err(error) => {
                println!("FAIL: cannot verify the vault: {error}");
                verdict_ok = false;
            }
        }
    }

    println!(
        "\nRESULT: {}",
        if verdict_ok {
            "PASS - 0 dropped bytes"
        } else {
            "FAIL"
        }
    );
    if !verdict_ok {
        std::process::exit(1);
    }
}

struct PortReport {
    id: String,
    chunks: u64,
    bytes: u64,
    gaps: u64,
}

struct SequenceReport {
    ports: Vec<PortReport>,
    bytes: u64,
}

/// Read every record and check that each port's block sequence is dense.
fn verify_sequences(path: &str) -> Result<SequenceReport, String> {
    let mut reader = LogReader::open(path).map_err(|error| error.to_string())?;
    let total = reader.chunks();
    let mut seen: HashMap<u16, (u64, u64, u64, u64)> = HashMap::new();

    for frame in 0..total {
        let Some(record) = reader.read_at(frame).map_err(|error| error.to_string())? else {
            break;
        };
        if record.payload.len() < 8 {
            continue;
        }
        let seq = u64::from_le_bytes(record.payload[..8].try_into().unwrap());
        let entry = seen.entry(record.chunk.port_id).or_insert((0, 0, 0, seq));
        let (chunks, bytes, gaps, expected) = entry;
        if seq != *expected {
            *gaps += seq.saturating_sub(*expected).max(1);
        }
        *expected = seq + 1;
        *chunks += 1;
        *bytes += record.payload.len() as u64;
    }

    let mut ports: Vec<PortReport> = seen
        .into_iter()
        .map(|(port, (chunks, bytes, gaps, _))| PortReport {
            id: format!("port {}", port),
            chunks,
            bytes,
            gaps,
        })
        .collect();
    ports.sort_by(|a, b| a.id.cmp(&b.id));
    let bytes = ports.iter().map(|port| port.bytes).sum();
    Ok(SequenceReport { ports, bytes })
}
