//! A device simulator on loopback, for tests without hardware (S8).
//!
//! Waits for one client and writes the same 19-byte `ImuPacket` frames the test
//! firmware sends, COBS encoded and zero delimited, so `bforge tail`, `record` and
//! `assert` can run in CI with no board attached.
//!
//! ```sh
//! cargo run -p bforge-core --release --example s8_device_sim -- 127.0.0.1:9100 20
//! ```

use bforge_framer::cobs_encode;
use std::io::Write;
use std::net::TcpListener;
use std::time::{Duration, Instant};

fn frame(sequence: u64) -> Vec<u8> {
    let mut frame = Vec::with_capacity(23);
    frame.extend_from_slice(&0xAA55u16.to_le_bytes()); // sync
    frame.push(3); // version
    frame.push((sequence & 0x07) as u8 | (((sequence >> 3) & 0x1F) as u8) << 3);
    frame.extend_from_slice(&(sequence as u32 * 1_000).to_le_bytes()); // timestamp_us
    frame.extend_from_slice(&(7_400u16 + (sequence % 800) as u16).to_be_bytes()); // v_batt_mv
    frame.extend_from_slice(&(0.001f32 * (sequence % 1000) as f32).to_le_bytes()); // gyro_z
    frame.push((sequence & 0xFF) as u8); // samples carry the low sequence bytes
    frame.push(((sequence >> 8) & 0xFF) as u8);
    frame.push(0x30);
    frame.push(0x40);
    frame.push(1); // mode = RUN
    let crc = crc32c(&frame);
    frame.extend_from_slice(&crc.to_le_bytes());
    frame
}

fn crc32c(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x82F6_3B78
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn main() {
    let mut args = std::env::args().skip(1);
    let address = args.next().unwrap_or_else(|| "127.0.0.1:9100".to_string());
    let hz: u64 = args
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);

    let listener = match TcpListener::bind(&address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("cannot listen on {address}: {error}");
            std::process::exit(1);
        }
    };
    println!("simulator listening on {address} at {hz} Hz");

    // Serve one client at a time and keep listening, so a test can tail, record and
    // assert against the same simulator in sequence.
    loop {
        let Ok((mut stream, peer)) = listener.accept() else {
            eprintln!("no client connected");
            std::process::exit(1);
        };
        println!("client {peer} connected");

        let period = Duration::from_micros(1_000_000 / hz.max(1));
        let mut sequence = 0u64;
        let mut next_due = Instant::now();
        loop {
            let mut payload = cobs_encode(&frame(sequence));
            payload.push(0);
            if stream.write_all(&payload).is_err() {
                println!("client went away after {sequence} frames");
                break;
            }
            sequence += 1;
            next_due += period;
            let now = Instant::now();
            if next_due > now {
                std::thread::sleep(next_due - now);
            }
        }
    }
}
