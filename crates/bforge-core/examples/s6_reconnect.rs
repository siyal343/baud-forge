//! Watch one port and print every state change, so an unplug can be measured.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s6_reconnect -- COM8 115200 120
//! ```
//!
//! Output is one line per transition, with the time since start in milliseconds.
//! Unplug the board while it runs and plug it back in: the log then shows how long
//! the reader took to notice and how long it took to reopen.

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_hal::uart::{UartConfig, UartTransport};
use bforge_hal::{LineConfig, PortState};
use std::io::Write;
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let device = args.next().unwrap_or_else(|| "COM8".to_string());
    let baud = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(115_200u32);
    let seconds = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120u64);

    let transport = UartTransport::new(UartConfig {
        device: device.clone(),
        line: LineConfig {
            baud_rate: baud,
            ..Default::default()
        },
        read_timeout: Duration::from_millis(50),
    });
    let mut pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 0,
            consumers: 1,
            // Twelve seconds of patience: enough for a person to plug the cable back in.
            reconnect_attempts: 2_400,
            ..Default::default()
        },
        Box::new(transport),
    );
    let mut logger = pipeline.take_consumers().remove(0);

    let started = Instant::now();
    println!("watching {device} at {baud} baud for {seconds} s: unplug it, then plug it back in");
    let _ = std::io::stdout().flush();

    let mut last_state: Option<PortState> = None;
    let mut state_since = started;
    let mut last_beat = Duration::ZERO;
    let mut chunks = 0u64;
    let mut bytes = 0u64;
    let mut reconnects = 0u64;
    let mut last_bytes_at = Duration::ZERO;

    while started.elapsed() < Duration::from_secs(seconds) {
        while let Ok(slab) = logger.pop() {
            chunks += 1;
            bytes += u64::from(slab.meta.len);
            last_bytes_at = started.elapsed();
        }

        let stats = pipeline.stats();
        if last_state != Some(stats.state) {
            let now = started.elapsed();
            let quiet = now.saturating_sub(last_bytes_at);
            println!(
                "{:>8.1} ms  state -> {:<12} after {:>7.1} ms  reconnects {}  away {} ms  open {} ms  chunks {}  bytes {}  read errors {}",
                now.as_secs_f64() * 1000.0,
                stats.state.as_str(),
                state_since.elapsed().as_secs_f64() * 1000.0,
                stats.reconnects,
                stats.last_reconnect_ms,
                stats.last_open_ms,
                chunks,
                bytes,
                stats.read_errors,
            );
            let _ = std::io::stdout().flush();
            last_state = Some(stats.state);
            state_since = started;
            if stats.reconnects > reconnects {
                println!(
                    "{:>8.1} ms  data was quiet for {:>7.1} ms before the port left",
                    now.as_secs_f64() * 1000.0,
                    quiet.as_secs_f64() * 1000.0
                );
                let _ = std::io::stdout().flush();
                reconnects = stats.reconnects;
            }
        }
        // A heartbeat every ten seconds: proof the watcher is alive even when the
        // cable never moves, and a timestamp to line up against a wall clock.
        let now = started.elapsed();
        if now.saturating_sub(last_beat) >= Duration::from_secs(10) {
            println!(
                "{:>8.1} ms  alive  state {:<12} chunks {}  bytes {}  reconnects {}",
                now.as_secs_f64() * 1000.0,
                pipeline.stats().state.as_str(),
                chunks,
                bytes,
                pipeline.stats().reconnects,
            );
            let _ = std::io::stdout().flush();
            last_beat = now;
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let stats = pipeline.stats();
    println!(
        "\nsummary: state {}  reconnects {}  chunks {}  bytes {}  read errors {}",
        stats.state.as_str(),
        stats.reconnects,
        chunks,
        bytes,
        stats.read_errors
    );
    let _ = std::io::stdout().flush();
    pipeline.stop();
}
