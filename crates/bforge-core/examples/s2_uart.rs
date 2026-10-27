//! S2 demo, part 2: a real serial port to `.bflog`, then read back.
//!
//! Lists the serial ports, opens one, shows the modem pins, pulses RTS to
//! restart the target, records for a few seconds, then reads a window back.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s2_uart -- COM8 115200 3
//! ```

use bforge_core::pipeline::{Pipeline, PipelineConfig};
use bforge_hal::uart::{UartConfig, UartTransport, available};
use bforge_hal::{Direction, LineConfig, TransportDriver};
use bforge_storage::{LogHeader, LogReader, LogWriter, RawChunk};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
        .unwrap_or(3u64);

    println!("serial ports the operating system reports:");
    match available() {
        Ok(ports) => {
            for port in ports {
                println!(
                    "  {:<8} vid:pid {:>9}  serial {}",
                    port.device_path,
                    port.vid_pid.unwrap_or_else(|| "-".into()),
                    port.serial.unwrap_or_else(|| "-".into())
                );
            }
        }
        Err(error) => println!("  cannot enumerate: {error}"),
    }

    let config = UartConfig {
        device: device.clone(),
        line: LineConfig {
            baud_rate: baud,
            ..Default::default()
        },
        read_timeout: Duration::from_millis(50),
    };

    // Direct probe: pins, reset pulse, and the first bytes.
    let mut probe = UartTransport::new(config.clone());
    match probe.open() {
        Ok(()) => {
            println!("\nopened {device} at {baud} baud");
            match probe.read_pins() {
                Ok(pins) => println!(
                    "modem pins: CTS {} DSR {} DCD {} RI {}",
                    pins.contains(bforge_hal::PinStateFlags::CTS),
                    pins.contains(bforge_hal::PinStateFlags::DSR),
                    pins.contains(bforge_hal::PinStateFlags::DCD),
                    pins.contains(bforge_hal::PinStateFlags::RI)
                ),
                Err(error) => println!("cannot read pins: {error}"),
            }
            match probe.pulse_rts(Duration::from_millis(100)) {
                Ok(()) => println!("RTS pulsed: the target should restart"),
                Err(error) => println!("cannot pulse RTS: {error}"),
            }
            let mut buffer = [0u8; 512];
            let mut first = Vec::new();
            let deadline = Instant::now() + Duration::from_millis(1_500);
            while Instant::now() < deadline && first.len() < 256 {
                match probe.read_slab(&mut buffer) {
                    Ok(0) => {}
                    Ok(len) => first.extend_from_slice(&buffer[..len]),
                    Err(error) => {
                        println!("read error: {error}");
                        break;
                    }
                }
            }
            println!("first {} bytes after reset:", first.len());
            print_hex(&first, 128);
            probe.close();
        }
        Err(error) => {
            println!("\ncannot open {device}: {error}");
            return;
        }
    }

    // The same port through the pipeline and the vault.
    let path = format!("target/s2-{}.bflog", device.replace(['\\', '/', ':'], "_"));
    let mut pipeline = Pipeline::start(
        PipelineConfig {
            port_id: 0,
            ..Default::default()
        },
        Box::new(UartTransport::new(config)),
    );
    let mut consumers = pipeline.take_consumers();
    let mut logger = consumers.remove(0);

    let header = LogHeader {
        session_id: 0x5eed_0000_0000_0002_0000_0000_0000_0002,
        start_epoch_ns: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64,
        config_hash: 0,
        port_table_offset: 256,
    };
    let mut writer = LogWriter::create(&path, header).unwrap();
    println!("\nrecording {device} at {baud} baud for {seconds} s into {path}");

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(seconds) {
        match logger.pop() {
            Ok(slab) => {
                let meta = slab.meta;
                let chunk = RawChunk {
                    seq_id: meta.seq_id,
                    timestamp_ns: meta.timestamp_ns,
                    port_id: meta.port_id,
                    direction: Direction::Rx,
                    line_state: meta.line_state,
                    payload_offset: 0,
                    payload_len: meta.len,
                };
                writer.append(&chunk, slab.bytes()).unwrap();
            }
            Err(_) => std::thread::sleep(Duration::from_millis(1)),
        }
    }
    let elapsed = started.elapsed();
    let summary = writer.seal().unwrap();
    let stats = pipeline.stats();
    pipeline.stop();

    println!(
        "recorded {} chunks, {} bytes in {:.2} s ({:.0} B/s), read errors {}",
        summary.chunks,
        summary.payload_bytes,
        elapsed.as_secs_f64(),
        summary.payload_bytes as f64 / elapsed.as_secs_f64(),
        stats.read_errors
    );
    println!(
        "file {}: {} bytes",
        summary.path.display(),
        summary.file_bytes
    );

    let mut reader = LogReader::open(&path).unwrap();
    println!(
        "reader: {} chunks, damaged tail {}",
        reader.chunks(),
        reader.damaged_tail()
    );
    let window = reader.window(0, 4).unwrap();
    for record in &window {
        println!(
            "\nrecord {} at {} us, {} bytes, pins {:#06x}",
            record.chunk.seq_id,
            record.chunk.timestamp_ns / 1_000,
            record.payload.len(),
            record.chunk.line_state.0
        );
        print_hex(&record.payload, 96);
    }

    if window.is_empty() {
        println!(
            "\nno bytes arrived. Check the port name and the baud rate: the target\n\
             may be quiet at this speed, or it may not print after a reset."
        );
    }
}

fn print_hex(bytes: &[u8], limit: usize) {
    if bytes.is_empty() {
        println!("  (no data)");
        return;
    }
    for (row, piece) in bytes.chunks(16).take(limit.div_ceil(16)).enumerate() {
        print!("  {:04x}  ", row * 16);
        for byte in piece {
            print!("{byte:02x} ");
        }
        for _ in piece.len()..16 {
            print!("   ");
        }
        print!(" |");
        for byte in piece {
            let text = if byte.is_ascii_graphic() || *byte == b' ' {
                *byte as char
            } else {
                '.'
            };
            print!("{text}");
        }
        println!("|");
    }
}
